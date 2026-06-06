/**
 * InitiativeStore — CRUD for the memory_initiatives table.
 *
 * Lifecycle of a single initiative:
 *   driver.propose() → store.insert(pending) → executor.run() →
 *   store.markRunning() → store.markDone()/markFailed()/markSkipped()
 *
 * 24h dedup: listRecentSettledTargetRefs is used by the loop to filter out
 * targets that have been handled (succeeded or failed) recently before dispatching.
 * Failed items also enter dedup to prevent garbage tokens from repeatedly wasting LLM tokens.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Initiative,
  InitiativeOutcomeRefs,
  InitiativeProposal,
  InitiativeStatus,
} from './types.js';

interface InitiativeRow {
  id: string;
  kind: string;
  driver: string;
  target_ref: string;
  rationale: string;
  utility: number;
  status: string;
  budget_estimate: number;
  budget_actual: number | null;
  outcome_summary: string | null;
  outcome_refs: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function rowToInitiative(row: InitiativeRow): Initiative {
  let refs: InitiativeOutcomeRefs | null = null;
  if (row.outcome_refs) {
    try {
      const parsed = JSON.parse(row.outcome_refs) as Partial<InitiativeOutcomeRefs>;
      refs = {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        pursuits: Array.isArray(parsed.pursuits) ? parsed.pursuits : [],
      };
    } catch {
      refs = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    driver: row.driver,
    targetRef: row.target_ref,
    rationale: row.rationale,
    utility: row.utility,
    status: parseStatus(row.status),
    budgetEstimate: row.budget_estimate,
    budgetActual: row.budget_actual,
    outcomeSummary: row.outcome_summary,
    outcomeRefs: refs,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseStatus(s: string): InitiativeStatus {
  if (
    s === 'pending' ||
    s === 'running' ||
    s === 'done' ||
    s === 'failed' ||
    s === 'skipped'
  ) {
    return s;
  }
  return 'pending';
}

const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class InitiativeStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Persist a candidate to the database with status pending. Returns the full Initiative.
   */
  insert(p: InitiativeProposal): Initiative {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare<[
        string, string, string, string, string, number, number, number,
      ]>(
        `INSERT INTO memory_initiatives
         (id, kind, driver, target_ref, rationale, utility, budget_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.kind,
        p.driver,
        p.targetRef,
        p.rationale,
        p.utility,
        p.budgetEstimate,
        createdAt,
      );
    return {
      ...p,
      id,
      status: 'pending',
      budgetActual: null,
      outcomeSummary: null,
      outcomeRefs: null,
      error: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    };
  }

  getById(id: string): Initiative | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_initiatives WHERE id = ?`)
      .get(id) as InitiativeRow | undefined;
    return row ? rowToInitiative(row) : null;
  }

  /**
   * Mark as running. Returns updated Initiative; returns null if not in pending state.
   */
  markRunning(id: string): Initiative | null {
    const startedAt = Date.now();
    const r = this.db
      .prepare<[number, string]>(
        `UPDATE memory_initiatives
         SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(startedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  markDone(
    id: string,
    summary: string,
    refs: InitiativeOutcomeRefs,
    budgetActual: number,
  ): Initiative | null {
    const completedAt = Date.now();
    const refsJson = JSON.stringify(refs);
    const r = this.db
      .prepare<[string, string, number, number, string]>(
        `UPDATE memory_initiatives
         SET status = 'done',
             outcome_summary = ?,
             outcome_refs = ?,
             budget_actual = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(summary, refsJson, budgetActual, completedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  markFailed(id: string, error: string, budgetActual: number): Initiative | null {
    const completedAt = Date.now();
    const r = this.db
      .prepare<[string, number, number, string]>(
        `UPDATE memory_initiatives
         SET status = 'failed',
             error = ?,
             budget_actual = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(error, budgetActual, completedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  markSkipped(id: string, reason: string): Initiative | null {
    const completedAt = Date.now();
    const r = this.db
      .prepare<[string, number, string]>(
        `UPDATE memory_initiatives
         SET status = 'skipped',
             error = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(reason, completedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  /**
   * Set of target_refs that are done or failed within the last 24h (used by loop for dedup before dispatching).
   *
   * Previously only done was checked, causing the same garbage token (e.g. a common Chinese phrase
   * caught by CuriosityDriver) to be repeatedly proposed → executor repeatedly fails → repeatedly proposed,
   * wasting tokens. Now failed also enters the dedup ring; the same target won't be retried for 24h.
   * For transient failures (network hiccups etc.), the 24h window naturally unlocks retry.
   */
  listRecentSettledTargetRefs(windowMs = DEFAULT_DEDUPE_WINDOW_MS, now = Date.now()): Set<string> {
    const since = now - windowMs;
    const rows = this.db
      .prepare<[number]>(
        `SELECT DISTINCT target_ref FROM memory_initiatives
         WHERE status IN ('done', 'failed') AND completed_at IS NOT NULL AND completed_at >= ?`,
      )
      .all(since) as Array<{ target_ref: string }>;
    return new Set(rows.map((r) => r.target_ref));
  }

  /** @deprecated Use listRecentSettledTargetRefs (failed also deduped) instead */
  listRecentDoneTargetRefs(windowMs = DEFAULT_DEDUPE_WINDOW_MS, now = Date.now()): Set<string> {
    return this.listRecentSettledTargetRefs(windowMs, now);
  }

  /**
   * List initiatives in pending status, ordered by utility DESC + created_at ASC.
   * Loop usually doesn't use this directly — dispatches immediately after propose —
   * but retained for recovery / debugging.
   */
  listPending(limit = 20): Initiative[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_initiatives
         WHERE status = 'pending'
         ORDER BY utility DESC, created_at ASC
         LIMIT ?`,
      )
      .all(limit) as InitiativeRow[];
    return rows.map(rowToInitiative);
  }

  /**
   * List the most recent N done initiatives (for chat-handler to render "what I just did").
   * Ordered by completed_at DESC; only those after sinceTs.
   */
  listRecentDone(sinceTs: number, limit = 5): Initiative[] {
    const rows = this.db
      .prepare<[number, number]>(
        `SELECT * FROM memory_initiatives
         WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(sinceTs, limit) as InitiativeRow[];
    return rows.map(rowToInitiative);
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_initiatives`)
      .get() as { n: number };
    return row.n;
  }

  countByStatus(status: InitiativeStatus): number {
    const row = this.db
      .prepare<[string]>(
        `SELECT COUNT(*) as n FROM memory_initiatives WHERE status = ?`,
      )
      .get(status) as { n: number };
    return row.n;
  }

  /**
   * General recent list — for dashboard / debugging; can filter by status / driver.
   * Ordered by created_at DESC; default limit 30.
   */
  listRecent(opts: {
    limit?: number;
    status?: InitiativeStatus;
    driver?: string;
  } = {}): Initiative[] {
    const limit = opts.limit ?? 30;
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status) {
      conds.push('status = ?');
      params.push(opts.status);
    }
    if (opts.driver) {
      conds.push('driver = ?');
      params.push(opts.driver);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    // rowid as stable tiebreaker when multiple inserts happen within the same ms
    // (id is a UUID string; lexicographic order does not reflect insertion order)
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_initiatives
         ${where}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params) as InitiativeRow[];
    return rows.map(rowToInitiative);
  }

  /**
   * Count by status group (for overview). Returns a structure with all 5 tiers, defaulting to 0.
   */
  countByStatusGroup(): Record<InitiativeStatus, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as n FROM memory_initiatives GROUP BY status`,
      )
      .all() as Array<{ status: string; n: number }>;
    const out: Record<InitiativeStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    };
    for (const r of rows) {
      const s = parseStatus(r.status);
      out[s] = r.n;
    }
    return out;
  }
}
