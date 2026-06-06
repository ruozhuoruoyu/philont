/**
 * PursuitStore: Pursuit layer storage (added in v7)
 *
 * Core conventions:
 *   - A pursuit row with parent_pursuit_id IS NULL is the root → agent identity
 *   - All other self-domain tables are attributed to root via the root_pursuit_id redundant column, for flat queries
 *   - constitution_* four fields are only valid on root rows; writes to non-root will be rejected
 *   - During a session run, constitution is treated as frozen: hashed once into audit on load;
 *     writes to constitution_* during the run should not happen (enforced by the application layer)
 */

import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ConstitutionFields,
  OpenQuestion,
  OpenQuestionStatus,
  ProgressMarker,
  Pursuit,
  PursuitInput,
  PursuitStake,
  PursuitStatus,
} from './types.js';
import { BOOTSTRAP_ROOT_PURSUIT_ID } from './schema.js';
import type { MemoryAuditHook } from './audit.js';

const PURSUIT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class InvalidPursuitIdError extends Error {
  constructor(id: string) {
    super(`pursuit id "${id}" does not match ^[a-z0-9][a-z0-9_-]{0,63}$`);
  }
}

export class ConstitutionOnNonRootError extends Error {
  constructor(id: string) {
    super(`constitution fields can only be written to root pursuit; target id=${id} is not root`);
  }
}

export class PursuitNotFoundError extends Error {
  constructor(id: string) {
    super(`pursuit id=${id} does not exist`);
  }
}

interface PursuitRow {
  id: string;
  parent_pursuit_id: string | null;
  root_pursuit_id: string;
  title: string;
  intent: string;
  status: string;
  is_evergreen: number;
  stake: string;
  deadline: number | null;
  origin: string;
  open_questions_json: string;
  resolution_criteria: string | null;
  evidence_refs_json: string;
  progress_markers_json: string;
  last_progress_turn: number;
  constitution_values: string | null;
  constitution_red_lines: string | null;
  constitution_drive_bounds: string | null;
  constitution_governance: string | null;
  last_touched_ts: number | null;
  stake_weight: number;
  is_active_research: number;
  research_iterations: number;
  created_at: number;
  updated_at: number;
}

/** Default mapping from stake enum → 1-10 weight */
function stakeToWeight(stake: PursuitStake): number {
  switch (stake) {
    case 'low': return 3;
    case 'high': return 8;
    case 'medium':
    default: return 5;
  }
}

function rowToPursuit(row: PursuitRow): Pursuit {
  return {
    id: row.id,
    parentPursuitId: row.parent_pursuit_id,
    rootPursuitId: row.root_pursuit_id,
    title: row.title,
    intent: row.intent,
    status: row.status as PursuitStatus,
    isEvergreen: row.is_evergreen === 1,
    stake: row.stake as PursuitStake,
    deadline: row.deadline,
    origin: row.origin as Pursuit['origin'],
    openQuestions: JSON.parse(row.open_questions_json) as OpenQuestion[],
    resolutionCriteria: row.resolution_criteria,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    progressMarkers: JSON.parse(row.progress_markers_json) as ProgressMarker[],
    lastProgressTurn: row.last_progress_turn,
    values: row.constitution_values,
    redLines: row.constitution_red_lines
      ? (JSON.parse(row.constitution_red_lines) as string[])
      : null,
    driveBounds: row.constitution_drive_bounds
      ? (JSON.parse(row.constitution_drive_bounds) as ConstitutionFields['driveBounds'])
      : null,
    pursuitGovernance: row.constitution_governance
      ? (JSON.parse(row.constitution_governance) as ConstitutionFields['pursuitGovernance'])
      : null,
    lastTouchedAt: row.last_touched_ts ?? row.updated_at,
    stakeWeight: row.stake_weight,
    isActiveResearch: (row.is_active_research ?? 0) === 1,
    researchIterations: row.research_iterations ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateId(id: string): void {
  if (!PURSUIT_ID_RE.test(id)) {
    throw new InvalidPursuitIdError(id);
  }
}

function newOpenQuestion(text: string, createdTurn: number): OpenQuestion {
  return {
    id: randomUUID(),
    text,
    status: 'open',
    resolvedBy: null,
    createdTurn,
    updatedTurn: createdTurn,
    pendingTool: null,
  };
}

export class PursuitStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a root pursuit (= new agent identity).
   *
   * Idempotency is guaranteed by the application-side caller (duplicate creation with the same id
   * will be rejected by the SQLite PK constraint).
   * The built-in bootstrap root is created by schema.ts's ensureBootstrapRoot during initSchema;
   * the application layer typically does not need to explicitly call createRoot — just call getRoot() directly.
   */
  createRoot(input: PursuitInput): Pursuit {
    if (input.parentPursuitId != null) {
      throw new Error(
        'createRoot: input.parentPursuitId must be null; to create a child pursuit use createChild()'
      );
    }
    const id = input.id ?? randomUUID();
    validateId(id);
    return this.insertRow({
      ...input,
      id,
      parentPursuitId: null,
      rootPursuitId: id, // root's own root points to itself
    });
  }

  /**
   * Create a child pursuit. Automatically derives root_pursuit_id from the parent pursuit.
   * Constitution fields cannot be written to a child pursuit.
   */
  createChild(input: PursuitInput & { parentPursuitId: string }): Pursuit {
    const parent = this.get(input.parentPursuitId);
    if (!parent) throw new PursuitNotFoundError(input.parentPursuitId);

    const hasConstitution =
      input.values != null ||
      input.redLines != null ||
      input.driveBounds != null ||
      input.pursuitGovernance != null;
    if (hasConstitution) {
      throw new ConstitutionOnNonRootError(input.id ?? '<new>');
    }

    const id = input.id ?? randomUUID();
    validateId(id);
    return this.insertRow({
      ...input,
      id,
      rootPursuitId: parent.rootPursuitId,
    });
  }

  private insertRow(
    full: PursuitInput & {
      id: string;
      parentPursuitId: string | null;
      rootPursuitId: string;
    }
  ): Pursuit {
    const now = Date.now();
    const openQuestions: OpenQuestion[] =
      full.openQuestions?.map((q) => newOpenQuestion(q.text, 0)) ?? [];

    const isRoot = full.parentPursuitId === null;
    // constitution fields for non-root rows are already validated in createChild
    const values = isRoot ? full.values ?? null : null;
    const redLines = isRoot && full.redLines ? JSON.stringify(full.redLines) : null;
    const driveBounds = isRoot && full.driveBounds ? JSON.stringify(full.driveBounds) : null;
    const governance =
      isRoot && full.pursuitGovernance ? JSON.stringify(full.pursuitGovernance) : null;

    const stake = full.stake ?? 'medium';
    const stakeWeight = full.stakeWeight ?? stakeToWeight(stake);

    this.db
      .prepare(
        `INSERT INTO memory_pursuits
         (id, parent_pursuit_id, root_pursuit_id, title, intent, status,
          is_evergreen, stake, deadline, origin, open_questions_json,
          resolution_criteria, evidence_refs_json, progress_markers_json,
          last_progress_turn,
          constitution_values, constitution_red_lines,
          constitution_drive_bounds, constitution_governance,
          last_touched_ts, stake_weight,
          is_active_research, research_iterations,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        full.id,
        full.parentPursuitId,
        full.rootPursuitId,
        full.title,
        full.intent,
        full.status ?? 'active',
        full.isEvergreen ? 1 : 0,
        stake,
        full.deadline ?? null,
        full.origin,
        JSON.stringify(openQuestions),
        full.resolutionCriteria ?? null,
        '[]',
        '[]',
        0,
        values,
        redLines,
        driveBounds,
        governance,
        now, // last_touched_ts: treated as "touched once" at creation
        stakeWeight,
        full.isActiveResearch ? 1 : 0,
        0, // research_iterations starts at 0
        now,
        now
      );

    return this.get(full.id)!;
  }

  get(id: string): Pursuit | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_pursuits WHERE id = ? LIMIT 1`
      )
      .get(id) as PursuitRow | undefined;
    return row ? rowToPursuit(row) : null;
  }

  /** Get the default root (the one created during bootstrap, id is BOOTSTRAP_ROOT_PURSUIT_ID) */
  getDefaultRoot(): Pursuit | null {
    return this.get(BOOTSTRAP_ROOT_PURSUIT_ID);
  }

  /** List all root pursuits (parent IS NULL) */
  listRoots(): Pursuit[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_pursuits
         WHERE parent_pursuit_id IS NULL
         ORDER BY created_at`
      )
      .all() as PursuitRow[];
    return rows.map(rowToPursuit);
  }

  /** List all active pursuits under a root (including the root itself) */
  listActive(rootId: string): Pursuit[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_pursuits
         WHERE root_pursuit_id = ? AND status = 'active'
         ORDER BY created_at`
      )
      .all(rootId) as PursuitRow[];
    return rows.map(rowToPursuit);
  }

  /** List pursuits with the specified status under a root */
  listByStatus(rootId: string, status: PursuitStatus): Pursuit[] {
    const rows = this.db
      .prepare<[string, string]>(
        `SELECT * FROM memory_pursuits
         WHERE root_pursuit_id = ? AND status = ?
         ORDER BY created_at`
      )
      .all(rootId, status) as PursuitRow[];
    return rows.map(rowToPursuit);
  }

  /**
   * Update the pursuit status.
   * PursuitIntegrityDrive is responsible for intercepting illegal status changes from External origin elsewhere;
   * no duplicate check here — the Store is the mechanism layer; the policy layer is guarded by drive/policy.
   */
  updateStatus(id: string, status: PursuitStatus): void {
    const now = Date.now();
    const r = this.db
      .prepare<[string, number, number, string]>(
        `UPDATE memory_pursuits SET status = ?, updated_at = ?, last_touched_ts = ? WHERE id = ?`
      )
      .run(status, now, now, id);
    if (r.changes === 0) throw new PursuitNotFoundError(id);
  }

  /**
   * v24: mark/unmark "active research". on=true lets the autonomous loop advance it every tick
   * without waiting for staleness; on=false converges and stops (falls back to ordinary pursuit).
   *
   * Note: **does not refresh last_touched_ts** — the active research path does not depend on aging,
   * and refreshing would interfere with commitment_pressure's "how long since last activity" semantics.
   */
  setActiveResearch(id: string, on: boolean): void {
    const r = this.db
      .prepare<[number, number, string]>(
        `UPDATE memory_pursuits SET is_active_research = ?, updated_at = ? WHERE id = ?`
      )
      .run(on ? 1 : 0, Date.now(), id);
    if (r.changes === 0) throw new PursuitNotFoundError(id);
  }

  /**
   * v24: advance active research by one step; research_iterations += 1; returns new value (for convergence limit checks).
   * Also does not refresh last_touched_ts (left to addEvidence/bumpProgress).
   */
  bumpResearchIterations(id: string): number {
    const r = this.db
      .prepare<[number, string]>(
        `UPDATE memory_pursuits SET research_iterations = research_iterations + 1, updated_at = ? WHERE id = ?`
      )
      .run(Date.now(), id);
    if (r.changes === 0) throw new PursuitNotFoundError(id);
    return this.get(id)!.researchIterations;
  }

  /** Append an open question; returns the new question id */
  addOpenQuestion(pursuitId: string, text: string, currentTurn: number): string {
    const pursuit = this.get(pursuitId);
    if (!pursuit) throw new PursuitNotFoundError(pursuitId);
    const q = newOpenQuestion(text, currentTurn);
    const updated = [...pursuit.openQuestions, q];
    const now = Date.now();
    this.db
      .prepare<[string, number, number, string]>(
        `UPDATE memory_pursuits
         SET open_questions_json = ?, updated_at = ?, last_touched_ts = ? WHERE id = ?`
      )
      .run(JSON.stringify(updated), now, now, pursuitId);
    return q.id;
  }

  /** Mark an open question as resolved/dismissed */
  closeOpenQuestion(
    pursuitId: string,
    questionId: string,
    status: Exclude<OpenQuestionStatus, 'open'>,
    resolvedBy: string | null,
    currentTurn: number
  ): void {
    const pursuit = this.get(pursuitId);
    if (!pursuit) throw new PursuitNotFoundError(pursuitId);
    const updated = pursuit.openQuestions.map((q) =>
      q.id === questionId
        ? // clear pendingTool when closing the question: the pending approval's lifetime ends with the question
          { ...q, status, resolvedBy: resolvedBy ?? null, updatedTurn: currentTurn, pendingTool: null }
        : q
    );
    const now = Date.now();
    this.db
      .prepare<[string, number, number, string]>(
        `UPDATE memory_pursuits
         SET open_questions_json = ?, updated_at = ?, last_touched_ts = ? WHERE id = ?`
      )
      .run(JSON.stringify(updated), now, now, pursuitId);
  }

  /**
   * Active research "permission request": record/clear a pending tool approval request for an open question.
   *
   * When the autonomous executor determines it needs a forbidden tool while answering this question →
   * OutcomeHook calls this method to record {tool, why} in question.pendingTool; after user approval
   * the driver replays accordingly. Pass null to clear.
   *
   * Deliberately **does not refresh last_touched_ts** (closeOpenQuestion/addOpenQuestion both refresh; this method does not) —
   * a pending approval is just a status annotation, not "progress made"; refreshing would disrupt
   * the active research staleness determination.
   * If the question is not found, this is a no-op (idempotent; repeated needs-grant calls do not error).
   */
  setQuestionPendingTool(
    pursuitId: string,
    questionId: string,
    pendingTool: { tool: string; why: string } | null
  ): void {
    const pursuit = this.get(pursuitId);
    if (!pursuit) throw new PursuitNotFoundError(pursuitId);
    let hit = false;
    const updated = pursuit.openQuestions.map((q) => {
      if (q.id !== questionId) return q;
      hit = true;
      return { ...q, pendingTool };
    });
    if (!hit) return;
    this.db
      .prepare<[string, number, string]>(
        `UPDATE memory_pursuits SET open_questions_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(JSON.stringify(updated), Date.now(), pursuitId);
  }

  /**
   * Advance pursuit progress: append a progress marker + update last_progress_turn.
   * Used by reflector / drive outcome phase.
   */
  bumpProgress(
    pursuitId: string,
    turn: number,
    summary: string,
    driveOutcomeId: string | null = null
  ): void {
    const pursuit = this.get(pursuitId);
    if (!pursuit) throw new PursuitNotFoundError(pursuitId);
    const marker: ProgressMarker = { turn, summary, driveOutcomeId };
    const updated = [...pursuit.progressMarkers, marker];
    const now = Date.now();
    this.db
      .prepare<[string, number, number, number, string]>(
        `UPDATE memory_pursuits
         SET progress_markers_json = ?,
             last_progress_turn = ?,
             updated_at = ?,
             last_touched_ts = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(updated), turn, now, now, pursuitId);
  }

  /** Append an evidence reference */
  addEvidence(pursuitId: string, ref: string): void {
    const pursuit = this.get(pursuitId);
    if (!pursuit) throw new PursuitNotFoundError(pursuitId);
    if (pursuit.evidenceRefs.includes(ref)) return;
    const updated = [...pursuit.evidenceRefs, ref];
    const now = Date.now();
    this.db
      .prepare<[string, number, number, string]>(
        `UPDATE memory_pursuits
         SET evidence_refs_json = ?, updated_at = ?, last_touched_ts = ? WHERE id = ?`
      )
      .run(JSON.stringify(updated), now, now, pursuitId);
  }

  // ── Constitution ─────────────────────────────────────────────────────

  /** Read the root's four constitution fields */
  getConstitution(rootId: string): ConstitutionFields | null {
    const pursuit = this.get(rootId);
    if (!pursuit) return null;
    if (pursuit.parentPursuitId !== null) {
      throw new ConstitutionOnNonRootError(rootId);
    }
    return {
      values: pursuit.values ?? null,
      redLines: pursuit.redLines ?? null,
      driveBounds: pursuit.driveBounds ?? null,
      pursuitGovernance: pursuit.pursuitGovernance ?? null,
    };
  }

  /**
   * Write the root's four constitution fields. Non-root is rejected.
   * Should not be called during a session run — guaranteed by the application layer; no runtime guard added here.
   */
  setConstitution(rootId: string, fields: ConstitutionFields): void {
    const pursuit = this.get(rootId);
    if (!pursuit) throw new PursuitNotFoundError(rootId);
    if (pursuit.parentPursuitId !== null) {
      throw new ConstitutionOnNonRootError(rootId);
    }
    this.db
      .prepare<[string | null, string | null, string | null, string | null, number, string]>(
        `UPDATE memory_pursuits
         SET constitution_values        = ?,
             constitution_red_lines     = ?,
             constitution_drive_bounds  = ?,
             constitution_governance    = ?,
             updated_at                 = ?
         WHERE id = ?`
      )
      .run(
        fields.values ?? null,
        fields.redLines ? JSON.stringify(fields.redLines) : null,
        fields.driveBounds ? JSON.stringify(fields.driveBounds) : null,
        fields.pursuitGovernance ? JSON.stringify(fields.pursuitGovernance) : null,
        Date.now(),
        rootId
      );
  }

  /**
   * Compute the SHA-256 hash of the constitution.
   *
   * Used at startup to write the hash into AuditLog (constitution_load event) as a proof of
   * soul integrity. Serialization uses stable JSON (keys sorted) so different processes get the same hash.
   */
  computeConstitutionHash(rootId: string): string {
    const fields = this.getConstitution(rootId);
    const payload = stableStringify(fields ?? {});
    return createHash('sha256').update(payload).digest('hex');
  }
}

/** Stable JSON serialization: outputs object keys in lexicographic order; used for hashing */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`
  );
  return `{${parts.join(',')}}`;
}

/**
 * Constitution startup load: called once by the application layer during server/demo initialization.
 *
 *   1. Read the root's four constitution fields from PursuitStore
 *   2. Compute SHA-256 hash
 *   3. Record a 'constitution_load' event (hash + origin='Internal') via the audit hook
 *   4. Return { fields, hash } for subsequent DriveRegistry assembly (drive_bounds for Reflector)
 *
 * During a session run, constitution is treated as frozen — the application layer should not modify
 * root's constitution_* fields after this call; changes should wait until the next startup, or go
 * through the constitution_proposals flow (future iteration).
 */
export interface LoadedConstitution {
  rootPursuitId: string;
  fields: ConstitutionFields;
  hash: string;
}

export function loadConstitution(
  pursuits: PursuitStore,
  rootId: string = BOOTSTRAP_ROOT_PURSUIT_ID,
  audit?: MemoryAuditHook
): LoadedConstitution {
  const fields = pursuits.getConstitution(rootId);
  if (!fields) {
    throw new PursuitNotFoundError(rootId);
  }
  const hash = pursuits.computeConstitutionHash(rootId);
  audit?.append('constitution_load', {
    rootPursuitId: rootId,
    hash,
    // full text is not logged (audit only needs the hash as an integrity proof; content is in DB);
    // if future need arises to "see the constitution text", retrieve via audit timestamp + DB snapshot
    hasValues: fields.values != null,
    redLineCount: fields.redLines?.length ?? 0,
    driveBoundKinds: Object.keys(fields.driveBounds ?? {}),
    origin: 'Internal',
    source: 'loadConstitution',
  });
  return { rootPursuitId: rootId, fields, hash };
}
