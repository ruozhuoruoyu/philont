/**
 * backup.ts 测试:BackupRunner 热备份 + 轮转 + chmod
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openMemoryDb, BackupRunner } from '../src/index.js';

function tmpDbDir(): string {
  return mkdtempSync(join(tmpdir(), 'philont-backup-'));
}

test('backupNow writes a usable SQLite file', async () => {
  const dir = tmpDbDir();
  const dbPath = join(dir, 'memory.sqlite');
  const handle = openMemoryDb(dbPath);
  try {
    handle.notes.storeNote({ content: 'hello backup', importance: 0.7 });
    const runner = new BackupRunner(handle.db, dbPath, { dir: join(dir, 'backups') });
    const target = await runner.backupNow();
    assert.ok(existsSync(target), 'backup file missing');
    // 重开备份并查询
    const backupDb = new Database(target, { readonly: true });
    const row = backupDb
      .prepare(`SELECT content FROM memory_notes LIMIT 1`)
      .get() as { content: string };
    assert.equal(row.content, 'hello backup');
    backupDb.close();
    runner.stop();
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup files have mode 0o600', async () => {
  if (process.platform === 'win32') return; // POSIX only
  const dir = tmpDbDir();
  const dbPath = join(dir, 'memory.sqlite');
  const handle = openMemoryDb(dbPath);
  try {
    const runner = new BackupRunner(handle.db, dbPath, { dir: join(dir, 'backups') });
    const target = await runner.backupNow();
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o600);
    runner.stop();
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate keeps only N newest by filename timestamp', async () => {
  const dir = tmpDbDir();
  const dbPath = join(dir, 'memory.sqlite');
  const backupsDir = join(dir, 'backups');
  const handle = openMemoryDb(dbPath);
  try {
    const runner = new BackupRunner(handle.db, dbPath, { dir: backupsDir, retain: 2 });
    // 跨 5 秒触发 5 次,文件名秒级不同,字典序排序稳定
    const base = Date.now();
    const produced: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await runner.backupNow(new Date(base + i * 1000));
      produced.push(p);
    }
    const remaining = readdirSync(backupsDir).filter(
      (n) => n.startsWith('memory-') && n.endsWith('.sqlite')
    );
    assert.equal(remaining.length, 2, `expected 2 kept, got ${remaining.length}: ${remaining}`);
    // 最新两个的基名应该存在(用 path.basename 以兼容 Windows 的反斜杠)
    const latestTwo = produced.slice(-2).map((p) => basename(p));
    for (const name of latestTwo) {
      assert.ok(remaining.includes(name), `expected ${name} to survive rotation`);
    }
    runner.stop();
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after stop(), backupNow is rejected', async () => {
  const dir = tmpDbDir();
  const dbPath = join(dir, 'memory.sqlite');
  const handle = openMemoryDb(dbPath);
  try {
    const runner = new BackupRunner(handle.db, dbPath, { dir: join(dir, 'backups') });
    runner.stop();
    await assert.rejects(() => runner.backupNow(), /closed/);
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMemoryDb with backup config starts the runner automatically', async () => {
  const dir = tmpDbDir();
  const dbPath = join(dir, 'memory.sqlite');
  // 极短 interval 触发一次 tick
  const handle = openMemoryDb(dbPath, {
    backup: { intervalMs: 20, dir: join(dir, 'backups') },
  });
  try {
    await new Promise((r) => setTimeout(r, 80)); // 等待至少一次 tick
    const files = existsSync(join(dir, 'backups'))
      ? readdirSync(join(dir, 'backups')).filter(
          (n) => n.startsWith('memory-') && n.endsWith('.sqlite')
        )
      : [];
    assert.ok(files.length >= 1, `expected at least one backup; got ${files.length}`);
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close() is idempotent and stops backup timer', () => {
  const dir = tmpDbDir();
  const dbPath = join(dir, 'memory.sqlite');
  const handle = openMemoryDb(dbPath, {
    backup: { intervalMs: 1_000_000, dir: join(dir, 'backups') },
  });
  try {
    assert.doesNotThrow(() => handle.close());
    assert.doesNotThrow(() => handle.close()); // 第二次不应炸
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
