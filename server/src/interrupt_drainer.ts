/**
 * InterruptDrainer — K7.3 intermediate layer for integrating InterruptController into chat-handler.
 *
 * Working model:
 *   - On startup, calls controller.subscribe(4 callbacks), which push level-4 snapshots into
 *     4 in-memory buckets.
 *   - chat-handler calls drain() once at the end of buildMemoryPrefix to atomically clear the
 *     buckets and get the list of signals fired this round.
 *   - Signals are concatenated into the system prefix section by severity; **not** placed in
 *     the messages user-role slot.
 *
 * Why this layer is needed:
 *   - Decouples "signal fire time" from "prefix build time" — signals may fire during an idle
 *     tick, but prefix construction only happens when a user message arrives.
 *   - Converts the callback (TS push) model into a pull model (chat-handler actively consumes).
 *   - 4 independent buckets — drain returns by level; prefix rendering has full control over
 *     how to display each severity.
 *
 * shutdown() should be called before process exit to release the 4 ThreadsafeFunction references.
 */

// 2026-05-29 soft-disable of Rust: types now sourced from the pure TS replacement (see interrupt_channel.ts).
import type {
  JsInterruptController,
  JsAgentInterruptSnapshot,
  JsInterruptSubscription,
} from './interrupt_channel.js';

export interface DrainResult {
  critical: JsAgentInterruptSnapshot[];
  high:     JsAgentInterruptSnapshot[];
  normal:   JsAgentInterruptSnapshot[];
  low:      JsAgentInterruptSnapshot[];
}

function emptyDrain(): DrainResult {
  return { critical: [], high: [], normal: [], low: [] };
}

export class InterruptDrainer {
  private buckets: DrainResult = emptyDrain();
  private readonly subscription: JsInterruptSubscription;
  private shutdownCalled = false;

  constructor(controller: JsInterruptController) {
    this.subscription = controller.subscribe(
      (snap) => { this.buckets.critical.push(snap); },
      (snap) => { this.buckets.high.push(snap); },
      (snap) => { this.buckets.normal.push(snap); },
      (snap) => { this.buckets.low.push(snap); },
    );
  }

  /**
   * Atomically clear all buckets and return the accumulated snapshots.
   * Synchronous, no async. All snapshots accumulated between drain() calls are returned.
   */
  drain(): DrainResult {
    const out = this.buckets;
    this.buckets = emptyDrain();
    return out;
  }

  /**
   * peek does not clear — for audit / logging use. Snapshots taken by drain() are from a
   * mutable bucket; a subsequent peek then drain will not double-return them.
   */
  peek(): Readonly<DrainResult> {
    return {
      critical: [...this.buckets.critical],
      high:     [...this.buckets.high],
      normal:   [...this.buckets.normal],
      low:      [...this.buckets.low],
    };
  }

  /** Release underlying ThreadsafeFunction references. Idempotent. */
  shutdown(): void {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    this.subscription.unsubscribe();
  }
}
