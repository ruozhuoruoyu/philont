/**
 * Telegram Bot API client — lightweight implementation
 *
 * Covers only the core methods the channel needs: getUpdates (long polling) /
 * sendMessage / sendChatAction (typing) / sendPhoto / sendDocument / getMe.
 *
 * Protocol reference: Telegram Bot API (https://core.telegram.org/bots/api).
 * Implementation approach inspired by Hermes-Agent gateway/platforms/telegram.py,
 * but only the core send/receive is taken — edge cases like forum-topic /
 * thread-anchor / polling-conflict handling are not replicated.
 */

const DEFAULT_TIMEOUT_MS = 35_000; // long-poll 30s + margin

/**
 * Proxy dispatcher (Telegram-specific only).
 *
 * api.telegram.org is blocked in some regions (e.g. mainland China), and Node's
 * global fetch does **not** read the HTTPS_PROXY environment variable. A undici
 * ProxyAgent is created on demand and attached only to Telegram's fetch calls
 * (via the dispatcher option), **without affecting** direct connections to
 * domestic services like DeepSeek / WeChat.
 *
 * Proxy URL priority: TELEGRAM_PROXY (Telegram-specific override) > PHILONT_PROXY
 * (global) > HTTPS_PROXY > https_proxy > ALL_PROXY > all_proxy.
 * Note: even if this returns undefined, if the process has set a global dispatcher
 * (see proxy-bootstrap.ts), Telegram fetches without a dispatcher will still use the
 * global proxy — listing it here explicitly is for log consistency and to support
 * "Telegram uses proxy A, everything else uses proxy B" scenarios.
 * Gracefully degrades when undici is not installed (direct connect + one-time warning),
 * so the channel won't crash.
 */
let proxyDispatcherPromise: Promise<unknown | undefined> | null = null;
function getProxyDispatcher(): Promise<unknown | undefined> {
  if (proxyDispatcherPromise) return proxyDispatcherPromise;
  const url =
    process.env.TELEGRAM_PROXY ||
    process.env.PHILONT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  proxyDispatcherPromise = (async () => {
    if (!url) return undefined;
    try {
      // Variable specifier: prevents TS from statically resolving 'undici' (avoids
      // typecheck errors when undici is not installed); provided by server/package.json's
      // undici dependency at runtime.
      const spec = 'undici';
      const undici = (await import(spec)) as { ProxyAgent: new (u: string) => unknown };
      console.log(`[telegram] using proxy ${url.replace(/\/\/.*@/, '//***@')}`);
      return new undici.ProxyAgent(url);
    } catch {
      console.warn('[telegram] proxy config detected but undici is not installed; Telegram will connect directly (may fail). Run `npm i` under server/');
      return undefined;
    }
  })();
  return proxyDispatcherPromise;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  date: number;
  /** Quoted reply: when a user replies to a message, this contains the quoted message (with its text/caption). */
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export class TelegramClient {
  private readonly base: string;

  constructor(private readonly token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  /** Verify the token and return bot info (username, etc.). Throws on failure. */
  async getMe(): Promise<TelegramUser> {
    const data = await this.call<TelegramUser>('getMe', {}, 10_000);
    return data;
  }

  /**
   * Long-poll for updates. offset = last max update_id + 1 (acknowledged ones are not returned again).
   * timeoutSec = server hold duration (0 = return immediately). signal can abort.
   */
  async getUpdates(
    offset: number,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const data = await this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message'],
      },
      (timeoutSec + 10) * 1000,
      signal,
    );
    return data ?? [];
  }

  /** Send text. Telegram's single-message limit is 4096 characters; chunking is handled by OutboundQueue. */
  async sendText(chatId: string, text: string): Promise<SendResult> {
    try {
      const msg = await this.call<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text,
        // No parse_mode: plain text, zero escaping risk (Telegram MarkdownV2 returns 400
        // for unescaped special characters).
        disable_web_page_preview: true,
      });
      return { ok: true, messageId: String(msg.message_id) };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }

  /** Send a typing status (valid for 5s, can be re-sent). Fire-and-forget; silent on failure. */
  async sendChatAction(chatId: string, action: 'typing' | 'upload_photo' | 'upload_document' = 'typing'): Promise<void> {
    try {
      await this.call('sendChatAction', { chat_id: chatId, action }, 8_000);
    } catch {
      /* typing failure is harmless */
    }
  }

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<SendResult> {
    return this.sendFile('sendPhoto', 'photo', chatId, filePath, caption);
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<SendResult> {
    return this.sendFile('sendDocument', 'document', chatId, filePath, caption);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Call a Bot API method (JSON body). Throws on failure (network / ok:false). */
  private async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const sig = signal ? anySignal([signal, ctrl.signal]) : ctrl.signal;
    const dispatcher = await getProxyDispatcher();
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: sig,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
    } finally {
      clearTimeout(timer);
    }
    return this.unwrap<T>(resp, method);
  }

  /** Multipart file upload (sendPhoto / sendDocument). */
  private async sendFile(
    method: string,
    field: string,
    chatId: string,
    filePath: string,
    caption?: string,
  ): Promise<SendResult> {
    try {
      const { readFile } = await import('node:fs/promises');
      const { basename } = await import('node:path');
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append('chat_id', chatId);
      if (caption) form.append('caption', caption);
      form.append(field, new Blob([bytes]), basename(filePath));

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      const dispatcher = await getProxyDispatcher();
      let resp: Response;
      try {
        resp = await fetch(`${this.base}/${method}`, {
          method: 'POST',
          body: form,
          signal: ctrl.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
      } finally {
        clearTimeout(timer);
      }
      const msg = await this.unwrap<TelegramMessage>(resp, method);
      return { ok: true, messageId: String(msg.message_id) };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }

  private async unwrap<T>(resp: Response, method: string): Promise<T> {
    const text = await resp.text();
    let json: { ok?: boolean; result?: T; description?: string; error_code?: number };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`telegram ${method}: non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }
    if (!json.ok) {
      const err = new Error(`telegram ${method} failed: ${json.error_code ?? resp.status} ${json.description ?? ''}`);
      (err as Error & { code?: number }).code = json.error_code ?? resp.status;
      throw err;
    }
    return json.result as T;
  }
}

/** Merge multiple AbortSignals (aborts when any of them aborts). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
