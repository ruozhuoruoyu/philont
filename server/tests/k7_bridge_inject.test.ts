/**
 * K7→K8 桥的渲染段单测。
 *
 * 验证 buildK7BridgeReviewSection / buildAutonomousProgressInjection 各自只
 * 取自己的 driver 类别 — 桥 initiative 进"复核段",其他 driver 进"调研段"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, InitiativeStore } from '../../agent-memory/src/index.js';
import {
  buildK7BridgeReviewSection,
  buildAutonomousProgressInjection,
} from '../src/autonomous_progress_inject.js';

function setup() {
  const handle = openMemoryDb(':memory:');
  const store = new InitiativeStore(handle.db);
  return { handle, store };
}

function done(
  store: InitiativeStore,
  driver: string,
  kind: string,
  summary: string,
) {
  const i = store.insert({
    kind,
    driver,
    targetRef: `${driver}:${kind}:${Math.random().toString(36).slice(2, 8)}`,
    rationale: 'r',
    utility: 0.7,
    budgetEstimate: 1000,
  });
  store.markRunning(i.id);
  store.markDone(i.id, summary, { facts: ['f1'], notes: [], pursuits: [] }, 100);
  return i;
}

test('K7 bridge inject: 仅 bridge initiative 出现在复核段', () => {
  const { handle, store } = setup();
  done(store, 'k7-bridge', 'honesty:verify-size', '核对了 /tmp/foo.bin 实际 18 字节');
  done(store, 'gap', 'fact_gap', '查了 fact:foo');

  const review = buildK7BridgeReviewSection(store, { sinceTs: 0, topK: 5 });
  assert.match(review, /## 我自己复核了上一轮的承诺/);
  assert.match(review, /honesty:verify-size/);
  assert.doesNotMatch(review, /fact_gap/);

  const progress = buildAutonomousProgressInjection(store, { sinceTs: 0, topK: 5 });
  assert.match(progress, /## 我自己刚做了什么/);
  assert.match(progress, /fact_gap/);
  assert.doesNotMatch(progress, /honesty:verify-size/);

  handle.close();
});

test('K7 bridge inject: 无任何 done bridge initiative → 复核段空字符串', () => {
  const { handle, store } = setup();
  done(store, 'gap', 'fact_gap', 'just gap');

  const review = buildK7BridgeReviewSection(store, { sinceTs: 0, topK: 5 });
  assert.equal(review, '');

  handle.close();
});

test('K7 bridge inject: sinceTs cutoff 同时作用于两段', () => {
  const { handle, store } = setup();
  done(store, 'k7-bridge', 'honesty:verify-size', 'old bridge');
  done(store, 'gap', 'fact_gap', 'old gap');

  // sinceTs 在未来 → 两段都空
  const review = buildK7BridgeReviewSection(store, { sinceTs: Date.now() + 60_000 });
  const progress = buildAutonomousProgressInjection(store, { sinceTs: Date.now() + 60_000 });
  assert.equal(review, '');
  assert.equal(progress, '');

  handle.close();
});

test('K7 bridge inject: topK 截断各段独立', () => {
  const { handle, store } = setup();
  for (let i = 0; i < 5; i++) {
    done(store, 'k7-bridge', `honesty:verify-size`, `bridge ${i}`);
    done(store, 'gap', 'fact_gap', `gap ${i}`);
  }

  const review = buildK7BridgeReviewSection(store, { sinceTs: 0, topK: 2 });
  const reviewLines = review.split('\n').filter((l) => l.startsWith('-'));
  assert.equal(reviewLines.length, 2);

  const progress = buildAutonomousProgressInjection(store, { sinceTs: 0, topK: 2 });
  const progressLines = progress.split('\n').filter((l) => l.startsWith('-'));
  assert.equal(progressLines.length, 2);

  handle.close();
});

test('K7 bridge inject: 复核段 maxChars 截断', () => {
  const { handle, store } = setup();
  // 制造一个超长 summary
  const longSummary = 'x'.repeat(2000);
  done(store, 'k7-bridge', 'honesty:verify-artifact', longSummary);

  const review = buildK7BridgeReviewSection(store, { sinceTs: 0, topK: 5, maxChars: 200 });
  assert.ok(review.length <= 200 + 20, `length=${review.length}`);
  assert.match(review, /截断/);

  handle.close();
});
