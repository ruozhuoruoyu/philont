/**
 * MetaConfigObserver (v18 Phase 8 M3, 2026-05-12)
 *
 * Meta-layer observer — scans audit_chain for patterns and automatically writes config_rules.
 *
 * Relationship to the Driver interface: **not** a Driver (does not produce initiatives).
 * Drivers go through executor to run tools/LLM; this observer **directly writes ConfigRuleStore**.
 * The executor still maintains the read-only invariant; config changes take a separate path
 * (only writes to 5 whitelisted scopes, backed by a confidence state machine).
 *
 * Invocation timing: at the end of idle_consolidator tick (runs every 60s) or at the end of autonomous loop tick.
 * A single call is idempotent — repeated triggers of the same pattern only insert new rules
 * (each rule has its own confidence state machine).
 *
 * 5 detectors (M3 v1 implements D1 + D2, directly corresponding to production bugs):
 *
 *   D1: autonomous turn + tool repeatedly auth_pending → add to autonomous_blacklist
 *       Self-repair for production bug #3 (env deadloop)
 *
 *   D2: same sessionPrefix repeatedly triggers auto_task_mode, then plan_update_step repeatedly fails
 *       → add prefix to task_mode_classifier.skip_patterns
 *       Self-repair for production bug #1 (autonomous schedule elevated to slow mode)
 *
 *   D3-D5 (stretch): in-turn threshold ineffective / gate leak (goes to Phase 8B BugDetector) /
 *       same task_signature repeatedly close failure
 *
 * Safety mechanisms:
 *   - All writes have confidence='provisional' (dry-run period)
 *   - Same (scope, value) rule is not inserted twice (dedup check)
 *   - Thresholds are conservative: require >= 3 occurrences of the same event in 24h
 *   - env PHILONT_META_OBSERVER=0 disables globally
 */

import type { ConfigRuleStore, ConfigScope } from '../config_rules.js';

/**
 * Minimal audit event interface — structural typing compatible with
 * `@agent/policy` AuditEvent (agent-memory does not depend on agent-policy; declared independently here).
 */
export interface AuditEventLike {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface MetaConfigObserverInput {
  auditEvents: ReadonlyArray<AuditEventLike>;
  configRules: ConfigRuleStore;
  /** Current time (injectable for tests). Defaults to Date.now(). */
  now?: number;
  /** Detection window (ms). Defaults to 24h. */
  windowMs?: number;
  /** Threshold: same pattern + same key must trigger N times before a new rule is proposed. Default 3. */
  threshold?: number;
}

export interface ConfigRuleProposal {
  scope: ConfigScope;
  key: string | null;
  value: unknown;
  evidence: string;
  pattern: 'D1' | 'D2';
}

export interface MetaConfigObserverResult {
  /** IDs of newly inserted rules (provisional) */
  insertedRuleIds: number[];
  /** All detected candidate patterns (including already-existing ones; for audit/debugging) */
  proposals: ConfigRuleProposal[];
  /** Number of candidates skipped because they already exist */
  skippedExisting: number;
}

/**
 * D1: autonomous turn + tool repeatedly auth_pending
 *
 * Detection conditions:
 *   - audit event type 'permission_denied' or 'approval_suspended' /
 *     'permission_denied' / auth_request category
 *   - sessionId startsWith 'system:scheduled:' / 'system:cron:' (autonomous)
 *   - Same (sessionId, toolName) >= threshold times within 24h
 *
 * Proposal: add the tool to autonomous_blacklist
 *
 * audit event field conventions:
 *   - type 'permission_denied' / data.toolName + data.sessionId
 *   - or chat-handler custom type 'auth_pending' (if present) — v1 uses permission_denied
 */
function detectD1AuthPending(
  events: ReadonlyArray<AuditEventLike>,
  now: number,
  windowMs: number,
  threshold: number,
): ConfigRuleProposal[] {
  const cutoff = now - windowMs;
  // (sessionId, toolName) → count
  const counts = new Map<string, { toolName: string; sessionId: string; count: number }>();

  for (const ev of events) {
    if (ev.timestamp < cutoff) continue;
    // Focus on permission_denied category events
    if (ev.type !== 'permission_denied' && ev.type !== 'approval_requested') continue;

    const data = ev.data as Record<string, unknown>;
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
    const toolName = typeof data.toolName === 'string' ? data.toolName : undefined;
    if (!sessionId || !toolName) continue;

    // Only care about autonomous turns
    if (!sessionId.startsWith('system:scheduled:') && !sessionId.startsWith('system:cron:')) {
      continue;
    }

    const key = `${sessionId}|${toolName}`;
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
    } else {
      counts.set(key, { sessionId, toolName, count: 1 });
    }
  }

  const proposals: ConfigRuleProposal[] = [];
  // Aggregate same toolName across sessionIds >= threshold (same tool blocked in multiple autonomous sessions)
  const toolCounts = new Map<string, number>();
  for (const e of counts.values()) {
    toolCounts.set(e.toolName, (toolCounts.get(e.toolName) ?? 0) + e.count);
  }
  for (const [toolName, total] of toolCounts) {
    if (total >= threshold) {
      proposals.push({
        scope: 'autonomous_blacklist',
        key: null,
        value: toolName,
        evidence: `D1: ${toolName} triggered ${total}x permission_denied in autonomous turn within ${windowMs / 3600000}h (threshold ${threshold})`,
        pattern: 'D1',
      });
    }
  }
  return proposals;
}

/**
 * D2: same sessionPrefix repeatedly triggers auto_task_mode to slow, then plan_update_step repeatedly fails
 *
 * Production observation (2026-05-12): autonomous schedule session elevated to slow, then LLM calls
 * plan_update_step but there is no active plan → fails. This is a counter-signal that auto-task-mode
 * is misclassifying the autonomous session as a complex task.
 *
 * Detection:
 *   - Group auto_task_mode events by sessionId prefix (first two colon-separated segments) within 24h
 *   - Under the same prefix, plan_update_step failures >= threshold → propose skip pattern
 *
 * Proposal: task_mode_classifier.skip_patterns += sessionPrefix
 */
function detectD2AutoModeMisclassify(
  events: ReadonlyArray<AuditEventLike>,
  now: number,
  windowMs: number,
  threshold: number,
): ConfigRuleProposal[] {
  const cutoff = now - windowMs;

  // Collect sessionIds of auto_task_mode events
  const autoModeSessions = new Map<string, number>(); // sessionPrefix → count
  // Collect sessionIds of plan_update_step failures
  const planUpdateFailures = new Map<string, number>(); // sessionPrefix → count

  for (const ev of events) {
    if (ev.timestamp < cutoff) continue;
    const data = ev.data as Record<string, unknown>;
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
    if (!sessionId) continue;

    // Extract prefix (first two colon-separated segments), e.g. 'system:scheduled:mycox-checkin' → 'system:scheduled:'
    const parts = sessionId.split(':');
    if (parts.length < 2) continue;
    const prefix = parts[0] + ':' + parts[1] + ':';

    if (ev.type === 'self_domain_write') {
      const toolName = typeof data.toolName === 'string' ? data.toolName : '';
      if (toolName === 'task_mode_auto_slow') {
        autoModeSessions.set(prefix, (autoModeSessions.get(prefix) ?? 0) + 1);
      }
      // plan_update_step failure audit tag: source='plan_protocol_gate' AND blockedTool='plan_update_step'
      // or result='rejected_by_plan_protocol_gate' AND tool='plan_update_step'
      // Detecting by source field here
      const source = typeof data.source === 'string' ? data.source : '';
      const blockedTool = typeof data.blockedTool === 'string' ? data.blockedTool : '';
      if (
        (source === 'plan_protocol_gate' && blockedTool === 'plan_update_step') ||
        (source === 'auto_revise_on_fail') // also counts as a misclassification signal
      ) {
        planUpdateFailures.set(prefix, (planUpdateFailures.get(prefix) ?? 0) + 1);
      }
    }
  }

  const proposals: ConfigRuleProposal[] = [];
  for (const [prefix, autoCount] of autoModeSessions) {
    const failCount = planUpdateFailures.get(prefix) ?? 0;
    // Threshold: both auto_task_mode hits and plan_update_step failures must be >= threshold/2 (half each, combined they qualify)
    if (autoCount >= Math.ceil(threshold / 2) && failCount >= Math.ceil(threshold / 2)) {
      proposals.push({
        scope: 'task_mode_classifier.skip_patterns',
        key: null,
        value: prefix,
        evidence: `D2: sessionPrefix '${prefix}' had ${autoCount}x auto_task_mode + ${failCount}x plan_update_step failures within ${windowMs / 3600000}h`,
        pattern: 'D2',
      });
    }
  }
  return proposals;
}

/**
 * Main entry point — scans audit_chain for patterns and automatically writes new rules.
 *
 * Idempotent: same (scope, value) rule is not inserted twice (dedup check).
 * Fail-soft: any detector error is only logged; other detectors are unaffected.
 */
export function runMetaConfigObserver(
  input: MetaConfigObserverInput,
): MetaConfigObserverResult {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? 24 * 60 * 60 * 1000;
  const threshold = input.threshold ?? 3;

  const result: MetaConfigObserverResult = {
    insertedRuleIds: [],
    proposals: [],
    skippedExisting: 0,
  };

  // Run all detectors
  const allProposals: ConfigRuleProposal[] = [];
  try {
    allProposals.push(...detectD1AuthPending(input.auditEvents, now, windowMs, threshold));
  } catch (e) {
    console.warn('[meta-config] D1 detector error (ignored):', e);
  }
  try {
    allProposals.push(...detectD2AutoModeMisclassify(input.auditEvents, now, windowMs, threshold));
  } catch (e) {
    console.warn('[meta-config] D2 detector error (ignored):', e);
  }

  result.proposals = allProposals;

  // Write — dedup check + insert as provisional
  for (const prop of allProposals) {
    try {
      // Check if same scope + value already exists (any state: provisional/tentative/validated/disputed/retired)
      const existing = input.configRules.listByScope(prop.scope).filter((r) => {
        // Value comparison: use JSON.stringify for string / array / object
        return JSON.stringify(r.value) === JSON.stringify(prop.value);
      });
      if (existing.length > 0) {
        result.skippedExisting++;
        continue;
      }
      const rule = input.configRules.insertRule({
        scope: prop.scope,
        key: prop.key,
        value: prop.value,
        source: 'self:meta-detector',
        confidence: 'provisional',
        evidence: prop.evidence,
      });
      result.insertedRuleIds.push(rule.id);
    } catch (e) {
      console.warn(`[meta-config] failed to write rule (${prop.pattern}, scope=${prop.scope}):`, e);
    }
  }

  return result;
}
