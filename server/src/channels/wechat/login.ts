/**
 * iLink Bot scan-code login flow
 *
 * State machine (reference: hermes weixin adapter):
 *   1. Call ilink/bot/get_bot_qrcode → receive (qrcode hex token, qrcode_img_content URL)
 *   2. Render: print the URL + ANSI prompt for the user to scan with WeChat
 *   3. Poll ilink/bot/get_qrcode_status?qrcode={hex} every second:
 *        wait                   → keep waiting
 *        scaned                 → scanned; waiting for user to confirm on phone
 *        scaned_but_redirect    → rebuild client using redirect_host and retry (rare)
 *        expired                → call get_bot_qrcode again for a new QR (max 3 attempts)
 *        confirmed              → receive (ilink_bot_id, bot_token, baseurl, ilink_user_id)
 *   4. Persist credentials.json
 *
 * Timeout: entire flow is capped at 480s; hard-terminates after that.
 *
 * Design discipline:
 *   - Does not depend on actual stdout terminal — render callback is injectable (test fake)
 *   - Does not depend on real sleep — sleep is injectable for test fast-forwarding
 *   - Does not write to disk — returns WeChatCredentials to the caller; cli.ts decides where to write
 */

import { ILinkClient, type QrCodeResponse, type QrStatusResponse } from './client.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
  type WeChatCredentials,
} from './state.js';

export const QR_POLL_INTERVAL_MS = 1_000;
export const QR_TOTAL_TIMEOUT_MS = 480_000;
export const QR_MAX_REFRESH = 3;

/** UI injection: render the QR for the user (default: print the URL) */
export type QrRenderer = (info: { qrcodeUrl: string; qrcodeToken: string; attempt: number }) => void;

/** Sleep injection (for testing) */
export type SleepFn = (ms: number) => Promise<void>;

const REAL_SLEEP: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** Default renderer: print the URL to stdout */
export const DEFAULT_QR_RENDERER: QrRenderer = ({ qrcodeUrl, attempt }) => {
  const banner = '═'.repeat(60);
  console.log(`\n${banner}`);
  console.log(`📱 WeChat scan-QR login (attempt ${attempt})`);
  console.log(banner);
  console.log(`Please scan the QR code image in the URL below with WeChat:\n`);
  console.log(`    ${qrcodeUrl}\n`);
  console.log(`(Open this URL in a browser to show the QR code, then scan it with WeChat)`);
  console.log(`${banner}\n`);
};

export interface LoginOptions {
  /** Existing client (injectable mock fetch); if not provided, one is created */
  client?: ILinkClient;
  /** Starting baseUrl; used to construct a client if none is provided */
  baseUrl?: string;
  /** UI render callback */
  render?: QrRenderer;
  /** Sleep injection */
  sleep?: SleepFn;
  /** Per-QR wait cap (ms) */
  qrTotalTimeoutMs?: number;
  /** Max QR refreshes */
  maxRefresh?: number;
  /** Desired accountId (used as directory name when persisting); defaults to ilink_user_id */
  accountIdOverride?: string;
}

export type LoginResult =
  | { ok: true; credentials: WeChatCredentials }
  | { ok: false; reason: 'timeout' | 'qr_expired' | 'aborted' | 'malformed_response'; detail?: string };

/**
 * Main entry point: scan-code login, runs until confirmed or timeout.
 *
 * Does not write to disk — caller (cli.ts) receives LoginResult and decides where to write.
 */
export async function loginWithQrCode(opts: LoginOptions = {}): Promise<LoginResult> {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  let client = opts.client ?? new ILinkClient({ baseUrl });
  const render = opts.render ?? DEFAULT_QR_RENDERER;
  const sleep = opts.sleep ?? REAL_SLEEP;
  const qrTotalMs = opts.qrTotalTimeoutMs ?? QR_TOTAL_TIMEOUT_MS;
  const maxRefresh = opts.maxRefresh ?? QR_MAX_REFRESH;

  const startedAt = Date.now();
  let attempt = 0;

  while (attempt < maxRefresh) {
    attempt++;

    // (1) Get a new QR
    let qr: QrCodeResponse;
    try {
      qr = await client.getBotQrCode(3);
    } catch (e) {
      return { ok: false, reason: 'malformed_response', detail: `get_bot_qrcode failed: ${String(e)}` };
    }
    if (qr.ret !== 0 || !qr.qrcode || !qr.qrcode_img_content) {
      return {
        ok: false,
        reason: 'malformed_response',
        detail: `get_bot_qrcode ret=${qr.ret} errmsg=${qr.errmsg ?? ''}`,
      };
    }
    render({ qrcodeUrl: qr.qrcode_img_content, qrcodeToken: qr.qrcode, attempt });

    // (2) Poll status until confirmed / expired / timeout
    while (true) {
      if (Date.now() - startedAt > qrTotalMs) {
        return { ok: false, reason: 'timeout', detail: `${qrTotalMs}ms 内未确认登录` };
      }

      let status: QrStatusResponse;
      try {
        status = await client.getQrCodeStatus(qr.qrcode);
      } catch (e) {
        return { ok: false, reason: 'malformed_response', detail: `get_qrcode_status failed: ${String(e)}` };
      }

      switch (status.status) {
        case 'wait':
        case 'scaned':
          // Keep waiting
          await sleep(QR_POLL_INTERVAL_MS);
          continue;

        case 'scaned_but_redirect': {
          // Switch host and rebuild client (rare, but hermes handles it this way)
          if (status.redirect_host) {
            const newBase = normalizeBaseUrl(status.redirect_host);
            client = new ILinkClient({ baseUrl: newBase, fetch: opts.client ? undefined : undefined });
            await sleep(QR_POLL_INTERVAL_MS);
            continue;
          }
          // No redirect_host → treat as expired
          break; // → exit inner loop and call get_bot_qrcode again
        }

        case 'expired':
          // Exit inner loop to refresh QR in outer loop
          break;

        case 'confirmed': {
          if (!status.bot_token || !status.ilink_user_id) {
            return {
              ok: false,
              reason: 'malformed_response',
              detail: 'confirmed without bot_token / ilink_user_id',
            };
          }
          const finalBaseUrl = status.baseurl ? normalizeBaseUrl(status.baseurl) : baseUrl;
          const accountId = opts.accountIdOverride || status.ilink_user_id;
          const creds: WeChatCredentials = {
            accountId,
            token: status.bot_token,
            baseUrl: finalBaseUrl,
            cdnBaseUrl: DEFAULT_CDN_BASE_URL,
            createdAt: Date.now(),
          };
          return { ok: true, credentials: creds };
        }

        default:
          // Unknown status — treat as wait (lenient error handling)
          await sleep(QR_POLL_INTERVAL_MS);
          continue;
      }
      // status === 'expired' or 'scaned_but_redirect' without redirect_host → break inner loop
      break;
    }
  }

  return { ok: false, reason: 'qr_expired', detail: `已尝试 ${maxRefresh} 次扫码均超时` };
}

function normalizeBaseUrl(s: string): string {
  let u = s.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/$/, '');
}
