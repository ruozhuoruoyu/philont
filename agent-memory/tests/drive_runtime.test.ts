/**
 * TsDriveRuntime 框架单测
 *
 * 历史:本文件曾包含 TsOpenLoopDrive 测试 (extractLastQuestion / looksAddressed /
 * isGreetingQuestion / looksLikeNewTask 等启发式),OpenLoopDrive 删除后(2026-05-03)
 * 仅保留 runtime 框架本身的测试。具体 drive(TaskCommitment / Curiosity)的测试
 * 在 kernel_drives.test.ts。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import { DriveOutcomeStore } from '../src/drive_outcome.js';
import {
  TsDriveRuntime,
  type DriveRuntimeState,
  type TsDriveEngine,
} from '../src/drive_runtime.js';
import { InMemoryAuditHook } from '../src/audit.js';

function mkState(overrides: Partial<DriveRuntimeState> = {}): DriveRuntimeState {
  return {
    sessionId: 's1',
    recentMessages: [],
    iteration: 0,
    activePursuits: [],
    recentToolCalls: [],
    ...overrides,
  };
}

function mkRuntime() {
  const db = new Database(':memory:');
  initSchema(db);
  const outcomes = new DriveOutcomeStore(db);
  const audit = new InMemoryAuditHook();
  const runtime = new TsDriveRuntime(outcomes, {
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    auditHook: audit,
  });
  return { db, outcomes, runtime, audit };
}

/** 测试用 stub drive:总是 fire 给定的 utility + message */
function makeStubDrive(
  id: string,
  opts: { utility?: number; message?: string; kind?: string } = {},
): TsDriveEngine {
  return {
    id,
    kind: opts.kind ?? 'stub',
    name: id,
    evaluate: () => ({
      injectMessage: opts.message ?? `msg-${id}`,
      utility: opts.utility ?? 0.5,
      triggerSnapshot: { id },
    }),
  };
}

test('TsDriveRuntime: 未注册 drive → beforeTurn 返回空', () => {
  const { runtime } = mkRuntime();
  const fired = runtime.beforeTurn(mkState());
  assert.equal(fired.length, 0);
});

test('TsDriveRuntime: 单 drive 触发 → outcome 落盘 + audit 有事件', () => {
  const { runtime, outcomes, audit } = mkRuntime();
  runtime.register(makeStubDrive('op', { message: '继续' }));

  const fired = runtime.beforeTurn(mkState());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].driveId, 'op');
  assert.ok(fired[0].outcomeId);

  const outcome = outcomes.get(fired[0].outcomeId)!;
  assert.equal(outcome.driveId, 'op');
  assert.equal(outcome.effectivenessScore, null);
  assert.ok(
    (outcome.injectedAction as { message: string }).message.includes('继续'),
  );

  const fireEvent = audit.events.find((e) => e.data.toolName === 'drive_fired');
  assert.ok(fireEvent);
  assert.equal(fireEvent!.data.driveId, 'op');
});

test('TsDriveRuntime: 多 drive 按 utility 排序,top-K 胜出', () => {
  const { runtime } = mkRuntime();
  runtime.register(makeStubDrive('low', { utility: 0.2 }));
  runtime.register(makeStubDrive('high', { utility: 0.9 }));
  runtime.register(makeStubDrive('mid', { utility: 0.5 }));

  const fired = runtime.beforeTurn(mkState());
  // maxInjections 默认 1 → 只注最高分
  assert.equal(fired.length, 1);
  assert.equal(fired[0].driveId, 'high');
});

test('TsDriveRuntime: evaluate 抛错不影响其它 drive', () => {
  const { runtime, audit } = mkRuntime();
  runtime.register({
    id: 'broken',
    kind: 'k',
    name: 'broken',
    evaluate() {
      throw new Error('boom');
    },
  });
  runtime.register(makeStubDrive('ok', { message: 'hi' }));
  const fired = runtime.beforeTurn(mkState());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].driveId, 'ok');
  const err = audit.events.find((e) => e.data.toolName === 'drive_evaluate_error');
  assert.ok(err);
  assert.equal(err!.data.driveId, 'broken');
});

test('TsDriveRuntime: afterTurn 把 tool/fact/note delta 合并进 outcome', () => {
  const { runtime, outcomes } = mkRuntime();
  runtime.register(makeStubDrive('op'));
  const fired = runtime.beforeTurn(mkState());
  assert.equal(fired.length, 1);

  runtime.afterTurn(fired, {
    toolCalls: [
      { toolName: 'webSearch', success: true, resultSnippet: 'result' },
    ],
    newFactIds: ['f1'],
    newNoteIds: ['n1'],
    pursuitProgressMarkerIds: ['m1'],
  });

  const o = outcomes.get(fired[0].outcomeId)!;
  assert.equal((o.subsequentToolCalls as unknown[]).length, 1);
  assert.deepEqual(o.memoryDelta.factIds, ['f1']);
  assert.deepEqual(o.memoryDelta.noteIds, ['n1']);
  assert.deepEqual(o.memoryDelta.pursuitProgressMarkers, ['m1']);
});

test('TsDriveRuntime: maxInjectionsPerTurn > 1 可并发注入', () => {
  const db = new Database(':memory:');
  initSchema(db);
  const outcomes = new DriveOutcomeStore(db);
  const runtime = new TsDriveRuntime(outcomes, {
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    maxInjectionsPerTurn: 2,
  });
  runtime.register(makeStubDrive('a', { utility: 0.3 }));
  runtime.register(makeStubDrive('b', { utility: 0.8 }));
  runtime.register(makeStubDrive('c', { utility: 0.5 }));

  const fired = runtime.beforeTurn(mkState());
  assert.equal(fired.length, 2);
  assert.deepEqual(
    fired.map((f) => f.driveId),
    ['b', 'c'],
  );
});
