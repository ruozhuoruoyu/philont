/**
 * failure_recovery_inject 单测。
 *
 * 验证:audit 真有 task_failure_mode 事件 → 注入命中;无 → 静默零开销。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '@agent/policy';
import {
  buildFailureRecoveryInjection,
  detectUserDissatisfaction,
} from '../src/failure_recovery_inject.js';

function setup(): { audit: AuditLog } {
  return { audit: new AuditLog() };
}

const SESSION_A = 'wechat:user-a';
const SESSION_B = 'wechat:user-b';

// ── 1. 无 audit → matched=false ────────────────────────────────────────

test('无 task_failure_mode audit → matched=false 且 text 空', () => {
  const { audit } = setup();
  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hello');
  assert.equal(r.matched, false);
  assert.equal(r.text, '');
  assert.deepEqual(r.recentFailures, []);
});

// ── 2. 1 条 iter_cap_hit < 30min → matched + 提示 planAndExecute ──────

test('近期 iter_cap_hit → 注入命中,文本含 planAndExecute', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'iter_cap_hit',
    ts: Date.now() - 5 * 60_000,
    detail: '撞 20 轮工具上限,最近工具:writeFile → shell',
  });

  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hello');
  assert.equal(r.matched, true);
  assert.equal(r.recentFailures.length, 1);
  assert.equal(r.recentFailures[0].kind, 'iter_cap_hit');
  assert.match(r.text, /planAndExecute/);
  assert.match(r.text, /searchSkills/);
  assert.match(r.text, /撞 iter cap/);
});

// ── 3. 多种 kind → 全列出 ──────────────────────────────────────────────

test('多种 kind 同时 → 文本列出各 kind', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'iter_cap_hit',
    ts: Date.now(),
  });
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'turn_deadline',
    ts: Date.now(),
  });
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'llm_timeout',
    ts: Date.now(),
  });

  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.equal(r.matched, true);
  assert.equal(r.recentFailures.length, 3);
  assert.match(r.text, /iter cap/);
  assert.match(r.text, /turn 超过时长/);
  assert.match(r.text, /反复超时/);
});

// ── 4. > 30min 老 audit → 不 match ────────────────────────────────────

test('> 30min 之前的 audit → 过期,不 match', () => {
  const { audit } = setup();
  // 手动篡改时间戳:append 后修改最后一条 event 的 timestamp
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'iter_cap_hit',
  });
  // hack:直接改 events 数组的 timestamp 模拟老事件
  const events = audit.getEvents() as Array<{ timestamp: number }>;
  const last = events[events.length - 1];
  (last as { timestamp: number }).timestamp = Date.now() - 60 * 60_000; // 60 min ago

  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi', { sinceMin: 30 });
  assert.equal(r.matched, false);
});

// ── 5. 不同 sessionId 不串 ──────────────────────────────────────────────

test('不同 sessionId 不串', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', {
    sessionId: SESSION_B,
    kind: 'iter_cap_hit',
  });

  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.equal(r.matched, false);
  assert.equal(r.recentFailures.length, 0);
});

// ── 6. opts 参数透传 ──────────────────────────────────────────────────

test('sinceMin / maxFailures 参数透传', () => {
  const { audit } = setup();
  for (let i = 0; i < 10; i++) {
    audit.append('task_failure_mode', {
      sessionId: SESSION_A,
      kind: 'iter_cap_hit',
    });
  }
  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi', {
    maxFailures: 3,
  });
  assert.equal(r.recentFailures.length, 3);
});

// ── 7. text 长度合理(< 1500 chars 防 prompt 膨胀)────────────────────

test('注入文本 < 1500 chars(防 prompt 膨胀)', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'iter_cap_hit',
    detail: 'A'.repeat(500), // 长 detail 也应被截断
  });
  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.ok(r.text.length < 1500, `text ${r.text.length} should be < 1500`);
});

// ── 8. 非 task_failure_mode 事件忽略 ──────────────────────────────────

test('audit 含其他 type 事件 → 不影响,只看 task_failure_mode', () => {
  const { audit } = setup();
  audit.append('self_domain_write', { sessionId: SESSION_A, foo: 'bar' });
  audit.append('tool_call', { sessionId: SESSION_A });
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'iter_cap_hit',
  });
  audit.append('self_domain_access', { sessionId: SESSION_A });

  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.equal(r.matched, true);
  assert.equal(r.recentFailures.length, 1);
});

// ── 9. malformed event 容错(kind 非法 / sessionId 缺) ────────────────

test('malformed audit data → 安全跳过', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', { sessionId: SESSION_A, kind: 'bogus' });
  audit.append('task_failure_mode', { kind: 'iter_cap_hit' }); // 无 sessionId
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'iter_cap_hit',
  });

  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.equal(r.recentFailures.length, 1);
  assert.equal(r.recentFailures[0].kind, 'iter_cap_hit');
});

// ── 软失败 kind:reflection_triggered / tool_failure_burst / user_dissatisfaction ──

test('软失败 kind 也能命中:reflection_triggered', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'reflection_triggered',
    detail: 'reasons=same_root_cause_failures turnCount=2',
  });
  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.equal(r.matched, true);
  assert.equal(r.recentFailures[0].kind, 'reflection_triggered');
  assert.match(r.text, /反思系统触发/);
});

test('软失败 kind 也能命中:tool_failure_burst', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'tool_failure_burst',
    detail: '本 turn 3 个 tool 失败',
  });
  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.equal(r.matched, true);
  assert.match(r.text, /工具失败/);
});

test('软失败 kind 也能命中:user_dissatisfaction', () => {
  const { audit } = setup();
  audit.append('task_failure_mode', {
    sessionId: SESSION_A,
    kind: 'user_dissatisfaction',
    detail: '还是没成功',
  });
  const r = buildFailureRecoveryInjection(audit, SESSION_A, 'hi');
  assert.equal(r.matched, true);
  assert.match(r.text, /不满意/);
});

// ── detectUserDissatisfaction 单元测试 ────────────────────────────────

test('detectUserDissatisfaction:中文不满意词', () => {
  assert.equal(detectUserDissatisfaction('还是没成功'), true);
  assert.equal(detectUserDissatisfaction('你之前并没有按照 guide 要求做'), true);
  assert.equal(detectUserDissatisfaction('再试一次,根据 X 的内容'), true);
  assert.equal(detectUserDissatisfaction('又失败了'), true);
  assert.equal(detectUserDissatisfaction('不对,这不是要的'), true);
  assert.equal(detectUserDissatisfaction('没用,你重做'), true);
  assert.equal(detectUserDissatisfaction('换个方法试'), true);
  assert.equal(detectUserDissatisfaction('还没好'), true);
});

test('detectUserDissatisfaction:英文不满意词', () => {
  assert.equal(detectUserDissatisfaction('try again please'), true);
  assert.equal(detectUserDissatisfaction("it didn't work"), true);
  assert.equal(detectUserDissatisfaction('this is wrong'), true);
  assert.equal(detectUserDissatisfaction('failed to do it'), true);
});

test('detectUserDissatisfaction:正常消息不命中', () => {
  assert.equal(detectUserDissatisfaction('帮我查 Python 文档'), false);
  assert.equal(detectUserDissatisfaction('你好,今天天气怎么样'), false);
  assert.equal(detectUserDissatisfaction('做一个 PPT'), false);
  assert.equal(detectUserDissatisfaction(''), false);
  // 老 caller 可能传 undefined 或非 string
  assert.equal(detectUserDissatisfaction(null as unknown as string), false);
});

test('detectUserDissatisfaction:边界 - "成功"单独不命中,"还是没成功"才命中', () => {
  assert.equal(detectUserDissatisfaction('成功了!'), false);
  assert.equal(detectUserDissatisfaction('已经成功'), false);
  assert.equal(detectUserDissatisfaction('还是没成功'), true);
});
