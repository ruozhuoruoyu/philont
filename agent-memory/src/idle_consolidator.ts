/**
 * K0.6 IdleConsolidator
 *
 * Uses a lightweight background setInterval to replace the old "ws.close → finalizeSession" path.
 * Design:
 *  - Checks once every tickInterval (default 60s)
 *  - If the most recent message in the raw global timeline is > idleThreshold (default 5min) ago →
 *    agent enters "idle state", triggering consolidation over the current batch range (cursor → latest_ts):
 *    extractor + reflector + optional onConsolidate hook from caller (used to attach pursuitExtractor /
 *    selfReflector / driveReflector)
 *  - cursor is stored in memory_facts as system.last_consolidated_ts, advancing is idempotent
 *  - On first startup cursor is empty → set directly to latest_ts and skip historical backfill,
 *    to avoid draining all past conversations at once (cost + LLM window can't handle it)
 *
 * This path does not depend on the session concept at all. Idle detection comes from timeline
 * continuity, not "ws disconnect" — closer to the "sleep consolidation" brain model.
 */

import type { RawStore } from './raw.js';
import type { MemoryStore } from './store.js';
import type { SessionExtractor } from './extractor.js';
import type { SessionReflector } from './reflector.js';

export interface ConsolidationRange {
  fromTs: number;
  toTs: number;
  messageCount: number;
}

export interface IdleConsolidatorOptions {
  raw: RawStore;
  facts: MemoryStore;
  extractor: SessionExtractor;
  reflector: SessionReflector;
  /**
   * Optional hook: called after successful consolidation, used to attach pursuitExtractor / selfReflector /
   * driveReflector. range is the time window covered by this consolidation. Failure does not affect cursor advancement.
   */
  onConsolidate?: (range: ConsolidationRange) => Promise<void> | void;
  /** Idle threshold ms, default 5 minutes */
  idleThresholdMs?: number;
  /** Minimum new message count to trigger consolidation, default 4 (2 user/assistant pairs) */
  minNewMessages?: number;
  /** Maximum messages per batch (to prevent oversized batches), default 1000 */
  maxMessagesPerBatch?: number;
  /** Tick interval ms, default 60s */
  tickIntervalMs?: number;
  /** Logger hook, defaults to console */
  logger?: { log: (msg: string) => void; error: (msg: string, e?: unknown) => void };
}

export interface IdleConsolidatorHandle {
  /**
   * Stop timer + wait for any in-flight tick to drain. **Idempotent and must be awaited**.
   *
   * Not awaiting causes a "DB connection is not open" error in the SIGINT path
   * (memory.close() races ahead of the in-flight tick completing → reflector/mapper/writeCursor's
   * next prepare() hits an already-closed DB).
   */
  stop(): Promise<void>;
  /** Explicitly run once (for testing / pre-shutdown consolidation). Returns true=consolidated, false=conditions not met. */
  tick(): Promise<boolean>;
}

const DEFAULTS = {
  idleThresholdMs: 5 * 60_000,
  minNewMessages: 4,
  maxMessagesPerBatch: 1_000,
  tickIntervalMs: 60_000,
};

const CURSOR_NAMESPACE = 'system';
const CURSOR_KEY = 'last_consolidated_ts';

export function startIdleConsolidator(
  opts: IdleConsolidatorOptions,
): IdleConsolidatorHandle {
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULTS.idleThresholdMs;
  const minNewMessages = opts.minNewMessages ?? DEFAULTS.minNewMessages;
  const maxMessagesPerBatch =
    opts.maxMessagesPerBatch ?? DEFAULTS.maxMessagesPerBatch;
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULTS.tickIntervalMs;
  const log = opts.logger ?? {
    log: (m) => console.log(m),
    error: (m, e) => console.error(m, e),
  };

  let inFlight = false;

  function readCursor(): number | null {
    const f = opts.facts.getFact(CURSOR_NAMESPACE, CURSOR_KEY);
    if (!f) return null;
    const v = f.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function writeCursor(ts: number): void {
    opts.facts.storeFact({
      namespace: CURSOR_NAMESPACE,
      key: CURSOR_KEY,
      value: ts,
    });
  }

  async function tickOnce(): Promise<boolean> {
    if (inFlight) return false;
    inFlight = true;
    try {
      const latest = opts.raw.queryTimeline({ order: 'desc', limit: 1 });
      if (latest.length === 0) return false;
      const latestTs = latest[0].timestamp;

      const idleMs = Date.now() - latestTs;
      if (idleMs < idleThresholdMs) return false;

      const cursor = readCursor();
      if (cursor === null) {
        // First run → skip historical backlog, anchor directly to latestTs
        writeCursor(latestTs);
        log.log(
          `[idle-consolidator] cursor initialized = ${latestTs} (skipping backlog)`,
        );
        return false;
      }

      if (latestTs <= cursor) return false; // no new messages

      // Select messages after cursor; limit caps batch size
      const fromTs = cursor + 1;
      const toTs = latestTs;
      const newMsgs = opts.raw.queryTimeline({
        fromTs,
        untilTs: toTs,
        order: 'asc',
        limit: maxMessagesPerBatch,
      });
      if (newMsgs.length < minNewMessages) return false;

      // Actual window may be shorter than [fromTs, toTs] (if limit truncated). Subsequent ticks continue from cursor.
      const actualToTs = newMsgs[newMsgs.length - 1].timestamp;

      log.log(
        `[idle-consolidator] consolidating [${fromTs} → ${actualToTs}] ${newMsgs.length} msgs (idle ${Math.round(idleMs / 1000)}s)`,
      );

      try {
        const ext = await opts.extractor.extractFromTimeRange(fromTs, actualToTs);
        log.log(
          `[idle-consolidator] extractor: ${ext.factsStored} facts + ${ext.notesStored} notes`,
        );
      } catch (e) {
        log.error('[idle-consolidator] extractor failed', e);
      }

      try {
        const ref = await opts.reflector.reflectFromTimeRange(fromTs, actualToTs);
        log.log(
          `[idle-consolidator] reflector: ${ref.skillsCreated} new skills, ${ref.skillsUpdated} updated`,
        );
      } catch (e) {
        log.error('[idle-consolidator] reflector failed', e);
      }

      if (opts.onConsolidate) {
        try {
          await opts.onConsolidate({
            fromTs,
            toTs: actualToTs,
            messageCount: newMsgs.length,
          });
        } catch (e) {
          log.error('[idle-consolidator] onConsolidate failed', e);
        }
      }

      // Advance cursor — even if extractor/reflector above failed, advance anyway,
      // otherwise a bad batch would cause all subsequent rounds to hit the same issue repeatedly.
      writeCursor(actualToTs);
      return true;
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void tickOnce().catch((e) => log.error('[idle-consolidator] tick error', e));
  }, tickIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Wait for in-flight tick to drain (prevent race: memory.close() racing during tick's await)
      const drainStartedAt = Date.now();
      const DRAIN_TIMEOUT_MS = 5_000;
      while (inFlight) {
        if (Date.now() - drainStartedAt > DRAIN_TIMEOUT_MS) {
          log.error(
            `[idle-consolidator] stop drain timeout after ${DRAIN_TIMEOUT_MS}ms, giving up waiting for in-flight tick`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    tick: tickOnce,
  };
}
