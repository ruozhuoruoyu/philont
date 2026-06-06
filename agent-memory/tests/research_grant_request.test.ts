/**
 * 主动研究"申请权限"(对话内授权)单测。
 *
 * 覆盖整条回路的各环节:
 *   1. PursuitStore.setQuestionPendingTool 写/清;closeOpenQuestion 顺手清 pendingTool。
 *   2. StandardExecutor:LLM 给 requestedTool 且未授权 → done + needsGrant + requestedTool,
 *      不写 facts;工具已授权(isToolGranted)→ 正常跑该 step、不走 needsGrant。
 *   3. applyPursuitProgress:needsGrant 结果 → 写 question.pendingTool(不算 evidence/进度)。
 *   4. PursuitDriver replay:question 有 pendingTool 且 isGranted → plan 追加该 tool step +
 *      跳过 dedup;未授权 → 不追加、dedup 照旧。
 *   5. createResearchTools(.., grantStore):grant_research_tool 写 grant;缺参报错;
 *      不传 grantStore 时不产出该工具。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  StandardExecutor,
  PursuitDriver,
  applyPursuitProgress,
  createResearchTools,
  DEFAULT_PURSUIT_CONFIG,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  type ExtractorLlmClient,
  type Initiative,
  type InitiativeRunResult,
  type ToolRunner,
  type ToolRunResult,
  type MemorySnapshot,
  type Pursuit,
  type OpenQuestion,
  type ResearchGrantSink,
} from '../src/index.js';

const NOW = 1_750_000_000_000;

// ── 共用 mock ────────────────────────────────────────────────────────────────

function fixedLlm(out: string): ExtractorLlmClient {
  return { async complete() { return { text: out, tokensUsed: 100 }; } };
}

function tools(map: Record<string, ToolRunResult>): ToolRunner {
  return {
    async run(name) {
      return map[name] ?? { ok: false, output: '', error: `tool ${name} not stubbed` };
    },
  };
}

function newInit(over: Partial<Initiative> = {}): Initiative {
  return {
    id: 'init-test', kind: 'pursuit:advance-question', driver: 'pursuit',
    targetRef: 'pursuit:r1:q:q1', rationale: '推进问题', utility: 0.9,
    budgetEstimate: 1500, plan: [{ tool: 'webSearch', params: { query: '猜想 X' } }],
    status: 'running', budgetActual: null, outcomeSummary: null, outcomeRefs: null,
    error: null, createdAt: NOW, startedAt: NOW, completedAt: null,
    ...over,
  };
}

function snap(partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    facts: [], routingRules: [], skills: [], activePursuits: [],
    recentTimelineTokens: [], recentDoneTargetRefs: new Set(), now: NOW,
    ...partial,
  };
}

function openQ(over: Partial<OpenQuestion> = {}): OpenQuestion {
  return { id: 'q1', text: '猜想 X 是否成立?', status: 'open', createdTurn: 1, updatedTurn: 1, ...over };
}

function pursuitFixture(over: Partial<Pursuit> = {}): Pursuit {
  return {
    id: 'r1', parentPursuitId: 'default', rootPursuitId: 'default',
    title: '研究猜想 X', intent: '深研究 X', status: 'active', isEvergreen: false,
    stake: 'high', deadline: null, origin: 'user',
    openQuestions: [openQ()], resolutionCriteria: null,
    evidenceRefs: [], progressMarkers: [], lastProgressTurn: 0,
    values: null, redLines: null, driveBounds: null, pursuitGovernance: null,
    lastTouchedAt: NOW - 60_000, stakeWeight: 8,
    isActiveResearch: true, researchIterations: 0,
    createdAt: NOW - 120_000, updatedAt: NOW - 60_000,
    ...over,
  };
}

const REQ_TOOL_OUT = JSON.stringify({
  summary: '只读资料不足以判定猜想真伪,需要形式化验证。',
  facts: [], notes: [],
  shouldEscalate: false,
  requestedTool: { tool: 'runLean', why: '跑 Lean 形式化验证这步推导' },
});

// ── 1. PursuitStore.setQuestionPendingTool / closeOpenQuestion 清理 ───────────

test('setQuestionPendingTool 写入 + closeOpenQuestion 清除 pendingTool', () => {
  const mem = openMemoryDb(':memory:');
  const root = mem.pursuits.getDefaultRoot()!;
  const p = mem.pursuits.createChild({
    parentPursuitId: root.id, title: '研究 X', intent: 'i', origin: 'user', stake: 'high',
    openQuestions: [{ text: '问题1' }], isActiveResearch: true,
  });
  const qid = p.openQuestions[0].id;

  mem.pursuits.setQuestionPendingTool(p.id, qid, { tool: 'runLean', why: '验证' });
  const after = mem.pursuits.get(p.id)!;
  assert.deepEqual(after.openQuestions[0].pendingTool, { tool: 'runLean', why: '验证' });

  // 关问题时自动清 pendingTool
  mem.pursuits.closeOpenQuestion(p.id, qid, 'resolved', 'tag', 0);
  const closed = mem.pursuits.get(p.id)!;
  assert.equal(closed.openQuestions[0].status, 'resolved');
  assert.equal(closed.openQuestions[0].pendingTool, null);
  mem.close();
});

test('setQuestionPendingTool 传 null 清除;未知 questionId 为 no-op', () => {
  const mem = openMemoryDb(':memory:');
  const root = mem.pursuits.getDefaultRoot()!;
  const p = mem.pursuits.createChild({
    parentPursuitId: root.id, title: '研究 X', intent: 'i', origin: 'user', stake: 'high',
    openQuestions: [{ text: '问题1' }], isActiveResearch: true,
  });
  const qid = p.openQuestions[0].id;
  mem.pursuits.setQuestionPendingTool(p.id, qid, { tool: 'runZ3', why: 'w' });
  mem.pursuits.setQuestionPendingTool(p.id, qid, null);
  assert.equal(mem.pursuits.get(p.id)!.openQuestions[0].pendingTool, null);
  // 未知 question:不抛、不改
  mem.pursuits.setQuestionPendingTool(p.id, 'nope', { tool: 'x', why: 'y' });
  assert.equal(mem.pursuits.get(p.id)!.openQuestions[0].pendingTool, null);
  mem.close();
});

// ── 2. StandardExecutor:requestedTool → needsGrant / 已授权放行 ──────────────

test('executor: LLM 给 requestedTool 且未授权 → done+needsGrant+requestedTool,不写 facts', async () => {
  const mem = openMemoryDb(':memory:');
  const ex = new StandardExecutor({
    facts: mem.facts, notes: mem.notes, llm: fixedLlm(REQ_TOOL_OUT),
    tools: tools({ webSearch: { ok: true, output: '一些只读资料' } }),
    isToolGranted: () => false, // 未授权
  });
  const res = await ex.run(newInit());
  assert.equal(res.status, 'done');
  assert.equal(res.needsGrant, true);
  assert.deepEqual(res.requestedTool, { tool: 'runLean', why: '跑 Lean 形式化验证这步推导' });
  assert.match(res.outcomeSummary ?? '', /needs-grant/);
  // 不写 facts/notes(无监督副作用=0)
  assert.equal(mem.facts.listFacts('autonomous').length, 0);
  mem.close();
});

test('executor: requestedTool 已授权(isToolGranted) → 不走 needsGrant,正常产出', async () => {
  const mem = openMemoryDb(':memory:');
  // LLM 这次正常产 fact(模拟拿到授权后那一轮)
  const okOut = JSON.stringify({
    summary: '用 runLean 验证通过', shouldEscalate: false, questionAnswered: true,
    facts: [{ namespace: 'autonomous', key: 'lean-proof', value: { ok: true }, confidence: 0.8, sourceRefs: ['lean://proof'] }],
    notes: [],
  });
  const ex = new StandardExecutor({
    facts: mem.facts, notes: mem.notes, llm: fixedLlm(okOut),
    // plan 含已授权的 gated 工具 step;isToolGranted 放行 → executor 调它而非 fail
    tools: tools({ webSearch: { ok: true, output: 'r' }, runLean: { ok: true, output: 'QED' } }),
    isToolGranted: (t) => t === 'runLean',
  });
  const res = await ex.run(newInit({
    plan: [{ tool: 'webSearch', params: { query: 'X' } }, { tool: 'runLean', params: { goal: 'X' } }],
  }));
  assert.equal(res.status, 'done');
  assert.notEqual(res.needsGrant, true);
  assert.equal(res.questionAnswered, true);
  assert.equal(mem.facts.listFacts('autonomous').length, 1);
  mem.close();
});

test('executor: plan 含未授权 gated 工具 step → 维持 failed', async () => {
  const mem = openMemoryDb(':memory:');
  const ex = new StandardExecutor({
    facts: mem.facts, notes: mem.notes, llm: fixedLlm('{}'),
    tools: tools({ runLean: { ok: true, output: 'x' } }),
    isToolGranted: () => false,
  });
  const res = await ex.run(newInit({ plan: [{ tool: 'runLean', params: {} }] }));
  assert.equal(res.status, 'failed');
  assert.match(res.error ?? '', /autonomous whitelist/);
  mem.close();
});

// ── 3. applyPursuitProgress:needsGrant → 写 question.pendingTool ─────────────

test('applyPursuitProgress: needsGrant 结果写 question.pendingTool,不算 evidence', () => {
  const mem = openMemoryDb(':memory:');
  const root = mem.pursuits.getDefaultRoot()!;
  const p = mem.pursuits.createChild({
    parentPursuitId: root.id, title: '研究 X', intent: 'i', origin: 'user', stake: 'high',
    openQuestions: [{ text: '问题1' }], isActiveResearch: true,
  });
  const qid = p.openQuestions[0].id;
  const init = newInit({ targetRef: `pursuit:${p.id}:q:${qid}` });
  const res: InitiativeRunResult = {
    status: 'done', needsGrant: true, requestedTool: { tool: 'runLean', why: '验证' },
    outcomeSummary: '[needs-grant] ...', llmTokensSpent: 50, toolCallsSpent: 1,
  };
  const r = applyPursuitProgress(mem.pursuits, init, res);
  assert.equal(r.applied, true);
  assert.equal(r.reason, 'applied_grant_request');

  const fresh = mem.pursuits.get(p.id)!;
  assert.deepEqual(fresh.openQuestions[0].pendingTool, { tool: 'runLean', why: '验证' });
  // 没把它当 evidence / 没 bumpProgress
  assert.equal(fresh.evidenceRefs.length, 0);
  assert.equal(fresh.progressMarkers.length, 0);
  mem.close();
});

// ── 4. PursuitDriver replay ───────────────────────────────────────────────────

test('driver replay: question 有 pendingTool 且已授权 → plan 追加该 tool + 跳过 dedup', () => {
  const driver = new PursuitDriver(DEFAULT_PURSUIT_CONFIG, (t) => t === 'runLean');
  const p = pursuitFixture({
    openQuestions: [openQ({ pendingTool: { tool: 'runLean', why: '验证' } })],
  });
  // 即便 targetRef 在 dedup 集合里(上一轮 needs-grant 落 done),也应让路 replay
  const proposals = driver.propose(snap({
    activePursuits: [p],
    recentDoneTargetRefs: new Set([`pursuit:${p.id}:q:q1`]),
  }));
  assert.equal(proposals.length, 1);
  const plan = proposals[0].plan!;
  assert.equal(plan[plan.length - 1].tool, 'runLean', 'plan 末尾应是已授权工具');
  assert.match(proposals[0].rationale, /authorization granted/);
});

test('driver: pendingTool 未授权 → 不追加 tool step,且 dedup 照旧拦截', () => {
  const driver = new PursuitDriver(DEFAULT_PURSUIT_CONFIG, () => false);
  const p = pursuitFixture({
    openQuestions: [openQ({ pendingTool: { tool: 'runLean', why: '验证' } })],
  });
  // dedup 命中 → 未授权时不让路
  const blocked = driver.propose(snap({
    activePursuits: [p],
    recentDoneTargetRefs: new Set([`pursuit:${p.id}:q:q1`]),
  }));
  assert.equal(blocked.length, 0, '未授权 + dedup 命中 → 不提议');

  // dedup 没命中 → 正常提议,但 plan 不含 gated 工具
  const fresh = driver.propose(snap({ activePursuits: [p] }));
  assert.equal(fresh.length, 1);
  assert.ok(!fresh[0].plan!.some((s) => s.tool === 'runLean'), 'plan 不应含未授权工具');
});

// ── 5. grant_research_tool ────────────────────────────────────────────────────

function fakeGrantSink(): ResearchGrantSink & { calls: any[] } {
  const calls: any[] = [];
  return { calls, grant(spec) { calls.push(spec); } };
}

test('grant_research_tool: 写 grant(execute/system/reason=research:<pid>)', async () => {
  const mem = openMemoryDb(':memory:');
  const sink = fakeGrantSink();
  const ts = createResearchTools(mem.pursuits, sink);
  const grantTool = ts.find((t) => t.name === 'grant_research_tool')!;
  assert.ok(grantTool, '提供 grantStore 时应产出 grant_research_tool');

  const r = await grantTool.execute({ pursuitId: 'r1', tool: 'runLean' });
  assert.equal(r.success, true);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0].toolName, 'runLean');
  assert.equal(sink.calls[0].capability, 'execute');
  assert.equal(sink.calls[0].domain, 'system');
  assert.equal(sink.calls[0].reason, 'research:r1');
  assert.ok(sink.calls[0].ttlMs > 0);
  mem.close();
});

test('grant_research_tool: 缺 tool / 缺 pursuitId → 报错', async () => {
  const mem = openMemoryDb(':memory:');
  const sink = fakeGrantSink();
  const grantTool = createResearchTools(mem.pursuits, sink).find((t) => t.name === 'grant_research_tool')!;
  assert.equal((await grantTool.execute({ pursuitId: 'r1' })).success, false);
  assert.equal((await grantTool.execute({ tool: 'runLean' })).success, false);
  assert.equal(sink.calls.length, 0);
  mem.close();
});

test('createResearchTools 不传 grantStore → 不产出 grant_research_tool', () => {
  const mem = openMemoryDb(':memory:');
  const ts = createResearchTools(mem.pursuits);
  assert.equal(ts.find((t) => t.name === 'grant_research_tool'), undefined);
  assert.ok(ts.find((t) => t.name === 'research_focus'));
  mem.close();
});
