/**
 * idle_consolidator 测试 —— 验证 K0.6 cursor 推进 + 空闲触发逻辑。
 *
 * 用 mock LLM(立即返回固定内容),关注的是调度逻辑而不是 extractor/reflector
 * 自身的解析正确性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  startIdleConsolidator,
  GLOBAL_TIMELINE_SESSION_ID,
  SessionExtractor,
  SessionReflector,
  type ExtractorLlmClient,
} from '../src/index.js';

function emptyArrayLlm(): ExtractorLlmClient {
  return {
    async complete() {
      return { text: '[]', tokensUsed: 1 };
    },
  };
}

function appendMessages(handle: ReturnType<typeof openMemoryDb>, n: number, prefix = ''): void {
  for (let i = 0; i < n; i++) {
    handle.raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${prefix}msg${i}`,
    });
  }
}

function setupConsolidator(idleThresholdMs = 0) {
  const handle = openMemoryDb(':memory:');
  const llm = emptyArrayLlm();
  const extractor = new SessionExtractor(llm, handle.facts, handle.notes, handle.raw);
  const reflector = new SessionReflector(llm, handle.skills, handle.actions, handle.raw);
  const consolidator = startIdleConsolidator({
    raw: handle.raw,
    facts: handle.facts,
    extractor,
    reflector,
    idleThresholdMs,
    minNewMessages: 2,
    tickIntervalMs: 1_000_000,    // 不让自动 timer 触发,只用显式 tick()
  });
  return { handle, consolidator };
}

test('idle: 空库 → tick 立刻返回 false', async () => {
  const { handle, consolidator } = setupConsolidator();
  const fired = await consolidator.tick();
  assert.equal(fired, false);
  consolidator.stop();
  handle.close();
});

test('idle: 第一次 tick 锚 cursor 到 latest,不抽 backlog', async () => {
  const { handle, consolidator } = setupConsolidator();
  appendMessages(handle, 5);
  // idleThresholdMs=0 → 立刻视为空闲
  const fired = await consolidator.tick();
  assert.equal(fired, false, '首次 tick 不该真跑 extractor');
  // cursor 已写
  const cursor = handle.facts.getFact('system', 'last_consolidated_ts');
  assert.ok(cursor, 'cursor 应该已经写入');
  consolidator.stop();
  handle.close();
});

test('idle: cursor 锚定后,新消息累积到 minNewMessages 触发固化', async () => {
  const { handle, consolidator } = setupConsolidator();
  appendMessages(handle, 5);
  await consolidator.tick(); // 锚 cursor

  // 累积新消息
  await new Promise((r) => setTimeout(r, 5)); // 让 timestamp 大于 cursor
  appendMessages(handle, 3, 'new-');
  const fired = await consolidator.tick();
  assert.equal(fired, true);
  // cursor 推进到最新
  const cursor = handle.facts.getFact('system', 'last_consolidated_ts');
  const cursorTs = cursor?.value as number;
  const latest = handle.raw.queryTimeline({ order: 'desc', limit: 1 });
  assert.equal(cursorTs, latest[0].timestamp);
  consolidator.stop();
  handle.close();
});

test('idle: 固化后 cursor 不动 → 再 tick no-op', async () => {
  const { handle, consolidator } = setupConsolidator();
  appendMessages(handle, 3);
  await consolidator.tick(); // 锚定
  await new Promise((r) => setTimeout(r, 5));
  appendMessages(handle, 4, 'new-');
  await consolidator.tick(); // 触发固化
  // 再次 tick 不应该做事
  const fired = await consolidator.tick();
  assert.equal(fired, false);
  consolidator.stop();
  handle.close();
});

test('idle: 还在活跃(idleThresholdMs > 0)→ 不固化', async () => {
  const { handle, consolidator } = setupConsolidator(60_000);
  appendMessages(handle, 5); // 刚刚 append,idleMs ≈ 0 < 60s
  const fired = await consolidator.tick();
  assert.equal(fired, false);
  consolidator.stop();
  handle.close();
});

test('idle: minNewMessages 未达 → 不触发', async () => {
  const { handle, consolidator } = setupConsolidator();
  appendMessages(handle, 5);
  await consolidator.tick(); // 锚定 cursor
  await new Promise((r) => setTimeout(r, 5));
  appendMessages(handle, 1, 'small-'); // 只 1 条 < minNewMessages=2
  const fired = await consolidator.tick();
  assert.equal(fired, false);
  consolidator.stop();
  handle.close();
});

test('idle: onConsolidate 钩子被调用,带正确 range', async () => {
  const handle = openMemoryDb(':memory:');
  const llm = emptyArrayLlm();
  const extractor = new SessionExtractor(llm, handle.facts, handle.notes, handle.raw);
  const reflector = new SessionReflector(llm, handle.skills, handle.actions, handle.raw);
  const captured: Array<{ fromTs: number; toTs: number; messageCount: number }> = [];
  const consolidator = startIdleConsolidator({
    raw: handle.raw,
    facts: handle.facts,
    extractor,
    reflector,
    idleThresholdMs: 0,
    minNewMessages: 2,
    tickIntervalMs: 1_000_000,
    onConsolidate: async (range) => {
      captured.push(range);
    },
  });

  appendMessages(handle, 3);
  await consolidator.tick(); // 锚定
  await new Promise((r) => setTimeout(r, 5));
  appendMessages(handle, 4, 'new-');
  await consolidator.tick();

  assert.equal(captured.length, 1);
  assert.ok(captured[0].messageCount >= 4);
  assert.ok(captured[0].toTs >= captured[0].fromTs);

  consolidator.stop();
  handle.close();
});

test('idle: stop() 是幂等的', async () => {
  const { handle, consolidator } = setupConsolidator();
  consolidator.stop();
  consolidator.stop();
  handle.close();
});
