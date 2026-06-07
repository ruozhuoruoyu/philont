/**
 * Failure signature extraction + same-root-cause failure clustering (2026-05-06).
 *
 * Serves the sameRootCauseFailures input for the reflection trigger. Semantics: the agent
 * repeatedly hits the same wall the same way (e.g. shell "command not found: rg" three times
 * in a row) = strong signal to trigger reflection, prompting the LLM to write a routing rule
 * "rg unavailable → switch to grep".
 *
 * Design tradeoffs:
 *   - **Lightweight**: no LLM calls, purely heuristic regex; same-root-cause detection may
 *     miss some cases (e.g. synonymous error words not collapsed) but never false-positives
 *     (mistaking unrelated failures for the same source)
 *   - **Cross-turn**: data source is memory_actions (all tool calls already persisted),
 *     not dependent on turn-local state
 *   - **Adjustable window**: caller provides sinceTs / limit; defaulting to the most recent
 *     30 tool calls is sufficient
 *
 * Signature format: `<toolName>:<errorClass>:<arg?>`
 *   - shell:cmd-not-found:rg
 *   - shell:permission-denied
 *   - webFetch:timeout
 *   - readFile:enoent
 *   - <tool>:other:<first 30 chars> (fallback)
 */

import type { Action } from './types.js';

/**
 * Extract failure signature from toolName + result text.
 * Input: result is ToolResult.output or the full text with a ⚠ failure prefix.
 *
 * Key error classes (priority high to low):
 *   1. cmd-not-found:<command>      shell tool command unreachable
 *   2. enoent / no-such-file        fs path does not exist
 *   3. permission-denied            insufficient permissions
 *   4. timeout                      timed out
 *   5. econnrefused                 connection refused
 *   6. eaddrinuse                   port already in use
 *   7. http-<status>                HTTP 4xx/5xx
 *   8. other:<first 30 chars>       fallback
 */
export function extractFailureSignature(
  toolName: string,
  resultText: string | null | undefined,
): string {
  const tool = (toolName || '<unknown>').trim() || '<unknown>';
  const text = (resultText ?? '').toString();
  const lower = text.toLowerCase();

  // 1. shell command not found (common enough to warrant dedicated extraction)
  const cmdNotFound =
    lower.match(/command not found:?\s*(\S+)/) ??
    lower.match(/(\S+):\s*command not found/);
  if (cmdNotFound) {
    const cmd = cmdNotFound[1].replace(/[^a-zA-Z0-9._\-+]/g, '');
    return `${tool}:cmd-not-found:${cmd.slice(0, 30)}`;
  }

  // 2. ENOENT / file not found (same source in node fs / shell)
  if (/\benoent\b/i.test(lower) || /no such file or directory/i.test(lower)) {
    return `${tool}:enoent`;
  }

  // 3. Permission denied
  if (
    /\beacces\b/i.test(lower) ||
    /permission denied/i.test(lower) ||
    /operation not permitted/i.test(lower)
  ) {
    return `${tool}:permission-denied`;
  }

  // 4. Timeout (network / shell killed at default timeout both count)
  if (/\b(etimedout|timeout|timed out|killed at)\b/i.test(lower)) {
    return `${tool}:timeout`;
  }

  // 5. ECONNREFUSED
  if (/\beconnrefused\b/i.test(lower) || /connection refused/i.test(lower)) {
    return `${tool}:econnrefused`;
  }

  // 6. EADDRINUSE
  if (/\beaddrinuse\b/i.test(lower) || /address already in use/i.test(lower)) {
    return `${tool}:eaddrinuse`;
  }

  // 7. HTTP status — capture "HTTP 404" / "status: 500" / "404 not found"
  const httpStatus = lower.match(/\b(?:http\s+|status[:\s]+)?(4\d\d|5\d\d)\b/);
  if (httpStatus) {
    return `${tool}:http-${httpStatus[1]}`;
  }

  // 8. PARI/GP exploratory-compute errors (2026-06-07): all of these otherwise fall into the
  //    useless `other:<first 30 chars>` bucket (the GP error text varies per expression), so
  //    repeated same-kind errors never group. Map the GP stderr to sharp classes so the
  //    learning pipeline can cluster recurring kinds. Pure deterministic regex on lowered text.
  if (tool === 'pariGp') {
    if (/syntax error/.test(lower)) return `${tool}:gp-syntax`;
    if (/incorrect type/.test(lower)) return `${tool}:gp-type`;
    if (/variable name expected/.test(lower)) return `${tool}:gp-varname`;
    if (/too few arguments|too many arguments/.test(lower)) return `${tool}:gp-args`;
    if (/not a function in function call/.test(lower)) return `${tool}:gp-not-a-function`;
    if (/computation timed out|process killed/.test(lower)) return `${tool}:gp-timeout`;
    return `${tool}:gp-other`;
  }

  // 8b. z3 verifier errors (2026-06-07): minimal single-class mapping, same rationale as PARI/GP.
  if (tool === 'z3Verify') {
    return `${tool}:z3-error`;
  }

  // 9. Fallback: take first 30 chars (strip ⚠ marker + excess whitespace)
  const stripped = text
    .replace(/^[⚠✓\s]+/, '')
    .replace(/^TOOL\s*FAILED:?\s*/i, '')
    .replace(/^Error:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  return `${tool}:other:${stripped.toLowerCase()}`;
}

/**
 * 2026-06-07: Two classes of recorded failures are NOT task-level recurring problems and were
 * causing the `same_root_cause_failures` reflection to fire as noise every turn:
 *
 *   (a) Exploratory-compute tools (pariGp / z3Verify) — trial-and-error compute probes run
 *       inside deep_explore. Their failures are normal exploration (a parallel change starts
 *       recording them to memory_actions), not the agent hitting a task wall.
 *   (b) Mechanism / deliberate-rejection signatures — plan_protocol_gate / in_turn_tool_block /
 *       autonomous_blacklist / research_before_retry are protocol-layer ON-PURPOSE stops, not
 *       the LLM hitting a wall. Mirrors the same exclusion in server/src/in_turn_reflection.ts.
 *
 * Both are filtered out of groupFailures (and therefore countSameRootCauseFailures) below.
 */
const EXCLUDED_FROM_ROOT_CAUSE = new Set<string>(['pariGp', 'z3Verify']);
const MECHANISM_REJECTION_RE =
  /:other:\[(plan_protocol_gate|in_turn_tool_block|autonomous_blacklist|research[_-]?before[_-]?retry)\b/i;

export interface FailureCounted {
  signature: string;
  count: number;
  /** Latest timestamp (epoch ms) hit by this signature; null means no time information */
  latestTs: number | null;
  /** Tool name of the first matching hit */
  toolName: string;
}

/**
 * Clusters a group of failure actions by signature and returns the max group count
 * (used by the reflection trigger decision).
 *
 * Input requirement: caller has already filtered for "recent failed tool calls" (success=false).
 * This function does not query DB / time windows itself.
 *
 * Returns 0 if there are no failures / no groups with ≥ 2 same-signature entries.
 */
export function countSameRootCauseFailures(
  failures: ReadonlyArray<Pick<Action, 'toolName' | 'result' | 'timestamp'>>,
): number {
  if (failures.length === 0) return 0;
  const groups = groupFailures(failures);
  let max = 0;
  for (const g of groups) {
    if (g.count > max) max = g.count;
  }
  return max;
}

/**
 * Detailed clustering (for testing / debugging). Returns all signature groups sorted by count descending.
 */
export function groupFailures(
  failures: ReadonlyArray<Pick<Action, 'toolName' | 'result' | 'timestamp'>>,
): FailureCounted[] {
  const map = new Map<
    string,
    { signature: string; count: number; latestTs: number | null; toolName: string }
  >();
  for (const f of failures) {
    // 2026-06-07: skip exploratory-compute tools + mechanism/deliberate-rejection signatures
    // (see EXCLUDED_FROM_ROOT_CAUSE / MECHANISM_REJECTION_RE) — not task-recurring failures.
    if (EXCLUDED_FROM_ROOT_CAUSE.has(f.toolName)) continue;
    const sig = extractFailureSignature(f.toolName, f.result);
    if (MECHANISM_REJECTION_RE.test(sig)) continue;
    const existing = map.get(sig);
    if (existing) {
      existing.count += 1;
      if (
        f.timestamp != null &&
        (existing.latestTs === null || f.timestamp > existing.latestTs)
      ) {
        existing.latestTs = f.timestamp;
      }
    } else {
      map.set(sig, {
        signature: sig,
        count: 1,
        latestTs: f.timestamp ?? null,
        toolName: f.toolName,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
