/**
 * RateLimit Validator — per-tool call rate limiting
 *
 * Sliding-window implementation: records a timestamp on each call and rejects
 * when the threshold is exceeded. Supports both per-tool and global limits.
 */

import type { Validator, ValidatorContext } from './types.js';
import { pass, deny } from './types.js';

export interface RateLimitConfig {
  /** Sliding window size in milliseconds (default 60 000 = 1 minute) */
  windowMs?: number;
  /** Maximum calls per window (default 60) */
  maxCalls?: number;
  /** Count separately per tool (default true) */
  perTool?: boolean;
  /** Per-tool overrides that supersede the defaults */
  perToolOverrides?: Record<string, { windowMs?: number; maxCalls?: number }>;
  /** Tools exempt from rate limiting */
  exempt?: Set<string>;
}

interface Counter {
  windowMs: number;
  maxCalls: number;
  timestamps: number[];
}

function pruneAndCheck(counter: Counter): boolean {
  const now = Date.now();
  const cutoff = now - counter.windowMs;
  while (counter.timestamps.length > 0 && counter.timestamps[0]! < cutoff) {
    counter.timestamps.shift();
  }
  if (counter.timestamps.length >= counter.maxCalls) return false;
  counter.timestamps.push(now);
  return true;
}

export function createRateLimitValidator(config: RateLimitConfig = {}): Validator {
  const defaultWindow = config.windowMs ?? 60_000;
  const defaultMax = config.maxCalls ?? 60;
  const perTool = config.perTool ?? true;
  const overrides = config.perToolOverrides ?? {};
  const exempt = config.exempt ?? new Set<string>();

  const counters = new Map<string, Counter>();

  const getCounter = (key: string): Counter => {
    if (!counters.has(key)) {
      const o = perTool ? overrides[key] : undefined;
      counters.set(key, {
        windowMs: o?.windowMs ?? defaultWindow,
        maxCalls: o?.maxCalls ?? defaultMax,
        timestamps: [],
      });
    }
    return counters.get(key)!;
  };

  return (ctx: ValidatorContext) => {
    if (exempt.has(ctx.toolName)) return pass();
    const key = perTool ? ctx.toolName : '__global__';
    const counter = getCounter(key);
    if (!pruneAndCheck(counter)) {
      return deny(
        'RATE_LIMIT_EXCEEDED',
        `Rate limit exceeded for ${perTool ? ctx.toolName : 'global'}: ${counter.maxCalls}/${counter.windowMs}ms`,
      );
    }
    return pass();
  };
}
