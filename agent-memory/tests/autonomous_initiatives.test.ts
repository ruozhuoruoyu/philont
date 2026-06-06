/**
 * InitiativeStore 单测:CRUD + 24h 去重。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, InitiativeStore } from '../src/index.js';

function setup() {
  const handle = openMemoryDb(':memory:');
  const store = new InitiativeStore(handle.db);
  return { handle, store };
}

test('initiative: insert + getById', () => {
  const { handle, store } = setup();
  const i = store.insert({
    kind: 'fact_gap',
    driver: 'gap',
    targetRef: 'fact:abc',
    rationale: 'low confidence',
    utility: 0.7,
    budgetEstimate: 1500,
  });
  assert.equal(i.status, 'pending');
  assert.equal(i.kind, 'fact_gap');
  assert.equal(i.budgetActual, null);

  const back = store.getById(i.id);
  assert.ok(back);
  assert.equal(back!.id, i.id);
  assert.equal(back!.targetRef, 'fact:abc');
  handle.close();
});

test('initiative: markRunning 仅在 pending 时生效', () => {
  const { handle, store } = setup();
  const i = store.insert({
    kind: 'k',
    driver: 'gap',
    targetRef: 't:1',
    rationale: 'r',
    utility: 0.5,
    budgetEstimate: 1000,
  });
  const r1 = store.markRunning(i.id);
  assert.ok(r1);
  assert.equal(r1!.status, 'running');
  // 重复 markRunning 应失败(已不在 pending)
  const r2 = store.markRunning(i.id);
  assert.equal(r2, null);
  handle.close();
});

test('initiative: markDone 写 outcome + 改 status', () => {
  const { handle, store } = setup();
  const i = store.insert({
    kind: 'k',
    driver: 'gap',
    targetRef: 't:done',
    rationale: 'r',
    utility: 0.5,
    budgetEstimate: 1000,
  });
  store.markRunning(i.id);
  const done = store.markDone(
    i.id,
    'looked it up, all good',
    { facts: ['f1'], notes: ['n1'], pursuits: [] },
    1234,
  );
  assert.ok(done);
  assert.equal(done!.status, 'done');
  assert.equal(done!.outcomeSummary, 'looked it up, all good');
  assert.deepEqual(done!.outcomeRefs, { facts: ['f1'], notes: ['n1'], pursuits: [] });
  assert.equal(done!.budgetActual, 1234);
  handle.close();
});

test('initiative: markFailed / markSkipped', () => {
  const { handle, store } = setup();
  const i1 = store.insert({
    kind: 'k', driver: 'd', targetRef: 't:f', rationale: 'r', utility: 0.5, budgetEstimate: 100,
  });
  store.markRunning(i1.id);
  const failed = store.markFailed(i1.id, 'llm timeout', 50);
  assert.equal(failed!.status, 'failed');
  assert.equal(failed!.error, 'llm timeout');

  const i2 = store.insert({
    kind: 'k', driver: 'd', targetRef: 't:s', rationale: 'r', utility: 0.5, budgetEstimate: 100,
  });
  const skipped = store.markSkipped(i2.id, 'budget exhausted');
  assert.equal(skipped!.status, 'skipped');
  assert.equal(skipped!.error, 'budget exhausted');
  handle.close();
});

test('initiative: 24h dedupe 集合(done + failed 都进,skipped 不进)', () => {
  const { handle, store } = setup();
  const now = Date.now();

  const a = store.insert({ kind: 'k', driver: 'd', targetRef: 't:A', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(a.id);
  store.markDone(a.id, 's', { facts: [], notes: [], pursuits: [] }, 100);

  // failed 也进集合 — 防垃圾 token 反复 propose
  const b = store.insert({ kind: 'k', driver: 'd', targetRef: 't:B', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(b.id);
  store.markFailed(b.id, 'failed', 0);

  // skipped 不进集合(没真试过,budget 解锁后应允许重试)
  const c = store.insert({ kind: 'k', driver: 'd', targetRef: 't:C', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markSkipped(c.id, 'skipped');

  const recent = store.listRecentSettledTargetRefs(24 * 60 * 60 * 1000, now + 1000);
  assert.ok(recent.has('t:A'));
  assert.ok(recent.has('t:B'), 'failed 应进 dedup ring');
  assert.ok(!recent.has('t:C'), 'skipped 不应进 dedup');

  // backwards-compat alias 应等价
  const recentLegacy = store.listRecentDoneTargetRefs(24 * 60 * 60 * 1000, now + 1000);
  assert.ok(recentLegacy.has('t:A'));
  assert.ok(recentLegacy.has('t:B'));
  handle.close();
});

test('initiative: listRecentDone since cutoff', () => {
  const { handle, store } = setup();
  const i = store.insert({ kind: 'k', driver: 'd', targetRef: 't:1', rationale: 'r', utility: 0.7, budgetEstimate: 100 });
  store.markRunning(i.id);
  store.markDone(i.id, 'first', { facts: [], notes: [], pursuits: [] }, 100);

  const list = store.listRecentDone(0, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].outcomeSummary, 'first');

  // sinceTs in the future filters out
  const future = store.listRecentDone(Date.now() + 100_000, 10);
  assert.equal(future.length, 0);
  handle.close();
});

// ── listRecent + countByStatusGroup(dashboard 用)──────────────────────

test('listRecent: 默认按 created_at DESC 限 30', () => {
  const { handle, store } = setup();
  for (let i = 0; i < 5; i++) {
    store.insert({
      kind: 'k', driver: 'gap', targetRef: `t:${i}`,
      rationale: 'r', utility: 0.5, budgetEstimate: 100,
    });
  }
  const list = store.listRecent();
  assert.equal(list.length, 5);
  // 最新的(t:4)在前
  assert.equal(list[0].targetRef, 't:4');
  handle.close();
});

test('listRecent: limit 截断', () => {
  const { handle, store } = setup();
  for (let i = 0; i < 5; i++) {
    store.insert({
      kind: 'k', driver: 'gap', targetRef: `t:${i}`,
      rationale: 'r', utility: 0.5, budgetEstimate: 100,
    });
  }
  const list = store.listRecent({ limit: 2 });
  assert.equal(list.length, 2);
  handle.close();
});

test('listRecent: 按 status 过滤', () => {
  const { handle, store } = setup();
  const i1 = store.insert({ kind: 'k', driver: 'gap', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i1.id);
  store.markDone(i1.id, 's', { facts: [], notes: [], pursuits: [] }, 100);
  store.insert({ kind: 'k', driver: 'gap', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });

  const done = store.listRecent({ status: 'done' });
  assert.equal(done.length, 1);
  assert.equal(done[0].id, i1.id);

  const pending = store.listRecent({ status: 'pending' });
  assert.equal(pending.length, 1);
  handle.close();
});

test('listRecent: 按 driver 过滤', () => {
  const { handle, store } = setup();
  store.insert({ kind: 'k', driver: 'gap', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.insert({ kind: 'k', driver: 'curiosity', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.insert({ kind: 'k', driver: 'pursuit', targetRef: 't:3', rationale: 'r', utility: 0.5, budgetEstimate: 100 });

  const gap = store.listRecent({ driver: 'gap' });
  assert.equal(gap.length, 1);
  assert.equal(gap[0].driver, 'gap');
  handle.close();
});

test('listRecent: 同时 status + driver 过滤', () => {
  const { handle, store } = setup();
  const i1 = store.insert({ kind: 'k', driver: 'gap', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i1.id);
  store.markDone(i1.id, 's', { facts: [], notes: [], pursuits: [] }, 100);
  store.insert({ kind: 'k', driver: 'curiosity', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });

  const r = store.listRecent({ status: 'done', driver: 'gap' });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, i1.id);

  const r2 = store.listRecent({ status: 'done', driver: 'curiosity' });
  assert.equal(r2.length, 0);
  handle.close();
});

test('countByStatusGroup: 全 5 档,缺省 0', () => {
  const { handle, store } = setup();
  // 0 condition
  const empty = store.countByStatusGroup();
  assert.deepEqual(empty, { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 });

  // 注入混合状态
  const i1 = store.insert({ kind: 'k', driver: 'd', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i1.id);
  store.markDone(i1.id, 's', { facts: [], notes: [], pursuits: [] }, 100);

  const i2 = store.insert({ kind: 'k', driver: 'd', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i2.id);
  store.markFailed(i2.id, 'err', 50);

  store.insert({ kind: 'k', driver: 'd', targetRef: 't:3', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  // pending

  const counts = store.countByStatusGroup();
  assert.equal(counts.done, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.pending, 1);
  assert.equal(counts.running, 0);
  assert.equal(counts.skipped, 0);
  handle.close();
});
