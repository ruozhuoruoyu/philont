/**
 * 短答 binding heuristic 单测
 *
 * 覆盖:
 *   - detectUnclosedQuestion 各种 happy / 反例
 *   - findLastAssistantText / findLastUserText 跳过 tool_use 数组
 *   - renderBindingContext / renderAskGuardRejection 文案完整性
 *
 * 集成验证(注入 + guard 在 chat-handler 中触发)留给现有 honesty-integration
 * 风格的端到端测试,本文件聚焦 helper 单元行为。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUnclosedQuestion,
  findLastAssistantText,
  findLastUserText,
  renderBindingContext,
  renderAskGuardRejection,
} from '../src/short_answer_binding.js';

// ── detectUnclosedQuestion ──────────────────────────────────────────────────

test('detect: 末尾问号 → 命中', () => {
  const r = detectUnclosedQuestion('需要我把这个产品list导出成Word文档吗?');
  assert.equal(r.hasQuestion, true);
  assert.match(r.snippet, /Word文档/);
});

test('detect: 末尾全角问号 → 命中', () => {
  const r = detectUnclosedQuestion('要继续吗？');
  assert.equal(r.hasQuestion, true);
  assert.match(r.snippet, /要继续/);
});

test('detect: 中间有问号 + 末尾陈述 → 仍命中(末尾 200 字内有 ?)', () => {
  const r = detectUnclosedQuestion('我看了下文件。需要我导出 Word 吗?  请回复 1-3 之间的数字');
  assert.equal(r.hasQuestion, true);
});

test('detect: 中文疑问短语 "是否" → 命中', () => {
  const r = detectUnclosedQuestion('我先停一下。是否需要我继续');
  assert.equal(r.hasQuestion, true);
  assert.match(r.snippet, /是否/);
});

test('detect: 中文疑问短语 "要不要" → 命中', () => {
  const r = detectUnclosedQuestion('提取完成。要不要我把它存成文件');
  assert.equal(r.hasQuestion, true);
  assert.match(r.snippet, /要不要/);
});

test('detect: 英文 "do you" → 命中', () => {
  const r = detectUnclosedQuestion('All done. Do you want me to commit it');
  assert.equal(r.hasQuestion, true);
});

test('detect: 纯陈述句 → 不命中', () => {
  const r = detectUnclosedQuestion('我已经把文件导出成 Word 文档,保存到了 /tmp/out.docx。');
  assert.equal(r.hasQuestion, false);
});

test('detect: 空字符串 / 非 string → 不命中', () => {
  assert.equal(detectUnclosedQuestion('').hasQuestion, false);
  assert.equal(detectUnclosedQuestion('   ').hasQuestion, false);
  assert.equal(detectUnclosedQuestion(null).hasQuestion, false);
  assert.equal(detectUnclosedQuestion(undefined).hasQuestion, false);
  assert.equal(detectUnclosedQuestion({} as unknown).hasQuestion, false);
});

test('detect: snippet 长度 ≤ 100', () => {
  const long = '前面很多铺垫'.repeat(20) + '需要我导出 Word 吗?';
  const r = detectUnclosedQuestion(long);
  assert.equal(r.hasQuestion, true);
  assert.ok(r.snippet.length <= 100);
});

test('detect: 非 hasQuestion 时 snippet 为空', () => {
  const r = detectUnclosedQuestion('这是一段陈述。结束。');
  assert.equal(r.hasQuestion, false);
  assert.equal(r.snippet, '');
});

// ── findLastAssistantText ────────────────────────────────────────────────────

test('findLastAssistantText: 倒序找最近 assistant string', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '问个问题' },
    { role: 'assistant', content: '答 A' },
    { role: 'user', content: '再问' },
    { role: 'assistant', content: '答 B' },
  ];
  assert.equal(findLastAssistantText(messages), '答 B');
});

test('findLastAssistantText: 跳过 tool_use 数组形式', () => {
  const messages = [
    { role: 'assistant', content: '是文本答' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'shell', input: {} }] },
  ];
  // 末尾是 tool_use 数组 → 应该跳到前面那条
  assert.equal(findLastAssistantText(messages), '是文本答');
});

test('findLastAssistantText: startBefore 限制查找范围', () => {
  const messages = [
    { role: 'assistant', content: 'A' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'B' },
  ];
  assert.equal(findLastAssistantText(messages, 2), 'A');
  assert.equal(findLastAssistantText(messages, 3), 'B');
});

test('findLastAssistantText: 空 / 全 user → null', () => {
  assert.equal(findLastAssistantText([]), null);
  assert.equal(findLastAssistantText([{ role: 'user', content: 'q' }]), null);
});

// ── findLastUserText ────────────────────────────────────────────────────────

test('findLastUserText: 跳过 tool_results 数组形式', () => {
  const messages = [
    { role: 'user', content: '真问句' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] },
  ];
  assert.equal(findLastUserText(messages), '真问句');
});

test('findLastUserText: 倒序优先末尾', () => {
  const messages = [
    { role: 'user', content: '老的' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: '新的' },
  ];
  assert.equal(findLastUserText(messages), '新的');
});

// ── renderBindingContext ────────────────────────────────────────────────────

test('renderBindingContext: 含原问 + user 答 + 切换话题指引', () => {
  const out = renderBindingContext('需要我导出 Word 吗?', '导出成 word 文档');
  assert.match(out, /上一轮你问的问题/);
  assert.match(out, /需要我导出 Word/);
  assert.match(out, /导出成 word 文档/);
  assert.match(out, /优先/);
  assert.match(out, /新话题/);
});

test('renderBindingContext: user 答超长截断', () => {
  const long = 'x'.repeat(500);
  const out = renderBindingContext('Q', long);
  // user 截到 200
  const reply = out.match(/\[本轮 user 答: ([^\]]+)\]/)?.[1] ?? '';
  assert.ok(reply.length <= 200);
});

// ── renderAskGuardRejection ─────────────────────────────────────────────────

test('renderAskGuardRejection: 包含原问 + user 答 + 拒绝指引', () => {
  const out = renderAskGuardRejection('要不要导出?', '要');
  assert.match(out, /ask_guard/);
  assert.match(out, /要不要导出/);
  assert.match(out, /要/);
  assert.match(out, /先消化/);
  assert.match(out, /不要二次追问/);
});
