/**
 * repairToolResultPairing 单测 —— tool_use ↔ tool_result 配对修复(安全网)。
 *
 * 背景(2026-05-31 生产 bug):DeepSeek(OpenAI-compat)长 turn + 授权挂起会留下
 * 悬空 tool_use(assistant 有 tool_use,下一条没补全部 tool_result)→ API 400
 * "tool_use ids were found without tool_result blocks immediately after"。
 * 该函数发请求前补占位 tool_result。此前只接在 Anthropic 适配器,漏接 OpenAI-compat
 * (DeepSeek 走的那条)→ 悬空原样发出。修复后两条路径都接。
 *
 * 这里测安全网本身保证的 API 不变量:每条 assistant 的 tool_use id,在**紧邻下一条**
 * user 消息里都有对应 tool_result。anthropicToOpenAI 是 1:1 忠实映射,native 配对成立
 * → 转出的 OpenAI 序列也配对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairToolResultPairing } from '../src/llm-adapter.js';
import type { NativeMessage } from '../src/llm-adapter.js';

type Block = { type: string; [k: string]: unknown };

function toolUse(id: string, name = 'shell'): Block {
  return { type: 'tool_use', id, name, input: {} };
}
function toolResult(id: string): Block {
  return { type: 'tool_result', tool_use_id: id, content: 'ok' };
}

/** API 不变量:每条 assistant 的 tool_use id 在紧邻下条 user 里有 tool_result。 */
function assertPaired(msgs: NativeMessage[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const useIds = (m.content as Block[]).filter((b) => b.type === 'tool_use').map((b) => b.id as string);
    if (useIds.length === 0) continue;
    const next = msgs[i + 1];
    const haveIds = new Set<string>();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content as Block[]) {
        if (b.type === 'tool_result') haveIds.add(b.tool_use_id as string);
      }
    }
    for (const id of useIds) {
      assert.ok(haveIds.has(id), `tool_use ${id} 在 assistant[${i}] 缺紧邻 tool_result`);
    }
  }
}

test('悬空单 tool_use(下条无 tool_result)→ 补占位,不变量成立', () => {
  const msgs: NativeMessage[] = [
    { role: 'user', content: '算一下' },
    { role: 'assistant', content: [toolUse('call_00_A')] as never },
    // 下一条本该是 tool_result,但被授权挂起截断 → 这里是个普通 user(或缺失)
    { role: 'user', content: '继续' },
  ];
  const out = repairToolResultPairing(msgs);
  assertPaired(out);
});

test('多 tool_use 部分结果(auth-pause 拆分场景)→ 只补缺的那个', () => {
  // 一条 assistant 有 3 个 tool_use,下条只补了前 2 个(第 3 个被 deny/挂起漏补)
  const msgs: NativeMessage[] = [
    { role: 'assistant', content: [toolUse('call_00_A'), toolUse('call_00_B'), toolUse('call_00_C')] as never },
    { role: 'user', content: [toolResult('call_00_A'), toolResult('call_00_B')] as never },
  ];
  const out = repairToolResultPairing(msgs);
  assertPaired(out);
  // 仍保留原有的 A/B 结果(不丢)
  const next = out[1];
  const ids = (next.content as Block[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  assert.ok(ids.includes('call_00_A') && ids.includes('call_00_B') && ids.includes('call_00_C'));
});

test('已配对 → 原样不动(不重复补占位)', () => {
  const msgs: NativeMessage[] = [
    { role: 'assistant', content: [toolUse('call_00_A')] as never },
    { role: 'user', content: [toolResult('call_00_A')] as never },
  ];
  const out = repairToolResultPairing(msgs);
  assertPaired(out);
  const ids = (out[1].content as Block[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  assert.deepEqual(ids, ['call_00_A']); // 没多补
});

test('tool_result 错位在远处 → 归位到紧邻下条(这正是生产 400 的修复)', () => {
  // call_00_A 的结果错位到了更后面(resume 拼乱);旧版不搬运 → 留悬空 → 400。
  // 新版:把它归位到 assistant 紧邻下条,且远处那份不再残留(避免孤儿)。
  const msgs: NativeMessage[] = [
    { role: 'assistant', content: [toolUse('call_00_A')] as never },
    { role: 'user', content: [toolResult('call_00_A')] as never }, // 错位:本该紧邻,但…
    { role: 'assistant', content: '中间插了段回复' },
  ];
  // 构造一个真正错位的版本:result 在更后面、assistant 紧邻下条是别的
  const misplaced: NativeMessage[] = [
    { role: 'assistant', content: [toolUse('call_00_A')] as never },
    { role: 'assistant', content: '插话(本不该出现在这,但模拟拼乱)' as never },
    { role: 'user', content: [toolResult('call_00_A')] as never },
  ];
  const out = repairToolResultPairing(misplaced);
  assertPaired(out); // 不变量必须成立
  // A 的 result 已归位到 assistant[0] 紧邻下条
  const next = out[1];
  assert.ok(
    next.role === 'user' && Array.isArray(next.content) &&
      (next.content as Block[]).some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_00_A'),
  );
  // 全数组里 call_00_A 的 tool_result 只剩一份(无孤儿)
  let count = 0;
  for (const m of out) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as Block[]) if (b.type === 'tool_result' && b.tool_use_id === 'call_00_A') count++;
    }
  }
  assert.equal(count, 1);
  void msgs;
});

test('孤儿 tool_result(无对应 tool_use)→ 丢弃(否则也 400)', () => {
  const msgs: NativeMessage[] = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: [toolResult('call_00_ORPHAN')] as never }, // 没有任何 tool_use 对应
  ];
  const out = repairToolResultPairing(msgs);
  assertPaired(out);
  // 孤儿被丢弃,不残留
  for (const m of out) {
    if (Array.isArray(m.content)) {
      assert.ok(!(m.content as Block[]).some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_00_ORPHAN'));
    }
  }
});

test('多 tool_use 顺序归位(部分错位 + 部分缺失)→ 全配齐', () => {
  const msgs: NativeMessage[] = [
    { role: 'assistant', content: [toolUse('call_00_A'), toolUse('call_00_B'), toolUse('call_00_C')] as never },
    { role: 'user', content: [toolResult('call_00_B')] as never }, // 只有 B,A 错位、C 缺失
    { role: 'user', content: [toolResult('call_00_A')] as never }, // A 错位在更后
  ];
  const out = repairToolResultPairing(msgs);
  assertPaired(out);
  const next = out[1];
  const ids = (next.content as Block[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  assert.deepEqual([...ids].sort(), ['call_00_A', 'call_00_B', 'call_00_C']);
});

test('普通文本 user 消息原样保留', () => {
  const msgs: NativeMessage[] = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好,有什么可以帮你' },
    { role: 'user', content: '再问一个' },
  ];
  const out = repairToolResultPairing(msgs);
  assert.equal(out.length, 3);
  assert.equal(out[0].content, '你好');
  assert.equal(out[2].content, '再问一个');
});
