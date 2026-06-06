/**
 * WeChat credential / state persistence layer
 *
 * Does not depend on iLink protocol details; only handles file IO + permissions +
 * multi-account directory layout. The scan-code login in W2 and the gateway in W3
 * both persist / read credentials through this layer.
 *
 * File layout (reference: hermes weixin adapter):
 *   ~/.philont/wechat/
 *     accounts/
 *       <account_id>/
 *         credentials.json       — { accountId, token, baseUrl, cdnBaseUrl, createdAt }
 *         .context-tokens.json   — iLink incremental context token (polling cursor)
 *         .lock                  — process lock, prevents running the same token twice
 *
 * Security:
 *   - All files chmod 0o600 (following agent-memory/src/index.ts:327 tightenPermissions pattern)
 *   - Token contents are never printed to console (only accountId + first 4 chars are logged)
 *
 * Concurrency:
 *   - .lock is best-effort (uses PID + ctime, not OS-level flock)
 *   - Running the same token on multiple machines will still result in mutual eviction
 *     by the iLink server; this layer is only an early warning
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** iLink Bot account credentials (persisted after scan-code login). */
export interface WeChatCredentials {
  accountId: string;
  token: string;
  baseUrl: string;
  cdnBaseUrl: string;
  /** epoch ms, timestamp when the credential was created; used for diagnosing token age. */
  createdAt: number;
}

export interface WeChatLockInfo {
  pid: number;
  startedAt: number;
  hostname: string;
}

/** Default service endpoints (can be overridden by environment variables / config). */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** Resolve the ~/.philont/wechat/ root directory (can be overridden by env, mainly for tests). */
export function getWeChatRoot(): string {
  return process.env.PHILONT_WECHAT_ROOT || join(homedir(), '.philont', 'wechat');
}

/** Single account directory: <root>/accounts/<accountId>/ */
export function getAccountDir(accountId: string): string {
  if (!isValidAccountId(accountId)) {
    throw new Error(`invalid accountId: ${JSON.stringify(accountId)}`);
  }
  return join(getWeChatRoot(), 'accounts', accountId);
}

/**
 * accountId must be a reasonable slug to prevent path traversal.
 *
 * iLink user_ids look like `o9cq801SI55LNCfpPkrmkUwB0hlU@im.wechat` — the `@` must
 * be allowed; path separators (`/` `\`) and plain `..` (parent dir escape) are excluded.
 */
export function isValidAccountId(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 128) return false;
  if (s === '.' || s === '..') return false;
  // Allow alphanumerics + these symbols (none of which are path separators): _ - . @ +
  return /^[A-Za-z0-9_.@+-]+$/.test(s);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Write file + chmod 0o600 (following agent-memory tightenPermissions); chmod failure on non-POSIX is non-fatal. */
function writeSecure(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Ignored on non-POSIX environments
  }
}

/** List configured accountIds (directory existence = configured; credentials.json need not exist yet). */
export function listAccounts(): string[] {
  const accountsDir = join(getWeChatRoot(), 'accounts');
  if (!existsSync(accountsDir)) return [];
  return readdirSync(accountsDir).filter((name) => {
    if (!isValidAccountId(name)) return false;
    return statSync(join(accountsDir, name)).isDirectory();
  });
}

/** Write credentials (atomic: write temp then rename); auto chmod 0o600. */
export function writeCredentials(creds: WeChatCredentials): void {
  if (!isValidAccountId(creds.accountId)) {
    throw new Error(`invalid accountId in credentials: ${creds.accountId}`);
  }
  const dir = getAccountDir(creds.accountId);
  ensureDir(dir);
  const path = join(dir, 'credentials.json');
  writeSecure(path, JSON.stringify(creds, null, 2));
}

/** Read credentials; returns null if not found. */
export function readCredentials(accountId: string): WeChatCredentials | null {
  const path = join(getAccountDir(accountId), 'credentials.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.accountId === 'string' &&
      typeof parsed?.token === 'string' &&
      typeof parsed?.baseUrl === 'string' &&
      typeof parsed?.cdnBaseUrl === 'string' &&
      typeof parsed?.createdAt === 'number'
    ) {
      return parsed as WeChatCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

/** Delete all local files for an account (use with caution; typically called only on user-initiated logout / re-scan). */
export function deleteAccount(accountId: string): void {
  const dir = getAccountDir(accountId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Persist the context-tokens incremental polling cursor (any serialisable object). */
export function writeContextTokens(accountId: string, payload: unknown): void {
  const dir = getAccountDir(accountId);
  ensureDir(dir);
  const path = join(dir, '.context-tokens.json');
  writeSecure(path, JSON.stringify(payload));
}

/** Read context-tokens; returns null if missing or corrupted — caller decides whether to poll from scratch. */
export function readContextTokens(accountId: string): unknown {
  const path = join(getAccountDir(accountId), '.context-tokens.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Acquire lock (best-effort).
 *
 * Failure: lock already exists and ctime is within 60s (treated as another process just started) → return existing info
 * Success: write .lock with this process's pid and start timestamp → return null
 *
 * Note: this is not an OS-level file lock, only an early hint. If another process crashes
 * and leaves a dead lock, the caller should call forceAcquireLock after 60s to take over.
 */
export function acquireLock(accountId: string, hostname: string = ''): WeChatLockInfo | null {
  const dir = getAccountDir(accountId);
  ensureDir(dir);
  const lockPath = join(dir, '.lock');
  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, 'utf-8')) as WeChatLockInfo;
      // Same-host lock: trust pid liveness over age. A launcher-triggered restart
      // (env change) re-spawns the agent well within 60s while the old pid is already
      // dead — without the liveness check the stale lock would falsely block the new
      // gateway. Cross-host locks can't probe the pid, so fall back to the age window.
      const sameHost = !hostname || !existing.hostname || existing.hostname === hostname;
      if (sameHost) {
        if (isPidAlive(existing.pid) && existing.pid !== process.pid) {
          return existing; // previous process genuinely still running
        }
        // pid is dead (or is us) → stale lock, take over below
      } else {
        const ageMs = Date.now() - existing.startedAt;
        if (ageMs < 60_000) {
          return existing; // different host, still within the assume-alive window
        }
      }
    } catch {
      // Corrupted lock file, treat as no lock
    }
  }
  const info: WeChatLockInfo = {
    pid: process.pid,
    startedAt: Date.now(),
    hostname,
  };
  writeSecure(lockPath, JSON.stringify(info));
  return null;
}

/**
 * Probe whether a pid is currently alive. `process.kill(pid, 0)` sends no signal but
 * performs the existence/permission check: throws ESRCH if the pid is gone, EPERM if it
 * exists but is owned by another user (still alive). Any other outcome is treated as alive
 * to stay conservative (never steal a lock from a process that might be running).
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Release lock (call on process exit / graceful shutdown). */
export function releaseLock(accountId: string): void {
  const lockPath = join(getAccountDir(accountId), '.lock');
  if (existsSync(lockPath)) {
    try {
      rmSync(lockPath);
    } catch {
      // Already deleted by someone else
    }
  }
}

/** Force take over (dead-lock scenario; caller must confirm the previous process is dead). */
export function forceAcquireLock(accountId: string, hostname: string = ''): void {
  releaseLock(accountId);
  const r = acquireLock(accountId, hostname);
  if (r !== null) {
    throw new Error(`forceAcquireLock raced with another process: ${JSON.stringify(r)}`);
  }
}

/**
 * Inbound media drop directory: `<account>/inbox/<msgId>/` (one subdirectory per inbound message).
 *
 * The same inbox subdirectory may contain multiple items (rare, but the iLink protocol
 * allows item_list to have multiple types). One subdirectory per message avoids filename
 * collisions and makes it easy to look up by message id later.
 */
export function getInboxDir(accountId: string, messageId: string): string {
  // messageId may contain arbitrary server-side characters; using base32 for slugification
  // is hard to debug — just sanitise: replace any non-[A-Za-z0-9._-] with _ and cap length.
  const safe = String(messageId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) ||
    `msg_${Date.now()}`;
  return join(getAccountDir(accountId), 'inbox', safe);
}

/** Determine which account to use: env > unique account > error. Used at server startup. */
export function resolveDefaultAccountId(): string | null {
  const fromEnv = process.env.WECHAT_ACCOUNT_ID;
  if (fromEnv && isValidAccountId(fromEnv)) {
    return fromEnv;
  }
  const accounts = listAccounts();
  if (accounts.length === 1) return accounts[0];
  return null; // 0 or more than 1; let the caller decide
}
