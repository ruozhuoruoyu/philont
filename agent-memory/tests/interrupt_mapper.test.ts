/**
 * InterruptMapper 单元测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InterruptMapper,
  type InterruptControllerLike,
  type FireRecord,
} from '../src/signals/interrupt_mapper.js';

interface Captured {
  severity: 'critical' | 'high' | 'normal' | 'low';
  signalType: string;
  payload: string | undefined;
}

function mkController(): { ctrl: InterruptControllerLike; sent: Captured[] } {
  const sent: Captured[] = [];
  const ctrl: InterruptControllerLike = {
    sendCritical: (s) => sent.push({ severity: 'critical', signalType: s.signalType, payload: s.payload }),
    sendHigh:     (s) => sent.push({ severity: 'high',     signalType: s.signalType, payload: s.payload }),
    sendNormal:   (s) => sent.push({ severity: 'normal',   signalType: s.signalType, payload: s.payload }),
    sendLow:      (s) => sent.push({ severity: 'low',      signalType: s.signalType, payload: s.payload }),
  };
  return { ctrl, sent };
}

function mkClock(initial = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

test('mapper: 信号跨 NORMAL → fire 一次 normal', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now });

  m.tick({ commitment_pressure: 0.5 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].severity, 'normal');
  assert.equal(m.getActiveLevels().commitment_pressure, 'NORMAL');
});

test('mapper: 同 level 持平 → 不重复 fire', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now });

  m.tick({ commitment_pressure: 0.5 });
  m.tick({ commitment_pressure: 0.55 });
  m.tick({ commitment_pressure: 0.6 });

  assert.equal(sent.length, 1, '同 NORMAL 内不该再 fire');
});

test('mapper: 升级 NORMAL → HIGH → CRITICAL 各 fire 一次', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now, cooldownMs: 0 });

  m.tick({ commitment_pressure: 0.5 });   // → NORMAL
  m.tick({ commitment_pressure: 0.75 });  // → HIGH
  m.tick({ commitment_pressure: 0.95 });  // → CRITICAL

  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((s) => s.severity), ['normal', 'high', 'critical']);
});

test('mapper: cooldown 内升级被压制', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now, cooldownMs: 30_000 });

  m.tick({ commitment_pressure: 0.5 });   // → NORMAL,fire
  clock.advance(10_000);                   // 仅过 10s
  m.tick({ commitment_pressure: 0.95 });  // 想 → CRITICAL,但 cooldown 内

  assert.equal(sent.length, 1);
  // level 内部已更新到 CRITICAL,只是没 fire(等下次跨阈值或 cooldown 过)
  assert.equal(m.getActiveLevels().commitment_pressure, 'CRITICAL');

  clock.advance(30_000);                   // cooldown 过
  m.tick({ commitment_pressure: 0.95 });  // 持平 CRITICAL → 不 fire(同 level 不重)
  assert.equal(sent.length, 1);
});

test('mapper: hysteresis 防止边缘 ping-pong', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, {
    clock: clock.now,
    cooldownMs: 0,
    hysteresisDelta: 0.15,
  });

  m.tick({ commitment_pressure: 0.75 });  // → HIGH(跨 0.7),fire
  assert.equal(sent.length, 1);

  // 跌到 0.65,但没低于 (0.7 - 0.15) = 0.55,所以**保持 HIGH**
  m.tick({ commitment_pressure: 0.65 });
  assert.equal(m.getActiveLevels().commitment_pressure, 'HIGH');
  assert.equal(sent.length, 1, '不该 fire(降级静默)');

  // 升回 0.75,持平 HIGH,不 fire
  m.tick({ commitment_pressure: 0.75 });
  assert.equal(sent.length, 1, '持平 HIGH,不该 fire');

  // 跌到 0.50,低于 dropFrom(0.7)=0.55 → 降到 NORMAL(>= 0.4),不 fire(降级)
  m.tick({ commitment_pressure: 0.50 });
  assert.equal(m.getActiveLevels().commitment_pressure, 'NORMAL');
  assert.equal(sent.length, 1);

  // 升回 0.75 → NORMAL → HIGH,升级,fire
  m.tick({ commitment_pressure: 0.75 });
  assert.equal(sent.length, 2);
});

test('mapper: 多信号同时跨阈值 → 各自 fire', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now, cooldownMs: 0 });

  m.tick({
    commitment_pressure: 0.75,
    service_dormancy: 0.92,
  });

  assert.equal(sent.length, 2);
  const sigTypes = sent.map((s) => s.signalType).sort();
  // commitment_pressure HIGH → IdentityThreat;service_dormancy CRITICAL → BoredomThreshold
  assert.deepEqual(sigTypes, ['BoredomThreshold', 'IdentityThreat']);
});

test('mapper: signalTypeForLevel 给 service_dormancy 打 BoredomThreshold tag', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now });

  m.tick({ service_dormancy: 0.95 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].severity, 'critical');
  assert.equal(sent[0].signalType, 'BoredomThreshold');
  assert.ok(sent[0].payload?.includes('service_dormancy'));
});

test('mapper: getLastFires 返回最近一轮 fire 记录', () => {
  const { ctrl } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now, cooldownMs: 0 });

  m.tick({ a: 0.5, b: 0.95 });
  const fires: ReadonlyArray<FireRecord> = m.getLastFires();
  assert.equal(fires.length, 2);
  assert.deepEqual(fires.map((f) => f.signal).sort(), ['a', 'b']);
  // 第二轮无新触发
  m.tick({ a: 0.5, b: 0.95 });
  assert.equal(m.getLastFires().length, 0);
});

test('mapper: broadcast=false 不调 controller,但仍返回 fire 记录', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now });

  const fires = m.tick({ commitment_pressure: 0.75 }, { broadcast: false });
  // controller 不该被调
  assert.equal(sent.length, 0);
  // 但 return 值有
  assert.equal(fires.length, 1);
  assert.equal(fires[0].level, 'HIGH');
  // state 仍然更新(下次 tick 视为持平)
  assert.equal(m.getActiveLevels().commitment_pressure, 'HIGH');

  // 后续以 broadcast=true tick,持平不 fire(state 已是 HIGH)
  m.tick({ commitment_pressure: 0.75 });
  assert.equal(sent.length, 0);
});

test('mapper: reset 清空状态,后续可重新 fire', () => {
  const { ctrl, sent } = mkController();
  const clock = mkClock();
  const m = new InterruptMapper(ctrl, { clock: clock.now });

  m.tick({ x: 0.5 });
  assert.equal(sent.length, 1);
  m.tick({ x: 0.5 });
  assert.equal(sent.length, 1);

  m.reset();
  m.tick({ x: 0.5 });
  assert.equal(sent.length, 2, 'reset 后能重新 fire');
});
