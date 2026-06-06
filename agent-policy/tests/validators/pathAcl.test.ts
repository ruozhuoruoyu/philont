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
