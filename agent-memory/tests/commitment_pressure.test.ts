/**
 * commitment_pressure 纯函数单元测试。
 *
 * 验证:
 *   - 0 active → 0
 *   - 单条新鲜 / 单条超老 / 单条 stake 高
 *   - 多条复合(总不超 1)
 *   - status='active' 之外的不计入
 *   - root pursuit (parent=null) 不计入
 *   - top contributors 排序
 *   - halfLife 旋钮敏感
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCommitmentPressure } from '../src/signals/commitment_pressure.js';
import type { Pursuit, PursuitStatus } from '../src/types.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

function mkPursuit(overrides: Partial<Pursuit> = {}): Pursuit {
  const ageHours = (overrides as { ageHours?: number }).ageHours ?? 0;
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

test('commitment_pressure: 0 active pursuit → 0', () => {
  const r = computeCommitmentPressure([], NOW);
  assert.equal(r.pressure, 0);
  assert.equal(r.contributors.length, 0);
  assert.equal(r.activeCount, 0);
});

test('commitment_pressure: 1 个新鲜 stake=5 → pressure 极低', () => {
  const r = computeCommitmentPressure(
    [mkPursuit({ stakeWeight: 5, ...({ ageHours: 1 } as object) })],
    NOW,
  );
  assert.ok(r.pressure < 0.1, `expected pressure < 0.1, got ${r.pressure}`);
  assert.equal(r.activeCount, 1);
});

test('commitment_pressure: 1 个超老 stake=10 → 单条贡献近上限', () => {
  // age 远超半衰期 → sigmoid → 1; stakeRatio=1 → raw=1 → cap by maxIndividual=0.4
  const r = computeCommitmentPressure(
    [mkPursuit({ stakeWeight: 10, ...({ ageHours: 720 } as object) })],
    NOW,
  );
  assert.ok(
    r.contributors[0].contribution >= 0.39 && r.contributors[0].contribution <= 0.401,
    `单条 cap 应 ~0.4, got ${r.contributors[0].contribution}`,
  );
  // pressure = 1 - exp(-0.4) ≈ 0.33
  assert.ok(r.pressure > 0.3 && r.pressure < 0.36);
});

test('commitment_pressure: 5 条 stake=8 / age=72h → 复合压力近 1 但不超', () => {
  const ps = Array.from({ length: 5 }, (_, i) =>
    mkPursuit({ id: `p${i}`, stakeWeight: 8, ...({ ageHours: 96 } as object) }),
  );
  const r = computeCommitmentPressure(ps, NOW);
  assert.ok(r.pressure > 0.5, `5 条复合应 > 0.5, got ${r.pressure}`);
  assert.ok(r.pressure < 1, '渐近不超 1');
});

test('commitment_pressure: closed/abandoned/paused 不计入', () => {
  const ps = [
    mkPursuit({ id: 'a', status: 'achieved', stakeWeight: 10, ...({ ageHours: 200 } as object) }),
    mkPursuit({ id: 'b', status: 'archived', stakeWeight: 10, ...({ ageHours: 200 } as object) }),
    mkPursuit({ id: 'c', status: 'abandoned', stakeWeight: 10, ...({ ageHours: 200 } as object) }),
    mkPursuit({ id: 'd', status: 'paused', stakeWeight: 10, ...({ ageHours: 200 } as object) }),
  ];
  const r = computeCommitmentPressure(ps, NOW);
  assert.equal(r.pressure, 0);
  assert.equal(r.activeCount, 0);
});

test('commitment_pressure: root pursuit (parent=null) 不计入', () => {
  const ps = [
    mkPursuit({ id: 'root-self', parentPursuitId: null, stakeWeight: 10, ...({ ageHours: 1000 } as object) }),
  ];
  const r = computeCommitmentPressure(ps, NOW);
  assert.equal(r.pressure, 0, 'root 是 evergreen 身份,不应产生 commitment 压力');
});

test('commitment_pressure: contributors 按贡献度降序', () => {
  const ps = [
    mkPursuit({ id: 'low', stakeWeight: 3, ...({ ageHours: 24 } as object) }),
    mkPursuit({ id: 'high', stakeWeight: 9, ...({ ageHours: 96 } as object) }),
    mkPursuit({ id: 'mid', stakeWeight: 5, ...({ ageHours: 48 } as object) }),
  ];
  const r = computeCommitmentPressure(ps, NOW);
  assert.equal(r.contributors[0].pursuitId, 'high');
  assert.equal(r.contributors[2].pursuitId, 'low');
});

test('commitment_pressure: halfLife 旋钮变小时同 age 压力变大', () => {
  const p = mkPursuit({ stakeWeight: 8, ...({ ageHours: 48 } as object) });
  const r72 = computeCommitmentPressure([p], NOW, { ageHalfLifeHours: 72 });
  const r24 = computeCommitmentPressure([p], NOW, { ageHalfLifeHours: 24 });
  assert.ok(
    r24.pressure > r72.pressure,
    `halfLife 越小同 age 越紧迫:r24=${r24.pressure} 应 > r72=${r72.pressure}`,
  );
});
