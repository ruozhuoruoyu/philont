/**
 * openMemoryDb 连接参数与文件权限测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb, BackupRunner } from '../src/index.js';

test('openMemoryDb sets WAL + NORMAL + foreign_keys + busy_timeout pragmas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'philont-pragma-'));
  const handle = openMemoryDb(join(dir, 'memory.sqlite'));
  try {
    assert.equal(handle.db.pragma('journal_mode', { simple: true }), 'wal');
    // synchronous: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    assert.equal(handle.db.pragma('synchronous', { simple: true }), 1);
    assert.equal(handle.db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(handle.db.pragma('busy_timeout', { simple: true }), 5000);
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMemoryDb chmods main DB file to 0o600', () => {
  if (process.platform === 'win32') return; // POSIX only
  const dir = mkdtempSync(join(tmpdir(), 'philont-chmod-'));
  const dbPath = join(dir, 'memory.sqlite');
  const handle = openMemoryDb(dbPath);
  try {
    const mode = statSync(dbPath).mode & 0o777;
    assert.equal(mode, 0o600, `main DB mode expected 0o600 got ${mode.toString(8)}`);
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMemoryDb with :memory: skips chmod and backup (no crash)', () => {
  const handle = openMemoryDb(':memory:', {
    backup: { intervalMs: 1000, retain: 1 },
  });
  try {
    assert.ok(handle.db);
    assert.equal(handle.recovery.kind, 'none');
    // 内存 DB 不应启动备份 runner;close() 干净退出
    handle.close();
  } catch (e) {
    assert.fail(`unexpected throw: ${e}`);
  }
});

test('openMemoryDb reports recovery=none for a healthy DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'philont-recover-none-'));
  const dbPath = join(dir, 'memory.sqlite');
  try {
    openMemoryDb(dbPath).close(); // 首次创建
    const handle = openMemoryDb(dbPath); // 再开:健康库
    try {
      assert.equal(handle.recovery.kind, 'none');
    } finally {
      handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMemoryDb starts fresh when DB is corrupt and no backup exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'philont-recover-fresh-'));
  const dbPath = join(dir, 'memory.sqlite');
  try {
    writeFileSync(dbPath, 'corrupt garbage, no backups around');
    const handle = openMemoryDb(dbPath);
    try {
      assert.equal(handle.recovery.kind, 'fresh-after-corruption');
      // 损坏文件被隔离保留(不静默丢弃)
      const quarantined = readdirSync(dir).filter((n) => n.includes('.corrupt-'));
      assert.ok(quarantined.length >= 1, 'corrupt file not quarantined');
      // 空库可正常用 —— 服务不崩
      handle.notes.storeNote({ content: 'fresh start works', importance: 0.5 });
      const rows = handle.db.prepare('SELECT content FROM memory_notes').all();
      assert.equal(rows.length, 1);
    } finally {
      handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMemoryDb restores from backup when DB is corrupt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'philont-recover-backup-'));
  const dbPath = join(dir, 'memory.sqlite');
  const backupDir = join(dir, 'backups');
  try {
    // 1. 建健康库,写一条 note,做一次备份
    const h1 = openMemoryDb(dbPath);
    h1.notes.storeNote({ content: 'survive the corruption', importance: 0.9 });
    const runner = new BackupRunner(h1.db, dbPath, { dir: backupDir });
    await runner.backupNow();
    runner.stop();
    h1.close();

    // 2. 破坏主库
    writeFileSync(dbPath, 'not a sqlite file at all — garbage');

    // 3. 重开 → 应从备份恢复,数据还在
    const h2 = openMemoryDb(dbPath, { backup: { dir: backupDir } });
    try {
      assert.equal(h2.recovery.kind, 'restored-from-backup');
      const rows = h2.db
        .prepare('SELECT content FROM memory_notes')
        .all() as Array<{ content: string }>;
      assert.ok(
        rows.some((r) => r.content === 'survive the corruption'),
        'restored note missing'
      );
    } finally {
      h2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
