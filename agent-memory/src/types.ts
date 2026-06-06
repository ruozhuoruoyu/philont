/**
 * Core types for the memory layer
 */

// ── Layer 2: Structured Facts ─────────────────────────────────────────────────

/** Namespace conventions (soft conventions, not enforced) */
export const CONVENTIONAL_NAMESPACES = [
  'user',       // User info: name, location, preferences.*
  'project',    // Project info: repo_url, tech_stack, conventions.*
  'decisions',  // Decision records: {topic} → { choice, rationale }
  'skills',     // Skill metadata: {name} → { description, last_used_at }
  'context',    // Temporary / session-scoped context
] as const;

export type ConventionalNamespace = typeof CONVENTIONAL_NAMESPACES[number];

/** Fact kind: a continuously-true state vs a one-time event */
export type FactKind = 'state' | 'event';

/** A single structured fact */
export interface Fact {
  id: string;
  namespace: string;
  key: string;
  /** Value can be any JSON-serializable type */
  value: unknown;
  /** Confidence 0-1, default 1.0 */
  confidence: number;
  /** If superseded by a newer fact, points to the new id; null when not superseded */
  supersededBy: string | null;
  /** The id of the fact this one superseded (for supersede chain backtracking) */
  supersedes: string | null;
  createdAt: number;
  /** Event time: the moment the thing actually happened (should be filled for event kind) */
  occurredAt: number | null;
  /** Validity start: when this fact became true (should be filled for state kind) */
  validFrom: number | null;
  /** Validity end: NULL = permanent */
  validUntil: number | null;
  /** Timestamp of the most recent read (LRU) */
  lastAccessedAt: number | null;
  /** Decay constant (days), NULL = use namespace default */
  decayTauDays: number | null;
  /** Soft-delete timestamp, NULL = not forgotten */
  forgottenAt: number | null;
  /** state = continuously true; event = one-time occurrence */
  factKind: FactKind;
}

/** Input for storage (automatic fields omitted) */
export interface FactInput {
  namespace: string;
  key: string;
  value: unknown;
  confidence?: number;
  occurredAt?: number | null;
  validFrom?: number | null;
  validUntil?: number | null;
  decayTauDays?: number | null;
  factKind?: FactKind;
}

// ── Layer 1: Text Fallback ───────────────────────────────────────────────────

export interface Note {
  id: string;
  content: string;
  /** Importance 0-1, used for sorting */
  importance: number;
  /** Associated session id (optional) */
  sessionId: string | null;
  createdAt: number;
  /** Timestamp of the most recent read (LRU) */
  lastAccessedAt: number | null;
  /** Soft-delete timestamp, NULL = not forgotten */
  forgottenAt: number | null;
}

export interface NoteInput {
  content: string;
  importance?: number;
  sessionId?: string | null;
}

// ── Layer 0: Raw Log ───────────────────────────────────────────────────

export interface RawSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
}

export interface RawMessage {
  id: number;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
}

export interface RawMessageInput {
  sessionId: string;
  role: RawMessage['role'];
  content: string;
}

// ── Layer 0.5: Action Log ────────────────────────────────────────────────

export interface Action {
  id: number;
  sessionId: string;
  /** The user intent or context that triggered this action (brief description) */
  trigger: string | null;
  toolName: string;
  params: unknown;
  /** Result summary (full output not stored, saves storage) */
  result: string | null;
  success: boolean;
  timestamp: number;
  /** Which skill triggered this action (feedback loop) */
  linkedSkill: string | null;
}

export interface ActionInput {
  sessionId: string;
  trigger?: string | null;
  toolName: string;
  params: unknown;
  result?: string | null;
  success: boolean;
  linkedSkill?: string | null;
}

// ── Layer 3: Skills ──────────────────────────────────────────────────────

/**
 * Skill maturity tier (v11): marks how well a skill has been validated, affects
 * retrieval injection phrasing + whether use_skill is allowed.
 *
 *   playbook   — experience notes/lessons; **cannot** use_skill, only hint injection
 *   draft      — self-written after the 1st success; usable but marked "insufficiently validated"
 *   confirmed  — success ≥ 2 and failure = 0
 *   stable     — success ≥ 5 and failure/success < 0.1
 *   deprecated — consecutive failure ≥ 3 or failure/success > 0.3 (success ≥ 5); no longer
 *                a use_skill candidate; description can still serve as a counter-example hint
 *
 * See skill_maturity.ts for the state machine.
 */
export type SkillMaturity =
  | 'playbook'
  | 'draft'
  | 'confirmed'
  | 'stable'
  | 'deprecated';

export interface Skill {
  id: string;
  /** Unique name, used as an id-friendly slug */
  name: string;
  /** One-line description: what it does and when to use it */
  description: string;
  /**
   * Trigger scenario text (2026-05-09 v15). Source: SKILL.md frontmatter `when_to_use:`
   * field; falls back to extracting the `## When to Use` section from the body. May be
   * an empty string (for older skills or reflection-generated skills).
   *
   * Purpose: when the skill index is injected into the system prompt, this lets the LLM
   * see a scenario description to semantically judge when to use this skill; for bundled
   * skills it is used as the routing rule trigger_condition.
   */
  whenToUse: string;
  /** Trigger keywords (LLM uses these to judge relevance) */
  triggerKeywords: string[];
  /** Action template: markdown/text recipe, LLM executes according to this */
  actionTemplate: string;
  /** Number of times used */
  useCount: number;
  /** Most recent use time */
  lastUsedAt: number | null;
  createdAt: number;
  /** Number of successful uses of this skill (feedback loop) */
  successCount: number;
  /** Number of failed uses of this skill */
  failureCount: number;
  /** Most recent failure time */
  lastFailureAt: number | null;
  /** Most recent success time (v11) */
  lastSuccessAt: number | null;
  /** Consecutive failure count (v11); reset to zero on any success; ≥ 3 triggers deprecated */
  consecutiveFailures: number;
  /** Skill maturity tier (v11); see SkillMaturity */
  maturity: SkillMaturity;
  /**
   * Skill polarity:
   *   'positive' — positive reusable action template (what to do)
   *   'negative' — anti-pattern / lesson (what not to do + what to do instead; from user corrections)
   */
  kind: 'positive' | 'negative';
  /**
   * Source tag (v10):
   *   null      — locally handwritten / reflectively auto-generated
   *   'clawhub:<slug>@<version>' — loaded from the ClawHub public skill library
   *   'self:reflect-<ts>-<hash>' — agent self-reflection generated (v11)
   *   other 'origin:...' — future extensions (MCP / private registry, etc.)
   *
   * chat-handler reload prune only removes rows where source is non-null but the disk file
   * has disappeared; locally handwritten skills are not touched. The system prompt index
   * appends an [origin] tag when source is non-null.
   */
  source: string | null;
}

export interface SkillInput {
  name: string;
  description: string;
  triggerKeywords: string[];
  actionTemplate: string;
  /** Trigger scenario text (2026-05-09 v15); defaults to empty string. */
  whenToUse?: string;
  /** Optional, defaults to 'positive'. 'negative' is used to carry anti-patterns/lessons. */
  kind?: 'positive' | 'negative';
  /** Optional source tag; see Skill.source. Defaults to null = locally handwritten. */
  source?: string | null;
  /**
   * Optional maturity, defaults to 'draft'. Only used at createSkill time; subsequent
   * promotions and demotions go through the state machine (recordSkillOutcome / setMaturity).
   *
   * - bundled / clawhub loaded skills: caller passes 'stable' (already validated)
   * - reflection-generated skills: default 'draft' (waits for accumulated uses)
   */
  maturity?: SkillMaturity;
}

// ── Extraction Results ────────────────────────────────────────────────────────────

export interface ExtractResult {
  /** Number of facts successfully stored in Layer 2 */
  factsStored: number;
  /** Number of notes stored in Layer 1 */
  notesStored: number;
  /** Token count consumed by this extraction call (estimated) */
  llmCostTokens: number;
  /** List of extracted facts (for debugging) */
  facts: Fact[];
  /** List of extracted notes */
  notes: Note[];
}

/** Reflection extraction result (SessionReflector) */
export interface ReflectResult {
  /** Number of new skills created in this reflection */
  skillsCreated: number;
  /** Number of existing skills updated in this reflection (use_count incremented) */
  skillsUpdated: number;
  llmCostTokens: number;
  skills: Skill[];
}

// ── Compactor ──────────────────────────────────────────────────────────────

/** Generic message interface (not bound to a specific SDK) */
export interface CompactorMessage {
  role: string;
  /** Can be a string or an SDK-specific array of content blocks */
  content: unknown;
}

export interface CompactorConfig {
  /** soft threshold: checked at turn start ("quiet period"); compacts if exceeded */
  thresholdTokens: number;
  /**
   * hard safety-net threshold: checked inside the turn's tool loop; compacts synchronously
   * only when exceeded, preventing the LLM context window from actually exploding.
   * Default = thresholdTokens × 1.4; can be overridden independently via env.
   * No in-turn compaction below this value (preserves plan_id / tool chain in the last N entries).
   */
  hardThresholdTokens?: number;
  /** Number of messages to protect at the head (system prompt + first turn not touched) */
  protectFirstN: number;
  /** Number of messages to protect at the tail (most recent N turns not touched) */
  protectLastN: number;
  /** Optional: custom token estimation function. Defaults to character count × 0.6 heuristic */
  estimator?: (msg: CompactorMessage) => number;
}

export interface CompactionResult {
  /** Compacted message array (the middle section is replaced by a summary) */
  compactedMessages: CompactorMessage[];
  /** Whether compaction was actually performed */
  didCompact: boolean;
  /** Token estimate before compaction */
  tokensBefore: number;
  /** Token estimate after compaction */
  tokensAfter: number;
  /** Summary note id written to Layer 1 (if compaction occurred) */
  summaryNoteId: string | null;
  /** Token count consumed by the LLM summarization call */
  llmCostTokens: number;
}

// ── Calendar Events (future time anchors) ────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  /** Start time (epoch ms) */
  startsAt: number;
  /** End time (epoch ms), NULL = no end (point event) */
  endsAt: number | null;
  /** iCalendar RRULE, NULL = one-time */
  rrule: string | null;
  /** IANA timezone, required */
  timezone: string;
  /** Back-linked fact id (optional) */
  relatedFactId: string | null;
  /** Third-party event id (Google/Outlook), used for deduplication */
  externalRef: string | null;
  createdAt: number;
}

export interface CalendarEventInput {
  title: string;
  startsAt: number;
  endsAt?: number | null;
  rrule?: string | null;
  timezone: string;
  relatedFactId?: string | null;
  externalRef?: string | null;
}

// ── Scheduled Tasks (future behavior commitments) ────────────────────────────────────────────

export type ScheduleActionType =
  | 'prompt'           // Push a reminder text to the frontend
  | 'tool_call'        // (reserved for policy layer) call a specific tool
  | 'reflect'          // Trigger SessionReflector
  | 'autonomous_turn'; // System-driven turn: agent autonomously runs LLM + tool calls, sessionId independent (2026-05-07)

/**
 * Creator tag for scheduled tasks; determines the SignalOrigin re-evaluated at trigger time by PolicyGate:
 *   - 'user'          Created directly by the user (treated as External)
 *   - 'llm_external'  Created by LLM via the schedule_reminder tool (External, default)
 *   - 'extractor'     Post-session processor (Internal)
 *   - 'reflector'     Skill reflector (Internal)
 *   - 'compactor'     Context compactor (Internal)
 *   - 'drive:<name>'  Internal drive engine (Internal), <name> is the engine id
 *
 * Convention: entries with the 'drive:' prefix or within the 'extractor/reflector/compactor' set
 * are recorded as Internal; all others are External. The scheduler's upper dispatch layer uses
 * this to determine the origin.
 */
export type ScheduleCreatedBy = string;

export interface Schedule {
  id: string;
  name: string;
  /** cron expression, NULL = one-time */
  cronExpr: string | null;
  /** Next run time (epoch ms) */
  nextRunAt: number;
  /** Last run time */
  lastRunAt: number | null;
  actionType: ScheduleActionType;
  /** Action payload; structure differs by actionType */
  payload: unknown;
  enabled: boolean;
  createdAt: number;
  /** Creator tag (used for origin inheritance) */
  createdBy: ScheduleCreatedBy;
  /** v16: consecutive failure count (accumulated for autonomous_turn failures; reset on any success) */
  consecutiveFailures: number;
  /** v16: soft-pause deadline (epoch ms); dueBefore is skipped when non-null and > now */
  pausedUntil: number | null;
  /**
   * v23 (Phase 13.5, 2026-05-18): project association. When a scheduled session triggers,
   * chat-handler uses this project name to locate plan.md and inject it as a prefix.
   * NULL = not a project-level schedule (pure reminder / general task).
   */
  project: string | null;
}

export interface ScheduleInput {
  name: string;
  cronExpr?: string | null;
  nextRunAt: number;
  actionType: ScheduleActionType;
  payload: unknown;
  enabled?: boolean;
  /** Creator tag; defaults to 'llm_external' (most conservative: triggers with External origin) */
  createdBy?: ScheduleCreatedBy;
  /** v23 (Phase 13.5): project association. Used to inject plan.md for scheduled sessions. */
  project?: string | null;
}

/** Parse createdBy into a SignalOrigin (Internal/External) */
export function inferOriginFromCreatedBy(createdBy: ScheduleCreatedBy): 'Internal' | 'External' {
  if (
    createdBy === 'extractor' ||
    createdBy === 'reflector' ||
    createdBy === 'compactor' ||
    createdBy === 'system'
  ) {
    return 'Internal';
  }
  if (createdBy.startsWith('drive:')) {
    return 'Internal';
  }
  // 'user' / 'llm_external' / unknown tag → External (conservative default)
  return 'External';
}

// ── Plan (v17: complex task protocol, 2026-05-11) ──────────────────────────────────
//
// The complex task protocol replaces turn-time "free improvisation" with a set of explicit contracts:
//   1. LLM self-assesses slow mode (task_mode_classify)
//   2. plan_draft writes status='draft'
//   3. plan_review(gaps=[], decision='pass') → status='reviewed', unblocked
//   4. Each step: plan_update_step updates steps_json progress
//   5. Reflection triggers plan_revise → updates steps + appends review_history
//   6. plan_close('success'|'failure') → status='completed'|'failed' + outcome_summary
//
// This is the implementation of the "six-step closed-loop" protocol in philont
// (inspired by OpenClaw's complex task protocol).

export type PlanStatus =
  // M3 / Phase 11 (2026-05-15): removed the 'reviewed' intermediate state. plan_review tool deleted;
  // draft + step→doing jumps directly to 'executing'.
  | 'draft'       // Just written by plan_draft; LLM has not started executing yet
  | 'executing'   // Automatically entered when the first step is marked doing
  | 'completed'   // Terminal state from plan_close('success')
  | 'failed';     // Terminal state from plan_close('failure')

export type PlanStepStatus =
  | 'pending'   // Not started
  | 'doing'     // In progress (startedAt is recorded when plan_update_step marks this)
  | 'done'      // Completed
  | 'blocked';  // Blocked; requires plan_revise intervention

/**
 * Deliverable (v20, 2026-05-15, Phase 11 spec-coverage):
 *
 * The "deliverables" explicitly listed in a plan — each independent output item required
 * by the user's guide. Example: mycox onboarding task deliverables = [
 *   { id: 'register',     description: 'register account', source: 'guide.md#part-1' },
 *   { id: 'post-first',   description: 'publish first post', source: 'guide.md#part-2' },
 *   { id: 'heartbeat',    description: 'start heartbeat', source: 'guide.md#part-3' },
 * ]
 *
 * id must be kebab-case and unique within the plan; description must be at least 8 characters.
 * The mechanism layer validates the parameter structure, not the semantics (the LLM decides
 * which entries are true deliverables).
 */
export interface PlanDeliverable {
  /** kebab-case, unique within the plan */
  id: string;
  /** ≥ 8 characters, human-readable deliverable description */
  description: string;
  /** Optional: guide reference excerpt */
  source?: string;
}

/**
 * Deliverable completion status (v20, LLM annotates each item at plan_close time):
 *
 * - 'done': completed and verifiable (evidence is in step.evidence)
 * - 'partial': partially completed (e.g. required 3 posts but only 1 published)
 * - 'skipped': actively skipped (must include a reason; LLM explains in summary)
 * - 'failed': attempted but failed (hit a wall)
 * - 'not-attempted': not attempted (outside the scope of this turn / overlooked)
 */
export type DeliverableStatus =
  | 'done'
  | 'partial'
  | 'skipped'
  | 'failed'
  | 'not-attempted';

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  /**
   * List of deliverable ids covered by this step (v20 spec-coverage, 2026-05-15).
   * Mechanism layer validates: each id must be ∈ plan.deliverables; each deliverable must
   * be covered by ≥ 1 step. Optional in M1 phase (transitional default []); M4 makes it
   * strictly required (placeholder plan exception).
   */
  covers: string[];
  /** Completion evidence (URL / file path / tool output excerpt), nullable */
  evidence: string | null;
  /** Timestamp when marked doing; used for step_timeout monitoring */
  startedAt: number | null;
  /** Timestamp when marked done / blocked */
  completedAt: number | null;
}

/** A single plan_review record: LLM self-checks plan vs guide, listing gaps and its decision */
export interface PlanReview {
  at: number;
  /** List of gaps found during self-check; empty + decision='pass' is required to unblock */
  gaps: string[];
  decision: 'pass' | 'revise';
  /** Revision reason filled when revising (written by plan_revise, also by reflection plan_revision) */
  reason: string | null;
}

export interface Plan {
  id: string;
  sessionId: string;
  /** Task signature shared with routing_rules / skills for cross-session reuse; nullable */
  taskSignature: string | null;
  steps: PlanStep[];
  /**
   * Deliverables list (v20, 2026-05-15, Phase 11 spec-coverage).
   * Mechanism layer validates: plan_draft requires deliverables ≥ 1 (placeholder exception);
   * each deliverable must be covered by ≥ 1 step.covers. Optional in M1 phase (default empty); M4 enforces strictly.
   */
  deliverables: PlanDeliverable[];
  /**
   * Deliverable status annotated by LLM at plan_close time (v20). Null before close.
   * Mechanism layer validates: keys must exactly equal the deliverable id set;
   * value ∈ 5 DeliverableStatus tiers; outcome='success' with any non-done/skipped → reject.
   */
  deliverableStatus: Record<string, DeliverableStatus> | null;
  status: PlanStatus;
  /** Record of all past gap-check + revise iterations */
  reviewHistory: PlanReview[];
  /**
   * Whether this is a placeholder plan (v20, 2026-05-15):
   * A "skeleton" plan created by chat-handler auto-plan-on-slow / auto-revise-on-fail.
   * Allows empty deliverables / step.covers, but the LLM must formalize it via plan_revise
   * (providing new_deliverables) before close success is allowed.
   */
  isPlaceholder: boolean;
  /**
   * Phase 13 (2026-05-17): if non-null, this plan is linked to a project plan.md file.
   * File path = `<PlanFileStore.baseDir>/<persistedTo>/plan.md` (plan.md is the LLM's
   * long-term project work notes; DB plan is the machine-facing current-turn protocol body).
   * NULL = DB plan only (default, ad-hoc / one-off tasks).
   */
  persistedTo: string | null;
  /** User-provided guide reference: SKILL.md name / user message excerpt / URL; nullable */
  guideRef: string | null;
  /** Execution summary filled at plan_close time */
  outcomeSummary: string | null;
  /**
   * Inner loop counter (v19, 2026-05-13): number of plan_review failures.
   * Mechanism layer bumps when gap is non-empty OR decision='revise' OR plan_revise is called.
   * ≥ INNER_LOOP_MAX → escalates to askUserQuestion.
   * Reset to 0 when plan_review passes (gap=[] AND decision='pass').
   *
   * **Progressively deprecated from v20 Phase 11 onward**: field deleted in M5, SQL column retained.
   */
  innerIter: number;
  /**
   * Outer loop counter (v19, 2026-05-13): number of times plan_close('success') was rejected by the mechanism layer.
   * Bumped at close-time when any hard check fails (step not completed / evidence empty / honesty fired / sameRootCause≥2).
   * ≥ OUTER_LOOP_MAX → auto plan_close('failure') + distill failure playbook.
   *
   * **Progressively deprecated from v20 Phase 11 onward**: field deleted in M5, SQL column retained.
   */
  outerIter: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface PlanInput {
  sessionId: string;
  taskSignature?: string | null;
  /** Step list; step.id is auto-generated by the store when omitted */
  steps: Array<{
    id?: string;
    description: string;
    status?: PlanStepStatus;
    /** v20 spec-coverage: list of deliverable ids covered by this step (M1 optional) */
    covers?: string[];
  }>;
  /** v20 spec-coverage: deliverables list (M1 optional, M4 enforces strictly) */
  deliverables?: PlanDeliverable[];
  /** v20: placeholder plan flag (set to true when chat-handler creates a recovery plan) */
  isPlaceholder?: boolean;
  /**
   * Phase 13 (2026-05-17): if provided, write to the corresponding project plan.md after plan creation.
   * Value is the project name (kebab-case); plan_tools translates the LLM's `project` / `persist`
   * parameters into this field. null/undefined = no file (default).
   */
  persistedTo?: string | null;
  guideRef?: string | null;
}

// ── Pursuit (v7 addition: agent identity + soul heartbeat) ───────────────────────────
//
// Core conventions:
//   - The pursuit row where parent_pursuit_id IS NULL is the root; root pursuit = agent identity
//   - All other self-domain tables link to the root via the root_pursuit_id redundant column for flat queries
//   - Constitution four fields (values / red_lines / drive_bounds / pursuit_governance)
//     are only valid on the root row; non-root rows leave them empty; treated as frozen during session runtime
//   - pursuits with is_evergreen are immune to stale detection and automatic achieved determination

/** Pursuit lifecycle status */
export type PursuitStatus = 'active' | 'paused' | 'shadow' | 'achieved' | 'archived' | 'abandoned';

/**
 * Pursuit creation origin. Affects SignalOrigin inference and trust boundaries at trigger time:
 *   - 'user'           Explicitly declared by the user (External)
 *   - 'system'         Automatically created by MemoryDB bootstrap (Internal)
 *   - 'extractor'      Inferred from the session by SessionExtractor (Internal, defaults to shadow state)
 *   - 'reflector'      Proposed by SessionReflector (Internal, defaults to shadow state)
 *   - 'llm_proposed'   Actively proposed by LLM during runtime (Internal, must enter shadow state)
 */
export type PursuitOrigin = 'user' | 'system' | 'extractor' | 'reflector' | 'llm_proposed';

/** Pursuit priority weight tier (stake × ... calculation used in arbitration) */
export type PursuitStake = 'low' | 'medium' | 'high';

/** Open question status */
export type OpenQuestionStatus = 'open' | 'resolved' | 'dismissed';

/** A single unresolved question (the "continuous trigger source" for a pursuit) */
export interface OpenQuestion {
  id: string;
  text: string;
  status: OpenQuestionStatus;
  /** Which evidence/fact/turn resolved this question; filled when resolved */
  resolvedBy?: string | null;
  createdTurn: number;
  updatedTurn: number;
  /**
   * Active research "permission request": when the autonomous executor determines it needs a
   * blocked gated tool (running Lean/Z3/Python, etc.) to answer this question, it records the
   * request here (tool=tool name, why=plain-language reason) and waits for the user to grant
   * approval via grant_research_tool in the conversation. Lifetime matches the question:
   * closeOpenQuestion will clear it when the question is answered. null/absent = no pending request.
   * Stored in the open_questions_json blob; no schema column.
   */
  pendingTool?: { tool: string; why: string } | null;
}

/** Progress trace (used by PursuitStaleDrive and effectiveness scoring) */
export interface ProgressMarker {
  turn: number;
  summary: string;
  /** Associated driveOutcome id (filled when a drive triggers the progress) */
  driveOutcomeId?: string | null;
}

/**
 * Constitution four fields (valid only on the root pursuit).
 * These fields are hash-written to the audit log at session startup and treated as immutable during runtime.
 */
export interface ConstitutionFields {
  /** 2~5 free-text value statements */
  values?: string | null;
  /** Hard prohibition list */
  redLines?: string[] | null;
  /**
   * Hard parameter bounds for declarative drive tuning. Structure:
   *   { [driveId]: { [paramName]: [min, max] } }
   * When Reflector writes back to drive_config, values must fall within bounds; violations go into constitution_proposals.
   */
  driveBounds?: Record<string, Record<string, [number, number]>> | null;
  /**
   * Pursuit creation governance rules.
   * Example: { llm_proposed_initial_status: 'shadow',
   *             llm_proposed_promotion_min_evidence: 3,
   *             llm_proposed_max_stake: 'medium' }
   */
  pursuitGovernance?: {
    llmProposedInitialStatus?: PursuitStatus;
    llmProposedPromotionMinEvidence?: number;
    llmProposedMaxStake?: PursuitStake;
  } | null;
}

/** Full Pursuit row */
export interface Pursuit extends ConstitutionFields {
  id: string;
  /** NULL = root = agent */
  parentPursuitId: string | null;
  /** Redundant column: root id (for the root row itself, this column points to itself) */
  rootPursuitId: string;
  title: string;
  /** Free-text goal statement */
  intent: string;
  status: PursuitStatus;
  /** evergreen = immune to stale detection / automatic achieved determination (typically true for root pursuit) */
  isEvergreen: boolean;
  stake: PursuitStake;
  /** NULL = no deadline */
  deadline: number | null;
  origin: PursuitOrigin;
  openQuestions: OpenQuestion[];
  /** What counts as done (free text) */
  resolutionCriteria: string | null;
  /** List of associated fact/note/turn ids */
  evidenceRefs: string[];
  progressMarkers: ProgressMarker[];
  /** Turn in which progress was most recently advanced; used for staleness detection */
  lastProgressTurn: number;
  /**
   * Ms timestamp that should be refreshed whenever anything makes the pursuit "come alive"
   * (addEvidence / bumpProgress / updateStatus / addOpenQuestion / closeOpenQuestion).
   * commitment_pressure uses (now - lastTouchedAt) as the aging input.
   * Backfilled to = updatedAt when migrating old databases at v9.
   */
  lastTouchedAt: number;
  /**
   * Numeric version of stake (1-10). stake (low/medium/high) is the human-readable label;
   * stake_weight is the number used in commitment_pressure calculations.
   * Mapping: low=3 / medium=5 / high=8.
   * Defaults to the mapping value when not specified at creation time; also backfilled
   * by mapping when migrating old rows at v9.
   */
  stakeWeight: number;
  /**
   * v24: true when the user has instructed "continuously research X". The autonomous loop
   * advances it every tick without waiting for staleness; automatically cleared to false
   * when the question is answered, research_iterations reaches its limit, or the user stops it.
   */
  isActiveResearch: boolean;
  /** v24: number of turns the active research has been advanced (used as convergence safety cap). */
  researchIterations: number;
  createdAt: number;
  updatedAt: number;
}

/** Input for creating a pursuit */
export interface PursuitInput {
  id?: string;
  parentPursuitId?: string | null;
  title: string;
  intent: string;
  status?: PursuitStatus;
  isEvergreen?: boolean;
  stake?: PursuitStake;
  /** 1-10 numeric value; when omitted, derived from stake mapping: low=3 / medium=5 / high=8 */
  stakeWeight?: number;
  deadline?: number | null;
  origin: PursuitOrigin;
  openQuestions?: Array<{ text: string }>;
  resolutionCriteria?: string | null;
  /** v24: mark as active research at creation time (used by research_focus tool); defaults to false. */
  isActiveResearch?: boolean;
  /** Only root (parent=null) pursuits may carry constitution fields; non-root inputs are rejected */
  values?: string | null;
  redLines?: string[] | null;
  driveBounds?: ConstitutionFields['driveBounds'];
  pursuitGovernance?: ConstitutionFields['pursuitGovernance'];
}

// ── Drive Config / Drive Outcome (v7 addition: declarative drives + feedback loop) ─────

/** Runtime status of a declarative drive */
export type DriveConfigStatus = 'active' | 'shadow' | 'retired';

/** Drive type tag (shared kind namespace for compiled drives and declarative drives) */
export type DriveKind = string;

/** Effectiveness statistics: recent-N EWMA + sample count */
export interface EffectivenessStats {
  samples: number;
  /** EWMA mean, ∈ [-1, 1] */
  ewma: number;
  /** Most recent fire time */
  lastFired: number | null;
}

/** Stored form of a declarative drive */
export interface DriveConfig {
  id: string;
  kind: DriveKind;
  status: DriveConfigStatus;
  /** Trigger expression (JSON structure; interpreted and executed by DeclarativeEngine) */
  triggerExpr: unknown;
  /** Injection action template (JSON structure) */
  actionTemplate: unknown;
  /** Tunable parameters (cooldown / priority_weight / ... defined by each kind) */
  params: Record<string, unknown>;
  effectiveness: EffectivenessStats;
  rootPursuitId: string;
  createdAt: number;
  updatedAt: number;
}

export interface DriveConfigInput {
  id?: string;
  kind: DriveKind;
  status?: DriveConfigStatus;
  triggerExpr: unknown;
  actionTemplate: unknown;
  params?: Record<string, unknown>;
  rootPursuitId: string;
}

/**
 * Persisted record of a single drive firing (append-only).
 * Reflector reads this table to calculate effectiveness and decide on parameter adjustments.
 */
export interface DriveOutcome {
  id: string;
  driveId: string;
  firedAt: number;
  /** Summary JSON of the AgentState at the time of firing */
  triggerSnapshot: unknown;
  /** Injected message/schedule/annotation JSON */
  injectedAction: unknown;
  /** Summary of tool calls made within N turns after firing */
  subsequentToolCalls: unknown[];
  /** Memory delta within N turns after firing (new fact ids / note ids) */
  memoryDelta: {
    factIds?: string[];
    noteIds?: string[];
    pursuitProgressMarkers?: string[];
  };
  /** The pursuit id being served */
  servedPursuitId: string | null;
  /** Effectiveness score, ∈ [-1, 1]; computed lazily (null at fire time, backfilled by reflector after N turns) */
  effectivenessScore: number | null;
  rootPursuitId: string;
}

export interface DriveOutcomeInput {
  id?: string;
  driveId: string;
  firedAt?: number;
  triggerSnapshot: unknown;
  injectedAction: unknown;
  subsequentToolCalls?: unknown[];
  memoryDelta?: DriveOutcome['memoryDelta'];
  servedPursuitId?: string | null;
  rootPursuitId: string;
}

// ── Memory Access Log (LRU + real-value estimation) ───────────────────────────────────

export type AccessTargetType = 'fact' | 'note' | 'skill';

export interface AccessLogEntry {
  id: number;
  targetType: AccessTargetType;
  targetId: string;
  accessedAt: number;
  context: string | null;
}

export interface AccessLogInput {
  targetType: AccessTargetType;
  targetId: string;
  context?: string | null;
}
