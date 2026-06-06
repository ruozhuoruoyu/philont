/**
 * RoutingRule: input condition → skill decision rules distilled by reflection
 *
 * Solves: agent runs 10 rounds trying different methods; the accumulated "which PDF method works when" differentiated knowledge
 * all evaporates, and the next time it still starts from scratch. This module provides a persistence channel for reflection,
 * encoding successful paths as routing rules (condition + recommendation + avoidance + evidence + boundary),
 * so the agent can adopt them directly when encountering similar tasks.
 *
 * Decoupled from SkillStore: routing rules reference skill name, not skill id; skill unload
 * and reload (version change / similar replacement) keeps rules intact. When a skill is truly deprecated,
 * call invalidateBySkillName to demote rules that recommend that skill.
 *
 * 5-tier confidence state machine (see nextConfidence below):
 *   provisional → tentative → validated
 *   validated/tentative/provisional + failure → disputed
 *   disputed + 2 consecutive failures → retired
 *   disputed + 2 consecutive successes → validated (recovery)
 *   retired is a terminal state (setConfidence can explicitly revive)
 */

import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';

export type RoutingConfidence =
  | 'provisional'
  | 'tentative'
  | 'validated'
  | 'disputed'
  | 'retired';

export interface RoutingRule {
  id: number;
  taskSignature: string;
  triggerCondition: string;
  preferSkill: string | null;
  avoidSkills: string[];
  carveout: string;
  evidence: string;
  confidence: RoutingConfidence;
  successCount: number;
  failureCount: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  contextKeywords: string[];
  reflectionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutingRuleInput {
  taskSignature: string;
  triggerCondition: string;
  preferSkill?: string | null;
  avoidSkills?: string[];
  /** Write-time enforcement — empty string not allowed (prevents over-generalization) */
  carveout: string;
  /** Write-time enforcement — empty string not allowed (prevents fabrication) */
  evidence: string;
  /** Default 'provisional'; caller can pass 'tentative' (LLM self-assessed self_confidence) */
  confidence?: RoutingConfidence;
  /** Keywords extracted from triggerCondition; caller provides by default; if empty, createRule will best-effort extract */
  contextKeywords?: string[];
  reflectionId?: string | null;
}

interface RoutingRuleRow {
  id: number;
  task_signature: string;
  trigger_condition: string;
  prefer_skill: string | null;
  avoid_skills: string | null;
  carveout: string;
  evidence: string;
  confidence: string;
  success_count: number;
  failure_count: number;
  consecutive_successes: number;
  consecutive_failures: number;
  context_keywords: string | null;
  reflection_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface RoutingRuleChangeEvent {
  type: 'created' | 'updated' | 'deleted' | 'invalidated';
  id: number;
}

// ── State machine ──────────────────────────────────────────────────────────────

export interface ConfidenceComputeInput {
  current: RoutingConfidence;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastOutcome: 'success' | 'failure';
}

/**
 * Compute the next confidence tier for a routing rule.
 *
 * Rules (see plan):
 *   provisional + 1 succ                       → tentative
 *   tentative   + 2 succ streak                → validated
 *   disputed    + 2 succ streak                → validated (recovery)
 *   validated   + 1 fail                       → disputed
 *   tentative   + 1 fail                       → provisional (catch-all demote one tier)
 *   provisional + 1 fail                       → disputed (escalate alarm)
 *   disputed    + 2 fail streak                → retired
 *   disputed    + 1 fail (streak < 2)          → disputed (stays)
 *   retired                                    → terminal state (automaton does not revive; setConfidence can explicitly)
 *
 * Invariant: caller should have already reflected the current outcome into the streak accumulation
 * (success → consecutiveSuccesses += 1, consecutiveFailures = 0; and vice versa).
 */
export function nextConfidence(input: ConfidenceComputeInput): RoutingConfidence {
  const { current, consecutiveSuccesses, consecutiveFailures, lastOutcome } = input;

  if (current === 'retired') return 'retired';

  if (lastOutcome === 'success') {
    if (current === 'provisional') return 'tentative';
    if (current === 'tentative' && consecutiveSuccesses >= 2) return 'validated';
    if (current === 'disputed' && consecutiveSuccesses >= 2) return 'validated';
    return current;
  }

  // failure path
  if (current === 'disputed') {
    if (consecutiveFailures >= 2) return 'retired';
    return 'disputed';
  }
  if (current === 'validated') return 'disputed';
  if (current === 'tentative') return 'provisional';
  if (current === 'provisional') return 'disputed';
  return current;
}

/** "Maturity tier" of confidence, used to sort for stable-first retrieval. */
export function confidenceRank(c: RoutingConfidence): number {
  switch (c) {
    case 'validated': return 4;
    case 'tentative': return 3;
    case 'provisional': return 2;
    case 'disputed': return 1;
    case 'retired': return 0;
  }
}

/** Whether this participates in use_skill candidate injection (retired does not). */
export function isActiveConfidence(c: RoutingConfidence): boolean {
  return c !== 'retired';
}

/** Tier hint text injected into system prompt. */
export function confidenceCaveat(c: RoutingConfidence): string {
  switch (c) {
    case 'provisional': return '[provisional · not yet validated, verify before use]';
    case 'tentative':   return '[tentative · based on limited experience, recommended but stay alert]';
    case 'validated':   return '[validated]';
    case 'disputed':    return '[⚠️ disputed · this rule has counter-examples, use with caution]';
    case 'retired':     return '[retired · verified unreliable, use as counter-example]';
  }
}

/**
 * Validate whether a string is a valid confidence value (deserialization fallback).
 */
export function parseConfidence(
  s: unknown,
  fallback: RoutingConfidence = 'provisional',
): RoutingConfidence {
  if (
    s === 'provisional' ||
    s === 'tentative' ||
    s === 'validated' ||
    s === 'disputed' ||
    s === 'retired'
  ) {
    return s;
  }
  return fallback;
}

// ── Keyword matching / conflict resolution ────────────────────────────────────────────────

/**
 * Simple keyword extraction: split free text into word segments, keep ≥ 2 char parts, lowercase.
 *
 * Used when caller doesn't explicitly provide contextKeywords at createRule time,
 * to auto-extract from triggerCondition. Quality is worse than stop-words+stemming but sufficient:
 * reflection is a sparse event, keyword retrieval is for rough filtering, not NLP precision.
 *
 * Chinese uses char-{bigram, trigram} dual coverage to improve recall for "user uses N-char word,
 * rule uses same N-char substring" scenarios (e.g. user says "scanned PDF", rule keyword "scanned" also hits).
 */
export function extractKeywords(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  const segments = text.split(/[\s,,。、.;:;:'"()【】<>《》「」『』/\\|`*+\-#@!???!=]+/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (/^[A-Za-z0-9_]+$/.test(trimmed)) {
      if (trimmed.length >= 2) tokens.push(trimmed.toLowerCase());
    } else {
      // Contains Chinese → full segment + char bigram + char trigram
      tokens.push(trimmed.toLowerCase());
      for (let i = 0; i < trimmed.length - 1; i++) {
        const bi = trimmed.slice(i, i + 2);
        if (bi.trim().length === 2) tokens.push(bi);
      }
      for (let i = 0; i < trimmed.length - 2; i++) {
        const tri = trimmed.slice(i, i + 3);
        if (tri.trim().length === 3) tokens.push(tri);
      }
    }
  }
  return Array.from(new Set(tokens));
}

/**
 * Compute the overlap score between two sets of keywords (simplified Jaccard).
 *
 * @returns 0..1, higher means more similar. Returns 0 when no keywords present (no match).
 */
export function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const k of setA) if (setB.has(k)) inter++;
  if (inter === 0) return 0;
  return inter / (setA.size + setB.size - inter);
}

/**
 * specificity: higher score when trigger_condition is more specific (more subclauses / keywords).
 * Used for rule conflict resolution: when multiple rules match simultaneously, higher specificity takes priority.
 *
 * Simplified implementation: contextKeywords count + carveout length (longer carveout means clearer boundaries).
 */
export function specificity(rule: RoutingRule): number {
  return rule.contextKeywords.length + Math.min(rule.carveout.length / 50, 5);
}

// ── Store ───────────────────────────────────────────────────────────────

function rowToRule(row: RoutingRuleRow): RoutingRule {
  return {
    id: row.id,
    taskSignature: row.task_signature,
    triggerCondition: row.trigger_condition,
    preferSkill: row.prefer_skill,
    avoidSkills: row.avoid_skills ? safeJsonArray(row.avoid_skills) : [],
    carveout: row.carveout,
    evidence: row.evidence,
    confidence: parseConfidence(row.confidence, 'provisional'),
    successCount: row.success_count,
    failureCount: row.failure_count,
    consecutiveSuccesses: row.consecutive_successes,
    consecutiveFailures: row.consecutive_failures,
    contextKeywords: row.context_keywords ? safeJsonArray(row.context_keywords) : [],
    reflectionId: row.reflection_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
  } catch {
    /* fallthrough */
  }
  return [];
}

export class RoutingRuleStore extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  /**
   * Create a new routing rule.
   * carveout / evidence are required; empty string rejected (prevents over-generalization and fabrication).
   */
  createRule(input: RoutingRuleInput): RoutingRule {
    if (!input.carveout || !input.carveout.trim()) {
      throw new Error('routing_rule: carveout cannot be empty (write-time guard against over-generalization)');
    }
    if (!input.evidence || !input.evidence.trim()) {
      throw new Error('routing_rule: evidence cannot be empty (rules must be traceable)');
    }
    if (!input.taskSignature || !input.triggerCondition) {
      throw new Error('routing_rule: taskSignature and triggerCondition are required');
    }

    const now = Date.now();
    const confidence = parseConfidence(input.confidence, 'provisional');
    const avoidSkills = JSON.stringify(input.avoidSkills ?? []);
    const contextKeywords = JSON.stringify(
      input.contextKeywords && input.contextKeywords.length > 0
        ? input.contextKeywords
        : extractKeywords(input.triggerCondition),
    );

    const result = this.db
      .prepare<[
        string, string, string | null, string, string, string,
        string, string, string | null, number, number,
      ]>(
        `INSERT INTO routing_rules
         (task_signature, trigger_condition, prefer_skill, avoid_skills, carveout, evidence,
          confidence, context_keywords, reflection_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskSignature,
        input.triggerCondition,
        input.preferSkill ?? null,
        avoidSkills,
        input.carveout,
        input.evidence,
        confidence,
        contextKeywords,
        input.reflectionId ?? null,
        now,
        now,
      );

    const id = Number(result.lastInsertRowid);
    this.emit('changed', { type: 'created', id } satisfies RoutingRuleChangeEvent);
    const created = this.getById(id);
    if (!created) {
      throw new Error('routing_rule: getById failed immediately after createRule write, DB error');
    }
    return created;
  }

  getById(id: number): RoutingRule | null {
    const row = this.db
      .prepare<[number]>(`SELECT * FROM routing_rules WHERE id = ?`)
      .get(id) as RoutingRuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  listAll(): RoutingRule[] {
    const rows = this.db
      .prepare(`SELECT * FROM routing_rules ORDER BY updated_at DESC`)
      .all() as RoutingRuleRow[];
    return rows.map(rowToRule);
  }

  listBySignature(taskSignature: string): RoutingRule[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM routing_rules WHERE task_signature = ? ORDER BY updated_at DESC`,
      )
      .all(taskSignature) as RoutingRuleRow[];
    return rows.map(rowToRule);
  }

  /**
   * Search for matching rules.
   *
   * Strategy:
   *   1. If taskSignature provided, rough-filter by exact / LIKE prefix; null/empty → full table (active status)
   *   2. JS layer scores with keywordOverlap against given contextKeywords
   *   3. Keep only rules with score >= minScore
   *   4. Sort by (confidenceRank, score, specificity) and take top-N
   *   5. retired never participates
   *
   * Use cases:
   *   - Task start with known task_signature (provided at reflection write time) → pass exact match
   *   - User message incoming, not yet classified → taskSignature=null, pure keyword search
   */
  match(
    taskSignature: string | null,
    contextKeywords: string[],
    options: { limit?: number; minScore?: number } = {},
  ): RoutingRule[] {
    const limit = options.limit ?? 3;
    const minScore = options.minScore ?? 0.1; // rough filter threshold

    let rows: RoutingRuleRow[];
    if (taskSignature && taskSignature.trim()) {
      const sig = taskSignature.trim();
      const sigPattern = `${sig.split('-')[0]}%`;
      rows = this.db
        .prepare<[string, string]>(
          `SELECT * FROM routing_rules
           WHERE confidence != 'retired'
             AND (task_signature = ? OR task_signature LIKE ?)
           ORDER BY updated_at DESC
           LIMIT 50`,
        )
        .all(sig, sigPattern) as RoutingRuleRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM routing_rules
           WHERE confidence != 'retired'
           ORDER BY updated_at DESC
           LIMIT 100`,
        )
        .all() as RoutingRuleRow[];
    }

    const scored = rows
      .map(rowToRule)
      .map((rule) => {
        // taskSig hit gives 0.5 + 0.5 * keyword overlap score;
        // taskSig not given (=null) gives 1.0 * keyword overlap score (avoids halving score when user input is unclassified).
        const overlap = keywordOverlap(rule.contextKeywords, contextKeywords);
        const exactSig = !!(taskSignature && rule.taskSignature === taskSignature);
        return {
          rule,
          score: exactSig ? 0.5 + 0.5 * overlap : overlap,
        };
      })
      .filter((x) => x.score >= minScore)
      .sort((a, b) => {
        const ca = confidenceRank(a.rule.confidence);
        const cb = confidenceRank(b.rule.confidence);
        if (ca !== cb) return cb - ca;
        if (a.score !== b.score) return b.score - a.score;
        return specificity(b.rule) - specificity(a.rule);
      })
      .slice(0, limit);

    return scored.map((x) => x.rule);
  }

  /**
   * Record feedback after a routing rule is adopted (success / failure).
   *
   * Accumulates: success_count / failure_count + corresponding streak;
   * then uses nextConfidence() to determine whether the tier changes.
   */
  recordRuleOutcome(id: number, success: boolean): RoutingRule | null {
    const sql = success
      ? `UPDATE routing_rules
         SET success_count          = success_count + 1,
             consecutive_successes  = consecutive_successes + 1,
             consecutive_failures   = 0,
             updated_at             = ?
         WHERE id = ?`
      : `UPDATE routing_rules
         SET failure_count          = failure_count + 1,
             consecutive_failures   = consecutive_failures + 1,
             consecutive_successes  = 0,
             updated_at             = ?
         WHERE id = ?`;
    const result = this.db.prepare<[number, number]>(sql).run(Date.now(), id);
    if (result.changes === 0) return null;

    const after = this.getById(id);
    if (!after) return null;
    const computed = nextConfidence({
      current: after.confidence,
      consecutiveSuccesses: after.consecutiveSuccesses,
      consecutiveFailures: after.consecutiveFailures,
      lastOutcome: success ? 'success' : 'failure',
    });
    if (computed !== after.confidence) {
      this.db
        .prepare<[string, number, number]>(
          `UPDATE routing_rules SET confidence = ?, updated_at = ? WHERE id = ?`,
        )
        .run(computed, Date.now(), id);
      this.emit('changed', { type: 'updated', id } satisfies RoutingRuleChangeEvent);
      return { ...after, confidence: computed };
    }
    return after;
  }

  /** Explicitly override confidence (for testing / reviving retired). */
  setConfidence(id: number, c: RoutingConfidence): RoutingRule | null {
    const result = this.db
      .prepare<[string, number, number]>(
        `UPDATE routing_rules SET confidence = ?, updated_at = ? WHERE id = ?`,
      )
      .run(c, Date.now(), id);
    if (result.changes === 0) return null;
    this.emit('changed', { type: 'updated', id } satisfies RoutingRuleChangeEvent);
    return this.getById(id);
  }

  /**
   * Called when a skill is unloaded / deprecated: retire all rules that reference this skill as prefer.
   * Avoid references are left unchanged (avoidance rules remain valid).
   *
   * @returns Number of affected rules
   */
  invalidateBySkillName(skillName: string): number {
    const result = this.db
      .prepare<[string]>(
        `UPDATE routing_rules
         SET confidence = 'retired', updated_at = strftime('%s','now')*1000
         WHERE prefer_skill = ? AND confidence != 'retired'`,
      )
      .run(skillName);
    if (result.changes > 0) {
      this.emit('changed', {
        type: 'invalidated',
        id: -1, // indicates batch operation
      } satisfies RoutingRuleChangeEvent);
    }
    return result.changes;
  }

  delete(id: number): boolean {
    const result = this.db
      .prepare<[number]>(`DELETE FROM routing_rules WHERE id = ?`)
      .run(id);
    if (result.changes > 0) {
      this.emit('changed', { type: 'deleted', id } satisfies RoutingRuleChangeEvent);
      return true;
    }
    return false;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM routing_rules`)
      .get() as { n: number };
    return row.n;
  }

  countActive(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM routing_rules WHERE confidence != 'retired'`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Time decay: scan all non-retired rules, demote those that haven't been touched for a long time.
   *
   * Rules:
   *   - updated_at < now - retireDays * 86400_000 → force retired
   *   - updated_at < now - tierDownDays * 86400_000 → demote one tier
   *     (validated → tentative → provisional → retired; disputed → retired)
   *
   * After demotion updated_at is refreshed to now, making this auto-idempotent: multiple calls
   * within the same idle tick will not double-demote. Each tierDownDays cycle demotes one tier again,
   * naturally walking the full demotion chain.
   *
   * Invariants:
   *   - retired is terminal state, decay does not touch it
   *   - DB state changes before/after are only confidence + updated_at columns
   *   - Does not emit EventEmitter 'changed' events (batch operation, avoids event storm)
   *
   * @returns Number of affected rules (demoted = one tier down, retired = directly retired)
   */
  decayStale(
    now: number = Date.now(),
    opts: { tierDownDays?: number; retireDays?: number } = {},
  ): { demoted: number; retired: number } {
    const tierDownDays = opts.tierDownDays ?? 30;
    const retireDays = opts.retireDays ?? 90;
    if (tierDownDays <= 0 || retireDays < tierDownDays) {
      throw new Error(
        `decayStale: invalid thresholds tierDownDays=${tierDownDays} retireDays=${retireDays}`,
      );
    }
    const tierDownCutoff = now - tierDownDays * 86_400_000;
    const retireCutoff = now - retireDays * 86_400_000;

    const stale = this.db
      .prepare<[number]>(
        `SELECT id, confidence, updated_at FROM routing_rules
         WHERE confidence != 'retired' AND updated_at < ?`,
      )
      .all(tierDownCutoff) as Array<{
      id: number;
      confidence: string;
      updated_at: number;
    }>;

    let demoted = 0;
    let retired = 0;
    const setConfidenceStmt = this.db.prepare<[string, number, number]>(
      `UPDATE routing_rules SET confidence = ?, updated_at = ? WHERE id = ?`,
    );
    for (const row of stale) {
      const current = parseConfidence(row.confidence, 'provisional');
      const next: RoutingConfidence =
        row.updated_at < retireCutoff ? 'retired' : demoteOneStep(current);
      if (next === current) continue;
      setConfidenceStmt.run(next, now, row.id);
      if (next === 'retired') retired++;
      else demoted++;
    }
    return { demoted, retired };
  }
}

/**
 * Demote confidence one tier. Chain: validated → tentative → provisional → retired;
 * disputed → retired (already a failure loop, decay directly retires).
 */
function demoteOneStep(c: RoutingConfidence): RoutingConfidence {
  switch (c) {
    case 'validated':
      return 'tentative';
    case 'tentative':
      return 'provisional';
    case 'provisional':
      return 'retired';
    case 'disputed':
      return 'retired';
    case 'retired':
      return 'retired';
  }
}
