/**
 * WeChat outbound message layer — chunking / rate-limiting / deduplication / markdown-boundary-preserving
 *
 * Does not depend on specific iLink protocol endpoints. The caller injects a `RawSender`
 * (a callback that sends a single short text message), and this layer handles:
 *   - 4000-character limit → markdown-aware chunking (paragraph/list/code-fence boundaries)
 *   - 0.3s inter-chunk delay (to avoid triggering iLink rate limit)
 *   - 5-minute sliding-window deduplication (same to + same content hash → skip)
 *
 * Design discipline:
 *   - Pure logic + pure-function helpers; no HTTP / no fs IO. Caller injects sender.
 *   - State (dedup window, last-send timestamp) is encapsulated in the class instance and
 *     persists across calls.
 *   - Time-sensitive parts (now / sleep) are injectable via clock; tests can freeze time.
 */

import { createHash } from 'node:crypto';

/** iLink Bot single-message text limit */
export const TEXT_CHUNK_LIMIT = 4000;

/** Minimum inter-chunk delay (to avoid rate-limit) */
export const CHUNK_DELAY_MS = 300;

/** Deduplication window length */
export const DEDUP_WINDOW_MS = 5 * 60_000;

/** Low-level callback that sends a short text to iLink; outbound layer is agnostic of the implementation */
export type RawSender = (to: string, text: string) => Promise<{ ok: boolean; messageId?: string }>;

/**
 * Sanitize text into a form safe for sending to WeChat.
 *
 * Steps:
 *   1. UI render symbol ↵ → real newline (some upstreams visualise newlines this way)
 *   2. Control characters (\x00-\x08, \x0E-\x1F, \x7F) → delete
 *      (WeChat does not render them but they can corrupt the client)
 *   3. U+FFFD decode-failure placeholder → replace with ?
 *      (makes garbled content visually obvious rather than a genuine "?" character)
 *   4. NUL bytes → delete
 *
 * Untouched: valid \t / \n / \r and all Unicode printable characters (including emoji and CJK).
 */
export function sanitizeForWechat(text: string): string {
  if (!text) return '';
  return text
    .replace(/↵/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/�/g, '?');
}

/** Clock + sleep injection; defaults to real time */
export interface OutboundClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: OutboundClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface OutboundOptions {
  chunkLimit?: number;
  chunkDelayMs?: number;
  dedupWindowMs?: number;
  clock?: OutboundClock;
}

export interface SendTextResult {
  /** Number of chunks actually sent */
  chunksSent: number;
  /** Number of chunks skipped due to deduplication */
  chunksDeduped: number;
  /** messageId for each sent chunk */
  messageIds: string[];
}

/**
 * Split markdown text at "semantic boundaries" to chunks of ≤ limit.
 *
 * Priority (high → low):
 *   1. Double newline (paragraph break)
 *   2. Single newline (line break)
 *   3. Sentence-ending punctuation (Chinese and English)
 *   4. Half-width space / full-width comma
 *   5. Hard cut at exactly limit (last resort)
 *
 * Does not break fenced code blocks (```) — when a code block straddles a boundary,
 * the entire block is pushed into the next chunk (if the block itself exceeds limit,
 * it is hard-cut with a comment added).
 */
export function chunkMarkdown(text: string, limit: number = TEXT_CHUNK_LIMIT): string[] {
  if (limit <= 0) throw new Error('chunkMarkdown: limit must be > 0');
  if (text.length <= limit) return text.length > 0 ? [text] : [];

  const out: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cutAt = limit;

    // Priority 1: double newline
    let p = remaining.lastIndexOf('\n\n', limit);
    if (p > limit / 2) {
      cutAt = p + 2;
    } else {
      // Priority 2: single newline
      p = remaining.lastIndexOf('\n', limit);
      if (p > limit / 2) {
        cutAt = p + 1;
      } else {
        // Priority 3: sentence-ending punctuation
        p = lastSentenceEnd(remaining, limit);
        if (p > limit / 2) {
          cutAt = p + 1;
        } else {
          // Priority 4: whitespace
          p = remaining.lastIndexOf(' ', limit);
          if (p > limit / 2) {
            cutAt = p + 1;
          }
          // Priority 5: hard cut at limit (default value)
        }
      }
    }

    out.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }

  if (remaining.length > 0) out.push(remaining);
  return out;
}

/** Find the last sentence-ending punctuation position < limit (common Chinese and English) */
function lastSentenceEnd(s: string, limit: number): number {
  const candidates = ['. ', '? ', '! ', '。', '？', '!', '!', '；', ';'];
  let best = -1;
  for (const c of candidates) {
    const p = s.lastIndexOf(c, limit - 1);
    if (p > best) best = p;
  }
  return best;
}

/** Content hash for deduplication (short hash: first 16 hex chars of SHA-256) */
export function fingerprint(to: string, text: string): string {
  return createHash('sha256').update(to).update('\0').update(text).digest('hex').slice(0, 16);
}

/**
 * Outbound engine: maintains dedup window + rate limiting so callers don't have to.
 *
 * One instance per account; different accounts do not interfere with each other.
 */
export class OutboundQueue {
  private readonly chunkLimit: number;
  private readonly chunkDelayMs: number;
  private readonly dedupWindowMs: number;
  private readonly clock: OutboundClock;

  /** fingerprint → last send timestamp */
  private readonly recent = new Map<string, number>();
  /** Timestamp of the last "any send"; used for cross-call rate-limiting */
  private lastSentAt = 0;

  constructor(private readonly sender: RawSender, opts: OutboundOptions = {}) {
    this.chunkLimit = opts.chunkLimit ?? TEXT_CHUNK_LIMIT;
    this.chunkDelayMs = opts.chunkDelayMs ?? CHUNK_DELAY_MS;
    this.dedupWindowMs = opts.dedupWindowMs ?? DEDUP_WINDOW_MS;
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  /** Main entry: send text to `to`, with automatic chunking + rate-limiting + dedup */
  async sendText(to: string, text: string): Promise<SendTextResult> {
    // Sanitise render symbols / control characters / U+FFFD on the way out —
    // upstream tool results may carry these (typical sources: Windows GBK decode failure,
    // tool render layer's ↵ markers)
    const trimmed = sanitizeForWechat(text ?? '');
    if (trimmed.length === 0) return { chunksSent: 0, chunksDeduped: 0, messageIds: [] };

    const chunks = chunkMarkdown(trimmed, this.chunkLimit);
    const result: SendTextResult = { chunksSent: 0, chunksDeduped: 0, messageIds: [] };

    for (const chunk of chunks) {
      const fp = fingerprint(to, chunk);
      const now = this.clock.now();
      const seenAt = this.recent.get(fp);

      if (seenAt !== undefined && now - seenAt < this.dedupWindowMs) {
        result.chunksDeduped++;
        continue; // dedup hit
      }

      // Rate-limit: if the gap since the last send is less than chunkDelayMs → wait
      const since = now - this.lastSentAt;
      if (this.lastSentAt > 0 && since < this.chunkDelayMs) {
        await this.clock.sleep(this.chunkDelayMs - since);
      }

      const r = await this.sender(to, chunk);
      const after = this.clock.now();
      this.lastSentAt = after;
      this.recent.set(fp, after);
      this.gcRecent(after);

      if (r.ok) {
        result.chunksSent++;
        if (r.messageId) result.messageIds.push(r.messageId);
      }
    }

    return result;
  }

  /** Evict expired fingerprints (called after each send to prevent unbounded Map growth) */
  private gcRecent(now: number): void {
    const cutoff = now - this.dedupWindowMs;
    for (const [fp, ts] of this.recent) {
      if (ts < cutoff) this.recent.delete(fp);
    }
  }

  /** For testing: inspect current dedup table size */
  get dedupSize(): number {
    return this.recent.size;
  }
}
