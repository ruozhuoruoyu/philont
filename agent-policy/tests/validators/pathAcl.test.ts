import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { createPathAclValidator } from '../../src/validators/pathAcl.js';

const mkCtx = (toolName: string, params: Record<string, unknown>) => ({
  toolName,
  params,
  classification: null,
});

describe('PathAclValidator', () => {
  it('default denyList blocks /etc/shadow', async () => {
    const v = createPathAclValidator();
    const r = await v(mkCtx('readFile', { path: '/etc/shadow' }));
    assert.equal(r.action, 'deny');
    if (r.action === 'deny') assert.equal(r.code, 'PATH_ACL_DENY');
  });

  it('default denyList blocks ~/.ssh/id_rsa', async () => {
    const v = createPathAclValidator();
    const r = await v(mkCtx('readFile', { path: '~/.ssh/id_rsa' }));
    assert.equal(r.action, 'deny');
  });

  it('default denyList blocks **/.env', async () => {
    const v = createPathAclValidator();
    const r = await v(mkCtx('readFile', { path: '/home/user/project/.env' }));
    assert.equal(r.action, 'deny');
  });

  it('normal paths pass through', async () => {
    const v = createPathAclValidator();
    const r = await v(mkCtx('readFile', { path: '/tmp/safe.txt' }));
    assert.equal(r.action, 'pass');
  });

  it('non-fs tools are skipped', async () => {
    const v = createPathAclValidator();
    const r = await v(mkCtx('shell', { path: '/etc/shadow' }));
    assert.equal(r.action, 'pass');
  });

  it('workspaceOnly blocks paths outside workspace', async () => {
    const v = createPathAclValidator({
      workspaceOnly: true,
      workspaceDir: '/tmp/project',
    });
    const r = await v(mkCtx('readFile', { path: '/tmp/other/file.txt' }));
    assert.equal(r.action, 'deny');
    if (r.action === 'deny') assert.equal(r.code, 'PATH_ACL_OUTSIDE_WORKSPACE');
  });

  it('workspaceOnly allows paths inside workspace', async () => {
    const v = createPathAclValidator({
      workspaceOnly: true,
      workspaceDir: '/tmp/project',
    });
    const r = await v(mkCtx('readFile', { path: '/tmp/project/src/a.ts' }));
    assert.equal(r.action, 'pass');
  });

  it('allowList overrides denyList', async () => {
    const v = createPathAclValidator({
      allowList: ['/etc/shadow'],
      denyList: ['/etc/**'],
    });
    const r = await v(mkCtx('readFile', { path: '/etc/shadow' }));
    assert.equal(r.action, 'pass');
  });

  it('checks path, from, to fields', async () => {
    const v = createPathAclValidator();
    const rFrom = await v(mkCtx('moveFile', { from: '/etc/shadow', to: '/tmp/x' }));
    assert.equal(rFrom.action, 'deny');
    const rTo = await v(mkCtx('moveFile', { from: '/tmp/x', to: '/etc/passwd-' }));
    assert.equal(rTo.action, 'deny');
  });

  it('handles ~ expansion', async () => {
    const v = createPathAclValidator();
    const home = homedir();
    const r = await v(mkCtx('readFile', { path: `${home}/.ssh/id_rsa` }));
    assert.equal(r.action, 'deny');
  });

  it('prevents workspace escape via ..', async () => {
    const v = createPathAclValidator({
      workspaceOnly: true,
      workspaceDir: '/tmp/project',
    });
    const r = await v(mkCtx('readFile', { path: '/tmp/project/../../../etc/passwd' }));
    assert.equal(r.action, 'deny');
  });
});

// Cross-platform glob matching. The `platform` config overrides OS detection so the Windows branch
// (backslash separators + case-insensitive) is exercised on any host — this regression-tests the bug
// where `**/.ssh/**` / `**/.aws/credentials` style denies silently failed on Windows backslash paths.
describe('PathAclValidator — OS-aware matching', () => {
  describe('Windows (platform=win32)', () => {
    const v = createPathAclValidator({ platform: 'win32' });

    it('REGRESSION: blocks backslash .aws\\credentials (was silently allowed)', async () => {
      const r = await v(mkCtx('readFile', { path: 'C:\\Users\\ye\\.aws\\credentials' }));
      assert.equal(r.action, 'deny');
    });

    it('blocks backslash .ssh\\config (internal-separator pattern)', async () => {
      const r = await v(mkCtx('readFile', { path: 'C:\\Users\\ye\\.ssh\\config' }));
      assert.equal(r.action, 'deny');
    });

    it('blocks backslash .docker\\config.json', async () => {
      const r = await v(mkCtx('readFile', { path: 'C:\\Users\\ye\\.docker\\config.json' }));
      assert.equal(r.action, 'deny');
    });

    it('case-insensitive: blocks .SSH (uppercase) on Windows', async () => {
      const r = await v(mkCtx('readFile', { path: 'C:\\Users\\ye\\.SSH\\config' }));
      assert.equal(r.action, 'deny');
    });

    it('blocks an id_rsa filename on a backslash path', async () => {
      const r = await v(mkCtx('readFile', { path: 'C:\\Users\\ye\\keys\\id_rsa' }));
      assert.equal(r.action, 'deny');
    });

    it('does not over-block a normal backslash path', async () => {
      const r = await v(mkCtx('readFile', { path: 'C:\\Users\\ye\\proj\\notes.md' }));
      assert.equal(r.action, 'pass');
    });
  });

  describe('POSIX (platform=linux)', () => {
    const v = createPathAclValidator({ platform: 'linux' });

    it('blocks .ssh/config', async () => {
      const r = await v(mkCtx('readFile', { path: '/home/ye/.ssh/config' }));
      assert.equal(r.action, 'deny');
    });

    it('blocks .aws/credentials', async () => {
      const r = await v(mkCtx('readFile', { path: '/home/ye/.aws/credentials' }));
      assert.equal(r.action, 'deny');
    });

    it('is case-SENSITIVE: .SSH (uppercase) is NOT a match on POSIX', async () => {
      const r = await v(mkCtx('readFile', { path: '/home/ye/.SSH/config' }));
      assert.equal(r.action, 'pass');
    });

    it('passes a normal path', async () => {
      const r = await v(mkCtx('readFile', { path: '/home/ye/proj/notes.md' }));
      assert.equal(r.action, 'pass');
    });
  });
});
