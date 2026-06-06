import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visionTool } from '../src/vision/visionTool.js';

// 保存/恢复相关 env,避免污染其他测试
const VISION_ENV = [
  'VISION_LLM_BASE_URL', 'VISION_LLM_API_KEY', 'VISION_LLM_MODEL',
  'VISION_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MODEL',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of VISION_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of VISION_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tmp(bytes: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vision-'));
  const p = join(dir, 'img.bin');
  writeFileSync(p, bytes);
  return p;
}

describe('visionTool', () => {
  it('缺 source → 报错', async () => {
    const r = await visionTool.execute({});
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /missing source/);
  });

  it('未配置任何模型 → 提示如何配置', async () => {
    const r = await visionTool.execute({ source: '/tmp/whatever.png' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /not configured/);
  });

  it('配了 ANTHROPIC_API_KEY 但文件不存在 → 读取失败(不触网)', async () => {
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const r = await visionTool.execute({ source: '/nonexistent/zzz.png' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /failed to read image/);
  });

  it('空文件 → 图片为空', async () => {
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const p = tmp(Buffer.alloc(0));
    const r = await visionTool.execute({ source: p });
    rmSync(p, { force: true });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /is empty/);
  });

  it('非图片(坏魔数)→ 无法识别格式', async () => {
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const p = tmp('this is plain text, not an image at all');
    const r = await visionTool.execute({ source: p });
    rmSync(p, { force: true });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /unrecognized image format/);
  });

  it('识别 PNG 魔数(走到网络层才失败,说明格式校验通过)', async () => {
    // 给一个合法 PNG 头 + 假 endpoint,断言错误不再是格式错误
    process.env.VISION_LLM_BASE_URL = 'http://127.0.0.1:1';
    process.env.VISION_LLM_API_KEY = 'dummy';
    process.env.VISION_LLM_MODEL = 'x';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const p = tmp(png);
    const r = await visionTool.execute({ source: p });
    rmSync(p, { force: true });
    assert.equal(r.success, false);
    assert.doesNotMatch(r.error ?? '', /unrecognized image format|is empty|failed to read image/);
  });

  it('capability=read / domain=network(只读矩阵下读图可自动放行)', () => {
    assert.equal(visionTool.capability, 'read');
    assert.equal(visionTool.domain, 'network');
  });
});
