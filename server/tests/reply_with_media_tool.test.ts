/**
 * replyWithMedia 工具单元测试 —— ALS 上下文 / channel 路由 / 错误降级。
 *
 * 不真用 wechat,用 fake channel 验证:
 *   - 不在 turn scope 调 → 明确报错(no active turn)
 *   - 在 web-ui sid scope 下调 → "no media channel registered" 报错(降级路径)
 *   - 在 wechat sid scope 下调 → channel.send 被命中,参数透传
 *   - kind / path 输入校验
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetMediaChannelsForTest,
  registerMediaChannel,
  type MediaChannel,
  type SendMediaArgs,
} from '../src/channels/registry.js';
import { runInTurnContext } from '../src/channels/turn_context.js';
import { replyWithMediaTool } from '../src/tools/reply_with_media.js';

beforeEach(() => {
  _resetMediaChannelsForTest();
});

function fakeWeChatChannel(): MediaChannel & { sent: SendMediaArgs[] } {
  const sent: SendMediaArgs[] = [];
  const ch: MediaChannel & { sent: SendMediaArgs[] } = {
    name: 'wechat:acct',
    sent,
    matches: (sid) => sid.startsWith('wechat:acct:'),
    async send(_sid, args) {
      sent.push(args);
      return { messageId: 'mm-fake' };
    },
  };
  return ch;
}

test('replyWithMedia: 不在 turn scope 调 → 错(no active turn)', async () => {
  registerMediaChannel(fakeWeChatChannel());
  const r = await replyWithMediaTool.execute({ kind: 'image', path: '/tmp/x.jpg' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /no active turn context/);
});

test('replyWithMedia: web-ui sid(无匹配 channel)→ 明确降级错', async () => {
  registerMediaChannel(fakeWeChatChannel());
  const r = await runInTurnContext('plain-ws-sid', () =>
    replyWithMediaTool.execute({ kind: 'image', path: '/tmp/x.jpg' }),
  );
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /不属于任何支持媒体发送的 channel/);
  // 提示 LLM 改用 writeFile
  assert.match(r.error ?? '', /writeFile/);
});

test('replyWithMedia: wechat sid → channel.send 命中,参数透传', async () => {
  const ch = fakeWeChatChannel();
  registerMediaChannel(ch);
  const r = await runInTurnContext('wechat:acct:user-x', () =>
    replyWithMediaTool.execute({
      kind: 'file',
      path: '/tmp/report.pdf',
      fileName: 'Q3-report.pdf',
    }),
  );
  assert.equal(r.success, true);
  assert.match(r.output, /✓ 已通过 wechat:acct/);
  assert.match(r.output, /messageId=mm-fake/);
  assert.deepEqual(ch.sent[0], {
    kind: 'file',
    path: '/tmp/report.pdf',
    fileName: 'Q3-report.pdf',
  });
});

test('replyWithMedia: 不合法 kind → 错', async () => {
  const r = await runInTurnContext('wechat:acct:user-x', () =>
    replyWithMediaTool.execute({ kind: 'pdf', path: '/tmp/x' }),
  );
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /invalid kind/);
});

test('replyWithMedia: 空 path → 错', async () => {
  const r = await runInTurnContext('wechat:acct:user-x', () =>
    replyWithMediaTool.execute({ kind: 'image', path: '' }),
  );
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /non-empty string/);
});

test('replyWithMedia: channel.send 抛 → 错被包装并返回', async () => {
  const ch: MediaChannel = {
    name: 'wechat:acct',
    matches: (sid) => sid.startsWith('wechat:acct:'),
    async send() {
      throw new Error('upload-cdn-down');
    },
  };
  registerMediaChannel(ch);
  const r = await runInTurnContext('wechat:acct:user-x', () =>
    replyWithMediaTool.execute({ kind: 'image', path: '/tmp/x.jpg' }),
  );
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /upload-cdn-down/);
  assert.match(r.error ?? '', /wechat:acct send failed/);
});

test('replyWithMedia 元数据:domain=network capability=write,4 种 kind', () => {
  assert.equal(replyWithMediaTool.capability, 'write');
  assert.equal(replyWithMediaTool.domain, 'network');
  const enums = (replyWithMediaTool.schema as any).properties.kind.enum;
  assert.deepEqual([...enums].sort(), ['file', 'image', 'video', 'voice']);
  assert.deepEqual([...(replyWithMediaTool.schema as any).required].sort(), ['kind', 'path']);
});
