#!/usr/bin/env node
/**
 * Phase 8 M5: config_rule rollback CLI
 *
 * Usage(from server/ dir):
 *   npx tsx scripts/config-rule-rollback.ts list [scope]
 *   npx tsx scripts/config-rule-rollback.ts retire <rule_id>
 *   npx tsx scripts/config-rule-rollback.ts promote <rule_id> <confidence>
 *   npx tsx scripts/config-rule-rollback.ts delete <rule_id>
 *
 * 让 admin 一行命令查看 / 修改 / 删除 config_rule(MetaConfigObserver 写出的
 * 自修规则),回滚误判 / 加速促进高质量规则到 validated。
 */

import { openMemoryDb, CONFIG_SCOPES, resolveDefaultMemoryPath } from '@agent/memory';

function usage(): never {
  console.error(`Usage:
  list [scope]                          列出 config_rules(可按 scope 过滤)
  retire <rule_id>                      标 retired(rollback 自修)
  promote <rule_id> <confidence>        显式设置 confidence(validated 等)
  delete <rule_id>                      硬删(危险,优先 retire)

Scopes: ${CONFIG_SCOPES.join(', ')}
Confidence: provisional | tentative | validated | disputed | retired
`);
  process.exit(1);
}

const cmd = process.argv[2];
if (!cmd) usage();

const dbPath = resolveDefaultMemoryPath();
const memory = openMemoryDb(dbPath);

try {
  if (cmd === 'list') {
    const scope = process.argv[3];
    const rules = scope
      ? memory.configRules.listByScope(scope as any)
      : memory.configRules.listAll();
    if (rules.length === 0) {
      console.log('(no rules)');
    } else {
      console.log(`${rules.length} rule(s):`);
      for (const r of rules) {
        const valuePreview = JSON.stringify(r.value).slice(0, 60);
        console.log(
          `  #${r.id} [${r.confidence}] ${r.scope}=${valuePreview} src=${r.source} success=${r.successCount} fail=${r.failureCount}`,
        );
        if (r.evidence) console.log(`       evidence: ${r.evidence.slice(0, 100)}`);
      }
    }
  } else if (cmd === 'retire') {
    const id = Number(process.argv[3]);
    if (!Number.isFinite(id)) usage();
    const after = memory.configRules.setConfidence(id, 'retired');
    if (after) console.log(`✓ rule #${id} → retired`);
    else console.error(`✗ rule #${id} not found`);
  } else if (cmd === 'promote') {
    const id = Number(process.argv[3]);
    const conf = process.argv[4];
    if (!Number.isFinite(id) || !conf) usage();
    if (!['provisional', 'tentative', 'validated', 'disputed', 'retired'].includes(conf)) {
      console.error(`Invalid confidence: ${conf}`);
      usage();
    }
    const after = memory.configRules.setConfidence(id, conf as any);
    if (after) console.log(`✓ rule #${id} → ${conf}`);
    else console.error(`✗ rule #${id} not found`);
  } else if (cmd === 'delete') {
    const id = Number(process.argv[3]);
    if (!Number.isFinite(id)) usage();
    const ok = memory.configRules.delete(id);
    if (ok) console.log(`✓ rule #${id} deleted`);
    else console.error(`✗ rule #${id} not found`);
  } else {
    usage();
  }
} finally {
  memory.close();
}
