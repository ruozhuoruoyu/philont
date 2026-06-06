/**
 * Demo:主动研究"申请权限"(对话内授权)—— 后台研究遇到需要 gated 工具 → 申请 →
 * 用户在对话里批一个有界审计授权 → 下个 tick 用上它。
 *
 * 跑法:  cd demo && npx tsx src/demo-grant-request.ts
 *
 * 确定性演示整条回路(mock executor / mock grant store,不烧 LLM、不真跑工具):
 *   1. research_focus 登记一条主动研究 pursuit(含 open question)
 *   2. idle tick #1:executor 判定"只读资料不够,要跑 runLean" → 返 needs-grant
 *      → ProgressWriter 把申请记到 question.pendingTool(不算 evidence)
 *   3. 渲染"## 后台研究待批准":列出申请,引导用户调 grant_research_tool
 *   4. 用户调 grant_research_tool → 写一个 execute/system + reason=research:<pid> 的
 *      有界授权(默认 2h TTL)
 *   5. idle tick #2:driver 见 question 有 pendingTool 且已授权 → plan 末尾追加
 *      runLean step、跳过 dedup;executor 跑通、答上 → closeOpenQuestion 清 pendingTool
 *
 * 边界(诚实):params 只能用 question 文本尽力构造(driver 替不了 Lean 写形式化输入);
 * 按需构造工具参数 = 深度推理后续。守住"无监督副作用=0":gated 工具永远要用户显式授权。
 */
import {
  openMemoryDb,
  PursuitDriver,
  applyPursuitProgress,
  createResearchTools,
  DEFAULT_PURSUIT_CONFIG,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  type MemorySnapshot,
  type Initiative,
  type InitiativeRunResult,
  type ResearchGrantSink,
} from '@agent/memory';

const NOW = Date.parse('2026-06-01T09:00:00Z');

/** 极简内存 grant 存储,模拟 GrantStore 的 grant/isGranted(本 demo 不计 TTL 过期)。 */
function makeGrants(): ResearchGrantSink & { isGranted: (t: string) => boolean } {
  const granted = new Set<string>();
  return {
    grant(spec) { granted.add(spec.toolName); },
    isGranted(t) { return granted.has(t); },
  };
}

function snap(mem: ReturnType<typeof openMemoryDb>, recentDone: Set<string>): MemorySnapshot {
  return {
    facts: [], routingRules: [], skills: [],
    activePursuits: mem.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID),
    recentTimelineTokens: [], recentDoneTargetRefs: recentDone, now: NOW,
  };
}

async function main(): Promise<void> {
  console.log('\n=== 主动研究"申请权限"回路验证 ===\n');
  const mem = openMemoryDb(':memory:');
  const grants = makeGrants();
  const driver = new PursuitDriver(DEFAULT_PURSUIT_CONFIG, (t) => grants.isGranted(t));
  const [researchFocus, grantTool] = createResearchTools(mem.pursuits, grants);

  // ── Step 1:登记主动研究 ──────────────────────────────────────────────
  await researchFocus.execute({
    action: 'start',
    title: '研究猜想 X',
    intent: '深研究猜想 X 是否成立',
    questions: ['猜想 X 在 n≤100 时是否有反例'],
  });
  const pid = mem.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID).find((p) => p.isActiveResearch)!.id;
  const qid = mem.pursuits.get(pid)!.openQuestions[0].id;
  console.log(`Step 1  research_focus 登记研究 pursuit=${pid}`);

  const recentDone = new Set<string>();

  // ── Step 2:tick #1 → executor 申请 runLean(未授权)──────────────────
  const p1 = driver.propose(snap(mem, recentDone))[0];
  console.log(`Step 2  tick#1 推进 ${p1.targetRef};plan 工具=[${p1.plan!.map((s) => s.tool).join(', ')}]`);
  const init1 = {
    id: 'i1', kind: p1.kind, driver: p1.driver, targetRef: p1.targetRef,
    rationale: p1.rationale, utility: p1.utility, status: 'done',
  } as unknown as Initiative;
  const res1: InitiativeRunResult = {
    status: 'done', needsGrant: true,
    requestedTool: { tool: 'runLean', why: '形式化验证这步推导' },
    outcomeSummary: '[needs-grant] 只读资料不足,需要跑 runLean',
    llmTokensSpent: 80, toolCallsSpent: 1,
  };
  applyPursuitProgress(mem.pursuits, init1, res1);
  recentDone.add(p1.targetRef); // needs-grant 也落 done,进 24h dedup
  const pending = mem.pursuits.get(pid)!.openQuestions[0].pendingTool;
  console.log(`        → ProgressWriter 记 pendingTool=${JSON.stringify(pending)}(未算 evidence)`);

  // ── Step 3:渲染待批准段(数据源 = openQuestions[].pendingTool)─────────
  const pendingLines = mem.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID)
    .filter((p) => p.isActiveResearch)
    .flatMap((p) => p.openQuestions
      .filter((q) => q.status === 'open' && q.pendingTool)
      .map((q) => `- 研究「${p.title}」需要用 \`${q.pendingTool!.tool}\` 来${q.pendingTool!.why} ` +
        `— 批准请调 grant_research_tool({ pursuitId: "${p.id}", tool: "${q.pendingTool!.tool}" })`));
  console.log('Step 3  ## 后台研究待批准\n' + pendingLines.map((l) => '        ' + l).join('\n'));

  // ── Step 4:用户在对话里批准 ──────────────────────────────────────────
  const g = await grantTool.execute({ pursuitId: pid, tool: 'runLean' });
  console.log(`Step 4  用户 grant_research_tool → ${g.output}`);
  console.log(`        isGranted(runLean)=${grants.isGranted('runLean')}`);

  // ── Step 5:tick #2 → driver replay(plan 追加 runLean、跳 dedup),跑通收敛 ──
  const p2 = driver.propose(snap(mem, recentDone))[0];
  console.log(`Step 5  tick#2 replay ${p2.targetRef};plan 工具=[${p2.plan!.map((s) => s.tool).join(', ')}]`);
  const usedLean = p2.plan!.some((s) => s.tool === 'runLean');
  const init2 = {
    id: 'i2', kind: p2.kind, driver: p2.driver, targetRef: p2.targetRef,
    rationale: p2.rationale, utility: p2.utility, status: 'done',
  } as unknown as Initiative;
  const res2: InitiativeRunResult = {
    status: 'done', questionAnswered: true,
    outcomeSummary: 'runLean 验证:n≤100 无反例',
    llmTokensSpent: 120, toolCallsSpent: 4,
  };
  applyPursuitProgress(mem.pursuits, init2, res2);

  const finalQ = mem.pursuits.get(pid)!.openQuestions[0];
  console.log(`        → 答上,question status=${finalQ.status},pendingTool=${finalQ.pendingTool}`);

  console.log(
    `\n结果:replay 用上 runLean=${usedLean};问题已 ${finalQ.status};pendingTool 已清=${finalQ.pendingTool === null}。`,
  );
  console.log('\n=== 验证结束:后台申请 gated 工具 → 用户对话内有界授权 → 续跑用上 → 答完自动清 ===\n');
  mem.close();
}

void main();
