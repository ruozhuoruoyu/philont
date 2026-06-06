/**
 * Soul 闭环集成测试(v7):把 Phase A + B + D 的构件串起来。
 *
 * 覆盖"learn → adapt"闭环的一整轮:
 *   1. 启动:bootstrap root 存在 + constitution hash 落 audit
 *   2. Extractor 从会话里归纳出 shadow pursuit(origin=extractor,Internal)
 *   3. 注册一个声明式 drive_config(active 态,带 cooldownMs 参数)
 *   4. 模拟 drive 若干次触发:append outcome(含 pursuit progress / fact delta /
 *      空转等不同信号)
 *   5. 跑 DriveReflector:scoreOutcome 回填、EWMA 合并、在 constitution.driveBounds
 *      内调 cooldownMs
 *   6. 验证 audit 链 + DB 终态
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import { PursuitStore, loadConstitution } from '../src/pursuit.js';
import { DriveConfigStore } from '../src/drive_config.js';
import { DriveOutcomeStore } from '../src/drive_outcome.js';
import { SessionPursuitExtractor } from '../src/pursuit_extractor.js';
import { SessionDriveReflector } from '../src/drive_reflector.js';
import { RawStore } from '../src/raw.js';
import { InMemoryAuditHook } from '../src/audit.js';
import type { ExtractorLlmClient } from '../src/extractor.js';

test('Soul loop: bootstrap → extractor → drive outcomes → reflector(整条闭环跑通)', async () => {
  // ── Phase A: bootstrap + constitution ────────────────────────────────
  const db = new Database(':memory:');
  initSchema(db);

  const pursuits = new PursuitStore(db);
  const driveConfigs = new DriveConfigStore(db);
  const driveOutcomes = new DriveOutcomeStore(db);
  const raw = new RawStore(db);
  const audit = new InMemoryAuditHook();

  // bootstrap root 存在
  const root = pursuits.getDefaultRoot();
  assert.ok(root);
  assert.equal(root!.id, BOOTSTRAP_ROOT_PURSUIT_ID);
  assert.equal(root!.isEvergreen, true);

  // 设 constitution(values + drive_bounds),触发 load → audit
  pursuits.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, {
    values: '诚实高于有用',
    redLines: ['不伪造用户身份'],
    driveBounds: { openLoop: { cooldownMs: [10_000, 3_600_000] } },
  });
  const loaded = loadConstitution(
    pursuits,
    BOOTSTRAP_ROOT_PURSUIT_ID,
    audit,
  );
  assert.equal(loaded.hash.length, 64);
  const loadEvents = audit.events.filter((e) => e.type === 'constitution_load');
  assert.equal(loadEvents.length, 1);
  assert.equal(loadEvents[0].data.origin, 'Internal');

  // ── Phase D.1: extractor 从会话里提议 shadow pursuit ─────────────────
  const extractorLlm: ExtractorLlmClient = {
    async complete() {
      return {
        text: JSON.stringify([
          {
            action: 'propose_pursuit',
            title: '理解用户头疼模式',
            intent: '跨会话识别诱因',
            open_questions: ['频率?', '诱因?'],
            stake: 'medium',
          },
        ]),
        tokensUsed: 80,
      };
    },
  };
  const pursuitExtractor = new SessionPursuitExtractor(
    extractorLlm,
    pursuits,
    raw,
    { auditHook: audit, rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
  );

  const sid = 'sess-1';
  raw.startSession(sid);
  for (const [role, content] of [
    ['user', '最近老头疼'],
    ['assistant', '频率呢?'],
    ['user', '几乎每天下午'],
    ['assistant', '压力大吗?'],
    ['user', '工作比较赶'],
  ] as const) {
    raw.appendMessage({ sessionId: sid, role, content });
  }

  const extractResult = await pursuitExtractor.extractFromSession(sid);
  assert.equal(extractResult.pursuitsProposed, 1);
  const shadowPursuit = extractResult.pursuits[0];
  assert.equal(shadowPursuit.status, 'shadow');
  assert.equal(shadowPursuit.origin, 'extractor');

  // ── Phase B.1: 注册声明式 drive_config ───────────────────────────────
  const drive = driveConfigs.create({
    id: 'open-loop-v1',
    kind: 'openLoop',
    status: 'active',
    triggerExpr: { op: 'unclosed_question' },
    actionTemplate: { type: 'inject_message' },
    params: { cooldownMs: 60_000 },
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });
  assert.equal(drive.effectiveness.samples, 0);

  // ── Phase B.2: 模拟 6 次 drive 触发,outcome 全部为"空转"(低效) ────
  for (let i = 0; i < 6; i++) {
    driveOutcomes.append({
      driveId: drive.id,
      triggerSnapshot: { iteration: i },
      injectedAction: { text: 'follow up?' },
      memoryDelta: {},
      servedPursuitId: null, // 故意空转
      rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    });
  }
  assert.equal(
    driveOutcomes.listUnscored(BOOTSTRAP_ROOT_PURSUIT_ID).length,
    6
  );

  // ── Phase D.2 + D.3: reflector 打分 → EWMA → bounds 内调参 ───────────
  const reflector = new SessionDriveReflector(
    driveOutcomes,
    driveConfigs,
    pursuits,
    { auditHook: audit, rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
  );
  const r = await reflector.reflect();
  assert.equal(r.outcomesScored, 6);
  assert.equal(r.driveEwmaUpdated, 1);
  // 6 次全为空转(-0.3) → EWMA ≤ -0.3 → cooldown 翻倍
  assert.equal(r.driveParamsTuned, 1);

  const tunedDrive = driveConfigs.get(drive.id)!;
  assert.equal(tunedDrive.params.cooldownMs, 120_000);
  assert.equal(tunedDrive.effectiveness.samples, 6);
  assert.ok(tunedDrive.effectiveness.ewma <= -0.3);

  // unscored 队列清空
  assert.equal(
    driveOutcomes.listUnscored(BOOTSTRAP_ROOT_PURSUIT_ID).length,
    0
  );

  // ── audit 链体检 ───────────────────────────────────────────────────
  const scoreEvents = audit.events.filter(
    (e) => e.data.source === 'drive_reflector' && e.data.toolName === 'score_outcome'
  );
  assert.equal(scoreEvents.length, 6);
  const tuneEvents = audit.events.filter(
    (e) => e.data.source === 'drive_reflector' && e.data.toolName === 'tune_drive_param'
  );
  assert.equal(tuneEvents.length, 1);
  assert.equal(tuneEvents[0].data.oldValue, 60_000);
  assert.equal(tuneEvents[0].data.newValue, 120_000);

  // pursuit extractor 也落了一条 audit
  const pursuitEvents = audit.events.filter(
    (e) => e.data.source === 'extractor' && e.data.toolName === 'create_pursuit'
  );
  assert.equal(pursuitEvents.length, 1);
  assert.equal(pursuitEvents[0].data.origin, 'Internal');
  assert.equal(pursuitEvents[0].data.status, 'shadow');
});

test('Soul loop: 好 outcome(pursuit 推进 + fact 沉淀)→ cooldown 被收紧', async () => {
  const db = new Database(':memory:');
  initSchema(db);
  const pursuits = new PursuitStore(db);
  const configs = new DriveConfigStore(db);
  const outcomes = new DriveOutcomeStore(db);
  const reflector = new SessionDriveReflector(outcomes, configs, pursuits);

  pursuits.setConstitution(BOOTSTRAP_ROOT_PURSUIT_ID, {
    driveBounds: { openLoop: { cooldownMs: [10_000, 3_600_000] } },
  });
  const drive = configs.create({
    id: 'x',
    kind: 'openLoop',
    status: 'active',
    triggerExpr: {},
    actionTemplate: {},
    params: { cooldownMs: 60_000 },
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  });

  // 6 次"高效"outcome:progress + fact
  for (let i = 0; i < 6; i++) {
    outcomes.append({
      driveId: drive.id,
      triggerSnapshot: {},
      injectedAction: {},
      memoryDelta: { pursuitProgressMarkers: [`m${i}`], factIds: [`f${i}`] },
      servedPursuitId: 'some-pursuit',
      rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    });
  }

  const r = await reflector.reflect();
  assert.equal(r.outcomesScored, 6);
  assert.equal(r.driveParamsTuned, 1);

  // cooldown 被减半
  assert.equal(configs.get(drive.id)!.params.cooldownMs, 30_000);
});
