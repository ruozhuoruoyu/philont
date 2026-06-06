/**
 * Memory layer audit hooks
 *
 * Post-processors (SessionExtractor / SessionReflector / Compactor) call MemoryStore
 * APIs directly, bypassing PolicyGate. But these "internal writes" still need a trail —
 * otherwise bypass = no trace, violating the audit baseline.
 *
 * Convention:
 *   - Caller can pass any object implementing `append(type, data)`
 *   - agent-policy's AuditLog can be used directly via structural compatibility (same append signature)
 *   - Each write passes origin='Internal' and source module name for post-hoc traceability
 */

export interface MemoryAuditHook {
  append(type: string, data: Record<string, unknown>): void;
}

/** Lightweight in-memory implementation for tests and demos */
export class InMemoryAuditHook implements MemoryAuditHook {
  readonly events: Array<{ type: string; data: Record<string, unknown>; timestamp: number }> = [];

  append(type: string, data: Record<string, unknown>): void {
    this.events.push({ type, data, timestamp: Date.now() });
  }
}
