/**
 * TsTaskCommitmentDrive 单测
 *
 * 覆盖:
 *   - 中文 handoff 典型用例(你可以自己 curl)
 *   - 英文 handoff 典型用例(you can run...)
 *   - 政策拒绝白名单(违反安全政策 → 不触发)
 *   - 半成品交付白名单(已为你下载 /tmp/x.pdf → 不触发)
 *   - 纯澄清问白名单(放过,由 LLM 自然处理)
 *   - 同 assistant 消息去重
 *   - cooldown 内压制
 *   - assistant 已续话 → 不触发(防止上两轮的事再跳出来)
 *   - 无 prior user 任务(taskHint=null)仍能触发,用"这件事"兜底
 *   - utility = 0.6
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TsTaskCommitmentDrive,
  detectTaskHandoff,
  isPolicyRefusal,
  isDeliveredResult,
  isPureOpenQuestion,
} from '../src/kernel_drives.js';
import type {
  DriveRuntimeState,
  RecentMessage,
} from '../src/drive_runtime.js';

function mkState(overrides: Partial<DriveRuntimeState> = {}): DriveRuntimeState {
  return {
    sessionId: 'test',
    recentMessages: [],
    iteration: 0,
    activePursuits: [],
    recentToolCalls: [],
    ...overrides,
  };
}

const user = (content: string): RecentMessage => ({ role: 'user', content });
const asst = (content: string): RecentMessage => ({ role: 'assistant', content });

// ── 工具函数级单测 ──────────────────────────────────────────────────────

test('detectTaskHandoff: 中文典型 — 你可以自己 curl', () => {
  const m = detectTaskHandoff(
    'PDF 二进制文件我这边还是拉不下来,你可以用这个命令直接下载:\n```\ncurl -L https://example.com/x.pdf -o x.pdf\n```',
  );
  assert.ok(m);
  assert.equal(m!.language, 'zh');
  // 命中的是"你可以...下载"模式,snippet 里含"下载"
  assert.ok(m!.snippet.includes('下载'));
});

test('detectTaskHandoff: 中文 — 建议你自己执行', () => {
  const m = detectTaskHandoff('建议你自己手动执行这个命令');
  assert.ok(m);
  assert.equal(m!.language, 'zh');
});

test('detectTaskHandoff: 中文 — 我无法下载', () => {
  const m = detectTaskHandoff('抱歉,我无法下载这个文件');
  assert.ok(m);
  assert.equal(m!.language, 'zh');
});

test('detectTaskHandoff: 英文 — you can run', () => {
  const m = detectTaskHandoff("Sorry, you can run `wget url -O file` yourself.");
  assert.ok(m);
  assert.equal(m!.language, 'en');
  assert.ok(m!.verb === 'run');
});

test('detectTaskHandoff: 英文 — I cannot fetch', () => {
  const m = detectTaskHandoff("I cannot fetch binary data through this tool.");
  assert.ok(m);
  assert.equal(m!.language, 'en');
});

test('detectTaskHandoff: 纯陈述/技术讨论不命中', () => {
  assert.equal(detectTaskHandoff('这个函数计算斐波那契数列。'), null);
  assert.equal(
    detectTaskHandoff("The algorithm has O(n log n) complexity."),
    null,
  );
});

// ── Tier 1.2: 预先 handoff 模式 ─────────────────────────────────────────

test('detectTaskHandoff: 预先 handoff —— 需要你确认权限(PDF→Word case)', () => {
  const m = detectTaskHandoff('需要你确认是否有 winget 权限');
  assert.ok(m, '"需要你确认权限" 是典型的预先 handoff,应命中');
  assert.equal(m!.language, 'zh');
  assert.equal(m!.verb, '确认');
});

test('detectTaskHandoff: 预先 handoff —— 需要你提供 API key', () => {
  const m = detectTaskHandoff('要继续就需要你提供 API key');
  assert.ok(m);
  assert.equal(m!.verb, '提供');
});

test('detectTaskHandoff: ask-back —— 需要你确认下结果 → 不命中', () => {
  // 合理的反向请求:agent 已经做了事,问用户结果
  assert.equal(
    detectTaskHandoff('需要你确认下我修改的代码效果如何'),
    null,
    '"需要你确认下结果/代码效果" 是合理 ask-back,不算 handoff',
  );
  assert.equal(
    detectTaskHandoff('需要你查看下工具返回值'),
    null,
  );
});

test('isPolicyRefusal: 命中政策拒绝', () => {
  assert.equal(isPolicyRefusal('抱歉,我不能帮你做攻击行为,这违反安全政策'), true);
  assert.equal(
    isPolicyRefusal("I can't help with illegal actions as it's against our guidelines"),
    true,
  );
});

test('isPolicyRefusal: 能力性放弃不命中', () => {
  assert.equal(isPolicyRefusal('我无法下载,你可以自己 curl'), false);
});

test('isDeliveredResult: 已交付产物', () => {
  assert.equal(isDeliveredResult('已为你下载到 /tmp/x.pdf,你可以查看'), true);
  assert.equal(isDeliveredResult('文件已保存在 C:\\Users\\test\\out.txt'), true);
  assert.equal(isDeliveredResult('Saved to /home/user/output.json'), true);
});

test('isDeliveredResult: 仅承诺未交付,不命中', () => {
  assert.equal(isDeliveredResult('你可以尝试下载这个文件'), false);
});

test('isPureOpenQuestion: 末尾问号无 handoff', () => {
  assert.equal(isPureOpenQuestion('你想下载 PDF 还是 markdown?'), true);
  assert.equal(isPureOpenQuestion('要不要继续看下一题?'), true);
});

test('isPureOpenQuestion: 有 handoff 动词则不算纯问句', () => {
  assert.equal(isPureOpenQuestion('你可以自己下载吗?'), false);
});

// ── Drive 集成测试 ───────────────────────────────────────────────────────

test('TaskCommitmentDrive: 典型放弃 → fire', () => {
  const drive = new TsTaskCommitmentDrive('task-commit-test', {
    cooldownMs: 0,
    minMessageLen: 4,
  });
  const state = mkState({
    recentMessages: [
      user('下载这个 PDF: https://example.com/paper.pdf'),
      asst('PDF 二进制我这边拉不下来,你可以自己运行 curl 下载'),
      user('这个链接有问题吗?'),
    ],
  });
  const p = drive.evaluate(state);
  assert.ok(p, '应该触发');
  assert.ok(p!.injectMessage.includes('(Drive TaskCommitment)'));
  assert.ok(p!.injectMessage.includes('下载'));
  assert.equal(p!.utility, 0.6);
  const snap = p!.triggerSnapshot as { matchedLanguage: string; taskHint: string | null };
  assert.equal(snap.matchedLanguage, 'zh');
  assert.ok(snap.taskHint?.includes('下载'));
});

test('TaskCommitmentDrive: 英文放弃 → fire', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      user('download this dataset'),
      asst("I can't download binary files. You can just run `wget https://...` yourself."),
      user('any alternative?'),
    ],
  });
  const p = drive.evaluate(state);
  assert.ok(p);
  const snap = p!.triggerSnapshot as { matchedLanguage: string };
  assert.equal(snap.matchedLanguage, 'en');
});

test('TaskCommitmentDrive: 政策拒绝白名单 → 不触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      user('帮我发送攻击流量'),
      asst('我不能帮你做攻击,这违反安全政策。你可以自己了解相关法律'),
      user('那算了'),
    ],
  });
  assert.equal(drive.evaluate(state), null);
});

test('TaskCommitmentDrive: 半成品交付白名单 → 不触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      user('下载 pdf'),
      asst('已为你下载到 /tmp/paper.pdf,你可以自己打开看一下'),
      user('好的'),
    ],
  });
  assert.equal(drive.evaluate(state), null);
});

test('TaskCommitmentDrive: 纯澄清问 → 放过,不触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      user('下载资料'),
      asst('你想下载 PDF 格式还是 markdown?'),
      user('你决定就好'),
    ],
  });
  assert.equal(drive.evaluate(state), null);
});

test('TaskCommitmentDrive: assistant 已续话 → 不触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      user('下载'),
      asst('你可以自己 curl 下载'),
      user('真的不行?'),
      asst('其实我再试一次吧,用 downloadFile 试试'),
      user('好的'),
    ],
  });
  assert.equal(drive.evaluate(state), null);
});

test('TaskCommitmentDrive: 同 assistant 消息去重', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      user('下载'),
      asst('你可以自己运行 curl 下载它'),
      user('嗯'),
    ],
  });
  const p1 = drive.evaluate(state);
  assert.ok(p1);
  drive.onFired('outcome-1');
  // 同一 state 再 evaluate(同 assistant 消息)
  assert.equal(drive.evaluate(state), null);
});

test('TaskCommitmentDrive: cooldown 内压制', () => {
  const drive = new TsTaskCommitmentDrive('t', {
    cooldownMs: 60_000,
    minMessageLen: 4,
  });
  const state1 = mkState({
    recentMessages: [
      user('下载 A'),
      asst('你可以自己运行 curl A'),
      user('嗯'),
    ],
  });
  assert.ok(drive.evaluate(state1));
  drive.onFired('o1');

  // 换新 assistant 消息(绕过去重),但 cooldown 仍生效
  const state2 = mkState({
    recentMessages: [
      user('下载 B'),
      asst('这个也是,建议你自己手动执行完成'),
      user('嗯'),
    ],
  });
  assert.equal(drive.evaluate(state2), null);
});

test('TaskCommitmentDrive: 无 prior user 消息 → taskHint=null 但仍能触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      asst('你可以自己运行 curl'),
      user('嗯?'),
    ],
  });
  const p = drive.evaluate(state);
  assert.ok(p);
  assert.ok(p!.injectMessage.includes('this task'));
});

test('TaskCommitmentDrive: assistant 消息太短 → 不触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 8 });
  const state = mkState({
    recentMessages: [
      user('?'),
      asst('你自己做'), // 只有 4 字符
      user('...'),
    ],
  });
  assert.equal(drive.evaluate(state), null);
});

test('TaskCommitmentDrive: 最近无 assistant → 不触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [user('hello')],
  });
  assert.equal(drive.evaluate(state), null);
});

test('TaskCommitmentDrive: assistant 之后无 user → 不触发', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [user('x'), asst('你可以自己运行 curl ...')],
  });
  // tail 为空,drive 不该触发
  assert.equal(drive.evaluate(state), null);
});

// ── 边缘:drive 注入消息不被当作 user 任务 ────────────────────────────

test('TaskCommitmentDrive: 跳过"(内驱 XXX)"开头的 user 消息作 taskHint', () => {
  const drive = new TsTaskCommitmentDrive('t', { cooldownMs: 0, minMessageLen: 4 });
  const state = mkState({
    recentMessages: [
      user('帮我下载论文 arxiv 2507.21046'),
      asst('收到,让我查一下'),
      user('(内驱 OpenLoop) 上次问的还没闭合...'), // drive 注入
      asst('你可以自己用 curl 下载这个 pdf'),
      user('继续'),
    ],
  });
  const p = drive.evaluate(state);
  assert.ok(p);
  const snap = p!.triggerSnapshot as { taskHint: string | null };
  // taskHint 应该回到真实 user 请求,而不是 drive 注入的那条
  assert.ok(snap.taskHint?.includes('arxiv') || snap.taskHint?.includes('下载'));
});
