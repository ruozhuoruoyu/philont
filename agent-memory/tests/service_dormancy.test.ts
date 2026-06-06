/**
 * service_dormancy 信号纯函数测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeServiceDormancy } from '../src/signals/service_dormancy.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function approxEq(a: number, b: number, eps = 0.005): void {
  assert.ok(
    Math.abs(a - b) <= eps,
    `expected ${a} ≈ ${b} (eps ${eps}), diff = ${Math.abs(a - b)}`,
  );
}

test('service_dormancy: 没服务过(null) → 0', () => {
  const r = computeServiceDormancy({ lastAssistantTs: null, now: NOW });
  assert.equal(r.dormancy, 0);
  assert.equal(r.hoursSinceLastServe, 0);
  assert.equal(r.lastAssistantTs, null);
});

test('service_dormancy: 0h(刚服务过) → 0', () => {
  const r = computeServiceDormancy({ lastAssistantTs: NOW, now: NOW });
  approxEq(r.dormancy, 0);
  approxEq(r.hoursSinceLastServe, 0);
});

test('service_dormancy: 1h(默认 halfLife=4) → ~0.22', () => {
  const r = computeServiceDormancy({ lastAssistantTs: NOW - 1 * HOUR_MS, now: NOW });
  approxEq(r.dormancy, 0.221, 0.005);
  approxEq(r.hoursSinceLastServe, 1);
});

test('service_dormancy: 4h(= halfLife) → ~0.63', () => {
  const r = computeServiceDormancy({ lastAssistantTs: NOW - 4 * HOUR_MS, now: NOW });
  approxEq(r.dormancy, 0.632, 0.005);
});

test('service_dormancy: 5h → ~0.71(接近 HIGH 阈值)', () => {
  const r = computeServiceDormancy({ lastAssistantTs: NOW - 5 * HOUR_MS, now: NOW });
  approxEq(r.dormancy, 0.713, 0.005);
});

test('service_dormancy: 9h → ~0.90(接近 CRITICAL 阈值)', () => {
  const r = computeServiceDormancy({ lastAssistantTs: NOW - 9 * HOUR_MS, now: NOW });
  approxEq(r.dormancy, 0.895, 0.005);
});

test('service_dormancy: halfLife 旋钮变小 → 同时长更紧迫', () => {
  const at = NOW - 4 * HOUR_MS;
  const r4 = computeServiceDormancy({ lastAssistantTs: at, now: NOW }, { halfLifeHours: 4 });
  const r2 = computeServiceDormancy({ lastAssistantTs: at, now: NOW }, { halfLifeHours: 2 });
  assert.ok(
    r2.dormancy > r4.dormancy,
    `halfLife=2 同 4h 应比 halfLife=4 紧迫:r2=${r2.dormancy} vs r4=${r4.dormancy}`,
  );
  approxEq(r2.dormancy, 0.865, 0.005);
});

test('service_dormancy: 时间戳颠倒(now < ts)→ 钳到 0,不报负值', () => {
  const r = computeServiceDormancy({ lastAssistantTs: NOW + 1000, now: NOW });
  approxEq(r.dormancy, 0);
  approxEq(r.hoursSinceLastServe, 0);
});
