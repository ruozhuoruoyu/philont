/**
 * recent_attachments — cross-channel "recently uploaded files" ledger.
 *
 * Problem being solved (from user conversation post-mortems):
 *   - User uploads a PDF on the wechat channel, then on the web-ui channel says
 *     "convert the one I just uploaded to Word".
 *   - Although the K0 global timeline can recall wechat inbound messages
 *     (which embed [file:name|/path] encoding), the retriever uses keyword +
 *     proximity matching — a pronoun like "just uploaded" carries no semantic
 *     signal and is often missed.
 *   - The agent can only glob the disk / guess the path from verbal hints, causing
 *     repeated detours.
 *
 * Design decisions:
 *   - **In-memory ring buffer** (no persistence): losing it on restart is fine —
 *     the file itself stays on disk; if the user still wants to reference it after
 *     a restart they can supply the filename/path explicitly. This memory only serves
 *     short-window references like "the one I just uploaded"; it is unlikely to be
 *     useful beyond 1 hour.
 *   - **Cross-channel identification**: each record carries a `channel` field
 *     (`wechat:<accountId>` / `webui` / future others) so the agent can see the
 *     source in the prefix and distinguish which channel the file came from.
 *   - **No dedup / no merging**: the same file uploaded multiple times within 1 h
 *     (rare) counts as separate records — simple and reliable.
 *
 * MAX_RECORDS=20: enough to cover a batch upload (typically ≤ 10 images) plus a
 * few cross-channel entries; ring buffer drops the oldest when it overflows.
 */

const MAX_RECORDS = 20;

export interface AttachmentRecord {
  /** Source identifier. E.g.: `wechat:<accountId>` / `webui` / future other channels. */
  channel: string;
  /** Media category. `file` is a generic binary attachment; the other three are wechat item types. */
  kind: 'file' | 'image' | 'voice' | 'video';
  /** User-visible filename (e.g. deepseek_v4.pdf); may be a fallback name inferred by the channel. */
  filename: string;
  /** Local absolute path; the agent can pass this directly to readFile / shell for processing. */
  path: string;
  /** Sender identifier (user id within the channel); optional — some channels cannot provide it. */
  fromUser?: string;
  /** unix epoch ms */
  ts: number;
}

/** Module-level singleton (single-process in-process is fine; not retained across restarts). */
const records: AttachmentRecord[] = [];

/** Push a record. Thread-safe: Node is single-threaded + synchronous push, no concurrency issues. */
export function recordAttachment(att: AttachmentRecord): void {
  records.push(att);
  while (records.length > MAX_RECORDS) records.shift();
}

/**
 * Get recent attachments, sorted by time descending (newest first).
 *   - limit  default 5
 *   - ttlMs  default 1 hour; expired entries are excluded (semantics: "just uploaded" window)
 *
 * Does not assume records are strictly ordered by ts — in theory push order equals
 * time order, but callers / tests may inject historical ts values. Filter then sort;
 * correctness over micro-optimisation (N ≤ 20).
 */
export function recentAttachments(
  opts: { limit?: number; ttlMs?: number; now?: number } = {},
): AttachmentRecord[] {
  const limit = opts.limit ?? 5;
  const ttl = opts.ttlMs ?? 60 * 60_000;
  const now = opts.now ?? Date.now();
  // Sort by (ts, insertion index): on equal ts (burst / test), use insertion order to
  // determine which is newer, so "later inserted = more recent".
  return records
    .map((r, idx) => ({ r, idx }))
    .filter((x) => now - x.r.ts < ttl)
    .sort((a, b) => b.r.ts - a.r.ts || b.idx - a.idx)
    .slice(0, limit)
    .map((x) => x.r);
}

/**
 * Test hook: clear all records. **Do not call in production code**.
 */
export function _resetForTests(): void {
  records.length = 0;
}
