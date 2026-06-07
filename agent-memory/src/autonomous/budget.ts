/**
 * BudgetTracker — three-tier budget buckets for the autonomous loop.
 *
 * Three tiers:
 *   1. dailyTokens / dailyToolCalls — hard per-user daily cap, auto-resets across days
 *   2. perTickTokens / perTickInitiatives — single-tick cap, prevents draining the budget in one go
 *   3. perInitiativeTokens — per-initiative cap, prevents runaway LLM calls
 *
 * Persistence: autonomous_budget (user_id, date) bucket; executor calls commit after running
 * to accumulate actual spend. perTick is an in-memory counter, reset between ticks (loop resets each tick).
 *
 * UTC date boundary (YYYY-MM-DD): tests can use a fake clock; prod is unambiguous across timezones.
 */

import type Database from 'better-sqlite3';

export interface BudgetCaps {
  /** Per-user daily LLM token cap. 0 = unlimited. Default 20_000. */
  dailyTokens: number;
  /** Per-user daily tool call count cap. 0 = unlimited. Default 50. */
  dailyToolCalls: number;
  /** LLM token cap per tick. Default 5_000. */
  perTickTokens: number;
  /** Max initiatives per tick. Default 3. */
  perTickInitiatives: number;
  /** Per-initiative LLM token cap (executor self-limits). Default 2_000. */
  perInitiativeTokens: number;
}

export const DEFAULT_BUDGET_CAPS: BudgetCaps = {
  dailyTokens: 0,
  dailyToolCalls: 50,
  // 2026-05-06 K7→K8 bridge: bridge initiatives share the same pool as Gap/Curiosity.
  // Bridge utility is high (0.75-0.9) and would crowd out Gap (0.6-0.85) and Curiosity (0.5-0.85),
  // but K7's 24h dedup limits bridge frequency in practice, giving natural pipelining.
  // Raising perTickInitiatives 3→4 + perTickTokens 5K→7K leaves 1-2 slots for Gap/Curiosity.
  // v24: 4→5, reserves a permanent slot for active-research (dispatched with priority) without crowding Gap/Curiosity.
  // 2026-06-07: 5→8. Prod logs showed `per-tick initiative cap reached (5/5)` firing constantly — the
  // curiosity/gap engine generates far more candidate initiatives than 5/tick, so the initiative count was
  // the standing bottleneck. perTickTokens raised 7K→16K in lockstep (8 × perInitiativeTokens of 2_000):
  // raising the initiative cap alone would be useless because the token gate becomes the limiter
  // (at 2_000 tokens/initiative, 7_000 only funds ~3.5 initiatives). Bumping both proportionally lets the
  // 8-initiative cap actually take effect. perInitiativeTokens unchanged at 2_000.
  perTickTokens: 16_000,
  perTickInitiatives: 8,
  perInitiativeTokens: 2_000,
};

interface BudgetRow {
  user_id: string;
  date: string;
  llm_tokens_used: number;
  tool_calls_used: number;
  initiatives_run: number;
}

/** YYYY-MM-DD UTC — stable boundary, friendly for LIKE comparisons. */
export function utcDateString(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface DailyUsage {
  llmTokensUsed: number;
  toolCallsUsed: number;
  initiativesRun: number;
}

export interface PerTickUsage {
  llmTokensUsed: number;
  initiativesRun: number;
}

export interface BudgetReservation {
  /** Whether running is allowed (false = blocked, see reason) */
  allowed: boolean;
  /** Reason for blocking (empty when allowed=true) */
  reason?: string;
  /** Effective per-initiative LLM token cap (already reduced by daily remaining) */
  effectivePerInitiativeTokens: number;
}

export class BudgetTracker {
  private perTick = new Map<string, PerTickUsage>();

  constructor(
    private readonly db: Database.Database,
    public readonly caps: BudgetCaps = DEFAULT_BUDGET_CAPS,
  ) {}

  /**
   * Reset perTick counters — loop calls this once at the start of each tick.
   */
  resetTick(userId: string): void {
    this.perTick.set(userId, { llmTokensUsed: 0, initiativesRun: 0 });
  }

  getDailyUsage(userId: string, now = Date.now()): DailyUsage {
    const date = utcDateString(now);
    const row = this.db
      .prepare<[string, string]>(
        `SELECT * FROM autonomous_budget WHERE user_id = ? AND date = ?`,
      )
      .get(userId, date) as BudgetRow | undefined;
    if (!row) {
      return { llmTokensUsed: 0, toolCallsUsed: 0, initiativesRun: 0 };
    }
    return {
      llmTokensUsed: row.llm_tokens_used,
      toolCallsUsed: row.tool_calls_used,
      initiativesRun: row.initiatives_run,
    };
  }

  getTickUsage(userId: string): PerTickUsage {
    return (
      this.perTick.get(userId) ?? { llmTokensUsed: 0, initiativesRun: 0 }
    );
  }

  /**
   * Pre-dispatch check: can another initiative run?
   *
   * Does not pre-deduct — actual spend is committed by executor after completion.
   * This only checks whether one more initiative would fit.
   */
  checkCanRun(userId: string, now = Date.now()): BudgetReservation {
    const daily = this.getDailyUsage(userId, now);
    const tick = this.getTickUsage(userId);
    const c = this.caps;

    // 0 = unlimited semantics applies uniformly to all 5 caps (fixed 2026-05-06).
    // Previously dailyTokens / dailyToolCalls had a `> 0` guard meaning 0 = unlimited,
    // but perTick* had no guard, making 0 mean always-blocked. Now unified:
    // any cap being 0 means that dimension is unlimited (useful for debug / unlocked scenarios).
    if (c.dailyTokens > 0 && daily.llmTokensUsed >= c.dailyTokens) {
      return {
        allowed: false,
        reason: `daily token cap reached (${daily.llmTokensUsed}/${c.dailyTokens})`,
        effectivePerInitiativeTokens: 0,
      };
    }
    if (c.dailyToolCalls > 0 && daily.toolCallsUsed >= c.dailyToolCalls) {
      return {
        allowed: false,
        reason: `daily tool call cap reached (${daily.toolCallsUsed}/${c.dailyToolCalls})`,
        effectivePerInitiativeTokens: 0,
      };
    }
    if (c.perTickInitiatives > 0 && tick.initiativesRun >= c.perTickInitiatives) {
      return {
        allowed: false,
        reason: `per-tick initiative cap reached (${tick.initiativesRun}/${c.perTickInitiatives})`,
        effectivePerInitiativeTokens: 0,
      };
    }
    if (c.perTickTokens > 0 && tick.llmTokensUsed >= c.perTickTokens) {
      return {
        allowed: false,
        reason: `per-tick token cap reached (${tick.llmTokensUsed}/${c.perTickTokens})`,
        effectivePerInitiativeTokens: 0,
      };
    }

    const dailyRemaining =
      c.dailyTokens > 0 ? c.dailyTokens - daily.llmTokensUsed : Number.POSITIVE_INFINITY;
    const tickRemaining =
      c.perTickTokens > 0 ? c.perTickTokens - tick.llmTokensUsed : Number.POSITIVE_INFINITY;
    const perInitCap =
      c.perInitiativeTokens > 0 ? c.perInitiativeTokens : Number.POSITIVE_INFINITY;
    const effective = Math.min(perInitCap, dailyRemaining, tickRemaining);
    // Fully unlimited → give a safe floor (1M); executor's own maxLlmOutputTokens will
    // further cap it. This only prevents NaN/Infinity from flowing into SQLite/JSON.
    const finalCap = Number.isFinite(effective) ? Math.max(0, effective) : 1_000_000;
    return { allowed: true, effectivePerInitiativeTokens: finalCap };
  }

  /**
   * Called after executor completes — accumulates actual spend into the daily bucket + perTick bucket.
   */
  commit(
    userId: string,
    spent: { llmTokens: number; toolCalls: number },
    now = Date.now(),
  ): void {
    const date = utcDateString(now);

    // UPSERT style: first INSERT OR IGNORE a row with 0 usage, then UPDATE to accumulate.
    this.db
      .prepare<[string, string]>(
        `INSERT OR IGNORE INTO autonomous_budget
         (user_id, date, llm_tokens_used, tool_calls_used, initiatives_run)
         VALUES (?, ?, 0, 0, 0)`,
      )
      .run(userId, date);

    this.db
      .prepare<[number, number, string, string]>(
        `UPDATE autonomous_budget
         SET llm_tokens_used = llm_tokens_used + ?,
             tool_calls_used = tool_calls_used + ?,
             initiatives_run = initiatives_run + 1
         WHERE user_id = ? AND date = ?`,
      )
      .run(Math.max(0, spent.llmTokens), Math.max(0, spent.toolCalls), userId, date);

    const tick = this.getTickUsage(userId);
    this.perTick.set(userId, {
      llmTokensUsed: tick.llmTokensUsed + Math.max(0, spent.llmTokens),
      initiativesRun: tick.initiativesRun + 1,
    });
  }
}
