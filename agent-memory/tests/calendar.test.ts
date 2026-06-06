/**
 * Phase 6:CalendarStore 测试(含 RRULE 展开)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

const DAY = 86_400_000;

test('create requires timezone', () => {
  const { calendar } = openMemoryDb(':memory:');
  assert.throws(
    () => calendar.create({ title: '会议', startsAt: 1000, timezone: '' }),
    /timezone/
  );
});

test('create + get + delete 基本 CRUD', () => {
  const { calendar } = openMemoryDb(':memory:');
  const e = calendar.create({
    title: '周会',
    startsAt: Date.parse('2026-04-20T09:00:00Z'),
    timezone: 'Asia/Shanghai',
  });

  const got = calendar.get(e.id);
  assert.ok(got);
  assert.equal(got.title, '周会');
  assert.equal(got.timezone, 'Asia/Shanghai');

  assert.ok(calendar.delete(e.id));
  assert.equal(calendar.get(e.id), null);
});

test('ends_at must be >= starts_at', () => {
  const { calendar } = openMemoryDb(':memory:');
  assert.throws(
    () =>
      calendar.create({
        title: '',
        startsAt: 2000,
        endsAt: 1000,
        timezone: 'UTC',
      }),
    /ends_at/
  );
});

test('listBetween: one-shot event inside window', () => {
  const { calendar } = openMemoryDb(':memory:');
  const t = Date.parse('2026-04-20T09:00:00Z');
  calendar.create({ title: 'A', startsAt: t, timezone: 'UTC' });
  calendar.create({ title: 'B', startsAt: t + 10 * DAY, timezone: 'UTC' });

  const hits = calendar.listBetween(t - DAY, t + 5 * DAY);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'A');
  assert.equal(hits[0].occurrenceStartsAt, t);
});

test('listBetween: RRULE FREQ=DAILY 展开窗口内 7 次', () => {
  const { calendar } = openMemoryDb(':memory:');
  const start = Date.parse('2026-04-01T09:00:00Z');
  calendar.create({
    title: '每日站会',
    startsAt: start,
    rrule: 'FREQ=DAILY',
    timezone: 'UTC',
  });

  const hits = calendar.listBetween(start, start + 6 * DAY + 3600_000);
  assert.equal(hits.length, 7);
  assert.equal(hits[0].occurrenceStartsAt, start);
  assert.equal(hits[6].occurrenceStartsAt, start + 6 * DAY);
});

test('listBetween: RRULE FREQ=WEEKLY;INTERVAL=2 间隔两周', () => {
  const { calendar } = openMemoryDb(':memory:');
  const start = Date.parse('2026-04-01T09:00:00Z');
  calendar.create({
    title: '双周 review',
    startsAt: start,
    rrule: 'FREQ=WEEKLY;INTERVAL=2',
    timezone: 'UTC',
  });

  const hits = calendar.listBetween(start, start + 60 * DAY);
  // 60/14 ≈ 4.3 → 5 次(含起点)
  assert.equal(hits.length, 5);
});

test('listBetween: RRULE COUNT 限制次数', () => {
  const { calendar } = openMemoryDb(':memory:');
  const start = Date.parse('2026-04-01T09:00:00Z');
  calendar.create({
    title: '3 次打卡',
    startsAt: start,
    rrule: 'FREQ=DAILY;COUNT=3',
    timezone: 'UTC',
  });

  const hits = calendar.listBetween(start, start + 100 * DAY);
  assert.equal(hits.length, 3);
});

test('listBetween: RRULE UNTIL 截止', () => {
  const { calendar } = openMemoryDb(':memory:');
  const start = Date.parse('2026-04-01T09:00:00Z');
  calendar.create({
    title: '到月底',
    startsAt: start,
    rrule: 'FREQ=DAILY;UNTIL=20260405T090000Z',
    timezone: 'UTC',
  });

  const hits = calendar.listBetween(start, start + 100 * DAY);
  // 4月1,2,3,4,5 → 5 次
  assert.equal(hits.length, 5);
});

test('findByExternalRef 去重外部同步', () => {
  const { calendar } = openMemoryDb(':memory:');
  calendar.create({
    title: 'GCal 同步',
    startsAt: 1000,
    timezone: 'UTC',
    externalRef: 'gcal:xyz123',
  });

  const hit = calendar.findByExternalRef('gcal:xyz123');
  assert.ok(hit);
  assert.equal(hit.title, 'GCal 同步');

  assert.equal(calendar.findByExternalRef('nonexistent'), null);
});

test('upcoming 默认 7 天窗口', () => {
  const { calendar } = openMemoryDb(':memory:');
  const now = Date.now();
  calendar.create({ title: '近期', startsAt: now + DAY, timezone: 'UTC' });
  calendar.create({ title: '远期', startsAt: now + 10 * DAY, timezone: 'UTC' });

  const up = calendar.upcoming(7 * DAY, now);
  assert.equal(up.length, 1);
  assert.equal(up[0].title, '近期');
});
