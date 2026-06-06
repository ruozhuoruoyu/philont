/**
 * PushSubscriptionStore — CRUD for the push_subscriptions table (introduced in v14, K8 proactive push).
 *
 * A subscription is uniquely identified by (channel, peer):
 *   - channel: 'wechat:<accountId>' / 'telegram:<botId>' / 'email' etc.
 *   - peer: the recipient id within the channel (WeChat userId / group id / email address)
 *
 * Fields:
 *   enabled: on/off switch. Cancellation uses enabled=0 rather than deletion, to allow history lookup
 *   quiet_start_hour / quiet_end_hour / timezone: quiet hours (optional)
 *   digest_min_interval_ms / urgent_min_interval_ms: minimum interval for two-tier push
 *   last_digest_at / last_urgent_at: most recent push timestamps (used for rate-limiting)
 *
 * Default empty table = push to no one. Subscriptions must be explicitly created by the caller
 * (subscribePush tool or test code).
 */

import type Database from 'better-sqlite3';

export interface PushSubscription {
  channel: string;
  peer: string;
  enabled: boolean;
  quietStartHour: number | null;
  quietEndHour: number | null;
  timezone: string | null;
  digestMinIntervalMs: number;
  urgentMinIntervalMs: number;
  lastDigestAt: number | null;
  lastUrgentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SubscribeInput {
  channel: string;
  peer: string;
  /** Default 4h (14_400_000 ms) */
  digestMinIntervalMs?: number;
  /** Default 1h (3_600_000 ms) */
  urgentMinIntervalMs?: number;
  /** 0-23; must be provided together with quietEndHour or both omitted */
  quietStartHour?: number;
  quietEndHour?: number;
  /** IANA tz, e.g. 'Asia/Shanghai'. If omitted, quiet hours are calculated in UTC */
  timezone?: string;
}

interface SubscriptionRow {
  channel: string;
  peer: string;
  enabled: number;
  quiet_start_hour: number | null;
  quiet_end_hour: number | null;
  timezone: string | null;
  digest_min_interval_ms: number;
  urgent_min_interval_ms: number;
  last_digest_at: number | null;
  last_urgent_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToSubscription(row: SubscriptionRow): PushSubscription {
  return {
    channel: row.channel,
    peer: row.peer,
    enabled: row.enabled === 1,
    quietStartHour: row.quiet_start_hour,
    quietEndHour: row.quiet_end_hour,
    timezone: row.timezone,
    digestMinIntervalMs: row.digest_min_interval_ms,
    urgentMinIntervalMs: row.urgent_min_interval_ms,
    lastDigestAt: row.last_digest_at,
    lastUrgentAt: row.last_urgent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const DEFAULT_URGENT_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1h

export class PushSubscriptionStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Subscribe (idempotent): if already exists, updates enabled=1 + config fields without resetting timestamps.
   */
  subscribe(input: SubscribeInput): PushSubscription {
    if (!input.channel.trim() || !input.peer.trim()) {
      throw new Error('subscribe: channel / peer must not be empty');
    }
    if (
      (input.quietStartHour !== undefined) !==
      (input.quietEndHour !== undefined)
    ) {
      throw new Error('subscribe: quietStartHour / quietEndHour must both be provided or both omitted');
    }
    if (input.quietStartHour !== undefined) {
      if (input.quietStartHour < 0 || input.quietStartHour > 23) {
        throw new Error('subscribe: quietStartHour must be 0-23');
      }
      if (input.quietEndHour! < 0 || input.quietEndHour! > 23) {
        throw new Error('subscribe: quietEndHour must be 0-23');
      }
    }

    const now = Date.now();
    const digest = input.digestMinIntervalMs ?? DEFAULT_DIGEST_INTERVAL_MS;
    const urgent = input.urgentMinIntervalMs ?? DEFAULT_URGENT_INTERVAL_MS;

    this.db
      .prepare(
        `INSERT INTO push_subscriptions
         (channel, peer, enabled,
          quiet_start_hour, quiet_end_hour, timezone,
          digest_min_interval_ms, urgent_min_interval_ms,
          created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, peer) DO UPDATE SET
           enabled = 1,
           quiet_start_hour = excluded.quiet_start_hour,
           quiet_end_hour = excluded.quiet_end_hour,
           timezone = excluded.timezone,
           digest_min_interval_ms = excluded.digest_min_interval_ms,
           urgent_min_interval_ms = excluded.urgent_min_interval_ms,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.channel,
        input.peer,
        input.quietStartHour ?? null,
        input.quietEndHour ?? null,
        input.timezone ?? null,
        digest,
        urgent,
        now,
        now,
      );

    const got = this.get(input.channel, input.peer);
    if (!got) throw new Error('subscribe: get failed immediately after write');
    return got;
  }

  /**
   * Unsubscribe (soft-delete enabled=0). Returns true on success, false if not found.
   */
  unsubscribe(channel: string, peer: string): boolean {
    const r = this.db
      .prepare<[number, string, string]>(
        `UPDATE push_subscriptions SET enabled = 0, updated_at = ?
         WHERE channel = ? AND peer = ?`,
      )
      .run(Date.now(), channel, peer);
    return r.changes > 0;
  }

  get(channel: string, peer: string): PushSubscription | null {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT * FROM push_subscriptions WHERE channel = ? AND peer = ?`,
      )
      .get(channel, peer) as SubscriptionRow | undefined;
    return row ? rowToSubscription(row) : null;
  }

  /**
   * List all subscriptions with enabled=1. Used by dispatcher for a single fan-out pass.
   */
  listActive(): PushSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM push_subscriptions WHERE enabled = 1 ORDER BY channel, peer`,
      )
      .all() as SubscriptionRow[];
    return rows.map(rowToSubscription);
  }

  /**
   * List all enabled subscriptions under a channel.
   */
  listByChannel(channel: string): PushSubscription[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM push_subscriptions
         WHERE enabled = 1 AND channel = ? ORDER BY peer`,
      )
      .all(channel) as SubscriptionRow[];
    return rows.map(rowToSubscription);
  }

  /**
   * Mark a successful digest push. Called by dispatcher after a successful push.
   */
  markDigestSent(channel: string, peer: string, at: number = Date.now()): void {
    this.db
      .prepare<[number, number, string, string]>(
        `UPDATE push_subscriptions
         SET last_digest_at = ?, updated_at = ?
         WHERE channel = ? AND peer = ?`,
      )
      .run(at, at, channel, peer);
  }

  markUrgentSent(channel: string, peer: string, at: number = Date.now()): void {
    this.db
      .prepare<[number, number, string, string]>(
        `UPDATE push_subscriptions
         SET last_urgent_at = ?, updated_at = ?
         WHERE channel = ? AND peer = ?`,
      )
      .run(at, at, channel, peer);
  }

  /**
   * Explicitly update quiet hours. null clears (removes quiet hours).
   */
  setQuietHours(
    channel: string,
    peer: string,
    quietStartHour: number | null,
    quietEndHour: number | null,
    timezone: string | null,
  ): boolean {
    if (
      (quietStartHour === null) !== (quietEndHour === null)
    ) {
      throw new Error('setQuietHours: start / end must both be provided or both cleared');
    }
    const r = this.db
      .prepare<[number | null, number | null, string | null, number, string, string]>(
        `UPDATE push_subscriptions
         SET quiet_start_hour = ?, quiet_end_hour = ?, timezone = ?, updated_at = ?
         WHERE channel = ? AND peer = ?`,
      )
      .run(quietStartHour, quietEndHour, timezone, Date.now(), channel, peer);
    return r.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM push_subscriptions`)
      .get() as { n: number };
    return row.n;
  }

  countActive(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM push_subscriptions WHERE enabled = 1`)
      .get() as { n: number };
    return row.n;
  }
}
