/**
 * z3Verify 工具测试。
 *
 * 真实求解(unsat/sat/反例)依赖宿主装了 python + z3-solver —— 检测不到则 skip
 * (CI/sandbox 无 z3 时不挂)。无条件测的:空输入校验 + 安全(只解 SMT-LIB,不 eval)+
 * 缺失时的干净降级。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { z3VerifyTool } from '../src/index.js';

let z3Available = false;

describe('z3Verify', () => {
  before(async () => {
    const r = await z3VerifyTool.execute({ smtlib: '(declare-const x Int)(assert (> x 0))' });
    z3Available = r.success && r.output.includes('result:');
    if (!z3Available) {
      console.log('[z3-test] z3/python 不可用,跳过真实求解断言(degradation 仍测)');
    }
  });

  // ── 无条件:输入校验 + 降级 ──────────────────────────────────────────────
  it('空 smtlib → 失败 + 清晰 error', async () => {
    const r = await z3VerifyTool.execute({ smtlib: '' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /smtlib|约束/);
  });

  it('z3/python 缺失时:error 指向安装(不抛、不假装成功)', async () => {
    if (z3Available) return; // 装了就不测这条
    const r = await z3VerifyTool.execute({ smtlib: '(assert true)' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /z3-solver|未安装|python/i);
  });

  // ── 安全:只 from_string SMT-LIB,绝不 eval 任意代码 ───────────────────────
  it('安全:Python 代码当 SMT-LIB 解析失败,不执行', async () => {
    if (!z3Available) return;
    // 这若被 eval 会执行;但 harness 只 from_string → SMT-LIB 解析错误
    const r = await z3VerifyTool.execute({ smtlib: 'import os; os.system("echo PWNED")' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /SMT|解析|求解|error/i);
  });

  // ── 真实求解(z3 可用才跑)────────────────────────────────────────────────
  it('unsat:矛盾约束', async () => {
    if (!z3Available) return;
    const r = await z3VerifyTool.execute({
      smtlib: '(declare-const x Int)(assert (> x 0))(assert (< x 0))',
    });
    assert.equal(r.success, true);
    assert.match(r.output, /result: unsat/);
  });

  it('sat:可满足 + 附 model', async () => {
    if (!z3Available) return;
    const r = await z3VerifyTool.execute({
      smtlib: '(declare-const x Int)(assert (> x 5))(assert (< x 9))',
    });
    assert.equal(r.success, true);
    assert.match(r.output, /result: sat/);
    assert.match(r.output, /model:/);
  });

  it('negate-to-prove:∀x.x*x≥0 → ∃x.x*x<0 得 unsat', async () => {
    if (!z3Available) return;
    const r = await z3VerifyTool.execute({
      smtlib: '(declare-const x Int)(assert (< (* x x) 0))',
    });
    assert.equal(r.success, true);
    assert.match(r.output, /result: unsat/);
  });

  it('找反例:对假命题 ∀x>0.x>1 → ∃x>0.x≤1 得 sat(反例 x=1)', async () => {
    if (!z3Available) return;
    const r = await z3VerifyTool.execute({
      smtlib: '(declare-const x Int)(assert (> x 0))(assert (<= x 1))',
    });
    assert.equal(r.success, true);
    assert.match(r.output, /result: sat/);
    assert.match(r.output, /x = 1/);
  });
});
