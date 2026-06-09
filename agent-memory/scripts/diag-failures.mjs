#!/usr/bin/env node
/**
 * Diagnose the `same_root_cause_failures` reflection trigger.
 *
 * Replicates EXACTLY what the reflection sees — the last 30 failed tool calls in the past 24h, run
 * through the real groupFailures (pariGp/z3/mechanism exclusions + the real signature extractor) — and
 * surfaces the recurring failure that keeps firing the trigger. Read-only; safe to run while the agent
 * is up (SQLite WAL allows concurrent readers).
 *
 * Usage:
 *   node agent-memory/scripts/diag-failures.mjs
 *   (override the DB with MEMORY_DB_PATH; default ~/.philont/memory/memory.sqlite)
 *
 * Requires agent-memory to be built (dist/) — it imports the real clustering logic so the result
 * matches production, not a hand-rolled copy.
 */
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { groupFailures, extractFailureSignature } from '../dist/src/index.js';

const dbPath = process.env.MEMORY_DB_PATH || join(homedir(), '.philont', 'memory', 'memory.sqlite');
console.log('DB:', dbPath);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const since = Date.now() - 24 * 60 * 60 * 1000;

// Matches ActionStore.listRecentFailures({ sinceTs, limit: 30 }) — exactly what the trigger reads.
const rows = db
  .prepare(
    `SELECT tool_name AS toolName, result, timestamp
       FROM memory_actions
      WHERE success = 0 AND timestamp >= ?
      ORDER BY timestamp DESC, id DESC
      LIMIT 30`,
  )
  .all(since);
db.close();

const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '?');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── 1. Reflection view: exactly what same_root_cause_failures counts (excludes pariGp/z3/mechanism) ──
const groups = groupFailures(rows);
const maxCount = groups.length ? groups[0].count : 0;

console.log(`\nLast 24h: ${rows.length} failed tool calls in the 30-entry window.`);
console.log(`same_root_cause_failures fires when the top signature count >= 3. Current max: ${maxCount}.\n`);

if (groups.length) {
  console.table(
    groups.slice(0, 15).map((g) => ({ signature: g.signature, count: g.count, tool: g.toolName, last: fmtTs(g.latestTs) })),
  );
  const culprit = groups[0];
  if (culprit.count >= 3) {
    console.log(`\n>>> CULPRIT (triggers same_root_cause): "${culprit.signature}" x${culprit.count}. Sample errors:`);
    for (const r of rows.filter((x) => extractFailureSignature(x.toolName, x.result) === culprit.signature).slice(0, 4)) {
      console.log('  -', oneLine(r.result).slice(0, 220));
    }
  } else {
    console.log('\nNo non-excluded signature >= 3 right now (may have aged out of the 30-entry window).');
  }
} else {
  console.log('No groupable failures (all excluded as pariGp/z3/mechanism, or none in window).');
}

// ── 2. Full view incl. excluded (pariGp/z3/mechanism) — these don't trigger the reflection but DO waste
//       deep_explore round iterations, so worth seeing (e.g. recurring pariGp:gp-args syntax errors). ──
const full = {};
for (const r of rows) {
  const s = extractFailureSignature(r.toolName, r.result);
  full[s] = (full[s] || 0) + 1;
}
const fullRows = Object.entries(full)
  .map(([signature, count]) => ({ signature, count, excluded: /^(?:pariGp|z3Verify):|:other:\[(?:plan_protocol_gate|in_turn_tool_block|autonomous_blacklist|research)/.test(signature) ? 'yes' : '' }))
  .sort((a, b) => b.count - a.count);
console.log('\nAll failures (incl. excluded — these waste iterations but do NOT trigger the reflection):');
console.table(fullRows.slice(0, 20));
