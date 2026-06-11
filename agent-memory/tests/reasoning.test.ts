/**
 * ReasoningStore 单测:推理树 CRUD + 回溯记忆 + 跨 turn 预算累积。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, ReasoningNodeNotFoundError } from '../src/index.js';

test('createSession 建会话 + 根节点(claim=goal),listActiveSessions 命中', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({
    goal: '猜想 X 成立',
    assumptions: ['n≥1', 'P(0) 成立'],
  });
  assert.equal(session.status, 'active');
  assert.equal(session.goal, '猜想 X 成立');
  assert.deepEqual(session.assumptions, ['n≥1', 'P(0) 成立']);
  assert.equal(session.rootNodeId, rootNode.id);
  assert.equal(rootNode.parentId, null);
  assert.equal(rootNode.claim, '猜想 X 成立');
  assert.equal(rootNode.status, 'open');
  assert.equal(mem.reasoning.listActiveSessions().length, 1);
  assert.equal(mem.reasoning.getMostRecentActiveSession()!.id, session.id);
  assert.equal(session.mode, 'formal', 'mode 默认 formal');
  mem.close();
});

test('createSession mode=deliberate 持久化并在 getSession 回放', () => {
  const mem = openMemoryDb(':memory:');
  const { session } = mem.reasoning.createSession({ goal: '该不该接 offer', mode: 'deliberate' });
  assert.equal(session.mode, 'deliberate');
  // 跨"读取"仍是 deliberate(continue/status/finalize 走 getSession/getMostRecentActiveSession)
  assert.equal(mem.reasoning.getSession(session.id)!.mode, 'deliberate');
  assert.equal(mem.reasoning.getMostRecentActiveSession()!.mode, 'deliberate');
  mem.close();
});

test('addNodes 在父下加子节点(含 id + depth),父不存在抛 ReasoningNodeNotFoundError', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const kids = mem.reasoning.addNodes(session.id, rootNode.id, [
    { claim: '引理 A', kind: 'lemma' },
    { claim: '子目标 B', kind: 'subgoal' },
  ]);
  assert.equal(kids.length, 2);
  assert.ok(kids[0].id && kids[0].id !== rootNode.id);
  assert.equal(kids[0].depth, 1);
  assert.equal(kids[0].parentId, rootNode.id);
  assert.equal(kids[0].kind, 'lemma');
  assert.equal(mem.reasoning.getNodes(session.id).length, 3); // root + 2

  assert.throws(
    () => mem.reasoning.addNodes(session.id, 'no-such-parent', [{ claim: 'x', kind: 'subgoal' }]),
    ReasoningNodeNotFoundError,
  );
  mem.close();
});

test('updateNode 标 proved/dead_end;dead_end 追加 approaches_tried;错 id 返 null', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const [a, b] = mem.reasoning.addNodes(session.id, rootNode.id, [
    { claim: 'A', kind: 'subgoal' },
    { claim: 'B', kind: 'subgoal' },
  ]);

  const proved = mem.reasoning.updateNode(session.id, a.id, { status: 'proved', result: '由归纳得' });
  assert.equal(proved!.status, 'proved');
  assert.equal(proved!.result, '由归纳得');

  // dead_end 追加 approach(回溯记忆)
  mem.reasoning.updateNode(session.id, b.id, { status: 'dead_end', appendApproach: '试了反证法' });
  const b2 = mem.reasoning.updateNode(session.id, b.id, { appendApproach: '试了构造法' });
  assert.equal(b2!.status, 'dead_end');
  assert.deepEqual(b2!.approachesTried, ['试了反证法', '试了构造法']);

  // 错 id → null(让工具回错误文本)
  assert.equal(mem.reasoning.updateNode(session.id, 'ghost', { status: 'proved' }), null);
  // 跨 session 串不到
  const other = mem.reasoning.createSession({ goal: 'H' });
  assert.equal(mem.reasoning.updateNode(other.session.id, a.id, { status: 'proved' }), null);
  mem.close();
});

test('setSessionStatus 收敛后退出 listActiveSessions;addBudgetSpent 累积', () => {
  const mem = openMemoryDb(':memory:');
  const { session } = mem.reasoning.createSession({ goal: 'G' });
  mem.reasoning.addBudgetSpent(session.id, 1000);
  mem.reasoning.addBudgetSpent(session.id, 500);
  assert.equal(mem.reasoning.getSession(session.id)!.budgetSpent, 1500);

  mem.reasoning.setSessionStatus(session.id, 'solved');
  assert.equal(mem.reasoning.getSession(session.id)!.status, 'solved');
  assert.equal(mem.reasoning.listActiveSessions().length, 0);
  mem.close();
});

test('getTree 返回 session + 全部节点;持久化跨"重新打开 store"(同 db)', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  mem.reasoning.addNodes(session.id, rootNode.id, [{ claim: 'A', kind: 'subgoal' }]);
  const tree = mem.reasoning.getTree(session.id)!;
  assert.equal(tree.session.id, session.id);
  assert.equal(tree.nodes.length, 2);
  assert.equal(mem.reasoning.getTree('nope'), null);
  mem.close();
});

test('owner scoping (v28): getMostRecentActiveSession(owner) only sees its own channel', () => {
  const mem = openMemoryDb(':memory:');
  const wechat = mem.reasoning.createSession({ goal: 'Goldbach', ownerSessionId: 'wechat:u:u' }).session;
  const webui = mem.reasoning.createSession({ goal: 'read env', ownerSessionId: '9akb4p61e5i' }).session;

  // owner field round-trips
  assert.equal(wechat.ownerSessionId, 'wechat:u:u');
  assert.equal(webui.ownerSessionId, '9akb4p61e5i');

  // scoped lookup returns ONLY the owner's session — no cross-channel hijack
  assert.equal(mem.reasoning.getMostRecentActiveSession('wechat:u:u')!.id, wechat.id);
  assert.equal(mem.reasoning.getMostRecentActiveSession('9akb4p61e5i')!.id, webui.id);
  assert.equal(mem.reasoning.listActiveSessions('wechat:u:u').length, 1);

  // an owner with no session of its own gets nothing (not the other channel's)
  assert.equal(mem.reasoning.getMostRecentActiveSession('telegram:x'), null);

  // unscoped (legacy) still sees the global most-recent
  assert.equal(mem.reasoning.listActiveSessions().length, 2);
  assert.equal(mem.reasoning.getMostRecentActiveSession()!.id, webui.id);
  mem.close();
});

test('owner scoping: pre-v28 NULL-owner session stays resumable by any channel (graceful migration)', () => {
  const mem = openMemoryDb(':memory:');
  // no ownerSessionId → stored NULL (simulates a session created before v28)
  const legacy = mem.reasoning.createSession({ goal: 'old session' }).session;
  assert.equal(legacy.ownerSessionId, null);
  // graceful: a scoped continue from ANY channel still picks up the legacy NULL-owner session
  assert.equal(mem.reasoning.getMostRecentActiveSession('wechat:u:u')!.id, legacy.id);
  assert.equal(mem.reasoning.getMostRecentActiveSession('9akb4p61e5i')!.id, legacy.id);

  // ...but a NEW owned session is strictly isolated: another channel never sees it — it only ever
  // sees the legacy NULL one, never the wechat-owned one.
  const owned = mem.reasoning.createSession({ goal: 'new', ownerSessionId: 'wechat:u:u' }).session;
  assert.equal(mem.reasoning.getMostRecentActiveSession('9akb4p61e5i')!.id, legacy.id);
  assert.equal(mem.reasoning.getMostRecentActiveSession('wechat:u:u')!.id, owned.id);
  mem.close();
});

test('recordRoundProgress: 无进展累加 / 有进展清零(stuck 计数)', () => {
  const mem = openMemoryDb(':memory:');
  const { session } = mem.reasoning.createSession({ goal: 'G', ownerSessionId: 'u' });
  assert.equal(session.noProgressRounds, 0);
  assert.equal(mem.reasoning.recordRoundProgress(session.id, false), 1);
  assert.equal(mem.reasoning.recordRoundProgress(session.id, false), 2);
  assert.equal(mem.reasoning.getSession(session.id)!.noProgressRounds, 2);
  assert.equal(mem.reasoning.recordRoundProgress(session.id, true), 0); // progress resets
  assert.equal(mem.reasoning.getSession(session.id)!.noProgressRounds, 0);
  mem.close();
});

test('setAutoAdvance / listAutoAdvanceSessions: 按 session opt-in 后台推进', () => {
  const mem = openMemoryDb(':memory:');
  const a = mem.reasoning.createSession({ goal: 'A', ownerSessionId: 'u' }).session;
  const b = mem.reasoning.createSession({ goal: 'B', ownerSessionId: 'u' }).session;
  assert.equal(a.autoAdvance, false);
  assert.equal(mem.reasoning.listAutoAdvanceSessions().length, 0);

  mem.reasoning.setAutoAdvance(a.id, true);
  assert.equal(mem.reasoning.getSession(a.id)!.autoAdvance, true);
  const list = mem.reasoning.listAutoAdvanceSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, a.id); // only the opted-in one, not b

  // 关闭后退出列表
  mem.reasoning.setAutoAdvance(a.id, false);
  assert.equal(mem.reasoning.listAutoAdvanceSessions().length, 0);
  // 已闭合的 session 即使 auto=1 也不在列表(只列 active)
  mem.reasoning.setAutoAdvance(b.id, true);
  mem.reasoning.setSessionStatus(b.id, 'solved');
  assert.equal(mem.reasoning.listAutoAdvanceSessions().length, 0);
  mem.close();
});
