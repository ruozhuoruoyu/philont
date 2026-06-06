/**
 * Interrupt channel · pure TS replacement (2026-05-29 soft-disable of Rust)
 *
 * Background: the only remaining production runtime dependency on the Rust `@agent/node`
 * package was this thin "interrupt broadcast pipe" layer — InterruptMapper fires signals
 * on it, InterruptDrainer subscribes, and chat-handler renders them into the system prefix.
 * The Rust `run_agent_loop` has never run in production (see project memory). Since the
 * current requirements do not need Rust (openclaw is pure TS proof, no untrusted code
 * execution requirement), this layer is replaced with a pure TS EventEmitter-style
 * implementation; production and build no longer touch agent-core / agent-node at all.
 *
 * Design contract: **bit-for-bit aligned with the interface and observable behaviour** of
 * `JsInterruptController` / `interruptChannelJs` from `@agent/node`, so the replacement
 * only changes the import path with zero behaviour change. Including:
 *   - send*: the `signalType → (kind, payload)` mapping exactly replicates Rust
 *     `js_to_interrupt` + `from_interrupt` (including unknown signalType →
 *     SteerMessage(signalType) lossy fallback, original payload discarded — this is the
 *     true FFI behaviour in production; autonomous signals do not depend on that payload;
 *     real content is rendered from DB).
 *   - subscribe registers 4-level callbacks; send* fan-out synchronously to all subscribers
 *     at the matching severity. (Rust side uses tokio broadcast + NonBlocking tsfn forwarding;
 *     synchronous fan-out is semantically equivalent and more deterministic for the
 *     "drainer buckets → next buildMemoryPrefix drain" pattern.)
 *
 * The Rust kernel (agent-core / agent-node) remains dormant in the repo for future use
 * when untrusted code sandboxing (ironclaw-style secure kernel) is needed; this module
 * removes the production runtime dependency on it.
 */

/** Input to send*, mirrors napi `JsAgentInterrupt`. */
export interface JsAgentInterrupt {
  signalType: string;
  payload?: string;
}

/** Snapshot received by subscriber callbacks; mirrors napi `JsAgentInterruptSnapshot` field for field. */
export interface JsAgentInterruptSnapshot {
  kind: string;
  payload: string;
  severity: 'critical' | 'high' | 'normal' | 'low';
  firedAtMs: number;
}

/** Subscription handle, mirrors napi `JsInterruptSubscription`. unsubscribe is idempotent. */
export interface JsInterruptSubscription {
  unsubscribe(): void;
}

/** Receiver-side placeholder: Rust side is consumed by run_agent_loop; since production no longer runs that loop, this is an opaque empty object. */
export interface JsInterruptReceiver {
  readonly __opaque?: never;
}

type SnapshotCb = (snapshot: JsAgentInterruptSnapshot) => void;

/** Known signal types (variants that carry a String payload + two no-payload variants). */
const PAYLOAD_VARIANTS = new Set([
  'SteerMessage', 'TaskReceived', 'ApprovalRequired', 'SurvivalThreat',
  'IdentityThreat', 'ValueConflict', 'CuriosityTriggered', 'QualityDissatisfaction',
]);
const EMPTY_PAYLOAD_VARIANTS = new Set(['UserHardStop', 'BoredomThreshold']);

/**
 * Replicates the (kind, payload) derivation of Rust `js_to_interrupt` (interrupt.rs) +
 * `from_interrupt` (kernel/interrupt.rs):
 *   - payload-carrying variant: kind=signalType, payload=payload (defaults to '')
 *   - UserHardStop / BoredomThreshold: kind=signalType, payload=''
 *   - Other (unknown): → SteerMessage(signalType) → kind='SteerMessage', payload=signalType
 *     (original payload discarded — consistent with Rust `other => SteerMessage(other.to_string())`)
 */
function deriveKindPayload(sig: JsAgentInterrupt): { kind: string; payload: string } {
  const t = sig.signalType;
  if (EMPTY_PAYLOAD_VARIANTS.has(t)) return { kind: t, payload: '' };
  if (PAYLOAD_VARIANTS.has(t)) return { kind: t, payload: sig.payload ?? '' };
  return { kind: 'SteerMessage', payload: t };
}

export class JsInterruptController {
  // One subscriber set per severity level; send* fan-out synchronously.
  private readonly subs = {
    critical: new Set<SnapshotCb>(),
    high: new Set<SnapshotCb>(),
    normal: new Set<SnapshotCb>(),
    low: new Set<SnapshotCb>(),
  };

  private fire(severity: JsAgentInterruptSnapshot['severity'], sig: JsAgentInterrupt): void {
    const { kind, payload } = deriveKindPayload(sig);
    const snapshot: JsAgentInterruptSnapshot = { kind, payload, severity, firedAtMs: Date.now() };
    // Copy to array before iterating to handle unsubscribe calls from within a callback.
    for (const cb of [...this.subs[severity]]) {
      try { cb(snapshot); } catch { /* single subscriber error does not affect others (same as Rust NonBlocking fault tolerance) */ }
    }
  }

  sendCritical(signal: JsAgentInterrupt): void { this.fire('critical', signal); }
  sendHigh(signal: JsAgentInterrupt): void { this.fire('high', signal); }
  sendNormal(signal: JsAgentInterrupt): void { this.fire('normal', signal); }
  sendLow(signal: JsAgentInterrupt): void { this.fire('low', signal); }

  /** Convenience: UserHardStop at CRITICAL (interface alignment; not used in production). */
  hardStop(): void { this.sendCritical({ signalType: 'UserHardStop' }); }
  /** Convenience: SteerMessage at HIGH (interface alignment; not used in production). */
  steer(message: string): void { this.sendHigh({ signalType: 'SteerMessage', payload: message }); }

  subscribe(
    onCritical: SnapshotCb,
    onHigh: SnapshotCb,
    onNormal: SnapshotCb,
    onLow: SnapshotCb,
  ): JsInterruptSubscription {
    this.subs.critical.add(onCritical);
    this.subs.high.add(onHigh);
    this.subs.normal.add(onNormal);
    this.subs.low.add(onLow);
    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return; // idempotent
        active = false;
        this.subs.critical.delete(onCritical);
        this.subs.high.delete(onHigh);
        this.subs.normal.delete(onNormal);
        this.subs.low.delete(onLow);
      },
    };
  }
}

/**
 * Create a (controller, receiver) pair, mirroring `interruptChannelJs()` from `@agent/node`.
 * receiver is now an opaque empty object — production no longer runs the Rust run_agent_loop,
 * so nothing consumes it.
 */
export function interruptChannelJs(): {
  controller: JsInterruptController;
  receiver: JsInterruptReceiver;
} {
  return { controller: new JsInterruptController(), receiver: {} };
}
