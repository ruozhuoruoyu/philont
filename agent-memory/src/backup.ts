/**
 * BackupRunner: periodically calls db.backup to produce hot backup files, rolling-retaining the most recent N copies.
 *
 * Design notes:
 * - Backup filename: `memory-YYYYMMDDTHHmmss.sqlite` (ISO8601 with colons and milliseconds removed; lexicographically sortable)
 * - better-sqlite3's db.backup() is a Promise-based online backup API;
 *   it produces a consistent snapshot even while concurrent writes are happening
 * - chmod 0o600: backup files are as sensitive as the main database; other users should not be able to read them
 * - Failures only warn, do not throw: backup is an auxiliary path and should not take down the main service
 * - setInterval.unref(): the backup timer does not prevent process exit
 */

import type Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface BackupConfig {
  /** Backup interval (ms); default 6 hours */
  intervalMs?: number;
  /** Backup directory; default <dbDir>/backups */
  dir?: string;
  /** Number of rolling copies to retain; default 28 (combined with default 6h cadence ≈ covers 1 week) */
  retain?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETAIN = 28;
const BACKUP_FILE_PREFIX = 'memory-';
const BACKUP_FILE_SUFFIX = '.sqlite';

/** ISO8601 with colons/dashes/milliseconds removed: 2026-04-23T02:30:15.123Z → 20260423T023015 */
function timestampTag(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

export class BackupRunner {
  private readonly intervalMs: number;
  private readonly dir: string;
  private readonly retain: number;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly dbPath: string,
    config: BackupConfig = {}
  ) {
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.dir = config.dir ?? join(dirname(dbPath), 'backups');
    this.retain = Math.max(1, config.retain ?? DEFAULT_RETAIN);
  }

  start(): void {
    if (this.timer || this.closed) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => {
      this.backupNow().catch((e) => {
        console.warn(`[memory-backup] backup failed:`, e);
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.closed = true;
  }

  /**
   * Triggers a single backup and returns the output path. Tests call this directly to avoid waiting for the timer.
   */
  async backupNow(at: Date = new Date()): Promise<string> {
    if (this.closed) {
      throw new Error('BackupRunner is closed');
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, `${BACKUP_FILE_PREFIX}${timestampTag(at)}${BACKUP_FILE_SUFFIX}`);
    // better-sqlite3 v11 db.backup returns Promise<{totalPages, remainingPages}>
    await (this.db as unknown as { backup(path: string): Promise<unknown> }).backup(target);
    try {
      chmodSync(target, 0o600);
    } catch {
      // chmod may fail on Windows / non-POSIX; ignore
    }
    this.rotate();
    return target;
  }

  /**
   * Sort by filename in descending order (filenames contain ISO8601 timestamps; lexicographic order equals chronological order),
   * retain the most recent `retain` copies, and delete the rest.
   * Sorts by filename rather than mtime: at high trigger frequencies mtime may be within the same microsecond
   * and is not reliable.
   */
  private rotate(): void {
    if (!existsSync(this.dir)) return;
    const entries = readdirSync(this.dir)
      .filter((n) => n.startsWith(BACKUP_FILE_PREFIX) && n.endsWith(BACKUP_FILE_SUFFIX))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // Descending lexicographic order = newest first

    for (const old of entries.slice(this.retain)) {
      const full = join(this.dir, old);
      try {
        unlinkSync(full);
      } catch (e) {
        console.warn(`[memory-backup] failed to delete old backup ${full}:`, e);
      }
    }
  }
}
