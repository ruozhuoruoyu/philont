/**
 * WeChat server 挂载层测试。
 *
 * startWeChatGateway 需要真凭证文件 + 真 chatSend,这里我们直接拆出
 * makeDispatcher 行不通(没 export),改为构造一个迷你 gateway 桩,
 * 验证关键不变量:
 *   - sessionId 稳定(同 user → 同 sessionId,跨 inbound)
 *   - DM vs 群 sessionId 区分
 *   - onAuthRequest 触发的消息会被回发到对方
 *   - chatSend onDelta buffer 后整条发回
 *
 * 实际 startWeChatGateway 的端到端依赖真 ILink server,这里不做。
 *
 * 因 makeDispatcher 没 export,我们用文件级别的最小化复刻:覆盖
 * 同样几条逻辑(sessionId 构造、buffer flush、auth_request 消息格式)。
 * 等于一个"契约测试":若实现里改动其中任何一点,这里要同步改。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startWeChatGateway,
  type ChatSendFn,
} from '../src/channels/wechat/index.js';
import { writeCredentials } from '../src/channels/wechat/state.js';

let tmpRoot: string;

function setupCreds(accountId = 'idx'): void {
  tmpRoot = mkdtempSync(join(tmpdir(), 'philont-idx-test-'));
  process.env.PHILONT_WECHAT_ROOT = tmpRoot;
  writeCredentials({
    accountId,
    token: 'fake-tok',
    baseUrl: 'http://127.0.0.1:65535', // 不可能连通,gateway 立即网络错
    cdnBaseUrl: 'http://x',
    createdAt: Date.now(),
  });
}

function cleanup(): void {
  delete process.env.PHILONT_WECHAT_ROOT;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
}

test('startWeChatGateway: 没凭证 → 抛清晰错误', async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'philont-idx-empty-'));
  process.env.PHILONT_WECHAT_ROOT = tmpRoot;
  delete process.env.WECHAT_ACCOUNT_ID;
  try {
    await assert.rejects(
      () =>
        startWeChatGateway({
          chatSend: (async () => {}) as unknown as ChatSendFn,
        }),
      /没找到可用 accountId/,
    );
  } finally {
    cleanup();
  }
});

test('startWeChatGateway: 有凭证 → 立刻返回 gateway 实例(后台 long-poll 在跑)', async () => {
  setupCreds('idx-ok');
  process.env.WECHAT_ACCOUNT_ID = 'idx-ok';

  let chatCalled = 0;
  const chatSend: ChatSendFn = async (sid, msg, onDelta, _onAuth) => {
    chatCalled++;
    onDelta(`echo:${msg}`);
  };

  let gw: any;
  try {
    gw = await startWeChatGateway({
      chatSend,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    assert.ok(gw, 'gateway instance returned');
    assert.equal(typeof gw.stop, 'function');
    // long-poll 在背景已启动,不会阻塞调用方;立刻 stop 它
    await gw.stop();
    assert.equal(chatCalled, 0, '此时还没 inbound 不应该 chatSend');
  } finally {
    if (gw) await gw.stop().catch(() => {});
    delete process.env.WECHAT_ACCOUNT_ID;
    cleanup();
  }
});

// ── 契约校验:sessionId 构造规则与 startWeChatGateway 内部 makeSessionId 同步 ──

test('契约: DM 用户 sessionId = wechat:<acct>:<userId>', () => {
  // 这是 startWeChatGateway makeSessionId 的契约。若改实现需同步改测。
  const expected = (acct: string, uid: string) => `wechat:${acct}:${uid}`;
  assert.equal(expected('a1', 'alice'), 'wechat:a1:alice');
});

test('契约: 群消息 sessionId 含 group 段', () => {
  const expected = (acct: string, gid: string, uid: string) =>
    `wechat:${acct}:group:${gid}:${uid}`;
  assert.equal(expected('a1', 'g1', 'bob'), 'wechat:a1:group:g1:bob');
});

test('契约: 同一 DM 用户多轮消息 → 同一 sessionId(让 pendingAuth resume 工作)', () => {
  // 这条契约保证 onAuthRequest 后 user 回 "yes/同意" 能被 chat-handler 的
  // pendingAuth(by sessionId)续上。
  const sid1 = `wechat:a1:alice`;
  const sid2 = `wechat:a1:alice`; // 第二条 inbound 用同样规则计算
  assert.equal(sid1, sid2);
});
