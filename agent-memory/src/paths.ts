/**
 * Memory database default path resolution and legacy database migration.
 *
 * Default location: `~/.philont/memory/memory.sqlite`. Sibling of the backups/ subdirectory,
 * for unified management (data + backups + potential future index/encryption state).
 *
 * Legacy migration: the historical default path was `./memory.sqlite` in the server's CWD.
 * To let existing users seamlessly switch to the new path, on startup scan the CWD for the
 * three-file set (`.sqlite` + `-wal` + `-shm`); only move them if the new path doesn't exist.
 * If the new database already exists, leave the old database in place and warn.
 */

import { existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const WAL_SUFFIX = '-wal';
const SHM_SUFFIX = '-shm';

/**
 * Return the default memory.sqlite path; ensure parent directory exists (mode 0o700).
 * Can be overridden by the HOME environment variable for testing.
 */
export function resolveDefaultMemoryPath(): string {
  const home = process.env.HOME ?? homedir();
  const dir = join(home, '.philont', 'memory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'memory.sqlite');
}

export interface MigrationResult {
  migrated: boolean;
  from?: string;
  reason?: 'no-legacy' | 'target-exists' | 'same-path';
}

/**
 * If `./memory.sqlite` exists in CWD and target does not exist, move the three-file set to the target location.
 *
 * - Three-file set: `memory.sqlite`, `memory.sqlite-wal`, `memory.sqlite-shm` (the latter two only moved if they exist)
 * - Same filesystem: atomic rename; cross-FS: fallback copy + unlink
 * - No-op if target already exists or legacy does not exist (never overwrites existing data)
 * - Returns immediately if already the same path (determined by comparing resolved paths)
 */
export function migrateLegacyMemoryDb(targetPath: string): MigrationResult {
  const legacyPath = resolve(process.cwd(), 'memory.sqlite');
  const absTarget = resolve(targetPath);

  if (legacyPath === absTarget) {
    return { migrated: false, reason: 'same-path' };
  }
  if (!existsSync(legacyPath)) {
    return { migrated: false, reason: 'no-legacy' };
  }
  if (existsSync(absTarget)) {
    console.warn(
      `[memory] found ${legacyPath} but ${absTarget} already exists; keeping target, not migrating legacy db.` +
      `To switch back to the legacy db, explicitly set MEMORY_DB_PATH=${legacyPath}.`
    );
    return { migrated: false, from: legacyPath, reason: 'target-exists' };
  }

  mkdirSync(dirname(absTarget), { recursive: true, mode: 0o700 });

  // Move each file in the three-file set; only move WAL/SHM if they exist
  const pairs: [string, string][] = [
    [legacyPath, absTarget],
    [legacyPath + WAL_SUFFIX, absTarget + WAL_SUFFIX],
    [legacyPath + SHM_SUFFIX, absTarget + SHM_SUFFIX],
  ];
  for (const [src, dst] of pairs) {
    if (!existsSync(src)) continue;
    try {
      renameSync(src, dst);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EXDEV') {
        copyFileSync(src, dst);
        unlinkSync(src);
      } else {
        throw e;
      }
    }
  }

  console.log(`[memory] migrating legacy db: ${legacyPath} → ${absTarget}`);
  return { migrated: true, from: legacyPath };
}
