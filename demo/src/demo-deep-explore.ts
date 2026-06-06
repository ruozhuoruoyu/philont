/**
 * Demo:深度推理子系统(隔离 / turn 内可续 / 推理状态持久化)。
 *
 * 跑法:  cd demo && npx tsx src/demo-deep-explore.ts
 *
 * 确定性走完整条回路(mock miniLoopLLM 脚本化推理动作,不烧真 LLM):
 *   1. deep_explore(start, goal)  → 建会话+根 → 子 LLM decompose 出 2 个子目标、证 1 个
 *   2. (模拟下个 turn)deep_explore(continue) → 读回树 → 证另一个、根标 proved → 收敛 solved
 *   3. 验证:树跨"turn"持久、approaches_tried 回溯记忆、后置收敛判定、跨 turn 续。
 *
 * 边界(诚实):这套是**脚手架 + 推理状态持久化**;真实里推理质量靠 LLM 本身。
 * 价值是让推理可累积/可回溯/可续,不是"会自动证明猜想"。
 */
import { openMemoryDb } from '@agent/memory';
import { createDeepExploreTool } from '../../server/src/deep_explore.js';
import type {
  MiniLoopLLMClient,
  MiniLoopLLMResponse,
  MiniLoopMessage,
} from '@agent/tools';

// ── 脚本化 mock 子 LLM:按"这是第几轮 + 看到什么 tool_result"决定下一步动作 ──────
// 每次 send 返回一个 toolCall(或最终 text)。用一个全局步进器驱动确定性剧本。
function makeScriptedLLM(): { llm: MiniLoopLLMClient; reset: () => void } {
  let step = 0;
  // 记录 decompose 返回的真实子节点 id(从 tool_result 文本里抠,模拟真 LLM 读回显)
  let lastChildIds: string[] = [];

  function harvestIds(messages: MiniLoopMessage[]): void {
    // 找最近一条 tool_result,抠出 [uuid] 形式的 id
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if ((block as { type?: string }).type === 'tool_result') {
          const text = String((block as { content?: unknown }).content ?? '');
          const ids = [...text.matchAll(/\[([0-9a-f-]{36})\]/g)].map((mm) => mm[1]);
          // 只捕获 decompose 结果(≥2 个 id),别被单 id 的 record 结果覆盖子节点表
          if (ids.length >= 2) { lastChildIds = ids; return; }
        }
      }
    }
  }

  const llm: MiniLoopLLMClient = {
    async send(_systemPrompt, messages): Promise<MiniLoopLLMResponse> {
      harvestIds(messages);
      step += 1;
      const tc = (name: string, input: Record<string, unknown>): MiniLoopLLMResponse => ({
        type: 'toolCalls',
        calls: [{ id: `call-${step}`, name, input }],
        assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: `call-${step}`, name, input }] },
        tokensUsed: 100,
      });

      // systemPrompt 里渲染了根节点 id,但 mock 不解析它;第一轮 decompose 用 "ROOT" 占位?
      // 真实里 LLM 从 systemPrompt 读 root id。这里简化:第一轮 systemPrompt 含 [root-id],
      // 我们从 systemPrompt 抠根 id。
      const rootMatch = _systemPrompt.match(/\[([0-9a-f-]{36})\]/);
      const rootId = rootMatch ? rootMatch[1] : 'ROOT';

      switch (step) {
        case 1: // 分解根 → 2 子目标
          return tc('reason_decompose', {
            parentNodeId: rootId,
            subClaims: [
              { claim: '子目标 A:基例成立', kind: 'subgoal' },
              { claim: '子目标 B:归纳步成立', kind: 'subgoal' },
            ],
          });
        case 2: // 证子目标 A(用回显的第一个子 id)
          return tc('reason_record', { nodeId: lastChildIds[0], status: 'proved', result: '直接验证基例' });
        case 3: // 第一轮收尾(文字),A 已证、B 仍 open
          return { type: 'text', content: '本轮证了基例,归纳步留待下轮。', tokensUsed: 50 };
        case 4: // continue 第二轮:先试一条死路标 dead_end(回溯记忆)
          return tc('reason_record', { nodeId: lastBopen(messages), status: 'dead_end', approach: '试了强归纳但绕不开 B' });
        default:
          return { type: 'text', content: '（兜底)', tokensUsed: 10 };
      }
    },
  };
  // 第二轮需要拿到 B 的 id —— 从 continue 的 systemPrompt frontier 里抠(简化:复用 lastChildIds[1])
  function lastBopen(_messages: MiniLoopMessage[]): string {
    return lastChildIds[1] ?? 'B';
  }
  return { llm, reset: () => { step = 0; lastChildIds = []; } };
}

async function main(): Promise<void> {
  console.log('\n=== 深度推理子系统验证 ===\n');
  const mem = openMemoryDb(':memory:');
  const { llm } = makeScriptedLLM();

  const noResearch = async () => ({ ok: false, output: '', error: '本 demo 不接研究工具' });
  const tool = createDeepExploreTool({
    reasoning: mem.reasoning,
    miniLoopLLM: llm,
    subTurnToolRunner: noResearch,
    readOnlyToolDefs: [],
    maxIters: 6,
  });

  // ── turn 1:start ────────────────────────────────────────────────────────
  const r1 = await tool.execute({ action: 'start', goal: '对所有 n≥0,P(n) 成立', assumptions: ['P 是某谓词'] });
  console.log('Turn 1  deep_explore(start) →\n  ' + r1.output.replace(/\n/g, '\n  '));
  const sid = mem.reasoning.listActiveSessions()[0]!.id; // 捕获会话 id(收敛后按 id 读)
  const nodes1 = mem.reasoning.getNodes(sid);
  console.log(`        树:${nodes1.length} 节点;已证 ${nodes1.filter((n) => n.status === 'proved').length}`);

  // ── prefix 注入(下个 turn 主 LLM 会看到)──────────────────────────────────
  const { buildReasoningProgressSection } = await import('../../server/src/autonomous_progress_inject.js');
  console.log('\n下个 turn prefix 注入:\n' + buildReasoningProgressSection(mem.reasoning).split('\n').map((l) => '  ' + l).join('\n'));

  // ── turn 2:continue(跨 turn 续,树持久)─────────────────────────────────
  const r2 = await tool.execute({ action: 'continue' });
  console.log('\nTurn 2  deep_explore(continue) →\n  ' + r2.output.replace(/\n/g, '\n  '));

  const all = mem.reasoning.getNodes(sid); // 按捕获的 id 读(会话可能已收敛为 stuck)
  const deadEnds = all.filter((n) => n.status === 'dead_end');
  console.log('\n结果:');
  console.log(`  - 树持久跨 turn:${all.length} 个节点;会话状态 ${mem.reasoning.getSession(sid)!.status}`);
  console.log(`  - 已证 ${all.filter((n) => n.status === 'proved').length} / 死胡同 ${deadEnds.length}`);
  if (deadEnds.length) console.log(`  - 回溯记忆(approaches_tried):${deadEnds[0].approachesTried.join(' / ')}`);
  console.log('\n=== 验证结束:start 分解推进 → 跨 turn continue 续 → 树+死胡同持久 ===\n');
  mem.close();
}

void main();
