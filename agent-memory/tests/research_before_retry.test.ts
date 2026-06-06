import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_TOOLS,
  isResearchTool,
  hasResearchCallInTurn,
  buildResearchReminder,
} from '../src/research_before_retry.js';

// ── isResearchTool ────────────────────────────────────────────────

test('isResearchTool: 文件读类工具 → true', () => {
  for (const tool of ['readFile', 'inspectPath', 'listDir', 'glob', 'grep']) {
    assert.equal(isResearchTool(tool), true, `${tool} 应该是 research`);
  }
});

test('isResearchTool: 网络读类 → true', () => {
  assert.equal(isResearchTool('webFetch'), true);
  assert.equal(isResearchTool('webSearch'), true);
});

test('isResearchTool: 记忆/skill 检索 → true', () => {
  for (const tool of ['get_fact', 'list_facts', 'search_notes', 'search_skills', 'recall_sessions']) {
    assert.equal(isResearchTool(tool), true);
  }
});

test('isResearchTool: 业务工具 → false', () => {
  for (const tool of ['http', 'shell', 'writeFile', 'saveCredential', 'store_fact']) {
    assert.equal(isResearchTool(tool), false, `${tool} 不应该是 research`);
  }
});

test('isResearchTool: plan 协议工具 → false(不算 research)', () => {
  assert.equal(isResearchTool('plan_draft'), false);
  assert.equal(isResearchTool('plan_review'), false);
  assert.equal(isResearchTool('task_mode_classify'), false);
});

test('isResearchTool: env PHILONT_RESEARCH_BEFORE_RETRY_TOOLS 可覆盖默认集合', () => {
  const orig = process.env.PHILONT_RESEARCH_BEFORE_RETRY_TOOLS;
  process.env.PHILONT_RESEARCH_BEFORE_RETRY_TOOLS = 'custom_tool,readFile';
  try {
    assert.equal(isResearchTool('custom_tool'), true);
    assert.equal(isResearchTool('readFile'), true);
    // 默认集合的工具但不在 env override 列表 → 现在不算
    assert.equal(isResearchTool('webFetch'), false);
  } finally {
    if (orig === undefined) delete process.env.PHILONT_RESEARCH_BEFORE_RETRY_TOOLS;
    else process.env.PHILONT_RESEARCH_BEFORE_RETRY_TOOLS = orig;
  }
});

// ── hasResearchCallInTurn ─────────────────────────────────────────

test('hasResearchCallInTurn: 空数组 → false', () => {
  assert.equal(hasResearchCallInTurn([]), false);
});

test('hasResearchCallInTurn: 只业务工具 → false', () => {
  const records = [
    { toolName: 'http' },
    { toolName: 'shell' },
    { toolName: 'writeFile' },
  ];
  assert.equal(hasResearchCallInTurn(records), false);
});

test('hasResearchCallInTurn: 含一次 readFile → true', () => {
  const records = [
    { toolName: 'http' },
    { toolName: 'readFile' },
    { toolName: 'http' },
  ];
  assert.equal(hasResearchCallInTurn(records), true);
});

test('hasResearchCallInTurn: 含 webFetch → true', () => {
  assert.equal(
    hasResearchCallInTurn([{ toolName: 'webFetch' }]),
    true,
  );
});

// ── buildResearchReminder ─────────────────────────────────────────

test('buildResearchReminder: 含所有关键引导词', () => {
  const text = buildResearchReminder('http', 'http:http-404', 'http');
  assert.match(text, /ResearchBeforeRetry/);
  assert.match(text, /http/);
  assert.match(text, /http-404/);
  assert.match(text, /Already-fetched resources/);
  assert.match(text, /Historical success paths/);
  assert.match(text, /Ready-made solutions/);
  assert.match(text, /webFetch/);
  assert.match(text, /Prohibited/);
  assert.match(text, /Guessing/);
});

test('buildResearchReminder: 失败工具 / 尝试工具不同 → 都在文本里', () => {
  const text = buildResearchReminder('webFetch', 'webFetch:timeout', 'http');
  assert.match(text, /webFetch/);
  assert.match(text, /http/); // attempted tool
  assert.match(text, /timeout/);
});

// ── RESEARCH_TOOLS 集合不变量 ──────────────────────────────────────

test('RESEARCH_TOOLS: 至少含 12 个核心工具', () => {
  assert.ok(RESEARCH_TOOLS.size >= 12);
});

test('RESEARCH_TOOLS: 含所有文件读 + 网络读 + 记忆检索类', () => {
  const required = [
    'readFile',
    'inspectPath',
    'listDir',
    'glob',
    'grep',
    'webFetch',
    'webSearch',
    'get_fact',
    'list_facts',
    'search_notes',
    'search_skills',
    'recall_sessions',
  ];
  for (const t of required) {
    assert.ok(RESEARCH_TOOLS.has(t), `RESEARCH_TOOLS 必须含 ${t}`);
  }
});

test('RESEARCH_TOOLS: 不含业务工具', () => {
  const forbidden = ['http', 'shell', 'writeFile', 'saveCredential', 'store_fact'];
  for (const t of forbidden) {
    assert.ok(!RESEARCH_TOOLS.has(t), `RESEARCH_TOOLS 不该含 ${t}`);
  }
});

test('RESEARCH_TOOLS: 不含 plan 协议工具', () => {
  for (const t of ['plan_draft', 'plan_review', 'plan_revise', 'plan_close', 'task_mode_classify']) {
    assert.ok(!RESEARCH_TOOLS.has(t), `RESEARCH_TOOLS 不该含 ${t}`);
  }
});
