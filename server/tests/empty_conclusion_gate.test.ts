/**
 * EmptyConclusionGate 单元测试 —— PDF→Word case 暴露的"工具调用堆 + 仅 '.' 输出"
 * 防御。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEmptyConclusion } from '@agent/memory';

test('empty_conclusion_gate: 0 tool call + 空 → 不触发', () => {
  const r = evaluateEmptyConclusion({ toolCallsThisTurn: 0, finalText: '' });
  assert.equal(r.shouldRegenerate, false);
});

test('empty_conclusion_gate: 1 tool call + 完全空 → empty_after_tools', () => {
  const r = evaluateEmptyConclusion({ toolCallsThisTurn: 1, finalText: '' });
  assert.equal(r.shouldRegenerate, true);
  assert.equal(r.reason, 'empty_after_tools');
  assert.equal(r.detail?.toolCallsThisTurn, 1);
  assert.equal(r.detail?.finalTextLength, 0);
});

test('empty_conclusion_gate: 1 tool call + 仅空白 → empty_after_tools', () => {
  const r = evaluateEmptyConclusion({ toolCallsThisTurn: 1, finalText: '   \n\t  ' });
  assert.equal(r.shouldRegenerate, true);
  assert.equal(r.reason, 'empty_after_tools');
});

test('empty_conclusion_gate: 3 tool call + "." → too_short_after_tools (PDF→Word case)', () => {
  const r = evaluateEmptyConclusion({ toolCallsThisTurn: 3, finalText: '.' });
  assert.equal(r.shouldRegenerate, true);
  assert.equal(r.reason, 'too_short_after_tools');
  assert.equal(r.detail?.finalTextLength, 1);
});

test('empty_conclusion_gate: 5 tool call + 真总结 → 不触发', () => {
  const r = evaluateEmptyConclusion({
    toolCallsThisTurn: 5,
    finalText: '已完成转换,文件保存到 ~/output.docx',
  });
  assert.equal(r.shouldRegenerate, false);
});

test('empty_conclusion_gate: 1 tool call + 短回复"OK" → 不触发(单次工具够 OK 兜底)', () => {
  const r = evaluateEmptyConclusion({ toolCallsThisTurn: 1, finalText: 'OK' });
  assert.equal(r.shouldRegenerate, false);
});
