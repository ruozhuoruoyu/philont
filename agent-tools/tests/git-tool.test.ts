import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { gitTool } from '../src/index.js';

const execAsync = promisify(exec);
const TMP = join(tmpdir(), `philont-git-test-${Date.now()}`);

describe('git tool', () => {
  before(async () => {
    await mkdir(TMP, { recursive: true });
    await execAsync('git init', { cwd: TMP });
    await execAsync('git config user.email "t@t.com"', { cwd: TMP });
    await execAsync('git config user.name "T"', { cwd: TMP });
    await writeFile(join(TMP, 'README.md'), '# test repo\n');
    await execAsync('git add README.md', { cwd: TMP });
    await execAsync('git commit -m "initial"', { cwd: TMP });
  });

  after(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('status returns working tree info', async () => {
    const r = await gitTool.execute({ action: 'status', cwd: TMP });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('##') || r.output.includes('branch'));
  });

  it('log returns commit history', async () => {
    const r = await gitTool.execute({ action: 'log', cwd: TMP, limit: 5 });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('initial'));
  });

  it('branch lists branches', async () => {
    const r = await gitTool.execute({ action: 'branch', cwd: TMP });
    assert.equal(r.success, true);
    assert.ok(r.output.length > 0);
  });

  it('diff returns (possibly empty) output', async () => {
    await writeFile(join(TMP, 'new-file.txt'), 'content');
    await execAsync('git add new-file.txt', { cwd: TMP });

    const r = await gitTool.execute({ action: 'diff', cwd: TMP, cached: true });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('new-file.txt'));
  });

  it('returns error for unknown action', async () => {
    const r = await gitTool.execute({ action: 'unknown' as any, cwd: TMP });
    assert.equal(r.success, false);
  });

  it('returns error outside git repo', async () => {
    const r = await gitTool.execute({ action: 'status', cwd: tmpdir() });
    assert.equal(r.success, false);
  });
});
