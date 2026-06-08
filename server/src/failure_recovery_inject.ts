/**
 * Failure recovery injection (2026-05-07)
 *
 * Trigger: the same session has task_failure_mode audit events within a recent time window.
 * Behaviour: append a strong hint to the end of the system section, telling the LLM
 * "you hit a wall last time — switch to planAndExecute this round".
 *
 * Key difference from the earlier task_pattern_hint (keyword-triggered hardcoded mappings,
 * now deleted):
 *   - Data-driven: only triggers when audit actually has failure records → zero false positives
 *   - Isolated by session: strictly filters by sessionId, no cross-session leakage
 *   - Short time window (default 30 minutes): old failures stop interfering once the user
 *     restarts the session or switches topics
 *
 * Design doc: /root/.claude/plans/misty-juggling-mist.md
 */

import type { AuditLog } from '@agent/policy';

export type FailureKind =
  | 'iter_cap_hit'
  | 'turn_deadline'
  | 'llm_timeout'
  | 'llm_api_error'
  | 'turn_error'
  // Soft failure signals (2026-05-07 extension):
  | 'reflection_triggered'    // reflection system triggered due to same_root_cause / honesty / drainer etc.
  | 'tool_failure_burst'      // ≥ 3 tool failures (⚠) in the same turn (did not trigger reflection but clearly abnormal)
  | 'user_dissatisfaction';   // user message contains dissatisfaction words like "still didn't work / wrong again / retry"

export interface FailureRecord {
  kind: FailureKind;
  tsAgoMin: number;
  detail?: string;
}

export interface FailureRecoveryInjection {
  text: string;
  matched: boolean;
  recentFailures: FailureRecord[];
}

const DEFAULT_SINCE_MIN = 30;
const DEFAULT_MAX_FAILURES = 5;

const KIND_DESCRIPTIONS: Record<FailureKind, string> = {
  iter_cap_hit: 'tool calls hit iter cap (probing too deep incrementally)',
  turn_deadline: 'entire turn exceeded time limit',
  llm_timeout: 'LLM call timed out repeatedly',
  llm_api_error: 'LLM API error (malformed request / context window exceeded)',
  turn_error: 'turn processing pipeline exception',
  reflection_triggered: 'reflection system triggered (same root cause failure / long turn / anomaly)',
  tool_failure_burst: '≥ 3 tool failures in the same turn',
  user_dissatisfaction: 'user feedback indicates dissatisfaction (still didn\'t work / retry / wrong)',
};

/**
 * Query task_failure_mode events for the same session within the last sinceMin minutes
 * and render the injection text.
 *
 * @param audit          internalAudit (module-level AuditLog instance)
 * @param sessionId      sessionId of the current turn
 * @param userMessage    user input this round (reserved for future extension; v1 does not read it)
 * @param opts.sinceMin  time window (default 30 minutes)
 * @param opts.maxFailures max number of failures to list (default 5)
 */
export function buildFailureRecoveryInjection(
  audit: AuditLog,
  sessionId: string,
  userMessage: string,
  opts: { sinceMin?: number; maxFailures?: number } = {},
): FailureRecoveryInjection {
  void userMessage; // reserved; v2 may do task signature matching
  const sinceMin = opts.sinceMin ?? DEFAULT_SINCE_MIN;
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;

  const now = Date.now();
  const cutoff = now - sinceMin * 60_000;

  const events = audit.getEvents();
  const recentFailures: FailureRecord[] = [];
  // 2026-06-08: dedup by kind. On a persistent failure (e.g. mycox same_root_cause), reflection
  // fires every turn and writes a fresh `reflection_triggered` audit entry each time; the old loop
  // injected ALL of them, so the hint count climbed 1→2→3→4… every turn, spamming the prompt with
  // identical meta-signals. Keep only the most-recent entry of each kind — the signal ("this kind
  // of failure has been recurring") is fully conveyed by one, the rest are pure noise.
  const seenKinds = new Set<FailureKind>();

  // Scan in reverse order (most recent first)
  for (let i = events.length - 1; i >= 0 && recentFailures.length < maxFailures; i--) {
    const e = events[i];
    if (e.type !== 'task_failure_mode') continue;
    if (e.timestamp < cutoff) break; // assumes events are pushed in ascending timestamp order; stop at cutoff
    const data = e.data as Record<string, unknown>;
    if (data.sessionId !== sessionId) continue;
    const kind = data.kind;
    if (typeof kind !== 'string' || !isFailureKind(kind)) continue;
    if (seenKinds.has(kind as FailureKind)) continue; // already have a (more recent) entry of this kind
    seenKinds.add(kind as FailureKind);
    const detail = typeof data.detail === 'string' ? data.detail : undefined;
    recentFailures.push({
      kind: kind as FailureKind,
      tsAgoMin: Math.round((now - e.timestamp) / 60_000),
      detail,
    });
  }

  if (recentFailures.length === 0) {
    return { text: '', matched: false, recentFailures: [] };
  }

  const text = renderInjection(recentFailures, sinceMin);
  return { text, matched: true, recentFailures };
}

function isFailureKind(s: string): s is FailureKind {
  return (
    s === 'iter_cap_hit' ||
    s === 'turn_deadline' ||
    s === 'llm_timeout' ||
    s === 'llm_api_error' ||
    s === 'turn_error' ||
    s === 'reflection_triggered' ||
    s === 'tool_failure_burst' ||
    s === 'user_dissatisfaction'
  );
}

/**
 * Detect whether a user message contains dissatisfaction / retry / negation signals.
 *
 * Difference from task_pattern_hint (deleted; keyword-triggered hardcoded tool mappings):
 * this function only identifies the meta-signal "user is reporting a failure", without
 * mapping it to a specific tool or task type — on match, failure_recovery_inject recommends
 * the general planAndExecute path rather than a scenario-specific one.
 *
 * Match → write task_failure_mode { kind: 'user_dissatisfaction' } audit.
 * buildFailureRecoveryInjection will pick it up within the 30-minute window.
 */
export function detectUserDissatisfaction(userMessage: string): boolean {
  if (typeof userMessage !== 'string' || userMessage.length === 0) return false;
  const t = userMessage.toLowerCase();

  // 1. Chinese "still / again / not yet" + "success / no good / failed"
  if (/还是.{0,4}(没|不|失败)/.test(userMessage)) return true;
  if (/又.{0,4}(失败|没|不行)/.test(userMessage)) return true;
  if (/还没.{0,4}(好|对|成|做)/.test(userMessage)) return true;

  // 2. "you didn't before / didn't follow the requirements / did it wrong"
  if (/(你之前.{0,4}没|没按.{0,6}(要求|guide|指引|说的))/.test(userMessage)) return true;
  if (/(做错|做反|做反了|不是这样|不是要)/.test(userMessage)) return true;

  // 3. Retry / redo / try a different method / this time (explicitly saying to try again → last attempt failed)
  if (/(再试|重试|重做|重来|换个方法|换种方法|这次.{0,4}(试|要|换))/.test(userMessage)) return true;

  // 4. Explicit failure words
  if (/(失败了|不对|有问题|有bug|没用|无效)/.test(userMessage)) return true;

  // 5. Common English expressions
  if (/\b(retry|try again|didn'?t work|doesn'?t work|failed|broken|wrong)\b/.test(t)) return true;

  return false;
}

function renderInjection(failures: FailureRecord[], sinceMin: number): string {
  const lines: string[] = [];
  lines.push(`\n\n## ⚠️ 上轮任务失败,本轮调整策略`);
  lines.push(`\n${sinceMin} 分钟内本会话遭遇:`);
  for (const f of failures) {
    const desc = KIND_DESCRIPTIONS[f.kind];
    const detail = f.detail ? `(${truncate(f.detail, 80)})` : '';
    lines.push(`- ${desc} ${f.tsAgoMin} 分钟前 ${detail}`);
  }
  lines.push(`\n**本轮务必**:`);
  lines.push(
    `1. **复杂多步任务** → 优先 \`planAndExecute({task: "...", aggregateMode: "llm-summary"})\` 一次完成。父 turn 视角 1 iter,内部子 loop 跑工具不会撞主 cap。`,
  );
  lines.push(
    `2. 或先 \`searchSkills\` + \`use_skill\` 找现成方案,避免从零摸索。`,
  );
  lines.push(
    `3. **不要**重复"writeFile 脚本 → shell 跑 → parse → ..."的逐步摸索路径,既往同样路径已撞墙。`,
  );
  lines.push(`\n这是数据驱动的提示(audit 记录到本会话最近撞墙),不是关键词触发。换策略。`);
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
