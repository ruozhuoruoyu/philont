/**
 * detectInTurnFailurePattern 单测。
 *
 * 通用机制 — 同根因失败 ≥ 3 次触发反思,适用任何 tool / service / skill。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectInTurnFailurePattern,
  type InTurnToolRecord,
} from '../src/in_turn_reflection.js';

function http401(): InTurnToolRecord {
  return {
    toolName: 'http',
    success: false,
    resultText: 'HTTP 401 POST https://api.example.com/x\nResponse body: Unauthorized',
  };
}

function httpSuccess(): InTurnToolRecord {
  return { toolName: 'http', success: true, resultText: '{"ok":true}' };
}

function shellCmdNotFound(cmd: string): InTurnToolRecord {
  return {
    toolName: 'shell',
    success: false,
    resultText: `command not found: ${cmd}`,
  };
}

// ── 基本路径 ──────────────────────────────────────────────────────────

test('空 records → 不触发', () => {
  const r = detectInTurnFailurePattern([]);
  assert.equal(r.triggered, false);
});

test('全成功 → 不触发', () => {
  const r = detectInTurnFailurePattern([httpSuccess(), httpSuccess(), httpSuccess()]);
  assert.equal(r.triggered, false);
});

test('1 个失败 → 不触发(< 默认阈值 2)', () => {
  const r = detectInTurnFailurePattern([http401()]);
  assert.equal(r.triggered, false);
});

test('2 个同 signature 失败 → 触发(默认阈值 2,"第一次重复"即介入)', () => {
  const r = detectInTurnFailurePattern([http401(), http401()]);
  assert.equal(r.triggered, true);
  assert.equal(r.count, 2);
});

test('3 个同 signature 失败 → 仍触发,count=3', () => {
  const r = detectInTurnFailurePattern([http401(), http401(), http401()]);
  assert.equal(r.triggered, true);
  assert.equal(r.count, 3);
  assert.match(r.signature ?? '', /http:http-401/);
  assert.match(r.reminder ?? '', /反思/);
  assert.match(r.reminder ?? '', /search_skills/);
  assert.match(r.reminder ?? '', /use_skill/);
  assert.match(r.reminder ?? '', /store_note/);
});

test('混合 - 3 个同根因失败 + 1 成功 + 1 不同 → 仍触发', () => {
  const r = detectInTurnFailurePattern([
    http401(),
    httpSuccess(),
    http401(),
    shellCmdNotFound('rg'),
    http401(),
  ]);
  assert.equal(r.triggered, true);
  assert.equal(r.count, 3);
});

test('多种失败但每种各 1 → 不触发(默认阈值 2)', () => {
  const r = detectInTurnFailurePattern([
    http401(),
    shellCmdNotFound('rg'),
  ]);
  assert.equal(r.triggered, false);
});

test('两种 root cause 都 ≥ 2 → 取最大组', () => {
  const r = detectInTurnFailurePattern([
    http401(), http401(),  // count=2
    shellCmdNotFound('jq'),
    shellCmdNotFound('jq'),
    shellCmdNotFound('jq'),  // count=3 (这个 max)
  ]);
  assert.equal(r.triggered, true);
  assert.equal(r.count, 3);
  assert.match(r.signature ?? '', /shell:cmd-not-found:jq/);
});

// ── 阈值可调 ─────────────────────────────────────────────────────────

test('threshold=1 时 1 个失败就触发(显式覆盖默认 2)', () => {
  const r = detectInTurnFailurePattern([http401()], 1);
  assert.equal(r.triggered, true);
});

test('threshold=5 时 4 个失败不触发', () => {
  const r = detectInTurnFailurePattern(
    [http401(), http401(), http401(), http401()],
    5,
  );
  assert.equal(r.triggered, false);
});

// ── 不同 toolName / 不同 errorClass 不算同 root cause ──────────────────

test('不同 tool 的同类错误不串签', () => {
  // shell:cmd-not-found:rg vs http:cmd-not-found:rg(实际不会有但测分组)
  // 两个不同 toolName 的 records,即便都"command not found",signature 不同
  const r = detectInTurnFailurePattern([
    shellCmdNotFound('rg'),
    {
      toolName: 'http',
      success: false,
      resultText: 'command not found: rg',
    },
  ]);
  // shell 1 次 + http 1 次,都 < 2,不触发
  assert.equal(r.triggered, false);
});

test('同 tool 不同 cmd → 不算同 signature(各 1 次都 < 2)', () => {
  const r = detectInTurnFailurePattern([
    shellCmdNotFound('rg'),
    shellCmdNotFound('jq'),
  ]);
  // rg 1 次 + jq 1 次,都 < 2,不触发
  assert.equal(r.triggered, false);
});

test('同 tool 同 cmd 2 次 → 触发(默认阈值 2)', () => {
  const r = detectInTurnFailurePattern([
    shellCmdNotFound('rg'),
    shellCmdNotFound('rg'),
  ]);
  assert.equal(r.triggered, true);
  assert.equal(r.count, 2);
});

// ── 文本完整性 ───────────────────────────────────────────────────────

test('reminder 文案含三选一指引', () => {
  const r = detectInTurnFailurePattern([http401(), http401()]);
  assert.equal(r.triggered, true);
  // search_skills / use_skill / store_note
  assert.match(r.reminder ?? '', /search_skills/);
  assert.match(r.reminder ?? '', /use_skill/);
  assert.match(r.reminder ?? '', /store_note/);
  // 收尾本 turn
  assert.match(r.reminder ?? '', /收尾/);
  // 一次性提醒(防 LLM 期待重复)
  assert.match(r.reminder ?? '', /只触发一次/);
});

test('reminder 文案不含 service / skill 具体名(通用机制)', () => {
  const r = detectInTurnFailurePattern([http401(), http401()]);
  assert.equal(r.triggered, true);
  // 不该绑特定 service
  assert.ok(!/(mycox|slack|github|openai)/i.test(r.reminder ?? ''));
});

// ── Fix A(2026-05-26):机制层主动拒不计入"同根因失败" ────────────────────
// 实测:plan_protocol_gate / in_turn_tool_block /
// autonomous_blacklist / research_before_retry 这些拒被算 failure 计入,
// 2 次就触发 in-turn-reflection 锁工具,self-defeating。修复后这类签名
// 跳过计数,只有真"撞墙"(http 401 / shell killed timeout / cmd-not-found)
// 才参与触发。

function mechReject(toolName: string, gate: string): InTurnToolRecord {
  return {
    toolName,
    success: false,
    resultText: `[${gate}] slow 模式下尚未调 plan_draft 拆解任务。\n本工具 ${toolName} 已被机制层禁用...`,
  };
}

test('plan_protocol_gate 拒 × 2 不触发(机制层拒不计数)', () => {
  const records: InTurnToolRecord[] = [
    mechReject('shell', 'plan_protocol_gate'),
    mechReject('shell', 'plan_protocol_gate'),
  ];
  const r = detectInTurnFailurePattern(records);
  assert.equal(r.triggered, false, '机制层主动拒不应触发 in-turn-reflection');
});

test('in_turn_tool_block 拒 × 3 不触发', () => {
  const records: InTurnToolRecord[] = [
    mechReject('shell', 'in_turn_tool_block'),
    mechReject('shell', 'in_turn_tool_block'),
    mechReject('shell', 'in_turn_tool_block'),
  ];
  const r = detectInTurnFailurePattern(records);
  assert.equal(r.triggered, false);
});

test('autonomous_blacklist 拒不计入', () => {
  const records: InTurnToolRecord[] = [
    mechReject('writeFile', 'autonomous_blacklist'),
    mechReject('writeFile', 'autonomous_blacklist'),
  ];
  const r = detectInTurnFailurePattern(records);
  assert.equal(r.triggered, false);
});

test('research_before_retry 拒不计入(连字符 / 下划线两种形式)', () => {
  const records: InTurnToolRecord[] = [
    mechReject('shell', 'research_before_retry'),
    mechReject('shell', 'research-before-retry'),
  ];
  const r = detectInTurnFailurePattern(records);
  assert.equal(r.triggered, false);
});

test('真撞墙(http 401)× 2 仍触发 — 机制层拒过滤不波及真失败', () => {
  const r = detectInTurnFailurePattern([http401(), http401()]);
  assert.equal(r.triggered, true);
  assert.equal(r.signature, 'http:http-401');
});

test('混合:机制层拒 × 5 + 真失败 × 2 → 仅真失败被计数 触发', () => {
  const records: InTurnToolRecord[] = [
    mechReject('shell', 'plan_protocol_gate'),
    mechReject('shell', 'plan_protocol_gate'),
    mechReject('shell', 'in_turn_tool_block'),
    mechReject('shell', 'autonomous_blacklist'),
    mechReject('shell', 'research_before_retry'),
    shellCmdNotFound('rg'),
    shellCmdNotFound('rg'),
  ];
  const r = detectInTurnFailurePattern(records);
  assert.equal(r.triggered, true);
  assert.match(r.signature ?? '', /shell:cmd-not-found:rg/);
  assert.equal(r.count, 2);
});
