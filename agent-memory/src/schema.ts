/**
 * SQLite schema: five-layer memory + time-aware extension (v3)
 *
 * Layer 0   (memory_raw_*):    raw conversation log, append-only, for auditing
 * Layer 0.5 (memory_actions):  tool call trace, reflection material
 * Layer 1   (memory_notes):    text fallback, FTS5 search
 * Layer 2   (memory_facts):    structured facts, KV + namespace + dual temporality (event/validity)
 * Layer 3   (memory_skills):   reusable action templates, reflection-generated
 *
 * Time dimension extension:
 *   - memory_calendar:     future event anchors (including RRULE periodicity)
 *   - memory_schedules:    future scheduled tasks (cron_expr / one-shot)
 *   - memory_access_log:   memory read log, for LRU decay and true value estimation
 */

import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 29;

/**
 * Canonical id for the bootstrap root pursuit. Used consistently by v7 migration and empty-DB init
 * as the default root; the redundant root_pursuit_id column of old self-domain rows is also filled
 * with this value. Users may rename the title later, but the id is permanent.
 */
export const BOOTSTRAP_ROOT_PURSUIT_ID = 'default';

/**
 * v8 global timeline session id.
 *
 * From v8 onward the raw layer no longer splits sessions by ws connection — the agent is a
 * continuous "individual" and all messages fall under this single session.
 * `memory_raw_messages.session_id` FK is still NOT NULL, so this row is kept as a placeholder.
 * Historical queries like `/api/memory/sessions` still work, and multiple session_ids in
 * old data are kept for compatibility.
 */
export const GLOBAL_TIMELINE_SESSION_ID = 'global';

// ── DDL split into two segments:
//   DDL_BASE: tables and basic indexes (no dependency on v3 new columns)
//   DDL_V3_DEPENDENT: partial indexes that depend on v3 new columns — must run after migration, otherwise v2 old DB reports "no such column"
// ───────────────────────────────────────────────────────────────────────
const DDL_BASE = `
-- ── Layer 0: Raw session log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_raw_sessions (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);

CREATE TABLE IF NOT EXISTS memory_raw_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES memory_raw_sessions(id),
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  timestamp  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_messages_session ON memory_raw_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_raw_messages_timestamp ON memory_raw_messages(timestamp);

-- v6: Full-text index on message content, for recall_sessions tool to search history by keyword
CREATE VIRTUAL TABLE IF NOT EXISTS memory_raw_messages_fts USING fts5(
  content,
  role,
  content='memory_raw_messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_raw_messages_ai AFTER INSERT ON memory_raw_messages BEGIN
  INSERT INTO memory_raw_messages_fts(rowid, content, role)
  VALUES (new.rowid, new.content, new.role);
END;
CREATE TRIGGER IF NOT EXISTS memory_raw_messages_ad AFTER DELETE ON memory_raw_messages BEGIN
  INSERT INTO memory_raw_messages_fts(memory_raw_messages_fts, rowid, content, role)
  VALUES ('delete', old.rowid, old.content, old.role);
END;

-- ── Layer 1: Text fallback ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_notes (
  id               TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  importance       REAL NOT NULL DEFAULT 0.5,
  session_id       TEXT,
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER,
  forgotten_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_importance ON memory_notes(importance DESC);
CREATE INDEX IF NOT EXISTS idx_notes_session ON memory_notes(session_id);

-- SQLite FTS5 for text search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
  content,
  content='memory_notes',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
  INSERT INTO memory_notes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_notes_ad AFTER DELETE ON memory_notes BEGIN
  INSERT INTO memory_notes_fts(memory_notes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_notes_au AFTER UPDATE ON memory_notes BEGIN
  INSERT INTO memory_notes_fts(memory_notes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_notes_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- ── Layer 2: Structured facts (with dual-temporal time dimension) ────────
CREATE TABLE IF NOT EXISTS memory_facts (
  id               TEXT PRIMARY KEY,
  namespace        TEXT NOT NULL,
  key              TEXT NOT NULL,
  value_json       TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  superseded_by    TEXT,
  supersedes       TEXT,
  created_at       INTEGER NOT NULL,
  -- v3: temporal semantics extension
  occurred_at      INTEGER,               -- event time (required for event kind)
  valid_from       INTEGER,               -- validity start (recommended for state kind)
  valid_until      INTEGER,               -- validity end (NULL=permanent)
  last_accessed_at INTEGER,               -- LRU
  decay_tau_days   REAL,                  -- decay constant, NULL=use namespace default
  forgotten_at     INTEGER,               -- soft delete
  fact_kind        TEXT NOT NULL DEFAULT 'state'  -- 'state' | 'event'
);

CREATE INDEX IF NOT EXISTS idx_facts_namespace ON memory_facts(namespace);
CREATE INDEX IF NOT EXISTS idx_facts_ns_key ON memory_facts(namespace, key);

-- ── Layer 0.5: Action log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  trigger      TEXT,
  tool_name    TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  result       TEXT,
  success      INTEGER NOT NULL,
  timestamp    INTEGER NOT NULL,
  linked_skill TEXT                       -- v3: which skill triggered this action, for feedback loop
);

CREATE INDEX IF NOT EXISTS idx_actions_session ON memory_actions(session_id);
CREATE INDEX IF NOT EXISTS idx_actions_tool ON memory_actions(tool_name);
CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON memory_actions(timestamp);

-- ── Layer 3: Skill library (with success-rate feedback) ──────────────────
CREATE TABLE IF NOT EXISTS memory_skills (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL,
  trigger_keywords TEXT NOT NULL,
  action_template  TEXT NOT NULL,
  use_count        INTEGER NOT NULL DEFAULT 0,
  last_used_at     INTEGER,
  created_at       INTEGER NOT NULL,
  -- v3: feedback loop fields
  success_count    INTEGER NOT NULL DEFAULT 0,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  last_failure_at  INTEGER,
  -- v5: polarity (positive=forward template / negative=anti-pattern lesson)
  kind             TEXT NOT NULL DEFAULT 'positive',
  -- v10: skill source tag. NULL = locally written / reflectively generated; 'clawhub:<slug>@<version>' = installed from ClawHub.
  -- Used to distinguish external skills in list/uninstall, and to append [clawhub] tag in system prompt index.
  source           TEXT
);

CREATE INDEX IF NOT EXISTS idx_skills_use_count ON memory_skills(use_count DESC);
CREATE INDEX IF NOT EXISTS idx_skills_name ON memory_skills(name);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_skills_fts USING fts5(
  name,
  description,
  trigger_keywords,
  content='memory_skills',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_skills_ai AFTER INSERT ON memory_skills BEGIN
  INSERT INTO memory_skills_fts(rowid, name, description, trigger_keywords)
  VALUES (new.rowid, new.name, new.description, new.trigger_keywords);
END;
CREATE TRIGGER IF NOT EXISTS memory_skills_ad AFTER DELETE ON memory_skills BEGIN
  INSERT INTO memory_skills_fts(memory_skills_fts, rowid, name, description, trigger_keywords)
  VALUES ('delete', old.rowid, old.name, old.description, old.trigger_keywords);
END;
CREATE TRIGGER IF NOT EXISTS memory_skills_au AFTER UPDATE ON memory_skills BEGIN
  INSERT INTO memory_skills_fts(memory_skills_fts, rowid, name, description, trigger_keywords)
  VALUES ('delete', old.rowid, old.name, old.description, old.trigger_keywords);
  INSERT INTO memory_skills_fts(rowid, name, description, trigger_keywords)
  VALUES (new.rowid, new.name, new.description, new.trigger_keywords);
END;

-- ── Calendar: future event anchors (added in v3) ─────────────────────────
CREATE TABLE IF NOT EXISTS memory_calendar (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  starts_at       INTEGER NOT NULL,
  ends_at         INTEGER,
  rrule           TEXT,                   -- iCalendar RRULE, e.g. FREQ=WEEKLY;BYDAY=MO
  timezone        TEXT NOT NULL,          -- IANA, required
  related_fact_id TEXT,                   -- back-reference to facts.id (nullable, no FK constraint to allow soft-delete)
  external_ref    TEXT,                   -- third-party calendar event id (Google/Outlook), for deduplication
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_starts ON memory_calendar(starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_external ON memory_calendar(external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_fact ON memory_calendar(related_fact_id) WHERE related_fact_id IS NOT NULL;

-- ── Scheduled tasks: future behavior commitments (added in v3, created_by added in v4) ──
CREATE TABLE IF NOT EXISTS memory_schedules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  cron_expr    TEXT,                     -- NULL=one-shot, non-NULL=recurring
  next_run_at  INTEGER NOT NULL,
  last_run_at  INTEGER,
  action_type  TEXT NOT NULL,            -- 'prompt' | 'tool_call' | 'reflect'
  payload_json TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  -- v4: creator origin record: "user" | "llm_external" | "extractor" | "reflector" | "drive:<name>"
  -- scheduler uses this at trigger time to determine SignalOrigin when re-running PolicyGate
  created_by   TEXT NOT NULL DEFAULT 'llm_external',
  -- v16: schedule auto-circuit-breaker fields (driven by mycox heartbeat 401 storm on 2026-05-11)
  --   consecutive_failures: autonomous_turn failure count, cleared on success
  --   paused_until: soft-pause deadline in ms; when non-null and > now, dueBefore skips it
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER,
  -- v23 (Phase 13.5, 2026-05-18): project association, used for scheduled session
  -- buildMemoryPrefix injects plan.md. NULL = non-project schedule (pure reminder).
  -- LLM passes explicitly via schedule_reminder({project:'mycox', ...}), or mechanism layer falls back
  -- to auto-filling from the current session's active plan.persistedTo.
  project      TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON memory_schedules(next_run_at) WHERE enabled = 1;

-- ── Schedule outcomes (v21, 2026-05-17): run results for each schedule fire ────
--
-- Design rationale: routing_rules / skills are "general task-level" memory, but high-frequency
-- repeated tasks like heartbeat don't benefit from them — each fire re-makes the same old mistakes.
-- This table auto-records each scheduled turn's key events (http call stats + failure signatures + outcome)
-- at the mechanism layer; the next fire injects the most recent N rows at the top of the prefix so LLM must see them — no dependency on the reflection distillation chain.
--
-- schedule_id is taken from the sessionId suffix (e.g. system:scheduled:mycox-checkin → mycox-checkin).
CREATE TABLE IF NOT EXISTS schedule_outcomes (
  id                   TEXT PRIMARY KEY,
  schedule_id          TEXT NOT NULL,
  fired_at             INTEGER NOT NULL,
  duration_ms          INTEGER NOT NULL,
  outcome              TEXT NOT NULL,        -- 'ok' | 'partial' | 'failed'
  http_ok_count        INTEGER NOT NULL DEFAULT 0,
  http_fail_count      INTEGER NOT NULL DEFAULT 0,
  http_status_json     TEXT NOT NULL DEFAULT '{}',   -- {"200":5,"404":3,"401":1}
  failure_signatures   TEXT NOT NULL DEFAULT '[]',   -- ["http:404","http:401"] JSON array
  text_summary         TEXT NOT NULL,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_outcomes_sid_time
  ON schedule_outcomes(schedule_id, fired_at DESC);

-- ── Memory access log: for LRU and real-value estimation (added in v3) ────
CREATE TABLE IF NOT EXISTS memory_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,             -- 'fact' | 'note' | 'skill'
  target_id   TEXT NOT NULL,
  accessed_at INTEGER NOT NULL,
  context     TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_target ON memory_access_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_access_time ON memory_access_log(accessed_at);

-- ── Pursuit layer (v7): agent identity + soul core ──────────────────────
-- parent_pursuit_id IS NULL  ⇒  root  ⇒  agent itself
-- constitution_* four columns only valid for root row (non-root left NULL); frozen during session
CREATE TABLE IF NOT EXISTS memory_pursuits (
  id                          TEXT PRIMARY KEY,
  parent_pursuit_id           TEXT,
  -- redundant column: root's own root_pursuit_id points to its own id
  root_pursuit_id             TEXT NOT NULL,
  title                       TEXT NOT NULL,
  intent                      TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active',
  is_evergreen                INTEGER NOT NULL DEFAULT 0,
  stake                       TEXT NOT NULL DEFAULT 'medium',
  deadline                    INTEGER,
  origin                      TEXT NOT NULL,
  open_questions_json         TEXT NOT NULL DEFAULT '[]',
  resolution_criteria         TEXT,
  evidence_refs_json          TEXT NOT NULL DEFAULT '[]',
  progress_markers_json       TEXT NOT NULL DEFAULT '[]',
  last_progress_turn          INTEGER NOT NULL DEFAULT 0,
  -- Constitution four fields (root only; non-root should be NULL)
  constitution_values         TEXT,
  constitution_red_lines      TEXT,
  constitution_drive_bounds   TEXT,
  constitution_governance     TEXT,
  -- v9 (Tier 2.1): two columns needed for commitment_pressure signal
  --   last_touched_ts: any event that "activates" the pursuit should refresh this timestamp;
  --                    "how long since last activity" = decay input for aging pressure
  --   stake_weight: numeric stake 1-10, no enum mapping needed when computing pressure as pure function
  last_touched_ts             INTEGER,
  stake_weight                INTEGER NOT NULL DEFAULT 5,
  -- v24 (active research loop): set is_active_research=1 when user says "keep researching X";
  --   autonomous loop advances it every tick without waiting for staleness; research_iterations counts advances,
  --   auto-clears is_active_research when limit is reached or question is answered (convergence shutdown).
  is_active_research          INTEGER NOT NULL DEFAULT 0,
  research_iterations         INTEGER NOT NULL DEFAULT 0,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pursuits_parent ON memory_pursuits(parent_pursuit_id);
CREATE INDEX IF NOT EXISTS idx_pursuits_root ON memory_pursuits(root_pursuit_id);
CREATE INDEX IF NOT EXISTS idx_pursuits_status ON memory_pursuits(status);

-- ── Declarative drive config (v7): drive as a self-domain memory citizen ──
CREATE TABLE IF NOT EXISTS memory_drive_configs (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'shadow',
  trigger_expr_json    TEXT NOT NULL,
  action_template_json TEXT NOT NULL,
  params_json          TEXT NOT NULL DEFAULT '{}',
  effectiveness_json   TEXT NOT NULL DEFAULT '{"samples":0,"ewma":0,"lastFired":null}',
  root_pursuit_id      TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drive_configs_root ON memory_drive_configs(root_pursuit_id);
CREATE INDEX IF NOT EXISTS idx_drive_configs_kind ON memory_drive_configs(kind);
CREATE INDEX IF NOT EXISTS idx_drive_configs_status ON memory_drive_configs(status);

-- ── Drive trigger persistence (v7, append-only): landing point for feedback loop ──
CREATE TABLE IF NOT EXISTS memory_drive_outcomes (
  id                          TEXT PRIMARY KEY,
  drive_id                    TEXT NOT NULL,
  fired_at                    INTEGER NOT NULL,
  trigger_snapshot_json        TEXT NOT NULL,
  injected_action_json         TEXT NOT NULL,
  subsequent_tool_calls_json   TEXT NOT NULL DEFAULT '[]',
  memory_delta_json            TEXT NOT NULL DEFAULT '{}',
  served_pursuit_id            TEXT,
  -- deferred computation: NULL at trigger time, back-filled by reflector after N turns
  effectiveness_score          REAL,
  root_pursuit_id              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drive_outcomes_drive ON memory_drive_outcomes(drive_id);
CREATE INDEX IF NOT EXISTS idx_drive_outcomes_fired ON memory_drive_outcomes(fired_at);
CREATE INDEX IF NOT EXISTS idx_drive_outcomes_root ON memory_drive_outcomes(root_pursuit_id);
CREATE INDEX IF NOT EXISTS idx_drive_outcomes_pursuit ON memory_drive_outcomes(served_pursuit_id)
  WHERE served_pursuit_id IS NOT NULL;

-- ── Meta table (schema version management) ───────────────────────────────
CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Partial indexes that depend on v3 new columns — must run after migration
const DDL_V3_DEPENDENT = `
CREATE INDEX IF NOT EXISTS idx_notes_active ON memory_notes(importance DESC)
  WHERE forgotten_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_active ON memory_facts(namespace, key)
  WHERE superseded_by IS NULL AND forgotten_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_validity ON memory_facts(valid_until)
  WHERE forgotten_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_actions_skill ON memory_actions(linked_skill)
  WHERE linked_skill IS NOT NULL;
`;

// ── Migration helpers ──────────────────────────────────────────────────────────

interface ColumnInfo {
  name: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare<[string]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    )
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  typeSpec: string
): void {
  if (!tableExists(db, table)) return;
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSpec}`);
}

/**
 * Incremental migration v3 → v4. Adds created_by column to memory_schedules (origin inheritance).
 */
function migrateV3ToV4(db: Database.Database): void {
  addColumnIfMissing(
    db,
    'memory_schedules',
    'created_by',
    "TEXT NOT NULL DEFAULT 'llm_external'"
  );
}

/**
 * Incremental migration v4 → v5. Adds kind column to memory_skills to distinguish positive templates from anti-pattern lessons.
 * Default 'positive' preserves old Skill behaviour.
 */
function migrateV4ToV5(db: Database.Database): void {
  addColumnIfMissing(
    db,
    'memory_skills',
    'kind',
    "TEXT NOT NULL DEFAULT 'positive'"
  );
}

/**
 * Incremental migration v5 → v6. Adds FTS index for memory_raw_messages and backfills existing messages.
 * DDL_BASE has already created the virtual table and triggers via CREATE IF NOT EXISTS;
 * only backfill is needed here (triggers only fire for subsequent INSERTs, existing data must be explicitly populated).
 *
 * Uses FTS5 'rebuild' command: it discards the existing index and rebuilds from the content table.
 * Idempotent for both "building from scratch" and "fixing after partial writes".
 */
function migrateV5ToV6(db: Database.Database): void {
  if (!tableExists(db, 'memory_raw_messages_fts')) return;
  if (!tableExists(db, 'memory_raw_messages')) return;
  db.exec(`INSERT INTO memory_raw_messages_fts(memory_raw_messages_fts) VALUES('rebuild')`);
}

/**
 * Incremental migration v6 → v7.
 *
 *  - Adds memory_pursuits / memory_drive_configs / memory_drive_outcomes tables
 *    (CREATE IF NOT EXISTS in DDL_BASE already created them; here we only handle column additions for existing DBs)
 *  - Adds redundant root_pursuit_id column to the six old self-domain tables, filled with BOOTSTRAP_ROOT_PURSUIT_ID
 *  - If memory_pursuits has no root row yet, inserts a bootstrap root;
 *    this also ensures empty DBs immediately have a usable default agent identity after initSchema.
 *
 * All operations are idempotent: safe to re-run on new, already-migrated, or partially-migrated DBs.
 */
function migrateV6ToV7(db: Database.Database): void {
  // 1. Add root_pursuit_id column to old self-domain tables
  const selfDomainTables = [
    'memory_facts',
    'memory_notes',
    'memory_skills',
    'memory_schedules',
    'memory_calendar',
    'memory_access_log',
  ];
  for (const table of selfDomainTables) {
    addColumnIfMissing(db, table, 'root_pursuit_id', 'TEXT');
  }

  // 2. About to UPDATE memory_notes / memory_skills; their AFTER UPDATE triggers will
  //    'delete + insert' on the FTS virtual table. If FTS is empty (newly CREATE IF NOT EXISTS
  //    built virtual table + not yet backfilled), the delete hits nothing and SQLite reports
  //    SQLITE_CORRUPT_VTAB. Rebuild first to sync the content table into FTS so trigger semantics are correct.
  for (const fts of ['memory_notes_fts', 'memory_skills_fts']) {
    if (tableExists(db, fts)) {
      db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`);
    }
  }

  // 3. Backfill BOOTSTRAP_ROOT_PURSUIT_ID into old rows that have not yet set root_pursuit_id
  //    (ALTER TABLE ADD COLUMN does not support DEFAULT + NOT NULL constraint for old rows in one shot,
  //     so use UPDATE for data backfill; newly inserted rows are set explicitly by each Store)
  for (const table of selfDomainTables) {
    if (!tableExists(db, table)) continue;
    if (!hasColumn(db, table, 'root_pursuit_id')) continue;
    db.prepare<[string]>(
      `UPDATE ${table} SET root_pursuit_id = ? WHERE root_pursuit_id IS NULL`
    ).run(BOOTSTRAP_ROOT_PURSUIT_ID);
  }

  // 4. Ensure memory_pursuits has at least one bootstrap root
  ensureBootstrapRoot(db);
}

/**
 * Incremental migration v7 → v8.
 *
 * K0: de-sessionize the working-memory architecture. The session concept is removed from
 * application-layer logic — LLM context is no longer taken from a specific session's messages
 * array but recalled from the global timeline.
 *
 * Here we only ensure the `'global'` session row exists (memory_raw_messages.session_id
 * is still NOT NULL FK, so new inserts need this placeholder row). Relaxing the FK / NOT NULL
 * constraint is deferred to a later migration; K0 does not touch it — to avoid large-table
 * rebuild risk, and old multi-session_id data is preserved for historical queries.
 */
function migrateV7ToV8(db: Database.Database): void {
  ensureGlobalTimelineSession(db);
}

/**
 * Incremental migration v8 → v9.
 *
 * Tier 2.1: prepare schema for the commitment_pressure signal.
 *   - Add `last_touched_ts INTEGER` to memory_pursuits (old rows backfilled = updated_at)
 *   - Add `stake_weight INTEGER NOT NULL DEFAULT 5` to memory_pursuits
 *     (old rows mapped from stake enum: low=3 / medium=5 / high=8)
 *
 * These two columns let the pure function commitment_pressure compute "old + high stake = high pressure"
 * without re-mapping the stake enum each time or inferring time from progress_markers.
 */
function migrateV8ToV9(db: Database.Database): void {
  addColumnIfMissing(db, 'memory_pursuits', 'last_touched_ts', 'INTEGER');
  addColumnIfMissing(
    db,
    'memory_pursuits',
    'stake_weight',
    'INTEGER NOT NULL DEFAULT 5',
  );

  if (!tableExists(db, 'memory_pursuits')) return;

  // Old rows: backfill last_touched_ts with updated_at (best approximation when no finer time trace is available)
  db.exec(
    `UPDATE memory_pursuits
     SET last_touched_ts = COALESCE(last_touched_ts, updated_at, created_at)
     WHERE last_touched_ts IS NULL`,
  );

  // Old rows: map stake_weight from stake enum. Do not touch rows that already have a non-default value.
  // SQLite ALTER ADD COLUMN sets all old rows to DEFAULT 5, so this step replaces 5 with
  // the real mapping (low=3 / medium=5 / high=8).
  db.exec(
    `UPDATE memory_pursuits SET stake_weight = 3 WHERE stake = 'low'`,
  );
  db.exec(
    `UPDATE memory_pursuits SET stake_weight = 8 WHERE stake = 'high'`,
  );
}

/**
 * v9 → v10: add source column to memory_skills.
 *
 * NULL = locally written / reflection-generated; non-null = external origin (loaded from ClawHub,
 * e.g. 'clawhub:foo-skill@1.2.0').
 *
 * Used by chat-handler reload prune to determine "which orphan rows may be deleted" — only
 * delete rows where source is non-NULL but the disk file no longer exists; locally written
 * skills are never touched.
 */
function migrateV9ToV10(db: Database.Database): void {
  addColumnIfMissing(db, 'memory_skills', 'source', 'TEXT');
}

/**
 * v10 → v11: add maturity 5-tier + last_success_at + consecutive_failures to memory_skills.
 *
 * Core self-learning schema: makes skill state trackable with promotion/demotion
 * (playbook/draft/confirmed/stable/deprecated) instead of implicitly expressed through
 * success/failure counts + composite score alone.
 *
 * Default value conventions:
 *   - maturity defaults to 'draft': newly written skills (reflection-generated) auto-promote after usage feedback accumulates
 *   - Existing skills (migration path): one-time UPDATE sets all to 'stable' — already in use and not reported broken,
 *     treated as stable. bundled-skills and clawhub-loaded are not differentiated: both get maximum trust tier, demote on failure.
 *   - last_success_at: filled with last_used_at at migration time (success path dominates, approximate)
 *   - consecutive_failures: defaults to 0 at migration (no accumulated failure history available)
 *
 * playbook tier is not produced by migration — must be explicitly written by subsequent reflection.
 */
function migrateV10ToV11(db: Database.Database): void {
  addColumnIfMissing(
    db,
    'memory_skills',
    'maturity',
    `TEXT NOT NULL DEFAULT 'draft'`,
  );
  addColumnIfMissing(db, 'memory_skills', 'last_success_at', 'INTEGER');
  addColumnIfMissing(
    db,
    'memory_skills',
    'consecutive_failures',
    'INTEGER NOT NULL DEFAULT 0',
  );

  // Promote historical rows from 'draft' default to 'stable' (all have seen real use, trust directly).
  // One-time UPDATE only; new rows still have maturity explicitly controlled by createSkill.
  // Do not touch reflection-generated rows (source LIKE 'self:%') — they should be promoted/demoted
  // naturally by the state machine. But there should be no such rows before v11 since the reflection
  // mechanism didn't exist; written as IS NOT 'self%' for safety.
  db.exec(
    `UPDATE memory_skills
     SET maturity = 'stable'
     WHERE maturity = 'draft'
       AND (source IS NULL OR source NOT LIKE 'self:%')`,
  );

  // At migration time, approximate last_success_at as last_used_at (existing calls are mostly successes)
  db.exec(
    `UPDATE memory_skills
     SET last_success_at = last_used_at
     WHERE last_success_at IS NULL AND last_used_at IS NOT NULL`,
  );
}

/**
 * v11 → v12: add routing_rules table (core self-learning).
 *
 * Stores "input condition → preferred skill / avoid skill" decision rules distilled by reflection.
 * Decoupled from memory_skills: a rule's lifecycle is independent of a specific skill (if skill X
 * is unloaded and replaced with a similar substitute Y, the rule's prefer/avoid can be remapped
 * without losing knowledge).
 *
 * Field semantics:
 *   - task_signature: fuzzy task label such as "pdf-to-word" (provided by LLM when writing reflection)
 *   - trigger_condition: free-text discrimination condition (LLM-written, must include concrete features)
 *   - prefer_skill: recommended skill name to use (NULL means pure avoidance rule)
 *   - avoid_skills: JSON array of not-recommended skill names
 *   - carveout: inapplicable cases (enforced at write-time for LLM to provide, prevents over-generalization)
 *   - evidence: which observation was the basis when the rule was written (traceable)
 *   - confidence: provisional/tentative/validated/disputed/retired
 *   - success_count/failure_count: feedback counts after adoption
 *   - consecutive_successes/consecutive_failures: streak, drives state machine
 *   - context_keywords: JSON array, keywords extracted from trigger_condition, used for lookup
 *   - reflection_id: traces back to the reflection event that generated this rule
 */
function migrateV11ToV12(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_signature TEXT NOT NULL,
      trigger_condition TEXT NOT NULL,
      prefer_skill TEXT,
      avoid_skills TEXT,
      carveout TEXT NOT NULL,
      evidence TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'provisional',
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      consecutive_successes INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      context_keywords TEXT,
      reflection_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rr_signature ON routing_rules(task_signature);
    CREATE INDEX IF NOT EXISTS idx_rr_confidence ON routing_rules(confidence);
    CREATE INDEX IF NOT EXISTS idx_rr_prefer_skill ON routing_rules(prefer_skill);
  `);
}

/**
 * v12 → v13: K8 proactivity layer schema.
 *
 * Adds two new tables, pure ADD with no ALTER:
 *   - memory_initiatives: work queue + history for the autonomous loop. An initiative is
 *     "a piece of research the agent decides to do itself", proposed by driver → executor runs
 *     tools/LLM → writes back to facts/notes, entire process is fully audit-traceable.
 *     target_ref is used for deduplication within 24h for the same target.
 *   - autonomous_budget: per-user / per-day three-tier budget buckets; both LLM tokens and tool
 *     calls are protected by daily caps. Date uses UTC YYYY-MM-DD string, resets automatically across days.
 *
 * Upgrading old DBs: CREATE TABLE only, does not modify existing data.
 */
function migrateV12ToV13(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_initiatives (
      id                TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      driver            TEXT NOT NULL,
      target_ref        TEXT NOT NULL,
      rationale         TEXT NOT NULL,
      utility           REAL NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      budget_estimate   INTEGER NOT NULL,
      budget_actual     INTEGER,
      outcome_summary   TEXT,
      outcome_refs      TEXT,
      error             TEXT,
      created_at        INTEGER NOT NULL,
      started_at        INTEGER,
      completed_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_initiatives_status
      ON memory_initiatives(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_initiatives_driver
      ON memory_initiatives(driver, completed_at);
    CREATE INDEX IF NOT EXISTS idx_initiatives_target_recent
      ON memory_initiatives(target_ref, completed_at)
      WHERE status = 'done';

    CREATE TABLE IF NOT EXISTS autonomous_budget (
      user_id           TEXT NOT NULL,
      date              TEXT NOT NULL,
      llm_tokens_used   INTEGER NOT NULL DEFAULT 0,
      tool_calls_used   INTEGER NOT NULL DEFAULT 0,
      initiatives_run   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
  `);
}

/**
 * v13 → v14: K8 proactive push layer schema (2026-05-06 phase C).
 *
 * Adds push_subscriptions table to store subscription state per (channel, peer) dimension:
 *   - enabled / frequency cap (digest 4h, urgent 1h) / quiet hours / timezone
 *   - Timestamps of last digest / urgent push (used for rate-limiting decisions)
 *
 * Default state: no subscriptions (empty table) = no push. Subscriptions must be explicitly
 * created by the subscribePush tool, or directly INSERTed by test code.
 *
 * Global kill switch uses environment variable PHILONT_PUSH_ENABLED=0, not stored in table.
 */
function migrateV13ToV14(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      channel                 TEXT NOT NULL,
      peer                    TEXT NOT NULL,
      enabled                 INTEGER NOT NULL DEFAULT 1,
      quiet_start_hour        INTEGER,
      quiet_end_hour          INTEGER,
      timezone                TEXT,
      digest_min_interval_ms  INTEGER NOT NULL DEFAULT 14400000,
      urgent_min_interval_ms  INTEGER NOT NULL DEFAULT 3600000,
      last_digest_at          INTEGER,
      last_urgent_at          INTEGER,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL,
      PRIMARY KEY (channel, peer)
    );

    CREATE INDEX IF NOT EXISTS idx_push_sub_enabled
      ON push_subscriptions(enabled, channel)
      WHERE enabled = 1;
  `);
}

/**
 * v14 → v15: add when_to_use TEXT column to memory_skills (2026-05-09).
 *
 * General learning capability layer 1: persists the `when_to_use:` field from SKILL.md frontmatter
 * to DB; when the skill index is injected into the system prompt it is shown alongside description
 * so LLM can semantically judge "when to use this skill", and serves as trigger_condition when
 * routing rules are auto-generated.
 *
 * Default NULL → old skills left empty (reflection-generated skills have no SKILL.md file and
 * it doesn't matter; on startup reloadSkillsFromDisk + onConflict='replace' re-parses all
 * bundled SKILL.md files and auto-backfills this column).
 *
 * Not included in memory_skills_fts — scenario text is narrative; mixing it with trigger keyword
 * indexes pollutes search hits (users searching for skill names should not accidentally match
 * scenario text).
 */
function migrateV14ToV15(db: Database.Database): void {
  addColumnIfMissing(db, 'memory_skills', 'when_to_use', 'TEXT');
}

/**
 * v15 → v16: add consecutive_failures + paused_until columns to memory_schedules
 * (2026-05-11, driven by mycox heartbeat 401 storm in production).
 *
 * Purpose: when autonomous_turn fails, chat-handler calls ScheduleStore.recordFailure to
 * accumulate consecutive_failures. On reaching threshold (default 3) → write
 * paused_until = now + 1h; ScheduleStore.dueBefore automatically skips un-expired paused rows,
 * effectively soft-pausing for 1h.
 *
 * One success → recordSuccess resets to 0 and clears paused_until.
 *
 * Default values are compatible with old rows (consecutive_failures=0 / paused_until=NULL
 * means "never failed"); dueBefore filter uses `paused_until IS NULL OR paused_until <= ?`
 * for backward compatibility.
 */
function migrateV15ToV16(db: Database.Database): void {
  addColumnIfMissing(db, 'memory_schedules', 'consecutive_failures', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'memory_schedules', 'paused_until', 'INTEGER');
}

/**
 * v16 → v17: add memory_plans table (core complex-task protocol, 2026-05-11).
 *
 * Persistence for the complex-task "plan-review-execute-close" four-phase protocol:
 *   - LLM self-rates as slow mode → plan_draft writes row (status='draft')
 *   - plan_review pass → status='reviewed' (allows execution, chat-handler gate unlocked)
 *   - During execution each plan_update_step updates the corresponding step's status in steps_json
 *   - Reflection hits plan_revise → modifies steps_json + appends review_history
 *   - plan_close → status='completed' / 'failed' + completed_at
 *
 * Field semantics:
 *   - session_id: bound to ChatSession, one-to-many (a session can have multiple plans)
 *   - task_signature: task signature shared with routing_rules / skills, reused across sessions
 *   - steps_json: PlanStep[] JSON, each step contains id/description/status/evidence/timestamps
 *   - status: draft / reviewed / executing / completed / failed, linear state machine progression
 *   - review_history_json: PlanReview[] JSON, one entry per gap-check / revise
 *   - guide_ref: source of user-provided guidance (SKILL.md name / message fragment / URL), nullable
 *   - outcome_summary: execution summary written at plan_close
 *
 * Indexes cover three query types:
 *   - listBySession: chat-handler fetches the latest plan for the current session during execution
 *   - listBySignature: used by Phase 6.1 auto-slow to query same-task history
 *   - listByStatus: filters 'executing' / 'reviewed' active plans during reflection
 */
function migrateV16ToV17(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_plans (
      id                   TEXT PRIMARY KEY,
      session_id           TEXT NOT NULL,
      task_signature       TEXT,
      steps_json           TEXT NOT NULL DEFAULT '[]',
      status               TEXT NOT NULL DEFAULT 'draft',
      review_history_json  TEXT NOT NULL DEFAULT '[]',
      guide_ref            TEXT,
      outcome_summary      TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_plans_session ON memory_plans(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_plans_signature ON memory_plans(task_signature, created_at)
      WHERE task_signature IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_plans_status ON memory_plans(status, updated_at);
  `);
}

/**
 * v17 → v18: add config_rules table (Phase 8 Self-Modifying Configuration, 2026-05-12).
 *
 * Core carrier for mechanism-layer configuration self-modification. Moves hardcoded TS consts
 * (autonomous_blacklist / classifier rule sets / thresholds / gate exemption lists) out to SQLite,
 * allowing the meta-layer observer (MetaConfigObserver) to auto-write new rules based on
 * audit_chain patterns, which the mechanism layer reads on startup.
 *
 * 5-tier confidence fully reuses the routing_rules.ts pattern: provisional → tentative →
 * validated; disputed cycle; retired terminal state. Outcome feedback is pushed by ConfigRuleStore.recordOutcome.
 *
 * scope column is a whitelist (defined in code, enforced by store), only the predefined 5 scopes can be written.
 *
 * Field semantics:
 *   - scope: configuration category, e.g. 'autonomous_blacklist'
 *   - key: sub-key within scope (array scopes use NULL, kv scopes use a concrete key)
 *   - value_json: JSON-serialized value (string / array / object)
 *   - source: 'bootstrap' | 'self:meta-detector' | 'manual'
 *   - evidence: audit pattern description that triggered this rule (human-readable for LLM)
 *   - audit_ref: references the audit event id that triggered this rule (traceable)
 *
 * Index coverage:
 *   - Startup loading: WHERE scope = ? AND confidence IN ('validated','tentative')
 *   - Meta-layer observer: WHERE scope = ? AND confidence = 'provisional' (dry-run candidates)
 *   - Decay scan: WHERE updated_at < ?
 */
/**
 * v18 → v19: add inner_iter / outer_iter to memory_plans (2026-05-13).
 *
 * Counters for the two-layer nested loop state machine:
 *   - inner_iter: number of plan_review failures (non-empty gap / decision='revise');
 *     when ≥ INNER_LOOP_MAX the mechanism layer escalates to askUserQuestion (plan sticking point + options)
 *   - outer_iter: number of times plan_close was rejected by the mechanism layer (close-time strong validation failure);
 *     when ≥ OUTER_LOOP_MAX auto plan_close('failure') + distill failure playbook
 *
 * Both are bumped by the mechanism layer when plan_review / plan_close tools are called; LLM does not control them directly.
 * ALTER TABLE adds columns with default 0 (backward compatible with historical plans).
 */
function migrateV18ToV19(db: Database.Database): void {
  if (!tableExists(db, 'memory_plans')) return; // guard: fresh init already has the column
  // SQLite ALTER does not support IF NOT EXISTS; if the column already exists let it throw and swallow
  const cols = db.prepare(`PRAGMA table_info(memory_plans)`).all() as Array<{
    name: string;
  }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('inner_iter')) {
    db.exec(`ALTER TABLE memory_plans ADD COLUMN inner_iter INTEGER NOT NULL DEFAULT 0`);
  }
  if (!have.has('outer_iter')) {
    db.exec(`ALTER TABLE memory_plans ADD COLUMN outer_iter INTEGER NOT NULL DEFAULT 0`);
  }
}

/**
 * v19 → v20: Phase 11 spec-coverage fields (2026-05-15).
 *
 * Complex-task protocol simplified from "two-layer loop + aux review" to "single layer + structural enforcement".
 * Three new columns:
 *   - deliverables_json: explicit deliverable checklist LLM provides in plan_draft (JSON array)
 *   - deliverable_status_json: status annotated per item by LLM at plan_close (JSON object, NULL before close)
 *   - is_placeholder: flag for placeholder plans created by auto-plan-on-slow / auto-revise-on-fail
 *
 * M1 phase: all field defaults are backward-compatible with old calls, behaviour unchanged. Structural enforcement only enabled at M4.
 *
 * Historical 'reviewed' status rows migrated to 'executing' (compatibility measure before M3 state machine tightening):
 *   The closest semantic for 'reviewed' is "plan confirmed ready to execute, equivalent to executing state".
 *   Code paths that read 'reviewed' rows will be removed with M3; this UPDATE clears the slate early.
 *
 * inner_iter / outer_iter / review_history_json columns retained (SQLite DROP is not easy);
 * code layer stops reading/writing them at M5.
 */
/**
 * v20 → v21: add schedule_outcomes table (2026-05-17).
 * DDL_BASE already creates the table (CREATE IF NOT EXISTS); empty DB inits directly, migration function is no-op for old DBs.
 */
function migrateV20ToV21(_db: Database.Database): void {
  // schedule_outcomes is a brand-new table; DDL_BASE's CREATE IF NOT EXISTS already built it.
  // No ALTER to existing tables needed. Function kept as placeholder to maintain version-increment semantics.
}

/**
 * v21 → v22: add persisted_to column to memory_plans (Phase 13, 2026-05-17).
 * NULL = DB-only plan (default); non-null = plan persisted to ~/.philont/projects/<value>/plan.md.
 * LLM triggers this at plan_draft call time via persist:true + project:'<name>'.
 */
function migrateV21ToV22(db: Database.Database): void {
  addColumnIfMissing(db, 'memory_plans', 'persisted_to', 'TEXT');
}

/**
 * v22 → v23: add project column to memory_schedules (Phase 13.5, 2026-05-18).
 * NULL = non-project-level schedule; non-null = when scheduled session fires, buildMemoryPrefix
 * uses this project name to inject the corresponding plan.md (the scheduled session's sessionId
 * differs from the original placeholder plan's sessionId, so listBySession cannot reverse-look up
 * project; it must be stored directly on the schedule).
 */
function migrateV22ToV23(db: Database.Database): void {
  addColumnIfMissing(db, 'memory_schedules', 'project', 'TEXT');
}

function migrateV23ToV24(db: Database.Database): void {
  // Active research loop: add "currently under active research" flag + iteration count to pursuit (for convergence safety cap).
  addColumnIfMissing(db, 'memory_pursuits', 'is_active_research', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'memory_pursuits', 'research_iterations', 'INTEGER NOT NULL DEFAULT 0');
}

/**
 * v24 → v25: deep reasoning subsystem (isolated, resumable within a turn). Two new tables store the "reasoning tree".
 *
 *   reasoning_sessions  — a reasoning session for one hard problem/conjecture (root proposition + state + cross-turn accumulated budget)
 *   reasoning_nodes     — sub-problem tree nodes (parent_id forms tree; status includes dead_end;
 *                         approaches_tried_json is backtrack memory, records dead ends tried to avoid repeating them)
 *
 * Upgrading old DBs: CREATE TABLE only, does not modify existing data. When env flag PHILONT_DEEP_EXPLORE is off (default),
 * tools are not registered but tables are still created (harmless empty tables).
 */
function migrateV24ToV25(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reasoning_sessions (
      id                TEXT PRIMARY KEY,
      goal              TEXT NOT NULL,
      assumptions_json  TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      owner_session_id  TEXT,
      root_node_id      TEXT,
      budget_spent      INTEGER NOT NULL DEFAULT 0,
      no_progress_rounds INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reasoning_sessions_status
      ON reasoning_sessions(status, updated_at);

    CREATE TABLE IF NOT EXISTS reasoning_nodes (
      id                   TEXT PRIMARY KEY,
      session_id           TEXT NOT NULL,
      parent_id            TEXT,
      claim                TEXT NOT NULL,
      kind                 TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'open',
      result               TEXT,
      approaches_tried_json TEXT,
      evidence_refs_json   TEXT,
      depth                INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reasoning_nodes_session
      ON reasoning_nodes(session_id, status);
  `);
}

/**
 * v25→v26: add two columns to reasoning_nodes for value-guided node selection (LATS / rStar style).
 *   value   REAL  — latest estimate by an independent aux-LLM of this node's "value/tractability for conquering the root proposition" (0-1, NULL=not yet evaluated)
 *   visits  INT   — number of turns this node has been advanced as an active frontier (denominator for UCB exploration term)
 * ADD COLUMN only, does not modify existing data; if table does not exist (deep_explore never used) skip; new DB v26 DDL includes columns directly.
 */
function migrateV25ToV26(db: Database.Database): void {
  if (!tableExists(db, 'reasoning_nodes')) return;
  const cols = db.prepare(`PRAGMA table_info(reasoning_nodes)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('value')) db.exec(`ALTER TABLE reasoning_nodes ADD COLUMN value REAL`);
  if (!have.has('visits')) db.exec(`ALTER TABLE reasoning_nodes ADD COLUMN visits INTEGER NOT NULL DEFAULT 0`);
}

/**
 * v26→v27: add technique column to reasoning_nodes (the "behavioural descriptor" for MAP-Elites-lite diversity archive).
 *   technique TEXT — proof/exploration technique used by the node (induction/contradiction/construction/algebraic/
 *   analytic/probabilistic/combinatorial/computational/other, NULL=unclassified), used for novelty scoring + bucketed selection.
 * ADD COLUMN only; skip if table does not exist (new DB v27 chain migration will add it).
 */
function migrateV26ToV27(db: Database.Database): void {
  if (!tableExists(db, 'reasoning_nodes')) return;
  const cols = db.prepare(`PRAGMA table_info(reasoning_nodes)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('technique')) db.exec(`ALTER TABLE reasoning_nodes ADD COLUMN technique TEXT`);
}

/**
 * v27→v28: add owner_session_id to reasoning_sessions so deep_explore continue/status/discover is scoped
 * to the chat session that started the reasoning. Prevents two concurrent channels (e.g. WeChat + web-ui)
 * from hijacking each other's most-recent-active reasoning session via getMostRecentActiveSession().
 * ADD COLUMN only; pre-existing sessions keep NULL owner and stay resumable by any channel (graceful
 * migration — they age out as they close), while every new session is strictly owner-scoped. Skip if
 * the table does not exist (new DB DDL already includes the column).
 */
function migrateV27ToV28(db: Database.Database): void {
  if (!tableExists(db, 'reasoning_sessions')) return;
  const cols = db.prepare(`PRAGMA table_info(reasoning_sessions)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('owner_session_id')) {
    db.exec(`ALTER TABLE reasoning_sessions ADD COLUMN owner_session_id TEXT`);
  }
}

/**
 * v28→v29: add reasoning_sessions.no_progress_rounds — a cross-round counter of consecutive rounds
 * that made NO net tree progress (no new proved/refuted/dead_end, no decompose). Drives stuck handling:
 * after a few stuck rounds the round prompt forces a pivot, and the reply escalates to the user instead
 * of grinding the same frontier. ADD COLUMN only; skip if the table does not exist.
 */
function migrateV28ToV29(db: Database.Database): void {
  if (!tableExists(db, 'reasoning_sessions')) return;
  const cols = db.prepare(`PRAGMA table_info(reasoning_sessions)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('no_progress_rounds')) {
    db.exec(`ALTER TABLE reasoning_sessions ADD COLUMN no_progress_rounds INTEGER NOT NULL DEFAULT 0`);
  }
}

function migrateV19ToV20(db: Database.Database): void {
  if (!tableExists(db, 'memory_plans')) return; // guard: fresh init already has the column
  const cols = db.prepare(`PRAGMA table_info(memory_plans)`).all() as Array<{
    name: string;
  }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('deliverables_json')) {
    db.exec(
      `ALTER TABLE memory_plans ADD COLUMN deliverables_json TEXT NOT NULL DEFAULT '[]'`,
    );
  }
  if (!have.has('deliverable_status_json')) {
    db.exec(
      `ALTER TABLE memory_plans ADD COLUMN deliverable_status_json TEXT`,
    );
  }
  if (!have.has('is_placeholder')) {
    db.exec(
      `ALTER TABLE memory_plans ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0`,
    );
  }
  // Historical 'reviewed' status rows → 'executing' (compatibility measure before M3 state machine tightening)
  db.exec(`UPDATE memory_plans SET status = 'executing' WHERE status = 'reviewed'`);
}

function migrateV17ToV18(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      key TEXT,
      value_json TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'provisional',
      evidence TEXT,
      audit_ref TEXT,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      consecutive_successes INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_config_rules_scope_active
      ON config_rules(scope, confidence)
      WHERE confidence NOT IN ('retired', 'disputed');
    CREATE INDEX IF NOT EXISTS idx_config_rules_scope_all
      ON config_rules(scope, updated_at);
    CREATE INDEX IF NOT EXISTS idx_config_rules_decay
      ON config_rules(updated_at)
      WHERE confidence != 'retired';
  `);
}

/**
 * Ensures the GLOBAL_TIMELINE_SESSION_ID row exists in memory_raw_sessions,
 * so that v8+ global timeline appends do not fail with FK errors. Idempotent.
 *
 * Should be run on: new DB initSchema, v7→v8 migration, and after runtime crash restart.
 */
function ensureGlobalTimelineSession(db: Database.Database): void {
  if (!tableExists(db, 'memory_raw_sessions')) return;
  const row = db
    .prepare<[string]>('SELECT id FROM memory_raw_sessions WHERE id = ? LIMIT 1')
    .get(GLOBAL_TIMELINE_SESSION_ID) as { id: string } | undefined;
  if (row) return;
  db.prepare<[string, number]>(
    'INSERT INTO memory_raw_sessions (id, started_at) VALUES (?, ?)'
  ).run(GLOBAL_TIMELINE_SESSION_ID, Date.now());
}

/**
 * If memory_pursuits has no root pursuit yet (parent_pursuit_id IS NULL),
 * insert BOOTSTRAP_ROOT_PURSUIT_ID as the default root.
 *
 * Idempotent: does nothing when a root already exists. Shared by migrateV6ToV7 and new-DB initSchema.
 */
function ensureBootstrapRoot(db: Database.Database): void {
  if (!tableExists(db, 'memory_pursuits')) return;
  const row = db
    .prepare(
      `SELECT id FROM memory_pursuits WHERE parent_pursuit_id IS NULL LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (row) return;

  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_pursuits
     (id, parent_pursuit_id, root_pursuit_id, title, intent, status, is_evergreen,
      stake, deadline, origin, open_questions_json, resolution_criteria,
      evidence_refs_json, progress_markers_json, last_progress_turn,
      constitution_values, constitution_red_lines, constitution_drive_bounds,
      constitution_governance, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, 'active', 1, 'medium', NULL, 'system',
             '[]', NULL, '[]', '[]', 0,
             NULL, NULL, NULL, NULL, ?, ?)`
  ).run(
    BOOTSTRAP_ROOT_PURSUIT_ID,
    BOOTSTRAP_ROOT_PURSUIT_ID,
    'general assistance',
    'serve whoever talks to me',
    now,
    now,
  );
}

/**
 * Incremental migration v2 → v3.
 * DDL already covers new tables with CREATE IF NOT EXISTS; here we only handle column additions to existing tables.
 * All operations are idempotent and safe for a brand-new DB.
 */
function migrateV2ToV3(db: Database.Database): void {
  // memory_facts time semantics
  addColumnIfMissing(db, 'memory_facts', 'occurred_at', 'INTEGER');
  addColumnIfMissing(db, 'memory_facts', 'valid_from', 'INTEGER');
  addColumnIfMissing(db, 'memory_facts', 'valid_until', 'INTEGER');
  addColumnIfMissing(db, 'memory_facts', 'last_accessed_at', 'INTEGER');
  addColumnIfMissing(db, 'memory_facts', 'decay_tau_days', 'REAL');
  addColumnIfMissing(db, 'memory_facts', 'forgotten_at', 'INTEGER');
  addColumnIfMissing(db, 'memory_facts', 'fact_kind', "TEXT NOT NULL DEFAULT 'state'");

  // memory_notes forgetting fields
  addColumnIfMissing(db, 'memory_notes', 'last_accessed_at', 'INTEGER');
  addColumnIfMissing(db, 'memory_notes', 'forgotten_at', 'INTEGER');

  // memory_skills feedback loop
  addColumnIfMissing(db, 'memory_skills', 'success_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'memory_skills', 'failure_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'memory_skills', 'last_failure_at', 'INTEGER');

  // memory_actions skill back-link
  addColumnIfMissing(db, 'memory_actions', 'linked_skill', 'TEXT');
}

export function initSchema(db: Database.Database): void {
  // 1) Run base DDL (create tables + indexes that don't depend on new columns)
  db.exec(DDL_BASE);

  // 2) Then run incremental migrations (fill in missing columns for old DBs)
  const current = getSchemaVersion(db);
  if (current < 3) {
    migrateV2ToV3(db);
  }
  if (current < 4) {
    migrateV3ToV4(db);
  }
  if (current < 5) {
    migrateV4ToV5(db);
  }
  if (current < 6) {
    migrateV5ToV6(db);
  }
  if (current < 7) {
    migrateV6ToV7(db);
  } else {
    // Even if schema is already v7, ensure bootstrap root still exists
    // (e.g. someone manually deleted the root from memory_pursuits)
    ensureBootstrapRoot(db);
  }
  if (current < 8) {
    migrateV7ToV8(db);
  } else {
    // Similarly ensure the 'global' session row exists (guard against manual deletion)
    ensureGlobalTimelineSession(db);
  }
  if (current < 9) {
    migrateV8ToV9(db);
  }
  if (current < 10) {
    migrateV9ToV10(db);
  }
  if (current < 11) {
    migrateV10ToV11(db);
  }
  if (current < 12) {
    migrateV11ToV12(db);
  }
  if (current < 13) {
    migrateV12ToV13(db);
  }
  if (current < 14) {
    migrateV13ToV14(db);
  }
  if (current < 15) {
    migrateV14ToV15(db);
  }
  if (current < 16) {
    migrateV15ToV16(db);
  }
  if (current < 17) {
    migrateV16ToV17(db);
  }
  if (current < 18) {
    migrateV17ToV18(db);
  }
  if (current < 19) {
    migrateV18ToV19(db);
  }
  if (current < 20) {
    migrateV19ToV20(db);
  }
  if (current < 21) {
    migrateV20ToV21(db);
  }
  if (current < 22) {
    migrateV21ToV22(db);
  }
  if (current < 23) {
    migrateV22ToV23(db);
  }
  if (current < 24) {
    migrateV23ToV24(db);
  }
  if (current < 25) {
    migrateV24ToV25(db);
  }
  if (current < 26) {
    migrateV25ToV26(db);
  }
  if (current < 27) {
    migrateV26ToV27(db);
  }
  if (current < 28) {
    migrateV27ToV28(db);
  }
  if (current < 29) {
    migrateV28ToV29(db);
  }

  // 3) Finally run partial indexes that depend on v3 new columns
  db.exec(DDL_V3_DEPENDENT);

  // 4) Write schema version
  db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION)
  );
}

export function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare('SELECT value FROM memory_meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}
