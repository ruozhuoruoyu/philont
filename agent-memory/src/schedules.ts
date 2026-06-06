/**
 * ScheduleStore: scheduled tasks table
 *
 * One-time tasks (cron_expr = null): enabled set to false after fire
 * Recurring tasks (cron_expr non-empty, MVP only supports "interval:<ms>"): next_run_at auto-advanced after fire
 *
 * action_type:
 *   - 'prompt'    → inject a system notification into the active session
 *   - 'tool_call' → execute tool through PolicyGate (caller's responsibility)
 *   - 'reflect'   → trigger SessionReflector incremental reflection
 *
 * This Store only manages storage and scheduling metadata; execution is done by scheduler.ts emitting events, consumers dispatch based on action_type.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Schedule, ScheduleInput, ScheduleActionType } from './types.js';

interface ScheduleRow {
  id: string;
  name: string;
  cron_expr: string | null;
  next_run_at: number;
  last_run_at: number | null;
  action_type: string;
  payload_json: string;
  enabled: number;
  created_at: number;
  created_by: string | null;
  consecutive_failures: number | null;
  paused_until: number | null;
  /** v23 (Phase 13.5): project association, NULL = non-project-level */
  project: string | null;
}

/** schedule auto-circuit-breaker default parameters (v16) */
export const SCHEDULE_FAILURE_THRESHOLD = 3;
export const SCHEDULE_PAUSE_MS = 60 * 60 * 1000; // 1 hour

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    cronExpr: row.cron_expr,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    actionType: row.action_type as ScheduleActionType,
    payload: JSON.parse(row.payload_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    createdBy: row.created_by ?? 'llm_external',
    consecutiveFailures: row.consecutive_failures ?? 0,
    pausedUntil: row.paused_until ?? null,
    project: row.project ?? null,
  };
}

/** Parse cron_expr → increment (ms) to advance next_run_at. MVP only supports interval:<ms> */
export function computeNextRun(cronExpr: string | null, lastRun: number): number | null {
  if (!cronExpr) return null;
  const m = cronExpr.match(/^interval:(\d+)$/);
  if (m) {
    const intervalMs = Number(m[1]);
    if (intervalMs > 0) return lastRun + intervalMs;
  }
  return null;
}

export class ScheduleStore {
  constructor(private readonly db: Database.Database) {}

  create(input: ScheduleInput): Schedule {
    if (!['prompt', 'tool_call', 'reflect', 'autonomous_turn'].includes(input.actionType)) {
      throw new Error(`Schedule: 未知 action_type ${input.actionType}`);
    }
    if (input.cronExpr) {
      // Validate that cron_expr is parseable
      if (computeNextRun(input.cronExpr, 0) === null) {
        throw new Error(`Schedule: 无法解析 cron_expr '${input.cronExpr}'`);
      }
    }
    const id = randomUUID();
    const createdAt = Date.now();
    const enabled = input.enabled !== false;
    const createdBy = input.createdBy ?? 'llm_external';
    const project = input.project ?? null;
    this.db
      .prepare<[
        string, string, string | null, number, string, string, number, number, string, string | null
      ]>(
        `INSERT INTO memory_schedules
         (id, name, cron_expr, next_run_at, action_type, payload_json, enabled, created_at, created_by, project)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.cronExpr ?? null,
        input.nextRunAt,
        input.actionType,
        JSON.stringify(input.payload),
        enabled ? 1 : 0,
        createdAt,
        createdBy,
        project
      );
    return {
      id,
      name: input.name,
      cronExpr: input.cronExpr ?? null,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      actionType: input.actionType,
      payload: input.payload,
      enabled,
      createdAt,
      createdBy,
      consecutiveFailures: 0,
      pausedUntil: null,
      project,
    };
  }

  /**
   * v23 (Phase 13.5): set the schedule's project association. Called as mechanism-layer fallback,
   * auto-fills when LLM calls schedule_reminder without project but the current session has an active plan.
   */
  setProject(id: string, project: string | null): Schedule | null {
    this.db
      .prepare<[string | null, string]>(
        `UPDATE memory_schedules SET project = ? WHERE id = ?`,
      )
      .run(project, id);
    return this.get(id);
  }

  /**
   * v23 (Phase 13.5): find the most recently enabled schedule by name.
   * Scheduled session sessionId is in the form `system:scheduled:<name>`; chat-handler uses this
   * to reverse-lookup schedule.project for injecting plan.md.
   */
  findByName(name: string): Schedule | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_schedules WHERE name = ? AND enabled = 1
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(name) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  get(id: string): Schedule | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_schedules WHERE id = ? LIMIT 1`)
      .get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  list(opts: { enabledOnly?: boolean } = {}): Schedule[] {
    const sql = opts.enabledOnly
      ? `SELECT * FROM memory_schedules WHERE enabled = 1 ORDER BY next_run_at ASC`
      : `SELECT * FROM memory_schedules ORDER BY next_run_at ASC`;
    const rows = this.db.prepare(sql).all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  /**
   * Return all tasks that are enabled, have next_run_at <= now, and are not in a pause period.
   *
   * v16: paused_until IS NULL (old row / never failed) **or** paused_until <= now
   * (pause expired) → participates in scheduling. Schedules in a pause period (paused_until > now) are skipped.
   */
  dueBefore(now: number): Schedule[] {
    const rows = this.db
      .prepare<[number, number]>(
        `SELECT * FROM memory_schedules
         WHERE enabled = 1 AND next_run_at <= ?
         AND (paused_until IS NULL OR paused_until <= ?)
         ORDER BY next_run_at ASC`
      )
      .all(now, now) as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  /**
   * One task execution completed.
   * One-time task → enabled=0; recurring task → advance next_run_at (also set to not enabled if cannot advance).
   */
  markRun(id: string, at: number): Schedule | null {
    const current = this.get(id);
    if (!current) return null;

    const next = computeNextRun(current.cronExpr, at);
    if (next === null) {
      // One-time or unparseable: disable
      this.db
        .prepare<[number, string]>(
          `UPDATE memory_schedules
           SET last_run_at = ?, enabled = 0
           WHERE id = ?`
        )
        .run(at, id);
    } else {
      this.db
        .prepare<[number, number, string]>(
          `UPDATE memory_schedules
           SET last_run_at = ?, next_run_at = ?
           WHERE id = ?`
        )
        .run(at, next, id);
    }
    return this.get(id);
  }

  /**
   * Called when autonomous_turn fails: increments consecutive_failures, writes paused_until when threshold reached.
   *
   * Returns the updated Schedule (including possibly newly written paused_until).
   * Threshold / pause duration are overridable, defaults SCHEDULE_FAILURE_THRESHOLD=3 / SCHEDULE_PAUSE_MS=1h.
   *
   * Caller should log/audit "schedule paused" when threshold is crossed (this method only writes to DB, no logging).
   * Compare whether newPausedUntil was newly written (returns schedule.pausedUntil > before)
   * to determine whether a pause was triggered this time.
   */
  recordFailure(
    id: string,
    at: number,
    opts: { threshold?: number; pauseMs?: number } = {},
  ): Schedule | null {
    const threshold = opts.threshold ?? SCHEDULE_FAILURE_THRESHOLD;
    const pauseMs = opts.pauseMs ?? SCHEDULE_PAUSE_MS;
    const current = this.get(id);
    if (!current) return null;
    const nextCount = current.consecutiveFailures + 1;
    const nextPausedUntil = nextCount >= threshold ? at + pauseMs : current.pausedUntil;
    this.db
      .prepare<[number, number | null, string]>(
        `UPDATE memory_schedules
         SET consecutive_failures = ?, paused_until = ?
         WHERE id = ?`,
      )
      .run(nextCount, nextPausedUntil, id);
    return this.get(id);
  }

  /**
   * Called when autonomous_turn succeeds: resets consecutive_failures to 0 and clears paused_until.
   * Idempotent (no change when already 0 / NULL).
   */
  recordSuccess(id: string): Schedule | null {
    this.db
      .prepare<[string]>(
        `UPDATE memory_schedules
         SET consecutive_failures = 0, paused_until = NULL
         WHERE id = ?`,
      )
      .run(id);
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const r = this.db
      .prepare<[number, string]>(
        `UPDATE memory_schedules SET enabled = ? WHERE id = ?`
      )
      .run(enabled ? 1 : 0, id);
    return r.changes > 0;
  }

  delete(id: string): boolean {
    const r = this.db
      .prepare<[string]>(`DELETE FROM memory_schedules WHERE id = ?`)
      .run(id);
    return r.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_schedules`)
      .get() as { n: number };
    return row.n;
  }
}
