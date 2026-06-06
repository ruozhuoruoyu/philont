/**
 * K7 → K8 bridge — converts K7 reactive drive (turn-time) fire signals into K8 initiative layer
 * (idle-time) InitiativeProposals, so the agent will **actually verify** its own commitments
 * during the next idle tick.
 *
 * Bridge position: chat-handler calls collectK7BridgeInitiatives once at the end of a turn
 * (after driveRuntime.afterTurn, before the reflection trigger). The bridge is a **pure function**:
 * does not write to DB, does not call LLM. chat-handler inserts the returned InitiativeProposal[]
 * directly into InitiativeStore. The loop picks them up naturally in the next tick.
 *
 * K7 signals currently bridged:
 *   - TaskCommitmentDrive (fired)                → commitment:research-handoff
 *   - HonestyGate.failures_with_claim            → honesty:retry-failed-tool
 *   - HonestyGate.memory_claim_without_write     → honesty:audit-memory-lapse
 *   - HonestyGate.unknown_results_with_claim     → honesty:audit-trail
 *
 * **Not** bridged:
 *   - EmptyConclusionGate: already regenerated/fixed this turn; K8 redo is pointless.
 *   - HonestyGate.fabricated_size_claim (from 2026-06-02): the in-turn silent gate already
 *     blocks real fabrication; idle-period inspectPath verification + feedback "I've self-corrected"
 *     over-triggers on "stale size in old memory" (not fabrication), creating a performative
 *     self-justification ritual with harassment >> value. Keep only the in-turn silent layer.
 *   - HonestyGate.unverified_destructive: **dead branch**. evaluateHonesty has not produced
 *     this reason since 2026-05-18 (branch 2 stopped firing); no evaluation of this kind
 *     reaches the bridge. Case label kept as documentation.
 *
 * Tool whitelist (see executor.ts DEFAULT_TOOL_WHITELIST):
 *   - listDir: verify "X is in directory" claims
 *   - searchSkills / searchNotes / webSearch: used for research-handoff
 *   - other read-only tools
 */

import { createHash } from 'node:crypto';
import type { HonestyEvaluation, ToolResultRecord } from '../honesty_gate.js';
import type { FiredDrive, TurnObservations } from '../drive_runtime.js';
import type { InitiativeProposal, InitiativePlanStep } from './types.js';

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Snapshot of K7 reactive signals within one turn. chat-handler fills this at turn end and passes it to the bridge.
 */
export interface BridgeInput {
  /** List of drives fired by driveRuntime.beforeTurn this turn (only TaskCommitment is bridged) */
  fired: readonly FiredDrive[];
  /** Latest HonestyGate evaluation fired this turn (undefined if not fired) */
  honesty?: {
    eval: HonestyEvaluation;
    /** toolResults used in the evaluation (for extracting paths / failed tool names) */
    toolResults: readonly ToolResultRecord[];
    /** assistant text (for path extraction) */
    assistantText: string;
  };
  /** Turn observations this turn (not yet used; placeholder for future expansion) */
  observations: TurnObservations;
  /**
   * Set of done targetRefs from the last 24h (supplied by loop snapshot). Bridge uses this for
   * self-dedup to prevent chat-handler from re-queuing the same target across consecutive similar turns.
   * Optional; the loop tick side will dedup again anyway.
   */
  recentDoneTargetRefs?: ReadonlySet<string>;
  /** Stable identifier for generating turn-granularity targetRefs. Recommended: sessionId+turnIndex. */
  turnRef?: string;
}

const DRIVER_NAME = 'k7-bridge';

// ── Top-level ─────────────────────────────────────────────────────────────

/**
 * Produce 0..N K8 InitiativeProposals based on K7 signals from this turn.
 *
 * Caller: chat-handler calls this once at turn end; inserts each returned proposal into InitiativeStore.
 * The loop picks them up naturally in the next tick.
 */
export function collectK7BridgeInitiatives(
  input: BridgeInput,
): InitiativeProposal[] {
  const proposals: InitiativeProposal[] = [];
  const dedup = input.recentDoneTargetRefs ?? new Set<string>();

  // (1) TaskCommitment fired
  for (const f of input.fired) {
    if (f.driveId !== 'task-commitment' && !f.driveId.includes('task-commitment')) {
      // Only bridge TaskCommitment; other drives not bridged for now
      continue;
    }
    const p = bridgeTaskCommitment(f);
    if (p && !dedup.has(p.targetRef)) proposals.push(p);
  }

  // (2) HonestyGate fired
  if (input.honesty) {
    const p = bridgeHonesty(
      input.honesty.eval,
      input.honesty.toolResults,
      input.honesty.assistantText,
      input.turnRef,
    );
    if (p && !dedup.has(p.targetRef)) proposals.push(p);
  }

  return proposals;
}

// ── TaskCommitment ───────────────────────────────────────────────────────

/**
 * Converts a TaskCommitment fire into a "research handoff alternative" initiative.
 *
 * targetRef = `commit:<handoff-hash>`, handoff-hash = sha256(snippet+verb).slice(0,12)
 * Same handoff is not redone within 24h.
 */
export function bridgeTaskCommitment(
  fired: FiredDrive,
): InitiativeProposal | null {
  const snap = fired.triggerSnapshot as
    | {
        matchedSnippet?: string;
        matchedVerb?: string;
        taskHint?: string | null;
        lastAssistantHead?: string;
      }
    | undefined;
  if (!snap || !snap.matchedSnippet) return null;

  const hash = sha12(snap.matchedSnippet + '|' + (snap.matchedVerb ?? ''));
  const taskHint = snap.taskHint ?? '';
  const verb = snap.matchedVerb ?? '?';

  // Query keywords: user's task hint is the first choice; fall back to verb + context snippet
  const query =
    (taskHint && taskHint.trim()) ||
    `${verb} ${snap.lastAssistantHead?.slice(0, 60) ?? ''}`.trim();

  const plan: InitiativePlanStep[] = [
    { tool: 'searchSkills', params: { query } },
    { tool: 'searchNotes', params: { query } },
    { tool: 'webSearch', params: { query } },
  ];

  return {
    kind: 'commitment:research-handoff',
    driver: DRIVER_NAME,
    targetRef: `commit:${hash}`,
    rationale:
      `K7 TaskCommitment detected I handed the task back to the user ("${snap.matchedSnippet.slice(0, 60)}", ` +
      `verb=${verb}${taskHint ? `, taskHint="${taskHint}"` : ''}). ` +
      `I should research whether there is a tool-accessible approach, and write "no X path" or "X path available" into notes so future similar situations can be handled directly.`,
    utility: 0.8,
    budgetEstimate: 1800,
    plan,
  };
}

// ── HonestyGate ──────────────────────────────────────────────────────────

/**
 * Converts a HonestyGate fire into a K8 initiative. The reason determines kind / plan / utility.
 */
export function bridgeHonesty(
  evaluation: HonestyEvaluation,
  toolResults: readonly ToolResultRecord[],
  assistantText: string,
  turnRef: string | undefined,
): InitiativeProposal | null {
  const turn = turnRef ?? sha12(assistantText.slice(0, 200));

  switch (evaluation.reason) {
    case 'fabricated_size_claim':
      // 2026-06-02: **no longer bridged**. The in-turn silent gate (chat-handler fabricated_size
      // branch) already force-rewrites and never sends to user — real fabrication is blocked there.
      // The K8 idle-period inspectPath verification + feedback "I've self-corrected N bytes"
      // was over-triggering on "stale size in old memory" (not fabrication), producing a performative
      // self-justification ritual (excessive re-verification + "no fabrication this time" self-defense).
      // Harassment >> value. Remove the external loop; keep the silent gate safety net.
      return null;
    case 'failures_with_claim':
      return buildFailuresWithClaimProposal(evaluation, toolResults, turn);
    case 'memory_claim_without_write':
      return buildMemoryLapseProposal(evaluation, turn);
    case 'unverified_destructive':
      // 2026-06-02: **dead branch, no longer bridged**. The only producer of HonestyEvaluation,
      // evaluateHonesty, stopped firing branch 2 completely since 2026-05-18 (Phase 13.5 v3)
      // (see honesty_gate.ts). No reason==='unverified_destructive' evaluation ever reaches here.
      // Case label kept as documentation: if branch 2 is ever restored, re-connect here.
      return null;
    case 'unknown_results_with_claim':
      return buildUnknownResultsProposal(evaluation, turn);
    default:
      // Unknown reason — conservatively do not enqueue
      return null;
  }
}

// ── HonestyGate per-branch builders ────────────────────────────────────────

// Note: buildFabricatedSizeProposal was removed on 2026-06-02 — fabricated_size_claim
// is no longer bridged to K8 (see bridgeHonesty switch). The in-turn silent gate is the only retained layer.

function buildFailuresWithClaimProposal(
  e: HonestyEvaluation,
  toolResults: readonly ToolResultRecord[],
  turn: string,
): InitiativeProposal {
  // Collect the set of failed tool names to use as query keywords
  const failedTools = Array.from(
    new Set(
      toolResults
        .filter((r) => r.content.startsWith('⚠'))
        .map((r) => r.toolName)
        .filter((n) => n && n.length > 0),
    ),
  );
  const query =
    failedTools.length > 0
      ? `${failedTools.join(' ')} failure alternative approaches`
      : 'alternative approaches for tool failures this turn';
  const plan: InitiativePlanStep[] = [
    { tool: 'searchSkills', params: { query } },
    { tool: 'searchNotes', params: { query } },
    { tool: 'webSearch', params: { query } },
  ];
  return {
    kind: 'honesty:retry-failed-tool',
    driver: DRIVER_NAME,
    targetRef: `honesty:retry-failed:${turn}`,
    rationale:
      `K7 HonestyGate failures_with_claim: this turn had ${e.failCount} failure(s)/${e.okCount} success(es), ` +
      `yet I claimed "${e.matchedClaim}". ` +
      `The alternative paths for failed tool(s)${failedTools.length > 0 ? ` (${failedTools.join(', ')})` : ''} should be researched; ` +
      `produce a note "<tool/task> alternative approaches on failure" so future similar situations avoid hitting the same wall.`,
    utility: 0.85,
    budgetEstimate: 1800,
    plan,
  };
}

function buildMemoryLapseProposal(
  e: HonestyEvaluation,
  turn: string,
): InitiativeProposal {
  // No tool call needed: record this "verbal promise without actual storage" event as a fact for audit visibility.
  return {
    kind: 'honesty:audit-memory-lapse',
    driver: DRIVER_NAME,
    targetRef: `honesty:memory-lapse:${turn}`,
    rationale:
      `K7 HonestyGate memory_claim_without_write: I said "${e.matchedClaim}" but called no store_fact this turn. ` +
      `Leave an audit note marking this event, to remind subsequent reflection to escalate this behavior into a routing rule (verbal memory claim → must call store_fact to persist).`,
    utility: 0.7,
    budgetEstimate: 800,
    plan: [], // executor goes straight to LLM to write a note; no tools needed
  };
}

// Note: buildUnverifiedDestructiveProposal was removed on 2026-06-02 — unverified_destructive
// is a dead branch (evaluateHonesty no longer produces this reason; see bridgeHonesty switch).

function buildUnknownResultsProposal(
  e: HonestyEvaluation,
  turn: string,
): InitiativeProposal {
  return {
    kind: 'honesty:audit-trail',
    driver: DRIVER_NAME,
    targetRef: `honesty:audit-trail:${turn}`,
    rationale:
      `K7 HonestyGate unknown_results_with_claim: this turn had ${e.unknownCount} tool result(s) that are all indeterminate, ` +
      `yet I claimed "${e.matchedClaim}". Leave an audit note recording this "unverified completion claim" event.`,
    utility: 0.65,
    budgetEstimate: 600,
    plan: [],
  };
}

// ── helper: path extraction ──────────────────────────────────────────────

/**
 * Extracts the first absolute path from text (POSIX / Windows / file://).
 * Simplified heuristic — good enough: does not parse file extensions or verify file existence.
 */
export function extractAbsolutePath(text: string): string | null {
  // POSIX: /tmp/x.docx etc.; allows surrounding quotes/punctuation; stops at whitespace or common punctuation
  const posix = text.match(/(?:^|[\s'"`(])(\/[A-Za-z0-9._/-]+)(?=[\s'"`,)。;:]|$)/);
  if (posix && posix[1]) return posix[1];
  // Windows: C:\path\file
  const win = text.match(/[A-Z]:\\[A-Za-z0-9._\\-]+/);
  if (win) return win[0];
  // file://
  const fileUri = text.match(/file:\/\/[A-Za-z0-9._/-]+/);
  if (fileUri) return fileUri[0];
  return null;
}

// ── helper: hash ──────────────────────────────────────────────────────────

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}
