/**
 * Autonomous loop budget caps — environment variable parsing (2026-05-06).
 *
 * 5 env variables; any absent value falls back to DEFAULT_BUDGET_CAPS;
 * invalid values (non-numeric / < 0) are ignored:
 *   PHILONT_AUTONOMOUS_DAILY_TOKENS         (default 0 = unlimited)
 *   PHILONT_AUTONOMOUS_DAILY_TOOL_CALLS     (default 50)
 *   PHILONT_AUTONOMOUS_PER_TICK_TOKENS      (default 7_000)
 *   PHILONT_AUTONOMOUS_PER_TICK_INITIATIVES (default 4)
 *   PHILONT_AUTONOMOUS_PER_INITIATIVE_TOKENS(default 2_000)
 *
 * Global kill switch: PHILONT_AUTONOMOUS=0 (implemented in loop.ts, independent of caps).
 */

import { DEFAULT_BUDGET_CAPS, type BudgetCaps } from '@agent/memory';

/**
 * Parse env variables into BudgetCaps. envSource can be injected for unit testing.
 */
export function resolveAutonomousBudgetCaps(
  envSource: NodeJS.ProcessEnv = process.env,
): BudgetCaps {
  const parsePositive = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n);
  };
  return {
    dailyTokens: parsePositive(
      envSource.PHILONT_AUTONOMOUS_DAILY_TOKENS,
      DEFAULT_BUDGET_CAPS.dailyTokens,
    ),
    dailyToolCalls: parsePositive(
      envSource.PHILONT_AUTONOMOUS_DAILY_TOOL_CALLS,
      DEFAULT_BUDGET_CAPS.dailyToolCalls,
    ),
    perTickTokens: parsePositive(
      envSource.PHILONT_AUTONOMOUS_PER_TICK_TOKENS,
      DEFAULT_BUDGET_CAPS.perTickTokens,
    ),
    perTickInitiatives: parsePositive(
      envSource.PHILONT_AUTONOMOUS_PER_TICK_INITIATIVES,
      DEFAULT_BUDGET_CAPS.perTickInitiatives,
    ),
    perInitiativeTokens: parsePositive(
      envSource.PHILONT_AUTONOMOUS_PER_INITIATIVE_TOKENS,
      DEFAULT_BUDGET_CAPS.perInitiativeTokens,
    ),
  };
}

/**
 * Log once at startup to show which caps are overridden by env.
 * When all values are at defaults, print the full default list
 * (convenient for confirming the overall configuration).
 */
export function describeBudgetCapsOverrides(caps: BudgetCaps): string {
  const overrides = (
    [
      ['dailyTokens', caps.dailyTokens, DEFAULT_BUDGET_CAPS.dailyTokens],
      ['dailyToolCalls', caps.dailyToolCalls, DEFAULT_BUDGET_CAPS.dailyToolCalls],
      ['perTickTokens', caps.perTickTokens, DEFAULT_BUDGET_CAPS.perTickTokens],
      ['perTickInitiatives', caps.perTickInitiatives, DEFAULT_BUDGET_CAPS.perTickInitiatives],
      ['perInitiativeTokens', caps.perInitiativeTokens, DEFAULT_BUDGET_CAPS.perInitiativeTokens],
    ] as Array<[string, number, number]>
  )
    .filter(([, actual, def]) => actual !== def)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (overrides) return `budget caps overridden: ${overrides}`;
  return (
    `budget caps default: dailyTokens=${caps.dailyTokens}, ` +
    `dailyToolCalls=${caps.dailyToolCalls}, perTickTokens=${caps.perTickTokens}, ` +
    `perTickInitiatives=${caps.perTickInitiatives}, perInitiativeTokens=${caps.perInitiativeTokens}`
  );
}
