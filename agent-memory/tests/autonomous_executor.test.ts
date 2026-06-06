/**
 * StandardExecutor 单测:工具白名单 / LLM 解析 / sourceRefs 强制 / 写回 memory。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  StandardExecutor,
  parseExecutorOutput,
  type ExtractorLlmClient,
  type Initiative,
  type ToolRunner,
  type ToolRunResult,
} from '../src/index.js';

function fixedLlm(out: string): ExtractorLlmClient {
  return {
    async complete() {
      return { text: out, tokensUsed: 100 };
    },
  };
}

function tools(map: Record<string, ToolRunResult>): ToolRunner {
  return {
    async run(name) {
      return map[name] ?? { ok: false, output: '', error: `tool ${name} not stubbed` };
    },
  };
}

function newInit(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: 'init-test',
    kind: 'fact_gap',
    driver: 'gap',
    targetRef: 'fact:f1',
    rationale: 'low confidence on f1',
    utility: 0.7,
    budgetEstimate: 1500,
    plan: [{ tool: 'webSearch', params: { query: 'foo' } }],
    status: 'running',
    budgetActual: null,
    outcomeSummary: null,
    outcomeRefs: null,
    error: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

const VALID_LLM_OUT = JSON.stringify({
  summary: 'Found that React 18.3 changed useEffect timing.',
  facts: [
    {
      namespace: 'autonomous',
      key: 'react-18.3-useeffect',
      value: { explanation: 'cleanup runs after the next render' },
      confidence: 0.7,
      sourceRefs: ['https://react.dev/release-18.3'],
    },
  ],
  notes: [
    {
      title: 'react@18.3 useEffect 变更',
      body: 'cleanup 时机改了',
      importance: 0.5,
    },
  ],
  shouldEscalate: false,
});

test('parseExecutorOutput: 直接 JSON', () => {
  const r = parseExecutorOutput(VALID_LLM_OUT);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.output.facts.length, 1);
    assert.equal(r.output.facts[0].sourceRefs.length, 1);
    assert.equal(r.output.notes.length, 1);
    assert.equal(r.output.shouldEscalate, false);
  }
});

test('parseExecutorOutput: ```json fenced 块', () => {
  const text = '上一步我跑了:\n```json\n' + VALID_LLM_OUT + '\n```\n';
  const r = parseExecutorOutput(text);
  assert.equal(r.ok, true);
});

test('parseExecutorOutput: 抓 { ... }', () => {
  const text = '我想了一下,产出如下: ' + VALID_LLM_OUT + ' 仅此';
  const r = parseExecutorOutput(text);
  assert.equal(r.ok, true);
});

test('parseExecutorOutput: 空输入 → errors', () => {
  const r = parseExecutorOutput('');
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: 完全不是 JSON → errors', () => {
  const r = parseExecutorOutput('我决定不输出 JSON,你能拿我怎样');
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: 缺 summary → errors', () => {
  const r = parseExecutorOutput(JSON.stringify({ facts: [], notes: [] }));
  assert.equal(r.ok, false);
});

// ── Tier 4 兜底:LLM 内嵌未转义双引号 ────────────────────────────────

test('parseExecutorOutput: tier-4 兜底 — summary 含未转义内嵌双引号', () => {
  // LLM 实战写出来的常见错误:`"summary":"调研了 "工具调用" ..."` —
  // 严格 JSON 在 "工具调用" 处挂。tier-4 抽 summary 救场。
  const broken =
    '{\n  "summary": "本次调研的 "工具调用" 概念,确认为 LLM 调外部 API 行为",\n' +
    '  "facts": [],\n' +
    '  "notes": []\n}';
  const r = parseExecutorOutput(broken);
  assert.equal(r.ok, true, 'tier-4 应救场');
  if (r.ok) {
    assert.match(r.output.summary, /工具调用/);
    // 内嵌引号已替换为单引号,避免下游再读时再挂
    assert.doesNotMatch(r.output.summary, /"工具调用"/);
    assert.match(r.output.summary, /'工具调用'/);
    // facts/notes 救不出来 → 空数组
    assert.equal(r.output.facts.length, 0);
    assert.equal(r.output.notes.length, 0);
    assert.equal(r.output.shouldEscalate, false);
  }
});

test('parseExecutorOutput: tier-4 完全没 summary 字段 → 仍然 errors', () => {
  // LLM 输出连 summary 都没,无救
  const noSummary = '{"foo": "bar baz", "x": 1}';
  const r = parseExecutorOutput(noSummary);
  // 这个其实严格 JSON 能 parse,后续校验缺 summary → ok=false
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: tier-4 summary 太短 → 拒收', () => {
  // 抽出来 < 5 字符,认为没救出来
  const broken = '{"summary":"  hi  ","facts":';
  const r = parseExecutorOutput(broken);
  // 严格 parse 失败 + 抽出来太短 → ok=false
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: tier-4 summary 超长 → 截 1000 字', () => {
  const long = 'A'.repeat(2000);
  const broken = `{"summary":"${long}", "broken":}`;
  const r = parseExecutorOutput(broken);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.output.summary.length <= 1000);
  }
});

// ── Executor 行为 ───────────────────────────────────────────────────────

test('executor: happy path 写 facts + notes', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({
      webSearch: { ok: true, output: 'react 18.3 changed useEffect cleanup timing' },
    }),
  });

  const result = await exe.run(newInit());
  assert.equal(result.status, 'done');
  assert.ok(result.outcomeRefs);
  assert.equal(result.outcomeRefs!.facts.length, 1);
  assert.equal(result.outcomeRefs!.notes.length, 1);
  assert.equal(result.toolCallsSpent, 1);

  // 验真:facts 表里有那条 fact
  const got = handle.facts.getFact('autonomous', 'react-18.3-useeffect');
  assert.ok(got);
  // value 包了 sourceRefs + via
  const v = got!.value as { sourceRefs: string[]; via: string };
  assert.deepEqual(v.sourceRefs, ['https://react.dev/release-18.3']);
  assert.equal(v.via, 'autonomous:init-test');
  handle.close();
});

test('executor: 工具白名单拦截 — 非白名单工具直接 fail', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({}),
  });

  const init = newInit({ plan: [{ tool: 'shell', params: { cmd: 'rm -rf /' } }] });
  const result = await exe.run(init);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /autonomous whitelist/);
  // 没调 LLM,token 应是 0
  assert.equal(result.llmTokensSpent, 0);
  handle.close();
});

test('executor: sourceRefs 空的 fact 被丢弃', async () => {
  const handle = openMemoryDb(':memory:');
  const out = JSON.stringify({
    summary: 'something',
    facts: [
      { key: 'good', value: { x: 1 }, sourceRefs: ['url'] },
      { key: 'bad-no-source', value: { x: 1 }, sourceRefs: [] },
    ],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(out),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });
  const result = await exe.run(newInit());
  assert.equal(result.status, 'done');
  assert.equal(result.outcomeRefs!.facts.length, 1); // bad-no-source 被丢
  handle.close();
});

test('executor: namespace=self 的 fact 被丢弃', async () => {
  const handle = openMemoryDb(':memory:');
  const out = JSON.stringify({
    summary: 'something',
    facts: [
      { namespace: 'self', key: 'summary', value: { x: 1 }, sourceRefs: ['url'] },
      { namespace: 'autonomous', key: 'good', value: { x: 1 }, sourceRefs: ['url'] },
    ],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(out),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });
  const result = await exe.run(newInit());
  assert.equal(result.status, 'done');
  assert.equal(result.outcomeRefs!.facts.length, 1);
  handle.close();
});

test('executor: 工具失败但不抛 → executor 继续到 LLM 摘要', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({
      webSearch: { ok: false, output: '', error: 'network' },
    }),
  });

  const result = await exe.run(newInit());
  // LLM 仍跑(可以基于"工具失败"写笔记),所以 status=done
  assert.equal(result.status, 'done');
  assert.equal(result.toolCallsSpent, 1);
  handle.close();
});

test('executor: LLM 解析失败 → status=failed', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm('我不输出 JSON,我就是不'),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });

  const result = await exe.run(newInit());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /parse failed/);
  handle.close();
});

test('executor: LLM 抛错 → status=failed 不污染 memory', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: {
      async complete() {
        throw new Error('llm down');
      },
    },
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });

  const result = await exe.run(newInit());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /llm down/);
  // memory 没新增 fact
  assert.equal(handle.facts.count(), 0);
  handle.close();
});

test('executor: 无 plan → 直接走 LLM(零工具调用)', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({}),
  });

  const result = await exe.run(newInit({ plan: [] }));
  assert.equal(result.status, 'done');
  assert.equal(result.toolCallsSpent, 0);
  handle.close();
});
