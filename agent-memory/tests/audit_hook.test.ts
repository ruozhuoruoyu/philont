/**
 * MemoryAuditHook 集成测试
 *
 * 验证 Extractor / Reflector / Compactor 在写入时通过 auditHook 留痕，
 * 事件携带 origin='Internal' + source=<module>。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  SessionExtractor,
  SessionReflector,
  Compactor,
  InMemoryAuditHook,
} from '../src/index.js';
import type { ExtractorLlmClient } from '../src/extractor.js';

class MockLlm implements ExtractorLlmClient {
  constructor(private readonly response: string) {}
  async complete(_prompt: string) {
    return { text: this.response, tokensUsed: 0 };
  }
}

test('extractor: auditHook receives self_domain_write with Internal origin for each fact/note', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: 'hi' });

  const llm = new MockLlm(
    JSON.stringify([
      { action: 'store_fact', namespace: 'user', key: 'name', value: '张三' },
      { action: 'store_note', content: '一条笔记', importance: 0.7 },
    ])
  );
  const auditHook = new InMemoryAuditHook();
  const extractor = new SessionExtractor(llm, facts, notes, raw, { auditHook });

  await extractor.extractFromSession(session.id);

  // 至少有一条 fact 和一条 note 的审计事件
  const events = auditHook.events.filter((e) => e.type === 'self_domain_write');
  assert.equal(events.length, 2);
  for (const ev of events) {
    assert.equal(ev.data.origin, 'Internal');
    assert.equal(ev.data.source, 'extractor');
    assert.equal(ev.data.sessionId, session.id);
  }
  // toolName 应覆盖 store_fact 与 store_note
  const toolNames = new Set(events.map((e) => e.data.toolName));
  assert.ok(toolNames.has('store_fact'));
  assert.ok(toolNames.has('store_note'));
});

test('reflector: auditHook records create_skill with Internal origin', async () => {
  const { raw, skills, actions } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: 'do X' });
  raw.appendMessage({ sessionId: session.id, role: 'assistant', content: 'done' });

  const llm = new MockLlm(
    JSON.stringify([
      {
        name: 'deploy-flow',
        description: '部署流程',
        trigger_keywords: ['deploy', '部署'],
        action_template: '1. build\n2. push',
      },
    ])
  );
  const auditHook = new InMemoryAuditHook();
  const reflector = new SessionReflector(llm, skills, actions, raw, { auditHook });
  await reflector.reflectFromSession(session.id);

  const events = auditHook.events.filter((e) => e.type === 'self_domain_write');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data.origin, 'Internal');
  assert.equal(events[0]!.data.source, 'reflector');
  assert.equal(events[0]!.data.toolName, 'create_skill');
});

test('compactor: auditHook records summary note write with Internal origin', async () => {
  const { notes } = openMemoryDb(':memory:');
  const llm = new MockLlm('这是一段摘要。');
  const auditHook = new InMemoryAuditHook();
  const compactor = new Compactor(
    llm,
    notes,
    {
      thresholdTokens: 10,             // 低阈值强触发
      protectFirstN: 1,
      protectLastN: 1,
      estimator: () => 100,            // 每条消息 100 token，必超阈值
    },
    { auditHook }
  );

  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
  ];
  const result = await compactor.compact(msgs, 'sess-x');
  assert.equal(result.didCompact, true);

  const events = auditHook.events.filter((e) => e.type === 'self_domain_write');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data.origin, 'Internal');
  assert.equal(events[0]!.data.source, 'compactor');
  assert.equal(events[0]!.data.toolName, 'store_note');
  assert.equal(events[0]!.data.sessionId, 'sess-x');
});

test('without auditHook: post-processors still work (silent mode)', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: 'hi' });

  const llm = new MockLlm(
    JSON.stringify([
      { action: 'store_fact', namespace: 'user', key: 'name', value: 'x' },
    ])
  );
  const extractor = new SessionExtractor(llm, facts, notes, raw);
  const result = await extractor.extractFromSession(session.id);
  assert.equal(result.factsStored, 1);
});
