/**
 * 主动研究回路(v24)单测。
 *
 * 覆盖:
 *   - PursuitDriver:isActiveResearch active pursuit **不等 staleness 即推进**最早
 *     open question;utility=0.9;24h dedup;无 open question → check-resolution(0.85)。
 *   - ProgressWriter 收敛:advance-question done + questionAnswered → closeOpenQuestion
 *     + research_iterations++;问题答完 / 到上限 → isActiveResearch 清零。
 *   - research_focus 工具:start 建 active pursuit;stop 清标记。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PursuitDriver,
  openMemoryDb,
  applyPursuitProgress,
  MAX_RESEARCH_ITERATIONS,
  createResearchTools,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  type MemorySnapshot,
} from '../src/index.js';
import type { Pursuit, OpenQuestion, Initiative, InitiativeRunResult } from '../src/index.js';

const NOW = 1_750_000_000_000;

function snap(partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    facts: [], routingRules: [], skills: [], activePursuits: [],
    recentTimelineTokens: [], recentDoneTargetRefs: new Set(), now: NOW,
    ...partial,
  };
}

function openQ(over: Partial<OpenQuestion> = {}): OpenQuestion {
  return { id: 'q1', text: '问题?', status: 'open', createdTurn: 1, updatedTurn: 1, ...over };
}

function pursuit(over: Partial<Pursuit> = {}): Pursuit {
  return {
    id: 'r1', parentPursuitId: 'default', rootPursuitId: 'default',
    title: '研究 X', intent: '持续研究 X', status: 'active', isEvergreen: false,
    stake: 'high', deadline: null, origin: 'user',
    openQuestions: [openQ()], resolutionCriteria: null,
    evidenceRefs: [], // 主动研究**不要求** evidence(全新 pursuit 也能推)
    progressMarkers: [], lastProgressTurn: 0,
    values: null, redLines: null, driveBounds: null, pursuitGovernance: null,
    lastTouchedAt: NOW - 60_000, // 刚 1 分钟前碰过 —— 普通 PursuitDriver 绝不会推
    stakeWeight: 8, isActiveResearch: true, researchIterations: 0,
    createdAt: NOW - 120_000, updatedAt: NOW - 60_000,
    ...over,
  };
}

// ── PursuitDriver 主动研究路径 ────────────────────────────────────────

test('driver: 主动研究 pursuit 不等 staleness 即推进最早 open question', () => {
  const d = new PursuitDriver();
  const p = pursuit({
    openQuestions: [openQ({ id: 'q1', createdTurn: 2 }), openQ({ id: 'q0', createdTurn: 1 })],
  });
  const out = d.propose(snap({ activePursuits: [p] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'pursuit:advance-question');
  assert.equal(out[0].targetRef, 'pursuit:r1:q:q0'); // createdTurn 最早
  assert.equal(out[0].utility, 0.9); // 固定高 utility
});

test('driver: 普通(非主动)pursuit 刚碰过则不推(对照)', () => {
  const d = new PursuitDriver();
  const p = pursuit({ isActiveResearch: false, evidenceRefs: ['e1'] });
  const out = d.propose(snap({ activePursuits: [p] }));
  assert.equal(out.length, 0); // lastTouched 1min 前 < 7 天阈值
});

test('driver: 主动研究 24h dedup —— 同问题不重戳', () => {
  const d = new PursuitDriver();
  const p = pursuit();
  const out = d.propose(snap({ activePursuits: [p], recentDoneTargetRefs: new Set(['pursuit:r1:q:q1']) }));
  assert.equal(out.length, 0);
});

test('driver: 主动研究无 open question → check-resolution(0.85)', () => {
  const d = new PursuitDriver();
  const p = pursuit({ openQuestions: [], resolutionCriteria: '收集 3 个来源' });
  const out = d.propose(snap({ activePursuits: [p] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'pursuit:check-resolution');
  assert.equal(out[0].utility, 0.85);
});

// ── ProgressWriter 收敛(真 PursuitStore)────────────────────────────

function seedActivePursuit(questions: { id?: string; text: string }[]): {
  pursuits: ReturnType<typeof openMemoryDb>['pursuits'];
  id: string;
} {
  const mem = openMemoryDb(':memory:');
  const root = mem.pursuits.getDefaultRoot()!;
  const p = mem.pursuits.createChild({
    parentPursuitId: root.id, title: '研究 X', intent: '持续研究 X',
    origin: 'user', stake: 'high', isActiveResearch: true,
    openQuestions: questions.map((q) => ({ text: q.text })),
  });
  return { pursuits: mem.pursuits, id: p.id };
}

function doneInit(targetRef: string, questionAnswered: boolean): { init: Initiative; res: InitiativeRunResult } {
  const init = {
    id: 'i1', kind: 'pursuit:advance-question', driver: 'pursuit', targetRef,
    rationale: 'r', utility: 0.9, status: 'done',
  } as unknown as Initiative;
  const res: InitiativeRunResult = {
    status: 'done', outcomeSummary: '发现…', questionAnswered,
    llmTokensSpent: 100, toolCallsSpent: 1,
  };
  return { init, res };
}

test('writer: questionAnswered=true → 关掉该 question + iterations++', () => {
  const { pursuits, id } = seedActivePursuit([{ text: 'Q1' }, { text: 'Q2' }]);
  const qid = pursuits.get(id)!.openQuestions[0].id;
  const { init, res } = doneInit(`pursuit:${id}:q:${qid}`, true);
  const r = applyPursuitProgress(pursuits, init, res);
  assert.equal(r.applied, true);
  const after = pursuits.get(id)!;
  assert.equal(after.openQuestions.find((q) => q.id === qid)!.status, 'resolved');
  assert.equal(after.researchIterations, 1);
  assert.equal(after.isActiveResearch, true); // 还有 Q2 open,不歇火
});

test('writer: 最后一个问题答完 → isActiveResearch 自动清零', () => {
  const { pursuits, id } = seedActivePursuit([{ text: '唯一问题' }]);
  const qid = pursuits.get(id)!.openQuestions[0].id;
  const { init, res } = doneInit(`pursuit:${id}:q:${qid}`, true);
  applyPursuitProgress(pursuits, init, res);
  const after = pursuits.get(id)!;
  assert.equal(after.openQuestions[0].status, 'resolved');
  assert.equal(after.isActiveResearch, false); // 无 open question 剩 → 歇火
});

test('writer: questionAnswered=false → 不关问题,但仍计 iteration', () => {
  const { pursuits, id } = seedActivePursuit([{ text: 'Q1' }]);
  const qid = pursuits.get(id)!.openQuestions[0].id;
  const { init, res } = doneInit(`pursuit:${id}:q:${qid}`, false);
  applyPursuitProgress(pursuits, init, res);
  const after = pursuits.get(id)!;
  assert.equal(after.openQuestions[0].status, 'open'); // 没答上,留着
  assert.equal(after.researchIterations, 1);
  assert.equal(after.isActiveResearch, true);
});

test('writer: 到迭代上限强制歇火(即使问题没答完)', () => {
  const { pursuits, id } = seedActivePursuit([{ text: 'Q1' }]);
  const qid = pursuits.get(id)!.openQuestions[0].id;
  // 预先把 iterations 顶到 上限-1
  for (let i = 0; i < MAX_RESEARCH_ITERATIONS - 1; i++) pursuits.bumpResearchIterations(id);
  const { init, res } = doneInit(`pursuit:${id}:q:${qid}`, false);
  applyPursuitProgress(pursuits, init, res); // 第 MAX 次
  const after = pursuits.get(id)!;
  assert.ok(after.researchIterations >= MAX_RESEARCH_ITERATIONS);
  assert.equal(after.isActiveResearch, false);
});

// ── research_focus 工具 ──────────────────────────────────────────────

test('tool: start 建 active 研究 pursuit;stop 清标记', async () => {
  const mem = openMemoryDb(':memory:');
  const [tool] = createResearchTools(mem.pursuits);
  const r = await tool.execute({
    action: 'start', title: '研究 Y', intent: '持续研究 Y',
    questions: ['Y 的现状?', 'Y 的难点?'],
  });
  assert.equal(r.success, true);
  const active = mem.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID).filter((p) => p.isActiveResearch);
  assert.equal(active.length, 1);
  assert.equal(active[0].openQuestions.length, 2);

  const stop = await tool.execute({ action: 'stop', pursuitId: active[0].id });
  assert.equal(stop.success, true);
  assert.equal(mem.pursuits.get(active[0].id)!.isActiveResearch, false);
});

test('tool: start 缺 questions → 报错', async () => {
  const mem = openMemoryDb(':memory:');
  const [tool] = createResearchTools(mem.pursuits);
  const r = await tool.execute({ action: 'start', title: 'X', intent: 'x', questions: [] });
  assert.equal(r.success, false);
});
