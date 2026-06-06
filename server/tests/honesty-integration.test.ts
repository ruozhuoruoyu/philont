/**
 * extractRecentToolResults 单测 —— 给 HonestyGate 喂的本轮工具结果切片要正确。
 *
 * 关键 invariants:
 *   - 从本轮起点(最近一条 string-content user 之后)正序扫
 *   - tool_use_id → toolName 映射通过同 turn 内的 assistant tool_use block 建立
 *   - tool_result block 的 content 既支持 string 也支持 [{type:'text', text}]
 *   - 跨 turn 的 tool_use/tool_result 不串到本轮
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecentToolResults } from '../src/chat-handler.js';
import type { NativeMessage } from '../src/llm-adapter.js';

function toolUseMsg(blocks: Array<{ id: string; name: string; input?: any }>): NativeMessage {
  return {
    role: 'assistant',
    content: blocks.map((b) => ({
      type: 'tool_use' as const,
      id: b.id,
      name: b.name,
      input: b.input ?? {},
    })),
  } as any;
}

function toolResultMsg(blocks: Array<{ id: string; content: string }>): NativeMessage {
  return {
    role: 'user',
    content: blocks.map((b) => ({
      type: 'tool_result' as const,
      tool_use_id: b.id,
      content: b.content,
    })),
  } as any;
}

test('extractRecentToolResults: 单一 tool_result 块,带 toolName', () => {
  const msgs: NativeMessage[] = [
    { role: 'user', content: '帮我转 docx' },
    toolUseMsg([{ id: 't1', name: 'shell' }]),
    toolResultMsg([{ id: 't1', content: '⚠ TOOL FAILED — exit=1' }]),
  ];
  const out = extractRecentToolResults(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].toolName, 'shell');
  assert.match(out[0].content, /TOOL FAILED/);
});

test('extractRecentToolResults: 多轮 tool_result(同 turn) → 全部收集 + 名字配对', () => {
  // 模拟 LLM tool_use → result → tool_use → result 多回合
  const msgs: NativeMessage[] = [
    { role: 'user', content: '装 pandoc' },
    toolUseMsg([{ id: 't1', name: 'shell' }]),
    toolResultMsg([{ id: 't1', content: '⚠ TOOL FAILED — exit=9009' }]),
    toolUseMsg([{ id: 't2', name: 'shell' }]),
    toolResultMsg([{ id: 't2', content: '⚠ TOOL FAILED — winget not found' }]),
    toolUseMsg([{ id: 't3', name: 'writeFile' }]),
    toolResultMsg([{ id: 't3', content: '⚠ TOOL FAILED — perm denied' }]),
  ];
  const out = extractRecentToolResults(msgs);
  assert.equal(out.length, 3, '本 turn 内 3 次 tool_result 都该收上来');
  assert.deepEqual(out.map((r) => r.toolName), ['shell', 'shell', 'writeFile']);
  for (const r of out) assert.match(r.content, /TOOL FAILED/);
});

test('extractRecentToolResults: 撞到 string-content user 就停(不跨 turn)', () => {
  const msgs: NativeMessage[] = [
    { role: 'user', content: '上一个 turn 的话题' },
    toolUseMsg([{ id: 'old', name: 'readFile' }]),
    toolResultMsg([{ id: 'old', content: '✓ TOOL OK\n上回的结果' }]),
    { role: 'assistant', content: '上回我做完了' } as any,
    { role: 'user', content: '本轮新需求' }, // ← turn 边界
    toolUseMsg([{ id: 't1', name: 'shell' }]),
    toolResultMsg([{ id: 't1', content: '⚠ TOOL FAILED — 本轮' }]),
  ];
  const out = extractRecentToolResults(msgs);
  assert.equal(out.length, 1, '只该返回本 turn 的 1 条,跨边界的不算');
  assert.equal(out[0].toolName, 'shell');
  assert.match(out[0].content, /本轮/);
});

test('extractRecentToolResults: tool_result content 是 [{type:text}] 数组形式', () => {
  // Anthropic SDK 也允许 tool_result content 是结构化 block 数组
  const msgs: NativeMessage[] = [
    { role: 'user', content: 'do it' },
    toolUseMsg([{ id: 't1', name: 'webSearch' }]),
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: '⚠ TOOL FAILED — block-array form' },
          ],
        },
      ],
    } as any,
  ];
  const out = extractRecentToolResults(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].toolName, 'webSearch');
  assert.match(out[0].content, /block-array/);
});

test('extractRecentToolResults: tool_use_id 配不上(跨 turn 残留) → toolName 留空', () => {
  // tool_result 的 id 在本轮没有对应 tool_use,toolName 应该是空,不是 undefined
  const msgs: NativeMessage[] = [
    { role: 'user', content: 'do it' },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'orphan-id',
          content: '✓ TOOL OK',
        },
      ],
    } as any,
  ];
  const out = extractRecentToolResults(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].toolName, '');
});

test('extractRecentToolResults: 空 messages → 空数组', () => {
  assert.deepEqual(extractRecentToolResults([]), []);
});

test('extractRecentToolResults: 没有 tool_result(纯文本对话) → 空数组', () => {
  const msgs: NativeMessage[] = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好,有什么可以帮你?' } as any,
  ];
  assert.deepEqual(extractRecentToolResults(msgs), []);
});
