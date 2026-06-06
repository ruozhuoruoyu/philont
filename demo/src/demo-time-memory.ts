/**
 * Phase 2-6 新功能运行时 demo
 *
 * 演示:
 *   1. Extractor 时间化:相对时间锚定 + event fact 镜像到日历
 *   2. Skills 反馈环:成功/失败记录后排序变化
 *   3. 衰退与遗忘池:老事实自动降分,可 pin 或软删
 *   4. Scheduler:一次性 + 周期任务
 */

import {
  openMemoryDb,
  SessionExtractor,
  startScheduler,
  scoreMemory,
  type ExtractorLlmClient,
  type Schedule,
} from '@agent/memory';

const FIXED_NOW = new Date('2026-04-17T10:00:00+08:00');
const NOW_MS = FIXED_NOW.getTime();

function section(title: string) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70) + '\n');
}

// ── Mock LLM:返回预设事实 JSON ──────────────────────────────────────
class FixedLlm implements ExtractorLlmClient {
  constructor(private readonly text: string) {}
  async complete() { return { text: this.text, tokensUsed: 0 }; }
}

async function main() {
  const mem = openMemoryDb(':memory:');

  // ═════════════════════════════════════════════════════════════════════
  section('1. Extractor 时间化 + 日历镜像');
  // ═════════════════════════════════════════════════════════════════════

  const sess = mem.raw.startSession();
  mem.raw.appendMessage({
    sessionId: sess.id,
    role: 'user',
    content: '下周一下午 3 点开评审,我休假到下下周五',
  });

  // 模拟 LLM 输出:一条未来 event 和一条带 validity window 的 state
  const llm = new FixedLlm(JSON.stringify([
    {
      action: 'store_fact',
      namespace: 'project', key: 'review_meeting',
      value: '评审会议',
      fact_kind: 'event',
      occurred_at: '2026-04-20T15:00:00+08:00',
    },
    {
      action: 'store_fact',
      namespace: 'user', key: 'status',
      value: 'on_leave',
      fact_kind: 'state',
      valid_from: '2026-04-17T00:00:00+08:00',
      valid_until: '2026-04-24T23:59:59+08:00',
    },
  ]));

  const extractor = new SessionExtractor(
    llm, mem.facts, mem.notes, mem.raw,
    { currentDate: () => FIXED_NOW, timezone: 'Asia/Shanghai', calendar: mem.calendar },
  );
  const result = await extractor.extractFromSession(sess.id);
  console.log(`  提取:${result.factsStored} facts,其中 event 自动镜像到日历`);

  // 日历里应该多出一条
  const upcoming = mem.calendar.upcoming(10 * 86_400_000, NOW_MS);
  console.log(`  📅 日历未来 10 天:`);
  for (const e of upcoming) {
    console.log(`     - ${new Date(e.occurrenceStartsAt).toISOString()} "${e.title}" (${e.timezone})`);
  }

  // 时态查询:2026-04-20 时 user.status 是什么?
  const onLeaveDay = mem.facts.getActiveAt('user', 'status', Date.parse('2026-04-20T12:00:00+08:00'));
  const afterLeave = mem.facts.getActiveAt('user', 'status', Date.parse('2026-04-25T12:00:00+08:00'));
  console.log(`  🕰  2026-04-20 user.status = ${JSON.stringify(onLeaveDay?.value)}`);
  console.log(`  🕰  2026-04-25 user.status = ${JSON.stringify(afterLeave?.value)} (过期)`);

  // ═════════════════════════════════════════════════════════════════════
  section('2. 技能反馈环:失败自动降权');
  // ═════════════════════════════════════════════════════════════════════

  mem.skills.createSkill({ name: 'reliable', description: '稳定流程', triggerKeywords: ['build'], actionTemplate: '...' });
  mem.skills.createSkill({ name: 'flaky', description: '脆弱流程', triggerKeywords: ['build'], actionTemplate: '...' });

  // reliable 三次全成功
  for (let i = 0; i < 3; i++) mem.skills.recordSkillOutcome('reliable', true);
  // flaky 一次成功四次失败
  mem.skills.recordSkillOutcome('flaky', true);
  for (let i = 0; i < 4; i++) mem.skills.recordSkillOutcome('flaky', false);

  console.log('  使用 listAll()(按综合分数排序):');
  for (const s of mem.skills.listAll()) {
    const rate = (s.successCount + 1) / (s.successCount + s.failureCount + 2);
    console.log(
      `     - ${s.name.padEnd(10)} use=${s.useCount} success=${s.successCount} failure=${s.failureCount} laplace=${rate.toFixed(2)}`
    );
  }
  console.log('  → reliable 排在 flaky 前,即便都在最近使用');

  // ═════════════════════════════════════════════════════════════════════
  section('3. 衰退 + 候选遗忘池');
  // ═════════════════════════════════════════════════════════════════════

  // 手工写入一条 project 事实,并把 created_at 拨回 200 天前
  const oldFact = mem.facts.storeFact({
    namespace: 'project',
    key: 'legacy_url',
    value: 'http://legacy.example.com',
    confidence: 0.8,
  });
  mem.db.prepare(`UPDATE memory_facts SET created_at = ? WHERE id = ?`)
    .run(NOW_MS - 200 * 86_400_000, oldFact.id);

  // 计算分数
  const refreshed = mem.facts.getById(oldFact.id)!;
  const score = scoreMemory(refreshed, NOW_MS);
  console.log(`  📉 project.legacy_url (200 天前创建,τ=60):`);
  console.log(`     confidence=${refreshed.confidence}, score=${score.toFixed(4)}`);

  const candidates = mem.facts.getForgetCandidates({ now: NOW_MS });
  console.log(`  🗑  候选遗忘池(${candidates.length} 条):`);
  for (const c of candidates) {
    console.log(`     - ${c.fact.namespace}.${c.fact.key}  score=${c.score.toFixed(4)}`);
  }

  // pin 后应从候选池消失
  mem.facts.pin(oldFact.id);
  const afterPin = mem.facts.getForgetCandidates({ now: NOW_MS });
  console.log(`  📌 pin 后候选池:${afterPin.length} 条`);

  // ═════════════════════════════════════════════════════════════════════
  section('4. Scheduler:到期触发');
  // ═════════════════════════════════════════════════════════════════════

  mem.schedules.create({
    name: '周日晚反思',
    cronExpr: 'interval:604800000', // 每周
    nextRunAt: NOW_MS + 1000,
    actionType: 'reflect',
    payload: { sessionId: sess.id },
  });
  mem.schedules.create({
    name: '一次性提醒',
    nextRunAt: NOW_MS + 500,
    actionType: 'prompt',
    payload: { message: '记得提交周报' },
  });

  // 用 mock clock 往前跳:触发两条到期任务
  const fired: Schedule[] = [];
  const handle = startScheduler(
    mem.schedules,
    async (s) => {
      fired.push(s);
      console.log(`  🔔 ${s.name} (${s.actionType}) fired — payload: ${JSON.stringify(s.payload)}`);
    },
    { intervalMs: 999_999, now: () => NOW_MS + 2000 },
  );
  await handle.tick();
  handle.stop();

  console.log(`  触发 ${fired.length} 条;检查一次性任务已禁用:`);
  for (const s of mem.schedules.list()) {
    console.log(
      `     - ${s.name.padEnd(12)} enabled=${s.enabled} next=${new Date(s.nextRunAt).toISOString()}`
    );
  }

  section('✅ 所有 Phase 2-6 路径均已真实运行');
  mem.db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
