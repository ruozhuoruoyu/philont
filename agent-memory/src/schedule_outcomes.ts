/**
 * ScheduleOutcomeStore (v21, 2026-05-17): run trace for multiple fires of the same schedule.
 *
 * Design motivation
 * ────────
 * routing_rules / skills are "general task-level" memory: LLM self-evaluates had_lesson → distills →
 * next relevant task hits → injected into prefix. The chain is long + fragile (in practice reflection JSON parse
 * failures / had_lesson=false skips).
 *
 * For high-frequency repeat scenarios like heartbeat, what's needed is not abstract patterns but **direct historical
 * trace**: how this schedule ran last time / which endpoints failed. This module automates this at the mechanism layer:
 *
 *   1. scheduled turn ends → chat-handler calls store.record() to write 1 row (no LLM involvement)
 *   2. scheduled turn starts → buildMemoryPrefix calls store.recent() to render top section
 *      (LLM must see this, unlike routing rules buried in the middle of a 7000-char prefix)
 *
 * Does not conflict with existing mechanisms — routing_rules / skills continue distilling abstract patterns;
 * this table is the schedule's "specific historical memory", complementary granularity.
 *
 * schedule_id convention
 * ─────────────────
 * Takes the sessionId suffix: `system:scheduled:mycox-checkin` → `mycox-checkin`.
 * Non-scheduled sessions should not write to this table (record() caller must pass schedule-scoped id).
 */

import type Database from 'better-sqlite3';

export type ScheduleOutcomeKind = 'ok' | 'partial' | 'failed';

export interface ScheduleOutcomeInput {
  scheduleId: string;
  firedAt: number;
  durationMs: number;
  outcome: ScheduleOutcomeKind;
  httpOkCount: number;
  httpFailCount: number;
  httpStatusCounts: Record<string, number>;
  failureSignatures: string[];
  textSummary: string;
}

export interface ScheduleOutcome extends ScheduleOutcomeInput {
  id: string;
  createdAt: number;
}

interface ScheduleOutcomeRow {
  id: string;
  schedule_id: string;
  fired_at: number;
  duration_ms: number;
  outcome: ScheduleOutcomeKind;
  http_ok_count: number;
  http_fail_count: number;
  http_status_json: string;
  failure_signatures: string;
  text_summary: string;
  created_at: number;
}

function rowToOutcome(row: ScheduleOutcomeRow): ScheduleOutcome {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    firedAt: row.fired_at,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    httpOkCount: row.http_ok_count,
    httpFailCount: row.http_fail_count,
    httpStatusCounts: safeJSON<Record<string, number>>(row.http_status_json, {}),
    failureSignatures: safeJSON<string[]>(row.failure_signatures, []),
    textSummary: row.text_summary,
    createdAt: row.created_at,
  };
}

function safeJSON<T>(s: string, fallback: T): T {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/**
 * Extract schedule id from sessionId.
 * Convention: scheduled session id is in the form `system:scheduled:<name>`, returns <name>.
 * Returns null if no match; caller decides whether to record (ordinary user sessions should not record).
 */
export function extractScheduleIdFromSession(sessionId: string): string | null {
  const prefix = 'system:scheduled:';
  if (!sessionId.startsWith(prefix)) return null;
  const rest = sessionId.slice(prefix.length);
  if (rest.length === 0) return null;
  return rest;
}

export class ScheduleOutcomeStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Write one outcome row. chat-handler calls this at the end of a scheduled turn.
   * id auto-generated (equivalent to crypto.randomUUID), createdAt = now.
   */
  record(input: ScheduleOutcomeInput): ScheduleOutcome {
    const id = randomId();
    const createdAt = Date.now();
    this.db
      .prepare<
        [
          string,
          string,
          number,
          number,
          ScheduleOutcomeKind,
          number,
          number,
          string,
          string,
          string,
          number,
        ]
      >(
        `INSERT INTO schedule_outcomes
         (id, schedule_id, fired_at, duration_ms, outcome,
          http_ok_count, http_fail_count, http_status_json,
          failure_signatures, text_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scheduleId,
        input.firedAt,
        input.durationMs,
        input.outcome,
        input.httpOkCount,
        input.httpFailCount,
        JSON.stringify(input.httpStatusCounts),
        JSON.stringify(input.failureSignatures),
        input.textSummary,
        createdAt,
      );
    return { ...input, id, createdAt };
  }

  /**
   * Query the most recent N outcomes for this schedule, newest first.
   * buildMemoryPrefix calls this at the start of a scheduled turn to render the historical trace section.
   */
  recent(scheduleId: string, limit: number = 5): ScheduleOutcome[] {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM schedule_outcomes
         WHERE schedule_id = ?
         ORDER BY fired_at DESC
         LIMIT ?`,
      )
      .all(scheduleId, Math.max(1, limit)) as ScheduleOutcomeRow[];
    return rows.map(rowToOutcome);
  }

  /** Delete all outcomes for a schedule (called during tests / when schedule is deleted). Returns number of deletions. */
  deleteBySchedule(scheduleId: string): number {
    const r = this.db
      .prepare<[string]>(`DELETE FROM schedule_outcomes WHERE schedule_id = ?`)
      .run(scheduleId);
    return r.changes;
  }

  /** List schedule ids that have recorded outcomes (deduplicated). For dashboard / debugging. */
  listScheduleIds(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT schedule_id FROM schedule_outcomes`)
      .all() as Array<{ schedule_id: string }>;
    return rows.map((r) => r.schedule_id);
  }
}

function randomId(): string {
  // Consistent with plans.ts and other stores: no crypto dependency, use timestamp + random base36
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Summary generation helpers ─────────────────────────────────────────────────────

export interface ToolCallTrace {
  toolName: string;
  success: boolean;
  /** http tool specific: HTTP status code + method together (e.g. 'GET 200', 'POST 404') */
  httpStatus?: number;
  httpMethod?: string;
  httpUrl?: string;
  /** On failure: errorClass (extracted by extractFailureSignature); empty on ok */
  errorSignature?: string;
}

/**
 * Aggregate a turn's toolResults into ScheduleOutcomeInput (scheduleId / firedAt /
 * durationMs are filled in by caller).
 *
 * Design: do not extract http url for 200 OK (privacy / noise), only extract failure signatures + status codes + success count.
 */
export function summarizeTurnTrace(traces: ToolCallTrace[]): {
  httpOkCount: number;
  httpFailCount: number;
  httpStatusCounts: Record<string, number>;
  failureSignatures: string[];
  textSummary: string;
  outcome: ScheduleOutcomeKind;
} {
  let httpOk = 0;
  let httpFail = 0;
  const statusCounts: Record<string, number> = {};
  const sigSet = new Set<string>();
  const failedHttpDetails: Array<{
    method: string;
    status: number;
    urlPattern: string;
  }> = [];

  for (const t of traces) {
    if (t.toolName !== 'http') continue;
    if (t.success) {
      httpOk++;
      if (t.httpStatus !== undefined) {
        const k = String(t.httpStatus);
        statusCounts[k] = (statusCounts[k] ?? 0) + 1;
      }
    } else {
      httpFail++;
      if (t.httpStatus !== undefined) {
        const k = String(t.httpStatus);
        statusCounts[k] = (statusCounts[k] ?? 0) + 1;
        // url pattern simplification: take path portion, replace hex / uuid segments with :id
        const pattern = t.httpUrl ? simplifyUrlPattern(t.httpUrl) : '?';
        failedHttpDetails.push({
          method: t.httpMethod ?? '?',
          status: t.httpStatus,
          urlPattern: pattern,
        });
      }
      if (t.errorSignature) sigSet.add(t.errorSignature);
    }
  }

  // outcome three-tier determination
  let outcome: ScheduleOutcomeKind = 'ok';
  if (httpFail > 0 && httpOk === 0) outcome = 'failed';
  else if (httpFail > 0) outcome = 'partial';

  // text_summary: 1-3 lines, key signals for LLM
  const lines: string[] = [];
  if (httpOk > 0) lines.push(`http ${httpOk}✓`);
  if (httpFail > 0) {
    // list first 3 distinct failures (method, status, pattern)
    const seen = new Set<string>();
    const distinct: typeof failedHttpDetails = [];
    for (const f of failedHttpDetails) {
      const k = `${f.method}|${f.status}|${f.urlPattern}`;
      if (seen.has(k)) continue;
      seen.add(k);
      distinct.push(f);
      if (distinct.length >= 3) break;
    }
    const detail = distinct
      .map((f) => `${f.method} ${f.urlPattern} → ${f.status}`)
      .join('; ');
    lines.push(`fail ${httpFail}x (${detail})`);
  }
  const textSummary = lines.length > 0 ? lines.join(' | ') : '(no http calls)';

  return {
    httpOkCount: httpOk,
    httpFailCount: httpFail,
    httpStatusCounts: statusCounts,
    failureSignatures: [...sigSet],
    textSummary,
    outcome,
  };
}

/**
 * URL → simplified pattern. Replace hex / uuid segments with :id, preserve path shape.
 * Used in trace summaries to reduce noise + help LLM see "repeatedly failing at /upvote" patterns.
 */
export function simplifyUrlPattern(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        // uuid:8-4-4-4-12 hex
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
          return ':id';
        }
        // pure hex ≥ 8 chars
        if (/^[0-9a-f]{8,}$/i.test(seg)) return ':id';
        // all digits ≥ 4
        if (/^\d{4,}$/.test(seg)) return ':id';
        return seg;
      })
      .join('/');
    return `${u.hostname}${path}`;
  } catch {
    // url parse failed → truncate to first 60 chars
    return url.length > 60 ? `${url.slice(0, 60)}…` : url;
  }
}

/**
 * Render the prefix injection section: "## Recent runs for this schedule (last N)".
 * Returns empty string for empty array (buildMemoryPrefix caller skips with if).
 */
export function renderScheduleOutcomesSection(
  outcomes: ScheduleOutcome[],
  scheduleId: string,
): string {
  if (outcomes.length === 0) return '';
  const lines: string[] = [];
  lines.push(`## Recent runs for this schedule (${scheduleId}, last ${outcomes.length})`);
  lines.push('');
  for (const o of outcomes) {
    const t = new Date(o.firedAt).toISOString().slice(11, 16); // HH:MM UTC
    const mark = o.outcome === 'ok' ? '✓' : o.outcome === 'partial' ? '◐' : '✗';
    const dur = `${Math.round(o.durationMs / 1000)}s`;
    lines.push(`- ${mark} ${t}Z (${dur}): ${o.textSummary}`);
  }
  lines.push('');
  lines.push(
    'The above is this schedule\'s **historical trace** (captured automatically by the mechanism layer, independent of reflection). ' +
      'If a failure recurs → change approach, do not retry the same URL+method.',
  );
  return lines.join('\n');
}
