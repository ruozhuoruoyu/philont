/**
 * SkillStore: Layer 3 skill library
 *
 * Stores reusable action patterns extracted from session reflection.
 * Each skill is a declarative recipe: a name, description, trigger keywords, and action template.
 *
 * v3 feedback loop:
 *   - Each invocation records success/failure via recordSkillOutcome(name, success)
 *   - search / listAll sort by log(1+use_count) × laplace_success_rate × recency
 *   - Skills with frequent failures are automatically down-weighted, shown to users with a [low reliability] indicator
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Skill, SkillInput, SkillMaturity } from './types.js';
import { nextMaturity, parseMaturity } from './skill_maturity.js';

/** SkillStore event payload */
export interface SkillChangeEvent {
  type: 'created' | 'updated' | 'deleted';
  name: string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  trigger_keywords: string;
  action_template: string;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  success_count: number;
  failure_count: number;
  last_failure_at: number | null;
  last_success_at: number | null;
  consecutive_failures: number;
  maturity: string;
  kind: string;
  source: string | null;
  /** v15: trigger scenario text (SKILL.md frontmatter when_to_use). Empty = NULL. */
  when_to_use: string | null;
}

/** Skill composite scoring constants */
const POSITIVE_RECENCY_HALFLIFE_DAYS = 30;
/**
 * Anti-patterns (kind='negative') use a longer half-life.
 * Anti-patterns are "don't do this" constraints with longer lifespans — not repeating them ≠ should forget,
 * so decay here is much slower than for positive Skills.
 */
const NEGATIVE_RECENCY_HALFLIFE_DAYS = 90;
const NEVER_USED_RECENCY = 0.1; // recency baseline when never used, to avoid score going to zero

/**
 * Skill composite score: log(2+useCount) × laplace_success_rate × recency_decay
 *
 * - laplace_success_rate = (success + 1) / (success + failure + 2), smooths zero samples
 * - recency_decay        = exp(-days_since_last_use / halflife)
 *   positive half-life 30 days; negative 90 days (anti-patterns should not lose influence quickly just because they haven't been used recently)
 * - Baseline 0.1 when never used
 */
export function scoreSkill(skill: Skill, now: number = Date.now()): number {
  const laplaceRate =
    (skill.successCount + 1) / (skill.successCount + skill.failureCount + 2);
  const usageWeight = Math.log(2 + skill.useCount);
  const halflife = skill.kind === 'negative'
    ? NEGATIVE_RECENCY_HALFLIFE_DAYS
    : POSITIVE_RECENCY_HALFLIFE_DAYS;
  let recencyDecay: number;
  if (skill.lastUsedAt === null) {
    recencyDecay = NEVER_USED_RECENCY;
  } else {
    const days = (now - skill.lastUsedAt) / 86_400_000;
    recencyDecay = Math.exp(-Math.max(0, days) / halflife);
  }
  return usageWeight * laplaceRate * recencyDecay;
}

function rankByScore(skills: Skill[], limit: number, now: number = Date.now()): Skill[] {
  return skills
    .map((s) => ({ skill: s, score: scoreSkill(s, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.skill);
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    whenToUse: row.when_to_use ?? '',
    triggerKeywords: JSON.parse(row.trigger_keywords),
    actionTemplate: row.action_template,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at,
    consecutiveFailures: row.consecutive_failures ?? 0,
    maturity: parseMaturity(row.maturity, 'draft'),
    kind: row.kind === 'negative' ? 'negative' : 'positive',
    source: row.source ?? null,
  };
}

export class SkillStore extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  /**
   * Create a new skill. Throws if name already exists (reflector should check first).
   * Emits a 'changed' event on success for hot-reload subscribers to refresh the index.
   */
  createSkill(input: SkillInput): Skill {
    const id = randomUUID();
    const createdAt = Date.now();
    const keywordsJson = JSON.stringify(input.triggerKeywords);
    const kind: 'positive' | 'negative' = input.kind === 'negative' ? 'negative' : 'positive';
    const source: string | null = input.source ?? null;
    const maturity: SkillMaturity = parseMaturity(input.maturity, 'draft');
    const whenToUse: string = input.whenToUse ?? '';

    this.db
      .prepare<[string, string, string, string, string, number, string, string | null, string, string | null]>(
        `INSERT INTO memory_skills
         (id, name, description, trigger_keywords, action_template, created_at, kind, source, maturity, when_to_use)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.description, keywordsJson, input.actionTemplate, createdAt, kind, source, maturity, whenToUse || null);

    this.emit('changed', { type: 'created', name: input.name } satisfies SkillChangeEvent);

    return {
      id,
      name: input.name,
      description: input.description,
      whenToUse,
      triggerKeywords: input.triggerKeywords,
      actionTemplate: input.actionTemplate,
      useCount: 0,
      lastUsedAt: null,
      createdAt,
      successCount: 0,
      failureCount: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      maturity,
      kind,
      source,
    };
  }

  /**
   * MECE check (v17, 2026-05-11): find existing skills with high similarity to the input name+whenToUse.
   *
   * Uses Jaccard token overlap similarity (name tokens + whenToUse tokens),
   * default threshold 0.5 (plan design):
   *   ≥ 0.5 → treated as "should extend existing skill rather than create new one", returns candidate list
   *   < 0.5 → not returned, creating new skill is allowed
   *
   * Caller semantics:
   *   - applyReflection new_skill: hit → downgrade to skill_refine, append newCondition
   *     to existing skill description
   *   - plan_close success hook: hit → updateSkill to append plan steps experience; no hit
   *     → create new_skill
   *
   * Design choices:
   *   - Does not automatically throw from inside createSkill (preserves compatibility with existing caller / bundled / clawhub loading)
   *   - Caller decides refine / replace / force-new based on business semantics
   *   - kind='negative' / maturity='deprecated' do not participate as candidates (they are counter-examples / terminal states)
   *
   * Returns candidates sorted by similarity DESC (at most 5); empty array means no conflict.
   */
  findDuplicateCandidates(
    name: string,
    whenToUse: string = '',
    threshold = 0.5,
  ): Array<{ skill: Skill; jaccard: number }> {
    const targetTokens = this.tokenize(name + ' ' + whenToUse);
    if (targetTokens.size === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_skills
         WHERE maturity != 'deprecated' AND kind != 'negative'`,
      )
      .all() as SkillRow[];

    const scored: Array<{ skill: Skill; jaccard: number }> = [];
    for (const row of rows) {
      const skill = rowToSkill(row);
      const candTokens = this.tokenize(skill.name + ' ' + skill.whenToUse);
      if (candTokens.size === 0) continue;
      const j = this.jaccard(targetTokens, candTokens);
      if (j >= threshold) scored.push({ skill, jaccard: j });
    }
    scored.sort((a, b) => b.jaccard - a.jaccard);
    return scored.slice(0, 5);
  }

  /** Simple tokenize: lowercase, split on [a-z0-9 Chinese], drop 1-char stop words. Used for MECE check. */
  private tokenize(text: string): Set<string> {
    const out = new Set<string>();
    const lowered = text.toLowerCase();
    // Split on non-alphanumeric non-Chinese characters; Chinese 1-2 char n-gram is too complex, treat each character individually
    const tokens = lowered.match(/[a-z0-9]+|[一-龥]/g);
    if (!tokens) return out;
    for (const t of tokens) {
      if (t.length >= 2) out.add(t);
    }
    return out;
  }

  /** Jaccard = |A ∩ B| / |A ∪ B| */
  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  /**
   * Exact lookup by name
   */
  getByName(name: string): Skill | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_skills WHERE name = ? LIMIT 1`)
      .get(name) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  /**
   * Full-text skill search (matches any of name/description/keywords)
   *
   * Strategy: FTS5 trigram main path + LIKE fallback.
   * After hits, re-rank in JS layer by composite score, preferring "frequently used, high success rate, recently used" skills.
   */
  search(query: string, limit = 5): Skill[] {
    const safe = query.replace(/['"*()]/g, ' ').trim();
    if (!safe) return [];
    const candidateLimit = Math.max(limit * 4, 20);

    // 2026-05-09: filter maturity='deprecated'. The design intent of deprecated is "agent
    // should not use this anymore" (terminal state); but previously the SQL did not filter it,
    // so after cleanup marked skills as deprecated they still surfaced to LLM (caught in production
    // mycox testing — 70+ deprecated mycox playbooks loaded could still be called by LLM, polluting behaviour).
    let rows: SkillRow[] = [];
    if (safe.length >= 3) {
      try {
        rows = this.db
          .prepare<[string, number]>(
            `SELECT s.* FROM memory_skills s
             JOIN memory_skills_fts fts ON fts.rowid = s.rowid
             WHERE memory_skills_fts MATCH ?
               AND s.maturity != 'deprecated'
             LIMIT ?`
          )
          .all(safe, candidateLimit) as SkillRow[];
      } catch {
        rows = [];
      }
    }

    if (rows.length === 0) {
      const pattern = `%${safe}%`;
      rows = this.db
        .prepare<[string, string, string, number]>(
          `SELECT * FROM memory_skills
           WHERE (name LIKE ? OR description LIKE ? OR trigger_keywords LIKE ?)
             AND maturity != 'deprecated'
           LIMIT ?`
        )
        .all(pattern, pattern, pattern, candidateLimit) as SkillRow[];
    }

    return rankByScore(rows.map(rowToSkill), limit);
  }

  /**
   * List all skills (descending composite score; used for system prompt injection index).
   *
   * 2026-05-09: filter deprecated. Same reason as search — the system prompt injection index
   * is also content LLM sees, deprecated skills should not appear.
   */
  listAll(limit = 50): Skill[] {
    // Fetch enough candidates; re-rank in JS layer
    const candidateLimit = Math.max(limit * 4, 200);
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_skills
         WHERE maturity != 'deprecated'
         ORDER BY use_count DESC, created_at DESC
         LIMIT ?`
      )
      .all(candidateLimit) as SkillRow[];
    return rankByScore(rows.map(rowToSkill), limit);
  }

  /**
   * List skills by maturity tier, sorted by created_at DESC (newest first).
   *
   * 2026-05-11: designed specifically for playbook section rendering. Playbook skills do not
   * accumulate use_count (always 0); sorting by created_at ensures the lessons from the most
   * recent reflection are exposed first. Also usable for targeted queries for other tiers
   * (e.g. "how many draft skills are there now").
   *
   * Default limit=5, matching the prefix section length of buildPlaybookHints.
   */
  listByMaturity(maturity: SkillMaturity, limit = 5): Skill[] {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_skills
         WHERE maturity = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(maturity, limit) as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * List all anti-pattern Skills (kind='negative').
   *
   * Descending composite score (more recently updated / more frequently violated anti-patterns first);
   * used for full injection into the system prompt. If the count grows too large to inject in full (>20),
   * caller can pass a limit.
   */
  listNegative(limit = 50): Skill[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_skills
         WHERE kind = 'negative'
           AND maturity != 'deprecated'
         ORDER BY last_used_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(Math.max(limit, 50)) as SkillRow[];
    return rankByScore(rows.map(rowToSkill), limit);
  }

  /**
   * Record a skill invocation result (core of feedback loop + maturity state machine).
   *
   *   - success=true  → success_count++, update last_used_at + last_success_at,
   *                     reset consecutive_failures to 0
   *   - success=false → failure_count++, update last_used_at + last_failure_at,
   *                     consecutive_failures++
   * Both cases: use_count++.
   *
   * Then evaluates whether to promote/demote the current tier using nextMaturity():
   *   - Promotion: success path only, strictly threshold-controlled (see skill_maturity.ts)
   *   - Demotion: failure path → deprecated directly if deprecated threshold triggered;
   *               otherwise stable → confirmed, confirmed → draft, draft → draft
   *   - playbook and deprecated are terminal states, the automatic state machine does not enter or exit them
   */
  recordSkillOutcome(name: string, success: boolean, at: number = Date.now()): Skill | null {
    const sql = success
      ? `UPDATE memory_skills
         SET use_count            = use_count + 1,
             success_count        = success_count + 1,
             last_used_at         = ?,
             last_success_at      = ?,
             consecutive_failures = 0
         WHERE name = ?`
      : `UPDATE memory_skills
         SET use_count            = use_count + 1,
             failure_count        = failure_count + 1,
             last_used_at         = ?,
             last_failure_at      = ?,
             consecutive_failures = consecutive_failures + 1
         WHERE name = ?`;
    const result = success
      ? this.db.prepare<[number, number, string]>(sql).run(at, at, name)
      : this.db.prepare<[number, number, string]>(sql).run(at, at, name);
    if (result.changes === 0) return null;

    // State machine evaluation: compute next tier from the already-updated counts, UPDATE if changed
    const after = this.getByName(name);
    if (!after) return null;
    const computed = nextMaturity({
      current: after.maturity,
      successCount: after.successCount,
      failureCount: after.failureCount,
      consecutiveFailures: after.consecutiveFailures,
      lastOutcome: success ? 'success' : 'failure',
    });
    if (computed !== after.maturity) {
      this.db
        .prepare<[string, string]>(`UPDATE memory_skills SET maturity = ? WHERE name = ?`)
        .run(computed, name);
      this.emit('changed', { type: 'updated', name } satisfies SkillChangeEvent);
      return { ...after, maturity: computed };
    }
    return after;
  }

  /**
   * Explicitly set maturity (overriding the state machine). For the following scenarios:
   *   - reflection writes playbook (state machine does not auto-enter playbook)
   *   - manually reviving a mistakenly deprecated skill to draft (state machine does not revive)
   *   - clawhub loading presetting trust tier to confirmed/stable
   *
   * Does not modify success/failure counts or timestamps.
   */
  setMaturity(name: string, maturity: SkillMaturity): Skill | null {
    const result = this.db
      .prepare<[string, string]>(`UPDATE memory_skills SET maturity = ? WHERE name = ?`)
      .run(maturity, name);
    if (result.changes === 0) return null;
    this.emit('changed', { type: 'updated', name } satisfies SkillChangeEvent);
    return this.getByName(name);
  }

  /**
   * Increment use count (backward compatibility; equivalent to recordSkillOutcome(name, true)).
   *
   * @deprecated New code should use recordSkillOutcome to carry success/failure signal
   */
  incrementUseCount(name: string): Skill | null {
    return this.recordSkillOutcome(name, true);
  }

  /**
   * Update a skill (used by reflector to merge similar patterns)
   */
  updateSkill(
    name: string,
    updates: Partial<Pick<SkillInput, 'description' | 'triggerKeywords' | 'actionTemplate' | 'kind' | 'source' | 'whenToUse'>>,
  ): Skill | null {
    const existing = this.getByName(name);
    if (!existing) return null;

    const description = updates.description ?? existing.description;
    const triggerKeywords = updates.triggerKeywords ?? existing.triggerKeywords;
    const actionTemplate = updates.actionTemplate ?? existing.actionTemplate;
    const kind: 'positive' | 'negative' = updates.kind === 'negative' || updates.kind === 'positive'
      ? updates.kind
      : existing.kind;
    // source 用 hasOwnProperty 区分"未传"(保留原值)与"显式 null"(清空)
    const source: string | null = Object.prototype.hasOwnProperty.call(updates, 'source')
      ? (updates.source ?? null)
      : existing.source;
    const whenToUse: string = updates.whenToUse ?? existing.whenToUse;

    this.db
      .prepare<[string, string, string, string, string | null, string | null, string]>(
        `UPDATE memory_skills
         SET description = ?, trigger_keywords = ?, action_template = ?, kind = ?, source = ?, when_to_use = ?
         WHERE name = ?`
      )
      .run(description, JSON.stringify(triggerKeywords), actionTemplate, kind, source, whenToUse || null, name);

    this.emit('changed', { type: 'updated', name } satisfies SkillChangeEvent);
    return this.getByName(name);
  }

  /** Delete a skill (users can revoke low-quality skills) */
  deleteSkill(name: string): boolean {
    const result = this.db
      .prepare<[string]>(`DELETE FROM memory_skills WHERE name = ?`)
      .run(name);
    if (result.changes > 0) {
      this.emit('changed', { type: 'deleted', name } satisfies SkillChangeEvent);
    }
    return result.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_skills`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * 2026-06-08: cap reflection-distilled DRAFT skills to bound skill-store bloat. The idle reflector
   * mints new draft skills every cycle; with no cap the store grows unboundedly, the reflector keeps
   * re-distilling near-duplicates, and skill scans/injection get noisier (and feed memory-prefix
   * growth). Evict the LOWEST-scored drafts (scoreSkill: unused / old / failing first) once drafts
   * exceed maxDrafts. ONLY `draft` maturity is touched — confirmed/stable/playbook (promoted,
   * curated) and external (disk SKILL.md) skills are never pruned here. Returns the number deleted.
   */
  pruneDraftsToCap(maxDrafts: number): number {
    if (!Number.isFinite(maxDrafts) || maxDrafts < 0) return 0;
    const drafts = (
      this.db.prepare(`SELECT * FROM memory_skills WHERE maturity = 'draft'`).all() as SkillRow[]
    ).map(rowToSkill);
    if (drafts.length <= maxDrafts) return 0;
    const now = Date.now();
    // ascending by score → lowest-value (unused/old/failing) drafts first
    const sorted = drafts.slice().sort((a, b) => scoreSkill(a, now) - scoreSkill(b, now));
    const toDelete = sorted.slice(0, drafts.length - maxDrafts);
    let deleted = 0;
    for (const s of toDelete) if (this.deleteSkill(s.name)) deleted++;
    return deleted;
  }

  /**
   * List all skills whose source starts with the specified prefix (for ClawHub list / filtering by registry).
   *
   * Example: listBySourcePrefix('clawhub:') returns all ClawHub-loaded skills,
   * regardless of version. Sorted by createdAt DESC, most recently loaded first.
   */
  listBySourcePrefix(sourcePrefix: string): Skill[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_skills
         WHERE source LIKE ?
         ORDER BY created_at DESC`
      )
      .all(`${sourcePrefix}%`) as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * List all external skills "loaded from disk SKILL.md", for chat-handler reload-prune.
   *
   * Excludes two types of skills that must not be pruned:
   *   - source IS NULL: locally written / legacy
   *   - source LIKE 'self:%': reflection-distilled self-generated (self:reflect-<id> etc.),
   *     which have non-NULL source but no corresponding file on disk — disk scan will never find them →
   *     if not excluded they would be mistakenly deleted by reload-prune, wasting the reflection "accumulation"
   *     mechanism (fixed 2026-05-15)
   *
   * No scoring; sorted by createdAt DESC — prune does not need ranking.
   */
  listExternalSkills(): Skill[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_skills
         WHERE source IS NOT NULL AND source NOT LIKE 'self:%'
         ORDER BY created_at DESC`,
      )
      .all() as SkillRow[];
    return rows.map(rowToSkill);
  }
}
