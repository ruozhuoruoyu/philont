/**
 * planAndExecute 集成测试 — 验证 chat-handler 特有的 adapter wiring 行为。
 *
 * 重点不重复 agent-tools/tests/plan-and-execute.test.ts 已覆盖的内核逻辑,
 * 这里专门验证:
 *   1. LLMAdapter 包装成 MiniLoopLLMClient 后,systemPrompt 正确拼到 user 前缀
 *   2. LLMResponse text / toolCalls 正确转 MiniLoopLLMResponse
 *   3. 端到端:用 mock LLMAdapter 驱动 planAndExecute 跑通
 *   4. blacklist nested planAndExecute 在子 loop 被拒
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlanAndExecuteTool,
  PlanBudgetTracker,
  registerMainLLM,
  clearMainLLMRegistration,
  type MiniLoopLLMClient,
  type MiniLoopLLMResponse,
  type MiniLoopMessage,
  type MiniLoopToolRunResult,
} from '@agent/tools';
import type {
  LLMAdapter,
  LLMResponse,
  NativeMessage,
} from '../src/llm-adapter.js';
import type { ToolDefinition } from '@agent/policy';

// ── chat-handler 同款 adapter wrapper(测试本地复制,验证逻辑) ────────────

function buildMiniLoopLLM(llm: LLMAdapter): MiniLoopLLMClient {
  return {
    async send(systemPrompt, messages, toolDefs) {
      const adjusted: NativeMessage[] = messages.length > 0
        ? messages.map((m, i) => {
            if (i === 0 && m.role === 'user' && typeof m.content === 'string') {
              return {
                role: 'user',
                content: `# 子 sub-task 系统指令\n${systemPrompt}\n\n# 子 sub-task 任务\n${m.content}`,
              };
            }
            return m as NativeMessage;
          })
        : [{ role: 'user', content: systemPrompt }];

      const resp = await llm.send(adjusted, toolDefs);
      return resp as unknown as MiniLoopLLMResponse;
    },
  };
}

// ── 测试辅助:mock LLMAdapter ────────────────────────────────────────────

class MockLLMAdapter implements LLMAdapter {
  public sentRequests: { messages: NativeMessage[]; tools?: ToolDefinition[] }[] = [];
  constructor(public scripted: LLMResponse[]) {}
  async send(messages: NativeMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
    this.sentRequests.push({ messages, tools });
    if (this.scripted.length === 0) {
      throw new Error('mock LLM exhausted');
    }
    return this.scripted.shift()!;
  }
}

const NO_TOOLS: ToolDefinition[] = [];
const NOOP_RUNNER = async (): Promise<MiniLoopToolRunResult> => ({
  ok: true,
  output: '',
});

beforeEach(() => {
  registerMainLLM(async (req) => `[MOCK] ${req.user.slice(0, 30)}`);
});

afterEach(() => {
  clearMainLLMRegistration();
});

// ── 测试 1:systemPrompt 拼到 user 前缀 ──────────────────────────────────

test('adapter:systemPrompt 拼到 messages[0] user 前缀', async () => {
  const mock = new MockLLMAdapter([{ type: 'text', content: 'ack' }]);
  const wrapped = buildMiniLoopLLM(mock);

  await wrapped.send(
    'YOU ARE A SUB AGENT',
    [{ role: 'user', content: 'do task' }],
    NO_TOOLS,
  );

  assert.equal(mock.sentRequests.length, 1);
  const sent = mock.sentRequests[0].messages[0];
  assert.equal(sent.role, 'user');
  assert.match(sent.content as string, /YOU ARE A SUB AGENT/);
  assert.match(sent.content as string, /do task/);
  // 拼装顺序:系统指令在前,任务在后
  const content = sent.content as string;
  assert.ok(
    content.indexOf('YOU ARE A SUB AGENT') < content.indexOf('do task'),
    'systemPrompt 应在任务前',
  );
});

// ── 测试 2:LLMResponse text → MiniLoopLLMResponse text ────────────────

test('adapter:LLMResponse text 转换正确', async () => {
  const mock = new MockLLMAdapter([
    { type: 'text', content: 'hello world' },
  ]);
  const wrapped = buildMiniLoopLLM(mock);

  const resp = await wrapped.send(
    'sys',
    [{ role: 'user', content: 'test' }],
    NO_TOOLS,
  );

  assert.equal(resp.type, 'text');
  if (resp.type === 'text') {
    assert.equal(resp.content, 'hello world');
  }
});

// ── 测试 3:LLMResponse toolCalls → MiniLoopLLMResponse toolCalls ──────

test('adapter:LLMResponse toolCalls 转换 + assistantMessage 保留', async () => {
  const toolUseBlock = {
    type: 'tool_use' as const,
    id: 'tc-1',
    name: 'readFile',
    input: { path: '/x' },
  };
  const mock = new MockLLMAdapter([
    {
      type: 'toolCalls',
      calls: [{ id: 'tc-1', name: 'readFile', input: { path: '/x' } }],
      assistantMessage: { role: 'assistant', content: [toolUseBlock] },
    },
  ]);
  const wrapped = buildMiniLoopLLM(mock);

  const resp = await wrapped.send('sys', [{ role: 'user', content: 'go' }], NO_TOOLS);

  assert.equal(resp.type, 'toolCalls');
  if (resp.type === 'toolCalls') {
    assert.equal(resp.calls.length, 1);
    assert.equal(resp.calls[0].name, 'readFile');
    assert.equal(resp.assistantMessage.role, 'assistant');
  }
});

// ── 测试 4:端到端 — planAndExecute 接 mock LLMAdapter 跑通 ─────────────

test('e2e:planAndExecute 接 mock LLMAdapter,2 sub-tasks 全跑成功', async () => {
  // 模拟 LLM 序列:
  //   1. planner 调用(无 tools):返回 plan JSON
  //   2. sub-task 1 调用(允许 tools,但 LLM 出 text):"did task 1"
  //   3. sub-task 2 调用:"did task 2"
  const mock = new MockLLMAdapter([
    {
      type: 'text',
      content: JSON.stringify({
        subTasks: [
          { id: 'st-1', description: 'task 1', dependsOn: [] },
          { id: 'st-2', description: 'task 2', dependsOn: [] },
        ],
      }),
    },
    { type: 'text', content: 'did task 1' },
    { type: 'text', content: 'did task 2' },
  ]);

  const wrapped = buildMiniLoopLLM(mock);

  const tool = createPlanAndExecuteTool({
    llm: wrapped,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
    budgetTracker: new PlanBudgetTracker(),
  });

  const result = await tool.execute({
    task: '做两件事',
    aggregateMode: 'concat',
  });

  assert.equal(result.success, true);
  assert.match(result.output ?? '', /st-1/);
  assert.match(result.output ?? '', /st-2/);
  assert.match(result.output ?? '', /2 成功/);
  // 应该恰好 3 次 LLM 调用:1 plan + 2 sub-task
  assert.equal(mock.sentRequests.length, 3);
});

// ── 测试 5:子 loop 调 planAndExecute(嵌套) → blacklist 拦截 ──────────

test('e2e:子 loop 调 planAndExecute → blacklist 拦截,sub-task 仍能完成', async () => {
  const mock = new MockLLMAdapter([
    // planner
    {
      type: 'text',
      content: JSON.stringify({
        subTasks: [
          { id: 'st-1', description: 'try nest', dependsOn: [] },
          { id: 'st-2', description: 'normal', dependsOn: [] },
        ],
      }),
    },
    // sub-task 1 第一轮:LLM 试图嵌套
    {
      type: 'toolCalls',
      calls: [
        { id: 'tc-1', name: 'planAndExecute', input: { task: 'nested!' } },
      ],
      assistantMessage: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use' as const,
            id: 'tc-1',
            name: 'planAndExecute',
            input: { task: 'nested!' },
          },
        ],
      },
    },
    // sub-task 1 第二轮:看到 rejection 后转 text
    { type: 'text', content: 'understood, no nesting' },
    // sub-task 2
    { type: 'text', content: 'normal done' },
  ]);

  const wrapped = buildMiniLoopLLM(mock);

  let runnerCalls = 0;
  const tool = createPlanAndExecuteTool({
    llm: wrapped,
    toolRunner: async () => {
      runnerCalls++;
      return { ok: true, output: '' };
    },
    toolDefs: NO_TOOLS,
    // 默认 blacklist 已包含 planAndExecute
  });

  const r = await tool.execute({ task: 'mixed', aggregateMode: 'concat' });
  assert.equal(r.success, true);
  assert.equal(runnerCalls, 0, 'blacklist 拦截 → toolRunner 不应被调');
  // 两个 sub-task 都该 success
  assert.match(r.output ?? '', /2 成功/);
});
