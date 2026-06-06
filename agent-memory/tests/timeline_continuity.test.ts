/**
 * K0 端到端集成测试:模拟用户的真实 bug 场景。
 *
 * 旧版 bug:09:39 agent 找到两个 PDF 路径并回复给用户,8 分钟后(09:47)
 * 用户问"对比一下这两份",agent 回答"我没看到任何路径" —— 因为 ws 抖动 +
 * server 单方面随机生成 sessionId,sessions Map 重建,in-memory messages 丢光。
 *
 * K0 后:每轮工作上下文从 raw 全局时间线召回,跟 ws sid 完全脱钩。
 * 这个测试用 RawStore + TimelineRetriever 模拟"两次不同的 ws 连接"看到
 * 同一段历史。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  TimelineRetriever,
  GLOBAL_TIMELINE_SESSION_ID,
} from '../src/index.js';

test('continuity: 跨 ws 连接,agent 看得见 8 分钟前自己说过的内容', () => {
  const handle = openMemoryDb(':memory:');
  const retriever = new TimelineRetriever(handle.raw);

  // ── 第一次"ws 连接"(模拟 ws-A,sessionId='aaa') ──
  // 注意:K0 后 chat-handler 不再用 ws sid 做 raw 写入 key,统一用 GLOBAL
  handle.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'user',
    content: '帮我下载 arxiv 2507.21046 这篇论文',
  });
  handle.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'assistant',
    content:
      '找到了!E:\\dev\\philont\\server\\arxiv_2507.21046_self_evolving_agents.pdf,' +
      'C:\\Users\\alice\\Downloads\\2507.21046.pdf 两个文件都在,论文已完整下载到本地。',
  });

  // ── 模拟 8 分钟空档:ws 断 + 重连(sessionId 变 'bbb',in-memory messages 丢光) ──
  // 关键差异:旧版下游 messages 数组是 sessions['bbb']=[],新连接看不到 'aaa' 的消息。
  // 新版 raw 全局时间线还在,retriever 可召回。

  // ── 第二次"ws 连接"(模拟 ws-B,sessionId='bbb',user 追问) ──
  const userFollowup = '你再看一下这两份一样吗?';
  const recalled = retriever.retrieve({
    recentBudgetTokens: 10_000,
    recallBudgetTokens: 10_000,
    recallQuery: userFollowup,
  });

  // 召回结果应该包含上一轮 assistant 给出的"两个 PDF 路径"
  const allText = recalled.messages.map((m) => m.content).join('\n');
  assert.ok(
    allText.includes('arxiv_2507.21046_self_evolving_agents.pdf'),
    'agent 应该能从时间线召回上一轮自己说过的 PDF 路径(E:\\\\)',
  );
  assert.ok(
    allText.includes('2507.21046.pdf'),
    'agent 应该能从时间线召回上一轮自己说过的 PDF 路径(C:\\\\)',
  );
  // 用户原始下载请求也应该在
  assert.ok(
    allText.includes('arxiv 2507.21046'),
    '用户最初的下载请求应该也在召回里',
  );

  handle.close();
});

test('continuity: 大量中间消息后,关键词召回仍能找到很老的事实', () => {
  const handle = openMemoryDb(':memory:');
  const retriever = new TimelineRetriever(handle.raw);

  // 用户介绍自己
  handle.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'user',
    content: '我叫张三,在北京做后端工程师,公司是字节跳动',
  });
  handle.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'assistant',
    content: '好的张三,我记下了你在字节跳动做后端。',
  });

  // 200 条与"张三"无关的中间对话
  for (let i = 0; i < 200; i++) {
    handle.raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `这是中间的对话第 ${i} 条,讨论的是天气和股票走势。`,
    });
  }

  // 用户问"我之前说过我是哪家公司的"
  const recalled = retriever.retrieve({
    recentBudgetTokens: 1000,   // 小预算 → recency 装不下 200 条
    recallBudgetTokens: 5000,
    recallQuery: '字节跳动',
  });

  const allText = recalled.messages.map((m) => m.content).join('\n');
  assert.ok(
    allText.includes('字节跳动'),
    `应该能用"字节跳动"做 recall 召回老消息,实得 ${recalled.recallCount} 召回 + ${recalled.recencyCount} recency`,
  );

  handle.close();
});
