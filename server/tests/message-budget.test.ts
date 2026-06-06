/**
 * message-budget 单测:truncate + evict + estimate 三件事。
 *
 * 关注点:
 *   - 单条硬截断带提示尾
 *   - 总量超预算驱逐最早,保留最近 K 条
 *   - 幂等(重复调用不会反复驱逐已占位的)
 *   - 紧急驱逐无差别全清
 *   - 非 tool_result 消息(user 文本 / assistant 文本)不被动
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeMessage } from '../src/llm-adapter.js';
import {
  truncateToolResultContent,
  evictOldToolResults,
  evictForEmergency,
  estimateTotalTokens,
  DEFAULTS,
} from '../src/message-budget.js';

// ── helpers ──────────────────────────────────────────────────────────────

function userText(text: string): NativeMessage {
  return { role: 'user', content: text };
}

function assistantText(text: string): NativeMessage {
  return { role: 'assistant', content: text };
}

function assistantToolUse(
  id: string,
  name: string,
  input: unknown = {},
): NativeMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input } as never],
  };
}

function userToolResult(
  id: string,
  content: string,
): NativeMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content } as never],
  };
}

// ── truncateToolResultContent ────────────────────────────────────────────

test('truncate: 小于阈值原样返回', () => {
  const small = 'hello world';
  assert.equal(truncateToolResultContent(small, 100), small);
});

test('truncate: 超阈值尾部截断 + 提示', () => {
  const big = 'x'.repeat(5_000);
  const out = truncateToolResultContent(big, 1_000);
  assert.ok(out.startsWith('x'.repeat(1_000)));
  assert.ok(out.includes('已截断'));
  assert.ok(out.includes('4000')); // 4000 字节被截
  assert.ok(out.length < 1_500); // 截断后长度受控
});

// ── estimateTotalTokens ──────────────────────────────────────────────────

test('estimate: 字符串 content', () => {
  const msgs = [userText('abcde'), assistantText('xyz')];
  // chars=8, tokens = ceil(3 * 0.6) + ceil(5 * 0.6) = 2 + 3 = 5
  assert.equal(estimateTotalTokens(msgs), 5);
});

test('estimate: tool_result block', () => {
  const msgs = [userToolResult('t1', 'hello')];
  // chars=5 → tokens=3
  assert.equal(estimateTotalTokens(msgs), 3);
});

// ── evictOldToolResults ──────────────────────────────────────────────────

test('evict: 总量未超预算 → no-op', () => {
  const msgs: NativeMessage[] = [
    assistantToolUse('t1', 'readFile'),
    userToolResult('t1', 'small content'),
  ];
  const r = evictOldToolResults(msgs, { budgetTokens: 1_000, keepRecent: 1 });
  assert.equal(r.didEvict, false);
  assert.equal(r.evictedCount, 0);
});

test('evict: 超预算 → 最早的 tool_result 被占位,最近 K 保留', () => {
  const bigText = 'x'.repeat(100_000);
  const msgs: NativeMessage[] = [];
  for (let i = 0; i < 5; i++) {
    msgs.push(assistantToolUse(`t${i}`, 'readFile'));
    msgs.push(userToolResult(`t${i}`, bigText));
  }
  const before = estimateTotalTokens(msgs);
  assert.ok(before > 100_000); // 5 × 60K tokens

  const r = evictOldToolResults(msgs, {
    budgetTokens: 50_000,
    keepRecent: 2,
  });
  assert.ok(r.didEvict);
  assert.ok(r.evictedCount >= 1);
  assert.ok(r.tokensAfter < r.tokensBefore);

  // 最后 2 条 tool_result 保留
  const lastTr = msgs[msgs.length - 1].content as Array<{ content: string }>;
  assert.ok(lastTr[0].content.length > 1_000, '最新一条不应被驱逐');

  const secondLastTr = msgs[msgs.length - 3].content as Array<{ content: string }>;
  assert.ok(secondLastTr[0].content.length > 1_000, '倒数第二条不应被驱逐');

  // 最早一条应被占位
  const firstTr = msgs[1].content as Array<{ content: string }>;
  assert.ok(firstTr[0].content.startsWith('[philont: tool result evicted]'));
});

test('evict: 幂等 - 重复调用不反复驱逐同一条', () => {
  const bigText = 'y'.repeat(200_000);
  const msgs: NativeMessage[] = [];
  for (let i = 0; i < 4; i++) {
    msgs.push(assistantToolUse(`t${i}`, 'readFile'));
    msgs.push(userToolResult(`t${i}`, bigText));
  }

  const r1 = evictOldToolResults(msgs, { budgetTokens: 100_000, keepRecent: 1 });
  assert.ok(r1.didEvict);
  const firstCount = r1.evictedCount;

  // 再调一次:要么 no-op,要么只动还没被驱逐的那部分
  const r2 = evictOldToolResults(msgs, { budgetTokens: 100_000, keepRecent: 1 });
  // 第二轮不应重复驱逐已占位的那批
  if (r2.didEvict) {
    assert.ok(r2.evictedCount <= firstCount);
  }
});

test('evict: tool_result 数量 ≤ keepRecent → 即使超预算也不动', () => {
  const huge = 'z'.repeat(2_000_000);
  const msgs: NativeMessage[] = [
    assistantToolUse('t1', 'readFile'),
    userToolResult('t1', huge),
  ];
  const r = evictOldToolResults(msgs, {
    budgetTokens: 100,
    keepRecent: 4,
  });
  assert.equal(r.didEvict, false);
  const tr = msgs[1].content as Array<{ content: string }>;
  assert.equal(tr[0].content.length, huge.length);
});

test('evict: 非 tool_result(纯 text user/assistant)不被动', () => {
  const bigText = 'a'.repeat(200_000);
  const msgs: NativeMessage[] = [
    userText(bigText),          // 不是 tool_result,不应被驱逐
    assistantText(bigText),
    assistantToolUse('t1', 'readFile'),
    userToolResult('t1', bigText),
    assistantToolUse('t2', 'readFile'),
    userToolResult('t2', bigText),
  ];
  const r = evictOldToolResults(msgs, { budgetTokens: 50_000, keepRecent: 1 });
  // user/assistant 文本消息原样
  assert.equal((msgs[0].content as string).length, bigText.length);
  assert.equal((msgs[1].content as string).length, bigText.length);
  // 但确实驱逐了老的 tool_result
  if (r.didEvict) {
    const firstTr = msgs[3].content as Array<{ content: string }>;
    assert.ok(firstTr[0].content.startsWith('[philont: tool result evicted]'));
  }
});

// ── evictForEmergency(400 兜底路径) ──────────────────────────────────────

test('emergency: 激进驱逐但保留最近 2 条(防失忆)', () => {
  const bigText = 'x'.repeat(100_000);
  const msgs: NativeMessage[] = [];
  for (let i = 0; i < 6; i++) {
    msgs.push(assistantToolUse(`t${i}`, 'readFile'));
    msgs.push(userToolResult(`t${i}`, bigText));
  }
  const r = evictForEmergency(msgs);
  assert.ok(r.didEvict);
  // 最早 4 条应被占位,最后 2 条原样(6 total - keepRecent=2)
  const firstTr = msgs[1].content as Array<{ content: string }>;
  assert.ok(firstTr[0].content.startsWith('[philont: tool result evicted]'));
  // 最后两条不被动 — 这是"你想下载什么"失忆 bug 的关键修复
  const lastTr = msgs[11].content as Array<{ content: string }>;
  assert.equal(lastTr[0].content.length, bigText.length);
  const secondLastTr = msgs[9].content as Array<{ content: string }>;
  assert.equal(secondLastTr[0].content.length, bigText.length);
});

test('emergency: Pass3 兜底 — 连最近的巨型 tool_result 也会被硬截(防 keepRecent 保护导致窗口爆)', () => {
  // 实测场景:agent 刚调了个输出巨大的工具(如 webFetch 下载了 500K 字符 HTML),
  // tool_result 数 ≤ keepRecent 时 Pass1 不动它,Pass2 只处理 text 不处理 tool_result,
  // 旧版紧急驱逐对这种情况完全无效 → Pass 3 兜底硬截 tool_result content。
  const big = 'y'.repeat(500_000);
  const msgs: NativeMessage[] = [
    assistantToolUse('t1', 'readFile'),
    userToolResult('t1', big),
    assistantToolUse('t2', 'readFile'),
    userToolResult('t2', big),
  ];
  const r = evictForEmergency(msgs);
  assert.ok(r.didEvict, 'Pass 3 应该硬截 tool_result content');
  assert.ok(r.tokensAfter < r.tokensBefore);

  // 两条 tool_result 的 content 都被截到 emergencyMaxToolResultBytes 附近
  const tr1 = msgs[1].content as Array<{ content: string }>;
  assert.ok(tr1[0].content.length < 20_000, `期望被截断, 实际 ${tr1[0].content.length}`);
  assert.ok(tr1[0].content.includes('紧急末路'));

  const tr2 = msgs[3].content as Array<{ content: string }>;
  assert.ok(tr2[0].content.length < 20_000);
});

test('emergency: Pass2 截断早期巨型 user/assistant 文本(不依赖 tool_result)', () => {
  // 实测线上抓到的场景:messages[0] 是个 2M 的 memory-prefix 塞在 user 消息里,
  // tool_result 少得可怜 → 旧版紧急驱逐完全不起作用
  const hugePrefix = 'x'.repeat(500_000);
  const msgs: NativeMessage[] = [
    userText(hugePrefix), // 相当于被污染的 memory-prefix
    assistantText('明白'),
    userText('帮我下载 pdf'),
    assistantText('好的'),
    userText('继续?'),
  ];
  const r = evictForEmergency(msgs);
  assert.ok(r.didEvict);
  // 最早那条 user 被截断
  const m0 = msgs[0].content as string;
  assert.ok(m0.length < 100_000, `期望被截断,实际长度 ${m0.length}`);
  assert.ok(m0.includes('紧急截断'));
  // 最后 2 条(keepRecent=2)原样
  assert.equal(msgs[3].content, '好的');
  assert.equal(msgs[4].content, '继续?');
});

test('emergency: Pass2 也能处理 text block 数组', () => {
  // 要超过 emergencyBudgetTokens=200_000,chars * 0.6 要 > 200K,故 ≥ 400K chars
  const hugeText = 'z'.repeat(400_000);
  const msgs: NativeMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: hugeText } as never],
    },
    userText('hi'),
    userText('world'),
  ];
  const r = evictForEmergency(msgs);
  assert.ok(r.didEvict);
  const blocks = msgs[0].content as Array<{ type: string; text: string }>;
  assert.ok(blocks[0].text.length < 50_000);
  assert.ok(blocks[0].text.includes('紧急截断'));
});

// ── 默认值 sanity ─────────────────────────────────────────────────────────

test('defaults 合理', () => {
  assert.ok(DEFAULTS.maxSingleToolResultBytes > 100_000);
  assert.ok(DEFAULTS.contextBudgetTokens > 100_000);
  assert.ok(DEFAULTS.keepRecentToolResults >= 1);
});
