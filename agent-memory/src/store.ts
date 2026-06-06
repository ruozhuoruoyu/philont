/**
 * MemoryStore: Layer 2 structured fact storage
 *
 * Core design:
 *   - Namespace KV lookup (namespace + key → JSON value)
 *   - Fact lifecycle: when new supersedes old, the old is not deleted but marked supersededBy
 *   - Queries default to returning only active facts (superseded_by IS NULL)
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Fact, FactInput, FactKind } from './types.js';
import {
  scoreMemory,
  DEFAULT_FORGET_THRESHOLD,
  PIN_SENTINEL,
  type ScorableMemory,
} from './decay.js';

interface FactRow {
  id: string;
  namespace: string;
  key: string;
  value_json: string;
  confidence: number;
  superseded_by: string | null;
  supersedes: string | null;
  created_at: number;
  occurred_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  last_accessed_at: number | null;
  decay_tau_days: number | null;
  forgotten_at: number | null;
  fact_kind: string;
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value_json),
    confidence: row.confidence,
    supersededBy: row.superseded_by,
    supersedes: row.supersedes,
    createdAt: row.created_at,
    occurredAt: row.occurred_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    lastAccessedAt: row.last_accessed_at,
    decayTauDays: row.decay_tau_days,
    forgottenAt: row.forgotten_at,
    factKind: (row.fact_kind === 'event' ? 'event' : 'state') as FactKind,
  };
}

/**
 * Write-protection error for the self.* namespace.
 * See MemoryStore.updateSelfFact.
 */
export class SelfDescriptionWriteForbiddenError extends Error {
  constructor(key: string, caller: string) {
    super(
      `memory_facts namespace='self' is kernel-only. ` +
      `To update 'self.${key}' use MemoryStore.updateSelfFact with caller='self-reflector'. ` +
      `Caller was: ${caller}`,
    );
    this.name = 'SelfDescriptionWriteForbiddenError';
  }
}

/**
 * Write-protection token for self.*. Not exported — only updateSelfFact within this file can access it.
 * Even if external code imports this module, it cannot obtain this symbol; storeFact writes to self.* will be rejected.
 */
const KERNEL_SELF_WRITE: unique symbol = Symbol('kernel-self-write');

/**
 * Structured value for self.* facts.
 */
export interface SelfFactValue {
  content: string | string[];
  sourceRefs: string[];
  updatedAt: number;
}

export class MemoryStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Store one fact.
   *
   * The self.* namespace is **protected**: external calls to storeFact writing self.* will throw
   * SelfDescriptionWriteForbiddenError. Writes must go through updateSelfFact (with kernel token).
   * This ensures the agent's self-description can only be updated by SelfReflector, not accidentally
   * overwritten by LLM prompts / tools / extractor paths.
   *
   * If an active record already exists for (namespace, key), the new fact supersedes the old one:
   * the old record's superseded_by points to the new id; the new record's supersedes points to the old id.
   */
  storeFact(input: FactInput, _kernelToken?: typeof KERNEL_SELF_WRITE): Fact {
    if (input.namespace === 'self' && _kernelToken !== KERNEL_SELF_WRITE) {
      throw new SelfDescriptionWriteForbiddenError(input.key, 'storeFact');
    }
    const id = randomUUID();
    const createdAt = Date.now();
    const valueJson = JSON.stringify(input.value);
    const confidence = input.confidence ?? 1.0;
    const factKind: FactKind = input.factKind ?? 'state';
    const occurredAt = input.occurredAt ?? null;
    const validFrom = input.validFrom ?? null;
    const validUntil = input.validUntil ?? null;
    const decayTauDays = input.decayTauDays ?? null;

    // Validation: if both validFrom and validUntil are specified, the latter must not be earlier than the former
    if (validFrom !== null && validUntil !== null && validUntil < validFrom) {
      throw new Error(
        `storeFact: valid_until (${validUntil}) 早于 valid_from (${validFrom})`
      );
    }

    // Find existing active fact
    const existing = this.db
      .prepare<[string, string]>(
        `SELECT * FROM memory_facts
         WHERE namespace = ? AND key = ? AND superseded_by IS NULL
         LIMIT 1`
      )
      .get(input.namespace, input.key) as FactRow | undefined;

    const supersedes = existing?.id ?? null;

    // Insert new fact (including v3 time fields).
    // 2026-05-23: last_accessed_at initialized to created_at — a freshly written fact is the most recently
    // touched; this prevents a brand new fact from falling to the end of the sort order because the field is NULL
    // and falling back to 0.
    this.db
      .prepare<[
        string, string, string, string, number, string | null, number,
        number | null, number | null, number | null, number, number | null, string
      ]>(
        `INSERT INTO memory_facts
         (id, namespace, key, value_json, confidence, supersedes, created_at,
          occurred_at, valid_from, valid_until, last_accessed_at, decay_tau_days, fact_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, input.namespace, input.key, valueJson, confidence, supersedes, createdAt,
        occurredAt, validFrom, validUntil, createdAt, decayTauDays, factKind
      );

    // Update old fact's superseded_by
    if (existing) {
      this.db
        .prepare<[string, string]>(
          `UPDATE memory_facts SET superseded_by = ? WHERE id = ?`
        )
        .run(id, existing.id);
    }

    return {
      id,
      namespace: input.namespace,
      key: input.key,
      value: input.value,
      confidence,
      supersededBy: null,
      supersedes,
      createdAt,
      occurredAt,
      validFrom,
      validUntil,
      lastAccessedAt: createdAt,
      decayTauDays,
      forgottenAt: null,
      factKind,
    };
  }

  /**
   * Get a single fact (active only, filtered for forgotten).
   * Automatically refreshes last_accessed_at on hit — explicit key lookup = "this fact was used",
   * distinguished from listFacts (bulk scan, not counted as used). When chat-handler injects the
   * prefix it sorts by lastAccessedAt desc; identity/config facts (timezone / role) retain their
   * ranking as long as they are read and won't be pushed down by newly written research facts.
   */
  getFact(namespace: string, key: string): Fact | null {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT * FROM memory_facts
         WHERE namespace = ? AND key = ?
           AND superseded_by IS NULL
           AND forgotten_at IS NULL
         LIMIT 1`
      )
      .get(namespace, key) as FactRow | undefined;

    if (!row) return null;
    // One Date.now() call shared by both DB and the return object, ensuring caller gets a value consistent with DB.
    const accessTs = Date.now();
    this.markAccessed(row.id, accessTs);
    const fact = rowToFact(row);
    return { ...fact, lastAccessedAt: accessTs };
  }

  /**
   * Temporal query: returns the version of "whether this fact was true at time `at`".
   *
   * Only looks at the validity window (valid_from/valid_until), not ingestion time.
   * If "knowledge as known at time T" (bi-temporal AS-OF) is needed, implement a separate method.
   *
   * When multiple historical versions match, returns the one with the largest created_at (most recently extracted).
   */
  getActiveAt(namespace: string, key: string, at: number): Fact | null {
    const row = this.db
      .prepare<[string, string, number, number]>(
        `SELECT * FROM memory_facts
         WHERE namespace = ? AND key = ?
           AND (valid_from IS NULL OR valid_from <= ?)
           AND (valid_until IS NULL OR valid_until >= ?)
           AND forgotten_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(namespace, key, at, at) as FactRow | undefined;

    return row ? rowToFact(row) : null;
  }

  /**
   * List all active facts in a namespace (default: filter out forgotten)
   */
  listFacts(namespace: string): Fact[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_facts
         WHERE namespace = ?
           AND superseded_by IS NULL
           AND forgotten_at IS NULL
         ORDER BY key`
      )
      .all(namespace) as FactRow[];

    return rows.map(rowToFact);
  }

  /**
   * List all namespaces (for debugging or generating the memory index accessible to the agent)
   */
  listNamespaces(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT namespace FROM memory_facts
         WHERE superseded_by IS NULL AND forgotten_at IS NULL
         ORDER BY namespace`
      )
      .all() as { namespace: string }[];
    return rows.map((r) => r.namespace);
  }

  /**
   * Query historical versions (including superseded ones)
   * Used for "I might have misremembered" scenario backtracking
   *
   * Return order: current active version first, then descending by insertion order
   */
  getFactHistory(namespace: string, key: string): Fact[] {
    const rows = this.db
      .prepare<[string, string]>(
        `SELECT * FROM memory_facts
         WHERE namespace = ? AND key = ?
         ORDER BY (superseded_by IS NULL) DESC, rowid DESC`
      )
      .all(namespace, key) as FactRow[];

    return rows.map(rowToFact);
  }

  /**
   * Count: number of active facts
   */
  count(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM memory_facts
         WHERE superseded_by IS NULL AND forgotten_at IS NULL`
      )
      .get() as { n: number };
    return row.n;
  }

  // ── Phase 5: Access tracking + proactive forgetting ─────────────────────────────────────

  /** Get by id (including forgotten), for backtracking or unforget */
  getById(id: string, includeForgotten = false): Fact | null {
    const sql = includeForgotten
      ? `SELECT * FROM memory_facts WHERE id = ? LIMIT 1`
      : `SELECT * FROM memory_facts WHERE id = ? AND forgotten_at IS NULL LIMIT 1`;
    const row = this.db.prepare<[string]>(sql).get(id) as FactRow | undefined;
    return row ? rowToFact(row) : null;
  }

  /**
   * Mark last_accessed_at, for LRU decay.
   * Caller typically calls this on getFact/listFacts hits; can also be called explicitly at the tool layer.
   */
  markAccessed(id: string, at: number = Date.now()): void {
    this.db
      .prepare<[number, string]>(
        `UPDATE memory_facts SET last_accessed_at = ? WHERE id = ?`
      )
      .run(at, id);
  }

  /**
   * Return the forget candidate pool: non-forgotten non-pinned facts with score below threshold,
   * each with its current computed score. Sorted by score ascending (most forgettable first).
   */
  getForgetCandidates(opts: {
    threshold?: number;
    limit?: number;
    namespace?: string;
    now?: number;
  } = {}): Array<{ fact: Fact; score: number }> {
    const threshold = opts.threshold ?? DEFAULT_FORGET_THRESHOLD;
    const limit = opts.limit ?? 50;
    const now = opts.now ?? Date.now();

    const params: unknown[] = [];
    let sql = `SELECT * FROM memory_facts
               WHERE superseded_by IS NULL
                 AND forgotten_at IS NULL
                 AND (decay_tau_days IS NULL OR decay_tau_days >= 0)`;
    if (opts.namespace) {
      sql += ` AND namespace = ?`;
      params.push(opts.namespace);
    }

    const rows = this.db.prepare(sql).all(...params) as FactRow[];
    const scored: Array<{ fact: Fact; score: number }> = [];
    for (const row of rows) {
      const fact = rowToFact(row);
      const mem: ScorableMemory = {
        namespace: fact.namespace,
        confidence: fact.confidence,
        createdAt: fact.createdAt,
        lastAccessedAt: fact.lastAccessedAt,
        decayTauDays: fact.decayTauDays,
      };
      const score = scoreMemory(mem, now);
      if (score < threshold) {
        scored.push({ fact, score });
      }
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit);
  }

  /** Soft delete (reversible) */
  softForget(id: string, at: number = Date.now()): boolean {
    const r = this.db
      .prepare<[number, string]>(
        `UPDATE memory_facts SET forgotten_at = ?
         WHERE id = ? AND forgotten_at IS NULL`
      )
      .run(at, id);
    return r.changes > 0;
  }

  /** Undo soft delete */
  unforget(id: string): boolean {
    const r = this.db
      .prepare<[string]>(
        `UPDATE memory_facts SET forgotten_at = NULL WHERE id = ?`
      )
      .run(id);
    return r.changes > 0;
  }

  /** pin: never decay (represented by PIN_SENTINEL sentinel value) */
  pin(id: string): boolean {
    const r = this.db
      .prepare<[number, string]>(
        `UPDATE memory_facts SET decay_tau_days = ? WHERE id = ?`
      )
      .run(PIN_SENTINEL, id);
    return r.changes > 0;
  }

  /** unpin: restore decay by namespace default */
  unpin(id: string): boolean {
    const r = this.db
      .prepare<[string]>(
        `UPDATE memory_facts SET decay_tau_days = NULL WHERE id = ?`
      )
      .run(id);
    return r.changes > 0;
  }

  /**
   * Kernel-only write path for the self.* namespace.
   *
   * Only accepts caller='self-reflector' (TS literal type + runtime guard).
   * Value is wrapped in a SelfFactValue structure carrying sourceRefs (prevents fabricated self-identity).
   * Non-reflector callers → SelfDescriptionWriteForbiddenError.
   *
   * This is not true kernel protection (not achievable at the TS level), but it is sufficient to:
   * - Prevent accidental LLM tool writes (since storeFact already rejects self.*)
   * - Prevent accidental modification by extractor/compactor and other internal paths
   * - Force any bypass in code review to explicitly write `caller: 'self-reflector'`
   *
   * True kernel enforcement is planned for Phase K1 (Rust constants + FFI read-only).
   */
  updateSelfFact(
    key: string,
    content: string | string[],
    sourceRefs: string[],
    caller: 'self-reflector',
  ): Fact {
    if (caller !== 'self-reflector') {
      throw new SelfDescriptionWriteForbiddenError(key, String(caller));
    }
    const value: SelfFactValue = {
      content,
      sourceRefs,
      updatedAt: Date.now(),
    };
    return this.storeFact(
      {
        namespace: 'self',
        key,
        value,
        confidence: 1.0,
      },
      KERNEL_SELF_WRITE,
    );
  }
}
