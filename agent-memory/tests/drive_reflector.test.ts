/**
 * SessionDriveReflector 单测
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import { PursuitStore } from '../src/pursuit.js';
import { DriveConfigStore } from '../src/drive_config.js';
import { DriveOutcomeStore } from '../src/drive_outcome.js';
import {
  SessionDriveReflector,
  scoreOutcome,
} from '../src/drive_reflector.js';
import { InMemoryAuditHook } from '../src/audit.js';

function mk() {
  const db = new Database(':memory:');
  initSchema(db);
  const pursuits = new PursuitStore(db);
  const configs = new DriveConfigStore(db);
  const outcomes = new DriveOutcomeStore(db);
  const audit = new InMemoryAuditHook();
  const reflector = new SessionDriveReflector(outcomes, configs, pursuits, {
    auditHook: audit,
  });
  return { db, pursuits, configs, outcomes, reflector, audit };
}

test('scoreOutcome: pursuit 推进 + 事实沉淀 → 正分', () => {
  const score = scoreOutcome({
    id: 'x',
    driveId: 'd',
    firedAt: 0,
    triggerSnapshot: {},
    injectedAction: {},
    subsequentToolCalls: [],
    memoryDelta: { pursuitProgressMarkers: ['m1'], factIds: ['f1'] },
    servedPursuitId: 'p',
    effectivenessScore: null,
    rootPursuitId: 'r',
  });
  // +0.5 (progress) + 0.3 (fact) = 0.8
  assert.ok(Math.abs(score - 0.8) < 1e-9);
});

test('scoreOutcome: 空转(无 pursuit + 无工具) → 负分', () => {
  const score = scoreOutcome({
    id: 'x',
    driveId: 'd',
    firedAt: 0,
    triggerSnapshot: {},
    injectedAction: {},
    subsequentToolCalls: [],
    memoryDelta: {},
    servedPursuitId: null,
    effectivenessScore: null,
    rootPursuitId: 'r',
  });
  assert.equal(score, -0.3);
});

test('scoreOutcome: 工具多数失败 → 显著负分', () => {
  const score = scoreOutcome({
    id: 'x',
    driveId: 'd',
    firedAt: 0,
    triggerSnapshot: {},
    injectedAction: {},
    subsequentToolCalls: [
      { ok: false },
      { ok: false },
      { ok: true },
    ],
    memoryDelta: {},
    servedPursuitId: 'p',
    effectivenessScore: null,
    rootPursuitId: 'r',
  });
  // 失败率 > 50% → -0.4
  assert.equal(score, -0.4);
});

test('scoreOutcome: 工具全成功 → 加分', () => {
  const score = scoreOutcome({
    id: 'x',
    driveId: 'd',
    firedAt: 0,
    triggerSnapshot: {},
    injectedAction: {},
    subsequentToolCalls: [{ ok: true }, { ok: true }],
    memoryDelta: {},
    servedPursuitId: 'p',
    effectivenessScore: null,
    rootPursuitId: 'r',
  });
  // +0.2 (全 success)
  assert.equal(score, 0.2);
});

test('reflect: 回填 unscored outcome 的效用分数 + EWMA 合并', async () => {
  const { reflector, configs, outcomes } = mk();
  configs.create({
    id: 'open-loop-1',
    kind: 'openLoop',
    triggerExpr: {},
    actionTemplate: {},
    params: { cooldownMs: 60_000 },
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });

  // 两条好事件 outcome
  outcomes.append({
    driveId: 'open-loop-1',
    triggerSnapshot: {},
    injectedAction: {},
    memoryDelta: { pursuitProgressMarkers: ['m1'] },
    servedPursuitId: 'p',
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  outcomes.append({
    driveId: 'open-loop-1',
    triggerSnapshot: {},
    injectedAction: {},
    memoryDelta: { factIds: ['f1'] },
    servedPursuitId: 'p',
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });

  const r = await reflector.reflect();
  assert.equal(r.outcomesScored, 2);
  assert.equal(r.driveEwmaUpdated, 1);

  const cfg = configs.get('open-loop-1')!;
  assert.equal(cfg.effectiveness.samples, 2);
  // 两次都是正分,EWMA 也应为正
  assert.ok(cfg.effectiveness.ewma > 0);

  // unscored 列表现在应为空
  assert.equal(outcomes.listUnscored(BOOTSTRAP_ROOT_PURSUIT_ID).length, 0);
});

test('reflect: 长期低效 → cooldownMs 在 bounds 内翻倍', async () => {
  const { reflector, configs, outcomes, pursuits } = mk();
  // constitution 设定 bounds
  pursuits.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, {
    driveBounds: { openLoop: { cooldownMs: [10_000, 3_600_000] } },
  });
  configs.create({
    id: 'open-loop-1',
    kind: 'openLoop',
    triggerExpr: {},
    actionTemplate: {},
    params: { cooldownMs: 60_000 },
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });

  // 5 条空转 outcome(全部 -0.3)
  for (let i = 0; i < 5; i++) {
    outcomes.append({
      driveId: 'open-loop-1',
      triggerSnapshot: {},
      injectedAction: {},
      memoryDelta: {},
      servedPursuitId: null,
      rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    });
  }

  const r = await reflector.reflect();
  assert.equal(r.outcomesScored, 5);
  assert.equal(r.driveParamsTuned, 1);

  const cfg = configs.get('open-loop-1')!;
  assert.equal(cfg.params.cooldownMs, 120_000); // 翻倍
});

test('reflect: 超出 bounds 的调整被拦截 → out_of_bounds 计数', async () => {
  const { reflector, configs, outcomes, pursuits, audit } = mk();
  // 上限设 100s,当前 80s,翻倍到 160s 超界
  pursuits.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, {
    driveBounds: { openLoop: { cooldownMs: [10_000, 100_000] } },
  });
  configs.create({
    id: 'dl-1',
    kind: 'openLoop',
    triggerExpr: {},
    actionTemplate: {},
    params: { cooldownMs: 80_000 },
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  for (let i = 0; i < 5; i++) {
    outcomes.append({
      driveId: 'dl-1',
      triggerSnapshot: {},
      injectedAction: {},
      memoryDelta: {},
      rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    });
  }

  const r = await reflector.reflect();
  assert.equal(r.driveParamsTuned, 0);
  assert.equal(r.tuneSkippedOutOfBounds, 1);

  // 参数未变
  assert.equal(configs.get('dl-1')!.params.cooldownMs, 80_000);
  // audit 里有 out_of_bounds 事件
  const events = audit.events.filter(
    (e) => e.data.toolName === 'propose_param_out_of_bounds'
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].data.proposedValue, 160_000);
});

test('reflect: 样本不足(< 5) 不调参', async () => {
  const { reflector, configs, outcomes } = mk();
  configs.create({
    id: 'd',
    kind: 'openLoop',
    triggerExpr: {},
    actionTemplate: {},
    params: { cooldownMs: 60_000 },
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  // 只 3 条,低于门槛
  for (let i = 0; i < 3; i++) {
    outcomes.append({
      driveId: 'd',
      triggerSnapshot: {},
      injectedAction: {},
      memoryDelta: {},
      rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    });
  }
  const r = await reflector.reflect();
  assert.equal(r.outcomesScored, 3);
  assert.equal(r.driveParamsTuned, 0);
});
