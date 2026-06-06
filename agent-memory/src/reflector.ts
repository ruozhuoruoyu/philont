/**
 * SessionReflector: skill reflection extraction after session ends
 *
 * Difference from SessionExtractor:
 *   - SessionExtractor: extracts **facts** (user.name = "John Doe")
 *   - SessionReflector: extracts **skills** ("deployment workflow" → recipe)
 *
 * Flow:
 *   1. Read Layer 0.5 action log (tool call history for this session)
 *   2. Call LLM once:
 *      "Look at this session — are there any reusable action patterns?"
 *   3. LLM returns skill list (JSON)
 *   4. Write to memory_skills (create or update)
 *
 * Design principles:
 *   - Quality first: extract fewer, don't generate noisy skills
 *   - Reversible: every skill has a name, user can delete/edit
 *   - No side effects: reflection failure does not affect fact extraction
 */

import type { SkillStore } from './skills.js';
import type { ActionLog } from './actions.js';
import type { RawStore } from './raw.js';
import type { ExtractorLlmClient } from './extractor.js';
import type { Action, RawMessage, ReflectResult, Skill } from './types.js';
import type { MemoryAuditHook } from './audit.js';

// ── LLM-returned skill spec ─────────────────────────────────────────────────

interface ReflectedSkill {
  name: string;
  description: string;
  trigger_keywords: string[];
  action_template: string;
  kind?: 'positive' | 'negative';
}

// ── Prompt ─────────────────────────────────────────────────────────────

const REFLECT_INSTRUCTIONS = `You are a skill-reflection assistant. Your task is to analyze the **user-assistant conversation + tool call history** below and identify two types of distillable patterns:

1. **Positive skills (kind='positive')** — reusable action templates for achieving goals
2. **Anti-patterns / lessons (kind='negative')** — behaviors the user corrected; avoid them when a similar situation arises next time

---

## Positive skills (kind='positive')

**What is it?**
- A set of action steps that accomplish a specific goal
- Something that can be re-executed in the future when a similar goal arises
- Examples: "Deploy a Rust project", "Debug TypeScript compilation errors", "Check git status and push"

**What is it not?** (do NOT extract)
- One-off small talk or Q&A
- Just reading a file or replying with a single message
- Arbitrary operations with no clear goal

---

## Anti-patterns / lessons (kind='negative')

**Recognition signals**: scan **adjacent message pairs** in the conversation—
- Assistant said X / executed X
- User immediately corrected: "that's wrong / it should be / don't do that again / next time / no / mistake / that's not what I asked..."

Only extract when it can be **generalized into "what to do next time in a similar situation"**; one-off specific corrections (wrong name, wrong path) should not be recorded.

**The action_template for anti-patterns must strictly follow this three-section markdown structure** (exact heading text required for programmatic parsing):

\`\`\`markdown
## Trigger
<what situation / user statement makes you prone to this mistake>

## Avoid
<specific wrong behavior: what not to do>

## Instead
<correct behavior: what to do instead; may specify tools or steps to use>
\`\`\`

Example (user said "have the report ready tomorrow", but assistant immediately produced the report):

\`\`\`markdown
## Trigger
User uses relative time words like "tomorrow / day after tomorrow / next week X" to assign tasks

## Avoid
Immediately produce the complete output in the current conversation

## Instead
Call schedule_reminder or create_calendar_event to schedule for the user-specified time; current response only needs to confirm the schedule
\`\`\`

---

## Output format

Return a strict JSON array, each element containing:
\`\`\`json
[
  {
    "name": "skill-slug-kebab-case",
    "description": "one sentence describing what it does and when to use it (negative descriptions should highlight 'avoid X')",
    "trigger_keywords": ["keyword1", "keyword2"],
    "action_template": "...",
    "kind": "positive"
  }
]
\`\`\`

**Important rules**:
- name must be a kebab-case slug (lowercase letters, digits, hyphens only); negative names should start with \`avoid-\`
- If there are no distillable patterns, return empty array []
- kind defaults to 'positive' if omitted
- negative action_template must strictly contain \`## Trigger\`, \`## Avoid\`, \`## Instead\` sections
- Do not output any text outside the JSON

**Conversation + action history**:
`;

function buildReflectPrompt(dialogue: string, actions: Action[]): string {
  let actionsText = '';
  if (actions.length > 0) {
    actionsText =
      '\n\n[Tool call history]\n' +
      actions
        .map((a, i) => {
          const success = a.success ? '✓' : '✗';
          const params = JSON.stringify(a.params).slice(0, 200);
          const result = (a.result ?? '').slice(0, 200);
          return `${i + 1}. ${success} ${a.toolName}(${params}) → ${result}`;
        })
        .join('\n');
  }

  return REFLECT_INSTRUCTIONS + dialogue + actionsText + '\n\nOutput (strict JSON array):';
}

// ── Parse output ───────────────────────────────────────────────────────────

function parseSkills(text: string): ReflectedSkill[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }

  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSkillSpec);
  } catch {
    return [];
  }
}

function isValidSkillSpec(x: unknown): x is ReflectedSkill {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (
    !(
      typeof r.name === 'string' &&
      /^[a-z0-9-]+$/.test(r.name) &&
      typeof r.description === 'string' &&
      Array.isArray(r.trigger_keywords) &&
      r.trigger_keywords.every((k: unknown) => typeof k === 'string') &&
      typeof r.action_template === 'string'
    )
  ) {
    return false;
  }
  // kind omitted → defaults to positive; explicit 'negative' must follow the three-section structure
  if (r.kind !== undefined && r.kind !== 'positive' && r.kind !== 'negative') {
    return false;
  }
  if (r.kind === 'negative') {
    const tpl = r.action_template as string;
    if (!(tpl.includes('## Trigger') && tpl.includes('## Avoid') && tpl.includes('## Instead'))) {
      return false;
    }
  }
  return true;
}

// ── SessionReflector ────────────────────────────────────────────────────

export interface SessionReflectorOptions {
  /** Optional: self-domain write audit hook (records one Internal origin event per createSkill/updateSkill call) */
  auditHook?: MemoryAuditHook;
}

export class SessionReflector {
  private readonly auditHook: MemoryAuditHook | undefined;

  constructor(
    private readonly llm: ExtractorLlmClient,
    private readonly skills: SkillStore,
    private readonly actions: ActionLog,
    private readonly raw: RawStore,
    options: SessionReflectorOptions = {},
  ) {
    this.auditHook = options.auditHook;
  }

  /**
   * Extract skills by reflection from a session (legacy API, by sessionId)
   */
  async reflectFromSession(sessionId: string): Promise<ReflectResult> {
    const messages = this.raw.getMessages(sessionId);
    const actions = this.actions.getBySession(sessionId);
    return this.reflectFromMessages(messages, actions, sessionId);
  }

  /**
   * K0: reflect over a time range (global timeline version).
   */
  async reflectFromTimeRange(
    fromTs: number,
    toTs: number,
  ): Promise<ReflectResult> {
    const messages = this.raw.queryTimeline({
      fromTs,
      untilTs: toTs,
      order: 'asc',
      limit: 5_000,
    });
    const actions = this.actions.getByRange(fromTs, toTs);
    return this.reflectFromMessages(messages, actions, `range:${fromTs}-${toTs}`);
  }

  /** Shared core */
  private async reflectFromMessages(
    messages: RawMessage[],
    actions: Action[],
    tag: string,
  ): Promise<ReflectResult> {
    // No conversation or no actions → no skills to extract
    if (messages.length === 0) {
      return {
        skillsCreated: 0,
        skillsUpdated: 0,
        llmCostTokens: 0,
        skills: [],
      };
    }

    // Build dialogue text
    const dialogue = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n');

    const prompt = buildReflectPrompt(dialogue, actions);
    const { text, tokensUsed } = await this.llm.complete(prompt);

    const specs = parseSkills(text);
    const created: Skill[] = [];
    let updated = 0;

    for (const spec of specs) {
      const kind: 'positive' | 'negative' = spec.kind === 'negative' ? 'negative' : 'positive';
      try {
        const existing = this.skills.getByName(spec.name);
        if (existing) {
          // Already exists: merge description and template (new wins), preserve use_count
          const skill = this.skills.updateSkill(spec.name, {
            description: spec.description,
            triggerKeywords: spec.trigger_keywords,
            actionTemplate: spec.action_template,
            kind,
          });
          if (skill) {
            updated++;
            this.auditHook?.append('self_domain_write', {
              source: 'reflector',
              origin: 'Internal',
              toolName: 'update_skill',
              sessionId: tag,
              skillId: skill.id,
              skillName: skill.name,
              kind,
            });
          }
        } else {
          const skill = this.skills.createSkill({
            name: spec.name,
            description: spec.description,
            triggerKeywords: spec.trigger_keywords,
            actionTemplate: spec.action_template,
            kind,
          });
          created.push(skill);
          this.auditHook?.append('self_domain_write', {
            source: 'reflector',
            origin: 'Internal',
            toolName: 'create_skill',
            sessionId: tag,
            skillId: skill.id,
            skillName: skill.name,
            kind,
          });
        }
      } catch {
        // Skip invalid skills
      }
    }

    // Feedback loop: scan linked_skill actions in this range, feed success/failure back to SkillStore
    recordLinkedSkillOutcomes(actions, this.skills);

    return {
      skillsCreated: created.length,
      skillsUpdated: updated,
      llmCostTokens: tokensUsed,
      skills: created,
    };
  }
}

/**
 * Feed the success/failure signals of linked_skill actions in this session back to SkillStore.
 *
 * Strategy: if any action for the same skill in the same session fails, record the whole thing as failure;
 * otherwise record each successful action individually as success (preserve the high-frequency-use signal).
 *
 * This strategy is slightly conservative — better to record "partial failure" as failure than to underestimate the problem.
 */
export function recordLinkedSkillOutcomes(
  actions: Action[],
  skills: SkillStore
): { successes: number; failures: number } {
  const bySkill = new Map<string, Action[]>();
  for (const a of actions) {
    if (!a.linkedSkill) continue;
    const list = bySkill.get(a.linkedSkill) ?? [];
    list.push(a);
    bySkill.set(a.linkedSkill, list);
  }

  let successes = 0;
  let failures = 0;
  for (const [skillName, acts] of bySkill) {
    const anyFail = acts.some((a) => !a.success);
    if (anyFail) {
      const failAction = acts.find((a) => !a.success)!;
      skills.recordSkillOutcome(skillName, false, failAction.timestamp);
      failures++;
    } else {
      // Record each successful action separately, preserving the "high-frequency use" signal
      for (const a of acts) {
        skills.recordSkillOutcome(skillName, true, a.timestamp);
        successes++;
      }
    }
  }
  return { successes, failures };
}
