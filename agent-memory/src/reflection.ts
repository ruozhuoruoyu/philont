/**
 * Reflection parsing + application
 *
 * Defines the "lesson distillation" JSON schema that the LLM is asked to output at task wrap-up,
 * and provides the three-phase responsibility of parsing, validation,
 * and application (writing to SkillStore + RoutingRuleStore).
 *
 * Flow:
 *   1. chat-handler detects reflection trigger conditions + passes budget gate
 *   2. Injects reflection signal, prompting LLM to output structured JSON (schema defined by this module)
 *   3. Server receives LLM output → parseReflectionOutput parses + validates
 *   4. Validation passes → applyReflection writes each learning to stores
 *   5. Validation fails → reject and record (prevent overgeneralization / fabrication)
 *
 * Key constraints (see plan.md track 1.6):
 *   - learning='routing_rule' must include carveout + evidence (enforced at write-time)
 *   - learning='new_skill' must include actionTemplate
 *   - LLM is not allowed direct SQL — goes through structured channel; serialization errors / missing fields all rejected
 *   - When multiple learnings fail within one reflection: fail-soft — successful ones written, failed ones listed in errors
 */

import type { SkillStore } from './skills.js';
import type { RoutingRuleStore } from './routing_rules.js';
import type { PlanStore } from './plans.js';
import type { SkillMaturity } from './types.js';

// ── Schema types ─────────────────────────────────────────────────────────

export interface ReflectionAttempt {
  method: string;
  contextFeatures: string;
  outcome: 'success' | 'fail';
  failureReason?: string;
}

export type ReflectionLearning =
  | RoutingRuleLearning
  | SkillRefineLearning
  | PlaybookLearning
  | NewSkillLearning
  | PlanRevisionLearning
  | PlanKnowledgeLearning;

export interface RoutingRuleLearning {
  type: 'routing_rule';
  triggerCondition: string;
  preferSkill?: string | null;
  avoidSkills?: string[];
  carveout: string;
  evidence: string;
  /** LLM self-assessed confidence tier, influences initial confidence */
  selfConfidence?: 'provisional' | 'tentative';
}

export interface SkillRefineLearning {
  type: 'skill_refine';
  /** Name of the existing skill */
  skill: string;
  /** Refined "when to use / when not to use" condition to append to description */
  newCondition: string;
}

export interface PlaybookLearning {
  type: 'playbook';
  /** Optional name; auto-generated as 'playbook-<task_sig>-<random>' if not provided */
  name?: string;
  lesson: string;
  /**
   * Required (2026-05-11): applicable scenario. Turns a playbook from "abstract reflection" into "triggerable micro-routing".
   * When rendered into the prefix's "## Lessons I've learned" section, LLM can judge whether to apply it.
   */
  whenApplies: string;
  /**
   * Required (2026-05-11): what to do next time this scenario is encountered. Converts the lesson's "negative takeaway" into a "positive action".
   */
  nextTimeAction: string;
  /**
   * Required (2026-05-11): LLM self-check — explain why it cannot be upgraded to routing_rule.
   * Forces LLM to surface lazy reasoning, and provides input signal for subsequent playbook → routing_rule re-distillation.
   */
  whyNotRoutingRule: string;
}

export interface NewSkillLearning {
  type: 'new_skill';
  name: string;
  description: string;
  triggerKeywords: string[];
  actionTemplate: string;
  /** Optional; defaults to draft (upgraded later via usage feedback) */
  maturity?: SkillMaturity;
}

/**
 * Plan knowledge learning (Phase 14, 2026-05-18): reflection distills from this turn's tool_results
 * "successfully called endpoints / learned auth schemes / gotchas", **writing to plan.md's
 * Operational Knowledge section** (append, hash dedup).
 *
 * This is the mechanism-layer fallback for the plan_knowledge tool: when LLM doesn't proactively call plan_knowledge,
 * reflection automatically extracts "high-value facts" from successful http / shell results within the turn and writes them to plan.md.
 *
 * Trigger scenario: `scheduled_success` (scheduled session + outcome=ok|partial + httpOk≥1).
 */
export interface PlanKnowledgeLearning {
  type: 'plan_knowledge';
  /** kebab-case project name (scheduled session takes from schedule.project) */
  project: string;
  /** Knowledge content (≤ 200 chars per entry) */
  entry: string;
  /** Category (endpoints / auth / gotchas / limits / general) */
  section?: 'endpoints' | 'auth' | 'gotchas' | 'limits' | 'general';
}

/**
 * Plan revision learning (v17, 2026-05-11): reflection discovers the current plan path is wrong,
 * revises steps for re-review. Called by applyReflection via PlanStore.revise.
 *
 * Trigger scenario: in-turn-reflection same-root-cause failures ≥ 2 / honesty / interrupt drain reflection,
 * current session has a plan with status='draft' or 'executing', LLM judges the plan should be changed.
 * (M3 / 2026-05-15: 'reviewed' intermediate state removed, only 4 states remain.)
 */
export interface PlanRevisionLearning {
  type: 'plan_revision';
  planId: string;
  /** Revised step list (full replacement, same semantics as plan_revise tool) */
  newSteps: Array<{ id?: string; description: string }>;
  /** Reason for revision (for subsequent diagnostics) */
  reason: string;
  /** Root cause tag that triggered this revision: 'tool_failure' | 'same_root_cause' | 'honesty' | 'step_timeout' | 'gap_check' */
  trigger?: string;
}

export interface ReflectionOutput {
  hadLesson: boolean;
  taskSignature: string;
  attempts: ReflectionAttempt[];
  differentiator?: string;
  learnings: ReflectionLearning[];
}

// ── Parsing / validation ────────────────────────────────────────────────────────

export interface ParseResult {
  ok: boolean;
  /** Returned on successful parse */
  reflection?: ReflectionOutput;
  /** Locatable error message on parse failure (shown to LLM on next iter so it can rewrite) */
  errors: string[];
}

/**
 * Tier-4 error tolerance: scan JSON character by character, identify "nested ASCII double quotes not escaped" and fix in place.
 *
 * Algorithm: when inside a string context (after opening " but before closing "), encounter ",
 * look ahead:
 *   - close context (whitespace + , } ] :) → truly closing
 *   - otherwise treat as nested quote, rewrite as \"
 *
 * Not perfect but sufficient for the most common LLM mistakes (`"summary": "researched the concept of "tool calls""`).
 * Unit tests cover typical cases; extremely nested structures may still fail to parse → let caller fall back to returning
 * errors.
 */
export function tryRepairAndParseJSON(text: string): unknown | null {
  if (typeof text !== 'string') return null;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const body = text.slice(first, last + 1);

  let result = '';
  let inString = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    // Skip escape sequences (already-escaped \" \\ \n etc.)
    if (ch === '\\' && i + 1 < body.length) {
      result += ch + body[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        result += ch;
        i++;
        continue;
      }
      // " inside a string — is it truly closing? Check following close context
      const tail = body.slice(i + 1, Math.min(i + 16, body.length));
      // close = immediately followed by comma / brace / bracket / colon (the latter for after "key") / whitespace then the above
      if (/^\s*[,}\]:]/.test(tail) || tail.length === 0) {
        inString = false;
        result += ch;
      } else {
        // nested quote → escape
        result += '\\"';
      }
      i++;
      continue;
    }
    result += ch;
    i++;
  }

  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Parse LLM output text into structured reflection.
 *
 * Error tolerance strategy:
 *   - Input is a JSON string → JSON.parse
 *   - Input is a string containing other text → extract the first ```json ... ``` code block and try parsing
 *   - Parse or validation fails → tier-4 repair of embedded quotes and retry
 *   - Still failing → return errors list, reflection is undefined
 */
export function parseReflectionOutput(text: string): ParseResult {
  const errors: string[] = [];
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, errors: ['reflection output is empty'] };
  }

  // Attempt 1: direct JSON.parse
  let raw: unknown = null;
  let parseError: string | null = null;
  try {
    raw = JSON.parse(text.trim());
  } catch (e) {
    parseError = String(e);
  }

  // Attempt 2: extract ```json ... ``` code block
  if (!raw) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1]) {
      try {
        raw = JSON.parse(fenced[1].trim());
        parseError = null;
      } catch (e) {
        parseError = String(e);
      }
    }
  }

  // Attempt 2b: opening fence without closing (truncated response or model ignoring instructions)
  if (!raw) {
    const opened = text.match(/^```(?:json)?\s*([\s\S]+)/);
    if (opened && opened[1]) {
      const inner = opened[1].replace(/```\s*$/, '').trim();
      const first = inner.indexOf('{');
      const last = inner.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try {
          raw = JSON.parse(inner.slice(first, last + 1));
          parseError = null;
        } catch (e) {
          parseError = String(e);
        }
      }
    }
  }

  // Attempt 3: extract JSON surrounded by { ... } (LLM occasionally omits fence)
  if (!raw) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        raw = JSON.parse(text.slice(firstBrace, lastBrace + 1));
        parseError = null;
      } catch (e) {
        parseError = String(e);
      }
    }
  }

  // Attempt 4 (2026-05-08): all strict JSON parse attempts failed → repair embedded unescaped double quotes and retry.
  // Common in practice: LLM writes `"task_signature": "researching the concept of "tool calls""`, the inner double quotes
  // are not escaped, JSON.parse immediately fails. This function scans the entire body, rewrites nested " as \"
  // then parses. Once reflection fails to parse → routing rule / playbook all lost, equivalent to
  // self-learning path 3 intermittently disabled.
  if (!raw) {
    const repaired = tryRepairAndParseJSON(text);
    if (repaired !== null && typeof repaired === 'object') {
      raw = repaired;
      parseError = null;
    }
  }

  if (!raw || typeof raw !== 'object') {
    errors.push(`Failed to parse as JSON object${parseError ? ': ' + parseError : ''}`);
    return { ok: false, errors };
  }

  // 字段校验
  const obj = raw as Record<string, unknown>;
  const reflection: Partial<ReflectionOutput> = {};

  if (typeof obj.had_lesson === 'boolean') {
    reflection.hadLesson = obj.had_lesson;
  } else if (typeof obj.hadLesson === 'boolean') {
    reflection.hadLesson = obj.hadLesson;
  } else {
    errors.push("Missing field 'had_lesson' (boolean)");
  }

  const sig = (obj.task_signature ?? obj.taskSignature) as unknown;
  if (typeof sig === 'string' && sig.trim().length > 0) {
    reflection.taskSignature = sig.trim();
  } else {
    errors.push("Missing field 'task_signature' (non-empty string)");
  }

  const attemptsRaw = (obj.attempts ?? []) as unknown;
  if (Array.isArray(attemptsRaw)) {
    reflection.attempts = attemptsRaw
      .map((a, i) => parseAttempt(a, i, errors))
      .filter((x): x is ReflectionAttempt => x !== null);
  } else {
    reflection.attempts = [];
  }

  if (typeof obj.differentiator === 'string') {
    reflection.differentiator = obj.differentiator;
  }

  const learningsRaw = (obj.learnings ?? []) as unknown;
  if (Array.isArray(learningsRaw)) {
    reflection.learnings = learningsRaw
      .map((l, i) => parseLearning(l, i, errors))
      .filter((x): x is ReflectionLearning => x !== null);
  } else {
    reflection.learnings = [];
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, reflection: reflection as ReflectionOutput, errors: [] };
}

function parseAttempt(
  raw: unknown,
  index: number,
  errors: string[],
): ReflectionAttempt | null {
  if (!raw || typeof raw !== 'object') {
    errors.push(`attempts[${index}] is not an object`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const method = typeof o.method === 'string' ? o.method.trim() : '';
  const contextFeatures =
    (typeof o.context_features === 'string' ? o.context_features
      : typeof o.contextFeatures === 'string' ? o.contextFeatures
      : '').trim();
  // outcome error tolerance (2026-05-08): LLM occasionally writes 'partial' / 'mixed' / 'pending' etc.
  // non-whitelisted values; previously rejecting the entire reflection segment was too strict. Now fallback:
  //   - 'success' / true / 'succeeded' → success
  //   - 'fail' / false / any other string value (including 'partial' 'mixed' 'unknown') → fail
  //   - failureReason missing but outcome=fail: extract a fragment from method as reason
  let outcome: 'success' | 'fail';
  if (o.outcome === 'success' || o.outcome === true || o.outcome === 'succeeded') {
    outcome = 'success';
  } else {
    outcome = 'fail'; // partial / mixed / unknown / any other value treated as fail (conservative)
  }
  const failureReason =
    typeof o.failure_reason === 'string' ? o.failure_reason
      : typeof o.failureReason === 'string' ? o.failureReason
      : undefined;

  if (!method) {
    errors.push(`attempts[${index}] missing method`);
    return null;
  }
  return { method, contextFeatures, outcome, failureReason };
}

function parseLearning(
  raw: unknown,
  index: number,
  errors: string[],
): ReflectionLearning | null {
  if (!raw || typeof raw !== 'object') {
    errors.push(`learnings[${index}] is not an object`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const type = o.type as unknown;

  if (type === 'routing_rule') {
    const triggerCondition = strField(o, 'trigger_condition', 'triggerCondition');
    const carveout = strField(o, 'carveout');
    const evidence = strField(o, 'evidence');
    if (!triggerCondition) {
      errors.push(`learnings[${index}] (routing_rule) missing trigger_condition`);
      return null;
    }
    if (!carveout) {
      errors.push(
        `learnings[${index}] (routing_rule) missing carveout — required at write time (prevents overgeneralization)`,
      );
      return null;
    }
    if (!evidence) {
      errors.push(
        `learnings[${index}] (routing_rule) missing evidence — rules must be traceable`,
      );
      return null;
    }
    const preferSkill = strField(o, 'prefer_skill', 'preferSkill') || null;
    const avoidRaw = (o.avoid_skills ?? o.avoidSkills) as unknown;
    const avoidSkills = Array.isArray(avoidRaw)
      ? avoidRaw.filter((x): x is string => typeof x === 'string')
      : [];
    const sc = (o.self_confidence ?? o.selfConfidence) as unknown;
    const selfConfidence: 'provisional' | 'tentative' | undefined =
      sc === 'provisional' || sc === 'tentative' ? sc : undefined;

    // 2026-05-11 relaxed: allow both prefer_skill and avoid_skills to be empty.
    // Practice (mycox honesty_fired reflection scenario) shows LLM often can only say "next time encountering X pay attention to Y",
    // but has no specific skill recommendation / avoidance (skill name momentarily forgotten). Previous hard validation would reject
    // the entire reflection → all lessons lost. Now allow "pure trigger_condition + carveout + evidence"
    // routing_rule (LLM still gets situational reminder when encountered, even without a specific skill route).
    //
    // This type of "pure avoidance" rule equals a refined playbook, but the routing_rule path has a 5-tier
    // confidence state machine + task signature index, making it more structured than playbook.
    return {
      type: 'routing_rule',
      triggerCondition,
      preferSkill,
      avoidSkills,
      carveout,
      evidence,
      selfConfidence,
    };
  }

  if (type === 'skill_refine') {
    const skill = strField(o, 'skill');
    const newCondition = strField(o, 'new_condition', 'newCondition');
    if (!skill) {
      errors.push(`learnings[${index}] (skill_refine) missing skill`);
      return null;
    }
    if (!newCondition) {
      errors.push(`learnings[${index}] (skill_refine) missing new_condition`);
      return null;
    }
    return { type: 'skill_refine', skill, newCondition };
  }

  if (type === 'playbook') {
    const lesson = strField(o, 'lesson');
    if (!lesson) {
      errors.push(`learnings[${index}] (playbook) missing lesson`);
      return null;
    }
    const whenApplies = strField(o, 'when_applies', 'whenApplies');
    if (!whenApplies) {
      errors.push(
        `learnings[${index}] (playbook) missing when_applies — required: specify the exact scenario where this lesson applies (makes the playbook triggerable)`,
      );
      return null;
    }
    const nextTimeAction = strField(o, 'next_time_action', 'nextTimeAction');
    if (!nextTimeAction) {
      errors.push(
        `learnings[${index}] (playbook) missing next_time_action — required: what to do next time (concrete action, not abstract principle)`,
      );
      return null;
    }
    const whyNotRoutingRule = strField(o, 'why_not_routing_rule', 'whyNotRoutingRule');
    if (!whyNotRoutingRule) {
      errors.push(
        `learnings[${index}] (playbook) missing why_not_routing_rule — playbook is fallback; must explain why it cannot be upgraded to routing_rule / new_skill / skill_refine`,
      );
      return null;
    }
    const name = strField(o, 'name') || undefined;
    return {
      type: 'playbook',
      name,
      lesson,
      whenApplies,
      nextTimeAction,
      whyNotRoutingRule,
    };
  }

  if (type === 'plan_revision') {
    const planId = strField(o, 'plan_id', 'planId');
    const reason = strField(o, 'reason');
    if (!planId) {
      errors.push(`learnings[${index}] (plan_revision) missing plan_id`);
      return null;
    }
    if (!reason) {
      errors.push(`learnings[${index}] (plan_revision) missing reason`);
      return null;
    }
    const rawSteps = (o.new_steps ?? o.newSteps) as unknown;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      errors.push(
        `learnings[${index}] (plan_revision) missing new_steps (non-empty array required)`,
      );
      return null;
    }
    const newSteps: Array<{ id?: string; description: string }> = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const s = rawSteps[i];
      if (!s || typeof s !== 'object') {
        errors.push(`learnings[${index}].new_steps[${i}] is not an object`);
        return null;
      }
      const so = s as Record<string, unknown>;
      const desc = so.description;
      if (typeof desc !== 'string' || desc.trim().length === 0) {
        errors.push(`learnings[${index}].new_steps[${i}] missing description`);
        return null;
      }
      newSteps.push({
        id: typeof so.id === 'string' ? so.id.trim() : undefined,
        description: desc.trim(),
      });
    }
    const triggerRaw = (o.trigger as unknown) ?? null;
    const trigger =
      typeof triggerRaw === 'string' && triggerRaw.trim()
        ? triggerRaw.trim()
        : undefined;
    return { type: 'plan_revision', planId, newSteps, reason, trigger };
  }

  if (type === 'new_skill') {
    const name = strField(o, 'name');
    const description = strField(o, 'description');
    const actionTemplate = strField(o, 'action_template', 'actionTemplate');
    const triggerRaw = (o.trigger_keywords ?? o.triggerKeywords) as unknown;
    const triggerKeywords = Array.isArray(triggerRaw)
      ? triggerRaw.filter((x): x is string => typeof x === 'string')
      : [];

    if (!name || !description || !actionTemplate) {
      errors.push(
        `learnings[${index}] (new_skill) must include name / description / action_template`,
      );
      return null;
    }
    const matRaw = o.maturity as unknown;
    const maturity: SkillMaturity | undefined =
      matRaw === 'draft' || matRaw === 'confirmed' || matRaw === 'stable' ||
      matRaw === 'playbook' || matRaw === 'deprecated'
        ? matRaw
        : undefined;
    return {
      type: 'new_skill',
      name,
      description,
      triggerKeywords,
      actionTemplate,
      maturity,
    };
  }

  if (type === 'plan_knowledge') {
    const project = strField(o, 'project');
    const entry = strField(o, 'entry');
    const sectionRaw = strField(o, 'section');
    if (!project) {
      errors.push(`learnings[${index}] (plan_knowledge) missing project (kebab-case project name)`);
      return null;
    }
    if (!entry) {
      errors.push(`learnings[${index}] (plan_knowledge) missing entry (knowledge content)`);
      return null;
    }
    const validSections = ['endpoints', 'auth', 'gotchas', 'limits', 'general'] as const;
    const section = (validSections as readonly string[]).includes(sectionRaw)
      ? (sectionRaw as PlanKnowledgeLearning['section'])
      : 'general';
    return { type: 'plan_knowledge', project, entry, section };
  }

  errors.push(`learnings[${index}] unknown type: ${String(type)}`);
  return null;
}

function strField(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
  }
  return '';
}

// ── Application (reducer) ─────────────────────────────────────────────────────

export interface ApplyContext {
  skills: SkillStore;
  routingRules: RoutingRuleStore;
  /** v17 (2026-05-11): PlanStore, supports plan_revision learning type */
  plans?: PlanStore;
  /**
   * Phase 14 (2026-05-18): PlanFileStore, supports plan_knowledge learning type.
   * If not provided = plan_knowledge learning fails (goes into errors, does not block other learnings).
   */
  planFiles?: {
    appendKnowledge: (project: string, entry: string, subsection?: string) => boolean;
  };
  /** Reflection event id, written to routing_rules.reflection_id */
  reflectionId?: string;
}

export interface ApplyReflectionOptions {
  /**
   * 2026-05-15: turn was force-degraded by the mechanism layer (plan-circuit-breaker / in-turn-block
   * unrecovered / plan auto-close failure) → reject new_skill / skill_refine distillation paths,
   * preventing failed approaches from being solidified into skills and repeatedly applied.
   *
   * When triggered: learning is skipped, errors records `degraded-turn:...` reason.
   */
  turnDegraded?: boolean;
}

export interface ApplyResult {
  /** Successfully written learnings (indexed to match original array) */
  applied: number[];
  /** Failed learnings (index + error message) */
  errors: Array<{ index: number; error: string }>;
  /** Detailed statistics */
  stats: {
    routingRulesCreated: number;
    skillsRefined: number;
    playbooksCreated: number;
    newSkillsCreated: number;
    /** v17: number of plan_revision entries successfully applied */
    plansRevised: number;
    /** Phase 14: number of plan_knowledge entries written (truly new after dedup) */
    planKnowledgeWritten: number;
  };
}

/**
 * Apply the parsed reflection to stores.
 *
 * fail-soft: a single learning write failure does not affect others; failure reason recorded in errors return.
 *
 * Not applied when:
 *   - hadLesson=false → return empty result immediately (LLM explicitly declares no lesson)
 *   - learnings array is empty → same as above
 */
export function applyReflection(
  reflection: ReflectionOutput,
  ctx: ApplyContext,
  opts: ApplyReflectionOptions = {},
): ApplyResult {
  const result: ApplyResult = {
    applied: [],
    errors: [],
    stats: {
      routingRulesCreated: 0,
      skillsRefined: 0,
      playbooksCreated: 0,
      newSkillsCreated: 0,
      plansRevised: 0,
      planKnowledgeWritten: 0,
    },
  };

  if (!reflection.hadLesson || reflection.learnings.length === 0) {
    return result;
  }

  reflection.learnings.forEach((learning, i) => {
    try {
      // 2026-05-15: degraded turn rejects positive skill distillation (new_skill / skill_refine).
      // Failure path distilled into skill → re-applied via use_skill next time → same error infinite loop.
      // Allowed: routing_rule(carveout) + playbook(failure_lesson) + plan_revision.
      if (opts.turnDegraded && (learning.type === 'new_skill' || learning.type === 'skill_refine')) {
        result.errors.push({
          index: i,
          error: `degraded-turn: rejected ${learning.type} — this turn was force-closed by the mechanism layer (failure path); distilling positive skills is forbidden. Produce routing_rule(carveout) or playbook(failure_lesson) instead.`,
        });
        return;
      }
      switch (learning.type) {
        case 'routing_rule': {
          ctx.routingRules.createRule({
            taskSignature: reflection.taskSignature,
            triggerCondition: learning.triggerCondition,
            preferSkill: learning.preferSkill ?? null,
            avoidSkills: learning.avoidSkills ?? [],
            carveout: learning.carveout,
            evidence: learning.evidence,
            confidence: learning.selfConfidence ?? 'provisional',
            reflectionId: ctx.reflectionId ?? null,
          });
          result.stats.routingRulesCreated++;
          break;
        }
        case 'skill_refine': {
          const existing = ctx.skills.getByName(learning.skill);
          if (!existing) {
            throw new Error(`skill '${learning.skill}' does not exist, cannot refine`);
          }
          // Append new_condition to end of description (separated visually with newline + ▸)
          const newDesc = existing.description.includes(learning.newCondition)
            ? existing.description
            : `${existing.description}\n▸ ${learning.newCondition}`;
          ctx.skills.updateSkill(learning.skill, { description: newDesc });
          result.stats.skillsRefined++;
          break;
        }
        case 'playbook': {
          const name =
            learning.name ||
            `playbook-${reflection.taskSignature}-${shortHash(learning.lesson)}`;
          // already exists → skip (playbook rewrite is more likely redundant, not an update)
          if (ctx.skills.getByName(name)) {
            throw new Error(`playbook '${name}' already exists, skipping`);
          }
          // 2026-05-11: join whenApplies + nextTimeAction into description, so that when
          // prefix renders the "## Lessons I've learned" section, LLM sees the complete actionable lesson,
          // not just an abstract lesson sentence. why_not_routing_rule goes into actionTemplate
          // at the end for traceability (for subsequent playbook → routing_rule re-distillation).
          const description = [
            learning.lesson,
            `Applies when: ${learning.whenApplies}`,
            `Next time: ${learning.nextTimeAction}`,
          ].join('\n');
          const actionTemplate = [
            description,
            `[Why not routing_rule] ${learning.whyNotRoutingRule}`,
          ].join('\n');
          ctx.skills.createSkill({
            name,
            description,
            triggerKeywords: [],
            actionTemplate,
            maturity: 'playbook',
            source: ctx.reflectionId ? `self:reflect-${ctx.reflectionId}` : null,
          });
          result.stats.playbooksCreated++;
          break;
        }
        case 'plan_revision': {
          if (!ctx.plans) {
            throw new Error('plan_revision learning requires ApplyContext.plans');
          }
          // M4 (2026-05-15) plans.revise adds newDeliverables parameter; reflection-distilled
          // plan_revision does not change deliverables (only changed when LLM proactively calls plan_revise)
          const updated = ctx.plans.revise(
            learning.planId,
            learning.newSteps,
            null,
            learning.reason,
          );
          if (!updated) {
            throw new Error(
              `plan '${learning.planId}' does not exist or is already completed/failed (cannot revise)`,
            );
          }
          result.stats.plansRevised++;
          break;
        }
        case 'new_skill': {
          if (ctx.skills.getByName(learning.name)) {
            throw new Error(`new_skill '${learning.name}' already exists`);
          }
          // MECE check (v17, 2026-05-11): search for existing skills with high similarity to this task;
          // if found, automatically downgrade to refine — append to description, don't create new. Avoid skill library bloat.
          const dupes = ctx.skills.findDuplicateCandidates(
            learning.name,
            learning.description,
          );
          if (dupes.length > 0) {
            const existing = dupes[0].skill;
            const addendum =
              `\n▸ [refined by reflection${ctx.reflectionId ? ' ' + ctx.reflectionId : ''}] ` +
              `${learning.description}`;
            const newDesc = existing.description.includes(learning.description)
              ? existing.description
              : existing.description + addendum;
            ctx.skills.updateSkill(existing.name, { description: newDesc });
            // Count as skillsRefined, not newSkillsCreated (MECE downgrade semantics)
            result.stats.skillsRefined++;
            break;
          }
          ctx.skills.createSkill({
            name: learning.name,
            description: learning.description,
            triggerKeywords: learning.triggerKeywords,
            actionTemplate: learning.actionTemplate,
            maturity: learning.maturity ?? 'draft',
            source: ctx.reflectionId ? `self:reflect-${ctx.reflectionId}` : null,
          });
          result.stats.newSkillsCreated++;
          break;
        }
        case 'plan_knowledge': {
          if (!ctx.planFiles) {
            throw new Error('plan_knowledge learning requires ApplyContext.planFiles');
          }
          const project = (learning.project || '').trim();
          const entry = (learning.entry || '').trim();
          if (!project || !entry) {
            throw new Error('plan_knowledge: project / entry are required');
          }
          if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(project)) {
            throw new Error(
              `plan_knowledge: project must be kebab-case, received "${project}"`,
            );
          }
          if (entry.length > 500) {
            throw new Error(
              `plan_knowledge: entry too long (${entry.length} > 500)`,
            );
          }
          const added = ctx.planFiles.appendKnowledge(
            project,
            entry,
            learning.section ?? 'general',
          );
          if (added) result.stats.planKnowledgeWritten++;
          break;
        }
      }
      result.applied.push(i);
    } catch (e) {
      result.errors.push({ index: i, error: String(e) });
    }
  });

  return result;
}

/** Simple short hash (8-char base36), used only for playbook auto-naming, not for cryptographic purposes. */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36).padStart(6, '0').slice(0, 8);
}

// ── Trigger condition evaluation (pure function, called by chat-handler) ────────────────────────

export interface ReflectionTriggerInput {
  /** Number of turns elapsed in this task/session */
  turnCount: number;
  /** Number of tool failures so far in this task */
  toolFailures: number;
  /** Whether this turn is wrapping up (pursuit closed / user expressed "done") */
  taskClosing: boolean;
  /** Whether HonestyGate was triggered this turn */
  honestyFired: boolean;
  /** InterruptDrainer drained due to consecutive failures */
  interruptDrained: boolean;
  /** Same-root-cause failure count (count of consecutive failures with high keyword overlap in error/failure_reason) */
  sameRootCauseFailures: number;
  /** Task duration in minutes */
  taskDurationMin: number;
  /**
   * 2026-05-15: whether this turn was force-degraded by the mechanism layer (plan-circuit-breaker fired /
   * in-turn-tool-block fired + unrecovered / plan auto-close failure).
   *
   * true → reflection takes the "negative distillation" path:
   *   - prompt uses degraded template (explicitly states "this turn is a failure path, not a success experience")
   *   - applyReflection rejects new_skill / skill_refine (prevents failed approaches from being distilled into skills)
   *   - only routing_rule(carveout) + playbook(failure_lesson) allowed
   *
   * Computed and forwarded by chat-handler at turn wrap-up based on signalBus; default undefined ≡ false.
   */
  turnDegraded?: boolean;
  /**
   * Phase 14 (2026-05-18): scheduled session turn successfully completed (httpOk ≥ 1 + outcome=ok/partial).
   *
   * true → reflection takes the "successful endpoint distillation" path (new trigger):
   *   - prompt hints "this turn LLM successfully called a batch of endpoints, distill success_endpoints from tool_results"
   *   - applyReflection writes success_endpoints list to the corresponding project's plan.md
   *     Operational Knowledge section (auto dedup)
   *   - this is the mechanism-layer fallback: even when LLM doesn't proactively call plan_knowledge, the mechanism layer distills from tool_result
   *
   * Computed and forwarded by chat-handler at turn wrap-up based on schedule outcome.
   */
  scheduledSuccess?: boolean;
}

export interface ReflectionTriggerDecision {
  shouldFire: boolean;
  /** Trigger reasons (for audit; empty array means no trigger) */
  reasons: string[];
}

/**
 * Evaluate whether reflection should be triggered.
 *
 * Any entry condition hit + budget gate passed → trigger.
 *
 * Entry conditions:
 *   1. Task closing (taskClosing)
 *   2. Same-root-cause failures ≥ 3
 *   3. HonestyGate triggered
 *   4. InterruptDrainer drained
 *   5. turn ≥ 15 OR duration ≥ 20 min
 *
 * Budget gate (must satisfy any one):
 *   - Task ≥ 3 turns
 *   - ≥ 1 tool failure
 *   - Task closing itself passes through (closing reflection is always valuable)
 */
export function shouldTriggerReflection(
  input: ReflectionTriggerInput,
): ReflectionTriggerDecision {
  const reasons: string[] = [];

  if (input.taskClosing) reasons.push('task_closing');
  if (input.sameRootCauseFailures >= 3) reasons.push('same_root_cause_failures');
  if (input.honestyFired) reasons.push('honesty_fired');
  if (input.interruptDrained) reasons.push('interrupt_drained');
  if (input.turnCount >= 15) reasons.push('long_turn_count');
  if (input.taskDurationMin >= 20) reasons.push('long_duration');
  if (input.turnDegraded === true) reasons.push('turn_degraded');
  // Phase 14: scheduled session successful turn also triggers — capture "endpoints that just ran successfully" as success_endpoints distillation
  if (input.scheduledSuccess === true) reasons.push('scheduled_success');

  if (reasons.length === 0) {
    return { shouldFire: false, reasons };
  }

  // Budget gate
  const passesBudget =
    input.taskClosing ||
    input.turnCount >= 3 ||
    input.toolFailures >= 1 ||
    // Phase 14: scheduled success has intrinsic value (successful endpoint distillation = long-term ROI),
    // bypasses budget gate. Even with turnCount=1 + no failures, endpoint knowledge is still worth distilling.
    input.scheduledSuccess === true;

  if (!passesBudget) {
    return { shouldFire: false, reasons: [`budget_gate_failed (${reasons.join(',')})`] };
  }

  return { shouldFire: true, reasons };
}

// ── reflection prompt template ──────────────────────────────────────────────

/**
 * Generate a targeted hint based on trigger reasons.
 *
 * Different trigger reasons suggest different optimal output types — same_root_cause almost always means routing_rule,
 * task_closing tends toward new_skill / refine, honesty triggers focus on preventing the same error next time.
 * Share this prior with the LLM to prevent it from defaulting to the easiest playbook fallback.
 */
function inferReasonsHint(reasons: string[]): string {
  if (reasons.includes('same_root_cause_failures')) {
    return (
      `**This reflection was triggered by \`same_root_cause_failures\`** — the same root cause failure has recurred repeatedly.\n` +
      `This suggests there is a **identifiable discriminating condition** (what differs between this failure and a past success).\n` +
      `**routing_rule is almost certainly the preferred output**; playbook should not be the answer.`
    );
  }
  if (reasons.includes('honesty_fired')) {
    return (
      `**This reflection was triggered by \`honesty_fired\`** — the previous reply was suspected of dishonesty (completion claim / fabricated data / unverified assertion).\n` +
      `Reflect on: **use routing_rule or skill_refine to prevent recurrence**. For example, hard constraints like "must stat before claiming file size".`
    );
  }
  if (reasons.includes('interrupt_drained')) {
    return (
      `**This reflection was triggered by \`interrupt_drained\`** — intrinsic observations (K7 signals) have accumulated.\n` +
      `Reflect on: do these observations reveal routing decision blind spots worth writing as routing_rule?`
    );
  }
  if (reasons.includes('task_closing')) {
    return (
      `**This reflection was triggered by \`task_closing\`** — task wrap-up.\n` +
      `Reflect on: what new workflow did this task prove out? Is it worth solidifying as **new_skill** (complete step template)\n` +
      `or **routing_rule** (which path to take next time)?`
    );
  }
  if (reasons.includes('scheduled_success')) {
    return (
      `**This reflection was triggered by \`scheduled_success\`** (Phase 14, 2026-05-18) — ≥ 1 tool call succeeded in this scheduled session.\n` +
      `**Preferred output: \`plan_knowledge\`** — distill from this turn's ✓ TOOL OK http/shell results the "successfully called endpoints / auth scheme", write to ` +
      `project plan.md Operational Knowledge section; auto-injected into prefix on next fire.\n` +
      `**Extraction rules**:\n` +
      `  - http 200/201 + complete method + url + key headers → one line in endpoints section\n` +
      `  - Confirmed auth scheme (header name + value placeholder) → one line in auth section\n` +
      `  - Repeated 4xx/5xx but already worked around endpoint → one line in gotchas section\n` +
      `**Don't be lazy**: don't produce only playbook — the purpose of scheduled sessions is to accumulate endpoint cookbook; playbook won't help on next fire.`
    );
  }
  return `**This reflection was triggered by \`${reasons.join(', ')}\`**. Prefer routing_rule / new_skill / skill_refine first.`;
}

/**
 * The system prompt text the LLM reads after a reflection signal is triggered.
 *
 * chat-handler appends this to the end of messages[0] when triggered, and the LLM's next reply
 * will output according to this schema. This function generates the "prompt + schema example".
 *
 * 2026-05-11 constitution revision: reverse the output incentive structure. Old version defaulted to guiding LLM to write playbook
 * (fewest fields, lowest barrier), resulting in 100% playbook in practice but invisible on next turn. New version:
 *   1. Show 4 output types ranked by "action value", routing_rule first
 *   2. playbook gains 3 required fields (when_applies / next_time_action / why_not_routing_rule)
 *      → writing playbook now costs more effort than routing_rule, pushing the path of least resistance toward high-value outputs
 *   3. Explicitly tell LLM what "should be produced this time" based on reasons
 */
/**
 * 降级反思 prompt:turn 被机制层强制收尾(circuit-breaker / in-turn-block 无恢复 /
 * auto-close failure)。这种 turn 的工具序列 = 失败链路,不是成功经验。
 *
 * 与原 prompt 的差异:
 *   - 明确告诉 LLM "本 turn 失败收尾,蒸馏的是要避免的反模式"
 *   - 禁产 new_skill / skill_refine(applyReflection 会拒收;prompt 也明示)
 *   - 只允许产 routing_rule(carveout 形式)+ playbook(failure_lesson)
 *
 * 2026-05-15:防止"reflection 把错误做法蒸馏成 skill,LLM 反复套用错 skill"
 * 死循环。实战 mycox-heartbeat 把 api_key_prefix 当完整 key 拼,被蒸馏成
 * mycox-heartbeat-check skill,然后每次 use_skill 撞同款错。
 */
function renderDegradedReflectionPrompt(reasons: string[]): string {
  return (
    `\n\n## ⚠️ Reflection triggered (degraded path, reason: ${reasons.join(', ')})\n\n` +
    `**This turn was force-closed by the mechanism layer** (plan-circuit-breaker / in-turn-tool-block unrecovered / plan auto-close failure).\n` +
    `This means the tool sequence in this turn was **a failure path, not a success**.\n\n` +
    `### ⛔ Forbidden outputs\n` +
    `  - **new_skill** — failure paths cannot be solidified into skill templates (will be re-applied via use_skill, causing infinite loops)\n` +
    `  - **skill_refine** — the "experience" of a failed turn cannot be used to augment existing skills\n\n` +
    `### ✅ Allowed outputs (one or both)\n\n` +
    `**1. routing_rule (carveout form) — best**\n` +
    `   Describe "avoid tool Y / method Y under condition X". Next time a similar task hits this rule, it will be guided away.\n` +
    `   Example: LLM used api_key_prefix as a full key → routing_rule\n` +
    `   triggerCondition="outbound http requiring secret auth"\n` +
    `   carveout="Do not use *_prefix / *_token_prefix fact fields directly; Authorization must use {credential-name} placeholder"\n\n` +
    `**2. playbook (failure_lesson) — fallback**\n` +
    `   Only use when you cannot write a specific routing_rule trigger. lesson must explicitly state "root cause of this failure + what to avoid next time".\n\n` +
    `### JSON Schema (degraded version, only 2 types) — output raw JSON, no fences\n\n` +
    `{\n` +
    `  "had_lesson": true,\n` +
    `  "task_signature": "<short task label>",\n` +
    `  "attempts": [{\n` +
    `    "method": "<method used in this turn>",\n` +
    `    "context_features": "<key scenario that triggered this failure>",\n` +
    `    "outcome": "failed",\n` +
    `    "failure_reason": "<root cause, precise rather than 'unknown error'>"\n` +
    `  }],\n` +
    `  "differentiator": "<key discriminating condition distinguishing 'failure path' from 'future correct path'>",\n` +
    `  "learnings": [\n` +
    `    {\n` +
    `      "type": "routing_rule",\n` +
    `      "trigger_condition": "<what scenario>",\n` +
    `      "avoid_skills": ["<skill name exposed as inappropriate by this failure>"],\n` +
    `      "carveout": "<specific avoidance action>",\n` +
    `      "evidence": "<concrete evidence of this turn's failure>",\n` +
    `      "self_confidence": "provisional"\n` +
    `    },\n` +
    `    {\n` +
    `      "type": "playbook",\n` +
    `      "lesson": "<root cause of this failure + what to avoid next time>",\n` +
    `      "when_applies": "<when this lesson applies>",\n` +
    `      "next_time_action": "<what exactly to do next time>",\n` +
    `      "why_not_routing_rule": "<why this cannot be upgraded to routing_rule>"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n`
  );
}

export function renderReflectionPrompt(
  reasons: string[],
  turnDegraded = false,
): string {
  if (turnDegraded) {
    return renderDegradedReflectionPrompt(reasons);
  }
  const hint = inferReasonsHint(reasons);
  return (
    `\n\n## ⚠️ Reflection triggered (reason: ${reasons.join(', ')})\n` +
    `${hint}\n\n` +
    `In your next reply, **output raw JSON only** — no markdown fences, no prose, no \`\`\`json wrapper.\n` +
    `The system will parse and write it to memory, **actually changing future behavior**.\n\n` +
    `### Output types ranked by "action value" (highest to lowest)\n\n` +
    `**1. routing_rule — most valuable**\n` +
    `   Describes which path to take in the future. Auto-injected as a recommendation at task start; guides the same type of task next time.\n` +
    `   When to use: this failure exposed a discriminating condition like "use skill X / avoid skill Y in scenario Z".\n` +
    `   Example: webFetch of service docs was blocked by aux LLM distillation → routing_rule "service API doc: use http GET not webFetch".\n\n` +
    `**2. new_skill — high value**\n` +
    `   Solidify the complete steps discovered this time into a SKILL.md template callable via use_skill.\n` +
    `   When to use: proved out a new workflow (registration / onboarding / report generation) that you want to call directly next time rather than rediscovering.\n\n` +
    `**3. skill_refine — medium value**\n` +
    `   Add "when to use / when not to use" refinements to an existing skill, giving routing injection a more precise boundary.\n` +
    `   When to use: a skill succeeded in scenario X and failed in scenario Y; you want the next recommendation to know the X/Y boundary.\n\n` +
    `**4. playbook — ⚠️ fallback, only when none of the above apply**\n` +
    `   Cross-cutting principles / abstract lessons; last resort when no specific trigger condition or skill can be identified.\n` +
    `   **Must include why_not_routing_rule field explaining why it cannot be upgraded**.\n\n` +
    `**5. plan_revision — only when this turn's context shows an active plan (v17 complex task protocol)**\n` +
    `   Reflection reveals the current plan path is untenable; revise steps. Include plan_id + new_steps + reason.\n` +
    `   Not mutually exclusive with 1-4 (same reflection can produce routing_rule + plan_revision simultaneously).\n\n` +
    `### JSON Schema\n\n` +
    `{\n` +
    `  "had_lesson": true,\n` +
    `  "task_signature": "<short task label, e.g. 'service-api-doc-fetch'>",\n` +
    `  "attempts": [\n` +
    `    { "method": "...", "context_features": "...", "outcome": "fail", "failure_reason": "..." },\n` +
    `    { "method": "...", "context_features": "...", "outcome": "success" }\n` +
    `  ],\n` +
    `  "differentiator": "what condition caused A to fail and B to succeed",\n` +
    `  "learnings": [\n` +
    `    // ★ Preferred: routing_rule\n` +
    `    {\n` +
    `      "type": "routing_rule",\n` +
    `      "trigger_condition": "<must include ≥1 specific discriminating feature>",\n` +
    `      "prefer_skill": "<existing skill name, optional; fill null if no specific recommendation>",\n` +
    `      "avoid_skills": ["...optional; leave empty array if no specific skill to avoid"],\n` +
    `      "carveout": "<required: this rule does not apply to...>",\n` +
    `      "evidence": "<required: which specific observation this is based on>",\n` +
    `      "self_confidence": "tentative"\n` +
    `    },\n` +
    `    // or: new_skill\n` +
    `    {\n` +
    `      "type": "new_skill",\n` +
    `      "name": "kebab-case-name",\n` +
    `      "description": "...",\n` +
    `      "trigger_keywords": ["..."],\n` +
    `      "action_template": "<complete step template>"\n` +
    `    },\n` +
    `    // or: skill_refine (add refined conditions to existing skill)\n` +
    `    {\n` +
    `      "type": "skill_refine",\n` +
    `      "skill": "<existing-skill-name>",\n` +
    `      "new_condition": "..."\n` +
    `    },\n` +
    `    // In complex task protocol: plan_revision (when turn context shows an active plan)\n` +
    `    {\n` +
    `      "type": "plan_revision",\n` +
    `      "plan_id": "<plan_id seen in this turn's context>",\n` +
    `      "new_steps": [{ "description": "..." }],\n` +
    `      "reason": "why the plan should be changed (specific root cause)",\n` +
    `      "trigger": "same_root_cause"\n` +
    `    },\n` +
    `    // Phase 14: plan_knowledge (strongly recommended when scheduled session successfully called a new endpoint)\n` +
    `    {\n` +
    `      "type": "plan_knowledge",\n` +
    `      "project": "<kebab-case project name, e.g. mycox>",\n` +
    `      "entry": "POST /api/posts/<id>/upvote, headers {X-API-Key: {mycox-api-key}} → 200",\n` +
    `      "section": "endpoints"  // or auth / gotchas / limits / general\n` +
    `    },\n` +
    `    // ⚠ Only when none of the above apply — playbook (fallback, 3 required fields)\n` +
    `    {\n` +
    `      "type": "playbook",\n` +
    `      "lesson": "<one-sentence lesson>",\n` +
    `      "when_applies": "<required: exact scenario where this lesson applies>",\n` +
    `      "next_time_action": "<required: what to do next time (concrete action)>",\n` +
    `      "why_not_routing_rule": "<required: why this lesson cannot be upgraded to routing_rule / new_skill / skill_refine>"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `### Key constraints\n\n` +
    `- **routing_rule is preferred** — when you see a "two different results for the same task" discriminating condition, write routing_rule, not playbook\n` +
    `- **playbook is fallback** — choosing it requires filling why_not_routing_rule explaining why it cannot be upgraded\n` +
    `- If you cannot write a carveout, do not force a routing_rule (prevents overgeneralization); but **try first** — in most cases a reasonable carveout can be found\n` +
    `- **routing_rule's prefer_skill / avoid_skills are both optional** (2026-05-11): filling null / empty array when no specific skill recommendation is compliant; trigger_condition + carveout + evidence are sufficient. Don't give up writing routing_rule in favor of playbook just because you can't recall a skill name\n` +
    `- No real lesson → directly \`{"had_lesson": false, "task_signature": "...", "attempts": [], "learnings": []}\`\n` +
    `- Don't fabricate attempts; only list methods actually tried in this task\n`
  );
}
