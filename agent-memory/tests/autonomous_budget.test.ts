/**
 * BudgetTracker 单测:三级预算门 + 跨 tick reset + 跨日 reset。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, BudgetTracker, utcDateString } from '../src/index.js';

function setup(caps?: Partial<Parameters<typeof newTracker>[1]>) {
  const handle = openMemoryDb(':memory:');
  const tracker = newTracker(handle.db, caps);
  return { handle, tracker };
}

function newTracker(db: ReturnType<typeof openMemoryDb>['db'], caps?: Partial<{
  dailyTokens: number;
  dailyToolCalls: number;
  perTickTokens: number;
  perTickInitiatives: number;
  perInitiativeTokens: number;
}>) {
  return new BudgetTracker(db, {
    dailyTokens: 10_000,
    dailyToolCalls: 30,
    perTickTokens: 3_000,
    perTickInitiatives: 2,
    perInitiativeTokens: 1_500,
    ...caps,
  });
}

test('budget: 起步无消耗 → checkCanRun 允许', () => {
  const { handle, tracker } = setup();
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, true);
  assert.equal(r.effectivePerInitiativeTokens, 1500);
  handle.close();
});

test('budget: commit 累积到 daily + perTick 桶', () => {
  const { handle, tracker } = setup();
  tracker.resetTick('alice');
  tracker.commit('alice', { llmTokens: 500, toolCalls: 3 });

  const daily = tracker.getDailyUsage('alice');
  assert.equal(daily.llmTokensUsed, 500);
  assert.equal(daily.toolCallsUsed, 3);
  assert.equal(daily.initiativesRun, 1);

  const tick = tracker.getTickUsage('alice');
  assert.equal(tick.llmTokensUsed, 500);
  assert.equal(tick.initiativesRun, 1);
  handle.close();
});

test('budget: per-tick initiative 上限', () => {
  const { handle, tracker } = setup({ perTickInitiatives: 2 });
  tracker.resetTick('alice');
  tracker.commit('alice', { llmTokens: 100, toolCalls: 1 });
  tracker.commit('alice', { llmTokens: 100, toolCalls: 1 });
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, false);
  assert.match(r.reason ?? '', /per-tick initiative/);
  handle.close();
});

test('budget: per-tick token 上限', () => {
  const { handle, tracker } = setup({ perTickTokens: 1000, perTickInitiatives: 100 });
  tracker.resetTick('alice');
  tracker.commit('alice', { llmTokens: 1000, toolCalls: 1 });
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, false);
  assert.match(r.reason ?? '', /per-tick token/);
  handle.close();
});

test('budget: daily token 上限', () => {
  const { handle, tracker } = setup({ dailyTokens: 800, perTickTokens: 10_000, perTickInitiatives: 100 });
  tracker.resetTick('alice');
  tracker.commit('alice', { llmTokens: 800, toolCalls: 1 });
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, false);
  assert.match(r.reason ?? '', /daily token/);
  handle.close();
});

test('budget: resetTick 清 perTick 但不动 daily', () => {
  const { handle, tracker } = setup();
  tracker.resetTick('alice');
  tracker.commit('alice', { llmTokens: 500, toolCalls: 3 });
  tracker.resetTick('alice');
  const tick = tracker.getTickUsage('alice');
  assert.equal(tick.llmTokensUsed, 0);
  assert.equal(tick.initiativesRun, 0);
  const daily = tracker.getDailyUsage('alice');
  assert.equal(daily.llmTokensUsed, 500);
  handle.close();
});

test('budget: 跨日 daily 桶相互独立', () => {
  const { handle, tracker } = setup({
    dailyTokens: 10_000,
    perTickTokens: 100_000,
    perTickInitiatives: 100,
  });
  const day1 = Date.UTC(2026, 4, 5, 23, 30); // 2026-05-05
  const day2 = Date.UTC(2026, 4, 6, 0, 30);  // 2026-05-06

  tracker.commit('alice', { llmTokens: 9000, toolCalls: 5 }, day1);
  // day1 桶里 alice 用了 9000;day2 桶应该 0
  const day1Usage = tracker.getDailyUsage('alice', day1);
  assert.equal(day1Usage.llmTokensUsed, 9000);
  const day2Usage = tracker.getDailyUsage('alice', day2);
  assert.equal(day2Usage.llmTokensUsed, 0);

  // resetTick 后 day1 仍可继续(还差 1000 就达上限)
  tracker.resetTick('alice');
  const r1 = tracker.checkCanRun('alice', day1);
  assert.equal(r1.allowed, true);

  // day2 视角下 daily 桶清空
  const r2 = tracker.checkCanRun('alice', day2);
  assert.equal(r2.allowed, true);
  assert.equal(r2.effectivePerInitiativeTokens, 1500);

  // 不同 user_id 互不干扰
  const bobDaily = tracker.getDailyUsage('bob', day1);
  assert.equal(bobDaily.llmTokensUsed, 0);
  handle.close();
});

test('budget: utcDateString 形如 YYYY-MM-DD', () => {
  const s = utcDateString(Date.UTC(2026, 4, 6, 12, 0));
  assert.equal(s, '2026-05-06');
});

test('budget: effectivePerInitiativeTokens 取 min(perInit, daily余, tick余)', () => {
  const { handle, tracker } = setup({
    perInitiativeTokens: 5000,
    dailyTokens: 800,
    perTickTokens: 10_000,
    perTickInitiatives: 100,
  });
  tracker.resetTick('alice');
  // daily 还剩 800,perInit=5000,tick=10K → 取 800
  const r = tracker.checkCanRun('alice');
  assert.equal(r.effectivePerInitiativeTokens, 800);
  handle.close();
});

// ── 0 = unlimited 语义(2026-05-06 修正,5 个 cap 全部一致)──────────────

test('budget: dailyTokens=0 → 无限制(已写过的语义,这里再校验)', () => {
  const { handle, tracker } = setup({
    dailyTokens: 0,
    dailyToolCalls: 0,
    perTickTokens: 0,
    perTickInitiatives: 0,
  });
  // 灌大量 token,只有 dailyTokens 0 = unlimited 才能通过
  tracker.commit('alice', { llmTokens: 999_999_999, toolCalls: 1 });
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, true);
  handle.close();
});

test('budget: perTickInitiatives=0 → 无限制(原来是永远拦,修复)', () => {
  const { handle, tracker } = setup({
    perTickInitiatives: 0,
    perTickTokens: 0,
    dailyTokens: 0,
    dailyToolCalls: 0,
  });
  tracker.resetTick('alice');
  for (let i = 0; i < 50; i++) {
    tracker.commit('alice', { llmTokens: 100, toolCalls: 1 });
  }
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, true, '50 个 initiative 后仍然允许');
  handle.close();
});

test('budget: perTickTokens=0 → 无限制', () => {
  const { handle, tracker } = setup({ perTickTokens: 0, perTickInitiatives: 100, dailyTokens: 100_000 });
  tracker.resetTick('alice');
  tracker.commit('alice', { llmTokens: 99_999, toolCalls: 1 });
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, true);
  handle.close();
});

test('budget: perInitiativeTokens=0 → effective 给保底 1M,不返 0/Infinity', () => {
  const { handle, tracker } = setup({ perInitiativeTokens: 0, dailyTokens: 0, perTickTokens: 0, perTickInitiatives: 0 });
  tracker.resetTick('alice');
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, true);
  assert.equal(Number.isFinite(r.effectivePerInitiativeTokens), true);
  assert.ok(r.effectivePerInitiativeTokens >= 1_000, `应有保底,实际=${r.effectivePerInitiativeTokens}`);
  handle.close();
});

test('budget: 全 5 cap=0 → 完全无限制(调试用)', () => {
  const { handle, tracker } = setup({
    dailyTokens: 0,
    dailyToolCalls: 0,
    perTickTokens: 0,
    perTickInitiatives: 0,
    perInitiativeTokens: 0,
  });
  tracker.resetTick('alice');
  // 灌满量
  for (let i = 0; i < 100; i++) {
    tracker.commit('alice', { llmTokens: 999_999, toolCalls: 999 });
  }
  const r = tracker.checkCanRun('alice');
  assert.equal(r.allowed, true);
  handle.close();
});
