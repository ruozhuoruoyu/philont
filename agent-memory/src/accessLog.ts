/**
 * AccessLog: memory read trace table
 *
 * Records one entry each time getFact / listFacts / searchNotes / useSkill accesses a memory item.
 * Uses:
 *   1. LRU decay: updates the corresponding row's last_accessed_at
 *   2. Real value estimation: "referenced 20 times in the last 30 days" is more informative than confidence alone
 *
 * Write timing is determined by the caller (MemoryStore.markAccessed calls this uniformly).
 */

import type Database from 'better-sqlite3';
import type { AccessLogEntry, AccessLogInput, AccessTargetType } from './types.js';

interface AccessLogRow {
  id: number;
  target_type: string;
  target_id: string;
  accessed_at: number;
  context: string | null;
}

function rowToEntry(row: AccessLogRow): AccessLogEntry {
  return {
    id: row.id,
    targetType: row.target_type as AccessTargetType,
    targetId: row.target_id,
    accessedAt: row.accessed_at,
    context: row.context,
  };
}

export class AccessLog {
  constructor(private readonly db: Database.Database) {}

  /** Record one access entry */
  record(input: AccessLogInput, at: number = Date.now()): AccessLogEntry {
    const result = this.db
      .prepare<[string, string, number, string | null]>(
        `INSERT INTO memory_access_log (target_type, target_id, accessed_at, context)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.targetType, input.targetId, at, input.context ?? null);

    return {
      id: Number(result.lastInsertRowid),
      targetType: input.targetType,
      targetId: input.targetId,
      accessedAt: at,
      context: input.context ?? null,
    };
  }

  /** Total access count for an object */
  countFor(targetType: AccessTargetType, targetId: string): number {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT COUNT(*) as n FROM memory_access_log
         WHERE target_type = ? AND target_id = ?`
      )
      .get(targetType, targetId) as { n: number };
    return row.n;
  }

  /** Most recent N accesses for an object */
  recentFor(
    targetType: AccessTargetType,
    targetId: string,
    limit = 20
  ): AccessLogEntry[] {
    const rows = this.db
      .prepare<[string, string, number]>(
        `SELECT * FROM memory_access_log
         WHERE target_type = ? AND target_id = ?
         ORDER BY accessed_at DESC
         LIMIT ?`
      )
      .all(targetType, targetId, limit) as AccessLogRow[];
    return rows.map(rowToEntry);
  }

  /** Total entry count (for monitoring) */
  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_access_log`)
      .get() as { n: number };
    return row.n;
  }
}
