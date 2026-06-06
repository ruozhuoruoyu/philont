/**
 * plan_protocol_gate Phase 18 "lazy gate" 单测。
 *
 * 验证:
 *   1. 现有的 exempt 规则不变(read×* + write×self + plan_* + task_mode_classify)
 *   2. 新增:shell + read-only verb + 无逃逸字符 → exempt
 *   3. 边界:shell + 写命令 / shell + 逃逸 / shell + find -delete → 仍 reject
 *   4. isReadOnlyShellCommand 单独测白名单 + 逃逸 + find 副作用 flag 检测
 *
 * 动机:某多步数据标准化任务 5/9 因 in-turn-tool-block
 * 锁 readFile + plan_protocol_gate 锁 shell 双重夹击 agent-fail。lazy gate
 * 把 read-only shell 视为 read-equivalent,解开探索期死锁。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlanGateExempt,
  isReadOnlyShellCommand,
} from '../src/plan_gate.js';

// ── isReadOnlyShellCommand:核心白名单 + 逃逸检测 ──────────────────────────────

test('isReadOnlyShellCommand: ls/find/cat/grep/head/wc 白名单内 → true', () => {
  assert.equal(isReadOnlyShellCommand('ls /root'), true);
  assert.equal(isReadOnlyShellCommand('find /tmp -name "*.csv"'), true);
  assert.equal(isReadOnlyShellCommand('cat /etc/hostname'), true);
  assert.equal(isReadOnlyShellCommand('grep -r foo /var/log'), true);
  assert.equal(isReadOnlyShellCommand('head -n 10 file.txt'), true);
  assert.equal(isReadOnlyShellCommand('wc -l data.csv'), true);
  assert.equal(isReadOnlyShellCommand('stat /root/.philont'), true);
  assert.equal(isReadOnlyShellCommand('tree -L 2 /root'), true);
});

test('isReadOnlyShellCommand: rm/mv/cp/curl/python 等 write 命令 → false', () => {
  assert.equal(isReadOnlyShellCommand('rm -rf /tmp/foo'), false);
  assert.equal(isReadOnlyShellCommand('mv a.txt b.txt'), false);
  assert.equal(isReadOnlyShellCommand('cp src dst'), false);
  assert.equal(isReadOnlyShellCommand('curl -o out.zip https://x.com'), false);
  assert.equal(isReadOnlyShellCommand('python -c "print(1)"'), false);
  assert.equal(isReadOnlyShellCommand('node script.js'), false);
  assert.equal(isReadOnlyShellCommand('bash setup.sh'), false);
  assert.equal(isReadOnlyShellCommand('git add .'), false);
});

test('isReadOnlyShellCommand: 重定向 > >> → false(即便 ls)', () => {
  assert.equal(isReadOnlyShellCommand('ls > out.txt'), false);
  assert.equal(isReadOnlyShellCommand('cat /etc/passwd >> backup.txt'), false);
});

test('isReadOnlyShellCommand: 命令链 ; && || & → false', () => {
  assert.equal(isReadOnlyShellCommand('ls; rm -rf /'), false);
  assert.equal(isReadOnlyShellCommand('cat foo && rm foo'), false);
  assert.equal(isReadOnlyShellCommand('ls /tmp || echo not-found'), false);
  assert.equal(isReadOnlyShellCommand('ls /root &'), false);
});

test('isReadOnlyShellCommand: 命令替换 $() / 反引号 → false', () => {
  assert.equal(isReadOnlyShellCommand('cat $(ls)'), false);
  assert.equal(isReadOnlyShellCommand('echo `pwd`'), false);
});

test('isReadOnlyShellCommand: |tee / |sponge / |dd → false', () => {
  assert.equal(isReadOnlyShellCommand('cat file | tee output.txt'), false);
  assert.equal(isReadOnlyShellCommand('ls | sponge dir.txt'), false);
});

test('isReadOnlyShellCommand: find -delete / -exec → false', () => {
  assert.equal(isReadOnlyShellCommand('find /tmp -name "*.log" -delete'), false);
  assert.equal(isReadOnlyShellCommand('find . -exec rm {} \\;'), false);
  assert.equal(isReadOnlyShellCommand('find . -execdir rm {} \\;'), false);
  // 普通 find 仍放行
  assert.equal(isReadOnlyShellCommand('find /root -name "*.csv"'), true);
});

test('isReadOnlyShellCommand: 普通 pipe(无 tee/sponge/dd)→ true', () => {
  // ls | grep / cat | head 等 read-only pipe 链
  assert.equal(isReadOnlyShellCommand('ls /tmp | grep csv'), true);
  assert.equal(isReadOnlyShellCommand('cat data.csv | head -n 5'), true);
});

test('isReadOnlyShellCommand: 空字符串 / 非字符串 → false', () => {
  assert.equal(isReadOnlyShellCommand(''), false);
  assert.equal(isReadOnlyShellCommand('  '), false);
  assert.equal(isReadOnlyShellCommand(undefined), false);
  assert.equal(isReadOnlyShellCommand(null), false);
  assert.equal(isReadOnlyShellCommand(42), false);
  assert.equal(isReadOnlyShellCommand({ command: 'ls' }), false);
});

test('isReadOnlyShellCommand: sed / awk / tar 不在白名单(可 -i inplace)→ false', () => {
  // 即便看似 read,流转语义 risky
  assert.equal(isReadOnlyShellCommand('sed s/foo/bar/ file.txt'), false);
  assert.equal(isReadOnlyShellCommand('awk \'{print}\' file.txt'), false);
  assert.equal(isReadOnlyShellCommand('tar -tf archive.tar'), false);
});

// ── isPlanGateExempt:综合规则 ────────────────────────────────────────────────

test('isPlanGateExempt: plan_* / task_mode_classify 永远放行', () => {
  assert.equal(isPlanGateExempt('plan_draft', null), true);
  assert.equal(isPlanGateExempt('plan_update_step', null), true);
  assert.equal(isPlanGateExempt('plan_close', null), true);
  assert.equal(isPlanGateExempt('task_mode_classify', null), true);
});

test('isPlanGateExempt: askUserQuestion 即便 read 也拦(防 LLM 推卸)', () => {
  assert.equal(
    isPlanGateExempt('askUserQuestion', { capability: 'read', domain: 'local' }),
    false,
  );
});

test('isPlanGateExempt: read 任何 domain → 放行', () => {
  assert.equal(
    isPlanGateExempt('readFile', { capability: 'read', domain: 'local' }),
    true,
  );
  assert.equal(
    isPlanGateExempt('listDir', { capability: 'read', domain: 'local' }),
    true,
  );
  assert.equal(
    isPlanGateExempt('webFetch', { capability: 'read', domain: 'network' }),
    true,
  );
  assert.equal(
    isPlanGateExempt('grep', { capability: 'read', domain: 'local' }),
    true,
  );
});

test('isPlanGateExempt: write×self → 放行(memory 自管)', () => {
  assert.equal(
    isPlanGateExempt('store_fact', { capability: 'write', domain: 'self' }),
    true,
  );
});

test('isPlanGateExempt: write×local → 拦(plan 在前)', () => {
  assert.equal(
    isPlanGateExempt('writeFile', { capability: 'write', domain: 'local' }),
    false,
  );
  assert.equal(
    isPlanGateExempt('patch', { capability: 'write', domain: 'local' }),
    false,
  );
});

test('isPlanGateExempt: write×network → 拦(POST API 等)', () => {
  assert.equal(
    isPlanGateExempt('http', { capability: 'write', domain: 'network' }),
    false,
  );
});

test('Phase 18: shell + read-only verb → 放行', () => {
  const exec = { capability: 'execute', domain: 'local' };
  assert.equal(isPlanGateExempt('shell', exec, { command: 'ls /root' }), true);
  assert.equal(
    isPlanGateExempt('shell', exec, { command: 'find /tmp -name "*.csv"' }),
    true,
  );
  assert.equal(
    isPlanGateExempt('shell', exec, { command: 'cat /etc/passwd' }),
    true,
  );
  assert.equal(
    isPlanGateExempt('shell', exec, { command: 'grep -r foo .' }),
    true,
  );
});

test('Phase 18: shell + write verb → 拦', () => {
  const exec = { capability: 'execute', domain: 'local' };
  assert.equal(
    isPlanGateExempt('shell', exec, { command: 'rm -rf /tmp/x' }),
    false,
  );
  assert.equal(
    isPlanGateExempt('shell', exec, { command: 'curl -X POST https://api' }),
    false,
  );
  assert.equal(
    isPlanGateExempt('shell', exec, { command: 'python script.py' }),
    false,
  );
});

test('Phase 18: shell + 重定向 → 拦(即便 ls > foo 也算 write)', () => {
  const exec = { capability: 'execute', domain: 'local' };
  assert.equal(
    isPlanGateExempt('shell', exec, { command: 'ls > out.txt' }),
    false,
  );
});

test('Phase 18: shell 缺 command 参数 → 拦', () => {
  const exec = { capability: 'execute', domain: 'local' };
  assert.equal(isPlanGateExempt('shell', exec, {}), false);
  assert.equal(isPlanGateExempt('shell', exec, undefined), false);
});

test('Phase 18: 非 shell 工具(process)即便 execute×local 也不走 shell 路径', () => {
  // 仅 shell 享白名单。process / 其它 execute 工具仍按"execute → 拦"
  assert.equal(
    isPlanGateExempt(
      'process',
      { capability: 'execute', domain: 'local' },
      { command: 'ls' },
    ),
    false,
  );
});

test('PHILONT_PLAN_GATE_EXEMPT_READONLY=0 → 整体回退严模式(read 也拦)', () => {
  const orig = process.env.PHILONT_PLAN_GATE_EXEMPT_READONLY;
  process.env.PHILONT_PLAN_GATE_EXEMPT_READONLY = '0';
  try {
    assert.equal(
      isPlanGateExempt('readFile', { capability: 'read', domain: 'local' }),
      false,
    );
    assert.equal(
      isPlanGateExempt(
        'shell',
        { capability: 'execute', domain: 'local' },
        { command: 'ls' },
      ),
      false,
    );
    // 但 plan_* / task_mode_classify 仍放行
    assert.equal(isPlanGateExempt('plan_draft', null), true);
    assert.equal(isPlanGateExempt('task_mode_classify', null), true);
  } finally {
    if (orig === undefined) {
      delete process.env.PHILONT_PLAN_GATE_EXEMPT_READONLY;
    } else {
      process.env.PHILONT_PLAN_GATE_EXEMPT_READONLY = orig;
    }
  }
});
