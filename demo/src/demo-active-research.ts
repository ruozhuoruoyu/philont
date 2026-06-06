/**
 * Demo:主动研究回路(v24)—— 接到研究题 → loop 每 tick 推进一问 → 答完自动歇火
 *
 * 跑法:  cd demo && npx tsx src/demo-active-research.ts
 *
 * 演示整条回路(确定性,mock executor 不烧 LLM):
 *   1. research_focus 工具登记一条主动研究 pursuit(3 个问题)
 *   2. 多个 idle tick:PursuitDriver 每 tick 推进**最早一条**未做过的 open question
 *      (不等 staleness,utility 0.9);mock executor 标 questionAnswered=true
 *   3. ProgressWriter 逐条 closeOpenQuestion + 计 iteration
 *   4. 问题全答完 → isActiveResearch 自动清零,loop 停推
 *
 * 边界(诚实):这套是**广度调研 + 归纳**——每问一次浅查、答上即收。它**不做**深度
 * 推理 / 自生子问题 / 形式化验证,所以适合"持续跟踪/调研一个题",不适合"深攻数学猜想"。
 */
import {
  openMemoryDb,
  PursuitDriver,
  applyPursuitProgress,
  createResearchTools,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  type MemorySnapshot,
  type Initiative,
  type InitiativeRunResult,
} from '@agent/memory';

const NOW = Date.parse('2026-06-01T09:00:00Z');

function snap(mem: ReturnType<typeof openMemoryDb>, recentDone: Set<string>): MemorySnapshot {
  return {
    facts: [], routingRules: [], skills: [],
    activePursuits: mem.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID),
    recentTimelineTokens: [], recentDoneTargetRefs: recentDone, now: NOW,
  };
}

async function main(): Promise<void> {
  console.log('\n=== 主动研究回路验证 ===\n');
  const mem = openMemoryDb(':memory:');
  const driver = new PursuitDriver();

  // ── Step 1:用户交代"持续研究 X"→ research_focus 登记 ────────────────
  const [tool] = createResearchTools(mem.pursuits);
  const r = await tool.execute({
    action: 'start',
    title: '研究 SQLite→Postgres 迁移',
    intent: '为多用户并发持续调研迁移方案',
    questions: ['连接池选什么', '数据迁移工具怎么选', '停机窗口怎么压缩'],
  });
  console.log('Step 1  research_focus →', r.output);
  const pid = mem.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID).find((p) => p.isActiveResearch)!.id;

  // ── Step 2-4:模拟 idle tick,每 tick 推一问、答上、收敛 ───────────────
  const recentDone = new Set<string>(); // 模拟 24h dedup 集合(本 demo 不过期)
  for (let tick = 1; tick <= 5; tick++) {
    const proposals = driver.propose(snap(mem, recentDone));
    if (proposals.length === 0) {
      console.log(`Step ${1 + tick}  tick#${tick}: driver 不再产候选 → 研究已收敛,loop 停推 ✓`);
      break;
    }
    const prop = proposals[0];
    const open = mem.pursuits.get(pid)!.openQuestions.filter((q) => q.status === 'open').length;
    console.log(`Step ${1 + tick}  tick#${tick}: 推进 ${prop.targetRef}(utility=${prop.utility},剩 ${open} 个 open）`);

    // mock executor:研究完这条问题、判定答上了
    const init = {
      id: `i${tick}`, kind: prop.kind, driver: prop.driver, targetRef: prop.targetRef,
      rationale: prop.rationale, utility: prop.utility, status: 'done',
    } as unknown as Initiative;
    const res: InitiativeRunResult = {
      status: 'done', outcomeSummary: `tick#${tick} 的发现…`, questionAnswered: true,
      llmTokensSpent: 100, toolCallsSpent: 1,
    };
    applyPursuitProgress(mem.pursuits, init, res);
    recentDone.add(prop.targetRef); // 同问题 24h 内不重戳
  }

  const final = mem.pursuits.get(pid)!;
  console.log(`\n结果:open 问题剩 ${final.openQuestions.filter((q) => q.status === 'open').length} 个,` +
    `已答 ${final.openQuestions.filter((q) => q.status === 'resolved').length} 个,` +
    `research_iterations=${final.researchIterations},isActiveResearch=${final.isActiveResearch}`);
  console.log('\n=== 验证结束:接到研究题 → 逐问推进 → 全答完自动歇火 ===\n');
}

void main();
