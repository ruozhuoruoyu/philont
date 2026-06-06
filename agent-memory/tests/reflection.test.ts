/**
 * Reflection 解析 + 应用 + 触发评估测试
 *
 * 覆盖:
 *   - parseReflectionOutput: 直接 JSON / fenced / 容错抓取 / 各 learning 类型必填字段
 *   - applyReflection: 写入 stores / fail-soft / hadLesson=false 短路
 *   - shouldTriggerReflection: 入口 + 预算阀 各组合
 *   - renderReflectionPrompt: 含必填字样
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  parseReflectionOutput,
  applyReflection,
  shouldTriggerReflection,
  renderReflectionPrompt,
} from '../src/index.js';

// ── parseReflectionOutput ──────────────────────────────────────────────

test('parse: 标准 JSON 解析成功', () => {
  const text = JSON.stringify({
    had_lesson: true,
    task_signature: 'pdf-to-word',
    attempts: [
      { method: 'pdf2docx', context_features: '扫描版', outcome: 'fail', failure_reason: '空 docx' },
      { method: 'camscanner', context_features: '扫描版+表格', outcome: 'success' },
    ],
    differentiator: '无文本层是关键',
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: 'PDF 无文本层',
        prefer_skill: 'camscanner',
        avoid_skills: ['pdf2docx'],
        carveout: '不适用于含可选文本层',
        evidence: 'turn 5-12',
        self_confidence: 'tentative',
      },
    ],
  });
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, true);
  assert.equal(r.reflection?.taskSignature, 'pdf-to-word');
  assert.equal(r.reflection?.attempts.length, 2);
  assert.equal(r.reflection?.learnings.length, 1);
  const learning = r.reflection!.learnings[0];
  assert.equal(learning.type, 'routing_rule');
  if (learning.type === 'routing_rule') {
    assert.equal(learning.preferSkill, 'camscanner');
    assert.deepEqual(learning.avoidSkills, ['pdf2docx']);
    assert.equal(learning.selfConfidence, 'tentative');
  }
});

test('parse: ```json ... ``` fenced 块', () => {
  const text = `Sure, here's my reflection:\n\n\`\`\`json\n${JSON.stringify({
    had_lesson: false,
    task_signature: 't',
    attempts: [],
    learnings: [],
  })}\n\`\`\`\n\nDone.`;
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, true);
  assert.equal(r.reflection?.hadLesson, false);
});

test('parse: 抓 { ... } 包围(LLM 不带 fence)', () => {
  const text = `Reflection follows: ${JSON.stringify({
    had_lesson: false,
    task_signature: 't',
    attempts: [],
    learnings: [],
  })}\nThanks.`;
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, true);
  assert.equal(r.reflection?.taskSignature, 't');
});

test('parse: 完全非 JSON 失败', () => {
  const r = parseReflectionOutput('just some text');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('parse: 空文本失败', () => {
  const r = parseReflectionOutput('');
  assert.equal(r.ok, false);
});

test('parse: tier-4 救场 — JSON 内嵌未转义双引号', () => {
  // 模拟 LLM 实战写法:summary / value 内嵌 " 没 escape
  const broken = `{
  "had_lesson": true,
  "task_signature": "调研 "工具调用" 概念",
  "attempts": [],
  "learnings": []
}`;
  const r = parseReflectionOutput(broken);
  assert.equal(r.ok, true, 'tier-4 应救活');
  if (r.ok && r.reflection) {
    assert.equal(r.reflection.hadLesson, true);
    // 内嵌引号应被转义保留
    assert.match(r.reflection.taskSignature ?? '', /工具调用/);
  }
});

test('parse: tier-4 完全 malformed → 仍然失败', () => {
  const r = parseReflectionOutput('{ totally broken }}}');
  assert.equal(r.ok, false);
});

test('parse: 缺 had_lesson 失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    task_signature: 't',
    attempts: [],
    learnings: [],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /had_lesson/.test(e)));
});

test('parse: 缺 task_signature 失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    attempts: [],
    learnings: [],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /task_signature/.test(e)));
});

test('parse: routing_rule 缺 carveout → 失败 (write-time 强制)', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: 'cond',
        prefer_skill: 's',
        evidence: 'ev',
      },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /carveout/.test(e)));
});

test('parse: routing_rule 缺 evidence → 失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: 'cond',
        prefer_skill: 's',
        carveout: 'cv',
      },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /evidence/.test(e)));
});

test('parse: routing_rule 既无 prefer 又无 avoid → 通过(2026-05-11 放宽:纯避雷规则合法)', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: 'cond',
        carveout: 'cv',
        evidence: 'ev',
      },
    ],
  }));
  assert.equal(r.ok, true, '放宽后 trigger_condition + carveout + evidence 即可,无 skill 推荐 / 规避也合法');
  const l = r.reflection!.learnings[0];
  if (l.type === 'routing_rule') {
    assert.equal(l.preferSkill, null);
    assert.deepEqual(l.avoidSkills, []);
  }
});

test('parse: skill_refine 缺字段失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [{ type: 'skill_refine', skill: 'x' }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /new_condition/.test(e)));
});

test('parse: new_skill 缺 actionTemplate 失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [{ type: 'new_skill', name: 'x', description: 'd' }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /action_template/.test(e)));
});

test('parse: playbook 含 lesson + 3 必填字段通过', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [{
      type: 'playbook',
      lesson: 'always do X first',
      when_applies: '操作 Y 类资源时',
      next_time_action: '先调 list,再调 modify',
      why_not_routing_rule: '没有具体 skill 可推荐,这是横切原则',
    }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.reflection?.learnings[0].type, 'playbook');
  if (r.reflection?.learnings[0].type === 'playbook') {
    assert.equal(r.reflection.learnings[0].whenApplies, '操作 Y 类资源时');
    assert.equal(r.reflection.learnings[0].nextTimeAction, '先调 list,再调 modify');
    assert.match(r.reflection.learnings[0].whyNotRoutingRule, /横切原则/);
  }
});

test('parse: playbook 缺 when_applies → 失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [{
      type: 'playbook',
      lesson: 'L',
      next_time_action: 'do Y',
      why_not_routing_rule: 'reason',
    }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /when_applies/.test(e)));
});

test('parse: playbook 缺 next_time_action → 失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [{
      type: 'playbook',
      lesson: 'L',
      when_applies: 'when X',
      why_not_routing_rule: 'reason',
    }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /next_time_action/.test(e)));
});

test('parse: playbook 缺 why_not_routing_rule → 失败(逼 LLM 解释为什么不升级)', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [{
      type: 'playbook',
      lesson: 'L',
      when_applies: 'when X',
      next_time_action: 'do Y',
    }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /why_not_routing_rule/.test(e)));
});

test('parse: 未知 type 失败', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [{ type: 'mystery' }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown type/.test(e)));
});

test('parse: attempts outcome 不在白名单 → fallback 到 fail(2026-05-08 容错)', () => {
  // 之前实战:LLM 写 'maybe' / 'partial' / 'mixed' 等非白名单值,整段 reflection
  // 被废,routing rule + playbook 全丢。现在 fallback 到 'fail'。
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [{ method: 'm', context_features: 'c', outcome: 'maybe' }],
    learnings: [],
  }));
  assert.equal(r.ok, true);
  if (r.ok && r.reflection) {
    assert.equal(r.reflection.attempts[0].outcome, 'fail');
  }
});

test('parse: attempts outcome=true → success;outcome="成功" → success', () => {
  const r = parseReflectionOutput(JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [
      { method: 'a', context_features: 'c', outcome: true },
      { method: 'b', context_features: 'c', outcome: '成功' },
    ],
    learnings: [],
  }));
  assert.equal(r.ok, true);
  if (r.ok && r.reflection) {
    assert.equal(r.reflection.attempts[0].outcome, 'success');
    // '成功' is not in the English whitelist (success/succeeded/true) → falls back to 'fail'
    assert.equal(r.reflection.attempts[1].outcome, 'fail');
  }
});

// ── applyReflection ────────────────────────────────────────────────────

test('apply: hadLesson=false 短路,啥都不写', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const r = applyReflection(
    { hadLesson: false, taskSignature: 't', attempts: [], learnings: [] },
    { skills, routingRules },
  );
  assert.equal(r.applied.length, 0);
  assert.equal(skills.count(), 0);
  assert.equal(routingRules.count(), 0);
});

test('apply: routing_rule 写入', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 'pdf-to-word',
      attempts: [],
      learnings: [
        {
          type: 'routing_rule',
          triggerCondition: 'PDF 无文本层',
          preferSkill: 'camscanner',
          avoidSkills: ['pdf2docx'],
          carveout: '不适用 X',
          evidence: 'turn 5-12',
          selfConfidence: 'tentative',
        },
      ],
    },
    { skills, routingRules, reflectionId: 'refl-001' },
  );
  assert.deepEqual(r.applied, [0]);
  assert.equal(r.stats.routingRulesCreated, 1);
  const list = routingRules.listAll();
  assert.equal(list.length, 1);
  assert.equal(list[0].confidence, 'tentative');
  assert.equal(list[0].preferSkill, 'camscanner');
  assert.equal(list[0].reflectionId, 'refl-001');
});

test('apply: playbook 写入(maturity=playbook,name 自动生成,description 拼 when/next)', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 'pdf-to-word',
      attempts: [],
      learnings: [{
        type: 'playbook',
        lesson: 'PDF 转 Word 前必须先探测文本层',
        whenApplies: '收到 PDF 转 Word 类请求',
        nextTimeAction: '先 pdftotext 探测,空文本则提示需 OCR',
        whyNotRoutingRule: '当前无 PDF-OCR skill,只是个原则',
      }],
    },
    { skills, routingRules, reflectionId: 'refl-002' },
  );
  assert.deepEqual(r.applied, [0]);
  assert.equal(r.stats.playbooksCreated, 1);
  const all = skills.listAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].maturity, 'playbook');
  assert.match(all[0].name, /^playbook-pdf-to-word-/);
  assert.match(all[0].source ?? '', /^self:reflect-/);
  // description 应包含 lesson + 适用 + 下次
  assert.match(all[0].description, /PDF 转 Word/);
  assert.match(all[0].description, /Applies when:.*PDF 转 Word/);
  assert.match(all[0].description, /Next time:.*pdftotext/);
  // actionTemplate 应额外含 whyNotRoutingRule(供后续二次蒸馏追溯)
  assert.match(all[0].actionTemplate, /\[Why not routing_rule\]/);
  assert.match(all[0].actionTemplate, /无 PDF-OCR skill/);
});

test('apply: new_skill 写入(maturity 默认 draft)', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 't',
      attempts: [],
      learnings: [
        {
          type: 'new_skill',
          name: 'foo-skill',
          description: 'd',
          triggerKeywords: ['k1'],
          actionTemplate: 'do x',
        },
      ],
    },
    { skills, routingRules, reflectionId: 'r1' },
  );
  assert.equal(r.stats.newSkillsCreated, 1);
  const s = skills.getByName('foo-skill');
  assert.equal(s?.maturity, 'draft');
  assert.match(s?.source ?? '', /^self:reflect-/);
});

test('apply: skill_refine 追加 new_condition 到 description', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'my-skill',
    description: '原始描述',
    triggerKeywords: [],
    actionTemplate: 't',
  });
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 't',
      attempts: [],
      learnings: [{ type: 'skill_refine', skill: 'my-skill', newCondition: '不适用扫描版' }],
    },
    { skills, routingRules },
  );
  assert.equal(r.stats.skillsRefined, 1);
  const s = skills.getByName('my-skill');
  assert.match(s?.description ?? '', /原始描述/);
  assert.match(s?.description ?? '', /不适用扫描版/);
});

test('apply: skill_refine 不存在的 skill → 单条 error fail-soft', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 't',
      attempts: [],
      learnings: [
        { type: 'skill_refine', skill: 'no-such', newCondition: 'x' },
        {
          type: 'playbook',
          lesson: 'L',
          whenApplies: 'when X',
          nextTimeAction: 'do Y',
          whyNotRoutingRule: 'no specific skill',
        },
      ],
    },
    { skills, routingRules },
  );
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0], 1); // playbook 那条成功
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].index, 0);
  assert.match(r.errors[0].error, /does not exist/);
});

test('apply: new_skill 重名 fail-soft', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'dup',
    description: '',
    triggerKeywords: [],
    actionTemplate: 't',
  });
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 't',
      attempts: [],
      learnings: [
        { type: 'new_skill', name: 'dup', description: 'd', triggerKeywords: [], actionTemplate: 'a' },
      ],
    },
    { skills, routingRules },
  );
  assert.equal(r.applied.length, 0);
  assert.equal(r.errors.length, 1);
});

// ── shouldTriggerReflection ────────────────────────────────────────────

test('trigger: task closing 触发(预算阀放过)', () => {
  const r = shouldTriggerReflection({
    turnCount: 1,
    toolFailures: 0,
    taskClosing: true,
    honestyFired: false,
    interruptDrained: false,
    sameRootCauseFailures: 0,
    taskDurationMin: 1,
  });
  assert.equal(r.shouldFire, true);
  assert.ok(r.reasons.includes('task_closing'));
});

test('trigger: 同根因失败 ≥ 3 + 预算阀通过', () => {
  const r = shouldTriggerReflection({
    turnCount: 5,
    toolFailures: 3,
    taskClosing: false,
    honestyFired: false,
    interruptDrained: false,
    sameRootCauseFailures: 3,
    taskDurationMin: 5,
  });
  assert.equal(r.shouldFire, true);
});

test('trigger: HonestyGate 触发', () => {
  const r = shouldTriggerReflection({
    turnCount: 5,
    toolFailures: 1,
    taskClosing: false,
    honestyFired: true,
    interruptDrained: false,
    sameRootCauseFailures: 0,
    taskDurationMin: 5,
  });
  assert.equal(r.shouldFire, true);
  assert.ok(r.reasons.includes('honesty_fired'));
});

test('trigger: 长任务 turn ≥ 15', () => {
  const r = shouldTriggerReflection({
    turnCount: 15,
    toolFailures: 1,
    taskClosing: false,
    honestyFired: false,
    interruptDrained: false,
    sameRootCauseFailures: 0,
    taskDurationMin: 5,
  });
  assert.equal(r.shouldFire, true);
  assert.ok(r.reasons.includes('long_turn_count'));
});

test('trigger: 长时长 ≥ 20 min', () => {
  const r = shouldTriggerReflection({
    turnCount: 5,
    toolFailures: 1,
    taskClosing: false,
    honestyFired: false,
    interruptDrained: false,
    sameRootCauseFailures: 0,
    taskDurationMin: 25,
  });
  assert.equal(r.shouldFire, true);
});

test('trigger: 预算阀拦截(turn=1, 0 fail, 非收口)', () => {
  // 强行造一个入口命中(同根因失败 3),但预算阀不通过
  const r = shouldTriggerReflection({
    turnCount: 1,
    toolFailures: 0,
    taskClosing: false,
    honestyFired: true, // 入口命中
    interruptDrained: false,
    sameRootCauseFailures: 0,
    taskDurationMin: 1,
  });
  assert.equal(r.shouldFire, false);
  assert.ok(r.reasons[0].includes('budget_gate_failed'));
});

test('trigger: 任何入口未命中 → 不触发', () => {
  const r = shouldTriggerReflection({
    turnCount: 5,
    toolFailures: 0,
    taskClosing: false,
    honestyFired: false,
    interruptDrained: false,
    sameRootCauseFailures: 0,
    taskDurationMin: 5,
  });
  assert.equal(r.shouldFire, false);
  assert.equal(r.reasons.length, 0);
});

// ── renderReflectionPrompt ─────────────────────────────────────────────

test('renderPrompt: 含 schema 字段提示与原因', () => {
  const text = renderReflectionPrompt(['task_closing', 'honesty_fired']);
  assert.match(text, /task_closing/);
  assert.match(text, /honesty_fired/);
  assert.match(text, /had_lesson/);
  assert.match(text, /carveout/);
  assert.match(text, /evidence/);
  assert.match(text, /had_lesson.*false/s);
});

test('renderPrompt: routing_rule 排前,playbook 标兜底(incentive 反转)', () => {
  const text = renderReflectionPrompt(['task_closing']);
  // 产物按动作含金量排序:routing_rule 在 playbook 之前
  const routingIdx = text.indexOf('routing_rule');
  const playbookIdx = text.indexOf('playbook');
  assert.ok(routingIdx > 0 && playbookIdx > 0);
  assert.ok(
    routingIdx < playbookIdx,
    'routing_rule 必须先于 playbook 出现(incentive 反转)',
  );
  // 显式标 playbook 兜底
  assert.match(text, /playbook is fallback/);
  // 显式说 routing_rule 是首选
  assert.match(text, /routing_rule is preferred/);
  // 含 playbook 3 个新必填字段提示
  assert.match(text, /when_applies/);
  assert.match(text, /next_time_action/);
  assert.match(text, /why_not_routing_rule/);
});

test('renderPrompt: same_root_cause_failures 触发时显式推 routing_rule', () => {
  const text = renderReflectionPrompt(['same_root_cause_failures']);
  // 应该有针对性 hint 告诉 LLM 这种触发几乎一定写 routing_rule
  assert.match(text, /same_root_cause_failures/);
  assert.match(text, /routing_rule is almost certainly the preferred output/);
});

test('renderPrompt: honesty_fired 触发时引导写 routing_rule 或 skill_refine', () => {
  const text = renderReflectionPrompt(['honesty_fired']);
  assert.match(text, /honesty_fired/);
  // 应引导阻止下次再犯
  assert.match(text, /routing_rule.*skill_refine|skill_refine.*routing_rule/);
});

test('renderPrompt: task_closing 触发时引导写 new_skill 或 routing_rule', () => {
  const text = renderReflectionPrompt(['task_closing']);
  assert.match(text, /task_closing/);
  // 应引导固化为 new_skill
  assert.match(text, /new_skill/);
});

// ── v17 plan_revision learning(2026-05-11)──────────────────────────────

test('parseLearning plan_revision: 合法输入 → 解析通过', () => {
  const text = JSON.stringify({
    had_lesson: true,
    task_signature: 'mycox-onboarding',
    attempts: [{ method: '原 plan', context_features: 'v1', outcome: 'fail', failure_reason: '/ping 404' }],
    learnings: [
      {
        type: 'plan_revision',
        plan_id: 'plan-abc',
        new_steps: [
          { description: '改用 /v2/ping' },
          { description: '验证 status 200' },
        ],
        reason: 'mycox v2 已废弃 /ping,需用 /v2/ping',
        trigger: 'same_root_cause',
      },
    ],
  });
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, true);
  const l = r.reflection!.learnings[0];
  assert.equal(l.type, 'plan_revision');
  if (l.type === 'plan_revision') {
    assert.equal(l.planId, 'plan-abc');
    assert.equal(l.newSteps.length, 2);
    assert.equal(l.newSteps[0].description, '改用 /v2/ping');
    assert.equal(l.reason, 'mycox v2 已废弃 /ping,需用 /v2/ping');
    assert.equal(l.trigger, 'same_root_cause');
  }
});

test('parseLearning plan_revision: 缺 plan_id → reject', () => {
  const text = JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [
      {
        type: 'plan_revision',
        new_steps: [{ description: 'a' }],
        reason: 'r',
      },
    ],
  });
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /plan_revision\) missing plan_id/);
});

test('parseLearning plan_revision: 缺 reason → reject', () => {
  const text = JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [
      {
        type: 'plan_revision',
        plan_id: 'p',
        new_steps: [{ description: 'a' }],
      },
    ],
  });
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /plan_revision\) missing reason/);
});

test('parseLearning plan_revision: 空 new_steps → reject', () => {
  const text = JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [
      {
        type: 'plan_revision',
        plan_id: 'p',
        new_steps: [],
        reason: 'r',
      },
    ],
  });
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /missing new_steps/);
});

test('applyReflection plan_revision: 端到端 — 真改 plan + plansRevised++', () => {
  const { skills, routingRules, plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [{ description: '原 step' }],
    taskSignature: 'auth',
  });
  // 先 pass review,让 plan 进 reviewed
  plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(plans.get(p.id)?.status, 'executing');

  const result = applyReflection(
    {
      hadLesson: true,
      taskSignature: 'auth',
      attempts: [],
      learnings: [
        {
          type: 'plan_revision',
          planId: p.id,
          newSteps: [
            { description: '改 step 1' },
            { description: '新加 step 2' },
          ],
          reason: '反思发现 step-1 路径错',
          trigger: 'same_root_cause',
        },
      ],
    },
    { skills, routingRules, plans },
  );
  assert.equal(result.stats.plansRevised, 1);
  assert.equal(result.errors.length, 0);

  const after = plans.get(p.id)!;
  assert.equal(after.steps.length, 2);
  assert.equal(after.steps[0].description, '改 step 1');
  assert.equal(after.status, 'draft', 'revise 后回 draft 重审');
  assert.equal(after.reviewHistory.at(-1)?.decision, 'revise');
  assert.equal(after.reviewHistory.at(-1)?.reason, '反思发现 step-1 路径错');
});

test('applyReflection plan_revision: 无 plans context → error 记录', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const result = applyReflection(
    {
      hadLesson: true,
      taskSignature: 'x',
      attempts: [],
      learnings: [
        {
          type: 'plan_revision',
          planId: 'p',
          newSteps: [{ description: 'a' }],
          reason: 'r',
        },
      ],
    },
    { skills, routingRules }, // 没传 plans
  );
  assert.equal(result.stats.plansRevised, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /plans/);
});

test('applyReflection plan_revision: plan_id 不存在 → error 记录,不影响其他 learning', () => {
  const { skills, routingRules, plans } = openMemoryDb(':memory:');
  const result = applyReflection(
    {
      hadLesson: true,
      taskSignature: 'x',
      attempts: [],
      learnings: [
        {
          type: 'plan_revision',
          planId: 'nonexistent',
          newSteps: [{ description: 'a' }],
          reason: 'r',
        },
        {
          type: 'playbook',
          lesson: '教训',
          whenApplies: 'X 场景',
          nextTimeAction: '下次做 Y',
          whyNotRoutingRule: '太抽象',
        },
      ],
    },
    { skills, routingRules, plans },
  );
  // plan_revision 失败,但 playbook 应该成功
  assert.equal(result.stats.plansRevised, 0);
  assert.equal(result.stats.playbooksCreated, 1);
  assert.equal(result.errors.length, 1);
});

test('renderPrompt: 含 plan_revision 类型说明 + schema 例子', () => {
  const text = renderReflectionPrompt(['same_root_cause_failures']);
  assert.match(text, /plan_revision/);
  assert.match(text, /v17 complex task protocol/);
});

// ── 2026-05-11:routing_rule prefer/avoid 校验放宽 ────────────────────────

test('parseLearning routing_rule: prefer_skill 和 avoid_skills 都空 → 通过(纯避雷规则)', () => {
  const text = JSON.stringify({
    had_lesson: true,
    task_signature: 'mycox-honesty',
    attempts: [{ method: '直接声明完成', context_features: '凭证保存场景', outcome: 'fail', failure_reason: 'unverified_destructive' }],
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: '凭证保存后,LLM 倾向声明"已完成"但没真验证',
        // prefer_skill 和 avoid_skills 都不填(无具体 skill 推荐 / 规避)
        carveout: '不适用于不涉及凭证的纯查询场景',
        evidence: '本次 saveCredential 后 LLM 直接声明完成,K7 honesty fired unverified_destructive',
      },
    ],
  });
  const r = parseReflectionOutput(text);
  assert.equal(r.ok, true, '应通过(2026-05-11 放宽:prefer/avoid 都可空)');
  const l = r.reflection!.learnings[0];
  assert.equal(l.type, 'routing_rule');
  if (l.type === 'routing_rule') {
    assert.equal(l.preferSkill, null);
    assert.deepEqual(l.avoidSkills, []);
    assert.match(l.triggerCondition, /凭证保存后/);
  }
});

test('renderPrompt: 关键约束含 prefer_skill / avoid_skills 都可选 提示', () => {
  const text = renderReflectionPrompt(['honesty_fired']);
  assert.match(text, /prefer_skill \/ avoid_skills are both optional/);
});

// ── 2026-05-15: turnDegraded 负向蒸馏路径 ────────────────────────────────

test('renderPrompt: turnDegraded=true → 走降级模板(明确禁产 new_skill / skill_refine)', () => {
  const text = renderReflectionPrompt(['turn_degraded', 'same_root_cause_failures'], true);
  assert.match(text, /degraded path/);
  assert.match(text, /Forbidden outputs/);
  assert.match(text, /new_skill/);
  assert.match(text, /skill_refine/);
  assert.match(text, /Allowed outputs/);
  assert.match(text, /routing_rule/);
  assert.match(text, /playbook/);
});

test('renderPrompt: turnDegraded=false(默认)→ 走原 prompt', () => {
  const textDefault = renderReflectionPrompt(['task_closing']);
  const textExplicit = renderReflectionPrompt(['task_closing'], false);
  assert.equal(textDefault, textExplicit, '默认参数应等同 false');
  assert.match(textDefault, /Reflection triggered/);
  assert.doesNotMatch(textDefault, /degraded path/);
});

test('shouldTriggerReflection: turnDegraded=true → reasons 含 turn_degraded', () => {
  const decision = shouldTriggerReflection({
    turnCount: 5,
    toolFailures: 2,
    taskClosing: false,
    honestyFired: false,
    interruptDrained: false,
    sameRootCauseFailures: 0,
    taskDurationMin: 0,
    turnDegraded: true,
  });
  assert.equal(decision.shouldFire, true);
  assert.ok(decision.reasons.includes('turn_degraded'));
});

test('apply: turnDegraded=true 拒收 new_skill(错误记入 errors,不写 SkillStore)', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 'mycox-heartbeat',
      attempts: [],
      learnings: [{
        type: 'new_skill',
        name: 'mycox-heartbeat-check',
        description: '用 api_key_prefix 作 Bearer token',  // 失败做法
        triggerKeywords: ['mycox', 'heartbeat'],
        actionTemplate: '...',
      }],
    },
    { skills, routingRules },
    { turnDegraded: true },
  );
  assert.equal(r.applied.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /degraded-turn:.*new_skill/);
  assert.equal(skills.count(), 0, '错误 skill 不应入库');
});

test('apply: turnDegraded=true 拒收 skill_refine(错误记入 errors,不改 SkillStore)', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  // 先种一个 skill 让 refine 有目标
  skills.createSkill({
    name: 'existing-skill',
    description: 'orig desc',
    triggerKeywords: [],
    actionTemplate: '...',
    maturity: 'stable',
  });
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 't',
      attempts: [],
      learnings: [{
        type: 'skill_refine',
        skill: 'existing-skill',
        newCondition: '把失败做法当 refine 补条',
      }],
    },
    { skills, routingRules },
    { turnDegraded: true },
  );
  assert.equal(r.applied.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /degraded-turn:.*skill_refine/);
  const after = skills.getByName('existing-skill');
  assert.equal(after!.description, 'orig desc', 'description 不应被改');
});

test('apply: turnDegraded=true 仍允许 routing_rule + playbook', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const r = applyReflection(
    {
      hadLesson: true,
      taskSignature: 'mycox-heartbeat',
      attempts: [],
      learnings: [
        {
          type: 'routing_rule',
          triggerCondition: '需要 secret 鉴权的 outbound http',
          preferSkill: null,
          avoidSkills: ['mycox-heartbeat-check'],
          carveout: 'Authorization 必须用 {credential-name} 占位符,不能拼 prefix',
          evidence: '本 turn http 4x 401',
          selfConfidence: 'provisional',
        },
        {
          type: 'playbook',
          lesson: '把 fact 里的 api_key_prefix 当完整 key 拼会 401',
          whenApplies: '需要 secret 鉴权的请求',
          nextTimeAction: '用 {credential-name} 占位符',
          whyNotRoutingRule: '已有 routing_rule,playbook 留备查',
        },
      ],
    },
    { skills, routingRules },
    { turnDegraded: true },
  );
  assert.deepEqual(r.applied, [0, 1]);
  assert.equal(r.errors.length, 0);
  assert.equal(r.stats.routingRulesCreated, 1);
  assert.equal(r.stats.playbooksCreated, 1);
});
