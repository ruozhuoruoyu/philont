/**
 * iLink Bot long-poll gateway
 *
 * Flow (reference: hermes weixin adapter):
 *   1. Start: acquire lock + load credentials + load context_tokens (including get_updates_buf cursor)
 *   2. Loop:
 *        client.getUpdates(buf, 40s timeout)
 *        ret=0  → for msg in msgs: dispatch(msg); update buf and persist to disk
 *        ret=-2 → exponential back-off ×3 then retry
 *        ret=-14 → token expired: audit + pause 10 minutes (waiting for user to re-scan)
 *        other ret → count as consecutive failure, sleep 2s; 5 consecutive failures → sleep 30s
 *        network error → same as above
 *   3. dispatch(msg):
 *        policy check (policy.allowsDm / allowsGroup)
 *        extract text (extractTextFromInbound) → call the injected onInbound callback
 *        if onInbound returns a string, send it back via the outbound queue
 *
 * Invariants:
 *   - Single instance per token — acquireLock at startup (rejects re-launch within 60s)
 *   - Cursor advances monotonically — immediately writeContextTokens after each successful
 *     getupdates call, so process restarts do not re-consume messages
 *   - getupdates ret=-14 → audit "wechat_token_expired" + stop retrying; wait for user to re-scan
 *
 * Design discipline:
 *   - dispatch callback is injected by caller (server/index connects handleChatSend)
 *   - clock / sleep are injectable for test time-skipping
 *   - logger is injectable; defaults to console
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ILinkClient,
  type GetUpdatesResponse,
  type InboundMessage,
  type InboundItem,
  ERR_OK,
  ERR_RATE_LIMIT,
  ERR_SESSION_EXPIRED,
  ITEM_TEXT,
  ITEM_IMAGE,
  ITEM_FILE,
  ITEM_VOICE,
  ITEM_VIDEO,
  inboundIsGroup,
  inboundGroupId,
} from './client.js';
import {
  type WeChatCredentials,
  readContextTokens,
  writeContextTokens,
  acquireLock,
  releaseLock,
  getInboxDir,
} from './state.js';
import {
  checkInboundPolicy,
  type PolicyConfig,
  DEFAULT_POLICY,
  type PolicyDecision,
} from './policy.js';

export const RETRY_DELAY_MS = 2_000;
export const BACKOFF_DELAY_MS = 30_000;
export const SESSION_EXPIRED_PAUSE_MS = 10 * 60_000;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const RATE_LIMIT_BACKOFF_MULT = 3;
export const RATE_LIMIT_BASE_MS = 5_000;

/** Normalised inbound event passed to dispatch */
export interface InboundEvent {
  /** Message id from iLink */
  messageId: string;
  /** Sender user_id */
  fromUserId: string;
  /** Group id; empty string = DM */
  groupId: string;
  /** Extracted text (images/files/etc. converted to placeholder strings) */
  text: string;
  /** iLink incremental context token; including it in the reply can continue LLM context */
  contextToken?: string;
  /** Raw message (retained for advanced consumers that need to inspect item_list) */
  raw: InboundMessage;
}

/** dispatch callback: caller decides what to do. Returning a string → gateway auto-sends it back */
export type InboundDispatcher = (e: InboundEvent) => Promise<string | void>;

/** Minimal logger interface (avoids external dependencies) */
export interface GatewayLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: GatewayLogger = {
  info: (m, meta) => console.log(`[wechat-gw] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[wechat-gw] ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`[wechat-gw] ${m}`, meta ?? ''),
};

/**
 * Callback invoked after an inbound attachment is successfully downloaded and saved to disk.
 * The caller uses this to push a record to the cross-channel recent_attachments singleton,
 * so chat-handler can expose "recently uploaded" files to the LLM at the top of the next-turn
 * prefix without the LLM having to glob the filesystem. Failed attachments are not reported
 * (only logged).
 */
export interface InboundAttachmentInfo {
  kind: 'file' | 'image' | 'voice' | 'video';
  filename: string;
  /** Absolute local path where the file was saved */
  path: string;
  /** Sending user id (optional) */
  fromUser?: string;
}

export interface GatewayOptions {
  credentials: WeChatCredentials;
  dispatch: InboundDispatcher;
  /** Reuse an existing client (for test mock fetch) */
  client?: ILinkClient;
  /** Admission policy */
  policy?: PolicyConfig;
  /** Single long-poll timeout in ms (should be slightly longer than server's 35s) */
  pollTimeoutMs?: number;
  /** Sleep injection (for testing) */
  sleep?: (ms: number) => Promise<void>;
  /** Logger injection */
  logger?: GatewayLogger;
  /** Skip lock check (for testing) */
  skipLock?: boolean;
  /** Reply text for blocked messages; empty string = completely silent */
  blockedReplyTemplate?: string;
  /** Hook called after successful inbound media download (used by recent_attachments). Not called on failure. */
  onAttachment?: (att: InboundAttachmentInfo) => void;
}

const DEFAULT_BLOCKED_REPLY = '抱歉,当前账户未授权与本智能体对话。如需使用,请联系部署者将你加入 allowlist。';

/**
 * Long-poll gateway.
 *
 * Usage:
 *   const gw = new ILinkGateway({ credentials, dispatch });
 *   await gw.start();          // async loop; runs indefinitely
 *   ...
 *   await gw.stop();           // graceful shutdown
 */
export class ILinkGateway {
  private readonly client: ILinkClient;
  private readonly accountId: string;
  private readonly dispatch: InboundDispatcher;
  private readonly policy: PolicyConfig;
  private readonly pollTimeoutMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logger: GatewayLogger;
  private readonly skipLock: boolean;
  private readonly blockedTemplate: string;
  private readonly onAttachment?: (att: InboundAttachmentInfo) => void;

  private running = false;
  private stopRequested = false;
  private getUpdatesBuf = '';
  private consecutiveFailures = 0;
  private rateLimitWaitMs = RATE_LIMIT_BASE_MS;
  /** AbortController for the in-flight long-poll; stop() aborts it immediately so fetch throws AbortError */
  private abortController: AbortController | null = null;

  constructor(opts: GatewayOptions) {
    this.client =
      opts.client ?? new ILinkClient({ baseUrl: opts.credentials.baseUrl, token: opts.credentials.token });
    if (!opts.client) this.client.setToken(opts.credentials.token);
    this.accountId = opts.credentials.accountId;
    this.dispatch = opts.dispatch;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 40_000;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = opts.logger ?? CONSOLE_LOGGER;
    this.skipLock = opts.skipLock ?? false;
    this.blockedTemplate = opts.blockedReplyTemplate ?? DEFAULT_BLOCKED_REPLY;
    this.onAttachment = opts.onAttachment;
  }

  /**
   * Start the long-poll loop. The returned Promise resolves when stop() is called
   * or an unrecoverable error occurs.
   */
  async start(): Promise<void> {
    if (this.running) throw new Error('gateway already running');

    if (!this.skipLock) {
      const existing = acquireLock(this.accountId);
      if (existing) {
        throw new Error(
          `another gateway instance is running for ${this.accountId} (pid=${existing.pid}, started ${new Date(existing.startedAt).toISOString()})`,
        );
      }
    }

    // Load cursor
    const stored = readContextTokens(this.accountId) as { get_updates_buf?: string } | null;
    this.getUpdatesBuf = stored?.get_updates_buf ?? '';

    this.running = true;
    this.stopRequested = false;
    this.logger.info('gateway started', { accountId: this.accountId });

    try {
      await this.loop();
    } finally {
      this.running = false;
      if (!this.skipLock) releaseLock(this.accountId);
      this.logger.info('gateway stopped', { accountId: this.accountId });
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.abortController?.abort();
  }

  /** Main loop */
  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      let res: GetUpdatesResponse | null = null;
      this.abortController = new AbortController();
      try {
        res = await this.client.getUpdates(
          this.getUpdatesBuf,
          this.pollTimeoutMs,
          this.abortController.signal,
        );
      } catch (e) {
        // Network error / abort
        if (this.stopRequested) break;
        this.consecutiveFailures++;
        const wait =
          this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        this.logger.warn(`getUpdates exception: ${String(e)}`, {
          consecutiveFailures: this.consecutiveFailures,
          waitMs: wait,
        });
        await this.sleepFn(wait);
        continue;
      }

      if (res.ret === ERR_OK) {
        this.consecutiveFailures = 0;
        this.rateLimitWaitMs = RATE_LIMIT_BASE_MS;
        const newBuf = (res.get_updates_buf as string | undefined) ?? '';
        if (newBuf && newBuf !== this.getUpdatesBuf) {
          this.getUpdatesBuf = newBuf;
          // Persist cursor immediately — prevents re-consuming messages if dispatch crashes
          writeContextTokens(this.accountId, { get_updates_buf: this.getUpdatesBuf });
        }
        const msgs = res.msgs ?? [];
        for (const msg of msgs) {
          if (this.stopRequested) break;
          await this.handleInbound(msg);
        }
        // Even if no messages, immediately continue long-polling (server will hold for 35s)
        continue;
      }

      if (res.ret === ERR_SESSION_EXPIRED) {
        this.logger.error(`token expired (ret=-14),paused ${SESSION_EXPIRED_PAUSE_MS / 1000}s,需重新扫码登录`, {
          accountId: this.accountId,
        });
        await this.sleepFn(SESSION_EXPIRED_PAUSE_MS);
        continue;
      }

      if (res.ret === ERR_RATE_LIMIT) {
        this.logger.warn(`rate limit hit (ret=-2),backing off ${this.rateLimitWaitMs}ms`, {
          accountId: this.accountId,
        });
        await this.sleepFn(this.rateLimitWaitMs);
        this.rateLimitWaitMs = Math.min(this.rateLimitWaitMs * RATE_LIMIT_BACKOFF_MULT, BACKOFF_DELAY_MS);
        continue;
      }

      // Other error codes
      this.consecutiveFailures++;
      const wait =
        this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
      this.logger.warn(`getUpdates ret=${res.ret} errmsg=${res.errmsg ?? ''}`, {
        consecutiveFailures: this.consecutiveFailures,
        waitMs: wait,
      });
      await this.sleepFn(wait);
    }
  }

  /** Handle a single inbound message: policy + text/media extraction + dispatch + auto-reply */
  private async handleInbound(msg: InboundMessage): Promise<void> {
    const fromUserId = msg.from_user_id ?? '';
    const groupId = inboundGroupId(msg);
    const decision: PolicyDecision = checkInboundPolicy(
      { fromUserId, groupId: groupId || undefined },
      this.policy,
    );

    if (!decision.allowed) {
      this.logger.info(`inbound blocked: ${decision.reason}`, { fromUserId, groupId });
      // Only reply in DMs when blocked; silently drop in groups to avoid revealing the bot's presence
      if (!groupId && this.blockedTemplate.length > 0) {
        try {
          await this.client.sendText(fromUserId, this.blockedTemplate);
        } catch {
          /* swallow */
        }
      }
      return;
    }

    // Media download + text assembly. Unlike plain extractTextFromInbound, this also
    // saves images/files/videos/voice to the inbox directory, giving the LLM a readable
    // local path in the user message that it can process with readFile / shell commands.
    const text = await this.extractInboundContent(msg, fromUserId);
    const event: InboundEvent = {
      messageId: msg.message_id ?? '',
      fromUserId,
      groupId,
      text,
      contextToken: msg.context_token,
      raw: msg,
    };

    this.logger.info(`inbound ${inboundIsGroup(msg) ? 'GROUP' : 'DM'}`, {
      from: fromUserId,
      group: groupId || undefined,
      preview: text.slice(0, 40),
    });
    // Debug: dump raw msg (condensed, skipping item_list to avoid log explosion) to help
    // detect field semantic differences
    {
      const dump: Record<string, unknown> = {};
      for (const k of Object.keys(msg)) {
        if (k === 'item_list') continue;
        dump[k] = (msg as any)[k];
      }
      this.logger.info('inbound raw', dump);
    }

    let reply: string | void;
    try {
      reply = await this.dispatch(event);
    } catch (e) {
      this.logger.error(`dispatch threw: ${String(e)}`, { messageId: event.messageId });
      return;
    }

    if (typeof reply === 'string' && reply.length > 0) {
      // Auto-send reply (group messages reply to the group; DMs reply to the individual)
      const to = groupId || fromUserId;
      try {
        await this.client.sendText(to, reply, { contextToken: msg.context_token });
      } catch (e) {
        this.logger.error(`send reply failed: ${String(e)}`, { to });
      }
    }
  }

  /**
   * Walk the inbound message's item_list, download media to disk,
   * and assemble human-readable text for the LLM.
   *
   * Extra work compared to `extractTextFromInbound`:
   *   - image/file/voice/video are actually downloaded, decrypted, and written to the inbox dir
   *   - Placeholders upgraded from `[image]` to `[image:/abs/path/img.bin]`
   *   - If any media download fails: do not interrupt; still use the generic placeholder, but log warn
   *
   * Save location: `<account>/inbox/<msgId>/<index>-<kind>[.<ext>]`
   * File names give the LLM a hint (`image.bin` / `file_<name>` / `voice.silk` / `video.mp4`).
   */
  private async extractInboundContent(msg: InboundMessage, fromUser: string): Promise<string> {
    /**
     * Notify the onAttachment hook. Only called when path is non-null (download succeeded).
     * Hook must not affect dispatch: any exception is swallowed and only warned, to keep
     * the main flow uninterrupted.
     */
    const notify = (att: InboundAttachmentInfo) => {
      if (!this.onAttachment) return;
      try {
        this.onAttachment(att);
      } catch (e) {
        this.logger.warn(`onAttachment hook threw: ${String(e)}`, { path: att.path });
      }
    };
    const items = msg.item_list ?? [];
    if (items.length === 0) return '';

    const messageId = msg.message_id ?? `unknown_${Date.now()}`;
    const parts: string[] = [];
    let inboxEnsured = false;
    const ensureInbox = (): string => {
      const dir = getInboxDir(this.accountId, String(messageId));
      if (!inboxEnsured) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          /* ignore — will throw when writing the file */
        }
        inboxEnsured = true;
      }
      return dir;
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as InboundItem;
      switch (item.type) {
        case ITEM_TEXT: {
          const text = item.text_item?.text ?? '';
          // Quoted reply: prepend "[quote: …]" so the LLM knows which message was quoted.
          // Logic aligned with hermes weixin.py::_extract_text.
          const ref = item.ref_msg;
          const refItem = ref?.message_item;
          if (refItem) {
            const refType = refItem.type;
            const isMedia =
              refType === ITEM_IMAGE || refType === ITEM_VIDEO || refType === ITEM_FILE || refType === ITEM_VOICE;
            if (isMedia) {
              const t = ref?.title ? `[引用媒体: ${ref.title}]` : '[引用媒体]';
              parts.push(`${t}\n${text}`.trim());
            } else {
              const refParts: string[] = [];
              if (ref?.title) refParts.push(ref.title);
              if (refItem.text_item?.text) refParts.push(refItem.text_item.text);
              parts.push(refParts.length ? `[引用: ${refParts.join(' | ')}]\n${text}`.trim() : text);
            }
          } else if (text) {
            parts.push(text);
          }
          break;
        }
        case ITEM_IMAGE: {
          const path = await this.tryDownloadMedia(item.image_item?.media, ensureInbox(), `${i}-image.bin`);
          parts.push(path ? `[图片:${path}]` : '[图片(下载失败)]');
          if (path) notify({ kind: 'image', filename: `${i}-image.bin`, path, fromUser });
          break;
        }
        case ITEM_FILE: {
          const fname = item.file_item?.file_name || `${i}-file.bin`;
          const safeFname = fname.replace(/[^A-Za-z0-9._一-龥-]/g, '_').slice(0, 120);
          const path = await this.tryDownloadMedia(item.file_item?.media, ensureInbox(), `${i}-${safeFname}`);
          parts.push(
            path ? `[文件:${fname}|${path}]` : `[文件:${fname}(下载失败)]`,
          );
          if (path) notify({ kind: 'file', filename: fname, path, fromUser });
          break;
        }
        case ITEM_VOICE: {
          const path = await this.tryDownloadMedia(item.voice_item?.media, ensureInbox(), `${i}-voice.silk`);
          // voice_item.text may contain ASR transcription from the server
          const asr = item.voice_item?.text;
          if (path) {
            parts.push(asr ? `[语音:${asr}|${path}]` : `[语音:${path}]`);
            notify({ kind: 'voice', filename: `${i}-voice.silk`, path, fromUser });
          } else {
            parts.push(asr ? `[语音:${asr}]` : '[语音(下载失败)]');
          }
          break;
        }
        case ITEM_VIDEO: {
          const path = await this.tryDownloadMedia(item.video_item?.media, ensureInbox(), `${i}-video.mp4`);
          parts.push(path ? `[视频:${path}]` : '[视频(下载失败)]');
          if (path) notify({ kind: 'video', filename: `${i}-video.mp4`, path, fromUser });
          break;
        }
        default:
          // Unknown type — skip
          break;
      }
    }
    return parts.join('\n');
  }

  /** Download media and save to disk; on failure only warn (do not throw, so other items can still dispatch) */
  private async tryDownloadMedia(
    media: { encrypt_query_param?: string; aes_key?: string; full_url?: string } | undefined,
    inboxDir: string,
    fileName: string,
  ): Promise<string | null> {
    if (!media) return null;
    if (!media.encrypt_query_param && !media.full_url) return null;
    try {
      const bytes = await this.client.downloadMedia(media);
      const path = join(inboxDir, fileName);
      writeFileSync(path, bytes);
      this.logger.info('inbound media saved', {
        path,
        size: bytes.length,
      });
      return path;
    } catch (e) {
      this.logger.warn(`inbound media download failed: ${String(e)}`, { fileName });
      return null;
    }
  }
}
