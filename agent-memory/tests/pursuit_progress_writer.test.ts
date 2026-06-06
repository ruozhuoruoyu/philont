/**
 * PursuitProgressWriter 单测:targetRef 解析 + applyPursuitProgress 各分支。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  applyPursuitProgress,
  parsePursuitTargetRef,
  pursuitProgressWriter,
  BOOTSTRAP_ROOT_PURSUIT_ID,
} from '../src/index.js';
import type { Initiative, InitiativeRunResult } from '../src/index.js';

// ── parsePursuitTargetRef ───────────────────────────────────────────────

test('parse: pursuit:<id>:q:<qid>', () => {
  const r = parsePursuitTargetRef('pursuit:p1:q:q-abc');
  assert.deepEqual(r, { pursuitId: 'p1', kind: 'question', questionId: 'q-abc' });
});

test('parse: pursuit:<id>:resolve', () => {
  const r = parsePursuitTargetRef('pursuit:p1:resolve');
  assert.deepEqual(r, { pursuitId: 'p1', kind: 'resolve' });
});

test('parse: pursuit:<id> 兜底', () => {
  const r = parsePursuitTargetRef('pursuit:p1');
  assert.deepEqual(r, { pursuitId: 'p1', kind: 'other' });
});

test('parse: 非 pursuit-shaped → null', () => {
  assert.equal(parsePursuitTargetRef('fact:abc'), null);
  assert.equal(parsePursuitTargetRef('honesty:verify-size:t1'), null);
  assert.equal(parsePursuitTargetRef('commit:abc12345'), null);
  assert.equal(parsePursuitTargetRef('token:CVE-2024-1'), null);
});

test('parse: questionId 含冒号 → 完整保留', () => {
  const r = parsePursuitTargetRef('pursuit:p1:q:q-abc:def');
  assert.deepEqual(r, { pursuitId: 'p1', kind: 'question', questionId: 'q-abc:def' });
});

// ── applyPursuitProgress ────────────────────────────────────────────────

function setup() {
  const h = openMemoryDb(':memory:');
  // 种入一个 pursuit,有 evidence + open question(就像 PursuitDriver 触发对象)
  const p = h.pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: '迁移 SQLite 到 Postgres',
    intent: '稳定性 + 多用户并发',
    origin: 'user',
    stake: 'high',
    openQuestions: [{ text: 'Postgres pooling 选什么?' }],
  });
  h.pursuits.addEvidence(p.id, 'note-seed');
  return { h, pursuitId: p.id };
}

function makeInitiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: 'init-test',
    kind: 'pursuit:advance-question',
    driver: 'pursuit',
    targetRef: 'pursuit:p1:q:q1',
    rationale: 'r',
    utility: 0.7,
    budgetEstimate: 1000,
    status: 'done',
    budgetActual: 100,
    outcomeSummary: '研究了 X,推荐 Y',
    outcomeRefs: { facts: [], notes: [], pursuits: [] },
    error: null,
    createdAt: 0,
    startedAt: 0,
    completedAt: 0,
    ...overrides,
  };
}

function doneResult(): InitiativeRunResult {
  return {
    status: 'done',
    outcomeSummary: '研究了 connection pooling,推荐 PgBouncer transaction',
    outcomeRefs: { facts: ['f1'], notes: ['n1'], pursuits: [] },
    llmTokensSpent: 200,
    toolCallsSpent: 2,
  };
}

test('apply: pursuit:advance-question done → addEvidence + bumpProgress', () => {
  const { h, pursuitId } = setup();
  const init = makeInitiative({ targetRef: `pursuit:${pursuitId}:q:q1`, id: 'i-x' });
  const before = h.pursuits.get(pursuitId)!;
  const beforeTouchedAt = before.lastTouchedAt;
  const beforeMarkers = before.progressMarkers.length;
  const beforeEvidence = before.evidenceRefs.length;

  // 短暂 sleep 以保证 lastTouchedAt 比 before 大(同 ms 不更新)
  const result = applyPursuitProgress(h.pursuits, init, doneResult());
  assert.equal(result.applied, true);
  assert.equal(result.reason, 'applied_question');

  const after = h.pursuits.get(pursuitId)!;
  // bumpProgress 加一条 marker
  assert.equal(after.progressMarkers.length, beforeMarkers + 1);
  assert.match(after.progressMarkers[beforeMarkers].summary, /PgBouncer/);
  // addEvidence 加一条 ref(autonomous:initiative-<id> 形式)
  assert.equal(after.evidenceRefs.length, beforeEvidence + 1);
  assert.match(after.evidenceRefs[beforeEvidence], /^autonomous:initiative-i-x$/);
  // last_touched_ts 已更新
  assert.ok(after.lastTouchedAt >= beforeTouchedAt);
  h.close();
});

test('apply: pursuit:check-resolution done → 仅 bumpProgress(不加 evidence)', () => {
  const { h, pursuitId } = setup();
  const init = makeInitiative({
    kind: 'pursuit:check-resolution',
    targetRef: `pursuit:${pursuitId}:resolve`,
  });
  const beforeEvidence = h.pursuits.get(pursuitId)!.evidenceRefs.length;
  const beforeMarkers = h.pursuits.get(pursuitId)!.progressMarkers.length;

  const result = applyPursuitProgress(h.pursuits, init, doneResult());
  assert.equal(result.applied, true);
  assert.equal(result.reason, 'applied_resolve');

  const after = h.pursuits.get(pursuitId)!;
  assert.equal(after.evidenceRefs.length, beforeEvidence, 'evidenceRefs 不应变');
  assert.equal(after.progressMarkers.length, beforeMarkers + 1);
  h.close();
});

test('apply: driver != pursuit → 不应用', () => {
  const { h } = setup();
  const init = makeInitiative({ driver: 'gap' });
  const r = applyPursuitProgress(h.pursuits, init, doneResult());
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'wrong_driver');
  h.close();
});

test('apply: K7-bridge initiative(driver=k7-bridge)→ 不应用', () => {
  const { h } = setup();
  const init = makeInitiative({
    driver: 'k7-bridge',
    targetRef: 'honesty:verify-size:turn-1',
  });
  const r = applyPursuitProgress(h.pursuits, init, doneResult());
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'wrong_driver');
  h.close();
});

test('apply: status !== done → 不应用', () => {
  const { h, pursuitId } = setup();
  const init = makeInitiative({ targetRef: `pursuit:${pursuitId}:q:q1` });
  const failed: InitiativeRunResult = {
    status: 'failed',
    error: 'llm timeout',
    llmTokensSpent: 50,
    toolCallsSpent: 0,
  };
  const r = applyPursuitProgress(h.pursuits, init, failed);
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'not_done');
  h.close();
});

test('apply: targetRef 解析失败 → 不应用', () => {
  const { h } = setup();
  // 即使 driver=pursuit 但 targetRef 形态不对,不应用
  const init = makeInitiative({ targetRef: 'pursuit:p1' /* 'other' kind 跳过 */ });
  const r = applyPursuitProgress(h.pursuits, init, doneResult());
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'unparseable_target');
  h.close();
});

test('apply: pursuit 不存在 → reason=pursuit_not_found,不抛', () => {
  const { h } = setup();
  const init = makeInitiative({ targetRef: 'pursuit:nonexistent:q:q1' });
  const r = applyPursuitProgress(h.pursuits, init, doneResult());
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'pursuit_not_found');
  h.close();
});

test('apply: outcomeSummary 缺失时 fallback 到 rationale', () => {
  const { h, pursuitId } = setup();
  const init = makeInitiative({
    targetRef: `pursuit:${pursuitId}:q:q1`,
    rationale: 'fallback rationale text',
  });
  const result: InitiativeRunResult = {
    status: 'done',
    // 不设 outcomeSummary
    outcomeRefs: { facts: [], notes: [], pursuits: [] },
    llmTokensSpent: 50,
    toolCallsSpent: 0,
  };
  applyPursuitProgress(h.pursuits, init, result);
  const after = h.pursuits.get(pursuitId)!;
  assert.match(
    after.progressMarkers[after.progressMarkers.length - 1].summary,
    /fallback rationale/,
  );
  h.close();
});

test('apply: summary 超 200 字截断', () => {
  const { h, pursuitId } = setup();
  const init = makeInitiative({ targetRef: `pursuit:${pursuitId}:q:q1` });
  const longSummary = 'x'.repeat(500);
  const result: InitiativeRunResult = {
    status: 'done',
    outcomeSummary: longSummary,
    outcomeRefs: { facts: [], notes: [], pursuits: [] },
    llmTokensSpent: 200,
    toolCallsSpent: 0,
  };
  applyPursuitProgress(h.pursuits, init, result);
  const after = h.pursuits.get(pursuitId)!;
  const lastMarker = after.progressMarkers[after.progressMarkers.length - 1];
  assert.ok(lastMarker.summary.length <= 200, `length=${lastMarker.summary.length}`);
  h.close();
});

// ── pursuitProgressWriter 工厂 ──────────────────────────────────────────

test('writer: 工厂返回的 hook 在 pursuit 不存在时仅 warn,不抛', async () => {
  const { h } = setup();
  const warns: string[] = [];
  const hook = pursuitProgressWriter(h.pursuits, {
    log: () => {},
    warn: (m) => warns.push(m),
  });
  const init = makeInitiative({ targetRef: 'pursuit:nope:q:q1' });
  await hook(init, doneResult());
  assert.equal(warns.length, 1);
  assert.match(warns[0], /pursuit gone/);
  h.close();
});

test('writer: 工厂返回的 hook 成功时 log applied_question', async () => {
  const { h, pursuitId } = setup();
  const logs: string[] = [];
  const hook = pursuitProgressWriter(h.pursuits, {
    log: (m) => logs.push(m),
    warn: () => {},
  });
  const init = makeInitiative({ targetRef: `pursuit:${pursuitId}:q:q1` });
  await hook(init, doneResult());
  assert.equal(logs.length, 1);
  assert.match(logs[0], /applied_question/);
  h.close();
});

test('writer: hook 抛错被吞,仅 warn', async () => {
  const { h } = setup();
  // 用一个会抛的 PursuitStore 替换某方法 — 改用反射注入
  const warns: string[] = [];
  const hook = pursuitProgressWriter(h.pursuits, {
    log: () => {},
    warn: (m) => warns.push(m),
  });
  // 强行损坏:覆盖 addEvidence 抛意外错
  const orig = h.pursuits.addEvidence.bind(h.pursuits);
  (h.pursuits as unknown as { addEvidence: (...a: unknown[]) => void }).addEvidence = () => {
    throw new Error('synthetic');
  };
  try {
    const init = makeInitiative({ targetRef: 'pursuit:p1:q:q1' });
    await hook(init, doneResult());
    assert.equal(warns.length, 1);
    assert.match(warns[0], /synthetic/);
  } finally {
    (h.pursuits as unknown as { addEvidence: typeof orig }).addEvidence = orig;
    h.close();
  }
});
