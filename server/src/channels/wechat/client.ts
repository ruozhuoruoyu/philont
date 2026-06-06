/**
 * iLink Bot HTTP client — thin protocol wrapper
 *
 * Endpoints (reference: hermes/gateway/platforms/weixin.py):
 *   POST ilink/bot/getupdates           long-poll for messages
 *   POST ilink/bot/sendmessage          send text / media
 *   POST ilink/bot/sendtyping           send "typing" indicator
 *   POST ilink/bot/getconfig            retrieve typing tickets (unused in v1)
 *   POST ilink/bot/getuploadurl         CDN upload credential (for media sending)
 *   POST ilink/bot/get_bot_qrcode       scan-code login — fetch QR
 *   POST ilink/bot/get_qrcode_status    scan-code login — poll status
 *
 * Common headers (sent with every request):
 *   Content-Type: application/json
 *   AuthorizationType: ilink_bot_token
 *   X-WECHAT-UIN: <random 16-byte base64>
 *   iLink-App-Id: bot
 *   iLink-App-ClientVersion: 131072
 *   Authorization: Bearer <token>      (omitted before login)
 *
 * Common body fields:
 *   base_info: { channel_version: "2.2.0" }
 *
 * Error codes:
 *   0    success
 *   -2   rate limit (retry after exponential back-off ×3)
 *   -14  session expired — on sendmessage: retry once without context_token;
 *        on getupdates: caller should pause ~10 min and prompt user to re-scan
 *
 * Design discipline:
 *   - Does not maintain connection state (token / cursor injected by caller)
 *   - Does not retry (retry/backoff is the responsibility of gateway.ts / outbound.ts)
 *   - fetch is injectable for test mocking
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  aesKeyToApiFormat,
  decryptMedia,
  encryptMedia,
  generateMediaKey,
  parseAesKey,
  pkcs7PaddedSize,
} from './crypto.js';

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const ILINK_CHANNEL_VERSION = '2.2.0';
/** (2<<16) | (2<<8) | 0 */
export const ILINK_CLIENT_VERSION = '131072';

/**
 * SSRF protection: only allow downloading media from these hosts.
 *
 * iLink CDN allows multiple hosts (primary c2c + general cdn); prevents a maliciously
 * crafted inbound full_url from using the bot as an SSRF proxy. Add new hosts here.
 */
export const WEIXIN_CDN_HOST_ALLOWLIST = new Set<string>([
  'novac2c.cdn.weixin.qq.com',
  'wx.qlogo.cn',
  'mmsns.qpic.cn',
  'thirdwx.qlogo.cn',
]);

/** iLink common error codes */
export const ERR_OK = 0;
export const ERR_RATE_LIMIT = -2;
export const ERR_SESSION_EXPIRED = -14;

/**
 * Item types (shared by inbound + outbound, consistent with hermes weixin)
 *
 * **Order is critical**: VOICE=3, FILE=4. An early implementation had these two swapped —
 * the iLink server parses based on the type number and reads the corresponding _item field,
 * causing the receiver to see the wrong media type.
 */
export const ITEM_TEXT = 1;
export const ITEM_IMAGE = 2;
export const ITEM_VOICE = 3;
export const ITEM_FILE = 4;
export const ITEM_VIDEO = 5;

/** Media types (used by the uploadurl endpoint; distinct from ITEM types) */
export const MEDIA_IMAGE = 1;
export const MEDIA_VIDEO = 2;
export const MEDIA_FILE = 3;
export const MEDIA_VOICE = 4;

/** Outbound message constants */
export const MSG_TYPE_BOT = 2;
export const MSG_STATE_FINISH = 2;

/** Injectable fetch (for test mocking); signature compatible with standard fetch */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl?: string;
  /** CDN base url, used for uploading / downloading media (`encrypted_query_param` path) */
  cdnBaseUrl?: string;
  /** Scan-code login completed; bearer token to include */
  token?: string;
  /** fetch mock for testing */
  fetch?: FetchLike;
  /** Default request timeout (ms); getupdates uses its own long timeout and is unaffected */
  defaultTimeoutMs?: number;
}

/**
 * iLink generic response envelope.
 *
 * In practice: the server sometimes omits the ret field (equivalent to 0 = success),
 * or may include errcode. Normalise once on receipt: missing ret → set to 0;
 * errcode present and non-zero → copy to top-level ret so callers only need to check ret.
 */
export interface ILinkResponse<T = unknown> {
  ret: number;
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

/** getupdates response */
export interface GetUpdatesResponse extends ILinkResponse {
  msgs?: InboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/** Inbound message (raw shape pulled from iLink; field names kept as-is from the protocol) */
export interface InboundMessage {
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  /** Present in group messages */
  room_id?: string;
  /** Alternate group field */
  chat_room_id?: string;
  context_token?: string;
  item_list?: InboundItem[];
  /** epoch s */
  send_time?: number;
}

export interface InboundItem {
  type: number;
  text_item?: { text?: string };
  image_item?: { media?: MediaRef };
  file_item?: { media?: MediaRef; file_name?: string };
  voice_item?: { media?: MediaRef; text?: string };
  video_item?: { media?: MediaRef };
  /**
   * Quoted reply: when a user quotes a previous message in WeChat, the ITEM_TEXT carries ref_msg.
   * Previously undeclared — philont was losing the "which message was replied to" context.
   * Structure aligned with iLink protocol (reference: Hermes-Agent weixin.py::_extract_text):
   *   ref_msg.title         title / sender summary of the quoted message
   *   ref_msg.message_item  content item of the quoted message (may be text or media)
   */
  ref_msg?: { title?: string; message_item?: InboundItem };
}

export interface MediaRef {
  encrypt_query_param?: string;
  /** base64-encoded (note hermes comment: server expects base64(hex_string) not base64(raw_bytes)) */
  aes_key?: string;
  full_url?: string;
  encrypt_type?: number;
}

/** sendmessage response */
export interface SendMessageResponse extends ILinkResponse {
  message_id?: string;
}

/** getuploadurl response */
export interface GetUploadUrlResponse extends ILinkResponse {
  /** server returns the full URL directly; POST to it as-is */
  upload_full_url?: string;
  /** otherwise returns encrypted_query_param; caller assembles `${cdn}/upload?...&filekey=...` */
  upload_param?: string;
}

/** Outbound message item (union of 4 types) */
export type OutboundItem =
  | { type: typeof ITEM_TEXT; text_item: { text: string } }
  | { type: typeof ITEM_IMAGE; image_item: { media: MediaRef; mid_size?: number } }
  | {
      type: typeof ITEM_FILE;
      file_item: { media: MediaRef; file_name: string; len: string };
    }
  | {
      type: typeof ITEM_VOICE;
      voice_item: {
        media: MediaRef;
        encode_type?: number;
        bits_per_sample?: number;
        sample_rate?: number;
        playtime?: number;
      };
    }
  | {
      type: typeof ITEM_VIDEO;
      video_item: { media: MediaRef; video_size?: number; play_length?: number; video_md5?: string };
    };

/** get_bot_qrcode response */
export interface QrCodeResponse extends ILinkResponse {
  /** Hex token used for subsequent status polling */
  qrcode?: string;
  /** QR code image URL (open in browser, scan with WeChat) */
  qrcode_img_content?: string;
}

/** get_qrcode_status response */
export interface QrStatusResponse extends ILinkResponse {
  status?: 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed' | string;
  /** New host provided on scaned_but_redirect */
  redirect_host?: string;
  /** Bot account info on confirmed */
  ilink_bot_id?: string;
  /** Actual bearer token for login on confirmed */
  bot_token?: string;
  /** Base URL to use for subsequent API calls on confirmed */
  baseurl?: string;
  /** Bot's own user_id on confirmed */
  ilink_user_id?: string;
}

/** Outbound item builder */
export function textItem(text: string): { type: number; text_item: { text: string } } {
  return { type: ITEM_TEXT, text_item: { text } };
}

/** ILink HTTP client */
export class ILinkClient {
  readonly baseUrl: string;
  readonly cdnBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private token: string | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || ILINK_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.cdnBaseUrl = (opts.cdnBaseUrl || ILINK_DEFAULT_CDN_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.token = opts.token;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  /** Long-poll for messages; timeoutMs defaults to 40s (slightly longer than server's 35s long poll) */
  async getUpdates(
    getUpdatesBuf: string,
    timeoutMs: number = 40_000,
    externalSignal?: AbortSignal,
  ): Promise<GetUpdatesResponse> {
    return this.post<GetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: getUpdatesBuf || '',
        base_info: { channel_version: ILINK_CHANNEL_VERSION },
      },
      { timeoutMs, externalSignal },
    );
  }

  /**
   * Send text to to_user_id; include contextToken if provided.
   *
   * The caller is responsible for: chunking, rate-limiting, deduplication,
   * and retrying without context_token on -14 — this layer does none of that.
   */
  async sendText(
    toUserId: string,
    text: string,
    opts: { contextToken?: string; clientId?: string } = {},
  ): Promise<SendMessageResponse> {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: opts.clientId ?? generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [textItem(text)],
        ...(opts.contextToken ? { context_token: opts.contextToken } : {}),
      },
      base_info: { channel_version: ILINK_CHANNEL_VERSION },
    };
    return this.post<SendMessageResponse>('ilink/bot/sendmessage', body);
  }

  /**
   * Fetch the scan-code login QR (note: these two endpoints use GET + query params, not POST).
   *
   * Important: get_qrcode_status is a server-side long-poll — the server holds the request
   * until the status changes or its own 30s timeout expires. The client must use a timeout
   * longer than the server's (hermes uses 35s; we use 40s for margin), otherwise the default
   * 30s will abort first.
   */
  async getBotQrCode(botType: number = 3): Promise<QrCodeResponse> {
    return this.get<QrCodeResponse>(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      { timeoutMs: 40_000 },
    );
  }

  /** Poll scan-code status (server-side long-poll; timeout set to 40s) */
  async getQrCodeStatus(qrcodeToken: string): Promise<QrStatusResponse> {
    return this.get<QrStatusResponse>(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeToken)}`,
      { timeoutMs: 40_000 },
    );
  }

  // ── Media download (inbound) ────────────────────────────────────────

  /**
   * Download and (if necessary) decrypt an inbound media item.
   *
   * Protocol:
   *   - Prefer `media.encrypt_query_param` → CDN /download?encrypted_query_param=...
   *   - Otherwise use `media.full_url` (must hit CDN allowlist to prevent SSRF)
   *   - If `media.aes_key` is present → parse 16-byte key via parseAesKey → AES-128-ECB decrypt
   *
   * @returns Decrypted plaintext bytes; if no aes_key, returns ciphertext as-is
   *          (server occasionally serves small images unencrypted)
   */
  async downloadMedia(media: MediaRef, timeoutMs: number = 60_000): Promise<Buffer> {
    let url: string;
    if (media.encrypt_query_param) {
      url = `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    } else if (media.full_url) {
      assertWeixinCdnUrl(media.full_url);
      url = media.full_url;
    } else {
      throw new Error('downloadMedia: media has neither encrypt_query_param nor full_url');
    }

    const raw = await this.fetchBytes(url, { timeoutMs });
    if (!media.aes_key) return raw;
    const key = parseAesKey(media.aes_key);
    return decryptMedia(raw, key);
  }

  // ── Media upload (outbound) ─────────────────────────────────────────

  /**
   * Upload media and send it. **Full outbound flow** (reference: hermes _send_media):
   *   1. Generate a 16-byte random AES key
   *   2. AES-128-ECB + PKCS7 encrypt the file
   *   3. POST `ilink/bot/getuploadurl` to get `upload_full_url` or `upload_param` (+ `filekey`)
   *   4. POST the ciphertext to the CDN; retrieve `encrypted_query_param` from the
   *      `x-encrypted-param` response header
   *   5. POST `ilink/bot/sendmessage` with `<type>_item.media` fields
   *      (aes_key encoded as base64(hex))
   *
   * @param toUserId  Target user / group id
   * @param mediaType MEDIA_IMAGE / MEDIA_VIDEO / MEDIA_FILE / MEDIA_VOICE
   * @param plaintext Raw file bytes
   * @param opts.fileName    File name (required for MEDIA_FILE)
   * @param opts.contextToken  Cross-turn LLM context token
   * @param opts.timeoutMs  Total timeout for the entire flow (default 120s)
   */
  async uploadAndSendMedia(
    toUserId: string,
    mediaType: number,
    plaintext: Buffer,
    opts: {
      fileName?: string;
      contextToken?: string;
      clientId?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<SendMessageResponse> {
    if (mediaType === MEDIA_FILE && !opts.fileName) {
      throw new Error('uploadAndSendMedia: MEDIA_FILE requires opts.fileName');
    }
    const totalTimeoutMs = opts.timeoutMs ?? 120_000;
    const aesKey = generateMediaKey();
    const ciphertext = encryptMedia(plaintext, aesKey);
    const rawSize = plaintext.length;
    const paddedSize = pkcs7PaddedSize(rawSize);
    const md5Hex = createHash('md5').update(plaintext).digest('hex');
    const aesKeyHex = aesKey.toString('hex');
    // filekey identifies this upload for server-side idempotency / quota tracking
    const filekey = `philont-${Date.now()}-${randomBytes(8).toString('hex')}`;

    // 1. Get upload URL
    const upRes = await this.getUploadUrl({
      filekey,
      mediaType,
      toUserId,
      rawSize,
      rawFileMd5: md5Hex,
      filesize: paddedSize,
      aesKeyHex,
      timeoutMs: Math.min(30_000, totalTimeoutMs),
    });
    if (upRes.ret !== ERR_OK) {
      throw new Error(`getuploadurl failed ret=${upRes.ret} errmsg=${upRes.errmsg ?? ''}`);
    }
    let uploadUrl: string;
    if (upRes.upload_full_url) {
      uploadUrl = upRes.upload_full_url;
    } else if (upRes.upload_param) {
      uploadUrl = `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upRes.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
    } else {
      throw new Error('getuploadurl response missing both upload_full_url and upload_param');
    }

    // 2. POST ciphertext to CDN; retrieve x-encrypted-param
    const encryptedQueryParam = await this.uploadCiphertext(uploadUrl, ciphertext, {
      timeoutMs: Math.min(120_000, totalTimeoutMs),
    });

    // 3. Build item and sendmessage
    const aesKeyForApi = aesKeyToApiFormat(aesKey);
    const mediaField: MediaRef = {
      encrypt_query_param: encryptedQueryParam,
      aes_key: aesKeyForApi,
      encrypt_type: 1,
    };
    const item = buildOutboundMediaItem({
      mediaType,
      mediaField,
      paddedSize,
      rawSize,
      md5Hex,
      fileName: opts.fileName,
    });
    return this.sendItems(toUserId, [item], {
      contextToken: opts.contextToken,
      clientId: opts.clientId,
    });
  }

  /** Internal: POST ilink/bot/getuploadurl to get the CDN upload address */
  async getUploadUrl(args: {
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawSize: number;
    rawFileMd5: string;
    filesize: number;
    aesKeyHex: string;
    timeoutMs?: number;
  }): Promise<GetUploadUrlResponse> {
    return this.post<GetUploadUrlResponse>(
      'ilink/bot/getuploadurl',
      {
        filekey: args.filekey,
        media_type: args.mediaType,
        to_user_id: args.toUserId,
        rawsize: args.rawSize,
        rawfilemd5: args.rawFileMd5,
        filesize: args.filesize,
        aeskey: args.aesKeyHex,
        no_need_thumb: true,
        base_info: { channel_version: ILINK_CHANNEL_VERSION },
      },
      { timeoutMs: args.timeoutMs },
    );
  }

  /**
   * POST ciphertext to the CDN. **Critical**: use POST + `application/octet-stream`;
   * read `encrypted_query_param` from the `x-encrypted-param` response header.
   * The response body is normally ignored.
   */
  async uploadCiphertext(
    uploadUrl: string,
    ciphertext: Buffer,
    opts: { timeoutMs?: number; externalSignal?: AbortSignal } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let externalCleanup: (() => void) | undefined;
    if (opts.externalSignal) {
      const onAbort = () => controller.abort();
      if (opts.externalSignal.aborted) controller.abort();
      else {
        opts.externalSignal.addEventListener('abort', onAbort, { once: true });
        externalCleanup = () => opts.externalSignal?.removeEventListener('abort', onAbort);
      }
    }
    try {
      const res = await this.fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        // RequestInit.BodyInit is too strict with Uint8Array in dom types;
        // actual fetch / undici both accept it — cast via ArrayBuffer view.
        body: new Uint8Array(
          ciphertext.buffer,
          ciphertext.byteOffset,
          ciphertext.byteLength,
        ) as unknown as BodyInit,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`CDN upload HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      }
      const param = res.headers.get('x-encrypted-param');
      if (!param) {
        const body = await res.text().catch(() => '');
        throw new Error(`CDN upload missing x-encrypted-param header: ${body.slice(0, 200)}`);
      }
      // Drain the body anyway to avoid leaving the connection hanging on keep-alive
      await res.arrayBuffer().catch(() => {});
      return param;
    } finally {
      clearTimeout(timer);
      externalCleanup?.();
    }
  }

  /** Generic sendmessage: caller assembles item_list themselves */
  async sendItems(
    toUserId: string,
    items: OutboundItem[],
    opts: { contextToken?: string; clientId?: string } = {},
  ): Promise<SendMessageResponse> {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: opts.clientId ?? generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: items,
        ...(opts.contextToken ? { context_token: opts.contextToken } : {}),
      },
      base_info: { channel_version: ILINK_CHANNEL_VERSION },
    };
    return this.post<SendMessageResponse>('ilink/bot/sendmessage', body);
  }

  // ── Internal fetch helpers ──────────────────────────────────────────

  /** Fetch raw bytes (for CDN download); does not parse JSON */
  private async fetchBytes(
    url: string,
    opts: { timeoutMs?: number; externalSignal?: AbortSignal } = {},
  ): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let externalCleanup: (() => void) | undefined;
    if (opts.externalSignal) {
      const onAbort = () => controller.abort();
      if (opts.externalSignal.aborted) controller.abort();
      else {
        opts.externalSignal.addEventListener('abort', onAbort, { once: true });
        externalCleanup = () => opts.externalSignal?.removeEventListener('abort', onAbort);
      }
    }
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`CDN download HTTP ${res.status} ${res.statusText} from ${url.slice(0, 80)}`);
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(timer);
      externalCleanup?.();
    }
  }

  /**
   * Internal: GET request (only iLink-App-Id / iLink-App-ClientVersion headers; no Bearer).
   * Used by the scan-code login endpoints which use GET.
   */
  private async get<T extends ILinkResponse>(
    path: string,
    opts: { timeoutMs?: number; baseUrlOverride?: string; externalSignal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${opts.baseUrlOverride ?? this.baseUrl}/${path.replace(/^\//, '')}`;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let externalCleanup: (() => void) | undefined;
    if (opts.externalSignal) {
      const onAbort = () => controller.abort();
      if (opts.externalSignal.aborted) {
        controller.abort();
      } else {
        opts.externalSignal.addEventListener('abort', onAbort, { once: true });
        externalCleanup = () => opts.externalSignal?.removeEventListener('abort', onAbort);
      }
    }

    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${path}`);
      }
      const json = (await res.json()) as any;
      return normalizeRet(json, path) as T;
    } finally {
      clearTimeout(timer);
      externalCleanup?.();
    }
  }

  /** Internal: unified POST */
  private async post<T extends ILinkResponse>(
    path: string,
    body: unknown,
    opts: { timeoutMs?: number; baseUrlOverride?: string; externalSignal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${opts.baseUrlOverride ?? this.baseUrl}/${path.replace(/^\//, '')}`;
    const bodyStr = JSON.stringify(body);
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // External signal (gateway.stop) → abort immediately
    let externalCleanup: (() => void) | undefined;
    if (opts.externalSignal) {
      const onAbort = () => controller.abort();
      if (opts.externalSignal.aborted) {
        controller.abort();
      } else {
        opts.externalSignal.addEventListener('abort', onAbort, { once: true });
        externalCleanup = () => opts.externalSignal?.removeEventListener('abort', onAbort);
      }
    }

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: bodyStr,
        signal: controller.signal,
      });
      // iLink returns 200 + ret; non-200 is treated as a transport error
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${path}`);
      }
      const json = (await res.json()) as any;
      return normalizeRet(json, path) as T;
    } finally {
      clearTimeout(timer);
      externalCleanup?.();
    }
  }

  /**
   * Common headers; includes Bearer after login.
   *
   * Content-Length is not set: undici computes it from the UTF-8 byte count automatically.
   * Previously it was set manually using `bodyStr.length` (character count, not byte count),
   * which differed from the actual byte count when the body contained non-ASCII characters,
   * causing undici to detect a mismatch and throw an AbortError.
   */
  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomXWechatUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
    };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }
}

/** Generate a random 16-byte base64 string for the X-WECHAT-UIN header (one per request) */
function randomXWechatUin(): string {
  return randomBytes(16).toString('base64');
}

/** client_id for sendmessage — used by the server for deduplication (same id = idempotent) */
export function generateClientId(): string {
  return `philont-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/** SSRF protection: full_url must resolve to a host in WEIXIN_CDN_HOST_ALLOWLIST */
export function assertWeixinCdnUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`media url unparseable: ${url.slice(0, 100)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`media url protocol disallowed: ${parsed.protocol}`);
  }
  if (!WEIXIN_CDN_HOST_ALLOWLIST.has(parsed.hostname)) {
    throw new Error(
      `media url host not in allowlist: ${parsed.hostname} (refusing to fetch to prevent SSRF)`,
    );
  }
}

/** Build an outbound media item (image/file/voice/video) */
export function buildOutboundMediaItem(args: {
  mediaType: number;
  mediaField: MediaRef;
  paddedSize: number;
  rawSize: number;
  md5Hex: string;
  fileName?: string;
}): OutboundItem {
  const { mediaType, mediaField, paddedSize, rawSize, md5Hex, fileName } = args;
  if (mediaType === MEDIA_IMAGE) {
    return {
      type: ITEM_IMAGE,
      image_item: { media: mediaField, mid_size: paddedSize },
    };
  }
  if (mediaType === MEDIA_VIDEO) {
    return {
      type: ITEM_VIDEO,
      video_item: {
        media: mediaField,
        video_size: paddedSize,
        play_length: 0,
        video_md5: md5Hex,
      },
    };
  }
  if (mediaType === MEDIA_FILE) {
    if (!fileName) throw new Error('buildOutboundMediaItem: MEDIA_FILE requires fileName');
    return {
      type: ITEM_FILE,
      file_item: { media: mediaField, file_name: fileName, len: String(rawSize) },
    };
  }
  if (mediaType === MEDIA_VOICE) {
    return {
      type: ITEM_VOICE,
      voice_item: {
        media: mediaField,
        encode_type: 6,
        bits_per_sample: 16,
        sample_rate: 24000,
        playtime: 0,
      },
    };
  }
  throw new Error(`buildOutboundMediaItem: unknown mediaType ${mediaType}`);
}

/**
 * Inbound parse helper: extract all text fragments and join into a single string.
 * Media items are skipped (v1 does not consume images/files; they appear as placeholder strings).
 */
export function extractTextFromInbound(msg: InboundMessage): string {
  const items = msg.item_list ?? [];
  const parts: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case ITEM_TEXT:
        if (item.text_item?.text) parts.push(item.text_item.text);
        break;
      case ITEM_IMAGE:
        parts.push('[图片]');
        break;
      case ITEM_FILE:
        parts.push(`[文件:${item.file_item?.file_name ?? ''}]`);
        break;
      case ITEM_VOICE:
        // voice_item.text may contain ASR transcription
        parts.push(item.voice_item?.text ? `[语音:${item.voice_item.text}]` : '[语音]');
        break;
      case ITEM_VIDEO:
        parts.push('[视频]');
        break;
      default:
        // Unknown type — skip
        break;
    }
  }
  return parts.join('\n');
}

/** Inbound group message detection: room_id or chat_room_id non-empty → group message */
export function inboundIsGroup(msg: InboundMessage): boolean {
  return Boolean(msg.room_id || msg.chat_room_id);
}

/** Extract group id (if group message); otherwise empty string */
export function inboundGroupId(msg: InboundMessage): string {
  return msg.room_id || msg.chat_room_id || '';
}

/**
 * Normalise an iLink response into `{ ret: number, ... }`.
 *
 * Observed response shapes (reference: hermes handling):
 *   1. `{ ret: 0, ... }` standard
 *   2. `{ ret: <non-zero> }` error code
 *   3. `{ errcode: <non-zero>, errmsg: "..." }` — no ret field
 *   4. `{ msgs: [...], get_updates_buf: "..." }` — ret omitted entirely (implicit success)
 *
 * Normalisation strategy:
 *   - Missing ret but errcode present → use errcode as ret
 *   - Neither present → ret = 0 (treat as success)
 *   - Not an object → throw (transport layer is broken)
 */
export function normalizeRet(json: any, path: string): ILinkResponse {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(
      `iLink response from ${path} is not an object: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  if (typeof json.ret === 'number') return json as ILinkResponse;
  if (typeof json.errcode === 'number' && json.errcode !== 0) {
    return { ...json, ret: json.errcode } as ILinkResponse;
  }
  // Missing both ret and errcode: hermes treats this as success
  return { ...json, ret: 0 } as ILinkResponse;
}
