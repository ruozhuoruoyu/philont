/**
 * AutonomousLoop — K8 initiative layer tick scheduler.
 *
 * Runs in parallel with IdleConsolidator, each handling its own concern:
 * IdleConsolidator does memory consolidation (extractor/reflector);
 * AutonomousLoop does proactive research. Both use setInterval + unref'd timers,
 * and each stops independently on SIGINT.
 *
 * Per-tick steps:
 *   1. Check enabled switch (config + environment variable)
 *   2. Check global kill switch (autonomous_budget daily budget not exhausted)
 *   3. Take MemorySnapshot (one SQLite read for facts/routing/skills/pursuits/recent tokens)
 *   4. Call all driver.propose() to collect candidates
 *   5. Sort by utility, dispatch sequentially (not in parallel, to avoid budget race + DB write conflicts)
 *   6. For each initiative: insert pending → markRunning → executor.run() →
 *      markDone/Failed/Skipped → budget commit → fire interrupt
 *   7. Once budget is exhausted within a tick, all remaining candidates are skipped
 *
 * Testing: exposes tickOnce() for synchronous await; fake clock can be injected.
 */

import type Database from 'better-sqlite3';
import type { MemoryStore } from '../store.js';
import type { NotesStore } from '../notes.js';
import type { RawStore } from '../raw.js';
import type { PursuitStore } from '../pursuit.js';
import type { SkillStore } from '../skills.js';
import type { RoutingRuleStore } from '../routing_rules.js';
import { BOOTSTRAP_ROOT_PURSUIT_ID } from '../schema.js';
import {
  BudgetTracker,
  DEFAULT_BUDGET_CAPS,
  type BudgetCaps,
} from './budget.js';
import { extractSpecificTokens } from './drivers/curiosity_driver.js';
import { InitiativeStore } from './initiatives.js';
import type {
  Driver,
  Initiative,
  InitiativeExecutor,
  InitiativeProposal,
  InitiativeRunResult,
  MemorySnapshot,
  OutcomeHook,
} from './types.js';

export type AutonomousInterruptKind =
  | 'discovery_made'
  | 'initiative_blocked';

export interface AutonomousInterruptPayload {
  kind: AutonomousInterruptKind;
  initiativeId: string;
  summary: string;
}

/**
 * Minimal interface for the loop to fire interrupts. Injected from the server side;
 * pumps payload into Rust-side InterruptController.send_*() so the drainer can render it in the next turn.
 *
 * Does not reference napi types, to avoid agent-memory reverse-depending on server / agent-node.
 */
export interface InterruptSink {
  fire(severity: 'normal' | 'high', payload: AutonomousInterruptPayload): void;
}

/**
 * Audit hook for the loop (optional). Called once per tick.
 */
export interface AutonomousAuditHook {
  onTick(event: TickEvent): void;
}

export interface TickEvent {
  startedAt: number;
  durationMs: number;
  proposalsCollected: number;
  initiativesRun: number;
  llmTokensSpent: number;
  toolCallsSpent: number;
  skipped: number;
  failed: number;
  budgetExhausted: boolean;
}

export interface AutonomousLoopOptions {
  db: Database.Database;
  facts: MemoryStore;
  notes: NotesStore;
  raw: RawStore;
  skills: SkillStore;
  routingRules: RoutingRuleStore;
  pursuits: PursuitStore;
  drivers: readonly Driver[];
  executor: InitiativeExecutor;
  /** Default 5 minutes. PHILONT_AUTONOMOUS_TICK_MS env var overrides. */
  tickIntervalMs?: number;
  /** Default 'default' — fixed value for single-tenant; multi-tenant passes this via caller. */
  userId?: string;
  /** Default BOOTSTRAP_ROOT_PURSUIT_ID */
  rootPursuitId?: string;
  /** Default DEFAULT_BUDGET_CAPS */
  budgetCaps?: BudgetCaps;
  /** Explicitly disable (can be turned off in tests). Also responds to env var PHILONT_AUTONOMOUS=0. */
  enabled?: boolean;
  /** How many recent raw messages to extract specific tokens from. Default 200. */
  recentMessagesForTokens?: number;
  interrupt?: InterruptSink;
  audit?: AutonomousAuditHook;
  /**
   * Side-effect hook after each initiative is persisted (added 2026-05-06, serves PursuitProgressWriter etc.).
   * Called once per initiative after markDone/Failed/Skipped. Hook errors are caught by loop and only logged;
   * they do not affect the main flow.
   */
  onOutcome?: OutcomeHook;
  logger?: { log: (m: string) => void; error: (m: string, e?: unknown) => void };
}

const DEFAULT_TICK_MS = 5 * 60_000;

export interface AutonomousLoopHandle {
  /** Start the background timer. Idempotent; can be called multiple times. */
  start(): void;
  /** Stop the timer + drain in-flight ticks. Idempotent; must be awaited. */
  stop(): Promise<void>;
  /**
   * Runtime pause / resume (can be toggled repeatedly) — timer keeps running, but each tick is a no-op.
   * For use as a global emergency stop.
   * Difference from stop(): stop() is a one-way shutdown (stopped is irreversible); pause() can be toggled.
   */
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /** Explicitly run one tick (for testing / pre-shutdown consolidation). Returns TickEvent. */
  tickOnce(now?: number): Promise<TickEvent>;
  /** Expose budget tracker (for testing / monitoring) */
  readonly budget: BudgetTracker;
  /** Expose initiative store (for testing / rendering) */
  readonly initiatives: InitiativeStore;
}

export function startAutonomousLoop(
  opts: AutonomousLoopOptions,
): AutonomousLoopHandle {
  const tickIntervalMs =
    opts.tickIntervalMs ??
    parseIntSafe(process.env.PHILONT_AUTONOMOUS_TICK_MS) ??
    DEFAULT_TICK_MS;
  const userId = opts.userId ?? 'default';
  const rootId = opts.rootPursuitId ?? BOOTSTRAP_ROOT_PURSUIT_ID;
  const recentMessages = opts.recentMessagesForTokens ?? 200;
  const log = opts.logger ?? {
    log: (m) => console.log(m),
    error: (m, e) => console.error(m, e),
  };
  const enabled =
    (opts.enabled ?? true) && process.env.PHILONT_AUTONOMOUS !== '0';

  const initiatives = new InitiativeStore(opts.db);
  const budget = new BudgetTracker(opts.db, opts.budgetCaps ?? DEFAULT_BUDGET_CAPS);

  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let paused = false; // Runtime emergency-stop switch (can be toggled); tickOnce no-ops when true

  function snapshot(now: number): MemorySnapshot {
    // facts: active facts across all namespaces. Number of namespaces is small (~10); list each and merge.
    const namespaces = opts.facts.listNamespaces();
    const facts = namespaces.flatMap((ns) => opts.facts.listFacts(ns));

    const routingRules = opts.routingRules.listAll();
    const skills = opts.skills.listAll(500);
    const activePursuits = opts.pursuits.listActive(rootId);

    // Recent timeline tokens
    const recent = opts.raw.queryTimeline({ order: 'desc', limit: recentMessages });
    const tokenSet = new Set<string>();
    for (const m of recent) {
      for (const t of extractSpecificTokens(m.content)) {
        tokenSet.add(t);
      }
    }

    const recentDoneTargetRefs = initiatives.listRecentSettledTargetRefs(
      24 * 60 * 60 * 1000,
      now,
    );

    return {
      facts,
      routingRules,
      skills,
      activePursuits,
      recentTimelineTokens: Array.from(tokenSet),
      recentDoneTargetRefs,
      now,
    };
  }

  async function runOne(initiative: Initiative): Promise<{
    finalStatus: 'done' | 'failed' | 'skipped';
    spent: { llmTokens: number; toolCalls: number };
  }> {
    const result = await opts.executor.run(initiative);
    const spent = {
      llmTokens: Math.max(0, result.llmTokensSpent | 0),
      toolCalls: Math.max(0, result.toolCallsSpent | 0),
    };

    if (result.status === 'done') {
      const updated = initiatives.markDone(
        initiative.id,
        result.outcomeSummary ?? '(executor returned no summary)',
        result.outcomeRefs ?? { facts: [], notes: [], pursuits: [] },
        spent.llmTokens,
      );
      // Commit budget even if markDone fails (double safety)
      budget.commit(userId, spent);
      if (updated && opts.interrupt) {
        opts.interrupt.fire(
          result.outcomeRefs && result.outcomeRefs.facts.length + result.outcomeRefs.notes.length > 0
            ? 'normal'
            : 'normal',
          {
            kind: 'discovery_made',
            initiativeId: initiative.id,
            summary: updated.outcomeSummary ?? '',
          },
        );
      }
      // onOutcome hook (PursuitProgressWriter etc.) — pass the latest persisted initiative
      // status as parameter; errors are only logged.
      await invokeOnOutcome(updated ?? initiative, result);
      return { finalStatus: 'done', spent };
    }

    if (result.status === 'failed') {
      const updated = initiatives.markFailed(initiative.id, result.error ?? 'unknown', spent.llmTokens);
      // Failed also spent tokens; must commit to prevent infinite retries
      if (spent.llmTokens > 0 || spent.toolCalls > 0) {
        budget.commit(userId, spent);
      }
      // 2026-05-07: per-initiative failure log for easier grep debugging.
      // Previously tick summary only showed failed=N; now exposes kind/driver/error for each failure.
      const reasonShort = String(result.error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 240);
      log.error(
        `[autonomous-fail] id=${initiative.id} kind=${initiative.kind} driver=${initiative.driver} ` +
          `target=${initiative.targetRef} llmTokens=${spent.llmTokens} toolCalls=${spent.toolCalls} ` +
          `reason="${reasonShort}"`,
      );
      await invokeOnOutcome(updated ?? initiative, result);
      return { finalStatus: 'failed', spent };
    }

    // Skipped
    const updated = initiatives.markSkipped(
      initiative.id,
      result.error ?? 'skipped by executor',
    );
    // Skipped usually means budget gate or dedup; low informational value but occasionally useful
    const skipReason = String(result.error ?? 'skipped by executor').slice(0, 200);
    log.log(
      `[autonomous-skip] id=${initiative.id} kind=${initiative.kind} driver=${initiative.driver} ` +
        `reason="${skipReason}"`,
    );
    await invokeOnOutcome(updated ?? initiative, result);
    return { finalStatus: 'skipped', spent: { llmTokens: 0, toolCalls: 0 } };
  }

  async function invokeOnOutcome(
    initiative: Initiative,
    result: InitiativeRunResult,
  ): Promise<void> {
    if (!opts.onOutcome) return;
    try {
      await opts.onOutcome(initiative, result);
    } catch (e) {
      log.error(`[autonomous] onOutcome threw error for initiative=${initiative.id}`, e);
    }
  }

  async function tickOnce(nowOverride?: number): Promise<TickEvent> {
    const now = nowOverride ?? Date.now();
    const startedAt = now;
    const event: TickEvent = {
      startedAt,
      durationMs: 0,
      proposalsCollected: 0,
      initiativesRun: 0,
      llmTokensSpent: 0,
      toolCallsSpent: 0,
      skipped: 0,
      failed: 0,
      budgetExhausted: false,
    };

    if (!enabled) {
      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    }
    if (paused) {
      // Emergency stop active: timer keeps running but each tick exits immediately,
      // no proposals are collected and no initiatives are run.
      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    }
    if (inFlight) {
      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    }
    inFlight = true;

    try {
      budget.resetTick(userId);
      const initialCheck = budget.checkCanRun(userId, now);
      if (!initialCheck.allowed) {
        log.log(`[autonomous] tick skipped: ${initialCheck.reason}`);
        event.budgetExhausted = true;
        event.durationMs = (nowOverride ?? Date.now()) - startedAt;
        opts.audit?.onTick(event);
        return event;
      }

      const snap = snapshot(now);

      const allProposals: InitiativeProposal[] = [];
      for (const driver of opts.drivers) {
        try {
          const ps = driver.propose(snap);
          allProposals.push(...ps);
        } catch (e) {
          log.error(`[autonomous] driver ${driver.name} propose threw error`, e);
        }
      }
      event.proposalsCollected = allProposals.length;
      if (allProposals.length === 0) {
        event.durationMs = (nowOverride ?? Date.now()) - startedAt;
        opts.audit?.onTick(event);
        return event;
      }

      // Active-research (pursuit:advance-question, utility 0.9) is dispatched first when tied,
      // ensuring user-assigned ongoing research isn't crowded out of the tick by trivial gap items.
      // All others are sorted by utility descending.
      const isActiveResearch = (p: InitiativeProposal): boolean =>
        p.driver === 'pursuit' && p.kind === 'pursuit:advance-question' && p.utility >= 0.9;
      allProposals.sort((a, b) => {
        const ar = isActiveResearch(a);
        const br = isActiveResearch(b);
        if (ar !== br) return ar ? -1 : 1;
        return b.utility - a.utility;
      });

      for (const proposal of allProposals) {
        const check = budget.checkCanRun(userId, now);
        if (!check.allowed) {
          event.budgetExhausted = true;
          // Mark remaining candidates as skipped (explicitly persisted for audit visibility)
          const inserted = initiatives.insert(proposal);
          initiatives.markSkipped(inserted.id, `budget gate: ${check.reason ?? ''}`);
          event.skipped += 1;
          log.log(
            `[autonomous-skip] id=${inserted.id} kind=${proposal.kind} driver=${proposal.driver} ` +
              `reason="budget gate: ${check.reason ?? ''}"`,
          );
          continue;
        }

        const inserted = initiatives.insert(proposal);
        const running = initiatives.markRunning(inserted.id);
        if (!running) {
          event.skipped += 1;
          continue;
        }

        try {
          const r = await runOne(running);
          if (r.finalStatus === 'done') {
            event.initiativesRun += 1;
          } else if (r.finalStatus === 'failed') {
            event.failed += 1;
          } else {
            event.skipped += 1;
          }
          event.llmTokensSpent += r.spent.llmTokens;
          event.toolCallsSpent += r.spent.toolCalls;
        } catch (e) {
          // Edge case: executor threw an uncaught exception (should not happen, but fallback)
          log.error(`[autonomous] runOne uncaught`, e);
          initiatives.markFailed(running.id, `uncaught: ${String(e)}`, 0);
          event.failed += 1;
        }
      }

      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (timer) return;
    if (!enabled) {
      log.log('[autonomous] loop disabled (enabled=false / PHILONT_AUTONOMOUS=0)');
      return;
    }
    timer = setInterval(() => {
      void tickOnce().catch((e) => log.error('[autonomous] tick uncaught', e));
    }, tickIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    log.log(`[autonomous] loop started, tick=${tickIntervalMs}ms`);
  }

  return {
    start,
    pause(): void { paused = true; log.log('[autonomous] paused (e-stop)'); },
    resume(): void { paused = false; log.log('[autonomous] resumed'); },
    isPaused(): boolean { return paused; },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const drainStart = Date.now();
      const TIMEOUT = 10_000;
      while (inFlight) {
        if (Date.now() - drainStart > TIMEOUT) {
          log.error('[autonomous] stop drain timeout, giving up waiting for in-flight tick');
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    tickOnce,
    budget,
    initiatives,
  };
}

function parseIntSafe(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
