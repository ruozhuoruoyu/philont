/**
 * askUserQuestion 工具单测 —— 纯函数(schema 校验、reply 解析、问题渲染)。
 *
 * 跨 turn 的 pending state / 恢复行为是 chat-handler 的职责,不在这测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askUserQuestionTool,
  parseQuestionAnswer,
  renderQuestion,
} from '../src/utility/askUserQuestion.js';

// ── schema 校验 ──────────────────────────────────────────

test('execute: 正常输入 → success + pending marker', async () => {
  const r = await askUserQuestionTool.execute({
    question: '哪一篇是你要的?',
    options: [{ label: 'A' }, { label: 'B' }],
  });
  assert.equal(r.success, true);
  assert.equal(r.output, '__pending_user_response__');
});

test('execute: 空 question 拒绝', async () => {
  const r = await askUserQuestionTool.execute({
    question: '',
    options: [{ label: 'A' }, { label: 'B' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /question is required/);
});

test('execute: 纯空白 question 拒绝', async () => {
  const r = await askUserQuestionTool.execute({
    question: '   \n  ',
    options: [{ label: 'A' }, { label: 'B' }],
  });
  assert.equal(r.success, false);
});

test('execute: options < 2 拒绝', async () => {
  const r = await askUserQuestionTool.execute({
    question: 'q',
    options: [{ label: 'A' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /2-9/);
});

test('execute: options > 9 拒绝', async () => {
  const r = await askUserQuestionTool.execute({
    question: 'q',
    options: Array.from({ length: 10 }, (_, i) => ({ label: `o${i}` })),
  });
  assert.equal(r.success, false);
});

test('execute: option 缺 label 拒绝', async () => {
  const r = await askUserQuestionTool.execute({
    question: 'q',
    options: [{ label: 'A' }, {} as any],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /label/);
});

test('execute: option label 过长拒绝', async () => {
  const r = await askUserQuestionTool.execute({
    question: 'q',
    options: [{ label: 'A' }, { label: 'x'.repeat(81) }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /80/);
});

test('execute: 非数组 options 拒绝', async () => {
  const r = await askUserQuestionTool.execute({
    question: 'q',
    options: 'nope' as any,
  });
  assert.equal(r.success, false);
});

// ── renderQuestion ────────────────────────────────────────

test('renderQuestion: 基本渲染含 ❓ + 编号', () => {
  const out = renderQuestion('要哪个?', [{ label: '甲' }, { label: '乙' }], false);
  assert.match(out, /❓ 要哪个\?/);
  assert.match(out, /1\. 甲/);
  assert.match(out, /2\. 乙/);
  assert.match(out, /reply with a number between 1 and 2/);
});

test('renderQuestion: 带 description', () => {
  const out = renderQuestion(
    '选论文',
    [
      { label: 'V4 Tech Report', description: 'arxiv 2604.xxxxx' },
      { label: 'Conditional Memory', description: 'arxiv 2601.07372' },
    ],
    false,
  );
  assert.match(out, /1\. V4 Tech Report — arxiv 2604/);
  assert.match(out, /2\. Conditional Memory — arxiv 2601\.07372/);
});

test('renderQuestion: allowFreeText 改提示语', () => {
  const out = renderQuestion('q', [{ label: 'A' }, { label: 'B' }], true);
  assert.match(out, /reply with the option number, or just type your answer/);
});

// ── parseQuestionAnswer ──────────────────────────────────

const opts = [{ label: '甲' }, { label: '乙' }, { label: '丙' }];

test('parse: 半角数字 1 → option 0', () => {
  const r = parseQuestionAnswer('1', 'q', opts, false);
  assert.equal(r.kind, 'option');
  if (r.kind === 'option') {
    assert.equal(r.index, 0);
    assert.equal(r.label, '甲');
    assert.match(r.content, /User selected option \[1\]: 甲/);
  }
});

test('parse: 半角数字 + 后缀文字仍命中', () => {
  const r = parseQuestionAnswer('2 ok', 'q', opts, false);
  assert.equal(r.kind, 'option');
  if (r.kind === 'option') assert.equal(r.index, 1);
});

test('parse: 全角数字 ２ 命中', () => {
  const r = parseQuestionAnswer('２', 'q', opts, false);
  assert.equal(r.kind, 'option');
  if (r.kind === 'option') assert.equal(r.index, 1);
});

test('parse: 数字越界 → reprompt', () => {
  const r = parseQuestionAnswer('5', 'q', opts, false);
  assert.equal(r.kind, 'reprompt');
  if (r.kind === 'reprompt') {
    assert.match(r.message, /between 1 and 3/);
    assert.match(r.message, /❓ q/); // 重新渲染了问题
  }
});

test('parse: 数字 0 → reprompt(用户从 1 数起)', () => {
  const r = parseQuestionAnswer('0', 'q', opts, false);
  assert.equal(r.kind, 'reprompt');
});

test('parse: 非数字 + allowFreeText=false → freetext(2026-05-07 修正:不再死循环)', () => {
  // 实战:微信用户回"随便选一个"这种自然语言时,旧逻辑卡 reprompt 死循环。
  // 新逻辑统一转 freetext 喂给 LLM 自己判断。
  const r = parseQuestionAnswer('随便选一个', 'q', opts, false);
  assert.equal(r.kind, 'freetext');
  if (r.kind === 'freetext') {
    assert.match(r.content, /随便选一个/);
  }
});

test('parse: 非数字 + allowFreeText=true → freetext', () => {
  const r = parseQuestionAnswer('那个 deepseek 论文', 'q', opts, true);
  assert.equal(r.kind, 'freetext');
  if (r.kind === 'freetext') {
    assert.match(r.content, /User reply \(free text\): 那个 deepseek 论文/);
  }
});

test('parse: 空回复 + allowFreeText=任意 仍 reprompt(空无内容可解析)', () => {
  assert.equal(parseQuestionAnswer('   ', 'q', opts, true).kind, 'reprompt');
  assert.equal(parseQuestionAnswer('', 'q', opts, false).kind, 'reprompt');
});

test('parse: 实战微信场景 — 用户自然语言答 → freetext 不再死循环', () => {
  // 来自 prod log 2026-05-07:askUserQuestion 4 选项,allowFreeText=false
  // 用户答"刚才说的2MW端边侧token工厂"被卡 reprompt 死循环
  const fourOpts = [
    { label: 'opt1' }, { label: 'opt2' }, { label: 'opt3' }, { label: 'opt4' },
  ];
  const r = parseQuestionAnswer('刚才说的2MW端边侧token工厂', 'q', fourOpts, false);
  assert.equal(r.kind, 'freetext');
});

test('parse: 数字优先 over freetext(即使 allowFreeText=true)', () => {
  const r = parseQuestionAnswer('1', 'q', opts, true);
  assert.equal(r.kind, 'option');
});

test('parse: tab/换行包围的数字也命中', () => {
  const r = parseQuestionAnswer('\t 3 \n', 'q', opts, false);
  assert.equal(r.kind, 'option');
  if (r.kind === 'option') assert.equal(r.index, 2);
});
