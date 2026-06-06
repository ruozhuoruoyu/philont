/**
 * Skill maturity 状态机测试
 *
 * 覆盖:
 *   - 升档:draft→confirmed→stable 阈值
 *   - 降档:stable→confirmed→draft / draft 失败保留 / playbook & deprecated 终态
 *   - deprecated 触发条件:连续 3 失败 OR 失败率超阈值
 *   - isCallableMaturity / maturityCaveat / parseMaturity 边界
 *
 * 用 SkillStore 端到端跑也覆盖一遍(确保状态机和 DB 协同)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextMaturity,
  isCallableMaturity,
  maturityCaveat,
  parseMaturity,
  CONFIRMED_MIN_SUCCESS,
  STABLE_MIN_SUCCESS,
  DEPRECATED_CONSECUTIVE_FAILURES,
  openMemoryDb,
} from '../src/index.js';
import type { SkillMaturity } from '../src/index.js';

// ── nextMaturity (纯函数) ──────────────────────────────────────────────

test('maturity: draft + 1 success → 仍 draft (阈值 2 没到)', () => {
  const r = nextMaturity({
    current: 'draft',
    successCount: 1,
    failureCount: 0,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'draft');
});

test('maturity: draft + 2 success 0 failure → confirmed', () => {
  const r = nextMaturity({
    current: 'draft',
    successCount: CONFIRMED_MIN_SUCCESS,
    failureCount: 0,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'confirmed');
});

test('maturity: draft + 2 success 1 failure → 仍 draft (failure_count > 0 阻止升 confirmed)', () => {
  const r = nextMaturity({
    current: 'draft',
    successCount: 2,
    failureCount: 1,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'draft');
});

test('maturity: confirmed + 5 success 0 failure → stable', () => {
  const r = nextMaturity({
    current: 'confirmed',
    successCount: STABLE_MIN_SUCCESS,
    failureCount: 0,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'stable');
});

test('maturity: confirmed + 5 success 1 failure (10% < 10%? false) → 仍 confirmed', () => {
  // failure/success = 1/5 = 0.2,大于 0.1 阈值 → 不升 stable
  const r = nextMaturity({
    current: 'confirmed',
    successCount: 5,
    failureCount: 1,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'confirmed');
});

test('maturity: confirmed + 10 success 1 failure (10%) → stable', () => {
  // failure/success = 1/10 = 0.1,严格小于 0.1? 0.1 < 0.1 = false。改用 11 success
  const r = nextMaturity({
    current: 'confirmed',
    successCount: 11,
    failureCount: 1,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'stable');
});

test('maturity: stable + 1 failure → confirmed (降一档)', () => {
  const r = nextMaturity({
    current: 'stable',
    successCount: 5,
    failureCount: 1,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'confirmed');
});

test('maturity: confirmed + 1 failure → draft (降一档)', () => {
  const r = nextMaturity({
    current: 'confirmed',
    successCount: 2,
    failureCount: 1,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'draft');
});

test('maturity: draft + 1 failure (consec=1) → 仍 draft (未达 deprecated 阈值)', () => {
  const r = nextMaturity({
    current: 'draft',
    successCount: 0,
    failureCount: 1,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'draft');
});

test('maturity: 任一档 + 连续 3 失败 → deprecated', () => {
  const states: SkillMaturity[] = ['stable', 'confirmed', 'draft'];
  for (const s of states) {
    const r = nextMaturity({
      current: s,
      successCount: 0,
      failureCount: DEPRECATED_CONSECUTIVE_FAILURES,
      consecutiveFailures: DEPRECATED_CONSECUTIVE_FAILURES,
      lastOutcome: 'failure',
    });
    assert.equal(r, 'deprecated', `${s} 应降为 deprecated`);
  }
});

test('maturity: stable + 失败率 > 30% (n≥5) → deprecated (而非降一档)', () => {
  const r = nextMaturity({
    current: 'stable',
    successCount: 5,
    failureCount: 2, // 2/5 = 40% > 30%
    consecutiveFailures: 1, // 不到 3
    lastOutcome: 'failure',
  });
  assert.equal(r, 'deprecated');
});

test('maturity: success_count < 5 时失败率不触发 deprecated', () => {
  // 4 success 4 failure(100% 失败率)但 < 5 → 走降一档
  const r = nextMaturity({
    current: 'confirmed',
    successCount: 4,
    failureCount: 4,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'draft');
});

test('maturity: playbook 任何情况都不变(终态)', () => {
  const succ = nextMaturity({
    current: 'playbook',
    successCount: 100,
    failureCount: 0,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(succ, 'playbook');
  const fail = nextMaturity({
    current: 'playbook',
    successCount: 0,
    failureCount: 100,
    consecutiveFailures: 100,
    lastOutcome: 'failure',
  });
  assert.equal(fail, 'playbook');
});

test('maturity: deprecated 任何情况都不变(终态)', () => {
  const r = nextMaturity({
    current: 'deprecated',
    successCount: 100,
    failureCount: 0,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'deprecated');
});

// ── isCallableMaturity ─────────────────────────────────────────────────

test('isCallableMaturity: draft/confirmed/stable=true; playbook/deprecated=false', () => {
  assert.equal(isCallableMaturity('draft'), true);
  assert.equal(isCallableMaturity('confirmed'), true);
  assert.equal(isCallableMaturity('stable'), true);
  assert.equal(isCallableMaturity('playbook'), false);
  assert.equal(isCallableMaturity('deprecated'), false);
});

// ── maturityCaveat ─────────────────────────────────────────────────────

test('maturityCaveat: draft 含 "not fully validated"', () => {
  assert.match(maturityCaveat('draft'), /not fully validated/);
});

test('maturityCaveat: deprecated 含 "verified unreliable"', () => {
  assert.match(maturityCaveat('deprecated'), /unreliable|deprecated/);
});

test('maturityCaveat: stable 简洁标记', () => {
  assert.equal(maturityCaveat('stable'), '[stable]');
});

// ── parseMaturity ──────────────────────────────────────────────────────

test('parseMaturity: 合法值原样返回', () => {
  assert.equal(parseMaturity('draft'), 'draft');
  assert.equal(parseMaturity('stable'), 'stable');
});

test('parseMaturity: 非法值 fallback', () => {
  assert.equal(parseMaturity('xxx'), 'draft');
  assert.equal(parseMaturity(null), 'draft');
  assert.equal(parseMaturity(undefined, 'confirmed'), 'confirmed');
});

// ── 端到端: SkillStore + 状态机 ────────────────────────────────────────

test('E2E: createSkill 默认 maturity=draft', () => {
  const { skills } = openMemoryDb(':memory:');
  const s = skills.createSkill({
    name: 'e2e-default',
    description: 'd',
    triggerKeywords: ['k'],
    actionTemplate: 't',
  });
  assert.equal(s.maturity, 'draft');
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastSuccessAt, null);
});

test('E2E: createSkill 显式 maturity=stable', () => {
  const { skills } = openMemoryDb(':memory:');
  const s = skills.createSkill({
    name: 'e2e-stable',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
    maturity: 'stable',
  });
  assert.equal(s.maturity, 'stable');
});

test('E2E: 2 次 recordSkillOutcome(true) 后 draft → confirmed', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'e2e-promote',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
  });
  let s = skills.recordSkillOutcome('e2e-promote', true);
  assert.equal(s?.maturity, 'draft'); // 1 次还不够
  s = skills.recordSkillOutcome('e2e-promote', true);
  assert.equal(s?.maturity, 'confirmed');
  assert.equal(s?.successCount, 2);
  assert.equal(s?.consecutiveFailures, 0);
  assert.notEqual(s?.lastSuccessAt, null);
});

test('E2E: 连续 3 次 failure 任何档 → deprecated', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'e2e-deprecate',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
    maturity: 'stable',
  });
  skills.recordSkillOutcome('e2e-deprecate', false);
  let s = skills.getByName('e2e-deprecate');
  assert.equal(s?.maturity, 'confirmed'); // stable → confirmed (降一档)
  assert.equal(s?.consecutiveFailures, 1);

  skills.recordSkillOutcome('e2e-deprecate', false);
  s = skills.getByName('e2e-deprecate');
  assert.equal(s?.maturity, 'draft'); // confirmed → draft

  skills.recordSkillOutcome('e2e-deprecate', false);
  s = skills.getByName('e2e-deprecate');
  assert.equal(s?.maturity, 'deprecated'); // 连续 3 fail
  assert.equal(s?.consecutiveFailures, 3);
});

test('E2E: success 之后 consecutive_failures 清零', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'e2e-reset',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
  });
  skills.recordSkillOutcome('e2e-reset', false);
  skills.recordSkillOutcome('e2e-reset', false);
  let s = skills.getByName('e2e-reset');
  assert.equal(s?.consecutiveFailures, 2);

  skills.recordSkillOutcome('e2e-reset', true);
  s = skills.getByName('e2e-reset');
  assert.equal(s?.consecutiveFailures, 0);
  // 再 2 fail 还不到 deprecated 阈值(连续从这次 success 后重新计数)
  skills.recordSkillOutcome('e2e-reset', false);
  skills.recordSkillOutcome('e2e-reset', false);
  s = skills.getByName('e2e-reset');
  assert.equal(s?.consecutiveFailures, 2);
  assert.notEqual(s?.maturity, 'deprecated');
});

test('E2E: setMaturity 显式覆盖状态机(用于 reflection 写 playbook)', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'e2e-set',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
  });
  const s = skills.setMaturity('e2e-set', 'playbook');
  assert.equal(s?.maturity, 'playbook');

  // playbook 终态:即使 success 也不动
  const s2 = skills.recordSkillOutcome('e2e-set', true);
  assert.equal(s2?.maturity, 'playbook');
});

test('E2E: deprecated 终态(自动)- 即使 success 也不复活', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'e2e-dep-stuck',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
    maturity: 'deprecated',
  });
  const s = skills.recordSkillOutcome('e2e-dep-stuck', true);
  assert.equal(s?.maturity, 'deprecated');
});

test('E2E: setMaturity 复活 deprecated → draft', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'e2e-revive',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
    maturity: 'deprecated',
  });
  const s = skills.setMaturity('e2e-revive', 'draft');
  assert.equal(s?.maturity, 'draft');

  // 复活后状态机正常工作
  skills.recordSkillOutcome('e2e-revive', true);
  skills.recordSkillOutcome('e2e-revive', true);
  const s2 = skills.getByName('e2e-revive');
  assert.equal(s2?.maturity, 'confirmed');
});
