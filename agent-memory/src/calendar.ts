/**
 * CalendarStore: future event anchors
 *
 * - One-time events: rrule = NULL; starts_at / ends_at stored directly
 * - Recurring events: rrule = iCalendar-style string (MVP supports FREQ=DAILY / WEEKLY + INTERVAL / COUNT / UNTIL)
 *
 * External sync (Google/Outlook) deduplicates via the external_ref field.
 *
 * Note: IANA timezone field is required, used for semantic display; stored starts_at/ends_at are epoch ms (UTC).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CalendarEvent, CalendarEventInput } from './types.js';

interface CalendarRow {
  id: string;
  title: string;
  starts_at: number;
  ends_at: number | null;
  rrule: string | null;
  timezone: string;
  related_fact_id: string | null;
  external_ref: string | null;
  created_at: number;
}

function rowToEvent(row: CalendarRow): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    rrule: row.rrule,
    timezone: row.timezone,
    relatedFactId: row.related_fact_id,
    externalRef: row.external_ref,
    createdAt: row.created_at,
  };
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

interface ParsedRrule {
  freq: 'DAILY' | 'WEEKLY';
  interval: number;
  count: number | null;
  until: number | null;
}

/** Minimal RRULE parser — supports only FREQ, INTERVAL, COUNT, UNTIL */
function parseRrule(rrule: string): ParsedRrule | null {
  const parts = rrule.split(';').map((p) => p.trim());
  const kv = new Map<string, string>();
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    kv.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1));
  }

  const freq = kv.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return null;

  const interval = Math.max(1, Number(kv.get('INTERVAL') ?? '1'));
  const countRaw = kv.get('COUNT');
  const count = countRaw ? Math.max(1, Number(countRaw)) : null;

  const untilRaw = kv.get('UNTIL');
  let until: number | null = null;
  if (untilRaw) {
    // UNTIL may be YYYYMMDD or YYYYMMDDTHHMMSSZ
    const iso = untilRaw.length === 8
      ? `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}T23:59:59Z`
      : untilRaw.length >= 15
        ? `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}T${untilRaw.slice(9, 11)}:${untilRaw.slice(11, 13)}:${untilRaw.slice(13, 15)}Z`
        : untilRaw;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) until = ms;
  }

  return { freq, interval, count, until };
}

/**
 * Expands event occurrences within the [from, to] window according to RRULE.
 * Non-recursive naive expansion; MVP supports DAILY/WEEKLY.
 */
function expandOccurrences(
  startsAt: number,
  endsAt: number | null,
  rrule: string | null,
  from: number,
  to: number
): Array<{ startsAt: number; endsAt: number | null }> {
  if (!rrule) {
    if (startsAt >= from && startsAt <= to) return [{ startsAt, endsAt }];
    return [];
  }

  const parsed = parseRrule(rrule);
  if (!parsed) {
    // Unparseable rrule: fall back to one-time event
    if (startsAt >= from && startsAt <= to) return [{ startsAt, endsAt }];
    return [];
  }

  const stepMs = parsed.freq === 'DAILY'
    ? parsed.interval * DAY_MS
    : parsed.interval * WEEK_MS;
  const duration = endsAt !== null ? endsAt - startsAt : null;

  const results: Array<{ startsAt: number; endsAt: number | null }> = [];
  let n = 0;
  let current = startsAt;
  // Guard: stop after 10_000 expansions (a very large window + high frequency would blow up)
  const MAX = 10_000;
  while (n < MAX) {
    if (parsed.count !== null && n >= parsed.count) break;
    if (parsed.until !== null && current > parsed.until) break;
    if (current > to) break;

    if (current >= from) {
      results.push({
        startsAt: current,
        endsAt: duration !== null ? current + duration : null,
      });
    }
    n++;
    current += stepMs;
  }
  return results;
}

/** Expanded event returned by listBetween / upcoming: includes the specific occurrence timestamp */
export interface OccurrenceEvent extends CalendarEvent {
  /** Actual occurrence timestamp after expansion (may differ from base.startsAt) */
  occurrenceStartsAt: number;
  occurrenceEndsAt: number | null;
}

export class CalendarStore {
  constructor(private readonly db: Database.Database) {}

  /** Create an event */
  create(input: CalendarEventInput): CalendarEvent {
    if (!input.timezone) {
      throw new Error('CalendarEvent: timezone is required (IANA string)');
    }
    if (input.endsAt !== undefined && input.endsAt !== null && input.endsAt < input.startsAt) {
      throw new Error('CalendarEvent: ends_at cannot be earlier than starts_at');
    }
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare<[
        string, string, number, number | null, string | null, string,
        string | null, string | null, number
      ]>(
        `INSERT INTO memory_calendar
         (id, title, starts_at, ends_at, rrule, timezone, related_fact_id, external_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.startsAt,
        input.endsAt ?? null,
        input.rrule ?? null,
        input.timezone,
        input.relatedFactId ?? null,
        input.externalRef ?? null,
        createdAt
      );
    return {
      id,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      rrule: input.rrule ?? null,
      timezone: input.timezone,
      relatedFactId: input.relatedFactId ?? null,
      externalRef: input.externalRef ?? null,
      createdAt,
    };
  }

  get(id: string): CalendarEvent | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_calendar WHERE id = ? LIMIT 1`)
      .get(id) as CalendarRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /** Find by external_ref; used for external sync deduplication */
  findByExternalRef(ref: string): CalendarEvent | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_calendar WHERE external_ref = ? LIMIT 1`
      )
      .get(ref) as CalendarRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  delete(id: string): boolean {
    const r = this.db
      .prepare<[string]>(`DELETE FROM memory_calendar WHERE id = ?`)
      .run(id);
    return r.changes > 0;
  }

  /**
   * Lists all occurrences within the [from, to] window (expanding RRULE).
   * Fetches all events that could intersect (recurring ones need full candidates), then expands in JS.
   */
  listBetween(from: number, to: number): OccurrenceEvent[] {
    if (to < from) return [];
    // One-time events: starts_at must fall within the window
    // Recurring events: any event with starts_at <= to (origin before or within the window) may have occurrences that hit
    const rows = this.db
      .prepare<[number, number, number]>(
        `SELECT * FROM memory_calendar
         WHERE (rrule IS NULL AND starts_at BETWEEN ? AND ?)
            OR (rrule IS NOT NULL AND starts_at <= ?)
         ORDER BY starts_at ASC`
      )
      .all(from, to, to) as CalendarRow[];

    const results: OccurrenceEvent[] = [];
    for (const row of rows) {
      const base = rowToEvent(row);
      const occurrences = expandOccurrences(
        row.starts_at,
        row.ends_at,
        row.rrule,
        from,
        to
      );
      for (const occ of occurrences) {
        results.push({
          ...base,
          occurrenceStartsAt: occ.startsAt,
          occurrenceEndsAt: occ.endsAt,
        });
      }
    }
    results.sort((a, b) => a.occurrenceStartsAt - b.occurrenceStartsAt);
    return results;
  }

  /** Events within the next windowMs time window (default 7 days) */
  upcoming(windowMs: number = 7 * DAY_MS, from: number = Date.now()): OccurrenceEvent[] {
    return this.listBetween(from, from + windowMs);
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_calendar`)
      .get() as { n: number };
    return row.n;
  }
}
