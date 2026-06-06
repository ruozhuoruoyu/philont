/**
 * PursuitStore + v7 迁移 + bootstrap 的单元测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import {
  PursuitStore,
  ConstitutionOnNonRootError,
  InvalidPursuitIdError,
  PursuitNotFoundError,
  loadConstitution,
} from '../src/pursuit.js';
import { InMemoryAuditHook } from '../src/audit.js';

function mkDb(): { db: Database.Database; pursuits: PursuitStore } {
  const db = new Database(':memory:');
  initSchema(db);
  return { db, pursuits: new PursuitStore(db) };
}

test('bootstrap: 空库 initSchema 后自动有一个 default root pursuit', () => {
  const { pursuits } = mkDb();
  const root = pursuits.getDefaultRoot();
  assert.ok(root, 'default root 应该被自动创建');
  assert.equal(root!.id, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(root!.parentPursuitId, null);
  assert.equal(root!.rootPursuitId, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(root!.isEvergreen, true);
  assert.equal(root!.status, 'active');
  assert.equal(root!.origin, 'system');
});

test('bootstrap: 幂等 — 多次 initSchema 只插入一条 root', () => {
  const db = new Database(':memory:');
  initSchema(db);
  initSchema(db);
  initSchema(db);
  const count = db
    .prepare(
      `SELECT COUNT(*) as n FROM memory_pursuits WHERE parent_pursuit_id IS NULL`
    )
    .get() as { n: number };
  assert.equal(count.n, 1);
});

test('v6 → v7 迁移：老 self 域表行的 root_pursuit_id 被回填为 default', () => {
  const db = new Database(':memory:');

  // 手建 v6 schema 完整版本(含 v3 新列),再写一行老数据。
  db.exec(`
    CREATE TABLE memory_facts (
      id               TEXT PRIMARY KEY,
      namespace        TEXT NOT NULL,
      key              TEXT NOT NULL,
      value_json       TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 1.0,
      superseded_by    TEXT,
      supersedes       TEXT,
      created_at       INTEGER NOT NULL,
      occurred_at      INTEGER,
      valid_from       INTEGER,
      valid_until      INTEGER,
      last_accessed_at INTEGER,
      decay_tau_days   REAL,
      forgotten_at     INTEGER,
      fact_kind        TEXT NOT NULL DEFAULT 'state'
    );
    CREATE TABLE memory_notes (
      id               TEXT PRIMARY KEY,
      content          TEXT NOT NULL,
      importance       REAL NOT NULL DEFAULT 0.5,
      session_id       TEXT,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER,
      forgotten_at     INTEGER
    );
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('schema_version', '6');
  `);
  db.prepare(
    `INSERT INTO memory_facts (id, namespace, key, value_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('f-legacy', 'user', 'name', '"alice"', 1000);
  db.prepare(
    `INSERT INTO memory_notes (id, content, created_at) VALUES (?, ?, ?)`
  ).run('n-legacy', '老笔记', 1000);

  initSchema(db);

  // 两行老数据都被回填
  const f = db
    .prepare(`SELECT root_pursuit_id FROM memory_facts WHERE id = ?`)
    .get('f-legacy') as { root_pursuit_id: string };
  assert.equal(f.root_pursuit_id, BOOTSTRAP_ROOT_PURSUIT_ID);
  const n = db
    .prepare(`SELECT root_pursuit_id FROM memory_notes WHERE id = ?`)
    .get('n-legacy') as { root_pursuit_id: string };
  assert.equal(n.root_pursuit_id, BOOTSTRAP_ROOT_PURSUIT_ID);

  // root pursuit 被创建
  const root = db
    .prepare(`SELECT * FROM memory_pursuits WHERE parent_pursuit_id IS NULL`)
    .get() as { id: string; title: string };
  assert.equal(root.id, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(root.title, 'general assistance');
});

test('PursuitStore: round-trip 基本读写', () => {
  const { pursuits } = mkDb();
  const created = pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    id: 'track-headaches',
    title: '追踪头疼',
    intent: '理解用户头疼的模式',
    origin: 'user',
    stake: 'medium',
    openQuestions: [{ text: '频率?' }, { text: '诱因?' }],
  });
  assert.equal(created.id, 'track-headaches');
  assert.equal(created.parentPursuitId, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(created.rootPursuitId, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(created.openQuestions.length, 2);
  assert.equal(created.openQuestions[0].status, 'open');

  const got = pursuits.get('track-headaches');
  assert.deepEqual(got, created);
});

test('PursuitStore: id 格式校验', () => {
  const { pursuits } = mkDb();
  assert.throws(
    () =>
      pursuits.createChild({
        parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
        id: 'INVALID UPPER',
        title: 't',
        intent: 'i',
        origin: 'user',
      }),
    InvalidPursuitIdError
  );
  assert.throws(
    () =>
      pursuits.createChild({
        parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
        id: '', // 空
        title: 't',
        intent: 'i',
        origin: 'user',
      }),
    InvalidPursuitIdError
  );
});

test('PursuitStore: non-root 写 constitution 字段被拒', () => {
  const { pursuits } = mkDb();
  assert.throws(
    () =>
      pursuits.createChild({
        parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
        title: 'sub',
        intent: 'something',
        origin: 'user',
        values: '不该在这里',
      }),
    ConstitutionOnNonRootError
  );
});

test('PursuitStore: setConstitution / getConstitution 只认 root', () => {
  const { pursuits } = mkDb();
  pursuits.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, {
    values: '诚实高于有用',
    redLines: ['不生成恶意代码', '不伪造用户身份'],
    driveBounds: {
      openLoop: { cooldownMs: [10_000, 3_600_000] },
    },
    pursuitGovernance: {
      llmProposedInitialStatus: 'shadow',
      llmProposedPromotionMinEvidence: 3,
    },
  });
  const c = pursuits.getConstitution(BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.ok(c);
  assert.equal(c!.values, '诚实高于有用');
  assert.deepEqual(c!.redLines, ['不生成恶意代码', '不伪造用户身份']);
  assert.deepEqual(c!.driveBounds, { openLoop: { cooldownMs: [10_000, 3_600_000] } });
  assert.equal(c!.pursuitGovernance!.llmProposedPromotionMinEvidence, 3);

  // 给子 pursuit 写 constitution 应拒
  const child = pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: 'sub',
    intent: 'x',
    origin: 'user',
  });
  assert.throws(
    () => pursuits.setConstitution(child.id, { values: 'nope' }),
    ConstitutionOnNonRootError
  );
  assert.throws(
    () => pursuits.getConstitution(child.id),
    ConstitutionOnNonRootError
  );
});

test('PursuitStore: hash 稳定性 — 相同 constitution 产出相同 hash', () => {
  const db1 = new Database(':memory:');
  initSchema(db1);
  const p1 = new PursuitStore(db1);
  const db2 = new Database(':memory:');
  initSchema(db2);
  const p2 = new PursuitStore(db2);

  const fields = {
    values: 'x',
    redLines: ['a', 'b'],
    driveBounds: { d: { p: [1, 2] as [number, number] } },
    pursuitGovernance: null,
  };
  p1.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, fields);
  p2.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, fields);

  const h1 = p1.computeConstitutionHash(BOOTSTRAP_ROOT_PURSUIT_ID);
  const h2 = p2.computeConstitutionHash(BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);

  // 改一下就不同
  p1.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, { ...fields, values: 'y' });
  assert.notEqual(p1.computeConstitutionHash(BOOTSTRAP_ROOT_PURSUIT_ID), h2);
});

test('PursuitStore: addOpenQuestion / closeOpenQuestion / bumpProgress / addEvidence', () => {
  const { pursuits } = mkDb();
  const p = pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: 't',
    intent: 'i',
    origin: 'user',
    openQuestions: [{ text: 'first?' }],
  });

  const qid = pursuits.addOpenQuestion(p.id, '诱因?', 1);
  assert.equal(pursuits.get(p.id)!.openQuestions.length, 2);

  pursuits.closeOpenQuestion(p.id, qid, 'resolved', 'fact-abc', 5);
  const after = pursuits.get(p.id)!;
  const closed = after.openQuestions.find((q) => q.id === qid);
  assert.equal(closed!.status, 'resolved');
  assert.equal(closed!.resolvedBy, 'fact-abc');

  pursuits.bumpProgress(p.id, 6, '用户确认了诱因', null);
  assert.equal(pursuits.get(p.id)!.lastProgressTurn, 6);
  assert.equal(pursuits.get(p.id)!.progressMarkers.length, 1);

  pursuits.addEvidence(p.id, 'fact-abc');
  pursuits.addEvidence(p.id, 'fact-abc'); // 幂等,不重复
  assert.equal(pursuits.get(p.id)!.evidenceRefs.length, 1);
});

test('PursuitStore: createChild 到不存在的 parent 抛 PursuitNotFoundError', () => {
  const { pursuits } = mkDb();
  assert.throws(
    () =>
      pursuits.createChild({
        parentPursuitId: 'no-such-parent',
        title: 't',
        intent: 'i',
        origin: 'user',
      }),
    PursuitNotFoundError
  );
});

test('loadConstitution: 读取 + hash + audit 落 constitution_load', () => {
  const { pursuits } = mkDb();
  pursuits.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, {
    values: '诚实',
    redLines: ['不伪造'],
    driveBounds: { openLoop: { cooldownMs: [10_000, 3_600_000] } },
  });
  const audit = new InMemoryAuditHook();
  const loaded = loadConstitution(pursuits, BOOTSTRAP_ROOT_PURSUIT_ID, audit);

  assert.equal(loaded.rootPursuitId, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(loaded.fields.values, '诚实');
  assert.equal(loaded.hash.length, 64);

  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].type, 'constitution_load');
  assert.equal(audit.events[0].data.rootPursuitId, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(audit.events[0].data.hash, loaded.hash);
  assert.equal(audit.events[0].data.origin, 'Internal');
  assert.equal(audit.events[0].data.redLineCount, 1);
  assert.deepEqual(audit.events[0].data.driveBoundKinds, ['openLoop']);
});

test('loadConstitution: 不存在的 rootId 抛 PursuitNotFoundError', () => {
  const { pursuits } = mkDb();
  assert.throws(
    () => loadConstitution(pursuits, 'nonexistent'),
    PursuitNotFoundError
  );
});

test('PursuitStore: listActive / listByStatus', () => {
  const { pursuits } = mkDb();
  pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    id: 'a',
    title: 'A',
    intent: 'i',
    origin: 'user',
  });
  pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    id: 'b',
    title: 'B',
    intent: 'i',
    origin: 'user',
  });
  pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    id: 'c-shadow',
    title: 'C',
    intent: 'i',
    origin: 'extractor',
    status: 'shadow',
  });

  const active = pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID);
  // root 本身也是 active
  assert.equal(active.length, 3);
  const shadow = pursuits.listByStatus(BOOTSTRAP_ROOT_PURSUIT_ID, 'shadow');
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].id, 'c-shadow');
});
