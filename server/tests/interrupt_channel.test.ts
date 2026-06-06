/**
 * 中断通道 TS 替身(2026-05-29 软屏蔽 Rust)单测。
 *
 * 验证替身与 `@agent/node` FFI 的可观测行为对齐:
 *   - send* → 对应 severity 的订阅回调收到正确 snapshot。
 *   - signalType → (kind, payload) 映射精确复刻 Rust js_to_interrupt + from_interrupt
 *     (含未知 signalType → SteerMessage(signalType) 的有损映射)。
 *   - subscribe / unsubscribe 幂等 + 解订后不再收。
 *
 * 纯模块,不 import chat-handler → 不触发后台子系统,可单文件快速跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interruptChannelJs,
  type JsAgentInterruptSnapshot,
} from '../src/interrupt_channel.js';

function collector() {
  const got: JsAgentInterruptSnapshot[] = [];
  return { got, cb: (s: JsAgentInterruptSnapshot) => got.push(s) };
}

test('send* fan-out 到对应 severity 回调,severity 标签正确', () => {
  const { controller } = interruptChannelJs();
  const c = collector(), h = collector(), n = collector(), l = collector();
  controller.subscribe(c.cb, h.cb, n.cb, l.cb);

  controller.sendCritical({ signalType: 'UserHardStop' });
  controller.sendHigh({ signalType: 'IdentityThreat', payload: 'commitment_pressure=0.75 → HIGH' });
  controller.sendNormal({ signalType: 'BoredomThreshold' });
  controller.sendLow({ signalType: 'CuriosityTriggered', payload: 'arxiv:1234' });

  assert.equal(c.got.length, 1);
  assert.equal(h.got.length, 1);
  assert.equal(n.got.length, 1);
  assert.equal(l.got.length, 1);
  assert.equal(c.got[0].severity, 'critical');
  assert.equal(h.got[0].severity, 'high');
  assert.equal(n.got[0].severity, 'normal');
  assert.equal(l.got[0].severity, 'low');
});

test('payload-携带 variant:kind=signalType, payload 保留', () => {
  const { controller } = interruptChannelJs();
  const h = collector();
  controller.subscribe(() => {}, h.cb, () => {}, () => {});
  controller.sendHigh({ signalType: 'IdentityThreat', payload: 'commitment_pressure=0.8 → HIGH' });
  assert.equal(h.got[0].kind, 'IdentityThreat');
  assert.equal(h.got[0].payload, 'commitment_pressure=0.8 → HIGH');
});

test('UserHardStop / BoredomThreshold:payload 归空', () => {
  const { controller } = interruptChannelJs();
  const c = collector(), n = collector();
  controller.subscribe(c.cb, () => {}, n.cb, () => {});
  controller.sendCritical({ signalType: 'UserHardStop', payload: '被忽略' });
  controller.sendNormal({ signalType: 'BoredomThreshold' });
  assert.equal(c.got[0].kind, 'UserHardStop');
  assert.equal(c.got[0].payload, '');
  assert.equal(n.got[0].kind, 'BoredomThreshold');
  assert.equal(n.got[0].payload, '');
});

test('未知 signalType → SteerMessage(signalType),原 payload 丢弃(复刻 Rust 有损映射)', () => {
  const { controller } = interruptChannelJs();
  const h = collector();
  controller.subscribe(() => {}, h.cb, () => {}, () => {});
  // chat-handler autonomous finding 走这条:signalType 非枚举已知 variant。
  controller.sendHigh({ signalType: 'AutonomousFinding', payload: '我研究出了 X' });
  assert.equal(h.got[0].kind, 'SteerMessage');
  assert.equal(h.got[0].payload, 'AutonomousFinding'); // 原 text payload 被丢,与 Rust 一致
});

test('snapshot 含 firedAtMs(number)', () => {
  const { controller } = interruptChannelJs();
  const h = collector();
  controller.subscribe(() => {}, h.cb, () => {}, () => {});
  controller.sendHigh({ signalType: 'SteerMessage', payload: 'x' });
  assert.equal(typeof h.got[0].firedAtMs, 'number');
  assert.ok(h.got[0].firedAtMs > 0);
});

test('unsubscribe 后不再收;幂等', () => {
  const { controller } = interruptChannelJs();
  const h = collector();
  const sub = controller.subscribe(() => {}, h.cb, () => {}, () => {});
  controller.sendHigh({ signalType: 'SteerMessage', payload: 'a' });
  sub.unsubscribe();
  controller.sendHigh({ signalType: 'SteerMessage', payload: 'b' });
  sub.unsubscribe(); // 幂等,不抛
  assert.equal(h.got.length, 1);
  assert.equal(h.got[0].payload, 'a');
});

test('多订阅者各自独立收到', () => {
  const { controller } = interruptChannelJs();
  const a = collector(), b = collector();
  controller.subscribe(() => {}, a.cb, () => {}, () => {});
  controller.subscribe(() => {}, b.cb, () => {}, () => {});
  controller.sendHigh({ signalType: 'SteerMessage', payload: 'x' });
  assert.equal(a.got.length, 1);
  assert.equal(b.got.length, 1);
});

test('回调内抛异常不影响其它订阅者(NonBlocking 容错)', () => {
  const { controller } = interruptChannelJs();
  const b = collector();
  controller.subscribe(() => {}, () => { throw new Error('boom'); }, () => {}, () => {});
  controller.subscribe(() => {}, b.cb, () => {}, () => {});
  assert.doesNotThrow(() => controller.sendHigh({ signalType: 'SteerMessage', payload: 'x' }));
  assert.equal(b.got.length, 1);
});

test('interruptChannelJs 返回 controller + receiver', () => {
  const ch = interruptChannelJs();
  assert.ok(ch.controller);
  assert.ok(ch.receiver);
  assert.equal(typeof ch.controller.sendHigh, 'function');
});
