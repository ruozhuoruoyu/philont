/**
 * ActionLog: Layer 0.5 tool call history
 *
 * Stores each tool call's (trigger, tool, params, result, success),
 * so SessionReflector can analyze at session end and extract reusable patterns.
 */

import type Database from 'better-sqlite3';
import type { Action, ActionInput } from './types.js';

interface ActionRow {
  id: number;
  session_id: string;
  trigger: string | null;
  tool_name: string;
  params_json: string;
  result: string | null;
  success: number;
  timestamp: number;
  linked_skill: string | null;
}

function rowToAction(row: ActionRow): Action {
  return {
    id: row.id,
    sessionId: row.session_id,
    trigger: row.trigger,
    toolName: row.tool_name,
    params: JSON.parse(row.params_json),
    result: row.result,
    success: row.success === 1,
    timestamp: row.timestamp,
    linkedSkill: row.linked_skill,
  };
}

export class ActionLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record a single tool call
   */
  log(input: ActionInput): Action {
    const timestamp = Date.now();
    const linkedSkill = input.linkedSkill ?? null;
    const result = this.db
      .prepare<[string, string | null, string, string, string | null, number, number, string | null]>(
        `INSERT INTO memory_actions
         (session_id, trigger, tool_name, params_json, result, success, timestamp, linked_skill)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.trigger ?? null,
        input.toolName,
        JSON.stringify(input.params),
        input.result ?? null,
        input.success ? 1 : 0,
        timestamp,
        linkedSkill,
      );

    return {
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      trigger: input.trigger ?? null,
      toolName: input.toolName,
      params: input.params,
      result: input.result ?? null,
      success: input.success,
      timestamp,
      linkedSkill,
    };
  }

  /**
   * List all actions in a session (chronological order)
   */
  getBySession(sessionId: string): Action[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_actions
         WHERE session_id = ?
         ORDER BY timestamp ASC, id ASC`
      )
      .all(sessionId) as ActionRow[];
    return rows.map(rowToAction);
  }

  /**
   * K0: list actions by time range (cross-session, global timeline).
   * @param fromTs inclusive
   * @param toTs   inclusive
   */
  getByRange(fromTs: number, toTs: number): Action[] {
    const rows = this.db
      .prepare<[number, number]>(
        `SELECT * FROM memory_actions
         WHERE timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC, id ASC`,
      )
      .all(fromTs, toTs) as ActionRow[];
    return rows.map(rowToAction);
  }

  /**
   * Count historical usage by tool name
   */
  countByTool(toolName: string): number {
    const row = this.db
      .prepare<[string]>(
        `SELECT COUNT(*) as n FROM memory_actions WHERE tool_name = ?`
      )
      .get(toolName) as { n: number };
    return row.n;
  }

  /** Total action count */
  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_actions`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * List the most recent N failed actions (success=0), ordered by timestamp DESC.
   *
   * Serves the reflection trigger's sameRootCauseFailures calculation: optional time window
   * sinceTs (default none) + count limit (default 30) + optional sessionId filter
   * (Phase 11, 2026-05-14: for cross-turn-reflection — when the same root-cause failure
   * occurs >= N times within the same session across turns, the mechanism layer intervenes,
   * see chat-handler turn start).
   *
   * Default is cross-session — global timeline perspective, consistent with K0 design.
   */
  listRecentFailures(opts: {
    sinceTs?: number;
    limit?: number;
    sessionId?: string;
  } = {}): Action[] {
    const limit = opts.limit ?? 30;
    const conds: string[] = ['success = 0'];
    const params: unknown[] = [];
    if (opts.sinceTs != null) {
      conds.push('timestamp >= ?');
      params.push(opts.sinceTs);
    }
    if (opts.sessionId) {
      conds.push('session_id = ?');
      params.push(opts.sessionId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_actions
         WHERE ${conds.join(' AND ')}
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as ActionRow[];
    return rows.map(rowToAction);
  }
}
