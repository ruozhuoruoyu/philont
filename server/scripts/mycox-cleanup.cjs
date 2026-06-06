#!/usr/bin/env node
/**
 * mycox onboarding 数据清理工具(2026-05-08)
 *
 * 用途:重新跑 service-onboarding 前清掉旧的 mycox 数据,避免新流程被旧
 * facts / schedules 干扰。
 *
 * 用法(在 server 目录跑):
 *   node scripts/mycox-cleanup.cjs                    # 仅查不删(dry-run)
 *   node scripts/mycox-cleanup.cjs --clean            # 真删
 *   node scripts/mycox-cleanup.cjs --fix-action-type  # 仅修 mycox schedule
 *                                                      # action_type=prompt → autonomous_turn
 *                                                      # 不删任何数据
 *
 * 删除范围:
 *   - memory_schedules     name 含 'mycox'(完全删除)
 *   - memory_facts         namespace 'service.mycox*' 或 'project.mycox*'(软删,设 forgotten_at)
 *   - memory_skills        name 含 'mycox' 且 source LIKE 'self:reflect-%'(reflection 写的派生 skill,setMaturity 'deprecated')
 *   - memory_raw_messages  content 含 'mycox'(2026-05-09 新增,硬删 — 避免 K0 timeline 召回旧 onboarding 历史污染新流程)
 *   - routing_rules        task_signature/evidence/context_keywords/prefer_skill 含 'mycox'(2026-05-09 新增,setConfidence 'retired')
 *   - secrets.json         key 含 'mycox'(可选,需 --clean-secrets)
 *
 * 安全:
 *   - 默认 dry-run,只列出会受影响的记录
 *   - bundled clawhub / mycox-agent-onboarding-and-post 等 reflection skill 仅
 *     标 deprecated,不真删 — 历史可追溯
 *   - raw timeline 清理是硬删 — K0 全局时间线不支持软删,且测试残留对未来流程
 *     是噪声,不需要保留(若需保留可加 --keep-timeline 选项,目前没做)
 */

'use strict';

// better-sqlite3 不是 server 直接依赖,而是通过 @agent/memory 间接依赖。
// 尝试多个解析路径,跨 npm/pnpm/workspace 布局。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function resolveBetterSqlite3() {
  const candidates = [
    'better-sqlite3',
    '@agent/memory/node_modules/better-sqlite3',
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', 'node_modules', '@agent', 'memory', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', '..', 'agent-memory', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'),
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      errors.push(`  ${c}: ${(e && e.code) || 'fail'}`);
    }
  }
  console.error('✗ 找不到 better-sqlite3。试过的路径:');
  console.error(errors.join('\n'));
  console.error('\n手动安装:cd server && npm install better-sqlite3 --save-dev');
  process.exit(1);
}

const Database = resolveBetterSqlite3();

const argv = process.argv.slice(2);
const DRY_RUN = !argv.includes('--clean') && !argv.includes('--fix-action-type');
const CLEAN_SECRETS = argv.includes('--clean-secrets');
const FIX_ACTION_TYPE = argv.includes('--fix-action-type');

// agent-memory 默认路径(见 paths.ts):
//   优先级 env MEMORY_DB_PATH > ~/.philont/memory/memory.sqlite > legacy ./memory.sqlite
function resolveDbPath() {
  if (process.env.MEMORY_DB_PATH) {
    return process.env.MEMORY_DB_PATH;
  }
  const home = process.env.HOME || os.homedir();
  const standard = path.join(home, '.philont', 'memory', 'memory.sqlite');
  if (fs.existsSync(standard)) return standard;
  // legacy 路径(老版本)
  const legacy = path.join(process.cwd(), 'memory.sqlite');
  if (fs.existsSync(legacy)) return legacy;
  // 兼容旧脚本路径(以防有人真用 .db 后缀)
  const oldGuess = path.join(home, '.philont', 'memory.db');
  if (fs.existsSync(oldGuess)) return oldGuess;
  return standard; // 默认返(即便不存在,后续报错)
}

const DB_PATH = resolveDbPath();
const SECRETS_PATH = path.join(os.homedir(), '.philont', 'secrets.json');

console.log(`[mycox-cleanup] mode: ${DRY_RUN ? 'DRY-RUN(仅查)' : '✂️ CLEAN(真删)'}`);
console.log(`[mycox-cleanup] db: ${DB_PATH}`);
console.log('');

if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ DB 不存在: ${DB_PATH}`);
  console.error('  可能路径(按优先级):');
  console.error('    1. env MEMORY_DB_PATH');
  console.error('    2. ~/.philont/memory/memory.sqlite(标准)');
  console.error('    3. ./memory.sqlite(legacy,server cwd)');
  console.error('  确认 server 跑过至少一次,DB 才会被创建。');
  process.exit(1);
}

const db = new Database(DB_PATH);

// ── 1. memory_schedules ──────────────────────────────────────────────

const schedules = db.prepare(`
  SELECT id, name, action_type, datetime(next_run_at/1000, 'unixepoch', 'localtime') AS next_run, payload_json
  FROM memory_schedules
  WHERE name LIKE '%mycox%' COLLATE NOCASE
`).all();

console.log(`[schedules] 找到 ${schedules.length} 条 mycox 相关 schedule:`);
for (const s of schedules) {
  console.log(`  - ${s.name} (${s.action_type}) next=${s.next_run}`);
  if (s.payload_json) {
    const pj = JSON.parse(s.payload_json);
    if (pj.prompt) console.log(`    prompt: ${pj.prompt.slice(0, 80)}...`);
  }
}

// ── 2. memory_facts(active 段)───────────────────────────────────────

const facts = db.prepare(`
  SELECT id, namespace, key
  FROM memory_facts
  WHERE (namespace LIKE 'service.mycox%' OR namespace LIKE 'project.mycox%' OR
         (namespace = 'project' AND key LIKE '%mycox%'))
    AND superseded_by IS NULL
    AND forgotten_at IS NULL
`).all();

console.log(`\n[facts] 找到 ${facts.length} 条 active mycox 相关 fact:`);
for (const f of facts) {
  console.log(`  - ${f.namespace}.${f.key}`);
}

// ── 3. memory_skills(reflection 写的派生 skill)──────────────────────

const skills = db.prepare(`
  SELECT name, source, maturity
  FROM memory_skills
  WHERE name LIKE '%mycox%' COLLATE NOCASE
    AND source LIKE 'self:reflect-%'
`).all();

console.log(`\n[skills] 找到 ${skills.length} 条 reflection 派生的 mycox skill:`);
for (const sk of skills) {
  console.log(`  - ${sk.name} (maturity=${sk.maturity}, source=${sk.source})`);
}

// ── 4. routing_rules(reflection 写的 mycox 路由规则)─────────────────
// 实战观察(2026-05-09):cleanup 标 deprecated 的 skill 已被 SkillStore 过滤,
// 但 routing_rules 仍触发(routing_rules.search 只过滤 retired,没看 prefer_skill
// 是否 deprecated)。这层 rule 教 agent "mycox 流程是 webFetch + register +
// post" 但漏了 schedule_reminder,导致 agent 跟着照做也漏 step 5。

const routingRules = db.prepare(`
  SELECT id, task_signature, prefer_skill, confidence,
         substr(trigger_condition, 1, 60) AS trigger_preview,
         substr(evidence, 1, 60) AS evidence_preview
  FROM routing_rules
  WHERE confidence != 'retired'
    AND (
      task_signature LIKE '%mycox%' COLLATE NOCASE
      OR evidence LIKE '%mycox%' COLLATE NOCASE
      OR context_keywords LIKE '%mycox%' COLLATE NOCASE
      OR prefer_skill LIKE '%mycox%' COLLATE NOCASE
      OR avoid_skills LIKE '%mycox%' COLLATE NOCASE
      OR trigger_condition LIKE '%mycox%' COLLATE NOCASE
    )
`).all();

console.log(`\n[routing_rules] 找到 ${routingRules.length} 条 active mycox 相关 routing rule:`);
for (const r of routingRules) {
  console.log(`  - id=${r.id} sig=${r.task_signature} confidence=${r.confidence} prefer=${r.prefer_skill || '-'}`);
  console.log(`    trigger: ${r.trigger_preview}...`);
}

// ── 5. memory_raw_messages(K0 全局时间线)──────────────────────────
// 2026-05-09:测试残留的 wechat session 对话(含 mycox 关键词)会被
// TimelineRetriever 召回到下次 user/autonomous turn 的 messages 里,
// agent 看到"我以前 onboard 过"就跑捷径跳过 SKILL.md。硬删干净。

const rawMsgs = db.prepare(`
  SELECT id, session_id, role, datetime(timestamp/1000, 'unixepoch', 'localtime') AS ts,
         substr(content, 1, 60) AS preview
  FROM memory_raw_messages
  WHERE content LIKE '%mycox%' COLLATE NOCASE
  ORDER BY timestamp DESC
  LIMIT 50
`).all();

const rawMsgCountTotal = db
  .prepare(`SELECT COUNT(*) AS c FROM memory_raw_messages WHERE content LIKE '%mycox%' COLLATE NOCASE`)
  .get().c;

console.log(`\n[raw_messages] 找到 ${rawMsgCountTotal} 条 mycox 相关 raw 消息(展示最近 ${Math.min(rawMsgCountTotal, 50)} 条):`);
for (const m of rawMsgs) {
  console.log(`  - [${m.ts}] ${m.role}@${m.session_id.slice(0, 30)}: ${m.preview.replace(/\n/g, ' ')}...`);
}

// ── 6. secrets ──────────────────────────────────────────────────────

let secretsToClean = [];
if (fs.existsSync(SECRETS_PATH)) {
  try {
    const j = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    secretsToClean = Object.keys(j).filter((k) => k.toLowerCase().includes('mycox'));
    console.log(`\n[secrets] 找到 ${secretsToClean.length} 条 mycox 相关凭证:`);
    for (const k of secretsToClean) console.log(`  - ${k}`);
  } catch {
    console.warn(`\n[secrets] 解析 ${SECRETS_PATH} 失败,跳过`);
  }
}

// ── 真删执行 ────────────────────────────────────────────────────────

// ── --fix-action-type 路径(单独操作,不删数据) ──────────────────────

if (FIX_ACTION_TYPE) {
  console.log('\n--- FIX ACTION_TYPE: 把 mycox schedule 从 prompt 转 autonomous_turn ---');
  let fixed = 0;
  for (const s of schedules) {
    if (s.action_type !== 'prompt') {
      console.log(`  skip ${s.name}(已是 ${s.action_type})`);
      continue;
    }
    const oldPayload = s.payload_json ? JSON.parse(s.payload_json) : {};
    // payload 转成 autonomous_turn 形态:{ prompt, replyChannel: 'silent' }
    const newPayload = {
      prompt: oldPayload.prompt || oldPayload.message || `执行 ${s.name}`,
      replyChannel: 'silent',
    };
    const r = db
      .prepare(
        `UPDATE memory_schedules SET action_type = 'autonomous_turn', payload_json = ? WHERE id = ?`
      )
      .run(JSON.stringify(newPayload), s.id);
    if (r.changes > 0) {
      fixed++;
      console.log(`  ✓ ${s.name}: prompt → autonomous_turn`);
    }
  }
  console.log(`\n--- FIX 完成,改了 ${fixed} 条 schedule ---`);
  console.log('建议:重启 server 让 scheduler 重新读 next_run_at');
  db.close();
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n--- DRY-RUN 完成 ---');
  console.log('选项:');
  console.log('  --clean              删 mycox schedules + 软删 facts + deprecate skills + 硬删 raw_messages + retire routing_rules');
  console.log('  --clean --clean-secrets   连带删 secrets');
  console.log('  --fix-action-type    仅修 schedule action_type = autonomous_turn(不删)');
  db.close();
  process.exit(0);
}

console.log('\n--- 开始 CLEAN ---');

const now = Date.now();

if (schedules.length > 0) {
  const r = db.prepare(`DELETE FROM memory_schedules WHERE name LIKE '%mycox%' COLLATE NOCASE`).run();
  console.log(`✓ schedules: 删除 ${r.changes} 条`);
}

if (facts.length > 0) {
  const r = db.prepare(`
    UPDATE memory_facts SET forgotten_at = ?
    WHERE (namespace LIKE 'service.mycox%' OR namespace LIKE 'project.mycox%' OR
           (namespace = 'project' AND key LIKE '%mycox%'))
      AND superseded_by IS NULL
      AND forgotten_at IS NULL
  `).run(now);
  console.log(`✓ facts: 软删 ${r.changes} 条(forgotten_at = now)`);
}

if (skills.length > 0) {
  const r = db.prepare(`
    UPDATE memory_skills SET maturity = 'deprecated'
    WHERE name LIKE '%mycox%' COLLATE NOCASE
      AND source LIKE 'self:reflect-%'
      AND maturity != 'deprecated'
  `).run();
  console.log(`✓ skills: 标 deprecated ${r.changes} 条(reflection 派生,保留历史)`);
}

// 2026-05-09:raw timeline 硬删 mycox 相关消息
if (rawMsgCountTotal > 0) {
  const r = db.prepare(`
    DELETE FROM memory_raw_messages WHERE content LIKE '%mycox%' COLLATE NOCASE
  `).run();
  console.log(`✓ raw_messages: 硬删 ${r.changes} 条(K0 timeline 不再召回 mycox 旧对话)`);
}

// 2026-05-09:routing rules 标 retired(routing_rules.search 已过滤 retired)
if (routingRules.length > 0) {
  const r = db.prepare(`
    UPDATE routing_rules SET confidence = 'retired', updated_at = strftime('%s','now')*1000
    WHERE confidence != 'retired'
      AND (
        task_signature LIKE '%mycox%' COLLATE NOCASE
        OR evidence LIKE '%mycox%' COLLATE NOCASE
        OR context_keywords LIKE '%mycox%' COLLATE NOCASE
        OR prefer_skill LIKE '%mycox%' COLLATE NOCASE
        OR avoid_skills LIKE '%mycox%' COLLATE NOCASE
        OR trigger_condition LIKE '%mycox%' COLLATE NOCASE
      )
  `).run();
  console.log(`✓ routing_rules: 标 retired ${r.changes} 条(routing-inject 不再注入)`);
}

if (CLEAN_SECRETS && secretsToClean.length > 0) {
  try {
    const j = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    let removed = 0;
    for (const k of secretsToClean) {
      delete j[k];
      removed++;
    }
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(j));
    console.log(`✓ secrets: 删除 ${removed} 条`);
  } catch (e) {
    console.error('✗ secrets 写回失败:', e.message);
  }
} else if (secretsToClean.length > 0) {
  console.log(`(secrets 未清,需要 --clean-secrets 才删)`);
}

db.close();
console.log('\n--- CLEAN 完成 ---');
console.log('建议:重启 server 让 SkillStore reload(或等下次 hot-reload)');
