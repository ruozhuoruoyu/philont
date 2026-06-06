import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseFrames, SseTransport } from '../src/transport/sse.js';

describe('parseSseFrames', () => {
  it('解析 endpoint 事件', () => {
    const { events, rest } = parseSseFrames('event: endpoint\ndata: /messages?s=abc\n\n');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { event: 'endpoint', data: '/messages?s=abc' });
    assert.equal(rest, '');
  });

  it('默认 event=message,data 为 JSON', () => {
    const { events } = parseSseFrames('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    assert.equal(events[0].event, 'message');
    assert.equal(events[0].data, '{"jsonrpc":"2.0","id":1,"result":{}}');
  });

  it('多行 data 拼接', () => {
    const { events } = parseSseFrames('data: line1\ndata: line2\n\n');
    assert.equal(events[0].data, 'line1\nline2');
  });

  it('保留不完整尾帧到 rest', () => {
    const { events, rest } = parseSseFrames('data: a\n\ndata: incomplete');
    assert.equal(events.length, 1);
    assert.equal(rest, 'data: incomplete');
  });

  it('忽略注释 / id / retry 行', () => {
    const { events } = parseSseFrames(': keep-alive\nid: 7\nretry: 1000\nevent: message\ndata: x\n\n');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { event: 'message', data: 'x' });
  });

  it('CRLF 换行也支持', () => {
    const { events } = parseSseFrames('event: endpoint\r\ndata: /m\r\n\r\n');
    assert.deepEqual(events[0], { event: 'endpoint', data: '/m' });
  });
});

describe('SseTransport 健壮性', () => {
  it('连接不可达端点时 connect() reject,而非 crash', async () => {
    // 端口 1 几乎必然 ECONNREFUSED,快速失败。
    const t = new SseTransport({ transport: 'sse', url: 'http://127.0.0.1:1/sse' }, 2000);
    await assert.rejects(() => t.connect());
    await t.close();
  });
});
