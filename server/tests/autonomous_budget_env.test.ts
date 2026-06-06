/**
 * autonomous budget caps env 解析单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET_CAPS } from '../../agent-memory/src/index.js';
import {
  resolveAutonomousBudgetCaps,
  describeBudgetCapsOverrides,
} from '../src/autonomous_budget_env.js';

test('resolve: 全空 env → 全部走 default', () => {
  const caps = resolveAutonomousBudgetCaps({});
  assert.deepEqual(caps, DEFAULT_BUDGET_CAPS);
});

test('resolve: dailyTokens 覆盖', () => {
  const caps = resolveAutonomousBudgetCaps({
    PHILONT_AUTONOMOUS_DAILY_TOKENS: '50000',
  });
  assert.equal(caps.dailyTokens, 50000);
  assert.equal(caps.dailyToolCalls, DEFAULT_BUDGET_CAPS.dailyToolCalls);
});

test('resolve: 全部 5 路覆盖', () => {
  const caps = resolveAutonomousBudgetCaps({
    PHILONT_AUTONOMOUS_DAILY_TOKENS: '50000',
    PHILONT_AUTONOMOUS_DAILY_TOOL_CALLS: '100',
    PHILONT_AUTONOMOUS_PER_TICK_TOKENS: '15000',
    PHILONT_AUTONOMOUS_PER_TICK_INITIATIVES: '8',
    PHILONT_AUTONOMOUS_PER_INITIATIVE_TOKENS: '3000',
  });
  assert.deepEqual(caps, {
    dailyTokens: 50000,
    dailyToolCalls: 100,
    perTickTokens: 15000,
    perTickInitiatives: 8,
    perInitiativeTokens: 3000,
  });
});

test('resolve: 非数字 → 走 default', () => {
  const caps = resolveAutonomousBudgetCaps({
    PHILONT_AUTONOMOUS_DAILY_TOKENS: 'not-a-number',
    PHILONT_AUTONOMOUS_DAILY_TOOL_CALLS: '',
  });
  assert.equal(caps.dailyTokens, DEFAULT_BUDGET_CAPS.dailyTokens);
  assert.equal(caps.dailyToolCalls, DEFAULT_BUDGET_CAPS.dailyToolCalls);
});

test('resolve: 负数 → 走 default', () => {
  const caps = resolveAutonomousBudgetCaps({
    PHILONT_AUTONOMOUS_DAILY_TOKENS: '-100',
  });
  assert.equal(caps.dailyTokens, DEFAULT_BUDGET_CAPS.dailyTokens);
});

test('resolve: 0 是合法的(unlimited 语义,见 budget.ts)', () => {
  const caps = resolveAutonomousBudgetCaps({
    PHILONT_AUTONOMOUS_DAILY_TOKENS: '0',
  });
  assert.equal(caps.dailyTokens, 0);
});

test('resolve: 浮点 → floor 取整', () => {
  const caps = resolveAutonomousBudgetCaps({
    PHILONT_AUTONOMOUS_DAILY_TOKENS: '50000.7',
  });
  assert.equal(caps.dailyTokens, 50000);
});

test('describe: 全 default → 列默认值', () => {
  const msg = describeBudgetCapsOverrides(DEFAULT_BUDGET_CAPS);
  assert.match(msg, /default/);
  assert.match(msg, /dailyTokens=/);
  assert.match(msg, /perTickInitiatives=/);
});

test('describe: 部分覆盖 → 仅列被改的', () => {
  const caps = { ...DEFAULT_BUDGET_CAPS, dailyTokens: 99999 };
  const msg = describeBudgetCapsOverrides(caps);
  assert.match(msg, /overridden/);
  assert.match(msg, /dailyTokens=99999/);
  assert.doesNotMatch(msg, /dailyToolCalls=/);
});
