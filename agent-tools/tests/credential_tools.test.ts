/**
 * credential_tools 单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '@agent/policy';
import { createCredentialTools } from '../src/utility/credential_tools.js';

// 32 bytes 全 0 → base64 (44 字符)
const TEST_MASTER_KEY = Buffer.alloc(32, 0).toString('base64');

function setup(): { tools: ReturnType<typeof createCredentialTools>; store: SecretStore } {
  const store = new SecretStore({ masterKey: TEST_MASTER_KEY });
  const tools = createCredentialTools(store);
  return { tools, store };
}

// 占位测试值,32 字符,远高于 16 字符 size guard,模拟典型完整 API key 长度
const FAKE_FULL_KEY_A = 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa';
const FAKE_FULL_KEY_B = 'sk-test-bbbbbbbbbbbbbbbbbbbbbbbb';

test('saveCredentialTool: 正常保存 + 后续 list 可见', async () => {
  const { tools, store } = setup();
  const save = tools[0];
  const r = await save.execute({ name: 'demo-api-key', value: FAKE_FULL_KEY_A });
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /saved/);
  assert.equal(store.get('demo-api-key'), FAKE_FULL_KEY_A);
  // 占位符提示包含
  assert.match(r.output ?? '', /DEMO_API_KEY/);
});

test('saveCredentialTool: 同名覆盖 (key rotation)', async () => {
  const { tools, store } = setup();
  const save = tools[0];
  await save.execute({ name: 'k1', value: FAKE_FULL_KEY_A });
  const r2 = await save.execute({ name: 'k1', value: FAKE_FULL_KEY_B });
  assert.equal(r2.success, true);
  assert.match(r2.output ?? '', /updated/);
  assert.equal(store.get('k1'), FAKE_FULL_KEY_B);
});

test('saveCredentialTool: name 非法 → fail', async () => {
  const { tools } = setup();
  const save = tools[0];
  // 太短
  const r1 = await save.execute({ name: 'a', value: FAKE_FULL_KEY_A });
  assert.equal(r1.success, false);
  // 含特殊字符
  const r2 = await save.execute({ name: 'has space', value: FAKE_FULL_KEY_A });
  assert.equal(r2.success, false);
  // 太长
  const r3 = await save.execute({ name: 'a'.repeat(65), value: FAKE_FULL_KEY_A });
  assert.equal(r3.success, false);
});

test('saveCredentialTool: value 空 / 超长 → fail', async () => {
  const { tools } = setup();
  const save = tools[0];
  const r1 = await save.execute({ name: 'good-name', value: '' });
  assert.equal(r1.success, false);
  const r2 = await save.execute({ name: 'good-name', value: 'x'.repeat(9000) });
  assert.equal(r2.success, false);
  assert.match(r2.error ?? '', /exceeds 8192/);
});

// 2026-05-14 Phase 10 P0:auth prefix 错存检测
test('saveCredentialTool: value 含 "Bearer " 前缀 → reject + 提示剥前缀', async () => {
  const { tools, store } = setup();
  const save = tools[0];
  const r = await save.execute({
    name: 'mycox-api-key',
    value: 'Bearer sk-abc123def456ghi789',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /auth-scheme prefix/);
  assert.match(r.error ?? '', /Bearer/);
  assert.match(r.error ?? '', /stripping the prefix/);
  assert.equal(store.has('mycox-api-key'), false);
});

test('saveCredentialTool: value 是 "Authorization: ..." 整段 → reject', async () => {
  const { tools, store } = setup();
  const save = tools[0];
  const r = await save.execute({
    name: 'mycox-api-key',
    value: 'Authorization: Bearer sk-xxx-very-long-token-12345',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /HTTP header line/);
  assert.match(r.error ?? '', /Authorization:/);
  assert.equal(store.has('mycox-api-key'), false);
});

test('saveCredentialTool: value 含换行 → reject', async () => {
  const { tools } = setup();
  const save = tools[0];
  const r = await save.execute({
    name: 'k1',
    value: 'sk-xxx-very-long-token-12345\nother line',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /newline/);
});

test('saveCredentialTool: value 被引号包裹 → reject', async () => {
  const { tools } = setup();
  const save = tools[0];
  const r = await save.execute({
    name: 'k2',
    value: '"sk-xxx-very-long-token-12345"',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /quotes/);
});

test('saveCredentialTool: 各种 scheme prefix 都拦', async () => {
  const { tools } = setup();
  const save = tools[0];
  for (const prefix of ['Bearer ', 'Token ', 'Basic ', 'Digest ', 'API-Key ', 'api_key ']) {
    const r = await save.execute({
      name: 'kp',
      value: `${prefix}sk-abc123def456ghi789-very-long`,
    });
    assert.equal(r.success, false, `prefix="${prefix}" 应该被拦`);
  }
});

test('saveCredentialTool: 裸 token(无 prefix)→ 正常存', async () => {
  const { tools, store } = setup();
  const save = tools[0];
  const r = await save.execute({
    name: 'mycox-api-key',
    value: 'sk-abc123def456ghi789jkl0',
  });
  assert.equal(r.success, true);
  assert.equal(store.has('mycox-api-key'), true);
});

test('saveCredentialTool: value < 16 字符 → fail 提示 prefix 踩坑', async () => {
  const { tools, store } = setup();
  const save = tools[0];
  // 典型 prefix 长度,12 字符
  const r1 = await save.execute({ name: 'mycox-api-key', value: 'svc_abcd1234' });
  assert.equal(r1.success, false);
  assert.match(r1.error ?? '', /16-char threshold/);
  assert.match(r1.error ?? '', /api_key_prefix/);
  assert.equal(store.has('mycox-api-key'), false, '未通过校验时不应写入 store');
  // 边界 — 15 字符也拒
  const r2 = await save.execute({ name: 'k2', value: 'x'.repeat(15) });
  assert.equal(r2.success, false);
  // 边界 — 16 字符通过
  const r3 = await save.execute({ name: 'k3', value: 'x'.repeat(16) });
  assert.equal(r3.success, true);
});

test('removeCredentialTool: 删存在的 → 成功; 删不存在 → 友好提示', async () => {
  const { tools, store } = setup();
  const [save, remove] = tools;
  await save.execute({ name: 'k1', value: FAKE_FULL_KEY_A });
  const r1 = await remove.execute({ name: 'k1' });
  assert.equal(r1.success, true);
  assert.match(r1.output ?? '', /deleted/);
  assert.equal(store.has('k1'), false);

  const r2 = await remove.execute({ name: 'never-saved' });
  assert.equal(r2.success, true);
  assert.match(r2.output ?? '', /does not exist/);
});

test('listCredentialNamesTool: 空 / 多条', async () => {
  const { tools } = setup();
  const [save, , list] = tools;
  const r1 = await list.execute({});
  assert.match(r1.output ?? '', /No credentials/);
  await save.execute({ name: 'aa', value: FAKE_FULL_KEY_A });
  await save.execute({ name: 'b-key', value: FAKE_FULL_KEY_B });
  const r2 = await list.execute({});
  assert.match(r2.output ?? '', /Saved credentials.*2/);
  assert.match(r2.output ?? '', /- aa/);
  assert.match(r2.output ?? '', /- b-key/);
});

test('listCredentialNamesTool: 不暴露 value', async () => {
  const { tools } = setup();
  const [save, , list] = tools;
  await save.execute({ name: 'xx', value: 'super-secret-value-aaaaaa' });
  const r = await list.execute({});
  assert.doesNotMatch(r.output ?? '', /super-secret/);
});

// 2026-05-15:C — 永久教育文本(防 LLM 把 prefix 当 key 拼)
test('listCredentialNamesTool: 非空时 output 含占位符使用说明 + http 示例', async () => {
  const { tools } = setup();
  const [save, , list] = tools;
  await save.execute({ name: 'svc-token', value: FAKE_FULL_KEY_A });
  const r = await list.execute({});
  assert.match(r.output ?? '', /How to use/);
  assert.match(r.output ?? '', /Bearer \{<credential-name>\}/);
  assert.match(r.output ?? '', /fallback/);
  assert.match(r.output ?? '', /prefix/);
});

test('listCredentialNamesTool: 空时 output 也给占位符 hint', async () => {
  const { tools } = setup();
  const [, , list] = tools;
  const r = await list.execute({});
  assert.match(r.output ?? '', /No credentials/);
  // 空时也要让 LLM 看到正确用法(避免误读为"系统坏了")
  assert.match(r.output ?? '', /placeholder/);
});

test('listCredentialNamesTool: description 含占位符语法 + prefix 防误用提示', () => {
  const { tools } = setup();
  const [, , list] = tools;
  const desc = list.description;
  assert.match(desc, /\{<name>\}/);
  assert.match(desc, /prefix/);
  assert.match(desc, /placeholder/);
});

test('schema:三个工具都 capability=write/read + domain=self', () => {
  const { tools } = setup();
  const [save, remove, list] = tools;
  assert.equal(save.domain, 'self');
  assert.equal(save.capability, 'write');
  assert.equal(remove.domain, 'self');
  assert.equal(remove.capability, 'write');
  assert.equal(list.domain, 'self');
  assert.equal(list.capability, 'read');
});
