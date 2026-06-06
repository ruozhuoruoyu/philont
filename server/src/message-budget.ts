/**
 * Message budget: prevents messages[] from growing unboundedly and causing LLM 400 errors.
 *
 * Two layers of protection:
 *   1. truncateToolResultContent: hard cap per tool_result (~2MB),
 *      preventing a single malformed output from blowing the window. Call before push.
 *   2. evictOldToolResults: when total messages[] tokens exceed the budget,
 *      replace "old" tool_result content with a placeholder,
 *      keeping the most recent K results intact and preserving all user/assistant text.
 *      The LLM can still see "tool X was called before", maintaining context continuity.
 *
 * Unit note: follows the Compactor heuristic, chars × 0.6 ≈ tokens.
 * Actual Claude Sonnet/Opus Chinese token density is ~1 char/token, English ~0.25;
 * 0.6 is a conservative upper estimate for Chinese/English mixed content.
 */

import type { NativeMessage } from './llm-adapter.js';

export const DEFAULTS = {
  /** Per-tool_result hard truncation threshold (chars). 500KB chars ≈ 300K tokens,
   *  already 30% of a 1M window. Any single result exceeding this means the tool
   *  should emit smaller output — the window should not accommodate the tool. */
  maxSingleToolResultBytes: 500_000,
  /** messages[] total token budget for normal pre-compression. Leaves 30% headroom for estimation error. */
  contextBudgetTokens: 700_000,
  /** Number of most recent tool_results to keep on normal eviction */
  keepRecentToolResults: 4,
  /** Tighter budget for emergency (ContextTooLargeError fallback) */
  emergencyBudgetTokens: 200_000,
  /** Emergency eviction still keeps at least the 2 most recent tool_results, ensuring
   *  key facts like URLs / file paths from the current task are not wiped — this is
   *  the root cause of the "amnesia" bug */
  emergencyKeepRecent: 2,
  /** Emergency last-resort Pass 3: even recent tool_results get hard-truncated if their
   *  content exceeds this. Keeping the first N chars is sufficient for the LLM to know
   *  "which tool was called and what type of result came back"; discarding the tail does
   *  not break conversation structure (tool_use_id pairing remains intact). */
  emergencyMaxToolResultBytes: 8_000,
};

// ── Estimation ───────────────────────────────────────────────────────────────

function charsOf(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let sum = 0;
    for (const b of content) sum += charsOf(b);
    return sum;
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    // Anthropic TextBlock
    if (typeof obj.text === 'string') return obj.text.length;
    // Nested fields in tool_result content or tool_use input etc.
    if (obj.content !== undefined) return charsOf(obj.content);
    if (obj.input !== undefined) return charsOf(obj.input);
    try {
      return JSON.stringify(content).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function estimateMessageTokens(msg: NativeMessage): number {
  return Math.ceil(charsOf(msg.content) * 0.6);
}

export function estimateTotalTokens(messages: NativeMessage[]): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessageTokens(m);
  return sum;
}

// ── Per-result truncation ─────────────────────────────────────────────────────

/**
 * Hard-truncate a single tool_result's content string.
 * Called only before push, as a safety fallback.
 */
export function truncateToolResultContent(
  content: string,
  maxBytes: number = DEFAULTS.maxSingleToolResultBytes,
): string {
  if (content.length <= maxBytes) return content;
  const kept = content.slice(0, maxBytes);
  const omitted = content.length - maxBytes;
  return (
    kept +
    `\n\n[philont: tool output too large; truncated tail of ${omitted} bytes (kept first ${maxBytes}).` +
    ` For full content, use chunked reading, e.g. readFile(path, offset, limit) or more precise grep/webFetch parameters.]`
  );
}

// ── Old tool_result eviction ──────────────────────────────────────────────────

const EVICTED_MARKER_PREFIX = '[philont: tool result evicted]';

function isEvictedPlaceholder(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith(EVICTED_MARKER_PREFIX);
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as Record<string, unknown>).type === 'tool_result'
  );
}

function locateToolResults(messages: NativeMessage[]): Array<{
  msgIdx: number;
  blockIdx: number;
  byteLen: number;
}> {
  const out: Array<{ msgIdx: number; blockIdx: number; byteLen: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const c = messages[i].content;
    if (!Array.isArray(c)) continue;
    for (let j = 0; j < c.length; j++) {
      if (isToolResultBlock(c[j])) {
        out.push({
          msgIdx: i,
          blockIdx: j,
          byteLen: charsOf((c[j] as ToolResultBlock).content),
        });
      }
    }
  }
  return out;
}

export interface EvictionOptions {
  budgetTokens?: number;
  keepRecent?: number;
}

export interface EvictionResult {
  didEvict: boolean;
  evictedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * In-place eviction of old tool_result content, replaced with a placeholder.
 *
 * Behaviour:
 *   - tokensBefore ≤ budget → no-op
 *   - Otherwise: replace from the earliest tool_result, until total drops below budget
 *   - The last keepRecent tool_results are never touched
 *   - Already-placeholder entries are skipped (idempotent; multiple calls are no-ops)
 */
export function evictOldToolResults(
  messages: NativeMessage[],
  options: EvictionOptions = {},
): EvictionResult {
  const budget = options.budgetTokens ?? DEFAULTS.contextBudgetTokens;
  const keepRecent = options.keepRecent ?? DEFAULTS.keepRecentToolResults;

  const tokensBefore = estimateTotalTokens(messages);
  if (tokensBefore <= budget) {
    return {
      didEvict: false,
      evictedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const locs = locateToolResults(messages);
  if (locs.length <= keepRecent) {
    return {
      didEvict: false,
      evictedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const candidates = locs.slice(0, locs.length - keepRecent);
  let evicted = 0;
  let currentTokens = tokensBefore;

  for (const { msgIdx, blockIdx, byteLen } of candidates) {
    if (currentTokens <= budget) break;
    const msg = messages[msgIdx];
    const blocks = msg.content as unknown[];
    const block = blocks[blockIdx] as ToolResultBlock;
    if (isEvictedPlaceholder(block.content)) continue;

    const placeholder =
      `${EVICTED_MARKER_PREFIX} (original ${byteLen} chars discarded; context budget exceeded.` +
      ` To retrieve again, call the corresponding tool once more)`;
    const savedChars = byteLen - placeholder.length;
    blocks[blockIdx] = { ...block, content: placeholder };
    currentTokens -= Math.ceil(savedChars * 0.6);
    evicted++;
  }

  return {
    didEvict: evicted > 0,
    evictedCount: evicted,
    tokensBefore,
    tokensAfter: currentTokens,
  };
}

/**
 * Emergency eviction: used as the ContextTooLargeError fallback.
 *
 * Two passes:
 *   1. Evict old tool_results (keeping the most recent emergencyKeepRecent entries)
 *   2. If tool_result eviction alone is not enough to drop below budget → **truncate
 *      oversized text messages** (string content or text blocks in user/assistant messages)
 *      beyond the most recent K messages
 *
 * Known fatal scenario caught in practice: the memory prefix was corrupted to 2M tokens
 * stuffed into the first user message; there were only 1-2 historical tool_results —
 * nowhere near large enough. Without truncating text messages, emergency eviction is useless.
 *
 * Retention policy:
 *   - The last keepRecent messages (regardless of role / text vs tool_result) are preserved intact
 *   - Earlier messages: tool_results replaced with placeholder; long text (>maxTextMsgBytes) is tail-truncated
 */
export function evictForEmergency(messages: NativeMessage[]): EvictionResult {
  const tokensBefore = estimateTotalTokens(messages);

  // Pass 1: evict old tool_results
  const pass1 = evictOldToolResults(messages, {
    budgetTokens: DEFAULTS.emergencyBudgetTokens,
    keepRecent: DEFAULTS.emergencyKeepRecent,
  });

  // If already within budget, we're done
  const tokensAfterPass1 = estimateTotalTokens(messages);
  if (tokensAfterPass1 <= DEFAULTS.emergencyBudgetTokens) {
    return {
      didEvict: pass1.didEvict,
      evictedCount: pass1.evictedCount,
      tokensBefore,
      tokensAfter: tokensAfterPass1,
    };
  }

  // Pass 2: truncate oversized user/assistant text content in messages older than the keepRecent window
  const MAX_TEXT_MSG_BYTES = 20_000; // per-message content limit (chars)
  const keepFrom = Math.max(0, messages.length - DEFAULTS.emergencyKeepRecent);
  let truncatedCount = 0;

  for (let i = 0; i < keepFrom; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string') {
      if (msg.content.length > MAX_TEXT_MSG_BYTES) {
        const origLen = msg.content.length;
        messages[i] = {
          ...msg,
          content:
            msg.content.slice(0, MAX_TEXT_MSG_BYTES) +
            `\n...[philont emergency truncation: original ${origLen} chars exceeded emergency budget; kept first ${MAX_TEXT_MSG_BYTES}]`,
        };
        truncatedCount++;
      }
    } else if (Array.isArray(msg.content)) {
      // Block array: truncate text blocks; leave other blocks intact
      const newBlocks = msg.content.map((block) => {
        if (
          block &&
          typeof block === 'object' &&
          (block as unknown as Record<string, unknown>).type === 'text'
        ) {
          const b = block as unknown as { type: 'text'; text: string };
          if (b.text.length > MAX_TEXT_MSG_BYTES) {
            const origLen = b.text.length;
            truncatedCount++;
            return {
              ...b,
              text:
                b.text.slice(0, MAX_TEXT_MSG_BYTES) +
                `\n...[philont emergency truncation: original ${origLen} chars; kept first ${MAX_TEXT_MSG_BYTES}]`,
            };
          }
        }
        return block;
      });
      messages[i] = { ...msg, content: newBlocks as typeof msg.content };
    }
  }

  const tokensAfterPass2 = estimateTotalTokens(messages);
  if (tokensAfterPass2 <= DEFAULTS.emergencyBudgetTokens) {
    return {
      didEvict: pass1.didEvict || truncatedCount > 0,
      evictedCount: pass1.evictedCount + truncatedCount,
      tokensBefore,
      tokensAfter: tokensAfterPass2,
    };
  }

  // Pass 3: last resort — hard-truncate tool_result content even in the recent keepRecent window.
  // Preserve tool_use_id pairing (do not touch structure), only shrink content to first N chars.
  // This is the final compromise between "no amnesia" and "no 400": shrinking content beats
  // discarding the whole entry. Trigger scenario: the agent just called a tool that returned
  // a huge result, and that tool_result is still in the keepRecent protected range, so Passes
  // 1-2 could not touch it. Seen in practice: a single webFetch page with 2M chars = 1.2M
  // tokens blew the window on its own.
  const MAX_TR_BYTES = DEFAULTS.emergencyMaxToolResultBytes;
  let pass3Truncated = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    let dirty = false;
    const newBlocks = msg.content.map((block) => {
      if (!isToolResultBlock(block)) return block;
      const c = (block as ToolResultBlock).content;
      if (typeof c === 'string') {
        if (c.length > MAX_TR_BYTES && !isEvictedPlaceholder(c)) {
          dirty = true;
          pass3Truncated++;
          return {
            ...block,
            content:
              c.slice(0, MAX_TR_BYTES) +
              `\n...[philont emergency last-resort: tool_result original ${c.length} chars;` +
              ` context near overflow, kept first ${MAX_TR_BYTES} chars]`,
          };
        }
        return block;
      }
      if (Array.isArray(c)) {
        let innerDirty = false;
        const newC = c.map((inner) => {
          if (
            inner &&
            typeof inner === 'object' &&
            (inner as unknown as Record<string, unknown>).type === 'text'
          ) {
            const t = inner as unknown as { type: 'text'; text: string };
            if (t.text.length > MAX_TR_BYTES) {
              innerDirty = true;
              return {
                ...t,
                text:
                  t.text.slice(0, MAX_TR_BYTES) +
                  `\n...[philont emergency last-resort: tool_result text original ${t.text.length} chars;` +
                  ` kept first ${MAX_TR_BYTES}]`,
              };
            }
          }
          return inner;
        });
        if (innerDirty) {
          dirty = true;
          pass3Truncated++;
          return { ...block, content: newC };
        }
      }
      return block;
    });
    if (dirty) {
      messages[i] = { ...msg, content: newBlocks as typeof msg.content };
    }
  }

  const tokensAfter = estimateTotalTokens(messages);
  return {
    didEvict: pass1.didEvict || truncatedCount > 0 || pass3Truncated > 0,
    evictedCount: pass1.evictedCount + truncatedCount + pass3Truncated,
    tokensBefore,
    tokensAfter,
  };
}
