/**
 * deep_explore 纯逻辑 + 编排单测(不加载 chat-handler)。
 * 覆盖:frontier 计算 / 树渲染 / 进度 diff / 后置收敛判定 / reason_* toolRunner
 * (回显新 nodeId、错 nodeId 回显合法列表)。用真 ReasoningStore(in-memory db)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import type { ReasoningNode } from '@agent/memory';
import type { MiniLoopLLMClient } from '@agent/tools';
import {
  computeFrontier,
  formatOpenIds,
  renderTreePrompt,
  summarizeProgress,
  judgeConvergence,
  makeReasoningToolRunner,
  DEEP_EXPLORE_RESEARCH_ALLOW,
  parseSkepticVerdict,
  tallyVerdicts,
  buildSkepticSystemPrompt,
  runAdversarialVerification,
  type VerificationTally,
  computeUCB,
  computeNovelty,
  rankFrontier,
  buildScorerPrompt,
  parseScores,
  parseAssessments,
  normalizeTechnique,
  scoreFrontierValues,
  buildDiscoverPrompt,
  createDeepExploreTool,
} from '../src/deep_explore.js';

function node(over: Partial<ReasoningNode>): ReasoningNode {
  return {
    id: 'n1', sessionId: 's1', parentId: null, claim: 'c', kind: 'subgoal',
    status: 'open', result: null, approachesTried: [], evidenceRefs: [],
    depth: 0, value: null, visits: 0, createdAt: 0, updatedAt: 0, ...over,
  };
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────

test('computeFrontier = open 叶节点(有子节点的不算 frontier)', () => {
  const root = node({ id: 'r', parentId: null, status: 'open' });
  const a = node({ id: 'a', parentId: 'r', status: 'open' }); // 叶
  const b = node({ id: 'b', parentId: 'r', status: 'proved' }); // 非 open
  const c = node({ id: 'c', parentId: 'a', status: 'open' }); // a 的子 → a 不是叶
  const f = computeFrontier([root, a, b, c]);
  const ids = f.map((n) => n.id).sort();
  assert.deepEqual(ids, ['c']); // 只有 c 是 open 叶(root/a 有子,b 非 open)
});

test('formatOpenIds 列出 open 节点 id', () => {
  const ns = [node({ id: 'x', status: 'open' }), node({ id: 'y', status: 'dead_end' }), node({ id: 'z', status: 'open' })];
  assert.equal(formatOpenIds(ns), 'x, z');
  assert.match(formatOpenIds([node({ status: 'proved' })]), /no open nodes/);
});

test('renderTreePrompt 含根命题/frontier/已证/死胡同(带 approaches)', () => {
  const session = { id: 's', goal: '猜想 X', assumptions: ['A1'], status: 'active' as const, rootNodeId: 'r', budgetSpent: 0, createdAt: 0, updatedAt: 0 };
  const nodes = [
    node({ id: 'r', parentId: null, status: 'open', claim: '猜想 X' }),
    node({ id: 'open1', parentId: 'r', status: 'open', claim: '待攻 1' }),
    node({ id: 'p1', parentId: 'r', status: 'proved', claim: '已证引理', result: 'QED' }),
    node({ id: 'd1', parentId: 'r', status: 'dead_end', claim: '死路', approachesTried: ['反证法'] }),
  ];
  const p = renderTreePrompt(session, nodes);
  assert.match(p, /猜想 X/);
  assert.match(p, /A1/);
  assert.match(p, /\[open1\]/);
  assert.match(p, /已证引理/);
  assert.match(p, /反证法/);
  assert.match(p, /reason_decompose/);
  assert.match(p, /reason_record/);
});

test('summarizeProgress diff 出新证/新死胡同/分解数', () => {
  const before = [node({ id: 'r', status: 'open' }), node({ id: 'a', status: 'open', claim: 'A' })];
  const after = [
    node({ id: 'r', status: 'open' }),
    node({ id: 'a', status: 'proved', claim: 'A' }),
    node({ id: 'b', status: 'dead_end', claim: 'B' }),
    node({ id: 'c', status: 'open', claim: 'C' }),
  ];
  const s = summarizeProgress(before, after);
  assert.deepEqual(s.newlyProved, ['A']);
  assert.deepEqual(s.newDeadEnds, ['B']);
  assert.equal(s.decomposedInto, 2); // b + c
  assert.equal(s.stillOpen, 2); // r + c
});

test('judgeConvergence:根 proved→solved;frontier 空→stuck;否则 active', () => {
  assert.equal(judgeConvergence([node({ id: 'r', parentId: null, status: 'proved' })]), 'solved');
  // frontier 空(根 dead_end,无 open 叶)但根未证 → stuck
  assert.equal(judgeConvergence([node({ id: 'r', parentId: null, status: 'dead_end' })]), 'stuck');
  // 有 open 叶 → active
  assert.equal(
    judgeConvergence([node({ id: 'r', parentId: null, status: 'open' }), node({ id: 'a', parentId: 'r', status: 'open' })]),
    'active',
  );
});

// ── reason_* toolRunner(用真 store)──────────────────────────────────────────

test('工具白名单:本地回忆 + z3Verify(验证),剔除 web 浏览/目录翻找', () => {
  // 保留本地记忆/文件回忆 + 验证牙齿(z3Verify SMT / pariGp 数论 CAS)
  for (const t of ['searchNotes', 'getFact', 'readFile', 'listFacts', 'searchKB', 'searchSkills', 'z3Verify', 'pariGp']) {
    assert.ok(DEEP_EXPLORE_RESEARCH_ALLOW.has(t), `应保留 ${t}`);
  }
  // 剔除 browsing —— 防子 LLM 用浏览回避推理
  for (const t of ['webSearch', 'webFetch', 'fetchUrl', 'listDir', 'inspectPath']) {
    assert.ok(!DEEP_EXPLORE_RESEARCH_ALLOW.has(t), `应剔除 ${t}`);
  }
});

const noopDelegate = async () => ({ ok: false, output: '', error: 'should not be called' });

test('reason_decompose 成功:写树 + output 回显新建 nodeId', async () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate);
  const r = await run('reason_decompose', {
    parentNodeId: rootNode.id,
    subClaims: [{ claim: '引理 A', kind: 'lemma' }, { claim: '子目标 B', kind: 'subgoal' }],
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /引理 A/);
  // 回显了真实 nodeId(B2 关键):output 含新节点 id
  const kids = mem.reasoning.getNodes(session.id).filter((n) => n.parentId === rootNode.id);
  assert.equal(kids.length, 2);
  for (const k of kids) assert.match(r.output, new RegExp(k.id));
  mem.close();
});

test('reason_decompose 父 id 幻觉 → 错误文本回显合法 open id', async () => {
  const mem = openMemoryDb(':memory:');
  const { session } = mem.reasoning.createSession({ goal: 'G' });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate);
  const r = await run('reason_decompose', { parentNodeId: 'ghost', subClaims: [{ claim: 'x', kind: 'subgoal' }] });
  assert.equal(r.ok, false);
  assert.match(r.error!, /does not exist/);
  assert.match(r.error!, /open nodes/);
  mem.close();
});

test('reason_record 成功标 proved;错 nodeId → 回显合法 id 列表', async () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate);

  const ok = await run('reason_record', { nodeId: rootNode.id, status: 'proved', result: 'QED' });
  assert.equal(ok.ok, true);
  assert.equal(mem.reasoning.getNode(session.id, rootNode.id)!.status, 'proved');

  const bad = await run('reason_record', { nodeId: 'ghost', status: 'proved' });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /open nodes/);

  const badStatus = await run('reason_record', { nodeId: rootNode.id, status: 'finished' });
  assert.equal(badStatus.ok, false);
  mem.close();
});

test('reason_record dead_end 追加 approach(回溯记忆)', async () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const [a] = mem.reasoning.addNodes(session.id, rootNode.id, [{ claim: 'A', kind: 'subgoal' }]);
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate);
  await run('reason_record', { nodeId: a.id, status: 'dead_end', approach: '试了反证法' });
  assert.deepEqual(mem.reasoning.getNode(session.id, a.id)!.approachesTried, ['试了反证法']);
  mem.close();
});

test('非 reason_* 工具委托给 delegate', async () => {
  const mem = openMemoryDb(':memory:');
  const { session } = mem.reasoning.createSession({ goal: 'G' });
  let called = '';
  const delegate = async (name: string) => { called = name; return { ok: true, output: 'ok' }; };
  const run = makeReasoningToolRunner(mem.reasoning, session.id, delegate);
  const r = await run('webSearch', { query: 'x' });
  assert.equal(called, 'webSearch');
  assert.equal(r.ok, true);
  mem.close();
});

// ── 对抗验证(C 原型)─────────────────────────────────────────────────────────

test('parseSkepticVerdict:规范判定行(证伪/维持),无判定行→null(弃权)', () => {
  assert.deepEqual(parseSkepticVerdict('第三步把待证当已知,循环论证。\n判定: 证伪')?.refuted, true);
  assert.equal(parseSkepticVerdict('每步严密。\n判定: 维持')?.refuted, false);
  assert.equal(parseSkepticVerdict('VERDICT: REFUTED')?.refuted, true);
  assert.equal(parseSkepticVerdict('VERDICT: HOLDS')?.refuted, false);
  // 末尾判定行优先(模型可能先复述再下判定)
  assert.equal(parseSkepticVerdict('判定: 维持\n…重新检查后\n判定: 证伪')?.refuted, true);
  // 无规范判定 → 弃权
  assert.equal(parseSkepticVerdict('看起来还行吧'), null);
  assert.equal(parseSkepticVerdict(''), null);
  // 证伪时带反对意见
  assert.match(parseSkepticVerdict('反例:n=4 时不成立。\n判定: 证伪')!.reason, /n=4/);
});

test('tallyVerdicts:平票按证伪;全弃权→接受;少数证伪→接受', () => {
  const R = { refuted: true, reason: 'x' };
  const H = { refuted: false, reason: '' };
  // 3 票 2 证伪 → 不接受
  assert.equal(tallyVerdicts([R, R, H]).confirmed, false);
  // 3 票 1 证伪 → 接受
  assert.equal(tallyVerdicts([R, H, H]).confirmed, true);
  // 平票(2:2)→ 不接受(证明门槛高)
  assert.equal(tallyVerdicts([R, R, H, H]).confirmed, false);
  // 全员弃权(全 null)→ 接受(不因基础设施失败降级),validVotes=0
  const allAbstain = tallyVerdicts([null, null, null]);
  assert.equal(allAbstain.confirmed, true);
  assert.equal(allAbstain.validVotes, 0);
  // topObjection 取首个证伪理由
  assert.equal(tallyVerdicts([{ refuted: true, reason: '漏洞A' }, R]).topObjection, '漏洞A');
});

test('buildSkepticSystemPrompt:含被审 claim/论证/根命题/已证引理 + 存疑即证伪纪律', () => {
  const p = buildSkepticSystemPrompt('引理 L', 'because 显然', '猜想 G', ['前提P'], ['已证 Q']);
  assert.match(p, /引理 L/);
  assert.match(p, /because 显然/);
  assert.match(p, /猜想 G/);
  assert.match(p, /前提P/);
  assert.match(p, /已证 Q/);
  assert.match(p, /unsure|REFUTED/);
  // 无论证时明确标注可疑
  assert.match(buildSkepticSystemPrompt('L', null, 'G', [], []), /no argument was given/);
});

/** 造一个按脚本返回文本的 fake mini-loop LLM(每次 send 取下一条脚本)。 */
function fakeLLM(scripts: string[]): MiniLoopLLMClient {
  let i = 0;
  return {
    async send() {
      const content = scripts[Math.min(i, scripts.length - 1)];
      i++;
      return { type: 'text', content, tokensUsed: 100 };
    },
  };
}

test('runAdversarialVerification:多数证伪→confirmed=false,token 累加', async () => {
  const tally: VerificationTally = await runAdversarialVerification({
    llm: fakeLLM(['判定: 证伪', '判定: 证伪', '判定: 维持']),
    systemPrompt: 's',
    count: 3,
    toolDefs: [],
    toolRunner: async () => ({ ok: true, output: '' }),
    whitelist: new Set(),
  });
  assert.equal(tally.confirmed, false);
  assert.equal(tally.refutedCount, 2);
  assert.equal(tally.validVotes, 3);
  assert.equal(tally.tokensSpent, 300); // 3 × 100
});

test('runAdversarialVerification:count=0 直接放行(关闭验证)', async () => {
  const tally = await runAdversarialVerification({
    llm: fakeLLM(['判定: 证伪']),
    systemPrompt: 's', count: 0, toolDefs: [],
    toolRunner: async () => ({ ok: true, output: '' }), whitelist: new Set(),
  });
  assert.equal(tally.confirmed, true);
  assert.equal(tally.validVotes, 0);
  assert.equal(tally.tokensSpent, 0);
});

test('reason_record proved 被证伪 → 不落库,节点留 open + 反对入回溯记忆', async () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const [a] = mem.reasoning.addNodes(session.id, rootNode.id, [{ claim: 'A', kind: 'lemma' }]);
  // 验证器:总是证伪
  const verifyProved = async () => ({
    confirmed: false, refutedCount: 2, validVotes: 3, topObjection: '第二步跳步', tokensSpent: 50,
  });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate, verifyProved);
  const r = await run('reason_record', { nodeId: a.id, status: 'proved', result: '论证…' });
  assert.equal(r.ok, true);
  assert.match(r.output, /did not pass adversarial verification/);
  assert.match(r.output, /第二步跳步/); // topObjection 透传(test data)
  const node = mem.reasoning.getNode(session.id, a.id)!;
  assert.equal(node.status, 'open'); // not recorded as proved
  assert.match(node.approachesTried.join(' '), /refuted/); // objection saved to backtracking memory
  mem.close();
});

test('reason_record proved 通过验证 → 落 proved(带验证标记)', async () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const [a] = mem.reasoning.addNodes(session.id, rootNode.id, [{ claim: 'A', kind: 'lemma' }]);
  const verifyProved = async () => ({
    confirmed: true, refutedCount: 0, validVotes: 3, topObjection: null, tokensSpent: 30,
  });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate, verifyProved);
  const r = await run('reason_record', { nodeId: a.id, status: 'proved', result: 'QED' });
  assert.equal(r.ok, true);
  assert.match(r.output, /passed adversarial verification/);
  assert.equal(mem.reasoning.getNode(session.id, a.id)!.status, 'proved');
  mem.close();
});

test('reason_record proved 错 nodeId(有验证器)→ 回显合法 open id,不调验证', async () => {
  const mem = openMemoryDb(':memory:');
  const { session } = mem.reasoning.createSession({ goal: 'G' });
  let verifyCalled = false;
  const verifyProved = async () => { verifyCalled = true; return null; };
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate, verifyProved);
  const r = await run('reason_record', { nodeId: 'ghost', status: 'proved', result: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /open nodes/);
  assert.equal(verifyCalled, false); // 节点不存在,不浪费 skeptic
  mem.close();
});

// ── value-guided 选点(A 原型:UCB + 估值)──────────────────────────────────────

test('computeUCB:未评估按 0.5;visits 越大探索项越小', () => {
  // 未评估 + 0 visits:0.5 + c·sqrt(ln(1+N)/1)
  const a = computeUCB(null, 0, 10, 0.7);
  assert.ok(Math.abs(a - (0.5 + 0.7 * Math.sqrt(Math.log(11)))) < 1e-9);
  // 同 value,visits 多 → UCB 低(探索项衰减)
  assert.ok(computeUCB(0.6, 1, 10, 0.7) > computeUCB(0.6, 9, 10, 0.7));
  // value 高即便多访问也可能压过低 value:exploit 起作用
  assert.ok(computeUCB(0.95, 5, 10, 0.7) > computeUCB(0.1, 5, 10, 0.7));
});

test('rankFrontier:高 UCB 在前,同分稳定(保持原序),不改入参', () => {
  const lowValHighVisit = node({ id: 'a', value: 0.3, visits: 8 });
  const highValLowVisit = node({ id: 'b', value: 0.9, visits: 0 });
  const input = [lowValHighVisit, highValLowVisit];
  // technique 全 null → novelty 0,退化成纯 UCB,单桶交错=纯排序
  const ranked = rankFrontier(input, input, 0.7, 0.3);
  assert.equal(ranked[0].id, 'b'); // 高价值低访问优先
  assert.equal(input[0].id, 'a'); // 入参未被原地排序
  // 同 value 同 visits → 保持原序
  const t1 = node({ id: 't1', value: 0.5, visits: 1 });
  const t2 = node({ id: 't2', value: 0.5, visits: 1 });
  assert.deepEqual(rankFrontier([t1, t2], [t1, t2], 0.7, 0.3).map((n) => n.id), ['t1', 't2']);
});

test('computeNovelty:未分类→0;新技法→1;试过越多越低', () => {
  const target = node({ id: 'x', technique: 'probabilistic' });
  // 没有别的同技法 → 1
  assert.equal(computeNovelty(target, [target]), 1);
  // 一个同技法且已闭合 → 1/(1+1)=0.5
  const tried = node({ id: 'y', technique: 'probabilistic', status: 'dead_end' });
  assert.equal(computeNovelty(target, [target, tried]), 0.5);
  // 同技法但还 open 且未访问 → 不算"试过"
  const openSame = node({ id: 'z', technique: 'probabilistic', status: 'open', visits: 0 });
  assert.equal(computeNovelty(target, [target, openSame]), 1);
  // 未分类技法 → 0(不偏置)
  assert.equal(computeNovelty(node({ id: 'n', technique: null }), [tried]), 0);
});

test('rankFrontier:MAP-Elites 跨技法交错——冷门桶最优代表靠前,不被主流桶霸榜', () => {
  // 主流桶 algebraic 三个高分,冷门桶 probabilistic 一个中分。
  const a1 = node({ id: 'a1', value: 0.9, technique: 'algebraic' });
  const a2 = node({ id: 'a2', value: 0.85, technique: 'algebraic' });
  const a3 = node({ id: 'a3', value: 0.8, technique: 'algebraic' });
  const p1 = node({ id: 'p1', value: 0.6, technique: 'probabilistic' });
  const all = [a1, a2, a3, p1];
  const ranked = rankFrontier(all, all, 0, 0).map((n) => n.id); // c=0,novelty权重=0:纯看分桶交错
  assert.equal(ranked[0], 'a1'); // 全局最优仍第一
  assert.equal(ranked[1], 'p1'); // 第二是另一个桶的最优(交错),而非 a2
  assert.deepEqual(ranked, ['a1', 'p1', 'a2', 'a3']);
});

test('buildScorerPrompt:含根命题 + frontier 节点 + JSON 输出约束 + 技法分类法', () => {
  const p = buildScorerPrompt('猜想 G', ['前提P'], [
    node({ id: 'f1', claim: '子目标一', kind: 'subgoal' }),
    node({ id: 'f2', claim: '引理二', kind: 'lemma' }),
  ]);
  assert.match(p, /猜想 G/);
  assert.match(p, /前提P/);
  assert.match(p, /\[f1\].*子目标一/);
  assert.match(p, /\[f2\].*引理二/);
  assert.match(p, /JSON array/);
  assert.match(p, /technique/); // 要技法标签
  assert.match(p, /probabilistic/); // 分类法出现
});

test('normalizeTechnique:分类法内保留,外归 other,空→null', () => {
  assert.equal(normalizeTechnique('Induction'), 'induction'); // 大小写裁剪
  assert.equal(normalizeTechnique('voodoo'), 'other'); // 表外
  assert.equal(normalizeTechnique(''), null);
  assert.equal(normalizeTechnique(42), null);
});

test('parseAssessments:解析 {id,value,technique};缺 technique 容忍;非法 id 丢', () => {
  const valid = new Set(['11111111-aaaa', '22222222-bbbb', '33333333-cccc']);
  const m = parseAssessments(
    '[{"id":"11111111-aaaa","value":0.8,"technique":"algebraic"},' +
    '{"id":"22222222-bbbb","value":1.5},' + // 缺 technique → null;value clamp
    '{"id":"33333333-cccc","value":0.5,"technique":"voodoo"},' + // 表外→other
    '{"id":"ghost","value":0.5,"technique":"x"}]', // 非法 id 丢
    valid,
  );
  assert.deepEqual(m.get('11111111-aaaa'), { value: 0.8, technique: 'algebraic' });
  assert.deepEqual(m.get('22222222-bbbb'), { value: 1, technique: null });
  assert.deepEqual(m.get('33333333-cccc'), { value: 0.5, technique: 'other' });
  assert.equal(m.has('ghost'), false);
  // JSON 失败 → parseScores 行兜底(technique=null)
  const fallback = parseAssessments('11111111-aaaa: 0.42', valid);
  assert.deepEqual(fallback.get('11111111-aaaa'), { value: 0.42, technique: null });
});

test('parseScores:JSON 数组解析 + clamp + 只留合法 id', () => {
  const valid = new Set(['11111111-aaaa', '22222222-bbbb']);
  const m = parseScores(
    '这是分数:[{"id":"11111111-aaaa","value":0.8},{"id":"22222222-bbbb","value":1.5},{"id":"ghost","value":0.5}]',
    valid,
  );
  assert.equal(m.get('11111111-aaaa'), 0.8);
  assert.equal(m.get('22222222-bbbb'), 1); // clamp 到 1
  assert.equal(m.has('ghost'), false); // 非法 id 丢弃
  assert.equal(m.size, 2);
});

test('parseScores:JSON 失败 → 行解析兜底;无法解析 → 空 Map', () => {
  const valid = new Set(['11111111-aaaa']);
  const line = parseScores('11111111-aaaa: 0.42\n无关行', valid);
  assert.equal(line.get('11111111-aaaa'), 0.42);
  assert.equal(parseScores('完全没有分数', valid).size, 0);
  assert.equal(parseScores('', valid).size, 0);
});

test('scoreFrontierValues:解析评估器输出(value+technique);abort/空 frontier → 空 + 0 token', async () => {
  const f = [node({ id: 'aaaaaaaa-1111' }), node({ id: 'bbbbbbbb-2222' })];
  const ok = await scoreFrontierValues({
    llm: fakeLLM(['[{"id":"aaaaaaaa-1111","value":0.7,"technique":"induction"},{"id":"bbbbbbbb-2222","value":0.2,"technique":"algebraic"}]']),
    goal: 'G', assumptions: [], frontier: f,
  });
  assert.deepEqual(ok.assessments.get('aaaaaaaa-1111'), { value: 0.7, technique: 'induction' });
  assert.equal(ok.tokensSpent, 100);
  // abort → 不调 LLM
  const ctrl = new AbortController();
  ctrl.abort();
  const aborted = await scoreFrontierValues({
    llm: fakeLLM(['[]']), goal: 'G', assumptions: [], frontier: f, abortSignal: ctrl.signal,
  });
  assert.equal(aborted.assessments.size, 0);
  assert.equal(aborted.tokensSpent, 0);
});

// ── 实验数学 explore 模式(①)──────────────────────────────────────────────────

test('buildDiscoverPrompt:含探索主题/挂载点 rootId/pariGp 纪律/conjecture 指令', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: '素数生成多项式' });
  const nodes = mem.reasoning.getNodes(session.id);
  const p = buildDiscoverPrompt(session, nodes, '形如 n^2+n+c 的多项式');
  assert.match(p, /experimental-mathematics engine/);
  assert.match(p, /形如 n\^2\+n\+c/); // seed 覆盖主题(test data)
  assert.match(p, new RegExp(`root node \\[${rootNode.id}\\]`)); // 暴露挂载点 root id
  assert.match(p, /pariGp/);
  assert.match(p, /conjecture/);
  // seed 为空时回落到 session.goal
  assert.match(buildDiscoverPrompt(session, nodes, ''), /素数生成多项式/);
  mem.close();
});

test('explore 模式:无活会话→建会话,跑一轮用 pariGp 证据挂 conjecture 节点', async () => {
  const mem = openMemoryDb(':memory:');
  // fake mini-loop LLM:第一次从 systemPrompt 抠出 rootId 发 decompose(conjecture),第二次收尾。
  let turn = 0;
  const llm: MiniLoopLLMClient = {
    async send(systemPrompt: string) {
      turn++;
      if (turn === 1) {
        const m = systemPrompt.match(/root node \[([0-9a-f-]+)\]/);
        const parentNodeId = m ? m[1] : '';
        return {
          type: 'toolCalls' as const,
          calls: [{
            id: 'c1',
            name: 'reason_decompose',
            input: {
              parentNodeId,
              subClaims: [{ claim: '对所有 n≥1, f(n) 为合数(pariGp 测 n=1..1e5 无反例)', kind: 'conjecture' }],
            },
          }],
          assistantMessage: { role: 'assistant' as const, content: [{ type: 'text' as const, text: '提出猜想' }] },
          tokensUsed: 50,
        };
      }
      return { type: 'text' as const, content: '本轮探索完成', tokensUsed: 10 };
    },
  };
  const subTurnToolRunner = async () => ({ ok: true, output: 'pari result' });
  const readOnlyToolDefs = [{ name: 'pariGp', description: 'gp', parameters: '{}' }];
  const tool = createDeepExploreTool({ reasoning: mem.reasoning, miniLoopLLM: llm, subTurnToolRunner, readOnlyToolDefs });

  const r = await tool.execute({ action: 'discover', goal: '素数生成多项式' });
  assert.equal(r.success, true);
  assert.match(r.output, /1 new data-backed conjecture/);
  // 树上确有一个 conjecture 节点,带实验证据
  const sess = mem.reasoning.getMostRecentActiveSession()!;
  const conj = mem.reasoning.getNodes(sess.id).filter((n) => n.kind === 'conjecture');
  assert.equal(conj.length, 1);
  assert.match(conj[0].claim, /无反例/);
  mem.close();
});

test('explore 模式:无 goal/seed 且无活会话 → 清晰报错', async () => {
  const mem = openMemoryDb(':memory:');
  const llm: MiniLoopLLMClient = { async send() { return { type: 'text' as const, content: 'x' }; } };
  const tool = createDeepExploreTool({
    reasoning: mem.reasoning, miniLoopLLM: llm,
    subTurnToolRunner: async () => ({ ok: true, output: '' }), readOnlyToolDefs: [],
  });
  const r = await tool.execute({ action: 'discover' });
  assert.equal(r.success, false);
  assert.match(r.error!, /goal|seed|主题/);
  mem.close();
});

test('store:setNodeValues clamp + incrementVisits 累加', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const [a] = mem.reasoning.addNodes(session.id, rootNode.id, [{ claim: 'A', kind: 'subgoal' }]);
  mem.reasoning.setNodeValues(session.id, [{ id: a.id, value: 2, technique: 'algebraic' }]); // clamp→1 + 技法
  assert.equal(mem.reasoning.getNode(session.id, a.id)!.value, 1);
  assert.equal(mem.reasoning.getNode(session.id, a.id)!.technique, 'algebraic');
  // 不带 technique 再写一次 → 保留原 technique
  mem.reasoning.setNodeValues(session.id, [{ id: a.id, value: 0.5 }]);
  assert.equal(mem.reasoning.getNode(session.id, a.id)!.technique, 'algebraic');
  mem.reasoning.incrementVisits(session.id, [a.id]);
  mem.reasoning.incrementVisits(session.id, [a.id]);
  assert.equal(mem.reasoning.getNode(session.id, a.id)!.visits, 2);
  // 新节点默认 value=null/visits=0
  assert.equal(rootNode.value, null);
  assert.equal(rootNode.visits, 0);
  mem.close();
});
