/**
 * AuditLog: SHA-256 hash-chain audit log
 *
 * Each event's hash = SHA-256(prevHash + type + timestamp + data).
 * Once chained, any tampering with an event can be detected by verify().
 *
 * Uses Node.js built-in crypto; no additional dependencies.
 */

import { createHash, randomUUID } from 'node:crypto';

export type AuditEventType =
  | 'step_start'
  | 'step_end'
  | 'interrupt'
  | 'permission_denied'
  | 'tool_call'
  | 'loop_start'
  | 'loop_end'
  | 'approval_requested'
  | 'approval_suspended'
  | 'tool_granted'
  // Validator chain events
  | 'validator_step'
  | 'leak_warn'
  // self-domain events (traces of internal-drive or introspective reads)
  | 'self_domain_access'
  | 'self_domain_write'
  // Registration-phase violations (plugin attempted to declare self domain and was rejected)
  | 'registry_violation'
  // task failure mode — recorded by chat-handler on iter cap / turn deadline / LLM
  // timeout / API error; retrieved by failure_recovery_inject on the next turn
  | 'task_failure_mode'
  | 'failure_recovery_injected'
  // schedule autonomous_turn (2026-05-07) — system-driven real chat turn completed / failed
  | 'schedule_autonomous_turn_done'
  | 'schedule_autonomous_turn_failed'
  // schedule auto circuit-breaker (2026-05-11) — soft-paused after consecutive failures >= threshold
  | 'schedule_auto_paused'
  // v17 complex task protocol (2026-05-11) — plan_drafted / reviewed / revised / closed
  | 'plan_drafted'
  | 'plan_reviewed'
  | 'plan_revised'
  | 'plan_closed_success'
  | 'plan_closed_failure'
  // v18 Phase 8 (2026-05-12) — config rule self-modification + bug report
  | 'config_rule_proposed'
  | 'config_rule_promoted'
  | 'config_rule_retired'
  | 'bug_report_generated';

export interface AuditEvent {
  readonly id:        string;
  readonly timestamp: number;
  readonly type:      AuditEventType;
  readonly data:      Record<string, unknown>;
  /** Hash of the previous event (all-zeros for the first event) */
  readonly prevHash:  string;
  /** Hash of this event */
  readonly hash:      string;
}

const GENESIS_HASH = '0'.repeat(64);

export class AuditLog {
  private readonly events: AuditEvent[] = [];
  private lastHash: string = GENESIS_HASH;

  /** Append an event, automatically computing and chaining its hash */
  append(type: AuditEventType, data: Record<string, unknown> = {}): AuditEvent {
    const id        = randomUUID();
    const timestamp = Date.now();
    const prevHash  = this.lastHash;

    // hash = SHA-256(prevHash | id | timestamp | type | JSON(data))
    const hash = createHash('sha256')
      .update(prevHash)
      .update(id)
      .update(String(timestamp))
      .update(type)
      .update(JSON.stringify(data))
      .digest('hex');

    const event: AuditEvent = { id, timestamp, type, data, prevHash, hash };
    this.events.push(event);
    this.lastHash = hash;
    return event;
  }

  /** Verify hash-chain integrity; returns true if untampered */
  verify(): boolean {
    let prevHash = GENESIS_HASH;
    for (const event of this.events) {
      const expected = createHash('sha256')
        .update(prevHash)
        .update(event.id)
        .update(String(event.timestamp))
        .update(event.type)
        .update(JSON.stringify(event.data))
        .digest('hex');

      if (expected !== event.hash)      return false;
      if (event.prevHash !== prevHash)  return false;
      prevHash = event.hash;
    }
    return true;
  }

  /** All events (read-only) */
  getEvents(): readonly AuditEvent[] {
    return this.events;
  }

  /** Number of events */
  get length(): number {
    return this.events.length;
  }

  /** Most recent event */
  get last(): AuditEvent | undefined {
    return this.events.at(-1);
  }
}
