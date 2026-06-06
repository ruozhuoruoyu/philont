import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ValidatorChain, pass, deny, mutate, requireGrant } from '../../src/validators/index.js';
import { GrantStore } from '../../src/grant.js';
import { AuditLog } from '../../src/audit.js';

const mkCtx = (overrides: any = {}) => ({
  toolName: 'test',
  params: { foo: 'bar' },
  classification: null,
  ...overrides,
});

describe('ValidatorChain', () => {
  it('runs validators in order and returns pass', async () => {
    const chain = new ValidatorChain()
      .register('v1', async () => pass())
      .register('v2', async () => pass());

    const r = await chain.run(mkCtx());
    assert.equal(r.action, 'pass');
    assert.equal(r.steps.length, 2);
  });

  it('stops at first deny', async () => {
    let v3Called = false;
    const chain = new ValidatorChain()
      .register('v1', async () => pass())
      .register('v2', async () => deny('TEST_DENY', 'blocked'))
      .register('v3', async () => {
        v3Called = true;
        return pass();
      });

    const r = await chain.run(mkCtx());
    assert.equal(r.action, 'deny');
    assert.equal(r.code, 'TEST_DENY');
    assert.equal(r.reason, 'blocked');
    assert.equal(v3Called, false);
    assert.equal(r.steps.length, 2);
  });

  it('mutate passes modified params to next validator', async () => {
    let v2SawNewParams = false;
    const chain = new ValidatorChain()
      .register('v1', async (ctx) => mutate({ ...ctx.params, injected: true }))
      .register('v2', async (ctx) => {
        v2SawNewParams = ctx.params.injected === true;
        return pass();
      });

    await chain.run(mkCtx());
    assert.equal(v2SawNewParams, true);
  });

  it('require-grant denies when no grant exists', async () => {
    const chain = new ValidatorChain()
      .register('v1', async () => requireGrant('tool', 'test', 'needs approval'));

    const grants = new GrantStore();
    const r = await chain.run(mkCtx({ grants }));
    assert.equal(r.action, 'require-grant');
    assert.equal(r.grantPattern, 'test');
  });

  it('require-grant passes when grant exists', async () => {
    const chain = new ValidatorChain()
      .register('v1', async () => requireGrant('tool', 'test', 'needs approval'))
      .register('v2', async () => pass());

    const grants = new GrantStore();
    grants.grant('test', 'read', 'local', 'granted for test');
    const r = await chain.run(mkCtx({ grants }));
    assert.equal(r.action, 'pass');
  });

  it('audits each step', async () => {
    const audit = new AuditLog();
    const chain = new ValidatorChain()
      .register('v1', async () => pass())
      .register('v2', async () => deny('X', 'blocked'));

    await chain.run(mkCtx({ audit }));
    const events = audit.getEvents().filter(e => e.type === 'validator_step');
    assert.equal(events.length, 2);
    assert.equal((events[0].data as any).validator, 'v1');
    assert.equal((events[1].data as any).validator, 'v2');
    assert.equal((events[1].data as any).action, 'deny');
  });

  it('empty chain passes', async () => {
    const chain = new ValidatorChain();
    const r = await chain.run(mkCtx());
    assert.equal(r.action, 'pass');
  });

  it('clear() removes all validators', async () => {
    const chain = new ValidatorChain()
      .register('v1', async () => deny('X', 'blocked'));
    chain.clear();
    const r = await chain.run(mkCtx());
    assert.equal(r.action, 'pass');
  });
});
