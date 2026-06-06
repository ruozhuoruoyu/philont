/**
 * DriveConfigStore: declarative drive configuration store (added in v7)
 *
 * Declarative drives are first-class citizens of agent-memory, on par with skills and facts.
 * DeclarativeEngine pulls active/shadow entries from here on startup; SessionReflector writes
 * drive parameter adjustments back here; constitution's drive_bounds are evaluated on the Reflector side.
 *
 * Status semantics:
 *   - shadow:  drive can fire and produce outcomes, but does **not** inject messages (observe without interfering)
 *   - active:  drive officially participates in arbitration and injection
 *   - retired: drive has been decommissioned; visible only for audit purposes, not loaded
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  DriveConfig,
  DriveConfigInput,
  DriveConfigStatus,
  EffectivenessStats,
} from './types.js';

const DRIVE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class InvalidDriveIdError extends Error {
  constructor(id: string) {
    super(`drive id "${id}" 不符合 ^[a-z0-9][a-z0-9_-]{0,63}$`);
  }
}

export class DriveConfigNotFoundError extends Error {
  constructor(id: string) {
    super(`drive config id=${id} 不存在`);
  }
}

interface DriveConfigRow {
  id: string;
  kind: string;
  status: string;
  trigger_expr_json: string;
  action_template_json: string;
  params_json: string;
  effectiveness_json: string;
  root_pursuit_id: string;
  created_at: number;
  updated_at: number;
}

function rowToConfig(row: DriveConfigRow): DriveConfig {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as DriveConfigStatus,
    triggerExpr: JSON.parse(row.trigger_expr_json),
    actionTemplate: JSON.parse(row.action_template_json),
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    effectiveness: JSON.parse(row.effectiveness_json) as EffectivenessStats,
    rootPursuitId: row.root_pursuit_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EMPTY_STATS: EffectivenessStats = { samples: 0, ewma: 0, lastFired: null };

export class DriveConfigStore {
  constructor(private readonly db: Database.Database) {}

  create(input: DriveConfigInput): DriveConfig {
    const id = input.id ?? randomUUID();
    if (!DRIVE_ID_RE.test(id)) throw new InvalidDriveIdError(id);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO memory_drive_configs
         (id, kind, status, trigger_expr_json, action_template_json,
          params_json, effectiveness_json, root_pursuit_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.status ?? 'shadow',
        JSON.stringify(input.triggerExpr),
        JSON.stringify(input.actionTemplate),
        JSON.stringify(input.params ?? {}),
        JSON.stringify(EMPTY_STATS),
        input.rootPursuitId,
        now,
        now
      );
    return this.get(id)!;
  }

  get(id: string): DriveConfig | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_drive_configs WHERE id = ? LIMIT 1`)
      .get(id) as DriveConfigRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  listByRoot(
    rootId: string,
    opts: { statuses?: DriveConfigStatus[]; kind?: string } = {}
  ): DriveConfig[] {
    const statuses = opts.statuses ?? ['active', 'shadow'];
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const params: unknown[] = [rootId, ...statuses];
    let sql = `SELECT * FROM memory_drive_configs
               WHERE root_pursuit_id = ? AND status IN (${placeholders})`;
    if (opts.kind) {
      sql += ` AND kind = ?`;
      params.push(opts.kind);
    }
    sql += ` ORDER BY created_at`;
    const rows = this.db.prepare(sql).all(...params) as DriveConfigRow[];
    return rows.map(rowToConfig);
  }

  updateStatus(id: string, status: DriveConfigStatus): void {
    const r = this.db
      .prepare<[string, number, string]>(
        `UPDATE memory_drive_configs SET status = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, Date.now(), id);
    if (r.changes === 0) throw new DriveConfigNotFoundError(id);
  }

  /**
   * Writes back parameter adjustments from the Reflector. No bounds check here — the caller
   * (Reflector) is responsible for intercepting proposals that exceed constitution.drive_bounds.
   * This is the mechanism layer; it simply writes.
   */
  updateParams(id: string, params: Record<string, unknown>): void {
    const r = this.db
      .prepare<[string, number, string]>(
        `UPDATE memory_drive_configs SET params_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(JSON.stringify(params), Date.now(), id);
    if (r.changes === 0) throw new DriveConfigNotFoundError(id);
  }

  /**
   * Updates effectiveness statistics: after each round's effectiveness score is available,
   * merges into EWMA and updates lastFired.
   * α is provided by the caller (Reflector v1 uses 0.3); not built into the mechanism layer.
   */
  updateEffectiveness(
    id: string,
    newScore: number,
    alpha: number,
    firedAt: number
  ): void {
    const existing = this.get(id);
    if (!existing) throw new DriveConfigNotFoundError(id);
    const prev = existing.effectiveness;
    const ewma =
      prev.samples === 0 ? newScore : alpha * newScore + (1 - alpha) * prev.ewma;
    const updated: EffectivenessStats = {
      samples: prev.samples + 1,
      ewma,
      lastFired: firedAt,
    };
    this.db
      .prepare<[string, number, string]>(
        `UPDATE memory_drive_configs SET effectiveness_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(JSON.stringify(updated), Date.now(), id);
  }
}
