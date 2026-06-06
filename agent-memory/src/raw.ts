/**
 * RawStore: Layer 0 raw session log
 *
 * Append-only, never deleted.
 * Uses: audit, deep-query reconstruction, offline re-extraction
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RawSession, RawMessage, RawMessageInput } from './types.js';

interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number | null;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: RawMessage['role'];
  content: string;
  timestamp: number;
}

function rowToSession(row: SessionRow): RawSession {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function rowToMessage(row: MessageRow): RawMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
  };
}

export class RawStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Start a new session; returns the session id
   */
  startSession(sessionId?: string): RawSession {
    const id = sessionId ?? randomUUID();
    const startedAt = Date.now();

    this.db
      .prepare<[string, number]>(
        `INSERT INTO memory_raw_sessions (id, started_at) VALUES (?, ?)`
      )
      .run(id, startedAt);

    return { id, startedAt, endedAt: null };
  }

  /**
   * Mark the session as ended
   */
  endSession(sessionId: string): void {
    this.db
      .prepare<[number, string]>(
        `UPDATE memory_raw_sessions SET ended_at = ? WHERE id = ?`
      )
      .run(Date.now(), sessionId);
  }

  /**
   * Append a message to the session
   */
  appendMessage(input: RawMessageInput): RawMessage {
    const timestamp = Date.now();
    const result = this.db
      .prepare<[string, string, string, number]>(
        `INSERT INTO memory_raw_messages (session_id, role, content, timestamp)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.sessionId, input.role, input.content, timestamp);

    return {
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      timestamp,
    };
  }

  /**
   * Read all messages in a session (chronological order)
   */
  getMessages(sessionId: string): RawMessage[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_raw_messages
         WHERE session_id = ?
         ORDER BY timestamp ASC, id ASC`
      )
      .all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Get session metadata
   */
  getSession(sessionId: string): RawSession | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_raw_sessions WHERE id = ? LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * List the most recent N sessions
   */
  listRecentSessions(limit = 20): RawSession[] {
    return this.listSessions({ limit });
  }

  /**
   * List sessions (optional time range / pagination); ordered by started_at descending.
   */
  listSessions(opts: {
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  } = {}): RawSession[] {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const conditions: string[] = [];
    const params: (number)[] = [];
    if (opts.since !== undefined) {
      conditions.push('started_at >= ?');
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      conditions.push('started_at <= ?');
      params.push(opts.until);
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_raw_sessions
         ${whereSql}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * v8: global timeline query — pull messages across sessions in chronological order.
   *
   * Used by the recency segment of TimelineRetriever.
   *
   * 2026-05-09: added sessionIds filter. autonomous turns (system:scheduled:*) need to restrict
   * recall to their own sessionId; otherwise conversations from wechat and other sessions get pulled in,
   * contaminating short_answer_binding / downstream LLM reasoning with cross-session content.
   * See server/src/chat-handler.ts buildFreshMessages. When sessionIds is omitted, global recall is used
   * (behavior unchanged).
   *
   * @param opts.fromTs      start time (epoch ms), null = no limit. inclusive
   * @param opts.untilTs     end time (epoch ms), null = no limit. inclusive
   * @param opts.limit       maximum number of messages to return, default 200
   * @param opts.order       'asc' = chronological, 'desc' = reverse (default desc for "get latest")
   * @param opts.sessionIds  restrict to these sessionIds (IN multi-value); empty array is equivalent to omitting
   */
  queryTimeline(opts: {
    fromTs?: number | null;
    untilTs?: number | null;
    limit?: number;
    order?: 'asc' | 'desc';
    sessionIds?: string[];
  } = {}): RawMessage[] {
    const limit = opts.limit ?? 200;
    const order = opts.order ?? 'desc';
    const conds: string[] = [];
    const params: (number | string)[] = [];
    if (opts.fromTs != null) {
      conds.push('timestamp >= ?');
      params.push(opts.fromTs);
    }
    if (opts.untilTs != null) {
      conds.push('timestamp <= ?');
      params.push(opts.untilTs);
    }
    if (opts.sessionIds && opts.sessionIds.length > 0) {
      const ph = opts.sessionIds.map(() => '?').join(',');
      conds.push(`session_id IN (${ph})`);
      params.push(...opts.sessionIds);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const dir = order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_raw_messages
         ${where}
         ORDER BY timestamp ${dir}, id ${dir}
         LIMIT ?`
      )
      .all(...params, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * K7.2: return the most recent message for a given role (ordered by timestamp descending).
   *
   * Used for the service_dormancy signal: getting the most recent `role='assistant'` = "last time the agent truly served the user".
   * Returns null if not found. Performance: uses the timestamp DESC index, O(log n).
   */
  getLastMessageByRole(role: RawMessage['role']): RawMessage | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_raw_messages
         WHERE role = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT 1`
      )
      .get(role) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  /**
   * Full-text search of historical message content.
   *
   * Strategy matches SkillStore: FTS5 trigram as primary path, falls back to LIKE on failure or no results.
   * Results ordered by timestamp descending; can filter by session / time window.
   *
   * 2026-05-09: added sessionIds (multi-value) filter, same semantics as queryTimeline. The original
   * sessionId single-value parameter is kept for compatibility; when both are provided, sessionIds takes
   * priority (if non-empty).
   */
  searchMessages(
    query: string,
    opts: {
      since?: number;
      until?: number;
      sessionId?: string;
      sessionIds?: string[];
      limit?: number;
    } = {}
  ): RawMessage[] {
    const safe = query.replace(/['"*()]/g, ' ').trim();
    if (!safe) return [];
    const limit = opts.limit ?? 20;

    const extraConds: string[] = [];
    const extraParams: (number | string)[] = [];
    if (opts.since !== undefined) {
      extraConds.push('m.timestamp >= ?');
      extraParams.push(opts.since);
    }
    if (opts.until !== undefined) {
      extraConds.push('m.timestamp <= ?');
      extraParams.push(opts.until);
    }
    // sessionIds multi-value takes priority (autonomous turn path); otherwise fall back to sessionId single value.
    const ids = opts.sessionIds && opts.sessionIds.length > 0
      ? opts.sessionIds
      : (opts.sessionId !== undefined ? [opts.sessionId] : undefined);
    if (ids) {
      const ph = ids.map(() => '?').join(',');
      extraConds.push(`m.session_id IN (${ph})`);
      extraParams.push(...ids);
    }
    const extraSql = extraConds.length ? ` AND ${extraConds.join(' AND ')}` : '';

    let rows: MessageRow[] = [];
    if (safe.length >= 3) {
      try {
        rows = this.db
          .prepare(
            `SELECT m.* FROM memory_raw_messages m
             JOIN memory_raw_messages_fts fts ON fts.rowid = m.rowid
             WHERE memory_raw_messages_fts MATCH ?
             ${extraSql}
             ORDER BY m.timestamp DESC
             LIMIT ?`
          )
          .all(safe, ...extraParams, limit) as MessageRow[];
      } catch {
        rows = [];
      }
    }

    if (rows.length === 0) {
      const pattern = `%${safe}%`;
      rows = this.db
        .prepare(
          `SELECT m.* FROM memory_raw_messages m
           WHERE m.content LIKE ?
           ${extraSql}
           ORDER BY m.timestamp DESC
           LIMIT ?`
        )
        .all(pattern, ...extraParams, limit) as MessageRow[];
    }

    return rows.map(rowToMessage);
  }
}
