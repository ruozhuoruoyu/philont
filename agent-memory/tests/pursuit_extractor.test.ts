/**
 * SessionPursuitExtractor 单测
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import { PursuitStore } from '../src/pursuit.js';
import { RawStore } from '../src/raw.js';
import { SessionPursuitExtractor } from '../src/pursuit_extractor.js';
import { InMemoryAuditHook } from '../src/audit.js';
import type { ExtractorLlmClient } from '../src/extractor.js';

function mkFixture(llmResponse: string) {
  const db = new Database(':memory:');
  initSchema(db);
  const pursuits = new PursuitStore(db);
  const raw = new RawStore(db);
  const audit = new InMemoryAuditHook();

  const llm: ExtractorLlmClient = {
    async complete() {
      return { text: llmResponse, tokensUsed: 100 };
    },
  };
  const extractor = new SessionPursuitExtractor(llm, pursuits, raw, {
    auditHook: audit,
  });

  // 造一段 4 轮以上的会话(低于 4 条直接返回空)
  const sessionId = 'sess-1';
  raw.startSession(sessionId);
  for (const [role, content] of [
    ['user', '最近老头疼'],
    ['assistant', '头疼持续多久了?'],
    ['user', '两周了,晚上睡不好'],
    ['assistant', '睡眠和头疼常常互相影响,要不要一起看?'],
    ['user', '好啊'],
  ] as const) {
    raw.appendMessage({ sessionId, role, content });
  }

  return { db, pursuits, raw, audit, extractor, sessionId };
}

test('SessionPursuitExtractor: LLM 返回空数组 → 不建 pursuit', async () => {
  const { extractor, pursuits, sessionId } = mkFixture('[]');
  const r = await extractor.extractFromSession(sessionId);
  assert.equal(r.pursuitsProposed, 0);
  assert.equal(r.pursuits.length, 0);
  // 默认 root 还在,但没有子 pursuit
  assert.equal(pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID).length, 1);
});

test('SessionPursuitExtractor: 正常返回 → shadow pursuit 落盘 + audit 事件', async () => {
  const llmOut = JSON.stringify([
    {
      action: 'propose_pursuit',
      title: '理解用户头疼模式',
      intent: '识别诱因并给建议',
      open_questions: ['频率?', '诱因?', '睡眠关系?'],
      stake: 'medium',
    },
  ]);
  const { extractor, pursuits, audit, sessionId } = mkFixture(llmOut);

  const r = await extractor.extractFromSession(sessionId);
  assert.equal(r.pursuitsProposed, 1);
  assert.equal(r.pursuits[0].status, 'shadow');
  assert.equal(r.pursuits[0].origin, 'extractor');
  assert.equal(r.pursuits[0].title, '理解用户头疼模式');
  assert.equal(r.pursuits[0].openQuestions.length, 3);
  assert.equal(r.pursuits[0].rootPursuitId, BOOTSTRAP_ROOT_PURSUIT_ID);

  // DB 里 shadow pursuit 可通过 listByStatus('shadow') 找到
  const shadow = pursuits.listByStatus(BOOTSTRAP_ROOT_PURSUIT_ID, 'shadow');
  assert.equal(shadow.length, 1);

  // audit 事件:create_pursuit,origin Internal,source extractor
  const events = audit.events.filter((e) => e.type === 'self_domain_write');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.source, 'extractor');
  assert.equal(events[0].data.origin, 'Internal');
  assert.equal(events[0].data.toolName, 'create_pursuit');
  assert.equal(events[0].data.status, 'shadow');
});

test('SessionPursuitExtractor: markdown code fence 包裹的 JSON 也能解析', async () => {
  const fenced =
    '```json\n' +
    JSON.stringify([
      {
        action: 'propose_pursuit',
        title: '学 Rust',
        intent: '掌握所有权和生命周期',
        open_questions: ['所有权细节', '生命周期案例'],
      },
    ]) +
    '\n```';
  const { extractor, sessionId } = mkFixture(fenced);
  const r = await extractor.extractFromSession(sessionId);
  assert.equal(r.pursuitsProposed, 1);
});

test('SessionPursuitExtractor: 对话太短直接返回空,不调 LLM', async () => {
  const db = new Database(':memory:');
  initSchema(db);
  const pursuits = new PursuitStore(db);
  const raw = new RawStore(db);
  let called = false;
  const llm: ExtractorLlmClient = {
    async complete() {
      called = true;
      return { text: '[]', tokensUsed: 0 };
    },
  };
  const extractor = new SessionPursuitExtractor(llm, pursuits, raw);

  const sid = 'short';
  raw.startSession(sid);
  raw.appendMessage({ sessionId: sid, role: 'user', content: '你好' });
  raw.appendMessage({ sessionId: sid, role: 'assistant', content: '你好!' });

  const r = await extractor.extractFromSession(sid);
  assert.equal(r.pursuitsProposed, 0);
  assert.equal(called, false, '对话 < 4 条不该调 LLM');
});

test('SessionPursuitExtractor: 非法 LLM 输出 → 返回空不崩', async () => {
  const { extractor, sessionId } = mkFixture('这不是 JSON');
  const r = await extractor.extractFromSession(sessionId);
  assert.equal(r.pursuitsProposed, 0);
});

test('SessionPursuitExtractor: 缺 title 或 intent 的提议被跳过', async () => {
  const { extractor, sessionId } = mkFixture(
    JSON.stringify([
      { action: 'propose_pursuit', title: '只有 title', open_questions: [] },
      {
        action: 'propose_pursuit',
        title: '完整项',
        intent: 'x',
        open_questions: ['q'],
      },
    ])
  );
  const r = await extractor.extractFromSession(sessionId);
  assert.equal(r.pursuitsProposed, 1);
  assert.equal(r.pursuits[0].title, '完整项');
});
