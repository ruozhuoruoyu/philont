/**
 * K7 → K8 桥单测。纯函数测试,手工构造 FiredDrive / HonestyEvaluation 喂入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectK7BridgeInitiatives,
  bridgeTaskCommitment,
  bridgeHonesty,
  extractAbsolutePath,
} from '../src/index.js';
import type { FiredDrive } from '../src/drive_runtime.js';
import type { HonestyEvaluation } from '../src/honesty_gate.js';

// ── extractAbsolutePath ─────────────────────────────────────────────────

test('extractAbsolutePath: POSIX 路径', () => {
  assert.equal(extractAbsolutePath('文件保存到 /tmp/foo.docx 完成'), '/tmp/foo.docx');
  assert.equal(extractAbsolutePath('/home/user/x.pdf'), '/home/user/x.pdf');
});

test('extractAbsolutePath: Windows 路径', () => {
  assert.equal(extractAbsolutePath('保存到 C:\\Users\\foo.docx'), 'C:\\Users\\foo.docx');
});

test('extractAbsolutePath: file:// URI', () => {
  assert.equal(extractAbsolutePath('see file:///tmp/x.txt for'), 'file:///tmp/x.txt');
});

test('extractAbsolutePath: 没有路径 → null', () => {
  assert.equal(extractAbsolutePath('普通文本没有路径'), null);
});

test('extractAbsolutePath: 引号包围的路径', () => {
  assert.equal(extractAbsolutePath('"/tmp/quoted.docx"'), '/tmp/quoted.docx');
});

// ── bridgeTaskCommitment ────────────────────────────────────────────────

function makeFired(over: Partial<FiredDrive> = {}): FiredDrive {
  return {
    driveId: 'task-commitment',
    outcomeId: 'outcome-1',
    servedPursuitId: null,
    injectedMessage: 'inject text',
    utility: 0.6,
    triggerSnapshot: {
      lastAssistantHead: '你可以自己运行 curl 下载',
      matchedLanguage: 'zh',
      matchedPattern: 0,
      matchedVerb: '下载',
      matchedSnippet: '你可以自己运行 curl 下载',
      taskHint: '帮我下载一个 PDF',
    },
    ...over,
  };
}

test('bridgeTaskCommitment: 正常 fired → 产 commitment:research-handoff', () => {
  const p = bridgeTaskCommitment(makeFired());
  assert.ok(p);
  assert.equal(p!.kind, 'commitment:research-handoff');
  assert.equal(p!.driver, 'k7-bridge');
  assert.match(p!.targetRef, /^commit:[a-f0-9]{12}$/);
  assert.equal(p!.utility, 0.8);
  assert.ok(p!.plan && p!.plan.length === 3);
  assert.equal(p!.plan![0].tool, 'searchSkills');
  assert.equal(p!.plan![1].tool, 'searchNotes');
  assert.equal(p!.plan![2].tool, 'webSearch');
});

test('bridgeTaskCommitment: 同 snippet+verb hash 稳定', () => {
  const p1 = bridgeTaskCommitment(makeFired());
  const p2 = bridgeTaskCommitment(makeFired());
  assert.equal(p1!.targetRef, p2!.targetRef);
});

test('bridgeTaskCommitment: 不同 snippet → 不同 hash', () => {
  const p1 = bridgeTaskCommitment(makeFired());
  const p2 = bridgeTaskCommitment(
    makeFired({
      triggerSnapshot: {
        ...(makeFired().triggerSnapshot as object),
        matchedSnippet: '你可以自己运行 wget 下载',
      },
    }),
  );
  assert.notEqual(p1!.targetRef, p2!.targetRef);
});

test('bridgeTaskCommitment: 缺 matchedSnippet → null', () => {
  const fired = makeFired({ triggerSnapshot: { matchedVerb: 'x' } });
  assert.equal(bridgeTaskCommitment(fired), null);
});

test('bridgeTaskCommitment: taskHint 进 query', () => {
  const p = bridgeTaskCommitment(makeFired());
  const q = (p!.plan![0].params as { query: string }).query;
  assert.match(q, /帮我下载/);
});

// ── bridgeHonesty 各分支 ────────────────────────────────────────────────

function makeHonesty(reason: HonestyEvaluation['reason']): HonestyEvaluation {
  return {
    severity: 'high',
    reason,
    matchedClaim: '已下载',
    okCount: 0,
    failCount: 1,
    unknownCount: 0,
    evidence: 'evidence text',
  };
}

test('bridgeHonesty: fabricated_size_claim **不再桥接** → null(2026-06-02)', () => {
  // turn 内静默 gate 已挡住真编造;idle 期 inspectPath 复核对"陈旧记忆里的旧大小"
  // 误触发,砍掉外显回路。fabricated_size 不应再产 K8 initiative。
  const e = { ...makeHonesty('fabricated_size_claim'), matchedClaim: '577KB' };
  const p = bridgeHonesty(
    e,
    [{ toolName: 'shell', content: '⚠ TOOL FAILED: ...' }],
    '文件 /tmp/test.docx 大小 577KB',
    'session-1:1234',
  );
  assert.equal(p, null);
});

test('bridgeHonesty: failures_with_claim → searchSkills/Notes/webSearch with failed tool name', () => {
  const e: HonestyEvaluation = {
    ...makeHonesty('failures_with_claim'),
    failCount: 2,
    okCount: 0,
  };
  const p = bridgeHonesty(
    e,
    [
      { toolName: 'shell', content: '⚠ TOOL FAILED' },
      { toolName: 'webFetch', content: '⚠ TOOL FAILED' },
      { toolName: 'noisy', content: '✓ TOOL OK' },
    ],
    'agent text',
    'turn-y',
  );
  assert.ok(p);
  assert.equal(p!.kind, 'honesty:retry-failed-tool');
  assert.equal(p!.utility, 0.85);
  assert.ok(p!.plan && p!.plan.length === 3);
  const q = (p!.plan![0].params as { query: string }).query;
  assert.match(q, /shell.*webFetch|webFetch.*shell/);
});

test('bridgeHonesty: memory_claim_without_write → audit 笔记,plan 空', () => {
  const e = { ...makeHonesty('memory_claim_without_write'), matchedClaim: 'I will remember' };
  const p = bridgeHonesty(e, [], '', 'turn-mem');
  assert.ok(p);
  assert.equal(p!.kind, 'honesty:audit-memory-lapse');
  assert.equal(p!.utility, 0.7);
  assert.deepEqual(p!.plan, []);
});

test('bridgeHonesty: unverified_destructive **死分支不再桥接** → null(2026-06-02)', () => {
  // evaluateHonesty 自 2026-05-18 起不再产此 reason(branch 2 停 fire),
  // 桥保留 case 标签纯为文档,实际返回 null。
  const e = { ...makeHonesty('unverified_destructive'), severity: 'medium' as const };
  const p = bridgeHonesty(
    e,
    [{ toolName: 'writeFile', content: '✓ TOOL OK: wrote /tmp/out.txt' }],
    '已生成文件',
    'turn-z',
  );
  assert.equal(p, null);
});

test('bridgeHonesty: unknown_results_with_claim → audit-trail', () => {
  const e = {
    ...makeHonesty('unknown_results_with_claim'),
    severity: 'medium' as const,
    failCount: 0,
    okCount: 0,
    unknownCount: 2,
  };
  const p = bridgeHonesty(e, [], '', 'turn-unk');
  assert.ok(p);
  assert.equal(p!.kind, 'honesty:audit-trail');
  assert.equal(p!.utility, 0.65);
  assert.deepEqual(p!.plan, []);
});

// ── collectK7BridgeInitiatives ──────────────────────────────────────────

test('collect: TaskCommitment + Honesty(failures) 同时 fired → 两条 proposal', () => {
  const ps = collectK7BridgeInitiatives({
    fired: [makeFired()],
    honesty: {
      eval: { ...makeHonesty('failures_with_claim'), failCount: 2, okCount: 0 },
      toolResults: [{ toolName: 'shell', content: '⚠ TOOL FAILED' }],
      assistantText: 'agent text',
    },
    observations: { toolCalls: [] },
    turnRef: 'session-1:111',
  });
  assert.equal(ps.length, 2);
  assert.equal(ps[0].kind, 'commitment:research-handoff');
  assert.equal(ps[1].kind, 'honesty:retry-failed-tool');
});

test('collect: TaskCommitment + fabricated_size fired → 只 1 条(size 不再桥接)', () => {
  const ps = collectK7BridgeInitiatives({
    fired: [makeFired()],
    honesty: {
      eval: { ...makeHonesty('fabricated_size_claim'), matchedClaim: '999MB' },
      toolResults: [],
      assistantText: '/tmp/foo.bin 实际 999MB',
    },
    observations: { toolCalls: [] },
    turnRef: 'session-1:111',
  });
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'commitment:research-handoff');
});

test('collect: 无 fired + 无 honesty → 空数组', () => {
  const ps = collectK7BridgeInitiatives({
    fired: [],
    observations: { toolCalls: [] },
  });
  assert.equal(ps.length, 0);
});

test('collect: recentDoneTargetRefs 命中 → dedup 跳过', () => {
  const fired = makeFired();
  const probe = bridgeTaskCommitment(fired);
  const ps = collectK7BridgeInitiatives({
    fired: [fired],
    observations: { toolCalls: [] },
    recentDoneTargetRefs: new Set([probe!.targetRef]),
  });
  assert.equal(ps.length, 0);
});

test('collect: 非 task-commitment driveId → 跳过', () => {
  const fired = makeFired({ driveId: 'some-other-drive' });
  const ps = collectK7BridgeInitiatives({
    fired: [fired],
    observations: { toolCalls: [] },
  });
  assert.equal(ps.length, 0);
});

test('collect: rationale 中标注 K7 来源', () => {
  const ps = collectK7BridgeInitiatives({
    fired: [makeFired()],
    observations: { toolCalls: [] },
  });
  assert.match(ps[0].rationale, /K7 TaskCommitment/);
});
