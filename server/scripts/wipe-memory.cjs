#!/usr/bin/env node
/**
 * 整体擦掉 philont memory + secrets,从干净状态重启 server(2026-05-09)
 *
 * 用途:开发期 mycox 等测试积累了大量 reflection-emitted skill / playbook /
 * routing rule / 跨 session timeline 历史,污染面已涉及 5 张表。继续点修
 * (mycox-cleanup.cjs)是 whack-a-mole — 改用整体核弹清干净重来。
 *
 * 默认行为(--db-only):
 *   - 备份 ~/.philont/memory/memory.sqlite 到 memory.sqlite.wipe.<ISO>.bak
 *   - 删 memory.sqlite + memory.sqlite-shm + memory.sqlite-wal
 *   - 不动 secrets / 不动 disk skills
 *
 * 加 --with-secrets:
 *   - 顺便备份 + 删 ~/.philont/secrets.json
 *   - 跨服务的 api-key 全部丢失,需要 onboarding 时重存
 *
 * 加 --with-disk-skills:
 *   - 顺便备份 + 清 ~/.philont/skills/(workspace + global)的 reflection-
 *     emitted .md 文件。bundled skills(agent-tools/bundled-skills/)不动 —
 *     那是源码的一部分。
 *   - 谨慎:用户手装的 clawhub skill 也会被清(若想保留,别用此 flag)
 *
 * 默认 dry-run,要真删必须传 --do-it。
 *
 * 用法:
 *   node scripts/wipe-memory.cjs                                   # dry-run 列要做什么
 *   node scripts/wipe-memory.cjs --do-it                           # 真清 DB
 *   node scripts/wipe-memory.cjs --do-it --with-secrets            # DB + 凭证
 *   node scripts/wipe-memory.cjs --do-it --with-secrets --with-disk-skills  # 全核弹
 *
 * 安全:
 *   - 备份文件在 ~/.philont/<file>.wipe.<ISO>.bak,可手动恢复
 *   - 备份永不删,定期手动清(避免脚本静默吃磁盘)
 *
 * 重启 server 后:
 *   - schema 自动建表
 *   - 16 bundled skills 重 import 到 memory_skills
 *   - facts / pursuits / routing_rules / raw_messages / schedules 全空
 *   - autonomous loop / pursuit / drives / reflection 等子系统从零起步
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const argv = process.argv.slice(2);
const DO_IT = argv.includes('--do-it');
const WITH_SECRETS = argv.includes('--with-secrets');
const WITH_DISK_SKILLS = argv.includes('--with-disk-skills');

const HOME = process.env.HOME || os.homedir();
const PHILONT_HOME = path.join(HOME, '.philont');

// agent-memory 的 paths.ts 优先级:env > ~/.philont/memory/memory.sqlite > legacy ./memory.sqlite
function resolveDbPath() {
  if (process.env.MEMORY_DB_PATH) return process.env.MEMORY_DB_PATH;
  const standard = path.join(PHILONT_HOME, 'memory', 'memory.sqlite');
  if (fs.existsSync(standard)) return standard;
  const legacy = path.join(process.cwd(), 'memory.sqlite');
  if (fs.existsSync(legacy)) return legacy;
  // 老路径(.db 后缀)兼容
  const oldGuess = path.join(PHILONT_HOME, 'memory.db');
  if (fs.existsSync(oldGuess)) return oldGuess;
  return standard; // 默认返(即便不存在,后续报"已干净")
}

const DB_PATH = resolveDbPath();
const SECRETS_PATH = path.join(PHILONT_HOME, 'secrets.json');
const SKILLS_DIRS = [
  path.join(PHILONT_HOME, 'skills'),                    // global
  path.join(process.cwd(), '.philont', 'skills'),       // workspace
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function backupFile(p) {
  const st = safeStat(p);
  if (!st || !st.isFile()) return null;
  const bak = `${p}.wipe.${stamp}.bak`;
  fs.copyFileSync(p, bak);
  return bak;
}

function backupDir(dir) {
  const st = safeStat(dir);
  if (!st || !st.isDirectory()) return null;
  const bak = `${dir}.wipe.${stamp}.bak`;
  // shallow copy:仅复制文件,不递归子目录(disk skills 一层结构够用)
  fs.mkdirSync(bak, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    const src = path.join(dir, f);
    const dst = path.join(bak, f);
    const fs1 = safeStat(src);
    if (fs1 && fs1.isFile()) {
      fs.copyFileSync(src, dst);
    } else if (fs1 && fs1.isDirectory()) {
      // 跳过子目录(这层 sql 的话仅在 .philont/skills/* 直接放 .md)
    }
  }
  return bak;
}

function fileSize(p) {
  const st = safeStat(p);
  return st && st.isFile() ? st.size : 0;
}

function dirInfo(dir) {
  const st = safeStat(dir);
  if (!st || !st.isDirectory()) return { exists: false, fileCount: 0 };
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  return { exists: true, fileCount: files.length };
}

console.log(`[wipe-memory] mode: ${DO_IT ? '⚠ DO-IT(真清)' : 'DRY-RUN(仅查)'}`);
console.log(`[wipe-memory] PHILONT_HOME: ${PHILONT_HOME}`);
console.log('');

// ── 1. memory DB ──────────────────────────────────────────────────────

const dbFiles = [
  DB_PATH,
  `${DB_PATH}-shm`,
  `${DB_PATH}-wal`,
];

console.log('[memory DB]');
let totalDbSize = 0;
for (const f of dbFiles) {
  const size = fileSize(f);
  if (size > 0) {
    console.log(`  - ${f}  (${(size / 1024).toFixed(1)} KB)`);
    totalDbSize += size;
  }
}
if (totalDbSize === 0) {
  console.log('  (DB 不存在或为空,跳过)');
}

// ── 2. secrets ────────────────────────────────────────────────────────

let secretsCount = 0;
let secretsSize = 0;
if (WITH_SECRETS) {
  console.log('\n[secrets]');
  secretsSize = fileSize(SECRETS_PATH);
  if (secretsSize > 0) {
    try {
      const j = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
      secretsCount = Object.keys(j).length;
      console.log(`  - ${SECRETS_PATH}  (${secretsSize} bytes, ${secretsCount} entries)`);
    } catch {
      console.log(`  - ${SECRETS_PATH}  (${secretsSize} bytes,无法解析,仍会备份+删)`);
    }
  } else {
    console.log('  (secrets.json 不存在或为空,跳过)');
  }
}

// ── 3. disk skills ────────────────────────────────────────────────────

const skillTargets = [];
if (WITH_DISK_SKILLS) {
  console.log('\n[disk skills]');
  for (const d of SKILLS_DIRS) {
    const info = dirInfo(d);
    if (info.exists && info.fileCount > 0) {
      console.log(`  - ${d}  (${info.fileCount} .md 文件)`);
      skillTargets.push(d);
    }
  }
  if (skillTargets.length === 0) {
    console.log('  (无 disk skills 目录或全为空,跳过)');
  }
}

// ── 执行 ──────────────────────────────────────────────────────────────

if (!DO_IT) {
  console.log('\n--- DRY-RUN 完成 ---');
  console.log('真清:');
  console.log('  --do-it                                  仅 DB');
  console.log('  --do-it --with-secrets                   DB + secrets');
  console.log('  --do-it --with-secrets --with-disk-skills  全核弹(disk skills 也清)');
  console.log('');
  console.log('重启 server 后:');
  console.log('  - 16 bundled skills 重 import,memory 从零');
  console.log('  - 跨服务 api-key 丢失(若清 secrets),需要 onboarding 重存');
  console.log('  - autonomous loop / pursuits / drives / reflection 全部从零起步');
  console.log('');
  console.log(`备份位置:每个 wipe 目标会备份到 <文件>.wipe.${stamp}.bak`);
  process.exit(0);
}

console.log('\n--- 开始 WIPE ---');

// 1. DB
let dbDeleted = 0;
for (const f of dbFiles) {
  if (fileSize(f) > 0) {
    const bak = backupFile(f);
    if (bak) console.log(`  ↩ 备份 ${f} → ${bak}`);
    fs.unlinkSync(f);
    console.log(`  ✗ 删 ${f}`);
    dbDeleted++;
  }
}
if (dbDeleted === 0) {
  console.log('  (DB 已不存在,无需清)');
}

// 2. secrets
if (WITH_SECRETS && secretsSize > 0) {
  const bak = backupFile(SECRETS_PATH);
  if (bak) console.log(`  ↩ 备份 ${SECRETS_PATH} → ${bak}`);
  fs.unlinkSync(SECRETS_PATH);
  console.log(`  ✗ 删 ${SECRETS_PATH} (${secretsCount} 条凭证)`);
}

// 3. disk skills
if (WITH_DISK_SKILLS && skillTargets.length > 0) {
  for (const d of skillTargets) {
    const bak = backupDir(d);
    if (bak) console.log(`  ↩ 备份 ${d} → ${bak}`);
    let removed = 0;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.md')) {
        fs.unlinkSync(path.join(d, f));
        removed++;
      }
    }
    console.log(`  ✗ 清 ${d} 下 ${removed} 个 .md`);
  }
}

console.log('\n--- WIPE 完成 ---');
console.log('下一步:重启 server。schema 自动建表,bundled skills 自动 import。');
