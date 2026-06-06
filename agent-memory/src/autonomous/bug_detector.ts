/**
 * BugDetector (v18 Phase 8 M4 = Phase 8B, 2026-05-12)
 *
 * Complements MetaConfigObserver:
 *   - MetaConfigObserver: self-fixable bugs (config layer) — writes config_rules
 *   - BugDetector: non-self-fixable bugs (logic branches) → outputs precise bug reports (file_hint + expected/actual + fix_proposal)
 *
 * The system cannot modify its own code (security boundary), but it can **precisely locate**
 * which line has a bug, letting an engineer fix it in under a minute.
 * This is a response to the critique "self-reporting ≠ real fix" — we do real self-repair (8A)
 * and precise reporting (8B). The two layers cover 67% self-fix + 33% precise reporting.
 *
 * 5 bug patterns (M4 v1 implements B1-B3, directly corresponding to observed production bugs):
 *
 *   B1: gate should reject but actually passed (logic branch bug)
 *       Production bug #2 (plan_protocol_gate leaking memory tools)
 *
 *   B2: mechanism layer rejects but LLM keeps hitting it (protocol unfamiliarity)
 *       Same reject ≥ 3 times in one turn → LLM hasn't learned
 *
 *   B3: honesty fired N times with same root cause (behavioral deficiency)
 *       routing_rule learning too slow
 *
 *   B4/B5 (stretch): schedule auth_pending deadloop / routing_rule match but still fails
 *
 * Output format: audit event `bug_report_generated` with full diagnostic info:
 *   - pattern + title
 *   - evidence (multiple audit event references)
 *   - expected vs actual
 *   - file_hint (file:line pointing engineer where to start looking)
 *   - fix_proposal (natural language fix suggestion)
 *   - severity / first_seen / last_seen / count
 *
 * Safety mechanisms:
 *   - **Does not write code or modify store** — only emits audit events
 *   - Same (pattern, key) is only reported once per 24h (dedup)
 *   - env PHILONT_BUG_DETECTOR=0 disables this
 */

import type { AuditEventLike } from './meta_config_observer.js';

export interface BugDetectorInput {
  auditEvents: ReadonlyArray<AuditEventLike>;
  /** Current time (injected for tests), defaults to Date.now() */
  now?: number;
  /** Detection window (ms), defaults to 24h */
  windowMs?: number;
  /** Dedup window (ms): same pattern+key suppressed for this long, defaults to 24h */
  dedupWindowMs?: number;
  /** Set of already-reported bug keys (dedup; caller maintains cross-tick state) */
  recentlyReported?: ReadonlySet<string>;
}

export type BugSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface BugReportEvidence {
  /** audit event id (if available) / or event description */
  ref: string;
  /** session id */
  sessionId?: string;
  /** tool name (if involved) */
  toolName?: string;
  /** timestamp */
  ts: number;
}

export interface BugReport {
  pattern: 'B1' | 'B2' | 'B3' | 'B4' | 'B5';
  /** Unique identifier within the same pattern (used for dedup) */
  key: string;
  title: string;
  evidence: BugReportEvidence[];
  expected: string;
  actual: string;
  /** file:line hint (where engineer should start looking) */
  fileHint: string;
  /** Natural language fix suggestion */
  fixProposal: string;
  severity: BugSeverity;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

export interface BugDetectorResult {
  /** Newly discovered bugs (already deduped, already filtered by recentlyReported) */
  reports: BugReport[];
  /** Bug keys skipped due to dedup */
  dedupSkipped: string[];
}

/**
 * B1: gate should reject but actually passed (plan_protocol_gate leaking tools)
 *
 * Detection conditions:
 *   - Observe task_mode_auto_slow audit event (mode elevated to slow) within a turn
 *   - No plan_drafted / plan_review pass audit in the same sessionId afterward (same turn)
 *   - But non-plan_* tool calls still succeeded (not blocked by plan_protocol_gate_blocked)
 *
 * Since "call succeeded" has no audit event (only tool_call audit), reverse-detect:
 *   Find task_mode_auto_slow event, within 5 minutes in the same session:
 *   - No plan_protocol_gate_blocked event seen (gate didn't block)
 *   - But there are self_domain_write entries (memory tool writes)
 *
 * If both are true → gate leaked those tools
 */
function detectB1GateLeak(
  events: ReadonlyArray<AuditEventLike>,
  now: number,
  windowMs: number,
): BugReport[] {
  const cutoff = now - windowMs;

  // Find all auto_slow events — within 5min of same sessionId the gate should be active
  const autoSlowEvents: Array<{ sessionId: string; ts: number }> = [];
  for (const ev of events) {
    if (ev.timestamp < cutoff) continue;
    if (ev.type !== 'self_domain_write') continue;
    const data = ev.data as Record<string, unknown>;
    if (data.toolName !== 'task_mode_auto_slow') continue;
    const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (sid) autoSlowEvents.push({ sessionId: sid, ts: ev.timestamp });
  }

  const reports: BugReport[] = [];
  const sessionsAlreadyReported = new Set<string>();

  for (const slowEv of autoSlowEvents) {
    if (sessionsAlreadyReported.has(slowEv.sessionId)) continue;
    const windowEnd = slowEv.ts + 5 * 60_000;

    // Query audits in the same sessionId within the 5min window
    let sawGateBlock = false;
    const passedTools: Array<{ tool: string; ts: number }> = [];
    for (const ev of events) {
      if (ev.timestamp < slowEv.ts || ev.timestamp > windowEnd) continue;
      const data = ev.data as Record<string, unknown>;
      if (data.sessionId !== slowEv.sessionId) continue;

      if (
        ev.type === 'self_domain_write' &&
        data.source === 'plan_protocol_gate' &&
        data.toolName === 'plan_protocol_gate_blocked'
      ) {
        sawGateBlock = true;
      }
      // self_domain_write = memory tool actually writing (get_fact / store_fact / listCredentialNames etc.)
      // These tools should be blocked by the gate in slow + no-plan state
      if (
        ev.type === 'self_domain_write' &&
        typeof data.toolName === 'string' &&
        !['task_mode_auto_slow', 'plan_protocol_gate_blocked', 'auto_revise_on_fail',
          'plan_drafted', 'plan_reviewed', 'auto_recovery_plan_created',
          'auto_revise_hint_injected', 'task_mode_auto_slow_after_fail',
          'reflection_reminder_injected', 'in_turn_tool_blocked',
          'config_rule_proposed', 'bug_report_generated',
        ].includes(data.toolName)
      ) {
        // Real tool write, not a mechanism-layer audit entry
        passedTools.push({ tool: data.toolName as string, ts: ev.timestamp });
      }
    }

    // If mode=slow but gate never blocked anything + non-protocol tool calls succeeded → bug
    if (!sawGateBlock && passedTools.length > 0) {
      const uniqueTools = [...new Set(passedTools.map((t) => t.tool))];
      const key = `B1:${slowEv.sessionId}:${uniqueTools.sort().join(',')}`;
      reports.push({
        pattern: 'B1',
        key,
        title: `plan_protocol_gate leaked tools: ${uniqueTools.join(', ')}`,
        evidence: passedTools.slice(0, 5).map((t) => ({
          ref: `passed_tool=${t.tool}`,
          sessionId: slowEv.sessionId,
          toolName: t.tool,
          ts: t.ts,
        })),
        expected: `In slow mode + no plan_reviewed, all non plan_* / task_mode_classify tools should be rejected by plan_protocol_gate`,
        actual: `mode=slow (elevated by auto_task_mode), gate did not block any tools within 5min, but ${passedTools.length} tool call(s) succeeded`,
        fileHint: `server/src/chat-handler.ts:~3870 (plan_protocol_gate dispatch loop) — check whether isPlanProtocolTool covers all tools that should be blocked, or whether memory tool takes a short-circuit path that skips dispatch`,
        fixProposal: `1) grep "isPlanProtocolTool" to inspect the logic; 2) check whether ${uniqueTools.join(', ')} are injected via extraInternalTools but don't go through the main dispatch; 3) add console.log to verify whether the gate is actually being called`,
        severity: 'high',
        firstSeen: passedTools[0].ts,
        lastSeen: passedTools[passedTools.length - 1].ts,
        count: passedTools.length,
      });
      sessionsAlreadyReported.add(slowEv.sessionId);
    }
  }

  return reports;
}

/**
 * B2: mechanism layer rejects but LLM keeps hitting it (protocol unfamiliarity)
 *
 * Detection: plan_protocol_gate_blocked >= 3 times in the same sessionId within 24h
 * → LLM sees the reject but never proactively calls plan_draft; keeps hitting the same wall
 */
function detectB2RejectLoop(
  events: ReadonlyArray<AuditEventLike>,
  now: number,
  windowMs: number,
  threshold: number,
): BugReport[] {
  const cutoff = now - windowMs;
  const sessionBlocks = new Map<string, Array<AuditEventLike>>();

  for (const ev of events) {
    if (ev.timestamp < cutoff) continue;
    if (ev.type !== 'self_domain_write') continue;
    const data = ev.data as Record<string, unknown>;
    if (data.toolName !== 'plan_protocol_gate_blocked') continue;
    const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (!sid) continue;
    const arr = sessionBlocks.get(sid) ?? [];
    arr.push(ev);
    sessionBlocks.set(sid, arr);
  }

  const reports: BugReport[] = [];
  for (const [sessionId, blocks] of sessionBlocks) {
    if (blocks.length < threshold) continue;
    const key = `B2:${sessionId}`;
    reports.push({
      pattern: 'B2',
      key,
      title: `LLM did not call plan_draft after ${blocks.length}x plan_protocol_gate rejects`,
      evidence: blocks.slice(0, 5).map((ev) => ({
        ref: `plan_protocol_gate_blocked`,
        sessionId,
        toolName: (ev.data as Record<string, unknown>).blockedTool as string | undefined,
        ts: ev.timestamp,
      })),
      expected: `Upon seeing a plan_protocol_gate reject, LLM should immediately call plan_draft / fall back via task_mode_classify('fast')`,
      actual: `LLM was rejected ${blocks.length} times in ${windowMs / 3600000}h, yet still has not taken the protocol path (may be continuing to call arbitrary tools or chatting)`,
      fileHint: `server/src/chat-handler.ts:~3890 (plan_protocol_gate reject message) — the current reject reason prompt already includes "call plan_draft immediately", but LLM is not responding`,
      fixProposal: `1) Strengthen reject message: add "**do not write ## user sections, call plan_draft immediately**" (already present, but LLM attention may be scattered); 2) Add in-turn detection: after plan_protocol_gate_blocked >= 2, force-inject a user-role hint; 3) Consider waiting for reflection to distill routing_rule "slow + reject → plan_draft first" via self-learning`,
      severity: 'medium',
      firstSeen: blocks[blocks.length - 1].timestamp,
      lastSeen: blocks[0].timestamp,
      count: blocks.length,
    });
  }

  return reports;
}

/**
 * B3: honesty fired N times with same root cause (behavioral deficiency)
 *
 * Detection: unverified_destructive (or other honesty reason) >= N times within 24h
 * → routing_rule learning too slow / K7 bridge review failed to correct LLM behavior
 */
function detectB3HonestyRepeat(
  events: ReadonlyArray<AuditEventLike>,
  now: number,
  windowMs: number,
  threshold: number,
): BugReport[] {
  const cutoff = now - windowMs;
  // reason → events
  const byReason = new Map<string, AuditEventLike[]>();

  for (const ev of events) {
    if (ev.timestamp < cutoff) continue;
    if (ev.type !== 'self_domain_write') continue;
    const data = ev.data as Record<string, unknown>;
    // chat-handler writes audit when honesty fires: source='honesty' / type varies
    // Simplified: detect k7_bridge_enqueued + reason field
    if (data.source === 'k7_bridge' || data.toolName === 'k7_bridge_enqueued') {
      const reason = typeof data.honestyReason === 'string'
        ? data.honestyReason
        : typeof data.reason === 'string' ? data.reason : '';
      if (!reason) continue;
      const arr = byReason.get(reason) ?? [];
      arr.push(ev);
      byReason.set(reason, arr);
    }
  }

  const reports: BugReport[] = [];
  for (const [reason, evs] of byReason) {
    if (evs.length < threshold) continue;
    const key = `B3:${reason}`;
    reports.push({
      pattern: 'B3',
      key,
      title: `honesty pattern '${reason}' repeatedly triggered (${evs.length}x in ${windowMs / 3600000}h)`,
      evidence: evs.slice(0, 5).map((ev) => ({
        ref: `honesty:${reason}`,
        sessionId: (ev.data as Record<string, unknown>).sessionId as string | undefined,
        ts: ev.timestamp,
      })),
      expected: `honesty firing triggers K7 bridge async review + reflection distills routing_rule, so LLM should not repeat the same error`,
      actual: `routing_rule learning failed or reflection did not produce an effective rule. LLM triggered the same reason ${evs.length} times in ${windowMs / 3600000}h`,
      fileHint: `agent-memory/src/honesty_gate.ts (reason='${reason}' branch) + agent-memory/src/reflection.ts (routing_rule distillation prompt)`,
      fixProposal: `1) Check whether reflection actually produced a routing_rule for this reason (query sqlite: routing_rules WHERE reflection_id LIKE '%honesty%'); 2) If produced but confidence didn't rise -> outcome feedback loop is broken; 3) If not produced -> reflection prompt needs honesty-specific examples added; 4) Long-term: consider forcing honesty into its own routing_rule store for persistent persistence`,
      severity: 'medium',
      firstSeen: evs[evs.length - 1].timestamp,
      lastSeen: evs[0].timestamp,
      count: evs.length,
    });
  }

  return reports;
}

/**
 * Main entry point — scans audit_chain for bug patterns, outputs BugReport list.
 * Does not write to any store; purely read-only.
 */
export function runBugDetector(input: BugDetectorInput): BugDetectorResult {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? 24 * 60 * 60 * 1000;
  const dedupWindowMs = input.dedupWindowMs ?? 24 * 60 * 60 * 1000;
  const recentlyReported = input.recentlyReported ?? new Set();

  const result: BugDetectorResult = {
    reports: [],
    dedupSkipped: [],
  };

  const allReports: BugReport[] = [];
  try {
    allReports.push(...detectB1GateLeak(input.auditEvents, now, windowMs));
  } catch (e) {
    console.warn('[bug-detector] B1 detector error (ignored):', e);
  }
  try {
    allReports.push(...detectB2RejectLoop(input.auditEvents, now, windowMs, 3));
  } catch (e) {
    console.warn('[bug-detector] B2 detector error (ignored):', e);
  }
  try {
    allReports.push(...detectB3HonestyRepeat(input.auditEvents, now, windowMs, 5));
  } catch (e) {
    console.warn('[bug-detector] B3 detector error (ignored):', e);
  }

  for (const r of allReports) {
    if (recentlyReported.has(r.key)) {
      result.dedupSkipped.push(r.key);
    } else {
      result.reports.push(r);
    }
  }

  return result;
}
