/**
 * NotesStore: Layer 1 text fallback storage
 *
 * Purpose: store contextual information that cannot be structured
 * Query: FTS5 full-text search (simple version; embedding deferred to Phase 2)
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Note, NoteInput } from './types.js';

interface NoteRow {
  id: string;
  content: string;
  importance: number;
  session_id: string | null;
  created_at: number;
  last_accessed_at: number | null;
  forgotten_at: number | null;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    content: row.content,
    importance: row.importance,
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    forgottenAt: row.forgotten_at,
  };
}

export class NotesStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Store a note
   */
  storeNote(input: NoteInput): Note {
    const id = randomUUID();
    const createdAt = Date.now();
    const importance = input.importance ?? 0.5;
    const sessionId = input.sessionId ?? null;

    this.db
      .prepare<[string, string, number, string | null, number]>(
        `INSERT INTO memory_notes (id, content, importance, session_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, input.content, importance, sessionId, createdAt);

    return {
      id,
      content: input.content,
      importance,
      sessionId,
      createdAt,
      lastAccessedAt: null,
      forgottenAt: null,
    };
  }

  /**
   * Full-text search
   *
   * Strategy:
   *   - Primary path: FTS5 trigram search (requires query length >= 3)
   *   - Fallback: LIKE substring match (for short queries and FTS5 misses)
   *
   * @param query Search term
   * @param limit Maximum results to return
   */
  search(query: string, limit = 5): Note[] {
    // Simple sanitize: remove FTS5 special characters to avoid syntax errors
    const safe = query.replace(/['"*()]/g, ' ').trim();
    if (!safe) return [];

    // Primary path: FTS5 (only used when length >= 3, trigram constraint)
    if (safe.length >= 3) {
      const rows = this.db
        .prepare<[string, number]>(
          `SELECT n.* FROM memory_notes n
           JOIN memory_notes_fts fts ON fts.rowid = n.rowid
           WHERE memory_notes_fts MATCH ?
           ORDER BY n.importance DESC, n.created_at DESC
           LIMIT ?`
        )
        .all(safe, limit) as NoteRow[];

      if (rows.length > 0) return rows.map(rowToNote);
    }

    // Fallback: LIKE substring match
    const likePattern = `%${safe}%`;
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_notes
         WHERE content LIKE ?
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`
      )
      .all(likePattern, limit) as NoteRow[];

    return rows.map(rowToNote);
  }

  /**
   * Read a note by id
   */
  getNoteById(id: string): Note | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_notes WHERE id = ? LIMIT 1`)
      .get(id) as NoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  /**
   * Upsert a note with a fixed id (used by the compactor for session-level summaries).
   * If it already exists, overwrite content/importance/sessionId; otherwise insert.
   */
  upsertNote(
    id: string,
    input: Pick<NoteInput, 'content' | 'importance' | 'sessionId'>
  ): Note {
    const now = Date.now();
    const importance = input.importance ?? 0.5;
    const sessionId = input.sessionId ?? null;
    const existing = this.getNoteById(id);

    if (existing) {
      this.db
        .prepare<[string, number, string | null, string]>(
          `UPDATE memory_notes
           SET content = ?, importance = ?, session_id = ?
           WHERE id = ?`
        )
        .run(input.content, importance, sessionId, id);
    } else {
      this.db
        .prepare<[string, string, number, string | null, number]>(
          `INSERT INTO memory_notes (id, content, importance, session_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, input.content, importance, sessionId, now);
    }

    return {
      id,
      content: input.content,
      importance,
      sessionId,
      createdAt: existing ? existing.createdAt : now,
      lastAccessedAt: existing ? existing.lastAccessedAt : null,
      forgottenAt: existing ? existing.forgottenAt : null,
    };
  }

  /**
   * Retrieve the most recent session-summary note excluding the current session (for cross-session continuation).
   * Returns null if no summary has been run before.
   */
  getLatestSessionSummary(excludeSessionId: string): Note | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_notes
         WHERE id LIKE 'session-summary-%'
           AND (session_id IS NULL OR session_id != ?)
           AND forgotten_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(excludeSessionId) as NoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  /**
   * List the top N most important notes
   */
  listTopImportant(limit = 10): Note[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_notes
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`
      )
      .all(limit) as NoteRow[];
    return rows.map(rowToNote);
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_notes`)
      .get() as { n: number };
    return row.n;
  }
}
