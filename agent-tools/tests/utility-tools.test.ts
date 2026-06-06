import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonPatchTool,
  hashTool,
  envTool,
  jsonTool,
  timeTool,
  echoTool,
  memoryTool,
} from '../src/index.js';

describe('jsonPatch', () => {
  it('add operation creates new key', async () => {
    const r = await jsonPatchTool.execute({
      document: '{"a":1}',
      operations: [{ op: 'add', path: '/b', value: 2 }],
    });
    assert.equal(r.success, true);
    assert.deepEqual(JSON.parse(r.output), { a: 1, b: 2 });
  });

  it('remove operation deletes key', async () => {
    const r = await jsonPatchTool.execute({
      document: '{"a":1,"b":2}',
      operations: [{ op: 'remove', path: '/b' }],
    });
    assert.equal(r.success, true);
    assert.deepEqual(JSON.parse(r.output), { a: 1 });
  });

  it('move operation relocates value', async () => {
    const r = await jsonPatchTool.execute({
      document: '{"a":1,"b":2}',
      operations: [{ op: 'move', from: '/a', path: '/c' }],
    });
    assert.equal(r.success, true);
    assert.deepEqual(JSON.parse(r.output), { b: 2, c: 1 });
  });

  it('copy operation duplicates value', async () => {
    const r = await jsonPatchTool.execute({
      document: '{"a":{"x":1}}',
      operations: [{ op: 'copy', from: '/a', path: '/b' }],
    });
    assert.equal(r.success, true);
    assert.deepEqual(JSON.parse(r.output), { a: { x: 1 }, b: { x: 1 } });
  });

  it('test operation succeeds when value matches', async () => {
    const r = await jsonPatchTool.execute({
      document: '{"a":1}',
      operations: [{ op: 'test', path: '/a', value: 1 }],
    });
    assert.equal(r.success, true);
  });

  it('test operation fails on mismatch', async () => {
    const r = await jsonPatchTool.execute({
      document: '{"a":1}',
      operations: [{ op: 'test', path: '/a', value: 2 }],
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('value mismatch'));
  });

  it('handles array paths', async () => {
    const r = await jsonPatchTool.execute({
      document: '{"arr":[1,2,3]}',
      operations: [
        { op: 'replace', path: '/arr/1', value: 99 },
        { op: 'add', path: '/arr/-', value: 4 },
      ],
    });
    assert.equal(r.success, true);
    assert.deepEqual(JSON.parse(r.output), { arr: [1, 99, 3, 4] });
  });

  it('rejects invalid JSON document', async () => {
    const r = await jsonPatchTool.execute({
      document: 'not valid json',
      operations: [],
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('Invalid JSON'));
  });

  it('rejects invalid pointer', async () => {
    const r = await jsonPatchTool.execute({
      document: '{}',
      operations: [{ op: 'replace', path: 'no-leading-slash', value: 1 }],
    });
    assert.equal(r.success, false);
  });
});

describe('hash', () => {
  it('sha256 produces expected output', async () => {
    const r = await hashTool.execute({ algorithm: 'sha256', input: 'abc' });
    assert.equal(r.success, true);
    assert.equal(r.output, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('md5 produces expected output', async () => {
    const r = await hashTool.execute({ algorithm: 'md5', input: 'hello' });
    assert.equal(r.success, true);
    assert.equal(r.output, '5d41402abc4b2a76b9719d911017c592');
  });

  it('base64 roundtrip', async () => {
    const enc = await hashTool.execute({ algorithm: 'base64encode', input: 'hello world' });
    assert.equal(enc.success, true);
    const dec = await hashTool.execute({ algorithm: 'base64decode', input: enc.output });
    assert.equal(dec.output, 'hello world');
  });

  it('hex roundtrip', async () => {
    const enc = await hashTool.execute({ algorithm: 'hexencode', input: 'abc' });
    assert.equal(enc.output, '616263');
    const dec = await hashTool.execute({ algorithm: 'hexdecode', input: '616263' });
    assert.equal(dec.output, 'abc');
  });
});

describe('env', () => {
  it('list filters by prefix', async () => {
    process.env.PHILONT_TEST_VAR_1 = 'v1';
    process.env.PHILONT_TEST_VAR_2 = 'v2';
    process.env.OTHER_VAR = 'nope';

    const r = await envTool.execute({ action: 'list', prefix: 'PHILONT_TEST_' });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('PHILONT_TEST_VAR_1=v1'));
    assert.ok(r.output.includes('PHILONT_TEST_VAR_2=v2'));
    assert.ok(!r.output.includes('OTHER_VAR'));

    delete process.env.PHILONT_TEST_VAR_1;
    delete process.env.PHILONT_TEST_VAR_2;
    delete process.env.OTHER_VAR;
  });

  it('unmask: true reveals sensitive values', async () => {
    process.env.PHILONT_FAKE_TOKEN = 'secret-value-12345';
    const masked = await envTool.execute({ action: 'get', name: 'PHILONT_FAKE_TOKEN' });
    assert.ok(!masked.output.includes('secret-value-12345'));

    const unmasked = await envTool.execute({
      action: 'get',
      name: 'PHILONT_FAKE_TOKEN',
      unmask: true,
    });
    assert.equal(unmasked.output, 'secret-value-12345');

    delete process.env.PHILONT_FAKE_TOKEN;
  });

  it('returns error for unset variable', async () => {
    const r = await envTool.execute({ action: 'get', name: 'DEFINITELY_NOT_SET_XYZ' });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('not set'));
  });
});

describe('json tool', () => {
  it('parse validates JSON', async () => {
    const r = await jsonTool.execute({ action: 'validate', data: '{"a":1}' });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('Valid'));
  });

  it('parse formats output', async () => {
    const r = await jsonTool.execute({ action: 'parse', data: '{"a":1,"b":2}' });
    assert.equal(r.success, true);
    // formatted = pretty-printed
    assert.ok(r.output.includes('\n'));
  });
});

describe('time tool', () => {
  it('iso format returns ISO string', async () => {
    const r = await timeTool.execute({ format: 'iso' });
    assert.equal(r.success, true);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.output));
  });

  it('unix format returns number string', async () => {
    const r = await timeTool.execute({ format: 'unix' });
    assert.equal(r.success, true);
    assert.ok(/^\d+$/.test(r.output));
  });
});

describe('echo and memory', () => {
  it('echo returns message', async () => {
    const r = await echoTool.execute({ message: 'hello' });
    assert.equal(r.output, 'hello');
  });

  it('memory set/get roundtrip', async () => {
    await memoryTool.execute({ action: 'set', key: 'test-key', value: 'test-val' });
    const r = await memoryTool.execute({ action: 'get', key: 'test-key' });
    assert.equal(r.output, 'test-val');
    await memoryTool.execute({ action: 'delete', key: 'test-key' });
  });
});
