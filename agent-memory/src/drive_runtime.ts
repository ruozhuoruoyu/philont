/**
 * TsDriveRuntime: TypeScript-side drive runtime.
 *
 * Why a separate TS runtime:
 *   - Rust `DriveEngine` + `DriveRegistry` (agent-core) is an async watch-channel model
 *     serving consumers that go through the Rust main loop (demo / future agent-node consumers).
 *   - server/chat-handler.ts uses its own TS synchronous loop, not the Rust kernel; for drives
 *     to fire in a real session, there must be a TS runtime that can be called synchronously at each turn.
 *
 * Calling protocol:
 *
 *   // Before each LLM call:
 *   const fired = runtime.beforeTurn(state);
 *   for (const f of fired) messages.push(f.injectedUserMessage());
 *
 *   // After LLM + tools have all run, feed this turn's observed tool/fact/note delta back to runtime:
 *   runtime.afterTurn(fired, observations);
 *
 * Design invariants:
 *   - beforeTurn is synchronous; drive.evaluate() must not call LLM (keeping the reflection layer lightweight and pure)
 *   - All drive firings are persisted to memory_drive_outcomes (servedPursuitId / triggerSnapshot /
 *     injectedAction); observations are merged back into the same row afterward
 *   - Injected messages are one-shot: used this turn then discarded; effectiveness is back-filled by DriveReflector
 *   - Origin semantics: user messages injected into messages[] remain "Internal-origin" —
 *     traceable via the drive_id association in memory_drive_outcomes
 */

import type { DriveConfig, DriveOutcome, Pursuit } from './types.js';
import type { DriveOutcomeStore } from './drive_outcome.js';
import type { MemoryAuditHook } from './audit.js';

// ── Runtime observation surface (assembled per-turn on the server side) ─────────────────────────────────────

export interface RecentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface TsToolCallSummary {
  toolName: string;
  success: boolean;
  /** Brief result (first N characters) */
  resultSnippet: string;
}

export interface DriveRuntimeState {
  sessionId: string;
  /** Most recent N messages (text roles only, in chronological order); runtime freely takes the last K entries */
  recentMessages: RecentMessage[];
  /** Number of iterations completed in this session */
  iteration: number;
  /** Active pursuit summaries */
  activePursuits: ReadonlyArray<Pursuit>;
  /** Tool call summaries from this turn or the previous turn */
  recentToolCalls: TsToolCallSummary[];
}

// ── Drive interface ─────────────────────────────────────────────────────────

export interface TsDriveEngine {
  /** Unique id (can be used directly when aligned with memory_drive_configs.id) */
  readonly id: string;
  /** Stable type label (same as DriveConfig.kind) */
  readonly kind: string;
  readonly name: string;

  /**
   * Evaluates whether to fire; returns null to indicate no firing.
   * Must be synchronous and side-effect-free (side effects are persisted uniformly at the runtime layer).
   */
  evaluate(state: DriveRuntimeState): DriveProposal | null;

  /**
   * Optional hook: called by the runtime after this drive's outcome is created,
   * used to update the drive's own internal state (e.g. cooldown markers, pending queues).
   */
  onFired?(outcomeId: string): void;
}

export interface DriveProposal {
  /** Text to inject (pushed to messages as an Internal-origin user message) */
  injectMessage: string;
  /** Arbitration score [0, 1]; highest wins */
  utility: number;
  /** Snapshot JSON at the time of firing; persisted to drive_outcomes.trigger_snapshot_json */
  triggerSnapshot: unknown;
  /** The pursuit id being served (optional); used for effectiveness attribution */
  servedPursuitId?: string;
}

// ── Runtime ─────────────────────────────────────────────────────────────

export interface FiredDrive {
  driveId: string;
  outcomeId: string;
  servedPursuitId: string | null;
  injectedMessage: string;
  utility: number;
  /** Snapshot at the time of firing (same as drive_outcomes.trigger_snapshot_json; for caller debugging/logging) */
  triggerSnapshot: unknown;
}

/** Observations fed back to the runtime after a turn ends, to be merged into the outcome */
export interface TurnObservations {
  toolCalls: TsToolCallSummary[];
  newFactIds?: string[];
  newNoteIds?: string[];
  /** progress_markers newly added for the served pursuit this turn (by id) */
  pursuitProgressMarkerIds?: string[];
}

export interface TsDriveRuntimeOptions {
  rootPursuitId: string;
  auditHook?: MemoryAuditHook;
  /** Maximum number of drive messages to inject per turn (top-K) */
  maxInjectionsPerTurn?: number;
}

export class TsDriveRuntime {
  private readonly engines: TsDriveEngine[] = [];
  private readonly auditHook: MemoryAuditHook | undefined;
  private readonly rootPursuitId: string;
  private readonly maxInjections: number;

  constructor(
    private readonly outcomes: DriveOutcomeStore,
    options: TsDriveRuntimeOptions,
  ) {
    this.auditHook = options.auditHook;
    this.rootPursuitId = options.rootPursuitId;
    this.maxInjections = options.maxInjectionsPerTurn ?? 1;
  }

  register(engine: TsDriveEngine): this {
    this.engines.push(engine);
    return this;
  }

  listEngines(): ReadonlyArray<TsDriveEngine> {
    return this.engines;
  }

  /**
   * Evaluates all drives, selects the top-K utility proposals, persists them as drive_outcomes rows,
   * and returns the FiredDrive list for the caller (server) to inject messages.
   */
  beforeTurn(state: DriveRuntimeState): FiredDrive[] {
    const proposals: Array<{ engine: TsDriveEngine; p: DriveProposal }> = [];
    for (const engine of this.engines) {
      let p: DriveProposal | null;
      try {
        p = engine.evaluate(state);
      } catch (e) {
        this.auditHook?.append('self_domain_write', {
          source: 'drive_runtime',
          origin: 'Internal',
          toolName: 'drive_evaluate_error',
          driveId: engine.id,
          error: String(e),
        });
        continue;
      }
      if (p && Number.isFinite(p.utility) && p.utility > 0 && p.injectMessage) {
        proposals.push({ engine, p });
      }
    }
    proposals.sort((a, b) => b.p.utility - a.p.utility);
    const winners = proposals.slice(0, this.maxInjections);

    const fired: FiredDrive[] = [];
    const now = Date.now();
    for (const w of winners) {
      const outcome = this.outcomes.append({
        driveId: w.engine.id,
        firedAt: now,
        triggerSnapshot: w.p.triggerSnapshot,
        injectedAction: {
          type: 'inject_message',
          message: w.p.injectMessage,
        },
        servedPursuitId: w.p.servedPursuitId ?? null,
        rootPursuitId: this.rootPursuitId,
      });
      this.auditHook?.append('self_domain_write', {
        source: 'drive_runtime',
        origin: 'Internal',
        toolName: 'drive_fired',
        driveId: w.engine.id,
        outcomeId: outcome.id,
        utility: w.p.utility,
        servedPursuitId: w.p.servedPursuitId ?? null,
      });
      try {
        w.engine.onFired?.(outcome.id);
      } catch {
        // drive onFired side-effect failure is non-fatal
      }
      fired.push({
        driveId: w.engine.id,
        outcomeId: outcome.id,
        servedPursuitId: w.p.servedPursuitId ?? null,
        injectedMessage: w.p.injectMessage,
        utility: w.p.utility,
        triggerSnapshot: w.p.triggerSnapshot,
      });
    }
    return fired;
  }

  /**
   * Merges the tool / fact / note / progress delta observed this turn into all outcomes
   * that fired this turn. The reflector will later read these outcomes to back-fill effectiveness_score.
   */
  afterTurn(fired: FiredDrive[], obs: TurnObservations): void {
    if (fired.length === 0) return;

    const calls = obs.toolCalls.map((c) => ({
      tool: c.toolName,
      ok: c.success,
      snippet: c.resultSnippet,
    }));

    for (const f of fired) {
      this.outcomes.appendSubsequentToolCalls(f.outcomeId, calls);
      this.outcomes.mergeMemoryDelta(f.outcomeId, {
        factIds: obs.newFactIds,
        noteIds: obs.newNoteIds,
        pursuitProgressMarkers: obs.pursuitProgressMarkerIds,
      });
    }
  }
}
