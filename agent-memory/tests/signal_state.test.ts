/**
 * SignalState 单例行为测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalState } from '../src/signals/state.js';
import type { Pursuit, PursuitStatus } from '../src/types.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_500_000_000_000;

function mkPursuit(overrides: Partial<Pursuit> & { ageHours?: number } = {}): Pursuit {
  const ageHours = overrides.ageHours ?? 0;
  const lastTouchedAt = NOW - ageHours * HOUR_MS;
  return {
    id: overrides.id ?? `p-${Math.random().toString(36).slice(2, 9)}`,
    parentPursuitId: overrides.parentPursuitId !== undefined ? overrides.parentPursuitId : 'root',
    rootPursuitId: 'root',
    title: overrides.title ?? 'task',
    intent: 'do something',
    status: (overrides.status as PursuitStatus) ?? 'active',
    isEvergreen: false,
    stake: 'medium',
    stakeWeight: overrides.stakeWeight ?? 5,
    isActiveResearch: false,
    researchIterations: 0,
    deadline: null,
    origin: 'user',
    openQuestions: [],
    resolutionCriteria: null,
    evidenceRefs: [],
    progressMarkers: [],
    lastProgressTurn: 0,
    values: null,
    redLines: null,
    driveBounds: null,
    pursuitGovernance: null,
    lastTouchedAt,
    createdAt: lastTouchedAt,
    updatedAt: lastTouchedAt,
  };
}

test('signal_state: 默认 commitmentPressure=0,getBreakdown=null', () => {
  signalState.reset();
  assert.equal(signalState.commitmentPressure, 0);
  assert.equal(signalState.getCommitmentBreakdown(), null);
  assert.equal(signalState.commitmentLastComputedAt, null);
});

test('signal_state: recompute 后读出一致', () => {
  signalState.reset();
  const ps = [mkPursuit({ stakeWeight: 10, ageHours: 720 })];
  const breakdown = signalState.recomputeCommitmentPressure(ps, NOW);
  assert.equal(signalState.commitmentPressure, breakdown.pressure);
  assert.deepEqual(signalState.getCommitmentBreakdown(), breakdown);
  assert.equal(signalState.commitmentLastComputedAt, NOW);
});

test('signal_state: 多次 recompute 覆盖前次', () => {
  signalState.reset();
  signalState.recomputeCommitmentPressure([mkPursuit({ stakeWeight: 10, ageHours: 720 })], NOW);
  const high = signalState.commitmentPressure;
  signalState.recomputeCommitmentPressure([], NOW + 1000);
  assert.equal(signalState.commitmentPressure, 0);
  assert.equal(signalState.commitmentLastComputedAt, NOW + 1000);
  assert.notEqual(high, 0, 'sanity:第一次确实不是 0');
});

test('signal_state: 没 active pursuit 时 getBreakdown 返回零结构', () => {
  signalState.reset();
  signalState.recomputeCommitmentPressure([], NOW);
  const b = signalState.getCommitmentBreakdown();
  assert.ok(b);
  assert.equal(b!.pressure, 0);
  assert.equal(b!.contributors.length, 0);
  assert.equal(b!.activeCount, 0);
});
