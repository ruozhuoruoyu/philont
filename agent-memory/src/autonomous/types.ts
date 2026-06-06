/**
 * K8 Initiative Layer — core type definitions for the initiative layer.
 *
 * Key difference from K7 reactive drives (TsDriveEngine in drive_runtime.ts):
 *   - K7 drive: inputs turn-time state (recentMessages etc.), outputs a DriveProposal
 *     (injected text for the LLM), does not call tools or write memory
 *   - K8 driver: inputs idle-time MemorySnapshot, outputs Initiative (candidate actions);
 *     loop dispatches to executor which actually runs tools / calls LLM / writes memory
 *
 * The two interface sets deliberately do not reuse the same type names, to prevent
 * changes in one from cascading to the other.
 */

import type { Fact, Pursuit, Skill } from '../types.js';
import type { RoutingRule } from '../routing_rules.js';

/**
 * Status of a single initiative.
 *   pending  — persisted to DB, not yet started
 *   running  — executor is running it (locked; will not be picked up again)
 *   done     — ran successfully; outcome written
 *   failed   — threw an error during execution; recorded in the error field
 *   skipped  — blocked by budget gate, or hit the 24h dedup window
 */
export type InitiativeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * Candidate action proposed by a driver. The loop sorts a group of Initiatives, applies budget
 * filtering, and passes them to the executor.
 *
 * Has no id — the driver is a pure function; the id is generated when InitiativeStore.insert
 * persists it to the database.
 */
export interface InitiativeProposal {
  /** Driver internal category (e.g. fact_gap / curiosity_token / routing_dispute) */
  kind: string;
  /** Driver's own name (corresponds to Driver.name) */
  driver: string;
  /**
   * Stable reference for the action target; used for 24h same-target deduplication.
   * Recommended format: "<source>:<id>", e.g. "fact:abc123" / "token:Anthropic-MCP" /
   * "routing:42" / "skill:pdf-to-word". If a done record exists for the same targetRef
   * within 24h, the proposal is skipped.
   */
  targetRef: string;
  /** Human-readable "why this is worth doing" — driver-supplied rationale, written to audit. */
  rationale: string;
  /** 0..1, driver self-assessed utility. Loop sorts by this and takes top-K when capped. */
  utility: number;
  /** Estimated LLM token count; used for coarse budget gate pre-filtering (actual spend is back-filled by executor). */
  budgetEstimate: number;
  /**
   * Optional inline execution plan. Executor runs tools in this plan first; if absent, LLM plans on its own.
   * v1 typically wraps one or two tool calls, e.g. [{tool:'webSearch', params:{query:'...'}}]
   */
  plan?: InitiativePlanStep[];
}

export interface InitiativePlanStep {
  tool: string;
  params: unknown;
}

/**
 * An initiative row after it has been persisted to the database (the shape returned by InitiativeStore).
 */
export interface Initiative extends InitiativeProposal {
  id: string;
  status: InitiativeStatus;
  budgetActual: number | null;
  outcomeSummary: string | null;
  outcomeRefs: InitiativeOutcomeRefs | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** Output references back-filled by the executor after running; stored as JSON in the outcome_refs column. */
export interface InitiativeOutcomeRefs {
  facts: string[];
  notes: string[];
  pursuits: string[];
}

/**
 * Full memory snapshot given to drivers on each loop tick.
 *
 * SELECTed by the loop in one pass; driver propose() is a pure function that reads this object.
 * All fields are readonly snapshots; drivers must not mutate them.
 */
export interface MemorySnapshot {
  /** All active facts (superseded_by IS NULL AND forgotten_at IS NULL) */
  facts: readonly Fact[];
  /** All routing rules (all confidence levels; driver filters itself) */
  routingRules: readonly RoutingRule[];
  /** All skills (all maturity levels) */
  skills: readonly Skill[];
  /** Active pursuits under root */
  activePursuits: readonly Pursuit[];
  /**
   * Specific tokens extracted (deduplicated) from the most recent N raw timeline entries.
   * Used by the curiosity driver via extractSpecificTokens; pre-computed here so drivers can consume directly.
   */
  recentTimelineTokens: readonly string[];
  /** For deduplication: set of target_refs for done initiatives in the past 24h (driver filters itself) */
  recentDoneTargetRefs: ReadonlySet<string>;
  /** Current timestamp (epoch ms); used by drivers to compute age etc. */
  now: number;
}

/**
 * Driver interface — propose is a pure function that scans a snapshot and produces candidates.
 *
 * Drivers are not allowed to write to the DB or call LLM. All side effects are concentrated in the executor.
 */
export interface Driver {
  readonly name: string;
  /**
   * Scans the snapshot and produces 0..N candidates.
   *
   * Implementation notes:
   *   - Must use snap.recentDoneTargetRefs to filter out targets already handled in the past 24h
   *   - utility estimates should be internally consistent within a driver (cross-driver ordering is handled by the loop globally)
   *   - Do not return large numbers of low-value candidates — the loop will truncate them, but CPU is wasted
   */
  propose(snap: MemorySnapshot): InitiativeProposal[];
}

/**
 * Executor interface — runs a single initiative.
 *
 * The concrete implementation is injected by the loop. Tests can inject a mock executor.
 */
export interface InitiativeExecutor {
  /**
   * Runs an initiative.
   *
   *   - Should not throw on failure; write the error into the return result so the loop can persist it
   *   - Must update the actual budget spend (executor itself calls budget tracker.commit)
   *   - On the success path, must write back to facts/notes/pursuits and fire an interrupt
   */
  run(initiative: Initiative): Promise<InitiativeRunResult>;
}

export interface InitiativeRunResult {
  status: 'done' | 'failed' | 'skipped';
  outcomeSummary?: string;
  outcomeRefs?: InitiativeOutcomeRefs;
  /** v24 active research: whether the open question targeted by this research has been answered (determined by executor LLM). */
  questionAnswered?: boolean;
  /**
   * Active research "request permission": when the executor LLM determines that answering this question
   * requires an **unauthorized** gated tool, the request is surfaced here (needsGrant=true).
   * The initiative is still markDone (no suspended state introduced); the OutcomeHook records
   * requestedTool in question.pendingTool, rendered as pending approval → user grant_research_tool
   * approves → driver replays next tick.
   */
  needsGrant?: boolean;
  requestedTool?: { tool: string; why: string };
  error?: string;
  /** Actual LLM tokens spent (used to calibrate estimates) */
  llmTokensSpent: number;
  /** Actual number of tool calls made */
  toolCallsSpent: number;
}

/**
 * Side-effect hook invoked after an initiative is persisted as done (or failed/skipped).
 *
 * Use case: PursuitProgressWriter writes pursuit.progressMarkers / evidenceRefs after a
 * pursuit:* initiative is done; more hooks can be attached in the future (e.g. K7-bridge
 * writing facts back to a ContradictionResolution table).
 *
 * Non-blocking — the loop awaits the hook, but hooks should return quickly. Failures are
 * only logged via console.warn.
 *
 * Hooks are called for all statuses; implementations decide whether to handle based on result.status.
 */
export type OutcomeHook = (
  initiative: Initiative,
  result: InitiativeRunResult,
) => Promise<void> | void;

/** When the executor uses LLM, the LLM output is parsed against this schema. */
export interface ExecutorLlmOutput {
  /** Short summary (≤500 chars), written to outcome_summary */
  summary: string;
  /** Facts to store in memory_facts */
  facts: ExecutorFactProposal[];
  /** Notes to store in memory_notes */
  notes: ExecutorNoteProposal[];
  /** Whether to escalate to HIGH severity interrupt (so the user sees it in the next turn) */
  shouldEscalate: boolean;
  /**
   * v24 active research: when this research targets a specific open question, set to true if
   * sufficient evidence to **answer it** has been found.
   * The question id is implied by initiative.targetRef (pursuit:<id>:q:<qid>); LLM only signals yes/no.
   * ProgressWriter uses this to closeOpenQuestion → research converges as questions are answered one by one.
   */
  questionAnswered?: boolean;
  /**
   * Active research "request permission": if the LLM determines that answering this question requires
   * a gated tool it currently lacks (running Lean/Z3/Python verification etc.), fill this field
   * (tool=tool name, why=human-readable reason). Otherwise omit.
   * Executor uses this to take the needsGrant path (see InitiativeRunResult).
   */
  requestedTool?: { tool: string; why: string };
}

export interface ExecutorFactProposal {
  namespace?: string;
  key: string;
  value: unknown;
  /** 0..1, default 0.7 (facts produced by autonomous research should not be pre-set to full confidence) */
  confidence?: number;
  /** At least one source (URL / "local note X" etc.); empty arrays are rejected (prevents fabrication) */
  sourceRefs: string[];
}

export interface ExecutorNoteProposal {
  /** Plain text to write to memory_notes (content); title is only used as a summary label */
  title: string;
  body: string;
  importance?: number;
}
