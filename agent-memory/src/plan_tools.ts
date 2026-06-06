/**
 * Plan tools (v17, 2026-05-11): tool set for the complex task protocol
 *
 * 5 LLM-facing tools implement the plan-review-execute-close protocol:
 *
 *   1. plan_draft         — decompose steps, write to PlanStore (status='draft')
 *   2. plan_review        — self-check plan vs guide gap; empty + pass → 'reviewed' to unblock
 *   3. plan_update_step   — advance per-step status during the execution phase
 *   4. plan_revise        — revise steps after reflection / failure, back to 'draft' for re-review
 *   5. plan_close         — complete, triggers MECE fixation (implemented by chat-handler hook)
 *
 * gate is enforced by chat-handler plan_protocol_gate (slow mode + plan not reviewed
 * → non-plan_* tools are rejected). This module only handles tool semantics; it does not enforce the gate.
 */

import type { MemoryTool } from './tools.js';
import type { PlanStore } from './plans.js';
import type { SkillStore } from './skills.js';
import type {
  DeliverableStatus,
  Plan,
  PlanDeliverable,
  PlanStepStatus,
} from './types.js';

// ── M4 / Phase 11 spec-coverage constants (2026-05-15) ──────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const DELIVERABLE_DESC_MIN_CHARS = 8;

/** Strict anti-walkthrough blacklist (forbidden words for deliverable.id). Disable via env PHILONT_SPEC_BLACKLIST=0. */
const DELIVERABLE_ID_BLACKLIST: ReadonlySet<string> = new Set([
  'task-done',
  'complete',
  'completed',
  'finished',
  'success',
  'all-done',
  'done',
]);

const VALID_DELIVERABLE_STATUS: ReadonlySet<DeliverableStatus> = new Set<DeliverableStatus>([
  'done',
  'partial',
  'skipped',
  'failed',
  'not-attempted',
]);

/** Minimum number of deliverables for a slow task. Adjustable via env PHILONT_SPEC_MIN_DELIVERABLES. */
function getSlowMinDeliverables(): number {
  const v = Number(process.env.PHILONT_SPEC_MIN_DELIVERABLES);
  return Number.isFinite(v) && v >= 1 ? v : 2;
}

/** Whether the deliverable id blacklist is enabled. Disable with env PHILONT_SPEC_BLACKLIST=0. */
function isBlacklistEnabled(): boolean {
  return process.env.PHILONT_SPEC_BLACKLIST !== '0';
}

interface ParsedDeliverable {
  id: string;
  description: string;
  source?: string;
}

interface ParsedStepInput {
  id?: string;
  description: string;
  covers: string[];
}

interface CoverageContext {
  isPlaceholder: boolean;
  isSlow: boolean;
}

/**
 * R1-R5 structure validation (2026-05-15, Phase 11 spec-coverage core).
 * Returns null on success; returns reject error string on failure.
 */
function validateSpecCoverage(
  deliverables: ParsedDeliverable[],
  steps: ParsedStepInput[],
  ctx: CoverageContext,
): string | null {
  // (R1) deliverables count
  if (!ctx.isPlaceholder) {
    const min = ctx.isSlow ? getSlowMinDeliverables() : 1;
    if (deliverables.length < min) {
      return (
        `deliverables.length=${deliverables.length} < ${min} ` +
        (ctx.isSlow
          ? `(slow task requires at least ${min} deliverable(s) to prevent catch-all walkthrough; adjust via env PHILONT_SPEC_MIN_DELIVERABLES)`
          : `(non-placeholder plan requires at least 1 deliverable)`)
      );
    }
  }
  // (R2) deliverable.id unique + kebab + blacklist + description char count
  const seen = new Set<string>();
  const blacklistEnabled = isBlacklistEnabled();
  for (const d of deliverables) {
    if (!KEBAB_CASE_RE.test(d.id)) {
      return `deliverable.id '${d.id}' is not kebab-case (/^[a-z][a-z0-9-]*[a-z0-9]$/)`;
    }
    if (seen.has(d.id)) return `deliverable.id is duplicate: '${d.id}'`;
    seen.add(d.id);
    if (blacklistEnabled && DELIVERABLE_ID_BLACKLIST.has(d.id)) {
      return (
        `deliverable.id '${d.id}' is in the anti-walkthrough blacklist. ` +
        `Catch-all ids like 'task-done' / 'complete' / 'done' are not allowed — ` +
        `use real names from the guide, e.g. 'register' / 'post-first' / 'heartbeat'. ` +
        `(disable with env PHILONT_SPEC_BLACKLIST=0)`
      );
    }
    if (d.description.trim().length < DELIVERABLE_DESC_MIN_CHARS) {
      return (
        `deliverable '${d.id}' description length ${d.description.trim().length} < ` +
        `${DELIVERABLE_DESC_MIN_CHARS} (must clearly state what the deliverable is)`
      );
    }
  }
  // (R3) step.covers non-empty (placeholder plans exempt)
  if (!ctx.isPlaceholder) {
    for (const s of steps) {
      if (!s.covers || s.covers.length === 0) {
        return (
          `step '${s.id ?? '(unnamed)'}' has empty covers — each step must cover at least 1 deliverable. ` +
          `(If this step is pure coordination with no deliverable, consider merging it into another step; placeholder plans are exempt)`
        );
      }
    }
  }
  // (R4) step.covers references must be ∈ deliverable ids
  const delIds = seen;
  for (const s of steps) {
    for (const c of s.covers) {
      if (!delIds.has(c)) {
        return (
          `step '${s.id ?? '(unnamed)'}' covers references unknown deliverable '${c}'. ` +
          `Declared deliverables: [${[...delIds].join(', ')}]`
        );
      }
    }
  }
  // (R5) all deliverables must be covered by ≥ 1 step.covers
  if (!ctx.isPlaceholder) {
    const allCovered = new Set<string>();
    for (const s of steps) for (const c of s.covers) allCovered.add(c);
    const uncovered = [...delIds].filter((id) => !allCovered.has(id));
    if (uncovered.length > 0) {
      return (
        `deliverable [${uncovered.join(', ')}] is not covered by any step — ` +
        `must be referenced in step.covers (otherwise marking deliverable_status as 'done' at close time will have no evidence basis)`
      );
    }
  }
  return null;
}

/**
 * plan_close close-time strict validation input (v19, 2026-05-13).
 *
 * chat-handler snapshots the current TurnSignalBus at the moment plan_close is called
 * and converts it to this interface:
 *   - honestyReason: reason when HonestyGate fires this turn (null = not fired)
 *   - honestySeverity: severity when fired ('medium' | 'high'; null = not fired)
 *   - sameRootCauseFailures: same-root-cause failure count computed this turn (0 = normal)
 *
 * Any field non-default → close success is rejected + bumpOuterIter.
 */
export interface PlanCloseSignals {
  honestyReason: string | null;
  honestySeverity: 'medium' | 'high' | null;
  sameRootCauseFailures: number;
}

export interface PlanToolsDeps {
  plans: PlanStore;
  /**
   * SkillStore (v17, 2026-05-11): used for MECE fixation at plan_close time.
   * Optional; if omitted, MECE fixation is skipped (plan status is still updated).
   */
  skills?: SkillStore;
  /** Injected by chat-handler; retrieves the current turn's sessionId */
  getCurrentSessionId: () => string;
  /**
   * M4 / Phase 11 (2026-05-15): injected by chat-handler; returns whether the current session is slow.
   * Used for plan_draft / plan_revise R1 validation — slow mode enforces deliverables ≥ MIN (default 2).
   * Not injected → treated as fast (MIN=1).
   */
  getIsSlow?: () => boolean;
  /**
   * v19 plan_close close-time strict validation signal source (2026-05-13).
   * Will be removed with the 5 structure validations in M4; retained in M2 phase so close internals
   * can still read honesty / sameRoot signals (will be reclaimed after M4 spec-coverage is complete).
   */
  getCloseTimeSignals?: () => PlanCloseSignals | null;
  /**
   * Phase 9.2 (2026-05-13) plan_close call write-back signal.
   * Called once every time plan_close.execute is entered (regardless of success/failure).
   * chat-handler uses this to set TurnSignalBus.planCloseCalled = true,
   * and the turn wrap-up fallback uses it to determine "whether LLM has already called plan_close".
   */
  markPlanCloseCalled?: () => void;
  /**
   * Phase 13 (2026-05-17): per-project plan.md working notes.
   * Optional: when LLM passes persist:true in plan_draft, plan_draft/plan_close auto-hook
   * write to file (append Run / write Lessons / update status).
   * Not injected → persistence unavailable; plan.persistedTo is still recorded in DB but no file side effects.
   */
  planFiles?: import('./plan_files.js').PlanFileStore;
}

const STEP_STATUS_VALUES: readonly PlanStepStatus[] = [
  'pending',
  'doing',
  'done',
  'blocked',
];

function isStepStatus(v: unknown): v is PlanStepStatus {
  return (
    typeof v === 'string' &&
    (STEP_STATUS_VALUES as readonly string[]).includes(v)
  );
}

/**
 * Phase 16 (2026-05-18):从 plan.md 文本提取 "## Operational Knowledge" 段 body。
 * 找不到段返空串。plan_close C6 校验用此判断 Operational Knowledge 是否有真实 entry。
 */
function extractOperationalKnowledge(md: string): string {
  const lines = md.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === '## Operational Knowledge');
  if (startIdx === -1) return '';
  // 找下个 ## section 或文末
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## (?!#)/.test(lines[i].trim())) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, endIdx).join('\n').trim();
}

/**
 * MECE fixation (v17, 2026-05-11) plan_close internal hook
 *
 * outcome='success' + plan.taskSignature non-empty:
 *   - findDuplicateCandidates(taskSignature) hits an existing skill
 *     → updateSkill appends plan steps + summary to description (refine rather than create new)
 *   - no hit
 *     → createSkill new_skill (name=`<sig>-skill`, actionTemplate=plan steps summary,
 *       maturity='draft', kind='positive')
 *
 * outcome='failure' + plan.taskSignature non-empty:
 *   - distill into failure-lesson playbook (name=`playbook-<sig>-fail-<hash>`,
 *     maturity='playbook', kind='negative', description contains failure summary +
 *     revision history); no MECE check (multiple failure-lessons are harmless)
 *
 * no task_signature → skip (no signature = cannot assess MECE, and cannot match on the next same-type task).
 */
function applyMECEFixation(
  plan: Plan,
  outcome: 'success' | 'failure',
  summary: string,
  skills: SkillStore,
): { kind: 'refined' | 'created' | 'failure-playbook' | 'skipped'; skillName?: string; reason?: string } {
  if (!plan.taskSignature) {
    return { kind: 'skipped', reason: 'no task_signature; skipping fixation (cannot match on next turn either)' };
  }
  const sig = plan.taskSignature;
  const stepsTemplate = plan.steps
    .map((s, i) => `${i + 1}. [${s.id}] ${s.description}${s.evidence ? ` — ${s.evidence}` : ''}`)
    .join('\n');

  // 2026-05-12 Phase 7 fixation 2 companion: `recovery-*` named placeholder plans are "diagnostic routines"
  // auto-created by in-turn-reflection — not real tasks. Even if closed with success, they should NOT be
  // fixated as positive skills (which would pollute the skill index); instead they should be retained as
  // negative playbooks ("I once recovered from failure X") for traceability.
  if (sig.startsWith('recovery-')) {
    const recoverySkillName = `playbook-${sig}-${outcome === 'success' ? 'recovered' : 'failed'}`;
    try {
      skills.createSkill({
        name: recoverySkillName,
        description: `[auto-recovery playbook] plan ${plan.id} (${sig}) outcome=${outcome}\nsummary: ${summary}\n${stepsTemplate}`,
        whenToUse: `When encountering a failure pattern with the same signature again, refer to this diagnostic approach`,
        triggerKeywords: [],
        actionTemplate: stepsTemplate,
        maturity: 'playbook',
        kind: 'negative',
        source: `auto-recovery:${plan.id}`,
      });
      return {
        kind: outcome === 'success' ? 'refined' : 'failure-playbook',
        skillName: recoverySkillName,
        reason: `recovery-* signature; classified as negative playbook (does not pollute positive skill index)`,
      };
    } catch (e) {
      return { kind: 'skipped', reason: `recovery playbook write failed: ${String(e).slice(0, 100)}` };
    }
  }

  if (outcome === 'success') {
    const dupes = skills.findDuplicateCandidates(sig, sig + ' ' + summary);
    if (dupes.length > 0) {
      // refine: append this plan's experience to the existing skill description
      const existing = dupes[0].skill;
      const addendum = `\n▸ Same task succeeded again (plan ${plan.id}): ${summary}\n${stepsTemplate}`;
      const newDesc = existing.description.includes(plan.id)
        ? existing.description
        : existing.description + addendum;
      skills.updateSkill(existing.name, { description: newDesc });
      return {
        kind: 'refined',
        skillName: existing.name,
        reason: `MECE matched existing skill '${existing.name}' (Jaccard ${dupes[0].jaccard.toFixed(2)}); appended this plan's experience`,
      };
    }
    // no match: create new_skill
    const skillName = `${sig}-skill`;
    try {
      skills.createSkill({
        name: skillName,
        description: `${summary}\n\nStep template:\n${stepsTemplate}`,
        whenToUse: `Task signature: ${sig}; apply when user proposes a similar task`,
        triggerKeywords: sig.split(/[-_\s]+/).filter((t) => t.length >= 2),
        actionTemplate: stepsTemplate,
        maturity: 'draft',
        kind: 'positive',
        source: `plan-success:${plan.id}`,
      });
      return { kind: 'created', skillName };
    } catch (e) {
      // name conflict (DB UNIQUE) — fall back to appending description
      const existing = skills.getByName(skillName);
      if (existing) {
        const addendum = `\n▸ Same task succeeded again (plan ${plan.id}): ${summary}`;
        skills.updateSkill(skillName, { description: existing.description + addendum });
        return {
          kind: 'refined',
          skillName,
          reason: `skill with same name already exists; appended to description instead`,
        };
      }
      return { kind: 'skipped', reason: `create failed: ${String(e).slice(0, 100)}` };
    }
  }

  // outcome === 'failure'
  const revisionLines = plan.reviewHistory
    .filter((r) => r.decision === 'revise')
    .map((r) => `  - ${new Date(r.at).toISOString()}: ${r.reason ?? '(no reason)'}`)
    .join('\n');
  const evidenceLines = plan.steps
    .filter((s) => s.evidence)
    .map((s) => `  - [${s.id}] ${s.evidence}`)
    .join('\n');
  const description = [
    `❌ Task '${sig}' failed (plan ${plan.id})`,
    `Failure reason: ${summary}`,
    revisionLines ? `\nRevision history (${plan.reviewHistory.filter((r) => r.decision === 'revise').length} revision(s)):\n${revisionLines}` : '',
    evidenceLines ? `\nStep evidence:\n${evidenceLines}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const failHash = Math.abs(
    plan.id.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0),
  )
    .toString(36)
    .slice(0, 6);
  const skillName = `playbook-${sig}-fail-${failHash}`;
  try {
    skills.createSkill({
      name: skillName,
      description,
      whenToUse: `When encountering a task with task_signature='${sig}', review this failure pattern first to avoid repeating it`,
      triggerKeywords: sig.split(/[-_\s]+/).filter((t) => t.length >= 2),
      actionTemplate: description,
      maturity: 'playbook',
      kind: 'negative',
      source: `plan-failure:${plan.id}`,
    });
    return { kind: 'failure-playbook', skillName };
  } catch (e) {
    return { kind: 'skipped', reason: `failure playbook write failed: ${String(e).slice(0, 100)}` };
  }
}

export function createPlanTools(deps: PlanToolsDeps): MemoryTool[] {
  const {
    plans,
    skills,
    getCurrentSessionId,
    getIsSlow,
    getCloseTimeSignals,
    markPlanCloseCalled,
    planFiles,
  } = deps;

  const planDraftTool: MemoryTool = {
    name: 'plan_draft',
    description:
      'Break down a complex task into a verifiable step list and write it to PlanStore. **First step of a slow-mode turn.**' +
      '\n[When to use] After task_mode_classify sets slow.' +
      '\n\n[deliverables — decomposition principles]' +
      '\n- Each entry = one independently verifiable concrete output from the guide / user message' +
      '\n- id must be unique kebab-case; description ≥ 8 chars' +
      '\n- Catch-all ids prohibited: "task-done" / "complete" / "done" / "all-done" are in the blacklist and will be rejected' +
      '\n- "research X" / "investigate Y" type unverifiable deliverables are prohibited (ask yourself: what does it look like when done and how do you verify it?)' +
      '\n- slow task ≥ 2 entries (env PHILONT_SPEC_MIN_DELIVERABLES; placeholder plans exempt)' +
      '\n\n[steps — decomposition principles]' +
      '\n- Start with a verb; granularity = "smallest unit that can be verified when done"' +
      '\n- Each step\'s covers array lists the deliverable ids this step covers; non-placeholder plans require ≥ 1 cover per step' +
      '\n- 1 step ≥ 1 deliverable; 1 deliverable can be covered by multiple steps (achieved in stages)' +
      '\n\n[Anti-examples — do not write these]' +
      '\n✗ {id:"task-done"}        — catch-all, rejected' +
      '\n✗ {id:"research-stack"}   — unverifiable (what does "researched" mean?)' +
      '\n✗ {id:"part-1"}+{id:"part-2"} both described as "follow the guide" — not decomposed, placeholder' +
      '\n✗ {id:"x"} desc 6 chars — char count < 8, rejected' +
      '\n\n[task_signature] Cross-session task label for reuse (kebab-case).' +
      '\n[guide_ref] Source reference: SKILL.md name / user message snippet / URL.' +
      '\n[effect] Returns plan_id; status is draft. Next step: call plan_update_step(status="doing") to start execution; plan auto-transitions to executing.' +
      '\n\n**Cross-domain example bank + full decomposition methodology** available in prefix "placeholder plan conversion" section (only shown in placeholder conversion scenarios; not repeated in tool schema).' +
      '\n\n[plan.md persistence (optional, Phase 13)]' +
      '\n- `project: "mycox"` + `persist: true` — long-lived agent role, accumulates lessons across sessions/fires' +
      '\n- `persist: true` (no project) — use task_signature as directory name; for one-time complex tasks where notes are desired' +
      '\n- omit persist — no file by default; discarded at close (ad-hoc / testing / not worth accumulating)' +
      '\nAsk yourself: will this task run again? Yes → persist:true; No → omit.',
    schema: {
      type: 'object',
      properties: {
        deliverables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Unique kebab-case id, e.g. "register" / "post-first"',
              },
              description: {
                type: 'string',
                description: '≥ 8 chars; clearly describes what is to be delivered',
              },
              source: {
                type: 'string',
                description: 'Optional; source snippet from guide (e.g. "guide.md#part-2")',
              },
            },
            required: ['id', 'description'],
          },
          description:
            'List of deliverables (required for M4 spec-coverage, 2026-05-15). ' +
            'slow task ≥ 2 entries (env PHILONT_SPEC_MIN_DELIVERABLES); placeholder plans exempt.',
        },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Optional custom step id (short slug); defaults to step-1/2/3',
              },
              description: {
                type: 'string',
                description: 'Step description (start with a verb)',
              },
              covers: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'List of deliverable ids this step covers (required for M4); non-placeholder plans require ≥ 1 cover per step.',
              },
            },
            required: ['description'],
          },
          description: 'Step list; at least 1 step required',
        },
        task_signature: {
          type: 'string',
          description: 'Cross-session task signature (optional). E.g. "pdf-to-word". Use kebab-case.',
        },
        guide_ref: {
          type: 'string',
          description:
            'Source reference (optional, **strongly recommended**). Reflection distillation uses guide_ref to trace back to the source; empty = reduced distillation quality.' +
            '\n\n[What to fill]' +
            '\n- SKILL.md name: `skill:<skill-name>` (e.g. "skill:stripe-onboarding")' +
            '\n- URL: `https://...` (documentation link from user)' +
            '\n- User message snippet: paste the key sentence directly (< 200 chars)' +
            '\n- Multiple sources: join with "; ", e.g. "skill:foo; https://bar.com/guide.md"' +
            '\n\n[When can it be empty]' +
            '\nOnly when "you decomposed entirely from scratch with no external reference". But placeholder plans (created by auto-plan-on-slow) usually have guide_ref; ' +
            'when converting via revise, **keep it** unless you webFetched a more precise sub-document and want to replace it.',
        },
        project: {
          type: 'string',
          description:
            'Phase 13 (2026-05-17): project name for long-lived agent role (kebab-case), e.g. "mycox".' +
            '\nFilled + persist:true → creates/reuses `~/.philont/projects/<project>/plan.md`, accumulating Lessons/Knowledge/Recent Runs across sessions/fires.' +
            '\nproject only without persist → no file created (equivalent to not filling).',
        },
        persist: {
          type: 'boolean',
          description:
            'Phase 13 (2026-05-17): whether to persist project plan.md (default false).' +
            '\n- true + project:"X" → `~/.philont/projects/X/plan.md`' +
            '\n- true + no project → use task_signature as directory name' +
            '\n- false / omit → DB plan only; discarded at close (default for ad-hoc / one-time tasks)',
        },
      },
      required: ['steps', 'deliverables'],
    },
    capability: 'write',
    domain: 'self',
    async execute(params) {
      const rawSteps = params.steps;
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { success: false, output: '', error: 'steps must be a non-empty array' };
      }
      // parse steps (M4 adds covers field)
      const steps: ParsedStepInput[] = [];
      for (let i = 0; i < rawSteps.length; i++) {
        const s = rawSteps[i];
        if (!s || typeof s !== 'object') {
          return { success: false, output: '', error: `steps[${i}] is not an object` };
        }
        const so = s as Record<string, unknown>;
        const desc = so.description;
        if (typeof desc !== 'string' || desc.trim().length === 0) {
          return {
            success: false,
            output: '',
            error: `steps[${i}].description is required and must be non-empty`,
          };
        }
        const id = typeof so.id === 'string' ? so.id.trim() : undefined;
        const coversRaw = so.covers;
        let covers: string[] = [];
        if (coversRaw !== undefined) {
          if (!Array.isArray(coversRaw)) {
            return {
              success: false,
              output: '',
              error: `steps[${i}].covers must be a string array`,
            };
          }
          for (const c of coversRaw) {
            if (typeof c !== 'string' || !c.trim()) {
              return {
                success: false,
                output: '',
                error: `steps[${i}].covers contains non-string or empty value`,
              };
            }
            covers.push(c.trim());
          }
        }
        steps.push({ id, description: desc.trim(), covers });
      }
      // parse deliverables (M4 new required field)
      const rawDeliverables = params.deliverables;
      const deliverables: ParsedDeliverable[] = [];
      if (rawDeliverables !== undefined) {
        if (!Array.isArray(rawDeliverables)) {
          return {
            success: false,
            output: '',
            error: 'deliverables must be an array',
          };
        }
        for (let i = 0; i < rawDeliverables.length; i++) {
          const d = rawDeliverables[i];
          if (!d || typeof d !== 'object') {
            return {
              success: false,
              output: '',
              error: `deliverables[${i}] is not an object`,
            };
          }
          const dd = d as Record<string, unknown>;
          if (typeof dd.id !== 'string' || !dd.id.trim()) {
            return {
              success: false,
              output: '',
              error: `deliverables[${i}].id is required and must be a non-empty string`,
            };
          }
          if (typeof dd.description !== 'string' || !dd.description.trim()) {
            return {
              success: false,
              output: '',
              error: `deliverables[${i}].description is required and must be a non-empty string`,
            };
          }
          const parsed: ParsedDeliverable = {
            id: dd.id.trim(),
            description: dd.description.trim(),
          };
          if (typeof dd.source === 'string' && dd.source.trim()) {
            parsed.source = dd.source.trim();
          }
          deliverables.push(parsed);
        }
      }
      const taskSig =
        typeof params.task_signature === 'string'
          ? params.task_signature.trim() || null
          : null;
      const guideRef =
        typeof params.guide_ref === 'string'
          ? params.guide_ref.trim() || null
          : null;

      // Phase 13 (2026-05-17): persist + project → persistedTo
      // persist:true required → writes plan.md; value prefers project, fallback to task_signature.
      // naming validation: kebab-case (alphanumeric + hyphens, no leading/trailing hyphens, 1-60 chars).
      let persistedTo: string | null = null;
      if (params.persist === true) {
        const projectRaw =
          typeof params.project === 'string' ? params.project.trim() : '';
        const candidate = projectRaw || taskSig || '';
        if (!candidate) {
          return {
            success: false,
            output: '',
            error:
              'When persist=true, at least one of project or task_signature must be non-empty (determines plan.md directory name)',
          };
        }
        if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(candidate)) {
          return {
            success: false,
            output: '',
            error:
              `project / task_signature must be kebab-case (alphanumeric + hyphens, 1-60 chars, no leading/trailing hyphens), got: "${candidate}"`,
          };
        }
        persistedTo = candidate;
      }

      // Phase 10 P0 (2026-05-14): active plan already exists in same session → reject.
      // M3 / Phase 11 (2026-05-15): active plan = draft / executing.
      if (process.env.PHILONT_PLAN_DRAFT_REJECT_ACTIVE !== '0') {
        const sid = getCurrentSessionId();
        const existing = plans.listBySession(sid, { limit: 1 })[0];
        if (
          existing &&
          (existing.status === 'draft' || existing.status === 'executing')
        ) {
          return {
            success: false,
            output: '',
            error:
              `Active plan ${existing.id} already exists (status=${existing.status}, ${existing.steps.length} steps, ` +
              `guide_ref=${existing.guideRef ?? '(none)'}).` +
              `\n**Do not plan_draft a new one** (would lose guide_ref + protocol state). Call instead:` +
              `\n  plan_revise({ plan_id: "${existing.id}", new_steps: [...], new_deliverables: [...], reason: "..." })` +
              `\nThis replaces steps + deliverables while preserving guide_ref / task_signature, conforming to the placeholder plan revision protocol.` +
              `\n\nIf you genuinely need to create a new plan (rare; typically for a completely unrelated new task), first call plan_close to close the current plan.`,
          };
        }
      }

      // M4 / Phase 11 spec-coverage structure validation (R1-R5)
      const ctx: CoverageContext = {
        // non-placeholder plan (LLM actively calling plan_draft): isPlaceholder is always false
        // (placeholder plans are created by chat-handler directly via plans.create, not through this tool)
        isPlaceholder: false,
        isSlow: getIsSlow?.() === true,
      };
      const violation = validateSpecCoverage(deliverables, steps, ctx);
      if (violation) {
        return {
          success: false,
          output: '',
          error: `[spec-coverage] ${violation}`,
        };
      }

      try {
        const plan = plans.create({
          sessionId: getCurrentSessionId(),
          steps,
          deliverables,
          taskSignature: taskSig,
          guideRef,
          persistedTo,
        });
        // Phase 13 (2026-05-17): persistedTo non-empty → create/reuse project plan.md
        // file-level hook; failure only logs console.warn, does not break DB plan creation semantics
        if (persistedTo && planFiles) {
          try {
            const goalHint =
              deliverables.length > 0
                ? `Complete ${deliverables.length} deliverable(s): ${deliverables.map((d) => d.id).join(', ')}`
                : undefined;
            planFiles.loadOrCreate(persistedTo, {
              goal: goalHint,
              deliverables,
            });
            // Phase 15.6 Fix C (2026-05-18): new real plan (non-placeholder) with deliverables →
            // write Sub-tasks section (loadOrCreate does not touch Sub-tasks when plan.md already exists)
            if (deliverables.length > 0) {
              planFiles.updateSubTasks(persistedTo, deliverables);
            }
          } catch (e) {
            console.warn(
              `[plan-files] loadOrCreate(${persistedTo}) failed (ignored):`,
              (e as Error)?.message ?? e,
            );
          }
        }
        return {
          success: true,
          output:
            `✅ plan created\nplan_id: ${plan.id}\nsteps: ${plan.steps.length}\n` +
            `deliverables: ${deliverables.length}\nstatus: draft\n\n` +
            `Deliverables:\n` +
            deliverables
              .map((d, i) => `  ${i + 1}. [${d.id}] ${d.description}`)
              .join('\n') +
            `\n\nSteps:\n` +
            plan.steps
              .map(
                (s, i) =>
                  `  ${i + 1}. [${s.id}] ${s.description}` +
                  (s.covers.length > 0
                    ? ` (covers: ${s.covers.join(', ')})`
                    : ''),
              )
              .join('\n') +
            `\n\n**Next step: call plan_update_step({plan_id, step_id, status:'doing'})** to begin executing the first step. plan auto-transitions to executing.` +
            `\nOn failure during execution → call plan_revise to change steps; on task completion → call plan_close (with deliverable_status).`,
        };
      } catch (e) {
        return {
          success: false,
          output: '',
          error: `plan creation failed: ${String(e).slice(0, 200)}`,
        };
      }
    },
  };

  // ── planReviewTool removed (2026-05-15, M2 Phase 11) ─────────────────────
  // Dual-layer loop simplified to single-layer: plan_draft → plan_update_step → plan_close.
  // "review" is now handled by LLM self-reflection + reflection distillation path; mechanism layer
  // no longer performs semantic review (proven to cause nesting traps in practice).
  // M3 state machine officially removes the 'reviewed' intermediate state; M4 adds spec-coverage
  // structure enforcement (deliverables / covers / deliverable_status) to replace review's gap enumeration.

  const planUpdateStepTool: MemoryTool = {
    name: 'plan_update_step',
    description:
      'Update the execution status of a single step in a plan. **Must be called for each step in the execution phase** (starting: doing → completing: done).' +
      '\n[When to use] Call status="doing" when a step truly begins (auto-records startedAt, plan status transitions to executing); ' +
      'call status="done" + evidence when complete (describe completion evidence, e.g. "fetch returned 200, 19 endpoints stored"); ' +
      'call status="blocked" + evidence when stuck (describe blocking reason).' +
      '\n[evidence] Strongly recommended when completing / blocking; this is key material when a failed plan is distilled into a playbook.',
    schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        step_id: { type: 'string', description: 'step.id from plan_draft (defaults to step-1/2/3)' },
        status: {
          type: 'string',
          enum: ['pending', 'doing', 'done', 'blocked'],
        },
        evidence: {
          type: 'string',
          description:
            'Completion basis / blocking reason. **Write objective factual changes, not subjective statements.**' +
            '\nPrinciple: cite specific tool output / return values / file state / fact writes, with numbers + ids + timestamps.' +
            '\n✓ Good evidence:' +
            '\n  "API returned 200, account_id=\'abc123\', stored to project.<service>.account_id via store_fact"' +
            '\n  "wrote /tmp/out.json (2.3KB), inspectPath confirmed mtime=current + size > 0"' +
            '\n  "callback endpoint verified 200 for 3 consecutive checks at 10s intervals"' +
            '\n✗ Poor evidence:' +
            '\n  "registration complete"      — subjective statement, no facts' +
            '\n  "called the API"              — no result' +
            '\n  "followed the guide"          — no specific output cited' +
            '\nThis evidence is used in plan close distillation; weak evidence → bad artifacts enter SkillStore and pollute future turns.',
        },
      },
      required: ['plan_id', 'step_id', 'status'],
    },
    capability: 'write',
    domain: 'self',
    async execute(params) {
      const planId = params.plan_id;
      const stepId = params.step_id;
      const status = params.status;
      if (typeof planId !== 'string' || !planId) {
        return { success: false, output: '', error: 'plan_id is required' };
      }
      if (typeof stepId !== 'string' || !stepId) {
        return { success: false, output: '', error: 'step_id is required' };
      }
      if (!isStepStatus(status)) {
        return {
          success: false,
          output: '',
          error: `status must be one of: pending/doing/done/blocked`,
        };
      }
      const evidence =
        typeof params.evidence === 'string' ? params.evidence : null;
      // Phase 11 amendment (2026-05-15): placeholder plans cannot call update_step,
      // forcing LLM to use plan_revise to promote the plan first.
      // Otherwise LLM finds a shortcut: plan_update_step doing (draft→executing directly) → all done →
      // plan_close success({}) passes C1-C4 vacuously for deliverables=[] → placeholder plan fakes completion.
      const currentPlan = plans.get(planId);

      // Phase 12 cont (2026-05-17): distinguish "plan does not exist" vs "step does not exist",
      // listing real step ids when the step is not found. Real-world bug: LLM abbreviated
      // `step-1-read-feed` to `step-1` across turns; old error "step 'X' not found" gave LLM no
      // chance to see the correct id → repeated retries → in-turn-reflection locks tools.
      if (!currentPlan) {
        return {
          success: false,
          output: '',
          error:
            `plan '${planId}' does not exist (may have already been closed or id is wrong).\n` +
            `To look up recent plans, first close the current task with plan_close, then plan_draft a new plan.`,
        };
      }
      if (currentPlan.isPlaceholder) {
        return {
          success: false,
          output: '',
          error:
            `Placeholder plan ${planId} (isPlaceholder=true) cannot call plan_update_step — ` +
            `this is a generic skeleton created by auto-plan-on-slow (deliverables empty); it cannot carry real task execution evidence.\n` +
            `Must first convert via plan_revise({ plan_id, new_steps, new_deliverables, reason }) (isPlaceholder=true → false) before advancing steps.\n` +
            (currentPlan.guideRef
              ? `guide_ref: ${currentPlan.guideRef}\nIf it is a URL not yet fetched → first webFetch(guide_ref) to read the full guide, then plan_revise to list real guide entries as deliverables.`
              : 'Please decompose real deliverables from the user task, then plan_revise to convert.'),
        };
      }
      // step_id not in plan.steps[] → list real ids
      const realStepIds = currentPlan.steps.map((s) => s.id);
      if (!realStepIds.includes(stepId)) {
        const stepList = currentPlan.steps
          .map((s) => `  - ${s.id} [${s.status}] ${s.description.slice(0, 60)}`)
          .join('\n');
        return {
          success: false,
          output: '',
          error:
            `plan '${planId}' has no step '${stepId}'.\n` +
            `Real step ids in this plan (${realStepIds.length} total):\n` +
            stepList +
            `\n\nCommon mistake: shortening the full id across turns (e.g. \`step-1-read-feed\` → \`step-1\`). Please copy the full id.`,
        };
      }
      const updated = plans.updateStep(planId, stepId, status, evidence);
      if (!updated) {
        // reaching here indicates an internal store error (plan suddenly deleted / db error) — should not happen.
        return {
          success: false,
          output: '',
          error: `plan '${planId}' / step '${stepId}' update failed (internal error; plan may have been concurrently closed)`,
        };
      }
      const overallProgress = `${updated.steps.filter((s) => s.status === 'done').length}/${updated.steps.length} done`;
      return {
        success: true,
        output:
          `step [${stepId}] → ${status}${evidence ? `\nevidence: ${evidence}` : ''}\n` +
          `plan status: ${updated.status} (${overallProgress})`,
      };
    },
  };

  const planReviseTool: MemoryTool = {
    name: 'plan_revise',
    description:
      'Revise plan steps + optionally change deliverables (M4 spec-coverage, 2026-05-15). **Returns to draft status.**' +
      '\n\n[When to use — 3 scenarios]' +
      '\n1. **Converting a placeholder plan** (isPlaceholder=true): must revise; must provide new_deliverables' +
      '\n2. **Execution failure requires a new approach**: common case; most often **only change new_steps, keep deliverables**' +
      '\n3. **Missed entries discovered when reading guide**: **change both**; add missing entries to deliverables' +
      '\n\n[Decision — only change steps vs. also change deliverables]' +
      '\n- step failed but deliverable set is **complete** → only change new_steps (swap technical approach)' +
      '\n  Example: webFetch failed → switch to curl + extract; deliverable is still "obtain API docs"' +
      '\n- failure reveals a **missing deliverable** → change both' +
      '\n  Example: discovered during execution that guide requires an additional entry not in original plan → add to new_deliverables' +
      '\n\n[How to write reason]' +
      '\nDo not write "revised per user request" (empty statement). Write "while at step X I discovered Y":' +
      '\n✓ "original plan only had the first entry; after executing, reading the guide revealed a second entry is required"' +
      '\n✓ "tool A timed out; switching to tool B + post-processing; deliverable unchanged"' +
      '\n✗ "revise the plan"' +
      '\n✗ "per user request"' +
      '\n\n[effect] Replaces steps; plan.status returns to draft. Call plan_update_step(status="doing") to re-execute → auto-transitions to executing.' +
      '\n**Converting a placeholder plan must provide new_deliverables** (otherwise rejected).' +
      '\n\n[plan.md persistence (optional, Phase 13)] Same project + persist fields as plan_draft:' +
      '\n- Converting a placeholder plan (most common use of this tool) is the LLM\'s only opportunity to declare persist intent — placeholder plans are created by the mechanism layer, bypassing plan_draft' +
      '\n- `project: "mycox"` + `persist: true` — long-lived agent role; plan.md accumulates Lessons / Knowledge / Recent Runs across sessions/fires' +
      '\n- omit — no file by default (ad-hoc / one-time complex task)' +
      '\nAsk yourself: will this task run again (recurring heartbeat / long-lived agent role)? Yes → pass project + persist:true.',
    schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        new_steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              covers: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of deliverable ids this step covers (required for M4; placeholder plans exempt)',
              },
            },
            required: ['description'],
          },
          description: 'New step list (replaces existing); at least 1 step required',
        },
        new_deliverables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              source: { type: 'string' },
            },
            required: ['id', 'description'],
          },
          description:
            'New deliverable list (optional, M4). Omit = keep existing deliverables; provide = replace entirely. ' +
            'Required when converting a placeholder plan.',
        },
        reason: {
          type: 'string',
          description:
            'Reason for revision (why the plan is being changed). E.g. "step 3 returned 404 on mycox API; need to change to /v2 path".',
        },
        project: {
          type: 'string',
          description:
            'Phase 13 (2026-05-17): same as plan_draft. project name for long-lived agent role (kebab-case). ' +
            'Converting a placeholder plan is the only opportunity to declare persistence (placeholder plans are created by mechanism layer, bypassing plan_draft).',
        },
        persist: {
          type: 'boolean',
          description:
            'Phase 13 (2026-05-17): whether to persist project plan.md (default false).' +
            '\n- true + project:"X" → `~/.philont/projects/X/plan.md`, accumulates Lessons/Knowledge/Recent Runs across fires' +
            '\n- true + no project → use plan.task_signature as directory name' +
            '\n- false / omit → DB plan only (default)',
        },
      },
      required: ['plan_id', 'new_steps', 'reason'],
    },
    capability: 'write',
    domain: 'self',
    async execute(params) {
      let planId = params.plan_id;
      const reason = params.reason;
      const rawSteps = params.new_steps;
      // Phase 15.7 (2026-05-18) Fix Bug 2: mechanism-layer fallback when plan_id is missing.
      //
      // Exposed in production (mycox-heartbeat): LLM repeatedly called plan_revise in a scheduled
      // session while missing the plan_id parameter → reject "plan_id required" → same-root-cause
      // failure 2x → in-turn-reflection blocks plan_revise → plan-circuit-breaker triggers 3x → entire
      // task degrades. Root cause: multiple plans in session (placeholder + real), LLM mixed them up.
      //
      // Fix: when plan_id is missing, automatically use the most recent active plan in this session
      // (status=draft/executing, preferring isPlaceholder=true placeholder plan promotion path)
      // as the implicit plan_id. LLM can still revise that plan even when it forgets to pass the id.
      if (typeof planId !== 'string' || !planId) {
        try {
          const sid = getCurrentSessionId();
          const recent = plans.listBySession(sid, { limit: 5 });
          // 优先转正占位 plan,其次最新 draft / executing
          const placeholder = recent.find(
            (p) => p.isPlaceholder && (p.status === 'draft' || p.status === 'executing'),
          );
          const target =
            placeholder ??
            recent.find((p) => p.status === 'draft' || p.status === 'executing');
          if (target) {
            planId = target.id;
            console.log(
              `[plan-revise-fallback] LLM missing plan_id, auto-selected session=${sid} most recent active plan=${target.id} (${target.isPlaceholder ? 'placeholder' : 'real'}, status=${target.status})`,
            );
          }
        } catch (e) {
          console.warn('[plan-revise-fallback] failed to query session active plan:', e);
        }
      }
      if (typeof planId !== 'string' || !planId) {
        return {
          success: false,
          output: '',
          error:
            'plan_id is required (mechanism-layer fallback also found no active plan in this session; ' +
            'please call plan_draft first or explicitly pass plan_id in params)',
        };
      }
      if (typeof reason !== 'string' || !reason.trim()) {
        return { success: false, output: '', error: 'reason is required and must be non-empty' };
      }
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { success: false, output: '', error: 'new_steps must be a non-empty array' };
      }
      // parse new_steps (adding covers)
      const steps: ParsedStepInput[] = [];
      for (let i = 0; i < rawSteps.length; i++) {
        const s = rawSteps[i];
        if (!s || typeof s !== 'object') {
          return { success: false, output: '', error: `new_steps[${i}] is not an object` };
        }
        const so = s as Record<string, unknown>;
        const desc = so.description;
        if (typeof desc !== 'string' || desc.trim().length === 0) {
          return {
            success: false,
            output: '',
            error: `new_steps[${i}].description is required and must be non-empty`,
          };
        }
        let covers: string[] = [];
        if (so.covers !== undefined) {
          if (!Array.isArray(so.covers)) {
            return {
              success: false,
              output: '',
              error: `new_steps[${i}].covers must be a string array`,
            };
          }
          for (const c of so.covers) {
            if (typeof c !== 'string' || !c.trim()) {
              return {
                success: false,
                output: '',
                error: `new_steps[${i}].covers contains non-string or empty value`,
              };
            }
            covers.push(c.trim());
          }
        }
        steps.push({
          id: typeof so.id === 'string' ? so.id.trim() : undefined,
          description: desc.trim(),
          covers,
        });
      }

      // fetch current plan to check if it is a placeholder
      const current = plans.get(planId);
      if (!current) {
        return {
          success: false,
          output: '',
          error: `plan '${planId}' does not exist`,
        };
      }
      if (current.status === 'completed' || current.status === 'failed') {
        return {
          success: false,
          output: '',
          error: `plan '${planId}' is already ${current.status} (cannot revise)`,
        };
      }

      // parse new_deliverables (optional)
      const rawNewDeliv = (params as Record<string, unknown>).new_deliverables;
      let newDeliverables: ParsedDeliverable[] | null = null;
      if (rawNewDeliv !== undefined) {
        if (!Array.isArray(rawNewDeliv)) {
          return {
            success: false,
            output: '',
            error: 'new_deliverables must be an array',
          };
        }
        newDeliverables = [];
        for (let i = 0; i < rawNewDeliv.length; i++) {
          const d = rawNewDeliv[i];
          if (!d || typeof d !== 'object') {
            return {
              success: false,
              output: '',
              error: `new_deliverables[${i}] is not an object`,
            };
          }
          const dd = d as Record<string, unknown>;
          if (typeof dd.id !== 'string' || !dd.id.trim()) {
            return {
              success: false,
              output: '',
              error: `new_deliverables[${i}].id is required and must be non-empty`,
            };
          }
          if (typeof dd.description !== 'string' || !dd.description.trim()) {
            return {
              success: false,
              output: '',
              error: `new_deliverables[${i}].description is required and must be non-empty`,
            };
          }
          const parsed: ParsedDeliverable = {
            id: dd.id.trim(),
            description: dd.description.trim(),
          };
          if (typeof dd.source === 'string' && dd.source.trim()) {
            parsed.source = dd.source.trim();
          }
          newDeliverables.push(parsed);
        }
      }

      // M4 placeholder plan promotion enforcement: new_deliverables required when isPlaceholder=true
      if (current.isPlaceholder) {
        if (!newDeliverables || newDeliverables.length === 0) {
          return {
            success: false,
            output: '',
            error:
              `Converting placeholder plan ${planId} (isPlaceholder=true) requires non-empty new_deliverables.\n` +
              `Please list deliverables from the guide's real outputs; each step's step.covers should reference the corresponding id.\n` +
              `This is the mechanism-layer R1 spec-coverage check to prevent placeholder plans from closing success without converting.`,
          };
        }
      }

      // R1-R5 structure validation
      // promotion semantics: providing new_deliverables means no longer treated as placeholder (validation runs as non-placeholder)
      const willBePlaceholder = current.isPlaceholder && !newDeliverables;
      const ctx: CoverageContext = {
        isPlaceholder: willBePlaceholder,
        isSlow: getIsSlow?.() === true,
      };
      const effectiveDeliverables: ParsedDeliverable[] =
        newDeliverables ?? current.deliverables;
      const violation = validateSpecCoverage(effectiveDeliverables, steps, ctx);
      if (violation) {
        return {
          success: false,
          output: '',
          error: `[spec-coverage] ${violation}`,
        };
      }

      // Phase 13 (2026-05-17): persist + project → persistedTo
      // Promoting a placeholder plan is the LLM's only opportunity to declare persistence. kebab-case validation same as plan_draft.
      let persistedToNew: string | null | undefined; // undefined = 不动 DB 列;string|null = 显式设
      if (params.persist === true) {
        const projectRaw =
          typeof params.project === 'string' ? params.project.trim() : '';
        const candidate =
          projectRaw || (current.taskSignature ?? '') || '';
        if (!candidate) {
          return {
            success: false,
            output: '',
            error:
              'When persist=true, at least one of project or current plan.task_signature must be non-empty (determines plan.md directory name)',
          };
        }
        if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(candidate)) {
          return {
            success: false,
            output: '',
            error:
              `project / task_signature must be kebab-case (alphanumeric + hyphens, 1-60 chars, no leading/trailing hyphens), got: "${candidate}"`,
          };
        }
        persistedToNew = candidate;
      }

      try {
        const updated = plans.revise(
          planId,
          steps,
          newDeliverables as PlanDeliverable[] | null,
          reason.trim(),
        );
        if (!updated) {
          return {
            success: false,
            output: '',
            error: `plan '${planId}' does not exist or is already completed/failed (cannot revise)`,
          };
        }
        // apply persistedTo update (only when persist:true is provided; false leaves it unchanged)
        let finalPlan = updated;
        let planFileLine = '';
        if (persistedToNew !== undefined && persistedToNew !== updated.persistedTo) {
          const after = plans.setPersistedTo(planId, persistedToNew);
          if (after) finalPlan = after;
        }
        // PlanFileStore hook: persistedTo non-empty + planFiles injected → loadOrCreate
        if (finalPlan.persistedTo && planFiles) {
          try {
            const goalHint =
              finalPlan.deliverables.length > 0
                ? `Complete ${finalPlan.deliverables.length} deliverable(s): ${finalPlan.deliverables.map((d) => d.id).join(', ')}`
                : undefined;
            planFiles.loadOrCreate(finalPlan.persistedTo, {
              goal: goalHint,
              deliverables: finalPlan.deliverables.map((d) => ({
                id: d.id,
                description: d.description,
              })),
            });
            // Phase 15.6 Fix C (2026-05-18): after promotion, write real deliverables to plan.md
            // Sub-tasks section (loadOrCreate only fills it when the file does not exist; when it already
            // exists, Sub-tasks is untouched → section remains a skeleton placeholder forever).
            if (finalPlan.deliverables.length > 0) {
              planFiles.updateSubTasks(
                finalPlan.persistedTo,
                finalPlan.deliverables.map((d) => ({
                  id: d.id,
                  description: d.description,
                })),
              );
            }
            planFileLine = `\nplan.md: project=${finalPlan.persistedTo} ready (Sub-tasks updated)`;
          } catch (e) {
            console.warn(
              `[plan-files] loadOrCreate(${finalPlan.persistedTo}) failed (ignored):`,
              (e as Error)?.message ?? e,
            );
          }
        }
        const promotedNote =
          current.isPlaceholder && !finalPlan.isPlaceholder
            ? '\n✅ Placeholder plan converted (isPlaceholder=true → false).'
            : '';
        return {
          success: true,
          output:
            `plan revised (${finalPlan.steps.length} steps, ${finalPlan.deliverables.length} deliverables), status back to draft.${promotedNote}\n` +
            `Revision reason recorded: ${reason.trim().slice(0, 100)}\n\n` +
            `**Next step: call plan_update_step({plan_id, step_id, status:'doing'})** to begin executing the revised steps.` +
            planFileLine,
        };
      } catch (e) {
        return {
          success: false,
          output: '',
          error: `plan revision failed: ${String(e).slice(0, 200)}`,
        };
      }
    },
  };

  const planCloseTool: MemoryTool = {
    name: 'plan_close',
    description:
      'Close a plan, marking this complex task as complete. **Last step in slow mode.**' +
      '\n[When to use success] All steps are done and the task is genuinely achieved. After closing, the mechanism layer triggers MECE fixation (looks for skill with same task_signature; extends if found, creates new if not).' +
      '\n[When to use failure] Task is stuck and cannot continue / user gave up / step blocked and cannot be unblocked. Failed plans are distilled into a "failure pattern playbook" visible on the next turn for the same type of task.' +
      '\n[summary] 1-3 sentences summarizing the outcome (success: write what was achieved; failure: write what was stuck).' +
      '\n[deliverable_status] M4 spec-coverage (2026-05-15) — required. Each deliverable.id maps to a status:' +
      '\n  - "done": complete and verifiable; "partial": partially complete; "skipped": actively skipped (write reason in summary);' +
      '\n  - "failed": attempted but failed; "not-attempted": never attempted.' +
      '\nWhen outcome="success", all statuses must be in {done, skipped}; any non-done/skipped status will be rejected.' +
      '\n\n[C4 fact check (2026-05-17)] When outcome="success", mechanism layer scans all step.evidence; ' +
      'if "EXCEPTION / fetch failed / TypeError / E* errno" type infrastructure-level error words are found → rejected.' +
      '\nPrevents LLM from pasting raw tool errors into evidence and claiming success (false report).' +
      '\nIf intermediate failures were retried to eventual success → before closing, call plan_update_step to rewrite that step.evidence with the final result.',
    schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
        summary: {
          type: 'string',
          description:
            '1-3 sentences summarizing the outcome (for user + distillation). **Write objective results / blockers, not subjective statements.**' +
            '\n\n[On success]' +
            '\n✓ "Registered account_id=abc123, configured API key, tested read-only endpoint returned 200. Full chain working."' +
            '\n✓ "Refactoring complete — split into 3 modules, tests 76/76 pass, no regression."' +
            '\n✗ "task done" / "done" — no facts, same as saying nothing' +
            '\n\n[On failure] Clearly state "what was stuck / what was tried / what the user needs to provide"' +
            '\n✓ "Stuck at step-3 webhook registration — upstream returned 400 \'invalid callback url\'; ' +
            'tried both https/http versions, both failed. User needs to provide whitelist host."' +
            '\n✓ "Not achieved — sub-document fetched-store mentioned in guide timed out 3 times; ' +
            'tried readFile too, also failed; possibly a CDN edge issue."' +
            '\n✗ "failed" / "stuck" — did not say what was stuck' +
            '\n\n[Self-check — after filling, ask] Can the user:' +
            '\n(1) Know whether it was done (2) Know what the specific output is (3) If failure, know what to provide to continue' +
            '\n\nsummary is used in plan close distillation into playbook/skill; weak summary → bad artifacts stored and polluting next turn.',
        },
        deliverable_status: {
          type: 'object',
          additionalProperties: {
            type: 'string',
            enum: ['done', 'partial', 'skipped', 'failed', 'not-attempted'],
          },
          description:
            'Per-deliverable status (required for M4, 2026-05-15). Keys must exactly match the id set of plan.deliverables.' +
            '\n\n[5-tier judgment — do not fill everything as done]' +
            '\n"done"          — has corresponding step.evidence and evidence describes an objective factual change' +
            '\n                  Ask yourself: "If the user goes to verify this right now, is it actually true?" → only fill done if yes' +
            '\n"partial"       — partially complete; some sub-items done. summary must write "X is done, Y remains"' +
            '\n"skipped"       — actively decided not to do (user said not needed / found inapplicable). summary must write reason' +
            '\n"failed"        — attempted but failed; not retrying this turn' +
            '\n"not-attempted" — never started (plan was interrupted after creation / ran out of time)' +
            '\n\n[C3 hard constraint] When outcome="success", all statuses must be in {done, skipped}.' +
            '\nAny failed/partial/not-attempted → must use outcome="failure" (mechanism layer blocks "false success").' +
            '\n\n[Self-check — after filling, ask each row]' +
            '\n- Is the evidence for "done" items actual facts (not empty statements)?' +
            '\n- Is "what remains" for "partial" items written in summary?' +
            '\n- Can the reason for "skipped" items be explained to the user?' +
            '\n\nFor placeholder plans (empty deliverables), pass {}.',
        },
      },
      required: ['plan_id', 'outcome', 'summary', 'deliverable_status'],
    },
    capability: 'write',
    domain: 'self',
    async execute(params) {
      // Phase 9.2 (2026-05-13): used by turn wrap-up fallback — marks that LLM has explicitly called
      // plan_close; chat-handler turn wrap-up knows auto-close is not needed.
      // Placed first so even if subsequent validation rejects, it still counts as "LLM has called plan_close".
      markPlanCloseCalled?.();

      const planId = params.plan_id;
      const outcomeRaw = params.outcome;
      const summary = params.summary;
      if (typeof planId !== 'string' || !planId) {
        return { success: false, output: '', error: 'plan_id is required' };
      }
      if (outcomeRaw !== 'success' && outcomeRaw !== 'failure') {
        return {
          success: false,
          output: '',
          error: `outcome must be 'success' or 'failure', got: ${String(outcomeRaw).slice(0, 40)}`,
        };
      }
      if (typeof summary !== 'string' || !summary.trim()) {
        return { success: false, output: '', error: 'summary is required and must be non-empty' };
      }

      // M4 / Phase 11 spec-coverage: C1-C4 deliverable_status validation
      const rawDelivStatus = (params as Record<string, unknown>).deliverable_status;
      if (
        rawDelivStatus === undefined ||
        rawDelivStatus === null ||
        typeof rawDelivStatus !== 'object' ||
        Array.isArray(rawDelivStatus)
      ) {
        return {
          success: false,
          output: '',
          error:
            'deliverable_status is required (M4 spec-coverage, 2026-05-15) — ' +
            'must be an object {<deliverable_id>: "done"|"partial"|"skipped"|"failed"|"not-attempted"}. ' +
            'For placeholder plans (empty deliverables), pass {}.',
        };
      }
      const planCurrent = plans.get(planId);
      if (!planCurrent) {
        return {
          success: false,
          output: '',
          error: `plan '${planId}' does not exist`,
        };
      }

      // Phase 11 amendment (2026-05-15): placeholder plans cannot close with success.
      // C1-C4 spec-coverage passes vacuously for deliverables=[] (empty set vs empty set),
      // LLM can pass deliverable_status={} to get through → pretending "task complete".
      // Allowing close failure lets it acknowledge that real execution did not happen.
      if (planCurrent.isPlaceholder && outcomeRaw === 'success') {
        return {
          success: false,
          output: '',
          error:
            `Placeholder plan ${planId} (isPlaceholder=true) cannot close with success — ` +
            `placeholder plans are generic skeletons created by auto-plan-on-slow (deliverables empty); they cannot carry real task completion evidence.\n` +
            `Choose one:\n` +
            `  - First call plan_revise({ plan_id, new_steps, new_deliverables, reason }) to convert, then execute, then plan_close success\n` +
            `  - Or plan_close({ plan_id, outcome:'failure', summary, deliverable_status:{} }) to wrap up acknowledging this run was not truly executed`,
        };
      }

      const expectedIds = new Set(planCurrent.deliverables.map((d) => d.id));
      const provided = rawDelivStatus as Record<string, unknown>;
      const providedKeys = new Set(Object.keys(provided));

      // (C1) keys must exactly equal the deliverable ids set
      const missing = [...expectedIds].filter((id) => !providedKeys.has(id));
      const extra = [...providedKeys].filter((id) => !expectedIds.has(id));
      if (missing.length > 0 || extra.length > 0) {
        return {
          success: false,
          output: '',
          error:
            `[spec-coverage C1] deliverable_status keys do not match plan.deliverables:` +
            (missing.length > 0 ? `\n  missing: [${missing.join(', ')}]` : '') +
            (extra.length > 0 ? `\n  extra: [${extra.join(', ')}]` : '') +
            `\n  expected: [${[...expectedIds].join(', ')}]`,
        };
      }

      // (C2) value ∈ valid 5-tier set
      const deliverableStatus: Record<string, DeliverableStatus> = {};
      for (const [k, v] of Object.entries(provided)) {
        if (typeof v !== 'string' || !VALID_DELIVERABLE_STATUS.has(v as DeliverableStatus)) {
          return {
            success: false,
            output: '',
            error:
              `[spec-coverage C2] deliverable_status['${k}'] has invalid status '${String(v).slice(0, 30)}'.` +
              `\nValid values: done / partial / skipped / failed / not-attempted`,
          };
        }
        deliverableStatus[k] = v as DeliverableStatus;
      }

      // (C3) when outcome=success, all statuses must be ∈ {done, skipped}
      let outcome: 'success' | 'failure' = outcomeRaw;
      let autoConvertedToFailure = false;
      let validationLine = '';

      if (outcome === 'success') {
        const nonSuccess: Array<[string, DeliverableStatus]> = [];
        for (const [k, v] of Object.entries(deliverableStatus)) {
          if (v !== 'done' && v !== 'skipped') {
            nonSuccess.push([k, v]);
          }
        }
        if (nonSuccess.length > 0) {
          return {
            success: false,
            output: '',
            error:
              `[spec-coverage C3] outcome='success' but some deliverables have non-done/skipped status:\n` +
              nonSuccess.map(([k, v]) => `  - ${k}: ${v}`).join('\n') +
              `\n\nChoose one:\n` +
              `  - Change outcome='failure' for failure wrap-up (distills failure playbook)\n` +
              `  - Change these deliverables to 'done' (execute+evidence) or 'skipped' (write reason in summary)`,
          };
        }

        // (C4) Phase 12 (2026-05-17): evidence contains failure signals → reject outcome=success
        // Even if all deliverable_status are done/skipped, if any step.evidence contains obvious failure markers
        // (EXCEPTION / fetch failed / TypeError / ENOENT and other infrastructure-level error words),
        // it means LLM pasted raw tool errors into evidence while claiming success — false report.
        // Limited to infrastructure-level error words only; narrative descriptions (e.g. "retried 3 times then succeeded" containing 500) do not match.
        const failureSignalPattern =
          /\b(?:EXCEPTION|TypeError|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\b|fetch failed|killed at|timed? out\b/i;
        const taintedSteps: Array<{ id: string; evidence: string }> = [];
        for (const s of planCurrent.steps) {
          if (s.evidence && failureSignalPattern.test(s.evidence)) {
            taintedSteps.push({ id: s.id, evidence: s.evidence });
          }
        }
        if (taintedSteps.length > 0) {
          return {
            success: false,
            output: '',
            error:
              `[spec-coverage C4] outcome='success' but some step.evidence contains failure signals:\n` +
              taintedSteps
                .map(
                  (t) =>
                    `  - step '${t.id}': ${t.evidence.slice(0, 150)}${t.evidence.length > 150 ? '...' : ''}`,
                )
                .join('\n') +
              `\n\nMechanism layer determined that evidence actually indicates the step failed (EXCEPTION / fetch failed / TypeError / E* errno); ` +
              `outcome cannot be 'success'.\nChoose one:\n` +
              `  - Change outcome='failure' to faithfully distill a failure playbook\n` +
              `  - If the step actually succeeded (evidence records an intermediate failure; final retry succeeded) → ` +
              `first call plan_update_step({plan_id, step_id, status:'done', evidence:'<rewritten final result>'}) ` +
              `to rewrite evidence as final success description, then plan_close success`,
          };
        }

        // (C5) all not-attempted + outcome=success → auto-convert to failure
        // (C3 already covers most cases, but keep explicit check for log clarity)
        const allNotAttempted =
          Object.values(deliverableStatus).length > 0 &&
          Object.values(deliverableStatus).every((s) => s === 'not-attempted');
        if (allNotAttempted) {
          outcome = 'failure';
          autoConvertedToFailure = true;
          validationLine =
            `⚠️ All deliverables are not-attempted; outcome automatically converted to 'failure' (spec-coverage C5)`;
        }

        // (C6) Phase 16 (2026-05-18): **operational-handoff enforcement**.
        //
        // Real-world root cause: when the onboarding turn successfully closes, plan.md Operational Knowledge
        // section is empty → subsequent scheduled fires see plan.md has no endpoint cookbook → fires hit
        // 401/404 infinite loop + reflection storm + circuit breaker.
        //
        // Fix: if the task contains recurring behavior (schedule_reminder / periodic / routine / heartbeat
        // / check-in / heartbeat / cron keywords in deliverables + steps descriptions),
        // and plan.persistedTo is non-empty (has plan.md) → plan.md Operational Knowledge
        // section must be non-empty (at least 1 endpoint / auth / gotchas entry) to close success.
        //
        // Generic mechanism, not custom-built for mycox — any long-lived agent role task benefits.
        const PERIODIC_KEYWORDS =
          /\b(schedule_reminder|periodic|routine|heartbeat|check[-_ ]?in|cron)\b/i;
        const planText =
          planCurrent.deliverables.map((d) => `${d.id} ${d.description}`).join(' ') +
          ' ' +
          planCurrent.steps.map((s) => `${s.id} ${s.description}`).join(' ');
        const isPeriodicTask = PERIODIC_KEYWORDS.test(planText);
        if (isPeriodicTask && planCurrent.persistedTo && planFiles) {
          try {
            const md = planFiles.getMarkdown(planCurrent.persistedTo);
            // extract Operational Knowledge section and check whether it has real entries (not just placeholders)
            const kSection = md ? extractOperationalKnowledge(md) : '';
            const hasEntries = /^- \[\d{4}-\d{2}-\d{2}\]/m.test(kSection);
            if (!hasEntries) {
              return {
                success: false,
                output: '',
                error:
                  `[spec-coverage C6 / Phase 16] outcome='success' but plan.md ` +
                  `(project=${planCurrent.persistedTo}) Operational Knowledge section is an empty skeleton.\n\n` +
                  `This task contains recurring behavior (schedule_reminder / routine / heartbeat / check-in etc.); ` +
                  `subsequent scheduled fires are fresh sessions that **can only rely on plan.md to find the correct endpoint+auth**.\n` +
                  `Empty Operational Knowledge = you did not write down the working endpoint during onboarding = ` +
                  `the next fire will inevitably hit a wall.\n\n` +
                  `**Fix**: before closing, call \`plan_knowledge\` one or more times to write the freshly verified:\n` +
                  `  - method + path + key headers + auth scheme for each business endpoint\n` +
                  `  - known gotchas (rate limits / error status code meanings / server quirks)\n` +
                  `into plan.md Operational Knowledge, then call plan_close success.\n\n` +
                  `Example:\n` +
                  `  plan_knowledge({\n` +
                  `    project: "${planCurrent.persistedTo}",\n` +
                  `    section: "endpoints",\n` +
                  `    entry: "POST /api/foo with Authorization: Bearer {api-key} → 200"\n` +
                  `  })`,
              };
            }
          } catch (e) {
            // plan.md read failure does not block close — only log warn (prevents mechanism-layer bug from stalling task)
            console.warn(
              `[spec-coverage C6] plan.md read failed (ignored, allowing close):`,
              (e as Error)?.message ?? e,
            );
          }
        }
      }

      // M4 / Phase 11 (2026-05-15): removed original 5 structure validations + outerIter bump section.
      // Replacement: C1-C4 deliverable_status already enforced above (coverage + outcome consistency).
      // honesty / sameRoot signals no longer hard-block close; absorbed by reflection distillation path —
      // genuine honesty issues will be written to routing_rule / playbook via reflection learning.

      const closed = plans.close(planId, outcome, summary.trim(), deliverableStatus);
      if (!closed) {
        return {
          success: false,
          output: '',
          error: `plan '${planId}' does not exist or is already closed (cannot close twice)`,
        };
      }

      // Phase 13 (2026-05-17): per-project plan.md hook.
      // persisted plan → append Run + update status + append Lessons on failure.
      // Failure only logs console.warn, does not break plan close success semantics.
      let planFileLine = '';
      if (closed.persistedTo && planFiles) {
        try {
          const project = closed.persistedTo;
          planFiles.appendRun(project, {
            startedAt: closed.createdAt,
            endedAt: closed.completedAt ?? Date.now(),
            outcome: outcome === 'success' ? 'ok' : 'failed',
            summary: summary.trim(),
            planId: closed.id,
          });
          planFiles.updateStatus(project, outcome === 'success' ? 'active' : 'active');
          // on failure, accumulate close summary as a lesson (deduplicated)
          if (outcome === 'failure' && summary.trim()) {
            const added = planFiles.appendLesson(project, summary.trim());
            if (added) planFileLine = `\nplan.md: lesson appended (project=${project})`;
          }
          if (!planFileLine) planFileLine = `\nplan.md: run written (${project})`;
        } catch (e) {
          planFileLine = `\nplan.md: ⚠️ hook failed (ignored): ${String(e).slice(0, 100)}`;
        }
      }

      // MECE fixation hook (v17, 2026-05-11). Skipped when skills is not injected; only closes the plan.
      let meceLine = '';
      if (skills) {
        try {
          const r = applyMECEFixation(closed, outcome, summary.trim(), skills);
          if (r.kind === 'refined') {
            meceLine = `\nMECE: ✏️ refined existing skill '${r.skillName}'${r.reason ? ` (${r.reason})` : ''}`;
          } else if (r.kind === 'created') {
            meceLine = `\nMECE: ✨ created new skill '${r.skillName}' (maturity=draft)`;
          } else if (r.kind === 'failure-playbook') {
            meceLine = `\nMECE: 📛 failure pattern playbook written to '${r.skillName}'; visible on next turn for same task`;
          } else {
            meceLine = `\nMECE: skipped (${r.reason ?? 'reason unknown'})`;
          }
        } catch (e) {
          meceLine = `\nMECE: ⚠️ fixation failed (ignored): ${String(e).slice(0, 100)}`;
        }
      }

      const header = autoConvertedToFailure
        ? `📛 plan auto-converted to failure wrap-up, status → ${closed.status}`
        : `✅ plan ${outcome === 'success' ? 'completed' : 'closed with failure'}, status → ${closed.status}`;

      return {
        success: true,
        output:
          (validationLine ? validationLine + '\n' : '') +
          header +
          `\nsummary: ${summary.trim()}` +
          meceLine +
          planFileLine,
      };
    },
  };

  // ── plan_knowledge (Phase 14, 2026-05-18) ──────────────────────────────────
  // LLM proactively accumulates endpoint / auth / gotcha experience to plan.md Operational Knowledge section.
  //
  // Design motivation: production tests of mycox repeated 401 failures across fires — LLM knows the
  // placeholder syntax from listCredentialNames but doesn't remember "upvote requires X-API-Key header",
  // so tries Bearer again next fire. routing_rules distilled by reflection are "avoid mistakes" style,
  // with no concrete copyable examples. plan_knowledge lets LLM write the endpoint cookbook **the first
  // time a successful call is made**; subsequent fires see it in prefix auto-inject and can copy directly.
  //
  // Write: planFiles.appendKnowledge(project, entry, subsection), hash dedup.
  // Read: chat-handler buildMemoryPrefix injects full plan.md text during scheduled fires; LLM sees it.
  const planKnowledgeTool: MemoryTool = {
    name: 'plan_knowledge',
    capability: 'write',
    domain: 'self',
    description:
      'Persist project-specific endpoint / auth / limit / gotcha experience to ' +
      '~/.philont/projects/<project>/plan.md Operational Knowledge section; ' +
      'auto-injected into prefix on subsequent fires. LLM calls proactively; mechanism layer hash-deduplicates.\n' +
      '\n' +
      '[When to call]\n' +
      '- **First time successfully calling a new endpoint** → write down method/path/headers/status; subsequent fires can copy directly\n' +
      '- Learned auth scheme from trial and error (e.g. "upvote uses X-API-Key not Bearer") → write immediately\n' +
      '- Found server bug / limit / known gotcha → write into gotchas so next run skips it\n' +
      '\n' +
      '[When not to call]\n' +
      '- General patterns (cross-project) → use routing_rule instead\n' +
      '- One-time observations / temporary variable values → use store_fact instead\n' +
      '- Failed endpoints (invalidated) → can still write into gotchas section, mark as "disabled"\n' +
      '\n' +
      '[Entry format suggestions]\n' +
      '- endpoints section: `POST /api/posts/<id>/upvote, headers {X-API-Key: {mycox-api-key}}, returns 200 ok`\n' +
      '- auth section: `header X-API-Key: {mycox-api-key} (not Authorization: Bearer)`\n' +
      '- gotchas section: `PUT /memories/<key> occasionally returns 500 INTERNAL_ERROR, server bug, can skip`\n' +
      '\n' +
      '[dedup] Same entry text (exact match) hash already exists → silently skip, do not write duplicate.',
    schema: {
      type: 'object',
      required: ['project', 'entry'],
      properties: {
        project: {
          type: 'string',
          description: 'kebab-case project name (e.g. "mycox"). Must match plan.persistedTo / schedule.project to be visible to scheduled fires.',
        },
        entry: {
          type: 'string',
          description: 'One piece of experience (≤ 200 chars). One entry per line; do not stuff paragraphs.',
        },
        section: {
          type: 'string',
          enum: ['endpoints', 'auth', 'gotchas', 'limits', 'general'],
          description: 'Category (default general). Subsection is rendered as an h3 heading in plan.md.',
        },
      },
    },
    async execute(params) {
      if (!planFiles) {
        return {
          success: false,
          output: '',
          error: 'planFiles not injected; plan_knowledge unavailable (server bootstrap missing)',
        };
      }
      const p = params as { project?: string; entry?: string; section?: string };
      const project = typeof p.project === 'string' ? p.project.trim() : '';
      const entry = typeof p.entry === 'string' ? p.entry.trim() : '';
      const section = (typeof p.section === 'string' ? p.section : 'general') || 'general';

      if (!project) {
        return { success: false, output: '', error: 'project is required (kebab-case)' };
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(project)) {
        return {
          success: false,
          output: '',
          error: `project must be kebab-case (lowercase alphanumeric + hyphens, 2-60 chars), got "${project}"`,
        };
      }
      if (!entry) {
        return { success: false, output: '', error: 'entry is required (experience content)' };
      }
      if (entry.length > 500) {
        return {
          success: false,
          output: '',
          error: `entry too long (${entry.length} chars, limit 500) — split into multiple entries, one per line`,
        };
      }
      try {
        const added = planFiles.appendKnowledge(project, entry, section);
        return {
          success: true,
          output: added
            ? `Written to plan.md (${project} / ${section}): ${entry.slice(0, 80)}${entry.length > 80 ? '...' : ''}`
            : `Already exists (same entry hash dedup): ${entry.slice(0, 80)}`,
        };
      } catch (e) {
        return {
          success: false,
          output: '',
          error: `plan_knowledge write failed: ${String(e).slice(0, 200)}`,
        };
      }
    },
  };

  return [
    planDraftTool,
    planUpdateStepTool,
    planReviseTool,
    planCloseTool,
    planKnowledgeTool,
  ];
}
