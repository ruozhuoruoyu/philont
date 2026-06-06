import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSsrfValidator } from '../../src/validators/ssrf.js';

const mkCtx = (toolName: string, params: Record<string, unknown>) => ({
  toolName,
  params,
  classification: null,
});

describe('SsrfValidator', () => {
  it('blocks localhost literal', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r = await v(mkCtx('http', { url: 'http://localhost/' }));
    assert.equal(r.action, 'deny');
  });

  it('blocks 127.0.0.1 literal', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r = await v(mkCtx('http', { url: 'http://127.0.0.1/' }));
    assert.equal(r.action, 'deny');
  });

  it('blocks RFC1918 private IPs', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1']) {
      const r = await v(mkCtx('http', { url: `http://${ip}/` }));
      assert.equal(r.action, 'deny', `${ip} should be blocked`);
    }
  });

  it('blocks AWS/GCP metadata endpoint', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r1 = await v(mkCtx('http', { url: 'http://169.254.169.254/latest/meta-data/' }));
    assert.equal(r1.action, 'deny');
    const r2 = await v(mkCtx('http', { url: 'http://metadata.google.internal/' }));
    assert.equal(r2.action, 'deny');
  });

  it('blocks IPv6 loopback ::1', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r = await v(mkCtx('http', { url: 'http://[::1]/' }));
    assert.equal(r.action, 'deny');
  });

  it('blocks embedded IPv4 in IPv6', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r = await v(mkCtx('http', { url: 'http://[::ffff:127.0.0.1]/' }));
    assert.equal(r.action, 'deny');
  });

  it('rejects non-http schemes', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r1 = await v(mkCtx('http', { url: 'file:///etc/passwd' }));
    assert.equal(r1.action, 'deny');
    const r2 = await v(mkCtx('http', { url: 'gopher://evil.com/' }));
    assert.equal(r2.action, 'deny');
  });

  it('rejects URL with userinfo', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r = await v(mkCtx('http', { url: 'http://user:pass@evil.com/' }));
    assert.equal(r.action, 'deny');
  });

  it('allowPrivateNetwork allows private IPs', async () => {
    const v = createSsrfValidator({ allowPrivateNetwork: true, verifyDns: false });
    const r = await v(mkCtx('http', { url: 'http://192.168.1.1/' }));
    assert.equal(r.action, 'pass');
  });

  it('allowPrivateNetwork still blocks loopback/linklocal', async () => {
    const v = createSsrfValidator({ allowPrivateNetwork: true, verifyDns: false });
    const r1 = await v(mkCtx('http', { url: 'http://127.0.0.1/' }));
    assert.equal(r1.action, 'deny');
    const r2 = await v(mkCtx('http', { url: 'http://169.254.169.254/' }));
    assert.equal(r2.action, 'deny');
  });

  it('skips non-network tools', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r = await v(mkCtx('readFile', { url: 'http://127.0.0.1/' }));
    assert.equal(r.action, 'pass');
  });

  it('blocks .localhost TLD suffix', async () => {
    const v = createSsrfValidator({ verifyDns: false });
    const r = await v(mkCtx('http', { url: 'http://admin.localhost/' }));
    assert.equal(r.action, 'deny');
  });

  it('allowHosts allows whitelisted', async () => {
    const v = createSsrfValidator({
      verifyDns: false,
      allowHosts: ['192.168.1.1'],
    });
    const r = await v(mkCtx('http', { url: 'http://192.168.1.1/' }));
    assert.equal(r.action, 'pass');
  });
});
