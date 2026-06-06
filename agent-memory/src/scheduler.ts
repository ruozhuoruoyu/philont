/**
 * Scheduler: polls ScheduleStore, calls back onFire when due.
 *
 * Design principles:
 *   - Mechanism not policy: scheduler only emits events, does not execute tools or inject messages. Caller dispatches based on actionType.
 *   - Safety: for tool_call tasks, caller **must** re-run through PolicyGate (payload is a persisted snapshot, may be from 1 week ago).
 *   - Idempotent: markRun after each processed round, will not re-trigger the same task.
 *   - Fault-tolerant: a single onFire exception does not affect other tasks or the next round.
 *
 * Default polling interval 30s; inject intervalMs and now clock for mock testing.
 */

import type { ScheduleStore } from './schedules.js';
import type { Schedule } from './types.js';

export interface SchedulerOptions {
  /** Polling interval (ms). Default 30_000 (30s) */
  intervalMs?: number;
  /** Inject clock (for testing). Default Date.now */
  now?: () => number;
  /** Callback when onFire throws an error; default console.warn */
  onError?: (err: unknown, schedule: Schedule) => void;
}

export interface SchedulerHandle {
  /** Stop polling, release interval */
  stop(): void;
  /** Run one round immediately (without waiting for next tick). Returns number of triggered tasks. For testing. */
  tick(): Promise<number>;
}

export function startScheduler(
  store: ScheduleStore,
  onFire: (schedule: Schedule) => Promise<void> | void,
  options: SchedulerOptions = {}
): SchedulerHandle {
  const intervalMs = options.intervalMs ?? 30_000;
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((err, s) => {
    console.warn(`[scheduler] task '${s.name}' failed:`, err);
  });

  let stopped = false;

  async function tick(): Promise<number> {
    if (stopped) return 0;
    const due = store.dueBefore(now());
    for (const schedule of due) {
      try {
        await onFire(schedule);
      } catch (err) {
        onError(err, schedule);
      } finally {
        // markRun regardless of success/failure: prevent the same task from repeatedly failing and blocking the schedule
        store.markRun(schedule.id, now());
      }
    }
    return due.length;
  }

  const timer = setInterval(() => {
    // No await: prevent slow tasks from blocking the next tick, each tick is independent
    void tick();
  }, intervalMs);
  // setInterval in Node prevents process exit; add .unref() in tests later if needed
  if (typeof (timer as NodeJS.Timeout).unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}
