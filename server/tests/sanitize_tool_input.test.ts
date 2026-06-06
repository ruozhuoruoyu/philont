/**
 * sanitizeToolInput 单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeToolInput,
  findFirstObjectEnd,
  sanitizeAssistantMessageBlocks,
} from '../src/sanitize_tool_input.js';

// ── 路径 1:object 直接通过 ─────────────────────────────────────────────

test('object: 普通对象 → 直接返', () => {
  const r = sanitizeToolInput({ pattern: '*.ts', cwd: '/tmp' });
  assert.equal(r.path, 'object');
  assert.deepEqual(r.input, { pattern: '*.ts', cwd: '/tmp' });
});

test('object: 空对象也通过', () => {
  const r = sanitizeToolInput({});
  assert.equal(r.path, 'object');
  assert.deepEqual(r.input, {});
});

// ── 路径 2:string 单 JSON ──────────────────────────────────────────────

test('string-single: 合法 JSON object 字符串 → parse 后返', () => {
  const r = sanitizeToolInput('{"pattern":"*.ts","cwd":"/tmp"}');
  assert.equal(r.path, 'string-single-json');
  assert.deepEqual(r.input, { pattern: '*.ts', cwd: '/tmp' });
});

test('string-single: 含中文也 OK', () => {
  const r = sanitizeToolInput('{"query":"哥德巴赫猜想"}');
  assert.equal(r.path, 'string-single-json');
  assert.deepEqual(r.input, { query: '哥德巴赫猜想' });
});

// ── 路径 3:多 JSON 拼接(实战 #1 bug) ─────────────────────────────────

test('multi: 两个 JSON 拼接 → 取首段', () => {
  // 来自 prod log 2026-05-07 实战样本
  const raw = '{"pattern":"**/*2MW*.pdf","cwd":"E:\\\\dev\\\\philont\\\\server"}{"query":"制作PPT"}';
  const r = sanitizeToolInput(raw);
  assert.equal(r.path, 'string-multi-json');
  assert.deepEqual(r.input, {
    pattern: '**/*2MW*.pdf',
    cwd: 'E:\\dev\\philont\\server',
  });
  assert.match(r.reason ?? '', /多 JSON 拼接/);
  assert.ok((r.truncatedTailLen ?? 0) > 0);
});

test('multi: 三个 JSON 拼接 → 仍只取首段', () => {
  const raw = '{"a":1}{"b":2}{"c":3}';
  const r = sanitizeToolInput(raw);
  assert.equal(r.path, 'string-multi-json');
  assert.deepEqual(r.input, { a: 1 });
});

test('multi: 嵌套对象 — brace-balance 正确处理', () => {
  const raw = '{"outer":{"nested":1,"deep":{"x":"y"}}}{"another":2}';
  const r = sanitizeToolInput(raw);
  assert.equal(r.path, 'string-multi-json');
  assert.deepEqual(r.input, {
    outer: { nested: 1, deep: { x: 'y' } },
  });
});

test('multi: 字符串里有 } 字面量 → 不被误识别为闭合', () => {
  const raw = '{"path":"a}b/c{d","x":1}{"y":2}';
  const r = sanitizeToolInput(raw);
  assert.equal(r.path, 'string-multi-json');
  assert.deepEqual(r.input, { path: 'a}b/c{d', x: 1 });
});

test('multi: 转义字符正确处理 (\\")', () => {
  const raw = '{"text":"he said \\"hi\\""}{"other":"x"}';
  const r = sanitizeToolInput(raw);
  assert.equal(r.path, 'string-multi-json');
  assert.deepEqual(r.input, { text: 'he said "hi"' });
});

// ── 路径 4:网关 wrap-once {raw_arguments: "<json>"} 展开(实战 #2,2026-05-23)──

test('unwrap: raw_arguments wrap → 展开内层', () => {
  const inner = '{"path":"E:\\\\dev\\\\philont\\\\server\\\\a.html","content":"<html>x</html>"}';
  const r = sanitizeToolInput({ raw_arguments: inner });
  assert.equal(r.path, 'unwrap-raw-arguments');
  assert.deepEqual(r.input, {
    path: 'E:\\dev\\philont\\server\\a.html',
    content: '<html>x</html>',
  });
  assert.match(r.reason ?? '', /raw_arguments/);
});

test('unwrap: arguments wrap → 同理展开', () => {
  const r = sanitizeToolInput({ arguments: '{"query":"小升初"}' });
  assert.equal(r.path, 'unwrap-raw-arguments');
  assert.deepEqual(r.input, { query: '小升初' });
});

test('unwrap: raw_args / tool_arguments 别名也展开', () => {
  const r1 = sanitizeToolInput({ raw_args: '{"x":1}' });
  assert.equal(r1.path, 'unwrap-raw-arguments');
  assert.deepEqual(r1.input, { x: 1 });
  const r2 = sanitizeToolInput({ tool_arguments: '{"y":2}' });
  assert.equal(r2.path, 'unwrap-raw-arguments');
  assert.deepEqual(r2.input, { y: 2 });
});

test('unwrap: 多 key 不当 wrap 处理(防误抓)', () => {
  // 正常 input 里有个字段叫 arguments,不能误展开
  const r = sanitizeToolInput({ arguments: '{"x":1}', other: 'value' });
  assert.equal(r.path, 'object');
  assert.deepEqual(r.input, { arguments: '{"x":1}', other: 'value' });
});

test('unwrap: wrap value 不是 string → 走原 object 路径', () => {
  const r = sanitizeToolInput({ raw_arguments: { already: 'parsed' } });
  assert.equal(r.path, 'object');
  assert.deepEqual(r.input, { raw_arguments: { already: 'parsed' } });
});

test('unwrap: wrap value 是字符串但 parse 失败 → 走原 object 路径', () => {
  // 工具自己将就处理,sanitize 不强行 reject(可能是工具就要个 string)
  const r = sanitizeToolInput({ raw_arguments: 'not json at all' });
  assert.equal(r.path, 'object');
});

test('unwrap: wrap value parse 后不是 object(是 array)→ 不展开', () => {
  const r = sanitizeToolInput({ raw_arguments: '[1,2,3]' });
  assert.equal(r.path, 'object');
});

test('unwrap: 实战样本 — writeFile 被包了一层', () => {
  // 还原 prod log 2026-05-23 样本
  const r = sanitizeToolInput({
    raw_arguments: JSON.stringify({
      path: 'E:\\dev\\philont\\server\\resume.html',
      content: '<!DOCTYPE html>\n<html><body>x</body></html>',
    }),
  });
  assert.equal(r.path, 'unwrap-raw-arguments');
  assert.equal((r.input as Record<string, unknown>).path, 'E:\\dev\\philont\\server\\resume.html');
  assert.match(String((r.input as Record<string, unknown>).content), /^<!DOCTYPE html>/);
});

// ── 拒绝路径 ────────────────────────────────────────────────────────────

test('reject: null', () => {
  const r = sanitizeToolInput(null);
  assert.equal(r.path, 'reject');
  assert.equal(r.input, null);
  assert.match(r.reason ?? '', /null/);
});

test('reject: undefined', () => {
  const r = sanitizeToolInput(undefined);
  assert.equal(r.path, 'reject');
  assert.match(r.reason ?? '', /undefined/);
});

test('reject: array', () => {
  const r = sanitizeToolInput([1, 2, 3]);
  assert.equal(r.path, 'reject');
  assert.match(r.reason ?? '', /对象/);
});

test('reject: number', () => {
  const r = sanitizeToolInput(42);
  assert.equal(r.path, 'reject');
});

test('reject: boolean', () => {
  const r = sanitizeToolInput(true);
  assert.equal(r.path, 'reject');
});

test('reject: 空字符串', () => {
  const r = sanitizeToolInput('');
  assert.equal(r.path, 'reject');
});

test('reject: 纯空白字符串', () => {
  const r = sanitizeToolInput('   \n\t  ');
  assert.equal(r.path, 'reject');
});

test('reject: 字符串但 parse 后是 array', () => {
  const r = sanitizeToolInput('[1,2,3]');
  assert.equal(r.path, 'reject');
});

test('reject: 字符串但 parse 后是 number', () => {
  const r = sanitizeToolInput('42');
  assert.equal(r.path, 'reject');
});

test('reject: 字符串无 { 字符', () => {
  const r = sanitizeToolInput('hello world');
  assert.equal(r.path, 'reject');
});

test('reject: 字符串括号未闭合', () => {
  const r = sanitizeToolInput('{"a":1');
  assert.equal(r.path, 'reject');
  assert.match(r.reason ?? '', /未闭合/);
});

test('reject: 截取出来的首段也无法 parse', () => {
  // 头有 { 但内部不合法 JSON 语法
  const r = sanitizeToolInput('{not valid}{"valid":1}');
  // 第一个 } 在 "not valid" 之后,brace-balance 算它是闭合,parse 失败
  assert.equal(r.path, 'reject');
});

// ── findFirstObjectEnd 工具函数 ─────────────────────────────────────────

test('findFirstObjectEnd: 简单对象', () => {
  assert.equal(findFirstObjectEnd('{"a":1}', 0), 6);
});

test('findFirstObjectEnd: 嵌套对象', () => {
  const s = '{"a":{"b":1}}';
  assert.equal(findFirstObjectEnd(s, 0), s.length - 1);
});

test('findFirstObjectEnd: 字符串里的 } 不算', () => {
  const s = '{"x":"a}b"}';
  assert.equal(findFirstObjectEnd(s, 0), s.length - 1);
});

test('findFirstObjectEnd: 起始非 { → -1', () => {
  assert.equal(findFirstObjectEnd('hello', 0), -1);
});

test('findFirstObjectEnd: 未闭合 → -1', () => {
  assert.equal(findFirstObjectEnd('{"a":1', 0), -1);
});

test('findFirstObjectEnd: 多对象只到第一个闭合', () => {
  const s = '{"a":1}{"b":2}';
  assert.equal(findFirstObjectEnd(s, 0), 6);
});

// ── sanitizeAssistantMessageBlocks ──────────────────────────────────────

test('sanitizeAsst: 无 tool_use blocks → 原样返', () => {
  const msg = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
  const r = sanitizeAssistantMessageBlocks(msg);
  assert.equal(r.stats.totalToolUse, 0);
  assert.equal(r.stats.fixed, 0);
  assert.equal(r.stats.rejected, 0);
  assert.deepEqual(r.msg.content, msg.content);
});

test('sanitizeAsst: string content → 原样返', () => {
  const msg = { role: 'assistant', content: 'plain text reply' };
  const r = sanitizeAssistantMessageBlocks(msg);
  assert.equal(r.msg, msg);
});

test('sanitizeAsst: 全合法 object input → 不动', () => {
  const msg = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'glob', input: { pattern: '*.ts' } },
    ],
  };
  const r = sanitizeAssistantMessageBlocks(msg);
  assert.equal(r.stats.totalToolUse, 1);
  assert.equal(r.stats.fixed, 0);
  assert.deepEqual((r.msg.content as Array<Record<string, unknown>>)[0].input, { pattern: '*.ts' });
});

test('sanitizeAsst: tool_use input 是多 JSON string → 修(stats.fixed=1)', () => {
  const msg = {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'glob',
        input: '{"pattern":"*.ts"}{"query":"X"}',
      },
    ],
  };
  const r = sanitizeAssistantMessageBlocks(msg);
  assert.equal(r.stats.totalToolUse, 1);
  assert.equal(r.stats.fixed, 1);
  assert.deepEqual((r.msg.content as Array<Record<string, unknown>>)[0].input, { pattern: '*.ts' });
});

test('sanitizeAsst: 不合法 input → rejected → 兜底 {} (stats.rejected=1)', () => {
  const msg = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'shell', input: 'not json at all' },
    ],
  };
  const r = sanitizeAssistantMessageBlocks(msg);
  assert.equal(r.stats.rejected, 1);
  assert.deepEqual((r.msg.content as Array<Record<string, unknown>>)[0].input, {});
});

test('sanitizeAsst: 多 block 混合 — 部分 fix 部分不动', () => {
  const msg = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will run two tools' },
      { type: 'tool_use', id: 't1', name: 'glob', input: { pattern: '*.ts' } },
      { type: 'tool_use', id: 't2', name: 'shell', input: '{"a":1}{"b":2}' },
    ],
  };
  const r = sanitizeAssistantMessageBlocks(msg);
  assert.equal(r.stats.totalToolUse, 2);
  assert.equal(r.stats.fixed, 1);
  const blocks = r.msg.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(blocks[1].input, { pattern: '*.ts' });
  assert.deepEqual(blocks[2].input, { a: 1 });
});

test('sanitizeAsst: 不 mutate 原对象', () => {
  const orig = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'shell', input: '{"a":1}{"b":2}' },
    ],
  };
  const before = JSON.stringify(orig);
  sanitizeAssistantMessageBlocks(orig);
  assert.equal(JSON.stringify(orig), before, '原对象不应被修改');
});
