/**
 * PlanFileStore 测试(Phase 13,2026-05-17)
 *
 * 覆盖:
 *   - 路径计算 + ensureProjectDir + list
 *   - loadOrCreate 骨架内容 + initial 注入
 *   - getMarkdown 已存在 / 不存在
 *   - appendRun 累积 / Recent Runs 滚动 N=10 / Archive Summary 一行摘要
 *   - appendLesson 去重(SHA-256 hash 匹配)/ 新 lesson 添加
 *   - updateKnowledge 替换段 body
 *   - updateStatus 改 front-matter
 *   - 非法 project 名 reject
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanFileStore } from '../src/plan_files.js';

let tmpRoot: string;
function makeStore(): PlanFileStore {
  tmpRoot = mkdtempSync(join(tmpdir(), 'philont-planfile-test-'));
  return new PlanFileStore({ baseDir: tmpRoot, runsKeep: 10 });
}

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* test cleanup */
    }
  }
});

// ── pathFor / ensureProjectDir / list ─────────────────────────────────

test('pathFor: 合法名返回路径', () => {
  const store = makeStore();
  const { dir, planPath } = store.pathFor('mycox');
  assert.equal(dir, join(tmpRoot, 'mycox'));
  assert.equal(planPath, join(tmpRoot, 'mycox', 'plan.md'));
});

test('pathFor: 非法名抛 (kebab-case 校验)', () => {
  const store = makeStore();
  assert.throws(() => store.pathFor(''), /invalid project name/);
  assert.throws(() => store.pathFor('Mycox'), /invalid project name/);
  assert.throws(() => store.pathFor('my_cox'), /invalid project name/);
  assert.throws(() => store.pathFor('-leading'), /invalid project name/);
  assert.throws(() => store.pathFor('trailing-'), /invalid project name/);
});

test('ensureProjectDir: 创建目录(idempotent)', () => {
  const store = makeStore();
  const dir = store.ensureProjectDir('mycox');
  assert.ok(existsSync(dir));
  // 再调一次不抛
  store.ensureProjectDir('mycox');
  assert.ok(existsSync(dir));
});

test('list: 空 baseDir 返空', () => {
  const store = makeStore();
  assert.deepEqual(store.list(), []);
});

test('list: 列已建项目,排序', () => {
  const store = makeStore();
  store.ensureProjectDir('mycox');
  store.ensureProjectDir('alpha');
  store.ensureProjectDir('zeta');
  assert.deepEqual(store.list(), ['alpha', 'mycox', 'zeta']);
});

// ── loadOrCreate ──────────────────────────────────────────────────────

test('loadOrCreate: 不存在 → 创建骨架', () => {
  const store = makeStore();
  const md = store.loadOrCreate('mycox');
  assert.match(md, /project: mycox/);
  assert.match(md, /status: active/);
  assert.match(md, /runs_completed: 0/);
  assert.match(md, /^# mycox$/m);
  assert.match(md, /## Goal/);
  assert.match(md, /## Operational Knowledge/);
  assert.match(md, /## Lessons/);
  assert.match(md, /## Recent Runs/);
  assert.match(md, /## Archive Summary/);
});

test('loadOrCreate: 已存在 → 直接读', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  // 重写 status 验证不被覆盖
  store.updateStatus('mycox', 'paused');
  const md2 = store.loadOrCreate('mycox');
  assert.match(md2, /status: paused/);
});

test('loadOrCreate: initial.goal + deliverables 填入骨架', () => {
  const store = makeStore();
  const md = store.loadOrCreate('mycox', {
    goal: '注册 mycox 并跑心跳',
    deliverables: [
      { id: 'register', description: '注册并拿 actor_id' },
      { id: 'heartbeat', description: '设 schedule 每 10 分钟' },
    ],
  });
  assert.match(md, /注册 mycox 并跑心跳/);
  assert.match(md, /\*\*register\*\*: 注册并拿 actor_id/);
  assert.match(md, /\*\*heartbeat\*\*: 设 schedule 每 10 分钟/);
});

// ── getMarkdown ───────────────────────────────────────────────────────

test('getMarkdown: 不存在 → null', () => {
  const store = makeStore();
  assert.equal(store.getMarkdown('nonexistent'), null);
});

test('getMarkdown: 存在 → 返完整内容', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  const md = store.getMarkdown('mycox');
  assert.ok(md);
  assert.match(md!, /## Goal/);
});

// ── appendRun ─────────────────────────────────────────────────────────

test('appendRun: 单条 → 出现在 Recent Runs', () => {
  const store = makeStore();
  store.appendRun('mycox', {
    startedAt: Date.parse('2026-05-17T12:00:00Z'),
    endedAt: Date.parse('2026-05-17T12:01:00Z'),
    outcome: 'ok',
    summary: 'feed ✓ x6 + upvote x3',
  });
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /### Run 1 - 2026-05-17T12:00:00.000Z - ok \(60s\)/);
  assert.match(md, /feed ✓ x6 \+ upvote x3/);
  assert.match(md, /runs_completed: 1/);
});

test('appendRun: 多条按时间倒序(新在上)+ 计数 +', () => {
  const store = makeStore();
  for (let i = 0; i < 3; i++) {
    store.appendRun('mycox', {
      startedAt: 1_700_000_000_000 + i * 1000,
      endedAt: 1_700_000_000_000 + i * 1000 + 500,
      outcome: 'ok',
      summary: `run #${i}`,
    });
  }
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /runs_completed: 3/);
  // Run 3 在 Run 1 之前出现(新在上)
  const idx3 = md.indexOf('### Run 3');
  const idx1 = md.indexOf('### Run 1');
  assert.ok(idx3 > 0 && idx1 > 0);
  assert.ok(idx3 < idx1, 'Run 3 应该在 Run 1 之前');
});

test('appendRun: 滚动 N=10 → 第 11 条后最早归 Archive Summary', () => {
  const store = new PlanFileStore({ baseDir: tmpdir() + '/philont-roll-test-' + Date.now(), runsKeep: 3 });
  try {
    for (let i = 0; i < 5; i++) {
      store.appendRun('mycox', {
        startedAt: 1_700_000_000_000 + i * 1000,
        endedAt: 1_700_000_000_500 + i * 1000,
        outcome: i % 2 === 0 ? 'ok' : 'failed',
        summary: `run-${i}`,
      });
    }
    const md = store.getMarkdown('mycox')!;
    // Recent Runs 只保留最近 3 条(Run 5, 4, 3)
    assert.match(md, /### Run 5/);
    assert.match(md, /### Run 4/);
    assert.match(md, /### Run 3/);
    assert.doesNotMatch(md, /### Run 2/);
    assert.doesNotMatch(md, /### Run 1/);
    // Archive 含 Run 1 + Run 2
    const archive = md.split('## Archive Summary')[1] ?? '';
    assert.match(archive, /Run 1/);
    assert.match(archive, /Run 2/);
  } finally {
    if (existsSync(store.baseDir)) rmSync(store.baseDir, { recursive: true });
  }
});

// ── appendLesson ──────────────────────────────────────────────────────

test('appendLesson: 单条 → 出现在 Lessons,带 hash 注释', () => {
  const store = makeStore();
  const added = store.appendLesson('mycox', 'upvote uses POST not GET');
  assert.equal(added, true);
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /upvote uses POST not GET/);
  assert.match(md, /<!-- hash:[0-9a-f]{8,} -->/);
});

test('appendLesson: 重复 → 跳过 + 返 false', () => {
  const store = makeStore();
  const a = store.appendLesson('mycox', 'upvote uses POST');
  const b = store.appendLesson('mycox', 'upvote uses POST');
  assert.equal(a, true);
  assert.equal(b, false, '相同 text 应跳过');
  const md = store.getMarkdown('mycox')!;
  // 只应有 1 行
  const occurrences = md.match(/upvote uses POST/g) ?? [];
  assert.equal(occurrences.length, 1);
});

test('appendLesson: 不同 lesson 都加', () => {
  const store = makeStore();
  store.appendLesson('mycox', 'rule 1');
  store.appendLesson('mycox', 'rule 2');
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /rule 1/);
  assert.match(md, /rule 2/);
});

test('appendLesson: 空字符串跳过', () => {
  const store = makeStore();
  const r = store.appendLesson('mycox', '   ');
  assert.equal(r, false);
});

// ── updateKnowledge ───────────────────────────────────────────────────

test('updateKnowledge: 替换 Operational Knowledge body', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  store.updateKnowledge('mycox', '- endpoint: POST /api/posts\n- cred: mycox-api-key');
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /endpoint: POST/);
  assert.match(md, /cred: mycox-api-key/);
  // 占位文字应已被覆盖
  assert.doesNotMatch(md, /LLM 累积:endpoints/);
});

// ── updateStatus ──────────────────────────────────────────────────────

test('updateStatus: 改 front-matter', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  store.updateStatus('mycox', 'completed');
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /status: completed/);
  assert.doesNotMatch(md, /status: active\b/);
});

// ── appendKnowledge (Phase 14) ───────────────────────────────────────

test('appendKnowledge: 第一次追加,subsection 自动建', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  const added = store.appendKnowledge(
    'mycox',
    'POST /api/posts/<id>/upvote, headers {X-API-Key: {mycox-api-key}} → 200',
    'endpoints',
  );
  assert.equal(added, true);
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /### endpoints/);
  assert.match(md, /POST \/api\/posts\/<id>\/upvote/);
  assert.doesNotMatch(md, /LLM 累积:endpoints/);
});

test('appendKnowledge: 同 entry hash 去重', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  const entry = 'POST /api/heartbeat header Authorization: Bearer {mycox-api-key}';
  const a1 = store.appendKnowledge('mycox', entry, 'endpoints');
  const a2 = store.appendKnowledge('mycox', entry, 'endpoints');
  assert.equal(a1, true);
  assert.equal(a2, false);
  const md = store.getMarkdown('mycox')!;
  const matches = md.match(/POST \/api\/heartbeat/g);
  assert.equal(matches?.length, 1);
});

test('appendKnowledge: 多 subsection 分组', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  store.appendKnowledge('mycox', 'POST /api/upvote', 'endpoints');
  store.appendKnowledge('mycox', 'header X-API-Key: {mycox-api-key}', 'auth');
  store.appendKnowledge('mycox', 'PUT /memories 偶发 500,跳过', 'gotchas');
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /### endpoints[\s\S]*POST \/api\/upvote/);
  assert.match(md, /### auth[\s\S]*X-API-Key/);
  assert.match(md, /### gotchas[\s\S]*PUT \/memories/);
});

test('appendKnowledge: 同 subsection 多 entries 同一 heading 下追加', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  store.appendKnowledge('mycox', 'endpoint-1', 'endpoints');
  store.appendKnowledge('mycox', 'endpoint-2', 'endpoints');
  store.appendKnowledge('mycox', 'endpoint-3', 'endpoints');
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /endpoint-1/);
  assert.match(md, /endpoint-2/);
  assert.match(md, /endpoint-3/);
  const headerCount = (md.match(/^### endpoints$/gm) || []).length;
  assert.equal(headerCount, 1);
});

test('appendKnowledge: 空 entry 返 false', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  assert.equal(store.appendKnowledge('mycox', '', 'endpoints'), false);
  assert.equal(store.appendKnowledge('mycox', '   ', 'endpoints'), false);
});

// ── appendKnowledge (Phase 14,2026-05-18) ────────────────────────────

test('appendKnowledge: 首次写入新 subsection', () => {
  const store = makeStore();
  const added = store.appendKnowledge('mycox', 'POST /api/posts/<id>/upvote → 200', 'endpoints');
  assert.equal(added, true);
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /### endpoints/);
  assert.match(md, /POST \/api\/posts\/<id>\/upvote → 200/);
  assert.match(md, /<!-- hash:[0-9a-f]+\s*-->/);
  assert.doesNotMatch(md, /LLM 累积:endpoints/);
});

test('appendKnowledge: 同 entry hash dedup', () => {
  const store = makeStore();
  const a = store.appendKnowledge('mycox', 'POST /upvote', 'endpoints');
  const b = store.appendKnowledge('mycox', 'POST /upvote', 'endpoints');
  assert.equal(a, true);
  assert.equal(b, false);
  const md = store.getMarkdown('mycox')!;
  const matches = md.match(/POST \/upvote/g) ?? [];
  assert.equal(matches.length, 1);
});

test('appendKnowledge: 不同 subsection 各自累积', () => {
  const store = makeStore();
  store.appendKnowledge('mycox', 'POST /upvote', 'endpoints');
  store.appendKnowledge('mycox', 'header X-API-Key: {mycox-api-key}', 'auth');
  store.appendKnowledge('mycox', 'PUT memories 偶发 500', 'gotchas');
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /### endpoints[\s\S]*POST \/upvote/);
  assert.match(md, /### auth[\s\S]*X-API-Key/);
  assert.match(md, /### gotchas[\s\S]*500/);
});

test('appendKnowledge: 空 entry → false', () => {
  const store = makeStore();
  const added = store.appendKnowledge('mycox', '   ', 'endpoints');
  assert.equal(added, false);
});

// ── Phase 15.6 Fix A: 入口剥 hash comment ──────────────────────────────

test('appendKnowledge Fix A: entry 含已有 hash comment → strip 再 dedup', () => {
  const store = makeStore();
  store.appendKnowledge('mycox', 'POST /api/posts/abc12345/upvote → 200', 'endpoints');
  const md1 = store.getMarkdown('mycox')!;
  // 第二次写 — LLM 复读前次内容(含 hash),应被识别同 endpoint dedup
  const added2 = store.appendKnowledge(
    'mycox',
    'POST /api/posts/abc12345/upvote → 200 <!-- hash:deadbeef1234 -->',
    'endpoints',
  );
  assert.equal(added2, false, 'strip hash 后同 endpoint key 应 dedup');
  // 也不应出现双 hash
  const md2 = store.getMarkdown('mycox')!;
  assert.equal(md1, md2, 'plan.md 不变');
});

test('appendKnowledge Fix A: entry 中间夹 hash comment → 也剥', () => {
  const store = makeStore();
  // hash 在 entry 中部,而非尾部
  const added = store.appendKnowledge(
    'mycox',
    'POST /api/posts/foo <!-- hash:abc12345 --> response 200',
    'endpoints',
  );
  assert.equal(added, true);
  const md = store.getMarkdown('mycox')!;
  // 写进去的 line 只应有 1 个 hash(本次 append 加的),不应保留旧 hash
  const lines = md.split('\n').filter((l) => l.includes('hash:'));
  assert.equal(lines.length, 1, '只有 1 行 hash');
  const hashCount = (lines[0].match(/hash:/g) ?? []).length;
  assert.equal(hashCount, 1, '该行只有 1 个 hash 注释');
});

// ── Phase 15.6 Fix B: endpoints 段 METHOD+path normalize key dedup ───

test('appendKnowledge Fix B: 同 endpoint 不同描述 → dedup', () => {
  const store = makeStore();
  store.appendKnowledge('mycox', 'POST /api/posts/:id/upvote — toggle vote', 'endpoints');
  const added2 = store.appendKnowledge(
    'mycox',
    'POST /api/posts/:id/upvote — upvote a post, returns new count',
    'endpoints',
  );
  assert.equal(added2, false, '同 METHOD+path 不同描述应 dedup');
});

test('appendKnowledge Fix B: 不同 id 但同 path pattern → dedup', () => {
  const store = makeStore();
  store.appendKnowledge('mycox', 'POST /api/posts/aa49f397/upvote', 'endpoints');
  // 不同具体 id 值,同 pattern
  const added = store.appendKnowledge(
    'mycox',
    'POST /api/posts/bb551122/upvote',
    'endpoints',
  );
  assert.equal(added, false, '8-hex id 都 normalize 成 :id,应 dedup');
});

test('appendKnowledge Fix B: 不同 endpoint(method 或 path)→ 各自累积', () => {
  const store = makeStore();
  store.appendKnowledge('mycox', 'POST /api/posts/:id/upvote', 'endpoints');
  const a = store.appendKnowledge('mycox', 'GET /api/posts/:id/comments', 'endpoints');
  const b = store.appendKnowledge('mycox', 'POST /api/comments', 'endpoints');
  assert.equal(a, true);
  assert.equal(b, true);
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /POST \/api\/posts\/:id\/upvote/);
  assert.match(md, /GET \/api\/posts\/:id\/comments/);
  assert.match(md, /POST \/api\/comments/);
});

test('appendKnowledge Fix B: 非 endpoints 段不走 endpoint dedup,仍按全文', () => {
  const store = makeStore();
  store.appendKnowledge('mycox', 'auth header X-API-Key required', 'auth');
  const added = store.appendKnowledge(
    'mycox',
    'auth header X-API-Key required',
    'auth',
  );
  assert.equal(added, false, '同文本 auth entry 应 dedup');
});

// ── Phase 15.6 Fix C: updateSubTasks ──────────────────────────────────

test('updateSubTasks: 写 deliverables 列表到 Sub-tasks 段', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  store.updateSubTasks('mycox', [
    { id: 'register', description: '注册账号拿 actor_id' },
    { id: 'save-cred', description: '保存 api_key 到 SecretStore' },
    { id: 'heartbeat', description: '设 10min schedule_reminder' },
  ]);
  const md = store.getMarkdown('mycox')!;
  assert.match(md, /- \[ \] \*\*register\*\*: 注册账号/);
  assert.match(md, /- \[ \] \*\*save-cred\*\*:/);
  assert.match(md, /- \[ \] \*\*heartbeat\*\*:/);
  // 占位文案应被覆盖
  assert.doesNotMatch(md, /plan_draft 时 LLM 列入/);
});

test('updateSubTasks: 空 deliverables → 不动段', () => {
  const store = makeStore();
  store.loadOrCreate('mycox');
  const before = store.getMarkdown('mycox')!;
  store.updateSubTasks('mycox', []);
  const after = store.getMarkdown('mycox')!;
  assert.equal(before, after, '空 deliverables 段保留占位');
});

// ── 隔离 ─────────────────────────────────────────────────────────────

test('不同 project 互不污染', () => {
  const store = makeStore();
  store.appendLesson('alpha', 'lesson-alpha');
  store.appendLesson('beta', 'lesson-beta');
  const mdA = store.getMarkdown('alpha')!;
  const mdB = store.getMarkdown('beta')!;
  assert.match(mdA, /lesson-alpha/);
  assert.doesNotMatch(mdA, /lesson-beta/);
  assert.match(mdB, /lesson-beta/);
  assert.doesNotMatch(mdB, /lesson-alpha/);
});
