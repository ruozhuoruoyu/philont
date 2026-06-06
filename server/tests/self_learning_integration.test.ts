/**
 * 自学习闭环 E2E(数据面)集成测试
 *
 * 不调真 LLM:模拟 LLM 输出反思 JSON,验证从"反思蒸馏 → routing rule 写入 →
 * 下次同类任务命中注入"的端到端数据流。
 *
 * 重现 PDF 10 轮场景:
 *   Task 1: 扫描版 PDF → Word(agent 多方法尝试,最终 camscanner 成功)
 *           收口反思 → 写出 routing rule "无文本层 → camscanner"
 *   Task 2: 再来一份扫描版 PDF(同类任务)
 *           buildRoutingInjection 命中刚写的规则 → 注入 system 提示
 *
 * 实 LLM 端到端验证留给手工 / staging。本文件保证数据通路对的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  parseReflectionOutput,
  applyReflection,
  shouldTriggerReflection,
} from '../../agent-memory/src/index.js';
import { buildRoutingInjection } from '../src/routing_inject.js';
import { collectReflectionState } from '../src/reflection_runner.js';

test('E2E: PDF 10 轮 — 第 1 次反思写出 routing rule', () => {
  const memory = openMemoryDb(':memory:');

  // ── Task 1: 用户尝试转扫描版 PDF,3 种方法只有 camscanner 成功 ─────────
  // 模拟 LLM 反思输出
  const reflectionJson = JSON.stringify({
    had_lesson: true,
    task_signature: 'pdf-to-word',
    attempts: [
      {
        method: 'pdf2docx',
        context_features: '扫描版/无文本层',
        outcome: 'fail',
        failure_reason: '无文本层导致空 docx',
      },
      {
        method: '手写 pdfminer 脚本',
        context_features: '扫描版/含表格',
        outcome: 'fail',
        failure_reason: '表格列对齐错位',
      },
      {
        method: 'camscanner-pdf2office',
        context_features: '扫描版/含表格',
        outcome: 'success',
      },
    ],
    differentiator: '无文本层是关键判别 — pdf2docx 依赖文本层提取,扫描版必失败',
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: 'PDF 无文本层(扫描版/图片版)',
        prefer_skill: 'camscanner-pdf2office',
        avoid_skills: ['pdf2docx'],
        carveout: '不适用于含可选文本层的扫描版 PDF',
        evidence: '本次 turn 5-12 验证',
        self_confidence: 'tentative',
      },
      {
        type: 'playbook',
        lesson: 'PDF 转 Word 前必须先探测有无文本层',
        when_applies: '收到 PDF 转 Word 类请求',
        next_time_action: '先 pdftotext 探测,空则提示需 OCR',
        why_not_routing_rule: '这是横切原则,已有 routing_rule 覆盖具体路径',
      },
    ],
  });

  // 解析反思 JSON
  const parsed = parseReflectionOutput(reflectionJson);
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.equal(parsed.reflection?.taskSignature, 'pdf-to-word');

  // 应用反思 → 写入 stores
  const result = applyReflection(parsed.reflection!, {
    skills: memory.skills,
    routingRules: memory.routingRules,
    reflectionId: 'r-task1',
  });
  assert.equal(result.applied.length, 2);
  assert.equal(result.stats.routingRulesCreated, 1);
  assert.equal(result.stats.playbooksCreated, 1);
  assert.equal(result.errors.length, 0);

  // 验证 routing rule 落地
  const rules = memory.routingRules.listAll();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].confidence, 'tentative');
  assert.equal(rules[0].preferSkill, 'camscanner-pdf2office');
  assert.deepEqual(rules[0].avoidSkills, ['pdf2docx']);
  assert.match(rules[0].carveout, /不适用于含可选文本层/);
  assert.equal(rules[0].reflectionId, 'r-task1');

  // 验证 playbook 落地
  const allSkills = memory.skills.listAll();
  const playbooks = allSkills.filter((s) => s.maturity === 'playbook');
  assert.equal(playbooks.length, 1);
  assert.match(playbooks[0].source ?? '', /^self:reflect-r-task1$/);

  memory.close();
});

test('E2E: Task 2 — 扫描版 PDF 同类任务 → 命中 routing rule 注入', () => {
  const memory = openMemoryDb(':memory:');

  // 直接造一条 validated 规则模拟"已经验证过几次的经验"
  memory.routingRules.createRule({
    taskSignature: 'pdf-to-word',
    triggerCondition: 'PDF 无文本层 / 扫描版',
    preferSkill: 'camscanner-pdf2office',
    avoidSkills: ['pdf2docx'],
    carveout: '不适用于含可选文本层的扫描版',
    evidence: '前 3 次任务验证',
    confidence: 'validated',
    contextKeywords: ['pdf', 'word', 'scanned', '扫描', '扫描版'],
  });

  // 模拟 user 第二次问类似任务
  const userMessage = '帮我转一下扫描版 PDF 到 Word';
  const inj = buildRoutingInjection(userMessage, memory.routingRules);

  assert.ok(inj.matched >= 1, '应该命中至少 1 条规则');
  assert.match(inj.text, /历史经验路由/);
  assert.match(inj.text, /pdf-to-word/);
  assert.match(inj.text, /camscanner-pdf2office/);
  assert.match(inj.text, /pdf2docx/);
  assert.match(inj.text, /\[validated\]/);
  assert.match(inj.text, /不适用于含可选文本层/);

  memory.close();
});

test('E2E: Task 1 → Task 2 — 完整闭环(反思后下次同类任务收益)', () => {
  const memory = openMemoryDb(':memory:');

  // ── Task 1 收口反思 ─────────────────────────────────
  const reflection = {
    had_lesson: true,
    task_signature: 'web-scraping',
    attempts: [
      {
        method: 'fetch + cheerio',
        context_features: '静态 HTML 站',
        outcome: 'fail',
        failure_reason: 'JavaScript-rendered 内容获取不到',
      },
      {
        method: 'puppeteer',
        context_features: '动态 SPA',
        outcome: 'success',
      },
    ],
    differentiator: 'JavaScript-rendered → 必须 headless browser',
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: 'web scraping JavaScript-rendered SPA 站',
        prefer_skill: 'puppeteer',
        avoid_skills: ['fetch + cheerio'],
        carveout: '静态 HTML 站不需要,优先 cheerio',
        evidence: 'turn 3-7 验证',
        self_confidence: 'tentative',
      },
    ],
  };
  const parsed = parseReflectionOutput(JSON.stringify(reflection));
  assert.equal(parsed.ok, true);
  applyReflection(parsed.reflection!, {
    skills: memory.skills,
    routingRules: memory.routingRules,
    reflectionId: 'r-web-1',
  });

  // ── Task 2 用户问类似 ─────────────────────────────
  const userMessage2 = '帮我 scrape 一个 SPA 站的 javascript 渲染页面';
  const inj2 = buildRoutingInjection(userMessage2, memory.routingRules);
  assert.ok(inj2.matched >= 1);
  assert.match(inj2.text, /puppeteer/);

  // ── 模拟 LLM 这次按 routing rule 选 puppeteer 成功了 ───
  // chat-handler 在 LLM 用完规则后回报 success(此处直接调 store API,等价于
  // chat-handler 内某未来集成点)。tentative + 2 succ streak → validated。
  memory.routingRules.recordRuleOutcome(inj2.ruleIds[0], true);
  memory.routingRules.recordRuleOutcome(inj2.ruleIds[0], true);

  const rule = memory.routingRules.getById(inj2.ruleIds[0]);
  assert.equal(rule?.confidence, 'validated');
  assert.equal(rule?.successCount, 2);

  memory.close();
});

test('E2E: 反思失败模式 — LLM 输出无 carveout 的 routing rule 被拒', () => {
  const memory = openMemoryDb(':memory:');

  const badJson = JSON.stringify({
    had_lesson: true,
    task_signature: 't',
    attempts: [],
    learnings: [
      {
        type: 'routing_rule',
        trigger_condition: '某种条件',
        prefer_skill: 'somex',
        evidence: 'ev',
        // 故意省略 carveout
      },
    ],
  });

  const parsed = parseReflectionOutput(badJson);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => /carveout/.test(e)));

  // 验证没写入
  assert.equal(memory.routingRules.count(), 0);
  memory.close();
});

test('E2E: 反思 hadLesson=false 短路,不写任何东西', () => {
  const memory = openMemoryDb(':memory:');

  const noLessonJson = JSON.stringify({
    had_lesson: false,
    task_signature: 't',
    attempts: [{ method: 'm', context_features: 'c', outcome: 'success' }],
    learnings: [],
  });
  const parsed = parseReflectionOutput(noLessonJson);
  assert.equal(parsed.ok, true);
  const result = applyReflection(parsed.reflection!, {
    skills: memory.skills,
    routingRules: memory.routingRules,
  });
  assert.equal(result.applied.length, 0);
  assert.equal(memory.routingRules.count(), 0);
  assert.equal(memory.skills.count(), 0);

  memory.close();
});

test('E2E: 反思触发链 — collectState + shouldTrigger + parser + applier', () => {
  // 模拟一个触发反思的会话状态
  const messages = [
    { role: 'user' as const, content: '帮我转 PDF' },
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '⚠ TOOL FAILED: pdf2docx exit 1' },
      ],
    },
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', tool_use_id: 'b', content: '⚠ TOOL FAILED: 第二种方法也错' },
      ],
    },
    { role: 'user' as const, content: '完成' }, // task closing
  ];

  const state = collectReflectionState(messages as any, '完成');
  assert.equal(state.taskClosing, true);
  assert.equal(state.toolFailures, 2);

  const decision = shouldTriggerReflection(state);
  assert.equal(decision.shouldFire, true);
  assert.ok(decision.reasons.includes('task_closing'));
});

test('E2E: skill deprecate → invalidateBySkillName 把引用规则降为 retired', () => {
  const memory = openMemoryDb(':memory:');

  memory.skills.createSkill({
    name: 'old-pdf-tool',
    description: '旧的 PDF 工具',
    triggerKeywords: ['pdf'],
    actionTemplate: 'do x',
    maturity: 'stable',
  });
  const rule = memory.routingRules.createRule({
    taskSignature: 'pdf-to-word',
    triggerCondition: 'PDF 处理',
    preferSkill: 'old-pdf-tool',
    carveout: '...',
    evidence: '...',
    confidence: 'validated',
  });

  // 模拟 skill 经过 3 次连续失败被 deprecated → 触发 invalidateBySkillName
  memory.skills.recordSkillOutcome('old-pdf-tool', false);
  memory.skills.recordSkillOutcome('old-pdf-tool', false);
  memory.skills.recordSkillOutcome('old-pdf-tool', false);
  const skill = memory.skills.getByName('old-pdf-tool');
  assert.equal(skill?.maturity, 'deprecated');

  // 调用 invalidateBySkillName(模拟 chat-handler 在 deprecated 时主动清理规则)
  const n = memory.routingRules.invalidateBySkillName('old-pdf-tool');
  assert.equal(n, 1);
  const after = memory.routingRules.getById(rule.id);
  assert.equal(after?.confidence, 'retired');

  memory.close();
});
