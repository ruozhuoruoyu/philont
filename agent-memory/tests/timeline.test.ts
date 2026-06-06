/**
 * TimelineRetriever 测试 —— 验证 K0 核心:LLM 上下文从全局时间线召回。
 *
 * 关注点:
 *  - recency 段按时间近 + token 预算装入,正序输出
 *  - 关键词召回 FTS5 命中老消息,与 recency 段去重
 *  - role 过滤(system 不进 timeline)
 *  - 空预算 / 空查询的边界行为
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, TimelineRetriever, GLOBAL_TIMELINE_SESSION_ID } from '../src/index.js';

function setupDb() {
  const handle = openMemoryDb(':memory:');
  // GLOBAL session row 由 initSchema 的 ensureGlobalTimelineSession 自动建好
  return handle;
}

test('retrieve: 空库 → 空结果', () => {
  const { raw } = setupDb();
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve();
  assert.equal(r.messages.length, 0);
  assert.equal(r.recencyCount, 0);
  assert.equal(r.recallCount, 0);
  assert.equal(r.totalTokens, 0);
});

test('retrieve: recency 按时间正序输出最新消息', () => {
  const { raw } = setupDb();
  for (let i = 0; i < 5; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve();
  assert.equal(r.recencyCount, 5);
  assert.equal(r.messages.length, 5);
  // 时间正序
  assert.equal(r.messages[0].content, 'message 0');
  assert.equal(r.messages[4].content, 'message 4');
});

test('retrieve: recency token 预算超限后停止', () => {
  const { raw } = setupDb();
  // 每条 1000 字符 ≈ 600 tokens
  for (let i = 0; i < 20; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'user',
      content: 'x'.repeat(1000),
    });
  }
  const tl = new TimelineRetriever(raw);
  // 1500 tokens 预算 → 应该装 2-3 条(每条 600)
  const r = tl.retrieve({ recentBudgetTokens: 1500 });
  assert.ok(r.recencyCount >= 1 && r.recencyCount <= 3, `got ${r.recencyCount}`);
  assert.ok(r.totalTokens <= 1500 + 600, '应在预算 + 1 条溢出之内');
});

test('retrieve: 关键词召回 FTS5 命中老消息', () => {
  const { raw } = setupDb();
  // 老消息含独特关键词
  raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'user',
    content: '我家狗叫旺财,黑色的拉布拉多',
  });
  raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'assistant',
    content: '记下了,旺财是黑色拉布拉多',
  });
  // 中间一堆与狗无关的消息
  for (let i = 0; i < 30; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'user',
      content: `今天天气真好 ${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  // 用极小的 recency 预算 → 老的两条不在 recency 里
  const r = tl.retrieve({
    recentBudgetTokens: 100,
    recallQuery: '旺财',
  });
  // 召回段应包含"旺财"那两条
  const recalledTexts = r.messages.map((m) => m.content);
  const hits = recalledTexts.filter((t) => t.includes('旺财'));
  assert.ok(hits.length >= 1, `应召回旺财相关,实得: ${recalledTexts.slice(0, 3).join(' | ')}`);
});

test('retrieve: 召回段不重复 recency 已含的消息', () => {
  const { raw } = setupDb();
  // 仅 3 条消息,recency 全包含
  for (let i = 0; i < 3; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'user',
      content: `keyword_xyz_${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve({
    recentBudgetTokens: 100_000,
    recallQuery: 'keyword_xyz',
  });
  // recency 已经把所有 3 条带回来了 → recall 段应该是空的
  assert.equal(r.recencyCount, 3);
  assert.equal(r.recallCount, 0);
});

test('retrieve: query 太短(< 2 char)跳过召回', () => {
  const { raw } = setupDb();
  for (let i = 0; i < 5; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'user',
      content: `m${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve({ recallQuery: 'a' });
  assert.equal(r.recallCount, 0);
});

test('retrieve: 召回 + recency 之间有分隔提示', () => {
  const { raw } = setupDb();
  // 老消息含特殊词
  raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'user',
    content: '记一下我喜欢吃榴莲',
  });
  // 大堆中间消息
  for (let i = 0; i < 20; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'assistant',
      content: `interim ${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve({
    recentBudgetTokens: 200,    // 极小,只能装最近 1-2 条
    recallQuery: '榴莲',
  });
  if (r.recallCount > 0 && r.recencyCount > 0) {
    const sep = r.messages.find((m) => m.content.includes('旧记忆与近期对话之间'));
    assert.ok(sep, '应有分隔提示');
  }
});

test('retrieve: role 映射 —— tool 转 user,system 被丢', () => {
  const { raw } = setupDb();
  raw.appendMessage({ sessionId: GLOBAL_TIMELINE_SESSION_ID, role: 'system', content: 'sys-msg' });
  raw.appendMessage({ sessionId: GLOBAL_TIMELINE_SESSION_ID, role: 'user', content: 'usr-msg' });
  raw.appendMessage({ sessionId: GLOBAL_TIMELINE_SESSION_ID, role: 'tool', content: 'tool-msg' });
  raw.appendMessage({ sessionId: GLOBAL_TIMELINE_SESSION_ID, role: 'assistant', content: 'ast-msg' });

  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve();
  // system 被丢
  assert.equal(r.messages.length, 3);
  assert.ok(!r.messages.some((m) => m.content === 'sys-msg'));
  // tool 转 user
  const toolMsg = r.messages.find((m) => m.content === 'tool-msg');
  assert.equal(toolMsg?.role, 'user');
});

// ── K8 调优后的默认行为 ────────────────────────────────────────────────────
// 旧默认 80K + 40K + 500 条让最近 3 条被淹。现默认 8K + 4K + 30 条 + 10 候选,
// 让最近 ~10-15 轮主导 LLM attention。

test('retrieve K8: 50 条消息 + 默认参数 → 最多 30 条(recentLimit 硬上限)', () => {
  const { raw } = setupDb();
  for (let i = 0; i < 50; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`, // 极短消息,远没到 token budget
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve(); // 不传 opts,用默认值
  assert.equal(r.recencyCount, 30, 'recencyCount 应被 recentLimitMessages=30 截断');
  assert.equal(r.messages.length, 30);
  // 取的是最新 30 条 (msg 20..msg 49),时间正序
  assert.equal(r.messages[0].content, 'msg 20');
  assert.equal(r.messages[29].content, 'msg 49');
});

test('retrieve K8: 30 条短消息 + 默认参数 → 全部装入(没超 budget 也没超 limit)', () => {
  const { raw } = setupDb();
  for (let i = 0; i < 30; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'user',
      content: `m${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve();
  assert.equal(r.recencyCount, 30);
});

test('retrieve K8: 30 条长消息(每条 ~5K chars)→ token budget 截断,但至少 1 条', () => {
  const { raw } = setupDb();
  // 5_000 chars × 0.6 estimator = 3_000 tokens/条;recentBudget=8_000 装 ~3 条
  const longContent = 'x'.repeat(5_000);
  for (let i = 0; i < 30; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'user',
      content: longContent + ` #${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve();
  assert.ok(r.recencyCount >= 1, '至少装入 1 条(retriever 的"装第一条不看 budget"保护)');
  assert.ok(r.recencyCount < 30, '应被 token budget 截断,不能装满 30 条');
  assert.ok(r.totalTokens <= 8_000 + 3_000, 'totalTokens 不应远超 8K 预算(允许首条溢出)');
  // 最近的那条必须在(content 末尾 #29)
  const last = r.messages[r.messages.length - 1];
  assert.ok(last.content.endsWith('#29'), '最新一条不能丢');
});

// ── 2026-05-09:restrictToSessionIds(autonomous turn 隔离根治路径) ─────

test('retrieve: restrictToSessionIds 切断跨 session 召回(recency 段)', () => {
  const { raw } = setupDb();
  const a = raw.startSession();
  const b = raw.startSession();
  // 在 session b 写若干条(模拟 wechat session 的对话)
  for (let i = 0; i < 5; i++) {
    raw.appendMessage({ sessionId: b.id, role: 'user', content: `wechat-msg-${i}` });
    raw.appendMessage({ sessionId: b.id, role: 'assistant', content: `wechat-reply-${i}` });
  }
  // 在 session a 写 1 条(模拟 autonomous turn 自己的历史)
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'autonomous-self' });

  const tl = new TimelineRetriever(raw);
  // 限本 session 召回(autonomous turn 模式)
  const r = tl.retrieve({ restrictToSessionIds: [a.id] });
  assert.equal(r.recencyCount, 1, '只应召回 session a 的 1 条消息');
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].content, 'autonomous-self');
  // 关键 negative:不能含 wechat-* 内容
  assert.ok(!r.messages.some((m) => m.content.startsWith('wechat-')), '不应召回 session b 的消息');
});

test('retrieve: restrictToSessionIds 切断跨 session 召回(召回段)', () => {
  const { raw } = setupDb();
  const a = raw.startSession();
  const b = raw.startSession();
  // session b 老消息含独特关键词(模拟 wechat 历史)
  raw.appendMessage({ sessionId: b.id, role: 'user', content: '我帮您切换社区' });
  // 大堆中间消息(让 session b 那条出 recency 段)
  for (let i = 0; i < 50; i++) {
    raw.appendMessage({ sessionId: a.id, role: 'user', content: `a-noise-${i}` });
  }

  const tl = new TimelineRetriever(raw);
  // 限本 session 召回 + 关键词召回
  const r = tl.retrieve({
    restrictToSessionIds: [a.id],
    recallQuery: '切换社区',
  });
  // 召回段绝不能命中 session b 的"切换社区"
  assert.ok(
    !r.messages.some((m) => m.content.includes('切换')),
    '召回段不应跨 session 拉到 session b 的消息',
  );
});

test('retrieve: restrictToSessionIds 不传 → 全局召回(行为不变)', () => {
  const { raw } = setupDb();
  const a = raw.startSession();
  const b = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'a-msg' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'b-msg' });

  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve(); // 不传 restrictToSessionIds
  // 两 session 的消息都应召回
  assert.equal(r.recencyCount, 2);
  const contents = r.messages.map((m) => m.content).sort();
  assert.deepEqual(contents, ['a-msg', 'b-msg']);
});

test('retrieve: restrictToSessionIds 多值 → IN 并集召回', () => {
  const { raw } = setupDb();
  const a = raw.startSession();
  const b = raw.startSession();
  const c = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'a-msg' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'b-msg' });
  raw.appendMessage({ sessionId: c.id, role: 'user', content: 'c-msg' });

  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve({ restrictToSessionIds: [a.id, c.id] });
  assert.equal(r.recencyCount, 2);
  const contents = r.messages.map((m) => m.content).sort();
  assert.deepEqual(contents, ['a-msg', 'c-msg']);
});

test('retrieve K8: recallLimitCandidates 默认 10 → FTS5 候选不超过 10', () => {
  const { raw } = setupDb();
  // 写 20 条都含关键词 "pandoc" 的老消息(早期),再写 30 条不含的近消息
  for (let i = 0; i < 20; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'user',
      content: `pandoc question number ${i}`,
    });
  }
  // 把光标推开,模拟"很久之后"
  for (let i = 0; i < 30; i++) {
    raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `recent unrelated chat ${i}`,
    });
  }
  const tl = new TimelineRetriever(raw);
  const r = tl.retrieve({ recallQuery: 'pandoc' });
  assert.equal(r.recencyCount, 30, 'recency 仍是最近 30 条');
  assert.ok(r.recallCount <= 10, `recallCount=${r.recallCount} 应 ≤ recallLimitCandidates=10`);
  // 召回段 + recency 段之间应有分隔提示
  if (r.recallCount > 0) {
    const sep = r.messages.find((m) => m.content.includes('旧记忆与近期对话之间'));
    assert.ok(sep, '应有分隔提示');
  }
});
