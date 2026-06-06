/**
 * Demo:预测式预动 · 第一片 —— deadline pursuit → 调度软唤醒(确定性,注入时钟)
 *
 * 跑法:  cd demo && npx tsx src/demo-predictive-wakeup.ts
 *
 * 把整条"预测回路"演一遍,每步打印发生了什么,演示**怎么验证**这套机制:
 *   场景 A(happy path):种高 stake 近 deadline 的 pursuit → reconcile 排出预动唤醒
 *     → 幂等(再 tick 不重复)→ 把时钟拨到唤醒时刻 → scheduler fire,打印预动指令。
 *   场景 B(取消):另种一条 → 唤醒已排上 → 在 fire **之前**把 pursuit 关掉
 *     → reconcile 自动取消那个唤醒(cancelled:1)。
 *
 * 不调真 LLM(onFire 用 stub 打印),证明"回路接对 + payload 正确";真 LLM 预动是
 * 真 server 的事(autonomous_turn 到点跑只读调研)。
 */
import {
  openMemoryDb,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  reconcilePredictiveWakeups,
  startScheduler,
} from '@agent/memory';

const MIN = 60_000;
const HOUR = 3600_000;
const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19); // HH:MM:SS
const NOW = Date.parse('2026-06-01T09:00:00Z'); // 固定"现在",输出可读可复现

async function main(): Promise<void> {
  console.log(`\n=== 预测式预动验证 (基准 now=${fmt(NOW)}) ===`);

  const memory = openMemoryDb(':memory:');
  let root = memory.pursuits.getDefaultRoot();
  if (!root) {
    root = memory.pursuits.createRoot({
      id: BOOTSTRAP_ROOT_PURSUIT_ID,
      title: 'root',
      intent: 'agent identity',
      origin: 'system',
      isEvergreen: true,
    });
  }

  // ── 场景 A:happy path ──────────────────────────────────────────────
  console.log('\n--- 场景 A:排 → 幂等 → 到点 fire ---\n');

  const p = memory.pursuits.createChild({
    parentPursuitId: root.id,
    title: '续约公司保险',
    intent: '6/1 18:00 前完成公司财产险续约',
    origin: 'user',
    stake: 'high',            // → stakeWeight 8 ≥ 7 阈值
    deadline: NOW + 2 * HOUR, // 11:00
    resolutionCriteria: '新保单已生效 + 确认邮件已收',
    openQuestions: [{ text: '哪家报价最低' }, { text: '去年保单号是多少' }],
  });
  console.log(`Step 1  种 pursuit id=${p.id.slice(0, 8)} "${p.title}" stake=${p.stakeWeight} deadline=${fmt(p.deadline!)}(距今 2h)`);

  const r1 = reconcilePredictiveWakeups({
    pursuits: memory.pursuits.listActive(root.id),
    now: NOW,
    schedules: memory.schedules,
  });
  const wakeup = memory.schedules.findByName(`predict:pursuit:${p.id}`);
  console.log(`Step 2  idle reconcile @ ${fmt(NOW)} →`, r1);
  if (!wakeup) { console.log('  ✗ 没排出唤醒!'); process.exit(1); }
  console.log(`        ✓ 预动 schedule 已排,唤醒时刻=${fmt(wakeup.nextRunAt)}(= deadline 11:00 − lead 30min = 10:30)`);

  const r1b = reconcilePredictiveWakeups({
    pursuits: memory.pursuits.listActive(root.id),
    now: NOW + 5 * MIN,
    schedules: memory.schedules,
  });
  console.log(`Step 2b 5min 后再 reconcile(应幂等)→`, r1b, `enabled 唤醒数=${memory.schedules.list({ enabledOnly: true }).length}`);

  let clock = NOW;
  const sched = startScheduler(
    memory.schedules,
    (s) => {
      console.log(`Step 3  ⏰ FIRED @ ${fmt(clock)} schedule="${s.name.slice(0, 24)}…"`);
      const prompt = (s.payload as { prompt?: string }).prompt ?? '(无 prompt)';
      console.log('        —— 到点要跑的"预动指令"(真 server 会喂给 autonomous_turn 调只读工具)——');
      console.log(prompt.split('\n').map((l) => '        | ' + l).join('\n'));
    },
    { now: () => clock, intervalMs: 9_999_999 }, // 手动 tick
  );
  console.log(`Step 3  唤醒前(09:00)due 数=${memory.schedules.dueBefore(NOW).length}(应 0)`);
  clock = wakeup.nextRunAt; // 拨到 10:30
  await sched.tick();       // → 触发 onFire
  sched.stop();

  // ── 场景 B:在 fire 之前关掉 pursuit → 自动取消 ──────────────────────
  console.log('\n--- 场景 B:排上后关掉 pursuit → 自动取消 ---\n');

  const q = memory.pursuits.createChild({
    parentPursuitId: root.id,
    title: '提交季度报税',
    intent: '6/3 前提交 Q2 报税',
    origin: 'user',
    stake: 'high',
    deadline: NOW + 5 * HOUR, // 14:00
  });
  reconcilePredictiveWakeups({ pursuits: memory.pursuits.listActive(root.id), now: NOW, schedules: memory.schedules });
  console.log(`Step 4  种 "${q.title}" → reconcile,enabled 预动唤醒数=${memory.schedules.list({ enabledOnly: true }).filter((s) => s.name.startsWith('predict:pursuit:')).length}`);

  memory.pursuits.updateStatus(q.id, 'achieved'); // 还没到唤醒点就做完了
  const r2 = reconcilePredictiveWakeups({ pursuits: memory.pursuits.listActive(root.id), now: NOW, schedules: memory.schedules });
  console.log(`Step 5  关掉 "${q.title}" 后 reconcile →`, r2, `(cancelled:1 = 那个还没 fire 的唤醒被取消)`);
  console.log(`        剩余 enabled 预动唤醒数=${memory.schedules.list({ enabledOnly: true }).filter((s) => s.name.startsWith('predict:pursuit:')).length}`);

  console.log('\n=== 验证结束:回路全通(排 → 幂等 → fire → 取消)===\n');
}

void main();
