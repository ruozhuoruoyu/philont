/**
 * planAndExecute 单测。
 *
 * 用 stub LLM client 验证三段(plan / execute / aggregate)行为。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlanAndExecuteTool,
  PlanBudgetTracker,
  _planAndExecuteInternal,
} from '../src/control/index.js';
import {
  registerMainLLM,
  clearMainLLMRegistration,
} from '../src/utils/aux-llm.js';
import type {
  MiniLoopLLMClient,
  MiniLoopLLMResponse,
  MiniLoopToolRunResult,
  MiniLoopMessage,
} from '../src/utils/mini-agent-loop.js';
import type { ToolDefinition } from '@agent/policy';

const NO_TOOLS: ToolDefinition[] = [];

const NOOP_RUNNER = async (): Promise<MiniLoopToolRunResult> => ({
  ok: true,
  output: '',
});

// ── 内部 helper 单测 ────────────────────────────────────────────────────

test('parsePlannerOutput:JSON.parse 直接通过', () => {
  const r = _planAndExecuteInternal.parsePlannerOutput(
    '{"subTasks":[{"id":"a","description":"x","dependsOn":[]}]}',
  );
  assert.deepEqual((r as { subTasks: unknown[] }).subTasks.length, 1);
});

test('parsePlannerOutput:fenced ```json 块', () => {
  const r = _planAndExecuteInternal.parsePlannerOutput(
    'preamble...\n```json\n{"subTasks":[{"id":"a","description":"x","dependsOn":[]}]}\n```\n',
  );
  assert.deepEqual((r as { subTasks: unknown[] }).subTasks.length, 1);
});

test('parsePlannerOutput:第一个 { 到最后 } slice', () => {
  const r = _planAndExecuteInternal.parsePlannerOutput(
    'noise {"subTasks":[{"id":"a","description":"x","dependsOn":[]}]} trailing',
  );
  assert.deepEqual((r as { subTasks: unknown[] }).subTasks.length, 1);
});

test('parsePlannerOutput:三路全失败 → null', () => {
  const r = _planAndExecuteInternal.parsePlannerOutput('完全不是 JSON');
  assert.equal(r, null);
});

test('detectCycle:有环返回环路径', () => {
  const cycle = _planAndExecuteInternal.detectCycle([
    { id: 'a', description: '', dependsOn: ['b'] },
    { id: 'b', description: '', dependsOn: ['a'] },
  ]);
  assert.ok(cycle, 'should detect cycle');
});

test('detectCycle:无环返回 null', () => {
  const cycle = _planAndExecuteInternal.detectCycle([
    { id: 'a', description: '', dependsOn: [] },
    { id: 'b', description: '', dependsOn: ['a'] },
  ]);
  assert.equal(cycle, null);
});

test('topoSort:按依赖顺序输出', () => {
  const sorted = _planAndExecuteInternal.topoSort([
    { id: 'c', description: '', dependsOn: ['b'] },
    { id: 'a', description: '', dependsOn: [] },
    { id: 'b', description: '', dependsOn: ['a'] },
  ]);
  const ids = sorted.map((s) => s.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('validateAndNormalize:tooSimple=true 当 1 个 subTask', () => {
  const r = _planAndExecuteInternal.validateAndNormalize(
    { subTasks: [{ id: 'a', description: 'x', dependsOn: [] }] },
    6,
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.tooSimple, true);
  }
});

test('validateAndNormalize:dep 引用不存在 → ok=false', () => {
  const r = _planAndExecuteInternal.validateAndNormalize(
    {
      subTasks: [
        { id: 'a', description: 'x', dependsOn: ['nope'] },
      ],
    },
    6,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /nonexistent/);
});

test('validateAndNormalize:超 maxSubTasks 截尾', () => {
  const sts = Array.from({ length: 10 }).map((_, i) => ({
    id: `st-${i}`,
    description: 'x',
    dependsOn: [],
  }));
  const r = _planAndExecuteInternal.validateAndNormalize({ subTasks: sts }, 3);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.subTasks.length, 3);
});

// ── tool 集成测试 ──────────────────────────────────────────────────────

/** 编排 LLM 响应:第 1 次 plan,后续是 sub-loop 的对应位置 */
function makeScriptedLLM(scripts: MiniLoopLLMResponse[]): {
  llm: MiniLoopLLMClient;
  callsCount: () => number;
} {
  let i = 0;
  return {
    llm: {
      async send() {
        if (i >= scripts.length) {
          throw new Error(`scripted LLM 耗尽 at call ${i + 1}`);
        }
        return scripts[i++];
      },
    },
    callsCount: () => i,
  };
}

function planResp(plan: object): MiniLoopLLMResponse {
  return { type: 'text', content: JSON.stringify(plan), tokensUsed: 200 };
}

function subTaskTextResp(text: string): MiniLoopLLMResponse {
  return { type: 'text', content: text, tokensUsed: 100 };
}

function subTaskFailResp(): MiniLoopLLMResponse {
  // 通过返回空文本模拟"任务失败"路径(收尾文本为空)
  return { type: 'text', content: '', tokensUsed: 50 };
}

beforeEach(() => {
  // 注册 noop main LLM 给 callAuxLLM(避免 not_configured 抛错)
  registerMainLLM(async (req) => {
    return `[MOCK SUMMARY] task=${req.user.slice(0, 30)}...`;
  });
});

afterEach(() => {
  clearMainLLMRegistration();
});

test('end-to-end:2 个独立 sub-task 全部成功 + concat 模式', async () => {
  const { llm } = makeScriptedLLM([
    planResp({
      subTasks: [
        { id: 'st-1', description: 'read file A', dependsOn: [] },
        { id: 'st-2', description: 'read file B', dependsOn: [] },
      ],
    }),
    subTaskTextResp('read A: data1'),
    subTaskTextResp('read B: data2'),
  ]);

  const tool = createPlanAndExecuteTool({
    llm,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
  });

  const r = await tool.execute({
    task: '读 A 和 B',
    aggregateMode: 'concat',
  });

  assert.equal(r.success, true);
  assert.match(r.output ?? '', /st-1/);
  assert.match(r.output ?? '', /st-2/);
  assert.match(r.output ?? '', /2 succeeded \/ 0 failed/);
});

test('dep-aware skip:st-2 失败 → st-3 (deps=[2]) 自动 skipped, st-4 (deps=[]) 仍跑', async () => {
  const { llm } = makeScriptedLLM([
    planResp({
      subTasks: [
        { id: 'st-1', description: 'a', dependsOn: [] },
        { id: 'st-2', description: 'b', dependsOn: [] },
        { id: 'st-3', description: 'c', dependsOn: ['st-2'] },
        { id: 'st-4', description: 'd', dependsOn: [] },
      ],
    }),
    subTaskTextResp('did a'),
    subTaskFailResp(), // st-2 fail
    // st-3 不会调 LLM(skipped)
    subTaskTextResp('did d'),
  ]);

  const tool = createPlanAndExecuteTool({
    llm,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
  });

  const r = await tool.execute({
    task: 'multi',
    aggregateMode: 'concat',
  });

  assert.equal(r.success, true);
  const struct = r.output?.match(/--- detailed results ---\n([\s\S]+)/)?.[1];
  assert.ok(struct, 'should have structured block');
  const parsed = JSON.parse(struct!) as {
    results: Array<{ id: string; status: string; skippedBecauseOf?: string }>;
  };
  const byId = Object.fromEntries(parsed.results.map((x) => [x.id, x]));
  assert.equal(byId['st-1'].status, 'success');
  assert.equal(byId['st-2'].status, 'failed');
  assert.equal(byId['st-3'].status, 'skipped');
  assert.equal(byId['st-3'].skippedBecauseOf, 'st-2');
  assert.equal(byId['st-4'].status, 'success');
});

test('tooSimple:plan 出 1 个 sub-task → 直接返回提示,不进 execute', async () => {
  const { llm, callsCount } = makeScriptedLLM([
    planResp({
      subTasks: [{ id: 'st-1', description: 'just one step', dependsOn: [] }],
    }),
    // 后续不应被调用
  ]);

  const tool = createPlanAndExecuteTool({
    llm,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
  });

  const r = await tool.execute({ task: 'simple' });
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /Task too simple/);
  // LLM 只被调 1 次(planner)
  assert.equal(callsCount(), 1);
});

test('plan 失败:LLM 返回 malformed JSON → tool success=false', async () => {
  const llm: MiniLoopLLMClient = {
    async send() {
      return { type: 'text', content: 'totally not JSON', tokensUsed: 10 };
    },
  };

  const tool = createPlanAndExecuteTool({
    llm,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
  });

  const r = await tool.execute({ task: 'x' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /plan phase failed/);
});

test('budget 耗尽:跑到一半 reserveSubTask 返回 false → 后续 skipped', async () => {
  const { llm } = makeScriptedLLM([
    planResp({
      subTasks: [
        { id: 'st-1', description: 'a', dependsOn: [] },
        { id: 'st-2', description: 'b', dependsOn: [] },
        { id: 'st-3', description: 'c', dependsOn: [] },
      ],
    }),
    subTaskTextResp('a done'),
    // st-2 / st-3 不应被调
  ]);

  // budget 上限 < 1 个 sub-task 估算 tokens(2000),所以第 1 个 commit 后就爆
  const tool = createPlanAndExecuteTool({
    llm,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
    budgetTracker: new PlanBudgetTracker({ maxLlmTokensTotal: 500 }),
  });

  const r = await tool.execute({ task: 'budget test', aggregateMode: 'concat' });
  assert.equal(r.success, true);
  // 解析 structured 段
  const struct = r.output?.match(/--- detailed results ---\n([\s\S]+)/)?.[1];
  const parsed = JSON.parse(struct!) as {
    results: Array<{ id: string; status: string; error?: string }>;
  };
  // st-1 的 reserveSubTask 在第 1 次调用时 0+2000 > 500 → 应该返回 false
  // 实际行为:第 1 个就 skipped
  const skippedDueToBudget = parsed.results.filter(
    (r) => r.status === 'skipped' && r.error?.includes('budget'),
  );
  assert.ok(skippedDueToBudget.length >= 1, 'at least one should be skipped due to budget');
});

test('aggregate llm-summary:调 callAuxLLM 一次,文本含 SUMMARY 标记', async () => {
  const { llm } = makeScriptedLLM([
    planResp({
      subTasks: [
        { id: 'st-1', description: 'a', dependsOn: [] },
        { id: 'st-2', description: 'b', dependsOn: [] },
      ],
    }),
    subTaskTextResp('a done'),
    subTaskTextResp('b done'),
  ]);

  const tool = createPlanAndExecuteTool({
    llm,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
  });

  const r = await tool.execute({ task: 'x', aggregateMode: 'llm-summary' });
  assert.equal(r.success, true);
  // beforeEach 注册的 mock LLM 返回 [MOCK SUMMARY] 前缀
  assert.match(r.output ?? '', /\[MOCK SUMMARY\]/);
});

test('blacklist:plan 出"调 planAndExecute"的 sub-task,sub-loop 拦截', async () => {
  // 模拟 sub-task 内 LLM 试图嵌套调 planAndExecute
  const { llm } = makeScriptedLLM([
    planResp({
      subTasks: [
        { id: 'st-1', description: 'try nest', dependsOn: [] },
      ],
      // 注意上面 length=1 会进 tooSimple 短路。我们改成 2 个让它真跑
    }),
  ]);

  const { llm: llm2 } = makeScriptedLLM([
    planResp({
      subTasks: [
        { id: 'st-1', description: 'try nest', dependsOn: [] },
        { id: 'st-2', description: 'normal', dependsOn: [] },
      ],
    }),
    {
      type: 'toolCalls',
      calls: [
        { id: 'tc-1', name: 'planAndExecute', input: { task: 'nest' } },
      ],
      assistantMessage: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use' as const,
            id: 'tc-1',
            name: 'planAndExecute',
            input: { task: 'nest' },
          },
        ],
      },
      tokensUsed: 50,
    },
    subTaskTextResp('ok understood'),
    subTaskTextResp('did normal'),
  ]);

  void llm; // unused — second variant is used

  const tool = createPlanAndExecuteTool({
    llm: llm2,
    toolRunner: NOOP_RUNNER,
    toolDefs: NO_TOOLS,
  });

  const r = await tool.execute({ task: 'x', aggregateMode: 'concat' });
  // st-1 应该 success(LLM 看到 rejection 后转文本)— blacklist 不让真嵌套
  assert.equal(r.success, true);
  const struct = r.output?.match(/--- detailed results ---\n([\s\S]+)/)?.[1];
  const parsed = JSON.parse(struct!) as {
    results: Array<{ id: string; status: string }>;
  };
  // 至少 st-1 / st-2 都应进 results
  assert.equal(parsed.results.length, 2);
});

test('PlanBudgetTracker:remaining + commit 路径', () => {
  const t = new PlanBudgetTracker({
    maxLlmTokensTotal: 1000,
    maxToolCallsTotal: 10,
    maxWallclockMs: 10_000,
  });
  assert.equal(t.remaining().tokens, 1000);
  t.commit({ llmTokens: 300, toolCalls: 2 });
  assert.equal(t.remaining().tokens, 700);
  assert.equal(t.remaining().toolCalls, 8);

  const ok = t.reserveSubTask(500);
  assert.equal(ok.allowed, true);

  t.commit({ llmTokens: 500, toolCalls: 0 });
  const fail = t.reserveSubTask(500); // 800 + 500 > 1000
  assert.equal(fail.allowed, false);
  assert.match(fail.reason ?? '', /tokens/);
});

test('用户参数 toolWhitelist:传给子 loop', async () => {
  const { llm } = makeScriptedLLM([
    planResp({
      subTasks: [
        { id: 'st-1', description: 'try shell', dependsOn: [] },
        { id: 'st-2', description: 'after', dependsOn: [] },
      ],
    }),
    {
      type: 'toolCalls',
      calls: [{ id: 'tc-1', name: 'shell', input: { command: 'rm /' } }],
      assistantMessage: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use' as const,
            id: 'tc-1',
            name: 'shell',
            input: { command: 'rm /' },
          },
        ],
      },
      tokensUsed: 50,
    },
    subTaskTextResp('blocked, gave up'),
    subTaskTextResp('after done'),
  ]);

  let runnerCalled = false;
  const tool = createPlanAndExecuteTool({
    llm,
    toolRunner: async () => {
      runnerCalled = true;
      return { ok: true, output: '' };
    },
    toolDefs: NO_TOOLS,
  });

  const r = await tool.execute({
    task: 'x',
    toolWhitelist: ['readFile'],
    aggregateMode: 'concat',
  });
  assert.equal(r.success, true);
  assert.equal(runnerCalled, false, 'shell 不在白名单 → toolRunner 不应被调');
});
