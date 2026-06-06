/**
 * ConfigRuleStore (v18 Phase 8 — Self-Modifying Configuration, 2026-05-12)
 *
 * Core vehicle for mechanism-layer self-modifying configuration. Moves hardcoded TS consts
 * (autonomous_blacklist / classifier rule sets / thresholds / gate exemption lists) out to SQLite,
 * allowing MetaConfigObserver to automatically write new rules based on audit_chain patterns,
 * which the mechanism layer reads on startup.
 *
 * Design principles:
 *   - **Scope whitelist**: the store only accepts scopes in CONFIG_SCOPES; other writes throw (prevents runaway self-modification)
 *   - **5-tier confidence reuses routing_rules.ts** (nextConfidence function) — no duplicate state machine implementation
 *   - **dry-run compatible**: during provisional period the mechanism layer reads only validated/tentative;
 *     provisional rules only audit "would intercept X if active" without actually taking effect
 *   - **hardcoded priority**: on startup, hardcoded defaults are the baseline; DB rules layer on top;
 *     DB corruption falls back to pure hardcoded
 *
 * Relationship to RoutingRuleStore:
 *   - Reuses the 5-tier confidence type + nextConfidence state machine
 *   - But scope-keyed rather than task_signature-keyed
 *   - Different consumers: RoutingRule is shown to the LLM prompt; ConfigRule is read by mechanism layer code
 */

import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { RoutingConfidence } from './routing_rules.js';
import { nextConfidence, parseConfidence } from './routing_rules.js';

/** ConfigRule confidence type; reuses the 5-tier semantics of routing_rule. */
export type ConfigConfidence = RoutingConfidence;

/**
 * 5 whitelisted scopes (initial set).
 *
 * **Any ConfigRuleInput with a scope not in this list throws**. This is the safety guard against runaway self-modification.
 * The meta-layer observer can only write to these 5 scopes. Adding a new scope requires an engineer to
 * modify code (extend the whitelist + add loading logic).
 *
 * Scope semantics:
 *   - `autonomous_blacklist`: array type; tool blacklist for autonomous turns. key=null, value=tool name
 *   - `task_mode_classifier.skip_patterns`: array type; sessionId prefixes that skip the classifier
 *   - `task_mode_classifier.heuristic_rules`: array type; overlays hardcoded heuristic rules
 *   - `in_turn_reflection.threshold`: single-value type; key='value', value=number
 *   - `plan_protocol_gate.exempt_tools`: array type; tool names exempt from the gate
 */
export const CONFIG_SCOPES = [
  'autonomous_blacklist',
  'task_mode_classifier.skip_patterns',
  'task_mode_classifier.heuristic_rules',
  'in_turn_reflection.threshold',
  'plan_protocol_gate.exempt_tools',
] as const;

export type ConfigScope = typeof CONFIG_SCOPES[number];

export function isConfigScope(s: unknown): s is ConfigScope {
  return typeof s === 'string' && (CONFIG_SCOPES as readonly string[]).includes(s);
}

export type ConfigSource = 'bootstrap' | 'self:meta-detector' | 'manual';

export interface ConfigRule {
  id: number;
  scope: ConfigScope;
  /** Sub-key within the scope: array scopes use null; kv scopes (e.g. in_turn_reflection.threshold) use a specific key */
  key: string | null;
  /** Actual value (deserialized from value_json) */
  value: unknown;
  source: ConfigSource;
  confidence: ConfigConfidence;
  /** Human-readable description of the audit pattern that triggered this rule */
  evidence: string | null;
  /** Reference to the audit event id that triggered this rule (for traceability) */
  auditRef: string | null;
  successCount: number;
  failureCount: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConfigRuleInput {
  scope: ConfigScope;
  key?: string | null;
  value: unknown;
  source: ConfigSource;
  /** Default 'provisional'. Caller may pass 'tentative' (LLM self-assessed high confidence) or 'validated' (bootstrap defaults) */
  confidence?: ConfigConfidence;
  evidence?: string | null;
  auditRef?: string | null;
}

interface ConfigRuleRow {
  id: number;
  scope: string;
  key: string | null;
  value_json: string;
  source: string;
  confidence: string;
  evidence: string | null;
  audit_ref: string | null;
  success_count: number;
  failure_count: number;
  consecutive_successes: number;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
}

export interface ConfigRuleChangeEvent {
  type: 'created' | 'updated' | 'deleted' | 'confidence_changed';
  id: number;
}

function rowToRule(row: ConfigRuleRow): ConfigRule {
  return {
    id: row.id,
    scope: row.scope as ConfigScope,
    key: row.key,
    value: JSON.parse(row.value_json),
    source: row.source as ConfigSource,
    confidence: parseConfidence(row.confidence),
    evidence: row.evidence,
    auditRef: row.audit_ref,
    successCount: row.success_count,
    failureCount: row.failure_count,
    consecutiveSuccesses: row.consecutive_successes,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConfigRuleStore extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  /**
   * Inserts a new rule. Default confidence='provisional'.
   *
   * **Whitelist check**: if scope is not in CONFIG_SCOPES, throws (prevents runaway self-modification).
   * source is required and must be one of 'bootstrap' | 'self:meta-detector' | 'manual'.
   */
  insertRule(input: ConfigRuleInput): ConfigRule {
    if (!isConfigScope(input.scope)) {
      throw new Error(
        `ConfigRuleStore: scope '${input.scope}' is not in the whitelist [${CONFIG_SCOPES.join(', ')}]. ` +
          `The whitelist is a safety guard against runaway self-modification; to add a new scope, extend CONFIG_SCOPES + loading logic.`,
      );
    }
    if (input.source !== 'bootstrap' && input.source !== 'self:meta-detector' && input.source !== 'manual') {
      throw new Error(`ConfigRuleStore: invalid source '${input.source}'`);
    }
    const now = Date.now();
    const confidence = input.confidence ?? 'provisional';
    const valueJson = JSON.stringify(input.value);
    const result = this.db
      .prepare<
        [string, string | null, string, string, string, string | null, string | null, number, number]
      >(
        `INSERT INTO config_rules
         (scope, key, value_json, source, confidence, evidence, audit_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope,
        input.key ?? null,
        valueJson,
        input.source,
        confidence,
        input.evidence ?? null,
        input.auditRef ?? null,
        now,
        now,
      );
    const id = Number(result.lastInsertRowid);
    this.emit('changed', { type: 'created', id } satisfies ConfigRuleChangeEvent);
    return this.get(id)!;
  }

  /** Fetch by id */
  get(id: number): ConfigRule | null {
    const row = this.db
      .prepare<[number]>(`SELECT * FROM config_rules WHERE id = ? LIMIT 1`)
      .get(id) as ConfigRuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  /**
   * Fetches "active" rules for a scope (confidence NOT IN retired/disputed).
   *
   * **Used for mechanism-layer startup loading**. During dry-run period, provisional rules should not
   * actually take effect — callers should additionally filter to confidence in ('validated', 'tentative')
   * before using for mechanism behavior. This getActiveRules only excludes retired/disputed,
   * returning provisional rules too, so the dry-run path can audit "would intercept X if active".
   */
  getActiveRules(scope: ConfigScope): ConfigRule[] {
    if (!isConfigScope(scope)) {
      throw new Error(`ConfigRuleStore.getActiveRules: invalid scope '${scope}'`);
    }
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM config_rules
         WHERE scope = ? AND confidence NOT IN ('retired', 'disputed')
         ORDER BY updated_at DESC`,
      )
      .all(scope) as ConfigRuleRow[];
    return rows.map(rowToRule);
  }

  /**
   * Fetches production-ready rules for a scope (confidence IN validated/tentative).
   *
   * Call this when the mechanism layer actually uses configuration — provisional rules are not
   * included during dry-run; they only participate after being promoted to tentative.
   */
  getProductionRules(scope: ConfigScope): ConfigRule[] {
    if (!isConfigScope(scope)) {
      throw new Error(`ConfigRuleStore.getProductionRules: invalid scope '${scope}'`);
    }
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM config_rules
         WHERE scope = ? AND confidence IN ('validated', 'tentative')
         ORDER BY updated_at DESC`,
      )
      .all(scope) as ConfigRuleRow[];
    return rows.map(rowToRule);
  }

  /** List all rules for a scope (for management / dashboard use; includes retired/disputed) */
  listByScope(scope: ConfigScope): ConfigRule[] {
    if (!isConfigScope(scope)) {
      throw new Error(`ConfigRuleStore.listByScope: invalid scope '${scope}'`);
    }
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM config_rules WHERE scope = ? ORDER BY updated_at DESC`,
      )
      .all(scope) as ConfigRuleRow[];
    return rows.map(rowToRule);
  }

  /** List all rules (dashboard overview) */
  listAll(): ConfigRule[] {
    const rows = this.db
      .prepare(`SELECT * FROM config_rules ORDER BY updated_at DESC`)
      .all() as ConfigRuleRow[];
    return rows.map(rowToRule);
  }

  /**
   * Outcome feedback — advances the confidence state machine. Reuses routing_rules.nextConfidence.
   *
   * success → consecutive_successes += 1, consecutive_failures = 0
   * failure → consecutive_failures += 1, consecutive_successes = 0
   *
   * Then calls nextConfidence to compute the next tier, persists + emits 'confidence_changed' event.
   * retired terminal state: still called, but nextConfidence returns retired (no revival) — updated_at is still refreshed.
   */
  recordOutcome(id: number, success: boolean): ConfigRule | null {
    const current = this.get(id);
    if (!current) return null;

    const newSuccess = current.successCount + (success ? 1 : 0);
    const newFailure = current.failureCount + (success ? 0 : 1);
    const newConsecutiveSuccesses = success ? current.consecutiveSuccesses + 1 : 0;
    const newConsecutiveFailures = success ? 0 : current.consecutiveFailures + 1;

    const newConfidence = nextConfidence({
      current: current.confidence,
      consecutiveSuccesses: newConsecutiveSuccesses,
      consecutiveFailures: newConsecutiveFailures,
      lastOutcome: success ? 'success' : 'failure',
    });
    const now = Date.now();
    this.db
      .prepare<[number, number, number, number, string, number, number]>(
        `UPDATE config_rules
         SET success_count = ?, failure_count = ?,
             consecutive_successes = ?, consecutive_failures = ?,
             confidence = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        newSuccess,
        newFailure,
        newConsecutiveSuccesses,
        newConsecutiveFailures,
        newConfidence,
        now,
        id,
      );
    const after = this.get(id);
    if (after && after.confidence !== current.confidence) {
      this.emit('changed', { type: 'confidence_changed', id } satisfies ConfigRuleChangeEvent);
    } else {
      this.emit('changed', { type: 'updated', id } satisfies ConfigRuleChangeEvent);
    }
    return after;
  }

  /**
   * Explicitly set confidence (for management / rollback use).
   * Does not modify success/failure counts; only overwrites confidence + refreshes updated_at.
   * **Outside the state machine**: bypasses the nextConfidence path; used for CLI-forced retire / revival etc.
   */
  setConfidence(id: number, confidence: ConfigConfidence): ConfigRule | null {
    const current = this.get(id);
    if (!current) return null;
    if (current.confidence === confidence) return current;
    const now = Date.now();
    this.db
      .prepare<[string, number, number]>(
        `UPDATE config_rules SET confidence = ?, updated_at = ? WHERE id = ?`,
      )
      .run(confidence, now, id);
    const after = this.get(id);
    this.emit('changed', { type: 'confidence_changed', id } satisfies ConfigRuleChangeEvent);
    return after;
  }

  /**
   * Time-based decay (same pattern as routing_rules.decayStale).
   *
   * - `updated_at < now - tierDownDays (default 30d)`: demote one tier
   *   validated → tentative → provisional → retired; disputed → retired
   * - `updated_at < now - retireDays (default 90d)`: force retired
   * - retired rows are not touched further (already terminal state)
   *
   * After demotion, updated_at is refreshed to now (same as routing_rule pattern),
   * to avoid repeated demotion within the same idle window.
   * Returns demoted + retired counts for audit persistence.
   *
   * idle_consolidator should call this once every 60s.
   */
  decayStale(
    now: number,
    opts: { tierDownDays?: number; retireDays?: number } = {},
  ): { demoted: number; retired: number } {
    const tierDownDays = opts.tierDownDays ?? 30;
    const retireDays = opts.retireDays ?? 90;
    if (tierDownDays <= 0) {
      throw new Error(`ConfigRuleStore.decayStale: invalid tierDownDays=${tierDownDays}`);
    }
    if (retireDays < tierDownDays) {
      throw new Error(
        `ConfigRuleStore.decayStale: retireDays=${retireDays} < tierDownDays=${tierDownDays}`,
      );
    }
    const tierDownThreshold = now - tierDownDays * 86_400_000;
    const retireThreshold = now - retireDays * 86_400_000;

    // First force-retire (exceeded retireDays) — skip the tier-down chain
    const retiredRes = this.db
      .prepare<[number, number]>(
        `UPDATE config_rules
         SET confidence = 'retired', updated_at = ?
         WHERE confidence != 'retired' AND updated_at < ?`,
      )
      .run(now, retireThreshold);
    const retiredCount = retiredRes.changes;

    // Then chain-demote (30 < age < 90)
    let demotedCount = 0;
    const stale = this.db
      .prepare<[number]>(
        `SELECT id, confidence FROM config_rules
         WHERE confidence NOT IN ('retired')
         AND updated_at < ?`,
      )
      .all(tierDownThreshold) as Array<{ id: number; confidence: string }>;
    for (const row of stale) {
      const cur = parseConfidence(row.confidence);
      let next: ConfigConfidence;
      switch (cur) {
        case 'validated': next = 'tentative'; break;
        case 'tentative': next = 'provisional'; break;
        case 'provisional': next = 'retired'; break;
        case 'disputed': next = 'retired'; break;
        case 'retired': continue;
      }
      this.db
        .prepare<[string, number, number]>(
          `UPDATE config_rules SET confidence = ?, updated_at = ? WHERE id = ?`,
        )
        .run(next, now, row.id);
      demotedCount++;
    }
    return { demoted: demotedCount, retired: retiredCount };
  }

  /**
   * Deletes a rule (use with caution; prefer setConfidence='retired' to preserve audit trail).
   * Recommended only for 'manual' source rules; rules produced by 'self:meta-detector'
   * should be retired via the retired path to preserve audit records.
   */
  delete(id: number): boolean {
    const r = this.db
      .prepare<[number]>(`DELETE FROM config_rules WHERE id = ?`)
      .run(id);
    if (r.changes > 0) {
      this.emit('changed', { type: 'deleted', id } satisfies ConfigRuleChangeEvent);
    }
    return r.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM config_rules`)
      .get() as { n: number };
    return row.n;
  }

  countByScope(scope: ConfigScope): number {
    if (!isConfigScope(scope)) {
      throw new Error(`ConfigRuleStore.countByScope: invalid scope '${scope}'`);
    }
    const row = this.db
      .prepare<[string]>(`SELECT COUNT(*) AS n FROM config_rules WHERE scope = ?`)
      .get(scope) as { n: number };
    return row.n;
  }
}
