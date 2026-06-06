/**
 * paths.ts 测试:默认路径解析 + 老库自动迁移
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDefaultMemoryPath, migrateLegacyMemoryDb } from '../src/paths.js';

function makeIsolatedHome(): string {
  return mkdtempSync(join(tmpdir(), 'philont-home-'));
}

test('resolveDefaultMemoryPath returns ~/.philont/memory/memory.sqlite under HOME', () => {
  const home = makeIsolatedHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const p = resolveDefaultMemoryPath();
    assert.equal(p, join(home, '.philont', 'memory', 'memory.sqlite'));
    // 父目录已建,mode 0o700(POSIX only)
    const dir = join(home, '.philont', 'memory');
    assert.ok(existsSync(dir));
    if (process.platform !== 'win32') {
      const mode = statSync(dir).mode & 0o777;
      assert.equal(mode, 0o700, `expected 0o700 got ${mode.toString(8)}`);
    }
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('migrateLegacyMemoryDb: no legacy file → {migrated:false, no-legacy}', () => {
  const home = makeIsolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'philont-cwd-'));
  const prev = { HOME: process.env.HOME, cwd: process.cwd() };
  process.env.HOME = home;
  process.chdir(cwd);
  try {
    const target = join(home, '.philont', 'memory', 'memory.sqlite');
    mkdirSync(join(home, '.philont', 'memory'), { recursive: true });
    const result = migrateLegacyMemoryDb(target);
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'no-legacy');
  } finally {
    process.chdir(prev.cwd);
    process.env.HOME = prev.HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('migrateLegacyMemoryDb: rename legacy + WAL + SHM when target absent', () => {
  const home = makeIsolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'philont-cwd-'));
  const prev = { HOME: process.env.HOME, cwd: process.cwd() };
  process.env.HOME = home;
  process.chdir(cwd);
  try {
    const legacy = resolve(cwd, 'memory.sqlite');
    writeFileSync(legacy, 'SQLITE-MAIN');
    writeFileSync(legacy + '-wal', 'WAL-DATA');
    writeFileSync(legacy + '-shm', 'SHM-DATA');

    const target = join(home, '.philont', 'memory', 'memory.sqlite');
    const result = migrateLegacyMemoryDb(target);
    assert.equal(result.migrated, true);
    assert.equal(result.from, legacy);

    assert.ok(existsSync(target), 'target sqlite 应已迁移');
    assert.ok(existsSync(target + '-wal'));
    assert.ok(existsSync(target + '-shm'));
    assert.ok(!existsSync(legacy), '老文件应已移走');
    assert.ok(!existsSync(legacy + '-wal'));
    assert.ok(!existsSync(legacy + '-shm'));
  } finally {
    process.chdir(prev.cwd);
    process.env.HOME = prev.HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('migrateLegacyMemoryDb: legacy + target both exist → no-op, target preserved', () => {
  const home = makeIsolatedHome();
  const cwd = mkdtempSync(join(tmpdir(), 'philont-cwd-'));
  const prev = { HOME: process.env.HOME, cwd: process.cwd() };
  process.env.HOME = home;
  process.chdir(cwd);
  try {
    const legacy = resolve(cwd, 'memory.sqlite');
    writeFileSync(legacy, 'LEGACY');
    const target = join(home, '.philont', 'memory', 'memory.sqlite');
    mkdirSync(join(home, '.philont', 'memory'), { recursive: true });
    writeFileSync(target, 'EXISTING-TARGET');

    const result = migrateLegacyMemoryDb(target);
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'target-exists');

    // target 内容保留,legacy 也没动
    assert.ok(existsSync(target));
    assert.ok(existsSync(legacy));
  } finally {
    process.chdir(prev.cwd);
    process.env.HOME = prev.HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('migrateLegacyMemoryDb: same-path short circuit', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'philont-cwd-'));
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    const target = resolve(cwd, 'memory.sqlite');
    writeFileSync(target, 'x');
    const result = migrateLegacyMemoryDb(target);
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'same-path');
    assert.ok(existsSync(target));
  } finally {
    process.chdir(prev);
    rmSync(cwd, { recursive: true, force: true });
  }
});
