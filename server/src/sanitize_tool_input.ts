/**
 * Tool input sanitization (2026-05-07)
 *
 * Defends against cases where the `input` field of a tool_use block returned by the LLM is
 * not a plain object. Field observations (prod log 2026-05-07): some LLM providers
 * (possibly Anthropic via proxy + retry aggregation, or OpenAI-compat with unusual behaviour
 * on parallel tool calls) concatenate the arguments of 2 tool_use blocks into a single string,
 * e.g.:
 *
 *   {"pattern":"**\/*X*"}{"query":"Y"}
 *
 * Our adapter passes this as-is to chat-handler; tools.execute passes this string as params
 * to the specific tool; the tool's `params.pattern` is undefined → TypeError → failed
 * tool_result → next LLM call receives bad data → 400 Improperly formed request →
 * entire turn fails; user sees an internal error.
 *
 * This module intercepts before tools.execute:
 *   - Already a plain object → use as-is
 *   - String that JSON.parse succeeds alone → parse and use
 *   - String with multiple concatenated JSON objects → split by brace-balance, take the **first**
 *     object, and warn
 *   - Object shaped like `{raw_arguments: "<json>"}` / `{arguments: "<json>"}` etc.
 *     (wrap-once form) → unwrap the inner layer (field observation #2, 2026-05-23): some
 *     Anthropic-compat gateways pass through the OpenAI tool_call `arguments` string without
 *     restoring it; the LLM's actual intent is a valid object, just wrapped once
 *   - Other shapes (null / undefined / array / number etc.) → reject, return null
 *
 * On rejection, caller should write a fail tool_result and skip tools.execute to avoid
 * further data corruption.
 */

export type SanitizedInput = Record<string, unknown>;

export interface SanitizeResult {
  /** On pass: sanitized input; on reject: null */
  input: SanitizedInput | null;
  /** Which code path was taken (for audit / log) */
  path: 'object' | 'string-single-json' | 'string-multi-json' | 'unwrap-raw-arguments' | 'reject';
  /** Human-readable reason on rejection or downgrade (for the LLM's tool_result error message) */
  reason?: string;
  /** On multi-JSON: length of the discarded tail (for log) */
  truncatedTailLen?: number;
}

/** Gateway wrap key names (object with one of these keys + string value = wrapped once, needs unwrapping) */
const WRAP_KEYS = ['raw_arguments', 'raw_args', 'arguments', 'tool_arguments'] as const;

/**
 * Main entry point. Returns SanitizeResult; caller decides how to handle it.
 *
 * Design discipline:
 *   - Does not throw (reject/downgrade are return values)
 *   - Does not call LLM, does not write DB; pure function
 *   - On multi-JSON, takes only the first object; does not attempt to merge (merge semantics
 *     are ambiguous and prone to producing bad data)
 */
export function sanitizeToolInput(raw: unknown): SanitizeResult {
  // Path 1: plain object (99% of normal cases)
  if (isPlainObject(raw)) {
    // Sub-path 1b: gateway wrapped once as {raw_arguments: "<json>"} — unwrap
    const unwrapped = tryUnwrapWrappedArguments(raw as Record<string, unknown>);
    if (unwrapped) return unwrapped;
    return { input: raw as SanitizedInput, path: 'object' };
  }

  // Path 2 / 3: string
  if (typeof raw === 'string') {
    return sanitizeStringInput(raw);
  }

  // All other shapes are rejected (null / array / number / boolean / undefined)
  return {
    input: null,
    path: 'reject',
    reason: `tool input 不是合法对象(typeof=${raw === null ? 'null' : typeof raw}),已拒绝`,
  };
}

function sanitizeStringInput(s: string): SanitizeResult {
  const trimmed = s.trim();
  if (trimmed.length === 0) {
    return { input: null, path: 'reject', reason: 'tool input 是空字符串' };
  }

  // Try parsing the whole string first
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) {
      return { input: parsed as SanitizedInput, path: 'string-single-json' };
    }
    return {
      input: null,
      path: 'reject',
      reason: 'tool input 是字符串但 parse 后不是对象(可能是数组/标量)',
    };
  } catch {
    // Fall through to the multi-JSON concatenation path
  }

  // Multi-JSON concatenation: use brace-balance to find the boundary of the first complete object
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace < 0) {
    return { input: null, path: 'reject', reason: 'tool input 字符串不含 JSON 对象' };
  }
  const firstEnd = findFirstObjectEnd(trimmed, firstBrace);
  if (firstEnd < 0) {
    return {
      input: null,
      path: 'reject',
      reason: 'tool input 字符串括号未闭合',
    };
  }
  const firstJson = trimmed.slice(firstBrace, firstEnd + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstJson);
  } catch {
    return {
      input: null,
      path: 'reject',
      reason: '截取的首段也无法 parse',
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      input: null,
      path: 'reject',
      reason: '截取的首段 parse 后不是对象',
    };
  }
  const tailLen = trimmed.length - (firstEnd + 1);
  return {
    input: parsed as SanitizedInput,
    path: 'string-multi-json',
    reason: `LLM 返了多 JSON 拼接,已取首段(尾段 ${tailLen} 字符已丢弃)`,
    truncatedTailLen: tailLen,
  };
}

/**
 * Detect gateway wrap-once form: object with exactly one wrap key (`raw_arguments` /
 * `arguments` / `raw_args` / `tool_arguments`) and a string value.
 * Match → unwrap the inner JSON and use it as the real input; otherwise return null
 * and let the caller follow the normal path.
 *
 * Field context (2026-05-23): an OpenAI → Anthropic protocol shim gateway stuffed the
 * OpenAI tool_call `arguments` string field into Anthropic ToolUseBlock.input without
 * restoring it, causing the tool to receive `{raw_arguments: "{...}"}` instead of the
 * unwrapped params. writeFile receiving this shape has `params.content` = undefined →
 * fs.writeFile throws ERR_INVALID_ARG_TYPE.
 *
 * Strict conditions: exactly one key (to avoid false-matching a normal input that happens
 * to have a field named `arguments`); value must be a string; parsed result must be a
 * plain object.
 */
function tryUnwrapWrappedArguments(
  raw: Record<string, unknown>,
): SanitizeResult | null {
  const keys = Object.keys(raw);
  if (keys.length !== 1) return null;
  const k = keys[0];
  if (!WRAP_KEYS.includes(k as (typeof WRAP_KEYS)[number])) return null;
  const v = raw[k];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Value is a string but not valid JSON → let string path / reject handle it;
    // this function only handles "object wrapping a JSON string".
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  return {
    input: parsed as SanitizedInput,
    path: 'unwrap-raw-arguments',
    reason: `网关把 tool args 包在 \`${k}\` 字段里,已展开`,
  };
}

/**
 * Starting from the `{` at startIdx, find the matching closing `}` index.
 * Simple state machine that handles string literals (prevents braces inside strings
 * from being counted).
 * Returns -1 if unmatched.
 */
export function findFirstObjectEnd(s: string, startIdx: number): number {
  if (s[startIdx] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strict plain object test: not null, not an array, typeof === 'object'.
 * Note: Date / Map / Set etc. also pass — they should not be tool inputs, and that is
 * the tool's own problem.
 */
function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Run sanitize on all tool_use inputs in an assistantMessage (which may contain tool_use
 * blocks); **returns a new object** (does not mutate the original).
 *
 * Purpose: clean the assistantMessage returned by the LLM provider (which may contain
 * bad input fields) before pushing it into the messages history, ensuring the history
 * always contains valid tool_use.input (object), so the next LLM call over the full
 * messages array does not hit 400 Improperly formed request.
 *
 * Behaviour:
 *   - msg.content is string → return as-is
 *   - msg.content is array → walk each block; for tool_use run sanitize; other blocks untouched
 *   - sanitize accepts → replace original input with sanitized.input
 *   - sanitize rejects → replace with {} as fallback (so the LLM at least sees a valid shape)
 */
export interface BlockSanitizeStat {
  totalToolUse: number;
  fixed: number;     // path != 'object' but was repaired
  rejected: number;  // rejected → fallback to {}
}

/**
 * Generic preserves the caller's NativeMessage shape, preventing TS from widening
 * content to unknown.
 */
export function sanitizeAssistantMessageBlocks<
  T extends { role: string; content: unknown },
>(msg: T): { msg: T; stats: BlockSanitizeStat } {
  const stats: BlockSanitizeStat = { totalToolUse: 0, fixed: 0, rejected: 0 };
  if (typeof msg.content === 'string' || !Array.isArray(msg.content)) {
    return { msg, stats };
  }
  const newContent = (msg.content as Array<Record<string, unknown>>).map((block) => {
    if (!block || typeof block !== 'object' || block.type !== 'tool_use') {
      return block;
    }
    stats.totalToolUse += 1;
    const sanitized = sanitizeToolInput(block.input);
    if (sanitized.input === null) {
      stats.rejected += 1;
      return { ...block, input: {} };
    }
    if (sanitized.path !== 'object') {
      stats.fixed += 1;
    }
    return { ...block, input: sanitized.input };
  });
  return {
    msg: { ...msg, content: newContent } as T,
    stats,
  };
}
