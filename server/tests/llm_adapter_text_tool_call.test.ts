/**
 * llm-adapter parseTextEmbeddedToolCalls 单测。
 *
 * 实战观察(2026-05-08):某些 LLM provider 把 tool_use 输出成 text 里的
 * <tool_call>{...}</tool_call> 标签而非 native tool_use block。Adapter 需要
 * 识别并救回。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTextEmbeddedToolCalls } from '../src/llm-adapter.js';

test('<tool_call>...</tool_call> 单条', () => {
  const text = '<tool_call>{"name":"webFetch","arguments":{"url":"https://x.com"}}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal(r!.length, 1);
  assert.equal(r![0].name, 'webFetch');
  assert.equal((r![0].input as { url: string }).url, 'https://x.com');
});

test('<tool_call>...</tool_call> 多条', () => {
  const text =
    '<tool_call>{"name":"a","arguments":{}}</tool_call>\n' +
    'preamble\n' +
    '<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal(r!.length, 2);
  assert.equal(r![0].name, 'a');
  assert.equal(r![1].name, 'b');
});

test('```tool_call fenced 块', () => {
  const text = 'I will call:\n```tool_call\n{"name":"x","arguments":{"a":1}}\n```\nthen continue';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal(r!.length, 1);
  assert.equal(r![0].name, 'x');
});

test('<function_call>...</function_call> Gemini 风格', () => {
  const text = '<function_call>{"name":"foo","arguments":{"q":"bar"}}</function_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal(r![0].name, 'foo');
});

test('整段 raw JSON({"name":...,"arguments":...})', () => {
  const text = '{"name":"calc","arguments":{"op":"add","x":1,"y":2}}';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal(r![0].name, 'calc');
});

test('arguments 是字符串(stringified JSON,某些 provider 这么发)', () => {
  const text = '<tool_call>{"name":"f","arguments":"{\\"x\\":1}"}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal((r![0].input as { x: number }).x, 1);
});

test('parameters / input 字段(arguments 替代名)', () => {
  const r1 = parseTextEmbeddedToolCalls('<tool_call>{"name":"f","parameters":{"x":1}}</tool_call>');
  assert.equal((r1![0].input as { x: number }).x, 1);
  const r2 = parseTextEmbeddedToolCalls('<tool_call>{"name":"f","input":{"y":2}}</tool_call>');
  assert.equal((r2![0].input as { y: number }).y, 2);
});

test('普通文本不匹配 → null', () => {
  assert.equal(parseTextEmbeddedToolCalls(''), null);
  assert.equal(parseTextEmbeddedToolCalls('Just a regular response'), null);
  assert.equal(parseTextEmbeddedToolCalls('## 给用户\n你好。'), null);
});

test('malformed JSON in tag → 跳过该条', () => {
  const text = '<tool_call>not json here</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.equal(r, null);
});

test('混合:有效 + 无效 → 仅返有效', () => {
  const text =
    '<tool_call>not json</tool_call>\n' +
    '<tool_call>{"name":"good","arguments":{}}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal(r!.length, 1);
  assert.equal(r![0].name, 'good');
});

test('id 字段保留(若 LLM 给了)', () => {
  const text = '<tool_call>{"id":"call-123","name":"f","arguments":{}}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.equal(r![0].id, 'call-123');
});

test('无 id 字段 → 自动生成', () => {
  const text = '<tool_call>{"name":"f","arguments":{}}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.match(r![0].id, /^text-tool-/);
});

test('实战观察 — webFetch 嵌入文本', () => {
  // 跟 prod log 里实际看到的格式对齐(service URL 用通用 placeholder)
  const text = '<tool_call>{"name":"webFetch","arguments":{"url":"https://api.example.com/svc/guide.md","prompt":"ext"}}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.ok(r);
  assert.equal(r![0].name, 'webFetch');
  assert.equal((r![0].input as { url: string }).url, 'https://api.example.com/svc/guide.md');
});

test('缺 name 字段 → 跳过', () => {
  const text = '<tool_call>{"arguments":{"x":1}}</tool_call>';
  const r = parseTextEmbeddedToolCalls(text);
  assert.equal(r, null);
});
