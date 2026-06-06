/**
 * inspectPath 工具测试 — 验证 size / type / preview 路径,以及空 / 不存在 /
 * binary / text 各情况。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPathTool } from '../src/index.js';

const TMP = join(tmpdir(), `philont-inspect-${Date.now()}`);

describe('inspectPath', () => {
  before(async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(join(TMP, 'short.txt'), 'hello world\n', 'utf-8');
    await writeFile(join(TMP, 'empty.txt'), '');
    // 写一个伪二进制文件:前若干字节有 \0
    await writeFile(
      join(TMP, 'fake.bin'),
      Buffer.concat([Buffer.from([0xff, 0x00, 0x01, 0x02]), Buffer.alloc(50, 0xab)]),
    );
    // 长文本
    await writeFile(join(TMP, 'long.txt'), 'x'.repeat(500));
  });

  after(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('text file: size + preview', async () => {
    const r = await inspectPathTool.execute({ path: join(TMP, 'short.txt') });
    assert.equal(r.success, true);
    const obj = JSON.parse(r.output);
    assert.equal(obj.exists, true);
    assert.equal(obj.type, 'file');
    assert.equal(obj.size, 12);
    assert.equal(obj.previewKind, 'text');
    assert.equal(obj.preview, 'hello world\n');
    assert.equal(obj.previewBytes, 12);
  });

  it('empty file: 无 preview 字段', async () => {
    const r = await inspectPathTool.execute({ path: join(TMP, 'empty.txt') });
    assert.equal(r.success, true);
    const obj = JSON.parse(r.output);
    assert.equal(obj.size, 0);
    assert.equal(obj.previewKind, undefined);
    assert.equal(obj.preview, undefined);
  });

  it('binary file: previewKind=binary + previewHex', async () => {
    const r = await inspectPathTool.execute({ path: join(TMP, 'fake.bin') });
    assert.equal(r.success, true);
    const obj = JSON.parse(r.output);
    assert.equal(obj.previewKind, 'binary');
    assert.match(obj.previewHex, /^ff0001/);
    assert.equal(obj.preview, undefined);
  });

  it('long text file: 截到 200 字节', async () => {
    const r = await inspectPathTool.execute({ path: join(TMP, 'long.txt') });
    const obj = JSON.parse(r.output);
    assert.equal(obj.size, 500);
    assert.equal(obj.previewBytes, 200);
    assert.equal(obj.preview.length, 200);
  });

  it('not exists: success=true + exists=false', async () => {
    const r = await inspectPathTool.execute({
      path: join(TMP, 'does-not-exist.xyz'),
    });
    assert.equal(r.success, true);
    const obj = JSON.parse(r.output);
    assert.equal(obj.exists, false);
  });

  it('directory: type=directory, no preview', async () => {
    const r = await inspectPathTool.execute({ path: TMP });
    assert.equal(r.success, true);
    const obj = JSON.parse(r.output);
    assert.equal(obj.type, 'directory');
    assert.equal(obj.previewKind, undefined);
  });

  it('missing path param: error', async () => {
    const r = await inspectPathTool.execute({});
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /path is required/);
  });
});
