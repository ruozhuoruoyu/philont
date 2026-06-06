/**
 * WeChat 凭证 / 状态持久化层单元测试。
 *
 * 用 PHILONT_WECHAT_ROOT 环境变量重定向到临时目录,不污染用户 home。
 * 每个 test 前 mkdtemp 新目录,后清理。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

// 必须在 import state.ts 前 set env,因为 state 用 process.env 一次解析
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'philont-wechat-test-'));
  process.env.PHILONT_WECHAT_ROOT = tmpRoot;
});

afterEach(() => {
  delete process.env.PHILONT_WECHAT_ROOT;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// 动态 import 让每个 test 拿到 fresh env
async function loadState() {
  // dynamic import 避免 ESM 缓存导致 env 不生效;node test runner 每个 file 一个 module 缓存
  return await import('../src/channels/wechat/state.js');
}

test('isValidAccountId 拒绝路径穿越 / 空 / 过长', async () => {
  const s = await loadState();
  // 合法
  assert.equal(s.isValidAccountId('alice'), true);
  assert.equal(s.isValidAccountId('alice_123.dev-team'), true);
  // iLink user_id 形如 wxid@im.wechat,必须放行
  assert.equal(s.isValidAccountId('o9cq801SI55LNCfpPkrmkUwB0hlU@im.wechat'), true);
  assert.equal(s.isValidAccountId('user+tag@example'), true);
  // 非法
  assert.equal(s.isValidAccountId(''), false);
  assert.equal(s.isValidAccountId('../etc/passwd'), false);
  assert.equal(s.isValidAccountId('a/b'), false);
  assert.equal(s.isValidAccountId('a\\b'), false);
  assert.equal(s.isValidAccountId('.'), false);
  assert.equal(s.isValidAccountId('..'), false);
  assert.equal(s.isValidAccountId('a'.repeat(129)), false); // 129 chars
  assert.equal(s.isValidAccountId(123 as any), false);
  assert.equal(s.isValidAccountId(null as any), false);
});

test('writeCredentials + readCredentials round-trip', async () => {
  const s = await loadState();
  const creds = {
    accountId: 'alice',
    token: 'sk-test-token-1234',
    baseUrl: s.DEFAULT_BASE_URL,
    cdnBaseUrl: s.DEFAULT_CDN_BASE_URL,
    createdAt: 1700000000000,
  };
  s.writeCredentials(creds);
  const got = s.readCredentials('alice');
  assert.deepEqual(got, creds);
});

test('readCredentials 不存在返回 null,损坏 JSON 也返回 null', async () => {
  const s = await loadState();
  assert.equal(s.readCredentials('nobody'), null);

  // 写一份损坏 JSON
  const dir = s.getAccountDir('corrupt');
  // 调 writeCredentials 先建目录(会写一份合法的)
  s.writeCredentials({
    accountId: 'corrupt',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  writeFileSync(join(dir, 'credentials.json'), '{ this is not json');
  assert.equal(s.readCredentials('corrupt'), null);
});

test('writeCredentials 拒绝非法 accountId', async () => {
  const s = await loadState();
  assert.throws(() =>
    s.writeCredentials({
      accountId: '../escape',
      token: 't',
      baseUrl: 'b',
      cdnBaseUrl: 'c',
      createdAt: 0,
    }),
  );
});

test('credentials.json 在 POSIX 下应有 0o600 权限', async () => {
  const s = await loadState();
  s.writeCredentials({
    accountId: 'perm-check',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  const path = join(s.getAccountDir('perm-check'), 'credentials.json');
  const mode = statSync(path).mode & 0o777;
  if (platform() !== 'win32') {
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  }
});

test('listAccounts 列出已建目录,过滤非法名', async () => {
  const s = await loadState();
  assert.deepEqual(s.listAccounts(), []);
  s.writeCredentials({
    accountId: 'alice',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  s.writeCredentials({
    accountId: 'bob',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  const list = s.listAccounts().sort();
  assert.deepEqual(list, ['alice', 'bob']);
});

test('deleteAccount 删除全部本地文件', async () => {
  const s = await loadState();
  s.writeCredentials({
    accountId: 'tmp',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  s.writeContextTokens('tmp', { cursor: 'x' });
  assert.equal(s.readCredentials('tmp')?.accountId, 'tmp');
  s.deleteAccount('tmp');
  assert.equal(s.readCredentials('tmp'), null);
  assert.equal(s.readContextTokens('tmp'), null);
  assert.equal(existsSync(s.getAccountDir('tmp')), false);
});

test('writeContextTokens + readContextTokens round-trip', async () => {
  const s = await loadState();
  s.writeCredentials({
    accountId: 'ctx',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  s.writeContextTokens('ctx', { cursor: 'sync_cursor_123', last: 42 });
  assert.deepEqual(s.readContextTokens('ctx'), { cursor: 'sync_cursor_123', last: 42 });
});

test('acquireLock 第一次成功 → null, 第二次返回 existing info', async () => {
  const s = await loadState();
  s.writeCredentials({
    accountId: 'lock1',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  const r1 = s.acquireLock('lock1', 'host-a');
  assert.equal(r1, null, 'first acquire should succeed');

  const r2 = s.acquireLock('lock1', 'host-b');
  assert.notEqual(r2, null, 'second acquire within 60s should see existing');
  assert.equal(r2?.pid, process.pid);
});

test('releaseLock 后可以再 acquire', async () => {
  const s = await loadState();
  s.writeCredentials({
    accountId: 'lock2',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  s.acquireLock('lock2');
  s.releaseLock('lock2');
  const r = s.acquireLock('lock2');
  assert.equal(r, null, 'after release should be acquirable');
});

test('60s+ 老 lock 自动过期允许接管', async () => {
  const s = await loadState();
  s.writeCredentials({
    accountId: 'stale',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  // 手写一个 75s 前的 lock
  const lockPath = join(s.getAccountDir('stale'), '.lock');
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 99999, startedAt: Date.now() - 75_000, hostname: 'old' }),
  );
  const r = s.acquireLock('stale');
  assert.equal(r, null, 'stale lock should be ignored');
  // 写入了我们的新 info
  const fresh = JSON.parse(readFileSync(lockPath, 'utf-8'));
  assert.equal(fresh.pid, process.pid);
});

test('resolveDefaultAccountId:env 优先,其次唯一账户,多账户返回 null', async () => {
  const s = await loadState();

  // 0 个账户 + 无 env → null
  delete process.env.WECHAT_ACCOUNT_ID;
  assert.equal(s.resolveDefaultAccountId(), null);

  // 1 个账户 + 无 env → 那个账户
  s.writeCredentials({
    accountId: 'only',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  assert.equal(s.resolveDefaultAccountId(), 'only');

  // 多账户 + 无 env → null(让调用方决定)
  s.writeCredentials({
    accountId: 'second',
    token: 't',
    baseUrl: 'b',
    cdnBaseUrl: 'c',
    createdAt: 0,
  });
  assert.equal(s.resolveDefaultAccountId(), null);

  // env 显式指定 → 即使多账户也以 env 为准
  process.env.WECHAT_ACCOUNT_ID = 'second';
  assert.equal(s.resolveDefaultAccountId(), 'second');

  // env 非法 → null
  process.env.WECHAT_ACCOUNT_ID = '../escape';
  assert.equal(s.resolveDefaultAccountId(), null);

  delete process.env.WECHAT_ACCOUNT_ID;
});
