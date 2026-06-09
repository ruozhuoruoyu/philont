/**
 * schema 迁移与 v3 新表测试
 *
 * 覆盖两条路径:
 *   1) 全新 DB:initSchema 一步到位创建 v3 所有表
 *   2) 模拟 v2 旧 DB:手建 v2 schema → 跑 initSchema → 断言新列/新表补齐且旧数据完好
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, getSchemaVersion, SCHEMA_VERSION } from '../src/schema.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.some((r) => r.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

test('fresh DB: initSchema creates current schema with all new tables and columns', () => {
  const db = new Database(':memory:');
  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 29);

  // v25: 深度推理两表;v26: value-guided 选点列;v27: technique(MAP-Elites 分桶);v28: owner_session_id(渠道隔离);v29: no_progress_rounds(卡死计数)
  assert.ok(tableExists(db, 'reasoning_sessions'));
  assert.ok(tableExists(db, 'reasoning_nodes'));
  assert.ok(hasColumn(db, 'reasoning_nodes', 'value'), 'v26: reasoning_nodes 缺 value');
  assert.ok(hasColumn(db, 'reasoning_nodes', 'visits'), 'v26: reasoning_nodes 缺 visits');
  assert.ok(hasColumn(db, 'reasoning_nodes', 'technique'), 'v27: reasoning_nodes 缺 technique');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'owner_session_id'), 'v28: reasoning_sessions 缺 owner_session_id');
  assert.ok(hasColumn(db, 'reasoning_sessions', 'no_progress_rounds'), 'v29: reasoning_sessions 缺 no_progress_rounds');

  // v8: 全局时间线 session 行('global')由 initSchema 自动建,作为
  // K0 时间线 bookkeeping 的占位
  const globalRow = db
    .prepare(`SELECT id FROM memory_raw_sessions WHERE id = 'global' LIMIT 1`)
    .get() as { id: string } | undefined;
  assert.ok(globalRow, "v8 应该自动创建 'global' session 行");

  // v7: pursuit 表及声明式 drive 支持
  assert.ok(tableExists(db, 'memory_pursuits'));
  assert.ok(tableExists(db, 'memory_drive_configs'));
  assert.ok(tableExists(db, 'memory_drive_outcomes'));
  // v7: 六张 self 域老表都补了 root_pursuit_id 冗余列
  for (const t of [
    'memory_facts',
    'memory_notes',
    'memory_skills',
    'memory_schedules',
    'memory_calendar',
    'memory_access_log',
  ]) {
    assert.ok(hasColumn(db, t, 'root_pursuit_id'), `${t} 缺 root_pursuit_id`);
  }

  // v4: memory_schedules.created_by
  assert.ok(hasColumn(db, 'memory_schedules', 'created_by'), 'memory_schedules 缺 created_by');

  // v5: memory_skills.kind (positive/negative 极性)
  assert.ok(hasColumn(db, 'memory_skills', 'kind'), 'memory_skills 缺 kind');

  // v6: memory_raw_messages_fts (消息全文索引)
  assert.ok(tableExists(db, 'memory_raw_messages_fts'), '缺 memory_raw_messages_fts');

  // 新表存在
  assert.ok(tableExists(db, 'memory_calendar'));
  assert.ok(tableExists(db, 'memory_schedules'));
  assert.ok(tableExists(db, 'memory_access_log'));

  // memory_facts 时间列
  for (const col of [
    'occurred_at',
    'valid_from',
    'valid_until',
    'last_accessed_at',
    'decay_tau_days',
    'forgotten_at',
    'fact_kind',
  ]) {
    assert.ok(hasColumn(db, 'memory_facts', col), `memory_facts 缺列 ${col}`);
  }

  // memory_notes 新列
  for (const col of ['last_accessed_at', 'forgotten_at']) {
    assert.ok(hasColumn(db, 'memory_notes', col), `memory_notes 缺列 ${col}`);
  }

  // memory_skills 反馈环列
  for (const col of ['success_count', 'failure_count', 'last_failure_at']) {
    assert.ok(hasColumn(db, 'memory_skills', col), `memory_skills 缺列 ${col}`);
  }

  // memory_actions 回链列
  assert.ok(hasColumn(db, 'memory_actions', 'linked_skill'));

  // v12: routing_rules 表
  assert.ok(tableExists(db, 'routing_rules'));

  // v13: K8 主动性层
  assert.ok(tableExists(db, 'memory_initiatives'));
  assert.ok(tableExists(db, 'autonomous_budget'));
  for (const col of [
    'kind', 'driver', 'target_ref', 'rationale', 'utility', 'status',
    'budget_estimate', 'budget_actual', 'outcome_summary', 'outcome_refs',
    'error', 'created_at', 'started_at', 'completed_at',
  ]) {
    assert.ok(hasColumn(db, 'memory_initiatives', col), `memory_initiatives 缺 ${col}`);
  }
  for (const col of ['user_id', 'date', 'llm_tokens_used', 'tool_calls_used', 'initiatives_run']) {
    assert.ok(hasColumn(db, 'autonomous_budget', col), `autonomous_budget 缺 ${col}`);
  }

  // v14: 主动推送订阅
  assert.ok(tableExists(db, 'push_subscriptions'));
  for (const col of [
    'channel', 'peer', 'enabled',
    'quiet_start_hour', 'quiet_end_hour', 'timezone',
    'digest_min_interval_ms', 'urgent_min_interval_ms',
    'last_digest_at', 'last_urgent_at',
    'created_at', 'updated_at',
  ]) {
    assert.ok(hasColumn(db, 'push_subscriptions', col), `push_subscriptions 缺 ${col}`);
  }
});

test('migration v2 → v3: preserves data, adds missing columns and tables', () => {
  const db = new Database(':memory:');

  // 手建 v2 schema 的子集(facts / notes / skills / actions / meta)
  db.exec(`
    CREATE TABLE memory_facts (
      id            TEXT PRIMARY KEY,
      namespace     TEXT NOT NULL,
      key           TEXT NOT NULL,
      value_json    TEXT NOT NULL,
      confidence    REAL NOT NULL DEFAULT 1.0,
      superseded_by TEXT,
      supersedes    TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE memory_notes (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      session_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE memory_skills (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      description      TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL,
      action_template  TEXT NOT NULL,
      use_count        INTEGER NOT NULL DEFAULT 0,
      last_used_at     INTEGER,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE memory_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      trigger     TEXT,
      tool_name   TEXT NOT NULL,
      params_json TEXT NOT NULL,
      result      TEXT,
      success     INTEGER NOT NULL,
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('schema_version', '2');
  `);

  // 写入 v2 旧数据
  db.prepare(
    `INSERT INTO memory_facts (id, namespace, key, value_json, created_at)
     VALUES ('f1', 'user', 'name', '"张三"', 1000)`
  ).run();
  db.prepare(
    `INSERT INTO memory_notes (id, content, created_at)
     VALUES ('n1', '一条旧笔记', 1000)`
  ).run();
  db.prepare(
    `INSERT INTO memory_skills (id, name, description, trigger_keywords, action_template, created_at)
     VALUES ('s1', 'skill-x', '测试', '[]', 'template', 1000)`
  ).run();

  // 跑迁移
  initSchema(db);

  // 版本已升级
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);

  // 旧数据保留
  const fact = db
    .prepare(`SELECT * FROM memory_facts WHERE id = ?`)
    .get('f1') as {
    namespace: string;
    value_json: string;
    fact_kind: string;
    occurred_at: number | null;
  };
  assert.equal(fact.namespace, 'user');
  assert.equal(fact.value_json, '"张三"');
  // 新列存在且为默认值
  assert.equal(fact.fact_kind, 'state');
  assert.equal(fact.occurred_at, null);

  const note = db
    .prepare(`SELECT * FROM memory_notes WHERE id = ?`)
    .get('n1') as { content: string; forgotten_at: number | null };
  assert.equal(note.content, '一条旧笔记');
  assert.equal(note.forgotten_at, null);

  const skill = db
    .prepare(`SELECT * FROM memory_skills WHERE id = ?`)
    .get('s1') as {
    name: string;
    success_count: number;
    failure_count: number;
    kind: string;
  };
  assert.equal(skill.name, 'skill-x');
  assert.equal(skill.success_count, 0);
  assert.equal(skill.failure_count, 0);
  // v5 迁移: 老 Skill kind 默认 'positive'
  assert.equal(skill.kind, 'positive');

  // 新表已创建
  assert.ok(tableExists(db, 'memory_calendar'));
  assert.ok(tableExists(db, 'memory_schedules'));
  assert.ok(tableExists(db, 'memory_access_log'));
});

test('idempotent: running initSchema twice is safe', () => {
  const db = new Database(':memory:');
  initSchema(db);
  initSchema(db);
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
});

test('migration v4 → v5: existing memory_skills gets kind=positive default', () => {
  const db = new Database(':memory:');

  // 手建 v4 schema 子集(memory_skills 无 kind 列 + meta 写 '4')
  db.exec(`
    CREATE TABLE memory_skills (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      description      TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL,
      action_template  TEXT NOT NULL,
      use_count        INTEGER NOT NULL DEFAULT 0,
      last_used_at     INTEGER,
      created_at       INTEGER NOT NULL,
      success_count    INTEGER NOT NULL DEFAULT 0,
      failure_count    INTEGER NOT NULL DEFAULT 0,
      last_failure_at  INTEGER
    );
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('schema_version', '4');
  `);

  db.prepare(
    `INSERT INTO memory_skills (id, name, description, trigger_keywords, action_template, created_at)
     VALUES ('sk1', 'legacy-skill', '老技能', '[]', '步骤', 1000)`
  ).run();

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(hasColumn(db, 'memory_skills', 'kind'));

  const row = db
    .prepare(`SELECT kind FROM memory_skills WHERE id = ?`)
    .get('sk1') as { kind: string };
  assert.equal(row.kind, 'positive', '迁移后老 skill kind 必须默认为 positive');
});

test('migration v5 → v6: adds memory_raw_messages_fts and backfills existing messages', () => {
  const db = new Database(':memory:');

  // 手建 v5 schema 子集(raw_* 表但无 FTS + meta 写 '5')
  db.exec(`
    CREATE TABLE memory_raw_sessions (
      id         TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );
    CREATE TABLE memory_raw_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES memory_raw_sessions(id),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  INTEGER NOT NULL
    );
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('schema_version', '5');
  `);

  db.prepare(`INSERT INTO memory_raw_sessions (id, started_at) VALUES (?, ?)`).run('s1', 1000);
  db.prepare(
    `INSERT INTO memory_raw_messages (session_id, role, content, timestamp)
     VALUES (?, ?, ?, ?)`
  ).run('s1', 'user', '讨论数据库迁移的细节', 2000);
  db.prepare(
    `INSERT INTO memory_raw_messages (session_id, role, content, timestamp)
     VALUES (?, ?, ?, ?)`
  ).run('s1', 'assistant', '建议先跑 backfill 再切读路径', 3000);

  initSchema(db);

  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  assert.ok(tableExists(db, 'memory_raw_messages_fts'), '迁移后应有 FTS 虚拟表');

  // FTS 被回填:能命中"数据库"与"backfill"
  const hitRows = db
    .prepare(
      `SELECT m.content FROM memory_raw_messages m
       JOIN memory_raw_messages_fts fts ON fts.rowid = m.rowid
       WHERE memory_raw_messages_fts MATCH ?`
    )
    .all('数据库') as { content: string }[];
  assert.equal(hitRows.length, 1, 'FTS 迁移回填后应能检索旧消息');
  assert.ok(hitRows[0].content.includes('数据库'));
});

test('memory_calendar requires timezone (NOT NULL)', () => {
  const db = new Database(':memory:');
  initSchema(db);

  assert.throws(() => {
    db.prepare(
      `INSERT INTO memory_calendar (id, title, starts_at, created_at) VALUES (?, ?, ?, ?)`
    ).run('c1', '会议', 1000, 2000);
  }, /NOT NULL/);

  // 正确写入带 timezone
  db.prepare(
    `INSERT INTO memory_calendar (id, title, starts_at, timezone, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('c1', '会议', 1000, 'Asia/Shanghai', 2000);

  const row = db.prepare(`SELECT * FROM memory_calendar WHERE id = ?`).get('c1') as {
    title: string;
    timezone: string;
  };
  assert.equal(row.title, '会议');
  assert.equal(row.timezone, 'Asia/Shanghai');
});

test('memory_schedules: default enabled=1, required next_run_at', () => {
  const db = new Database(':memory:');
  initSchema(db);

  db.prepare(
    `INSERT INTO memory_schedules (id, name, next_run_at, action_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('s1', '每日反思', 9999, 'reflect', '{}', 2000);

  const row = db.prepare(`SELECT * FROM memory_schedules WHERE id = ?`).get('s1') as {
    enabled: number;
    action_type: string;
  };
  assert.equal(row.enabled, 1);
  assert.equal(row.action_type, 'reflect');
});
