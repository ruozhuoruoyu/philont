/**
 * SelfReflector + self.* 写保护单测
 *
 * 覆盖:
 *   - 材料不足 → 占位 summary,不调 LLM
 *   - 材料充足 → 调 LLM → 写 self.summary/strengths/growth_edges
 *   - LLM 返回不合法 JSON → updated=false,不写
 *   - sourceIntegrity 校验真实 skill/pursuit ID
 *   - 外部 storeFact 写 self.* 被拒
 *   - updateSelfFact caller 必须是 'self-reflector'
 *   - 多次 reflect → 旧 fact 被 supersede
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import {
  MemoryStore,
  SelfDescriptionWriteForbiddenError,
  type SelfFactValue,
} from '../src/store.js';
import { SkillStore } from '../src/skills.js';
import { PursuitStore } from '../src/pursuit.js';
import { ActionLog } from '../src/actions.js';
import { DriveOutcomeStore } from '../src/drive_outcome.js';
import { SelfReflector } from '../src/self_reflector.js';
import { InMemoryAuditHook } from '../src/audit.js';
import type { ExtractorLlmClient } from '../src/extractor.js';

function mkStores() {
  const db = new Database(':memory:');
  initSchema(db);
  return {
    db,
    memory: new MemoryStore(db),
    skills: new SkillStore(db),
    pursuits: new PursuitStore(db),
    actions: new ActionLog(db),
    outcomes: new DriveOutcomeStore(db),
    audit: new InMemoryAuditHook(),
  };
}

function mkLlm(response: string): ExtractorLlmClient {
  return {
    async complete() {
      return { text: response, tokensUsed: 42 };
    },
  };
}

// ── 写保护 ──────────────────────────────────────────────────────────────

test('storeFact 对 self.* 直接写入抛 SelfDescriptionWriteForbiddenError', () => {
  const { memory } = mkStores();
  assert.throws(
    () =>
      memory.storeFact({
        namespace: 'self',
        key: 'summary',
        value: { content: '假装我很厉害', sourceRefs: [], updatedAt: Date.now() },
      }),
    SelfDescriptionWriteForbiddenError,
  );
});

test('非 self 命名空间 storeFact 不受影响', () => {
  const { memory } = mkStores();
  const f = memory.storeFact({
    namespace: 'user',
    key: 'name',
    value: 'alice',
  });
  assert.equal(f.namespace, 'user');
});

test('updateSelfFact 必须 caller="self-reflector",其它值抛错', () => {
  const { memory } = mkStores();
  // 正常路径
  memory.updateSelfFact('test', 'hello', [], 'self-reflector');
  // TS 类型层面已限死,但运行时也防御一道
  assert.throws(
    () =>
      (memory as unknown as {
        updateSelfFact: (
          k: string,
          v: string,
          s: string[],
          c: string,
        ) => unknown;
      }).updateSelfFact('test', 'hi', [], 'not-the-reflector'),
    SelfDescriptionWriteForbiddenError,
  );
});

// ── 材料不足路径 ──────────────────────────────────────────────────────

test('材料不足 → 占位 summary,不调 LLM', async () => {
  const { memory, skills, pursuits, actions, outcomes, audit } = mkStores();
  // 不塞 skill、不塞 pursuit
  let llmCalled = false;
  const llm: ExtractorLlmClient = {
    async complete() {
      llmCalled = true;
      return { text: '{}', tokensUsed: 0 };
    },
  };
  const reflector = new SelfReflector(
    llm,
    memory,
    skills,
    pursuits,
    actions,
    outcomes,
    { auditHook: audit },
  );
  const r = await reflector.reflect();
  assert.equal(llmCalled, false);
  assert.equal(r.updated, true);
  assert.ok(r.summary.includes('still getting to know myself'));

  const fact = memory.getFact('self', 'summary');
  assert.ok(fact);
  const value = fact!.value as SelfFactValue;
  assert.ok((value.content as string).includes('still getting to know myself'));
});

// ── 材料充足路径 ──────────────────────────────────────────────────────

test('材料充足 → 调 LLM → 写三个 self.* facts,sourceRefs 校验', async () => {
  const { memory, skills, pursuits, actions, outcomes, audit } = mkStores();

  // 塞 5 个 skill
  for (let i = 0; i < 5; i++) {
    skills.createSkill({
      name: `skill-${i}`,
      description: `技能${i}的描述`,
      triggerKeywords: [`kw${i}`],
      actionTemplate: `## 触发\n...\n## 避免\n...\n## 改做\n...`,
      kind: 'positive',
    });
  }
  // 塞 1 个活跃 pursuit
  pursuits.createChild({
    id: 'p-typing',
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: '陪用户搞类型系统',
    intent: '理解 TypeScript 泛型',
    origin: 'extractor',
    stake: 'medium',
  });

  const llmResponse = JSON.stringify({
    summary: '我倾向先查文档再动手,对类型系统敏感。',
    strengths: ['文档优先', '类型敏感'],
    growth_edges: ['架构级设计'],
    source_refs: [
      'skill:skill-0',
      'skill:skill-1',
      'pursuit:p-typing',
      'skill:nonexistent', // 故意一个假的,integrity < 1
    ],
  });

  const reflector = new SelfReflector(
    mkLlm(llmResponse),
    memory,
    skills,
    pursuits,
    actions,
    outcomes,
    { auditHook: audit },
  );
  const r = await reflector.reflect();

  assert.equal(r.updated, true);
  assert.ok(r.summary.includes('类型系统'));
  assert.deepEqual(r.strengths, ['文档优先', '类型敏感']);
  assert.deepEqual(r.growthEdges, ['架构级设计']);
  // 3/4 真实 → 0.75
  assert.ok(r.sourceIntegrity >= 0.7 && r.sourceIntegrity <= 0.8);

  // 三条 fact 都落盘
  assert.ok(memory.getFact('self', 'summary'));
  assert.ok(memory.getFact('self', 'strengths'));
  assert.ok(memory.getFact('self', 'growth_edges'));

  // audit 有 success 事件
  const ok = audit.events.find(
    (e) => e.data.source === 'self-reflector' && e.data.mode === 'success',
  );
  assert.ok(ok);
});

// ── LLM 失败 / parse 失败 ────────────────────────────────────────────

test('LLM 返回无效 JSON → updated=false,self.* 不写', async () => {
  const { memory, skills, pursuits, actions, outcomes, audit } = mkStores();
  for (let i = 0; i < 3; i++) {
    skills.createSkill({
      name: `s${i}`,
      description: `d${i}`,
      triggerKeywords: [],
      actionTemplate: `## 触发\n\n## 避免\n\n## 改做\n`,
      kind: 'positive',
    });
  }
  const reflector = new SelfReflector(
    mkLlm('this is not json at all'),
    memory,
    skills,
    pursuits,
    actions,
    outcomes,
    { auditHook: audit },
  );
  const r = await reflector.reflect();
  assert.equal(r.updated, false);
  assert.equal(memory.getFact('self', 'summary'), null);
  const parseErr = audit.events.find(
    (e) => e.data.mode === 'parse_error',
  );
  assert.ok(parseErr);
});

test('LLM throw → updated=false,audit 记 llm_error', async () => {
  const { memory, skills, pursuits, actions, outcomes, audit } = mkStores();
  for (let i = 0; i < 3; i++) {
    skills.createSkill({
      name: `s${i}`,
      description: `d${i}`,
      triggerKeywords: [],
      actionTemplate: `## 触发\n\n## 避免\n\n## 改做\n`,
      kind: 'positive',
    });
  }
  const llm: ExtractorLlmClient = {
    async complete() {
      throw new Error('boom');
    },
  };
  const reflector = new SelfReflector(
    llm,
    memory,
    skills,
    pursuits,
    actions,
    outcomes,
    { auditHook: audit },
  );
  const r = await reflector.reflect();
  assert.equal(r.updated, false);
  const err = audit.events.find((e) => e.data.mode === 'llm_error');
  assert.ok(err);
});

// ── supersede ───────────────────────────────────────────────────────────

test('多次 reflect → 新 summary supersede 旧的', async () => {
  const { memory, skills, pursuits, actions, outcomes } = mkStores();
  for (let i = 0; i < 3; i++) {
    skills.createSkill({
      name: `s${i}`,
      description: `d${i}`,
      triggerKeywords: [],
      actionTemplate: `## 触发\n\n## 避免\n\n## 改做\n`,
      kind: 'positive',
    });
  }

  const responses = [
    JSON.stringify({
      summary: '第一次:我还在摸索。',
      strengths: [],
      growth_edges: [],
      source_refs: [],
    }),
    JSON.stringify({
      summary: '第二次:我更清楚自己的偏好了。',
      strengths: [],
      growth_edges: [],
      source_refs: [],
    }),
  ];
  let i = 0;
  const llm: ExtractorLlmClient = {
    async complete() {
      return { text: responses[i++], tokensUsed: 10 };
    },
  };

  const reflector = new SelfReflector(
    llm,
    memory,
    skills,
    pursuits,
    actions,
    outcomes,
  );
  await reflector.reflect();
  await reflector.reflect();

  const current = memory.getFact('self', 'summary');
  assert.ok(current);
  assert.ok(
    ((current!.value as SelfFactValue).content as string).includes('第二次'),
  );

  // 历史存在
  const history = memory.getFactHistory('self', 'summary');
  assert.equal(history.length, 2);
});

// ── prompt fence 容忍 ───────────────────────────────────────────────

test('LLM 返回带 ```json fence 的 JSON → 能正确 parse', async () => {
  const { memory, skills, pursuits, actions, outcomes } = mkStores();
  for (let i = 0; i < 3; i++) {
    skills.createSkill({
      name: `s${i}`,
      description: `d${i}`,
      triggerKeywords: [],
      actionTemplate: `## 触发\n\n## 避免\n\n## 改做\n`,
      kind: 'positive',
    });
  }
  const fenced =
    '```json\n' +
    JSON.stringify({
      summary: 'fenced 输出也能 parse。',
      strengths: [],
      growth_edges: [],
      source_refs: [],
    }) +
    '\n```';
  const reflector = new SelfReflector(
    mkLlm(fenced),
    memory,
    skills,
    pursuits,
    actions,
    outcomes,
  );
  const r = await reflector.reflect();
  assert.equal(r.updated, true);
  assert.ok(r.summary.includes('fenced'));
});
