/**
 * DriveOutcomeStore: append-only persistence for each drive firing (added in v7)
 *
 * Closed-loop core: drive fires → kernel records outcome (without effectiveness) → after N rounds
 * SessionReflector back-fills effectiveness_score → DriveConfigStore.updateEffectiveness.
 *
 * Design invariant: this table is append-only — no updates, no deletes. Outcomes from timed-out or
 * retired drives are retained; they are the audit basis for the agent's evolution history.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DriveOutcome, DriveOutcomeInput } from './types.js';

interface DriveOutcomeRow {
  id: string;
  drive_id: string;
  fired_at: number;
  trigger_snapshot_json: string;
  injected_action_json: string;
  subsequent_tool_calls_json: string;
  memory_delta_json: string;
  served_pursuit_id: string | null;
  effectiveness_score: number | null;
  root_pursuit_id: string;
}

function rowToOutcome(row: DriveOutcomeRow): DriveOutcome {
  return {
    id: row.id,
    driveId: row.drive_id,
    firedAt: row.fired_at,
    triggerSnapshot: JSON.parse(row.trigger_snapshot_json),
    injectedAction: JSON.parse(row.injected_action_json),
    subsequentToolCalls: JSON.parse(row.subsequent_tool_calls_json) as unknown[],
    memoryDelta: JSON.parse(row.memory_delta_json) as DriveOutcome['memoryDelta'],
    servedPursuitId: row.served_pursuit_id,
    effectivenessScore: row.effectiveness_score,
    rootPursuitId: row.root_pursuit_id,
  };
}

export class DriveOutcomeStore {
  constructor(private readonly db: Database.Database) {}

  append(input: DriveOutcomeInput): DriveOutcome {
    const id = input.id ?? randomUUID();
    const firedAt = input.firedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO memory_drive_outcomes
         (id, drive_id, fired_at, trigger_snapshot_json, injected_action_json,
          subsequent_tool_calls_json, memory_delta_json,
          served_pursuit_id, effectiveness_score, root_pursuit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        id,
        input.driveId,
        firedAt,
        JSON.stringify(input.triggerSnapshot),
        JSON.stringify(input.injectedAction),
        JSON.stringify(input.subsequentToolCalls ?? []),
        JSON.stringify(input.memoryDelta ?? {}),
        input.servedPursuitId ?? null,
        input.rootPursuitId
      );
    return this.get(id)!;
  }

  get(id: string): DriveOutcome | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_drive_outcomes WHERE id = ? LIMIT 1`)
      .get(id) as DriveOutcomeRow | undefined;
    return row ? rowToOutcome(row) : null;
  }

  /**
   * Reflector back-fills the effectiveness score. This is an exception to the append-only principle:
   * the effectiveness_score column was intentionally designed as NULL-able for delayed back-fill;
   * this does not violate "do not rewrite facts" — what is being modified is a "post-hoc rating",
   * not a "historical fact".
   */
  setEffectivenessScore(id: string, score: number): void {
    if (score < -1 || score > 1) {
      throw new Error(`effectiveness score ${score} out of bounds [-1, 1]`);
    }
    this.db
      .prepare<[number, string]>(
        `UPDATE memory_drive_outcomes SET effectiveness_score = ? WHERE id = ?`
      )
      .run(score, id);
  }

  /** Appends/replaces downstream tool call summaries (accumulated within N rounds after the drive fires) */
  appendSubsequentToolCalls(id: string, calls: unknown[]): void {
    const existing = this.get(id);
    if (!existing) return;
    const merged = [...existing.subsequentToolCalls, ...calls];
    this.db
      .prepare<[string, string]>(
        `UPDATE memory_drive_outcomes SET subsequent_tool_calls_json = ? WHERE id = ?`
      )
      .run(JSON.stringify(merged), id);
  }

  /** Appends memory delta (fact/note/progress ids added within N rounds after the drive fires) */
  mergeMemoryDelta(id: string, delta: DriveOutcome['memoryDelta']): void {
    const existing = this.get(id);
    if (!existing) return;
    const merged: DriveOutcome['memoryDelta'] = {
      factIds: [
        ...(existing.memoryDelta.factIds ?? []),
        ...(delta.factIds ?? []),
      ],
      noteIds: [
        ...(existing.memoryDelta.noteIds ?? []),
        ...(delta.noteIds ?? []),
      ],
      pursuitProgressMarkers: [
        ...(existing.memoryDelta.pursuitProgressMarkers ?? []),
        ...(delta.pursuitProgressMarkers ?? []),
      ],
    };
    this.db
      .prepare<[string, string]>(
        `UPDATE memory_drive_outcomes SET memory_delta_json = ? WHERE id = ?`
      )
      .run(JSON.stringify(merged), id);
  }

  /**
   * Fetches the most recent N entries by drive_id, ordered by fired_at DESC by default.
   * Used by Reflector to aggregate effectiveness.
   */
  listByDrive(driveId: string, limit = 50): DriveOutcome[] {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_drive_outcomes
         WHERE drive_id = ?
         ORDER BY fired_at DESC
         LIMIT ?`
      )
      .all(driveId, limit) as DriveOutcomeRow[];
    return rows.map(rowToOutcome);
  }

  /** Reflector scan: list outcomes where effectiveness_score is still NULL (pending back-fill) */
  listUnscored(rootId: string, limit = 100): DriveOutcome[] {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_drive_outcomes
         WHERE root_pursuit_id = ? AND effectiveness_score IS NULL
         ORDER BY fired_at ASC
         LIMIT ?`
      )
      .all(rootId, limit) as DriveOutcomeRow[];
    return rows.map(rowToOutcome);
  }

  /** Fetch outcomes associated with a pursuit (used for effectiveness attribution) */
  listByPursuit(pursuitId: string, limit = 100): DriveOutcome[] {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_drive_outcomes
         WHERE served_pursuit_id = ?
         ORDER BY fired_at DESC
         LIMIT ?`
      )
      .all(pursuitId, limit) as DriveOutcomeRow[];
    return rows.map(rowToOutcome);
  }
}
