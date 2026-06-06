/**
 * DriveConfigStore + DriveOutcomeStore 单测 (v7)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import {
  DriveConfigStore,
  InvalidDriveIdError,
  DriveConfigNotFoundError,
} from '../src/drive_config.js';
import { DriveOutcomeStore } from '../src/drive_outcome.js';

function mk() {
  const db = new Database(':memory:');
  initSchema(db);
  return {
    db,
    configs: new DriveConfigStore(db),
    outcomes: new DriveOutcomeStore(db),
  };
}

test('DriveConfigStore: create + get round-trip, 默认状态 shadow + 空 effectiveness', () => {
  const { configs } = mk();
  const c = configs.create({
    id: 'curiosity-v1',
    kind: 'curiosity',
    triggerExpr: { op: 'match_keyword', keywords: ['量子'] },
    actionTemplate: { type: 'inject_message', text: '想深入了解吗?' },
    params: { cooldownMs: 60_000 },
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  assert.equal(c.status, 'shadow');
  assert.equal(c.effectiveness.samples, 0);
  assert.equal(c.effectiveness.ewma, 0);
  assert.equal(c.effectiveness.lastFired, null);
  assert.deepEqual(c.triggerExpr, { op: 'match_keyword', keywords: ['量子'] });
  assert.deepEqual(c.params, { cooldownMs: 60_000 });

  const got = configs.get('curiosity-v1');
  assert.deepEqual(got, c);
});

test('DriveConfigStore: id 格式校验', () => {
  const { configs } = mk();
  assert.throws(
    () =>
      configs.create({
        id: 'Bad.ID',
        kind: 'x',
        triggerExpr: {},
        actionTemplate: {},
        rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
      }),
    InvalidDriveIdError
  );
});

test('DriveConfigStore: listByRoot 过滤状态和 kind', () => {
  const { configs } = mk();
  configs.create({
    id: 'a',
    kind: 'curiosity',
    triggerExpr: {},
    actionTemplate: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    status: 'active',
  });
  configs.create({
    id: 'b',
    kind: 'curiosity',
    triggerExpr: {},
    actionTemplate: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    status: 'shadow',
  });
  configs.create({
    id: 'c',
    kind: 'curiosity',
    triggerExpr: {},
    actionTemplate: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    status: 'retired',
  });
  configs.create({
    id: 'd',
    kind: 'hypothesis',
    triggerExpr: {},
    actionTemplate: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    status: 'active',
  });

  // 默认只取 active + shadow
  const live = configs.listByRoot(BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(live.length, 3);
  assert.deepEqual(live.map((c) => c.id).sort(), ['a', 'b', 'd']);

  // 过滤 kind
  const curOnly = configs.listByRoot(BOOTSTRAP_ROOT_PURSUIT_ID, { kind: 'curiosity' });
  assert.deepEqual(curOnly.map((c) => c.id).sort(), ['a', 'b']);

  // 只取 retired
  const retired = configs.listByRoot(BOOTSTRAP_ROOT_PURSUIT_ID, { statuses: ['retired'] });
  assert.deepEqual(retired.map((c) => c.id), ['c']);
});

test('DriveConfigStore: updateStatus + updateParams + updateEffectiveness', () => {
  const { configs } = mk();
  configs.create({
    id: 'x',
    kind: 'k',
    triggerExpr: {},
    actionTemplate: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });

  configs.updateStatus('x', 'active');
  assert.equal(configs.get('x')!.status, 'active');

  configs.updateParams('x', { cooldownMs: 120_000, priorityWeight: 0.5 });
  assert.deepEqual(configs.get('x')!.params, {
    cooldownMs: 120_000,
    priorityWeight: 0.5,
  });

  // EWMA: 第一次 samples=0,newScore 直接落地
  configs.updateEffectiveness('x', 0.6, 0.3, 1000);
  let c = configs.get('x')!;
  assert.equal(c.effectiveness.samples, 1);
  assert.equal(c.effectiveness.ewma, 0.6);
  assert.equal(c.effectiveness.lastFired, 1000);

  // 第二次: 0.3 * 0.2 + 0.7 * 0.6 = 0.06 + 0.42 = 0.48
  configs.updateEffectiveness('x', 0.2, 0.3, 2000);
  c = configs.get('x')!;
  assert.equal(c.effectiveness.samples, 2);
  assert.ok(Math.abs(c.effectiveness.ewma - 0.48) < 1e-9);
  assert.equal(c.effectiveness.lastFired, 2000);
});

test('DriveConfigStore: updateStatus on missing → throws', () => {
  const { configs } = mk();
  assert.throws(() => configs.updateStatus('missing', 'active'), DriveConfigNotFoundError);
});

// ── DriveOutcomeStore ────────────────────────────────────────────────

test('DriveOutcomeStore: append + get + listByDrive round-trip', () => {
  const { outcomes } = mk();
  const o = outcomes.append({
    driveId: 'drive-1',
    triggerSnapshot: { iteration: 3 },
    injectedAction: { text: '回捞' },
    servedPursuitId: 'track-x',
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  assert.ok(o.id);
  assert.equal(o.driveId, 'drive-1');
  assert.equal(o.effectivenessScore, null);

  const got = outcomes.get(o.id);
  assert.deepEqual(got, o);

  const list = outcomes.listByDrive('drive-1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, o.id);
});

test('DriveOutcomeStore: setEffectivenessScore + 范围校验', () => {
  const { outcomes } = mk();
  const o = outcomes.append({
    driveId: 'd',
    triggerSnapshot: {},
    injectedAction: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  outcomes.setEffectivenessScore(o.id, 0.7);
  assert.equal(outcomes.get(o.id)!.effectivenessScore, 0.7);

  assert.throws(() => outcomes.setEffectivenessScore(o.id, 1.5));
  assert.throws(() => outcomes.setEffectivenessScore(o.id, -2));
});

test('DriveOutcomeStore: appendSubsequentToolCalls + mergeMemoryDelta', () => {
  const { outcomes } = mk();
  const o = outcomes.append({
    driveId: 'd',
    triggerSnapshot: {},
    injectedAction: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  outcomes.appendSubsequentToolCalls(o.id, [{ tool: 'a', ok: true }]);
  outcomes.appendSubsequentToolCalls(o.id, [{ tool: 'b', ok: false }]);
  assert.deepEqual(outcomes.get(o.id)!.subsequentToolCalls, [
    { tool: 'a', ok: true },
    { tool: 'b', ok: false },
  ]);

  outcomes.mergeMemoryDelta(o.id, { factIds: ['f1'], noteIds: ['n1'] });
  outcomes.mergeMemoryDelta(o.id, { factIds: ['f2'], pursuitProgressMarkers: ['m1'] });
  const after = outcomes.get(o.id)!;
  assert.deepEqual(after.memoryDelta.factIds, ['f1', 'f2']);
  assert.deepEqual(after.memoryDelta.noteIds, ['n1']);
  assert.deepEqual(after.memoryDelta.pursuitProgressMarkers, ['m1']);
});

test('DriveOutcomeStore: listUnscored 只含 score 为 NULL 的', () => {
  const { outcomes } = mk();
  const o1 = outcomes.append({
    driveId: 'a',
    triggerSnapshot: {},
    injectedAction: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  const o2 = outcomes.append({
    driveId: 'b',
    triggerSnapshot: {},
    injectedAction: {},
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  outcomes.setEffectivenessScore(o1.id, 0.5);

  const unscored = outcomes.listUnscored(BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(unscored.length, 1);
  assert.equal(unscored[0].id, o2.id);
});

test('DriveOutcomeStore: listByPursuit 按 servedPursuitId 聚合', () => {
  const { outcomes } = mk();
  outcomes.append({
    driveId: 'a',
    triggerSnapshot: {},
    injectedAction: {},
    servedPursuitId: 'p-x',
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  outcomes.append({
    driveId: 'b',
    triggerSnapshot: {},
    injectedAction: {},
    servedPursuitId: 'p-x',
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  outcomes.append({
    driveId: 'c',
    triggerSnapshot: {},
    injectedAction: {},
    servedPursuitId: 'p-y',
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  const xs = outcomes.listByPursuit('p-x');
  assert.equal(xs.length, 2);
});
