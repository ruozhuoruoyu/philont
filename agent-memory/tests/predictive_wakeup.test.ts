/**
 * 预测式预动(2026-05-29)单测:deadline pursuit → 调度软唤醒。
 *
 * projectPursuitWakeup 纯函数 + reconcilePredictiveWakeups 期望态 reconcile(真
 * ScheduleStore,注入 now)+ 端到端(reconcile 建 schedule → dueBefore 命中)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  projectPursuitWakeup,
  reconcilePredictiveWakeups,
  buildPursuitPreactionPrompt,
} from '../src/index.js';
import type { Pursuit } from '../src/types.js';

const HOUR = 3600_000;
const MIN = 60_000;
const NOW = 1_700_000_000_000;

function mkPursuit(over: Partial<Pursuit> = {}): Pursuit {
  return {
    id: 'p1',
    parentPursuitId: 'root',
    rootPursuitId: 'root',
    title: '测试承诺',
    intent: '做完某件事',
    status: 'active',
    isEvergreen: false,
    stake: 'high',
    deadline: null,
    origin: 'user',
    openQuestions: [],
    resolutionCriteria: null,
    evidenceRefs: [],
    progressMarkers: [],
    lastProgressTurn: 0,
    lastTouchedAt: NOW,
    stakeWeight: 8,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Pursuit;
}

// ── projectPursuitWakeup ──────────────────────────────────────────────

test('project: 无 deadline → null', () => {
  assert.equal(projectPursuitWakeup(mkPursuit({ deadline: null }), NOW), null);
});

test('project: evergreen → null', () => {
  assert.equal(projectPursuitWakeup(mkPursuit({ isEvergreen: true, deadline: NOW + 2 * HOUR }), NOW), null);
});

test('project: 非 active → null', () => {
  assert.equal(projectPursuitWakeup(mkPursuit({ status: 'paused', deadline: NOW + 2 * HOUR }), NOW), null);
});

test('project: stake 不足(<7) → null', () => {
  assert.equal(projectPursuitWakeup(mkPursuit({ stakeWeight: 5, deadline: NOW + 2 * HOUR }), NOW), null);
});

test('project: deadline 超 horizon(>7d) → null', () => {
  assert.equal(projectPursuitWakeup(mkPursuit({ deadline: NOW + 8 * 24 * HOUR }), NOW), null);
});

test('project: 已进 lead 窗(wake<=now) → null', () => {
  // deadline 距今 < lead(30min) → wake <= now
  assert.equal(projectPursuitWakeup(mkPursuit({ deadline: NOW + 20 * MIN }), NOW), null);
});

test('project: 正常 → deadline - leadMs', () => {
  const wake = projectPursuitWakeup(mkPursuit({ deadline: NOW + 2 * HOUR }), NOW);
  assert.equal(wake, NOW + 2 * HOUR - 30 * MIN); // = NOW + 90min
});

test('project: 自定义 lead/minStake 生效', () => {
  const wake = projectPursuitWakeup(
    mkPursuit({ deadline: NOW + 2 * HOUR, stakeWeight: 6 }),
    NOW,
    { leadMs: 10 * MIN, minStake: 6 },
  );
  assert.equal(wake, NOW + 2 * HOUR - 10 * MIN);
});

// ── reconcilePredictiveWakeups ────────────────────────────────────────

function freshSchedules() {
  return openMemoryDb(':memory:').schedules;
}

test('reconcile: 建一个 predict 唤醒 @ deadline-lead', () => {
  const schedules = freshSchedules();
  const p = mkPursuit({ deadline: NOW + 2 * HOUR });
  const r = reconcilePredictiveWakeups({ pursuits: [p], now: NOW, schedules });
  assert.equal(r.created, 1);
  const s = schedules.findByName('predict:pursuit:p1');
  assert.ok(s);
  assert.equal(s!.nextRunAt, NOW + 90 * MIN);
  assert.equal(s!.actionType, 'autonomous_turn');
  assert.equal(s!.cronExpr, null); // one-shot
});

test('reconcile: 容差内重复 tick 不重建(幂等)', () => {
  const schedules = freshSchedules();
  const p = mkPursuit({ deadline: NOW + 2 * HOUR });
  reconcilePredictiveWakeups({ pursuits: [p], now: NOW, schedules });
  const r2 = reconcilePredictiveWakeups({ pursuits: [p], now: NOW + 30_000, schedules }); // +30s < 60s 容差
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 0);
  assert.equal(schedules.list({ enabledOnly: true }).length, 1);
});

test('reconcile: deadline 改 → 改期(update)', () => {
  const schedules = freshSchedules();
  const p = mkPursuit({ deadline: NOW + 2 * HOUR });
  reconcilePredictiveWakeups({ pursuits: [p], now: NOW, schedules });
  const p2 = mkPursuit({ deadline: NOW + 4 * HOUR });
  const r = reconcilePredictiveWakeups({ pursuits: [p2], now: NOW, schedules });
  assert.equal(r.updated, 1);
  const s = schedules.findByName('predict:pursuit:p1');
  assert.equal(s!.nextRunAt, NOW + 4 * HOUR - 30 * MIN); // 改到 now+3.5h
  assert.equal(schedules.list({ enabledOnly: true }).length, 1); // 仍只一个 enabled
});

test('reconcile: stake 降到不足 → 取消', () => {
  const schedules = freshSchedules();
  reconcilePredictiveWakeups({ pursuits: [mkPursuit({ deadline: NOW + 2 * HOUR })], now: NOW, schedules });
  const r = reconcilePredictiveWakeups({
    pursuits: [mkPursuit({ deadline: NOW + 2 * HOUR, stakeWeight: 5 })],
    now: NOW,
    schedules,
  });
  assert.equal(r.cancelled, 1);
  assert.equal(schedules.findByName('predict:pursuit:p1'), null);
});

test('reconcile: pursuit 不在 active 集合 → 孤儿清扫', () => {
  const schedules = freshSchedules();
  reconcilePredictiveWakeups({ pursuits: [mkPursuit({ deadline: NOW + 2 * HOUR })], now: NOW, schedules });
  // 下个 tick pursuit 已 close(listActive 不再含)→ pursuits=[]
  const r = reconcilePredictiveWakeups({ pursuits: [], now: NOW, schedules });
  assert.equal(r.cancelled, 1);
  assert.equal(schedules.list({ enabledOnly: true }).length, 0);
});

test('reconcile: 不为无资格 pursuit 建唤醒', () => {
  const schedules = freshSchedules();
  const r = reconcilePredictiveWakeups({
    pursuits: [
      mkPursuit({ id: 'a', deadline: null }), // 无 deadline
      mkPursuit({ id: 'b', deadline: NOW + 8 * 24 * HOUR }), // 超 horizon
      mkPursuit({ id: 'c', stakeWeight: 3, deadline: NOW + 2 * HOUR }), // stake 低
    ],
    now: NOW,
    schedules,
  });
  assert.equal(r.created, 0);
  assert.equal(schedules.list({ enabledOnly: true }).length, 0);
});

// ── 端到端:reconcile 建的唤醒到点被 scheduler 视为 due ──────────────

test('e2e: reconcile 建的唤醒在 wake 时刻被 dueBefore 命中', () => {
  const schedules = freshSchedules();
  const p = mkPursuit({ deadline: NOW + 2 * HOUR });
  reconcilePredictiveWakeups({ pursuits: [p], now: NOW, schedules });
  const wake = NOW + 90 * MIN;
  // wake 之前不 due
  assert.equal(schedules.dueBefore(wake - 1).length, 0);
  // wake 时刻 due,且就是我们的 predict 唤醒
  const due = schedules.dueBefore(wake);
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'predict:pursuit:p1');
  // payload.prompt 是预动指令
  const payload = due[0].payload as { prompt?: string };
  assert.ok(payload.prompt && payload.prompt.includes('Predictive pre-action'));
});

// ── buildPursuitPreactionPrompt ──────────────────────────────────────

test('prompt: 含承诺信息 + 只读约束 + 防御句', () => {
  const p = mkPursuit({
    title: '续约保险',
    deadline: NOW + 2 * HOUR,
    resolutionCriteria: '保单已续',
    openQuestions: [
      { id: 'q1', text: '哪家便宜', status: 'open', createdTurn: 1, updatedTurn: 1 },
      { id: 'q2', text: '已答', status: 'resolved', createdTurn: 1, updatedTurn: 2 },
    ],
  });
  const s = buildPursuitPreactionPrompt(p);
  assert.ok(s.includes('续约保险'));
  assert.ok(s.includes('保单已续'));
  assert.ok(s.includes('哪家便宜'));
  assert.ok(!s.includes('已答')); // resolved 问题不列
  assert.ok(s.includes('read-only'));
  assert.ok(s.includes('Guard'));
});
