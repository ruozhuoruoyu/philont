/**
 * mini-agent-loop 单测。
 *
 * 用 stub LLM client + stub toolRunner 验证内核行为。不依赖真 LLM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMiniAgentLoop,
  type MiniLoopLLMClient,
  type MiniLoopLLMResponse,
  type MiniLoopMessage,
  type MiniLoopToolRunResult,
} from '../src/utils/mini-agent-loop.js';
import type { ToolDefinition } from '@agent/policy';

// ── 测试辅助 ────────────────────────────────────────────────────────────

const NO_TOOLS: ToolDefinition[] = [];

function stubLLM(scripted: MiniLoopLLMResponse[]): MiniLoopLLMClient {
  let i = 0;
  return {
    async send() {
      if (i >= scripted.length) {
        throw new Error(`stub LLM exhausted at call ${i + 1}`);
      }
      return scripted[i++];
    },
  };
}

function textResponse(content: string, tokensUsed = 100): MiniLoopLLMResponse {
  return { type: 'text', content, tokensUsed };
}

function toolCallResponse(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  tokensUsed = 100,
): MiniLoopLLMResponse {
  return {
    type: 'toolCalls',
    calls,
    assistantMessage: {
      role: 'assistant',
      content: calls.map((c) => ({
        type: 'tool_use' as const,
        id: c.id,
        name: c.name,
        input: c.input,
      })),
    },
    tokensUsed,
  };
}

// ── 测试 1:text-first response ─────────────────────────────────────────

test('text-first:LLM 直接出文本 → finalText 填充 + itersUsed=1', async () => {
  const llm = stubLLM([textResponse('done!')]);
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'hello',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: true, output: '' }),
  });

  assert.equal(r.finalText, 'done!');
  assert.equal(r.itersUsed, 1);
  assert.equal(r.hitCap, false);
  assert.equal(r.toolCallHistory.length, 0);
  assert.equal(r.toolCallsSpent, 0);
  assert.equal(r.error, undefined);
  assert.equal(r.llmTokensSpent, 100);
});

// ── 测试 2:tool cycle ─────────────────────────────────────────────────

test('tool cycle:LLM 调工具 → toolRunner ok → LLM 回文本结束', async () => {
  const llm = stubLLM([
    toolCallResponse([{ id: 'tc-1', name: 'readFile', input: { path: '/x' } }]),
    textResponse('I read it: hello'),
  ]);
  const calls: string[] = [];
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'read /x',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async (name, input) => {
      calls.push(`${name}:${JSON.stringify(input)}`);
      return { ok: true, output: 'hello' };
    },
  });

  assert.equal(r.finalText, 'I read it: hello');
  assert.equal(r.itersUsed, 2);
  assert.equal(r.hitCap, false);
  assert.equal(r.toolCallHistory.length, 1);
  assert.equal(r.toolCallHistory[0].name, 'readFile');
  assert.equal(r.toolCallHistory[0].ok, true);
  assert.match(r.toolCallHistory[0].outputPreview, /hello/);
  assert.equal(r.toolCallsSpent, 1);
  assert.deepEqual(calls, ['readFile:{"path":"/x"}']);
});

// ── 测试 3:iter cap ────────────────────────────────────────────────────

test('iter cap:LLM 死循环调工具 → 撞 cap 返回 hitCap=true,无 throw', async () => {
  // LLM 永远调 readFile,撞 cap=3
  const llm: MiniLoopLLMClient = {
    async send() {
      return toolCallResponse([
        { id: 'tc-' + Math.random(), name: 'readFile', input: {} },
      ]);
    },
  };
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'go',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: true, output: 'ok' }),
    maxIters: 3,
  });

  assert.equal(r.hitCap, true);
  assert.equal(r.itersUsed, 3);
  assert.equal(r.finalText, '');
  assert.equal(r.toolCallHistory.length, 3);
  assert.equal(r.toolCallsSpent, 3);
  assert.equal(r.error, undefined); // hitCap 不算 error
});

// ── 测试 4:whitelist 拦截 ──────────────────────────────────────────────

test('whitelist 拦截:LLM 调白名单外工具 → 返回 rejection,loop 继续', async () => {
  const llm = stubLLM([
    toolCallResponse([{ id: 'tc-1', name: 'shell', input: { command: 'rm -rf /' } }]),
    textResponse('ok understood, will not'),
  ]);
  let runnerCalled = false;
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'try shell',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => {
      runnerCalled = true;
      return { ok: true, output: '' };
    },
    toolWhitelist: new Set(['readFile', 'listDir']),
  });

  assert.equal(runnerCalled, false, 'toolRunner should NOT be called for blocked tool');
  assert.equal(r.toolCallHistory.length, 1);
  assert.equal(r.toolCallHistory[0].ok, false);
  assert.match(r.toolCallHistory[0].outputPreview, /sub-loop whitelist/);
  assert.equal(r.finalText, 'ok understood, will not');
  assert.equal(r.itersUsed, 2);
});

// ── 测试 5:blacklist 拦截 ──────────────────────────────────────────────

test('blacklist 拦截:LLM 调黑名单工具 → 返回 rejection,loop 继续', async () => {
  const llm = stubLLM([
    toolCallResponse([
      { id: 'tc-1', name: 'planAndExecute', input: { task: 'nest' } },
    ]),
    textResponse('cannot nest'),
  ]);
  let runnerCalled = false;
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'try',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => {
      runnerCalled = true;
      return { ok: true, output: '' };
    },
    toolBlacklist: new Set(['planAndExecute', 'askUserQuestion']),
  });

  assert.equal(runnerCalled, false);
  assert.equal(r.toolCallHistory.length, 1);
  assert.equal(r.toolCallHistory[0].ok, false);
  assert.match(r.toolCallHistory[0].outputPreview, /sub-loop blacklist/);
  assert.equal(r.finalText, 'cannot nest');
});

// ── 测试 6:abortSignal ────────────────────────────────────────────────

test('abortSignal:中途 abort → 返回 error=aborted', async () => {
  const ac = new AbortController();
  // LLM 第一次调用前就 abort
  ac.abort();
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'go',
    llm: stubLLM([textResponse('never')]),
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: true, output: '' }),
    abortSignal: ac.signal,
  });

  assert.equal(r.error, 'aborted');
  assert.equal(r.finalText, '');
  assert.equal(r.itersUsed, 0);
});

// ── 测试 7(额外):tool runner throw → 优雅返回 tool error,loop 继续 ──

test('toolRunner throw:捕获并转 tool error,loop 继续', async () => {
  const llm = stubLLM([
    toolCallResponse([{ id: 'tc-1', name: 'shell', input: { command: 'oops' } }]),
    textResponse('handled'),
  ]);
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'go',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => {
      throw new Error('bug in runner');
    },
  });

  assert.equal(r.toolCallHistory[0].ok, false);
  assert.match(r.toolCallHistory[0].outputPreview, /tool runner threw/);
  assert.equal(r.finalText, 'handled');
});

// ── 测试 8(额外):多 tool calls 一轮 → 全部跑 ───────────────────────

test('单轮多 tool_use:全部跑完再下一轮', async () => {
  const llm = stubLLM([
    toolCallResponse([
      { id: 'tc-1', name: 'readFile', input: { path: '/a' } },
      { id: 'tc-2', name: 'readFile', input: { path: '/b' } },
    ]),
    textResponse('both read'),
  ]);
  const calls: string[] = [];
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'multi',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async (_n, input) => {
      calls.push(input.path as string);
      return { ok: true, output: `read ${input.path}` };
    },
  });

  assert.equal(r.toolCallHistory.length, 2);
  assert.equal(r.toolCallsSpent, 2);
  assert.equal(r.itersUsed, 2);
  assert.deepEqual(calls, ['/a', '/b']);
});
