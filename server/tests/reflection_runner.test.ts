/**
 * Reflection runner — collectReflectionState 单测
 *
 * maybeRunReflection 端到端测试需要 mock LLM,会引入复杂度。本文件只覆盖
 * collectReflectionState 的纯函数行为,maybeRunReflection 留给 1.e 集成验证。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReflectionState } from '../src/reflection_runner.js';

test('collectState: 空 messages → turnCount=0 toolFailures=0', () => {
  const s = collectReflectionState([], '随便');
  assert.equal(s.turnCount, 0);
  assert.equal(s.toolFailures, 0);
  assert.equal(s.taskClosing, false);
});

test('collectState: 计 user role string content', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ] as const;
  const s = collectReflectionState(messages as any, 'q3');
  assert.equal(s.turnCount, 2);
});

test('collectState: tool_result 数组里的 ⚠ 算 failure', () => {
  const messages = [
    { role: 'user', content: 'q' },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '⚠ TOOL FAILED: shell exit 1' },
        { type: 'tool_result', tool_use_id: 'b', content: '✓ OK' },
        { type: 'tool_result', tool_use_id: 'c', content: '⚠ another fail' },
      ],
    },
  ];
  const s = collectReflectionState(messages as any, '继续');
  assert.equal(s.toolFailures, 2);
});

test('collectState: TOOL FAILED 大小写不敏感', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'tool failed exit 1' },
      ],
    },
  ];
  const s = collectReflectionState(messages as any, 'x');
  assert.equal(s.toolFailures, 1);
});

test('collectState: tool_result 数组 user role 不计入 turnCount', () => {
  const messages = [
    { role: 'user', content: 'real q' },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: '✓' }],
    },
  ];
  const s = collectReflectionState(messages as any, 'x');
  assert.equal(s.turnCount, 1);
});

test('collectState: taskClosing 中文短语命中', () => {
  const cases = ['完成', '搞定了', '搞好', '没问题了', '可以了', '好了'];
  for (const c of cases) {
    const s = collectReflectionState([], c);
    assert.equal(s.taskClosing, true, `应命中: ${c}`);
  }
});

test('collectState: taskClosing 英文短语命中', () => {
  const cases = ['done', 'finished', 'all set', "that's it"];
  for (const c of cases) {
    const s = collectReflectionState([], c);
    assert.equal(s.taskClosing, true, `应命中: ${c}`);
  }
});

test('collectState: 普通对话不命中 taskClosing', () => {
  const s = collectReflectionState([], '帮我做个 X');
  assert.equal(s.taskClosing, false);
});

test('collectState: 默认 signals → 全 false/0', () => {
  const s = collectReflectionState([], 'x');
  assert.equal(s.honestyFired, false);
  assert.equal(s.interruptDrained, false);
  assert.equal(s.sameRootCauseFailures, 0);
  assert.equal(s.taskDurationMin, 0);
});

// D.2 (2026-05-06):turn-local signals 接入

test('collectState: signals.honestyFired=true → state.honestyFired=true', () => {
  const s = collectReflectionState([], 'x', { honestyFired: true });
  assert.equal(s.honestyFired, true);
});

test('collectState: signals.interruptDrained=true → state.interruptDrained=true', () => {
  const s = collectReflectionState([], 'x', { interruptDrained: true });
  assert.equal(s.interruptDrained, true);
});

test('collectState: turnStartTs 推算 taskDurationMin', () => {
  const past = Date.now() - 25 * 60_000;
  const s = collectReflectionState([], 'x', { turnStartTs: past });
  assert.ok(s.taskDurationMin >= 24 && s.taskDurationMin <= 26, `got ${s.taskDurationMin}`);
});

test('collectState: turnStartTs 在未来 → taskDurationMin 不可为负', () => {
  const s = collectReflectionState([], 'x', { turnStartTs: Date.now() + 60_000 });
  assert.ok(s.taskDurationMin >= 0);
});

test('collectState: turnStartTs=0 视为未设置', () => {
  const s = collectReflectionState([], 'x', { turnStartTs: 0 });
  assert.equal(s.taskDurationMin, 0);
});

test('collectState: sameRootCauseFailures 透传(暂未自动接入)', () => {
  const s = collectReflectionState([], 'x', { sameRootCauseFailures: 4 });
  assert.equal(s.sameRootCauseFailures, 4);
});

test('collectState: signals 各字段独立(只设 honesty 不影响 interrupt)', () => {
  const s = collectReflectionState([], 'x', { honestyFired: true });
  assert.equal(s.honestyFired, true);
  assert.equal(s.interruptDrained, false);
  assert.equal(s.taskDurationMin, 0);
});
