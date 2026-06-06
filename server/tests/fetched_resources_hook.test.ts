/**
 * fetched-store hook 测试(2026-05-15)
 *
 * 关键场景:LLM readFile fetched/ 目录里的文件 → 应跳过 put,避免
 * 递归 `local-`/`local-local-` 前缀污染 workspace。
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FetchedResourceStore } from '@agent/memory';
import { persistToolResultIfFetched } from '../src/fetched_resources_hook.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function mkStore(): FetchedResourceStore {
  const dir = mkdtempSync(join(tmpdir(), 'philont-hook-'));
  tmpDirs.push(dir);
  return new FetchedResourceStore({ baseDir: dir, flushDebounceMs: 10 });
}

describe('persistToolResultIfFetched — readFile guard', () => {
  it('readFile 外部文件 → 正常 put', () => {
    const store = mkStore();
    persistToolResultIfFetched(store, {
      toolName: 'readFile',
      params: { path: '/some/external/path/guide.md' },
      success: true,
      output: '# Guide\nbody',
    });
    const files = readdirSync(store.baseDir).filter(f => f !== '_manifest.json');
    assert.equal(files.length, 1, '应有 1 个落盘文件');
    assert.ok(files[0].startsWith('local-'), 'filename 应有 local- 前缀');
  });

  it('readFile fetched/ 内部文件 → 跳过 put(不污染)', () => {
    const store = mkStore();
    // 先种一个 webFetch 落盘
    persistToolResultIfFetched(store, {
      toolName: 'webFetch',
      params: { url: 'https://example.com/guide.md' },
      success: true,
      output:
        'URL: https://example.com/guide.md\n' +
        'Status: 200\n' +
        'Extractor: markdown\n' +
        'Fetched in 100ms\n' +
        '\n---\n\n# Guide\nbody',
    });
    const filesAfterFetch = readdirSync(store.baseDir).filter(f => f !== '_manifest.json');
    assert.equal(filesAfterFetch.length, 1, 'webFetch 后 1 个文件');
    const fetchedPath = join(store.baseDir, filesAfterFetch[0]);

    // 再 readFile 同一个 fetched/ 内的文件 → 不应再产新文件
    persistToolResultIfFetched(store, {
      toolName: 'readFile',
      params: { path: fetchedPath },
      success: true,
      output: '# Guide\nbody',
    });
    const filesAfterRead = readdirSync(store.baseDir).filter(f => f !== '_manifest.json');
    assert.equal(filesAfterRead.length, 1, 'readFile fetched/ 内部文件不应新增');
    assert.doesNotMatch(filesAfterRead[0], /^local-local-/, '不应有递归前缀');
  });

  it('readFile fetched/ 内部嵌套文件路径也跳过', () => {
    const store = mkStore();
    // 直接构造 baseDir 内的路径(不需要文件真实存在,hook 只看路径前缀)
    persistToolResultIfFetched(store, {
      toolName: 'readFile',
      params: { path: join(store.baseDir, 'something.md') },
      success: true,
      output: 'body',
    });
    const files = readdirSync(store.baseDir).filter(f => f !== '_manifest.json');
    assert.equal(files.length, 0, 'baseDir 内任何路径都跳过');
  });

  it('readFile 路径恰好是 baseDir 自身(异常但 robust)', () => {
    const store = mkStore();
    persistToolResultIfFetched(store, {
      toolName: 'readFile',
      params: { path: store.baseDir },
      success: true,
      output: '',
    });
    const files = readdirSync(store.baseDir).filter(f => f !== '_manifest.json');
    assert.equal(files.length, 0);
  });

  it('Phase 15.5: excludeDirs 跳过 plan-files baseDir 下的 plan.md', () => {
    const store = mkStore();
    const planFilesBase = mkdtempSync(join(tmpdir(), 'philont-plans-'));
    tmpDirs.push(planFilesBase);
    persistToolResultIfFetched(
      store,
      {
        toolName: 'readFile',
        params: { path: join(planFilesBase, 'mycox', 'plan.md') },
        success: true,
        output: '---\nproject: mycox\n---\n# mycox\n',
      },
      { excludeDirs: [planFilesBase] },
    );
    const files = readdirSync(store.baseDir).filter(f => f !== '_manifest.json');
    assert.equal(files.length, 0, 'plan.md 应跳过,不复制进 fetched-store');
  });

  it('Phase 15.5: excludeDirs 不影响其它路径的正常 put', () => {
    const store = mkStore();
    const planFilesBase = mkdtempSync(join(tmpdir(), 'philont-plans-'));
    tmpDirs.push(planFilesBase);
    persistToolResultIfFetched(
      store,
      {
        toolName: 'readFile',
        params: { path: '/some/other/path/notes.md' },
        success: true,
        output: '# Notes',
      },
      { excludeDirs: [planFilesBase] },
    );
    const files = readdirSync(store.baseDir).filter(f => f !== '_manifest.json');
    assert.equal(files.length, 1, '排除目录外的文件仍正常落盘');
  });
});
