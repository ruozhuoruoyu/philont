/**
 * Cross-channel media registry + sessionId-based 路由 + ALS turn context 单元测试。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetMediaChannelsForTest,
  findMediaChannel,
  listRegisteredMediaChannels,
  registerMediaChannel,
  unregisterMediaChannel,
  type MediaChannel,
  type SendMediaArgs,
} from '../src/channels/registry.js';
import {
  currentSessionId,
  runInTurnContext,
} from '../src/channels/turn_context.js';

beforeEach(() => {
  _resetMediaChannelsForTest();
});

function fakeChannel(name: string, prefix: string): MediaChannel & { sent: SendMediaArgs[] } {
  const sent: SendMediaArgs[] = [];
  const ch: MediaChannel & { sent: SendMediaArgs[] } = {
    name,
    sent,
    matches: (sid) => sid.startsWith(prefix),
    async send(_sid, args) {
      sent.push(args);
      return { messageId: `${name}-${sent.length}` };
    },
  };
  return ch;
}

test('registry: register / find by sessionId pattern', () => {
  const wx = fakeChannel('wechat:acct1', 'wechat:acct1:');
  registerMediaChannel(wx);

  const got = findMediaChannel('wechat:acct1:user-x');
  assert.equal(got, wx);

  // 不命中 → null(典型:web-ui sid 是随机串)
  assert.equal(findMediaChannel('plain-ws-sid'), null);
  // 跨账户 → 不命中
  assert.equal(findMediaChannel('wechat:acct2:user-x'), null);
});

test('registry: 多 channel 按注册顺序匹配,第一个命中即停', () => {
  const a = fakeChannel('a', 'wechat:');
  const b = fakeChannel('b', 'wechat:'); // 同前缀,本不该,但用于验证 first-wins
  registerMediaChannel(a);
  registerMediaChannel(b);
  assert.equal(findMediaChannel('wechat:x:y'), a);
});

test('registry: unregister 移除',  () => {
  const wx = fakeChannel('wechat:acct1', 'wechat:acct1:');
  registerMediaChannel(wx);
  unregisterMediaChannel(wx);
  assert.equal(findMediaChannel('wechat:acct1:user-x'), null);
});

test('registry: listRegisteredMediaChannels 反映注册状态', () => {
  registerMediaChannel(fakeChannel('a', 'a:'));
  registerMediaChannel(fakeChannel('b', 'b:'));
  assert.deepEqual(listRegisteredMediaChannels().sort(), ['a', 'b']);
});

// ── ALS turn context ──────────────────────────────────────────

test('turn_context: 默认未进 scope 时 currentSessionId() = null', () => {
  assert.equal(currentSessionId(), null);
});

test('turn_context: runInTurnContext 内深嵌异步代码可读到 sessionId', async () => {
  const captured: (string | null)[] = [];

  await runInTurnContext('sid-A', async () => {
    captured.push(currentSessionId());
    await Promise.resolve(); // 跨一个 microtask
    captured.push(currentSessionId());
    // 嵌套异步函数
    await (async () => {
      await Promise.resolve();
      captured.push(currentSessionId());
    })();
  });

  // scope 出去后回到 null
  captured.push(currentSessionId());
  assert.deepEqual(captured, ['sid-A', 'sid-A', 'sid-A', null]);
});

test('turn_context: 不同 sid 的 scope 互不干扰(嵌套)', async () => {
  let inner: string | null = null;
  let backToOuter: string | null = null;
  await runInTurnContext('outer', async () => {
    await runInTurnContext('inner', async () => {
      inner = currentSessionId();
    });
    backToOuter = currentSessionId();
  });
  assert.equal(inner, 'inner');
  assert.equal(backToOuter, 'outer');
});

test('turn_context: parallel runInTurnContext 并发互不串味', async () => {
  const captured: Record<string, string[]> = {};
  const run = async (sid: string) => {
    captured[sid] = [];
    captured[sid].push(currentSessionId() ?? '');
    await new Promise((r) => setTimeout(r, 5));
    captured[sid].push(currentSessionId() ?? '');
  };
  await Promise.all([
    runInTurnContext('A', () => run('A')),
    runInTurnContext('B', () => run('B')),
  ]);
  assert.deepEqual(captured['A'], ['A', 'A']);
  assert.deepEqual(captured['B'], ['B', 'B']);
});
