/**
 * Compactor 单元测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, Compactor, type CompactorMessage, type ExtractorLlmClient } from '../src/index.js';

class MockSummaryLlm implements ExtractorLlmClient {
  callCount = 0;
  constructor(private readonly summary: string = '用户和助手讨论了 X 项目，决定使用 Rust，并完成了初步设计。') {}
  async complete(_prompt: string) {
    this.callCount++;
    return { text: this.summary, tokensUsed: 50 };
  }
}

class FailingLlm implements ExtractorLlmClient {
  async complete(_prompt: string): Promise<{ text: string; tokensUsed: number }> {
    throw new Error('LLM 调用失败');
  }
}

function makeMessages(count: number, charsPerMessage = 100): CompactorMessage[] {
  const out: CompactorMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `这是第 ${i} 条消息，` + '内容填充'.repeat(charsPerMessage / 4),
    });
  }
  return out;
}

// ── needsCompaction ────────────────────────────────────────────────────

test('needsCompaction returns false for short messages', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 10000,
    protectFirstN: 2,
    protectLastN: 4,
  });

  // 只有 5 条短消息，远低于阈值
  const messages = makeMessages(5, 50);
  assert.equal(compactor.needsCompaction(messages), false);
});

test('needsCompaction returns true when over threshold', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 500,  // 低阈值
    protectFirstN: 2,
    protectLastN: 4,
  });

  // 20 条长消息，超过阈值
  const messages = makeMessages(20, 200);
  assert.equal(compactor.needsCompaction(messages), true);
});

test('needsHardCompaction uses hardThresholdTokens (default = soft × 1.4)', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 1000,
    // 不传 hardThresholdTokens → 默认 = 1000 × 1.4 = 1400
    protectFirstN: 2,
    protectLastN: 4,
  });
  // 10 条 × charsPerMessage=200 ≈ 1260 tokens —— 过 soft(1000)但未过 hard(1400)
  const messages = makeMessages(10, 200);
  const tokens = compactor.estimateTokens(messages);
  assert.ok(tokens > 1000 && tokens < 1400, `tokens=${tokens} 应在 (1000, 1400) 区间`);
  assert.equal(compactor.needsCompaction(messages), true);
  assert.equal(compactor.needsHardCompaction(messages), false);
});

test('needsHardCompaction triggers when hardThresholdTokens is exceeded', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 500,
    hardThresholdTokens: 800,
    protectFirstN: 2,
    protectLastN: 4,
  });
  const messages = makeMessages(30, 200); // ~1800 tokens,过 hard
  assert.equal(compactor.needsHardCompaction(messages), true);
});

test('needsHardCompaction returns false when too few messages to protect head+tail', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 10,
    hardThresholdTokens: 20,
    protectFirstN: 2,
    protectLastN: 4,
  });
  const messages = makeMessages(5, 100);
  assert.equal(compactor.needsHardCompaction(messages), false);
});

test('needsCompaction returns false when too few messages to protect head+tail', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 10,  // 极低阈值
    protectFirstN: 2,
    protectLastN: 4,
  });

  // 只有 5 条消息，protectFirstN + protectLastN + 2 = 8，不够
  const messages = makeMessages(5, 100);
  assert.equal(compactor.needsCompaction(messages), false);
});

// ── compact 行为 ───────────────────────────────────────────────────────

test('compact short messages returns unchanged', async () => {
  const { notes } = openMemoryDb(':memory:');
  const llm = new MockSummaryLlm();
  const compactor = new Compactor(llm, notes, {
    thresholdTokens: 10000,
    protectFirstN: 2,
    protectLastN: 4,
  });

  const messages = makeMessages(5);
  const result = await compactor.compact(messages);

  assert.equal(result.didCompact, false);
  assert.equal(result.compactedMessages.length, 5);
  assert.equal(result.summaryNoteId, null);
  assert.equal(llm.callCount, 0); // 不应调用 LLM
});

test('compact preserves head and tail, summarizes middle', async () => {
  const { notes } = openMemoryDb(':memory:');
  const llm = new MockSummaryLlm('压缩后的摘要内容');
  const compactor = new Compactor(llm, notes, {
    thresholdTokens: 500,
    protectFirstN: 2,
    protectLastN: 4,
  });

  // 20 条消息，超过阈值
  const messages = makeMessages(20, 200);
  const tokensBefore = compactor.estimateTokens(messages);

  const result = await compactor.compact(messages);

  assert.equal(result.didCompact, true);
  assert.equal(llm.callCount, 1);

  // 结果应是：2 头 + 1 摘要 + 4 尾 = 7 条
  assert.equal(result.compactedMessages.length, 7);

  // 头部消息保持不变
  assert.deepEqual(result.compactedMessages[0], messages[0]);
  assert.deepEqual(result.compactedMessages[1], messages[1]);

  // 中间是摘要
  const summaryMsg = result.compactedMessages[2];
  assert.equal(summaryMsg.role, 'user');
  assert.ok(typeof summaryMsg.content === 'string');
  assert.ok((summaryMsg.content as string).includes('Context summary'));
  assert.ok((summaryMsg.content as string).includes('压缩后的摘要内容'));

  // 尾部 4 条保持不变
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(
      result.compactedMessages[3 + i],
      messages[messages.length - 4 + i],
    );
  }

  // tokens 应该减少
  assert.ok(result.tokensAfter < tokensBefore);
});

test('compact writes summary as session-summary note (v6: fixed id, importance=1.0)', async () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm('关键信息：项目 X'), notes, {
    thresholdTokens: 500,
    protectFirstN: 2,
    protectLastN: 4,
  });

  const messages = makeMessages(20, 200);
  const result = await compactor.compact(messages, 'session-abc');

  assert.equal(result.didCompact, true);
  assert.ok(result.summaryNoteId);

  // sessionId 存在 → 走 session-summary 路径,固定 id 便于 upsert
  assert.equal(result.summaryNoteId, 'session-summary-session-abc');

  assert.equal(notes.count(), 1);
  const found = notes.search('项目');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, result.summaryNoteId);
  assert.equal(found[0].sessionId, 'session-abc');
  // importance=1.0 区别于普通压缩笔记(之前 0.8),用于跨会话续接注入
  assert.equal(found[0].importance, 1.0);
});

test('compact without sessionId falls back to random-id note at importance 0.8', async () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm('无会话 summary'), notes, {
    thresholdTokens: 500,
    protectFirstN: 2,
    protectLastN: 4,
  });

  const messages = makeMessages(20, 200);
  const result = await compactor.compact(messages);

  assert.equal(result.didCompact, true);
  assert.ok(result.summaryNoteId);
  assert.ok(!result.summaryNoteId!.startsWith('session-summary-'));
  assert.equal(notes.count(), 1);
  const note = notes.getNoteById(result.summaryNoteId!);
  assert.equal(note?.importance, 0.8);
});

test('compact twice on same session updates session-summary note in place', async () => {
  const { notes } = openMemoryDb(':memory:');
  let summaryN = 0;
  const llm = {
    async complete() {
      summaryN++;
      return { text: `摘要版本 ${summaryN}`, tokensUsed: 1 };
    },
  };
  const compactor = new Compactor(llm, notes, {
    thresholdTokens: 100,
    protectFirstN: 2,
    protectLastN: 4,
  });
  const messages = makeMessages(20, 200);
  await compactor.compact(messages, 'session-xyz');
  await compactor.compact(makeMessages(20, 200), 'session-xyz');

  assert.equal(notes.count(), 1, '同 session 多次压缩应 upsert,只保留一条');
  const note = notes.getNoteById('session-summary-session-xyz');
  assert.equal(note?.content, '摘要版本 2');
});

test('compact gracefully degrades on LLM failure', async () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new FailingLlm(), notes, {
    thresholdTokens: 500,
    protectFirstN: 2,
    protectLastN: 4,
  });

  const messages = makeMessages(20, 200);
  const result = await compactor.compact(messages);

  // LLM 失败 → 安全降级，返回原消息
  assert.equal(result.didCompact, false);
  assert.equal(result.compactedMessages.length, 20);
  assert.equal(result.summaryNoteId, null);
  assert.equal(notes.count(), 0);
});

test('estimateTokens uses default heuristic', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 1000,
    protectFirstN: 1,
    protectLastN: 1,
  });

  // 100 chars × 0.6 = 60 tokens
  const messages: CompactorMessage[] = [
    { role: 'user', content: 'a'.repeat(100) },
  ];
  assert.equal(compactor.estimateTokens(messages), 60);
});

test('custom estimator overrides default', () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm(), notes, {
    thresholdTokens: 1000,
    protectFirstN: 1,
    protectLastN: 1,
    estimator: () => 999, // 每条消息固定 999 token
  });

  const messages: CompactorMessage[] = [
    { role: 'user', content: 'short' },
    { role: 'assistant', content: 'short' },
  ];
  assert.equal(compactor.estimateTokens(messages), 1998);
});

test('compact handles complex content (object)', async () => {
  const { notes } = openMemoryDb(':memory:');
  const compactor = new Compactor(new MockSummaryLlm('summary'), notes, {
    thresholdTokens: 200,
    protectFirstN: 1,
    protectLastN: 2,
  });

  // 包含工具调用风格的复合内容
  const messages: CompactorMessage[] = [
    { role: 'user', content: 'system prompt' },
    { role: 'user', content: 'first user msg' },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'read', input: { path: '/tmp/x' } }] as unknown },
    { role: 'user', content: [{ type: 'tool_result', content: 'file contents' }] as unknown },
    { role: 'assistant', content: 'middle reply with lots of text '.repeat(20) },
    { role: 'user', content: 'recent question' },
    { role: 'assistant', content: 'recent answer' },
  ];

  const result = await compactor.compact(messages);
  assert.equal(result.didCompact, true);
  // 应该是 1 头 + 1 摘要 + 2 尾 = 4 条
  assert.equal(result.compactedMessages.length, 4);
});
