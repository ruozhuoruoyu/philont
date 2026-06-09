/**
 * pariGp 工具测试。
 *
 * 真实计算(分解/素性/找反例)依赖宿主装了 PARI/GP(gp 可执行)—— 检测不到则 skip
 * (CI/sandbox 无 gp 时不挂)。无条件测的:空输入校验 + 缺失时干净降级。
 * 装了 gp 才测的关键一条:**secure 模式真的禁掉 system()**(防 shell 逃逸)。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { pariGpTool } from '../src/index.js';
import { checkGpParenBalance } from '../src/runtime/gp.js';

let gpAvailable = false;

describe('pariGp', () => {
  before(async () => {
    const r = await pariGpTool.execute({ script: 'print(2+2)' });
    gpAvailable = r.success && r.output.includes('4');
    if (!gpAvailable) {
      console.log('[gp-test] gp(PARI/GP)不可用,跳过真实计算断言(degradation/安全仍测)');
    }
  });

  // ── 无条件:输入校验 + 降级 ──────────────────────────────────────────────
  it('空 script → 失败 + 清晰 error', async () => {
    const r = await pariGpTool.execute({ script: '   ' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /script|脚本/);
  });

  it('gp 缺失时:error 指向安装(不抛、不假装成功)', async () => {
    if (gpAvailable) return; // 装了就不测这条
    const r = await pariGpTool.execute({ script: 'print(1)' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /PARI\/GP|pari-gp|PHILONT_GP|未找到/i);
  });

  // ── 安全:secure 模式禁 system()(子 LLM 不能借 gp 逃进 shell)──────────────
  it('安全:secure=1 下 system() 被拒,不执行 shell', async () => {
    if (!gpAvailable) return;
    const r = await pariGpTool.execute({ script: 'system("echo PWNED")' });
    // secure 模式下 system 被拒 → gp 报错(success=false);绝不能出现执行后的 PWNED 成功路径
    assert.equal(r.success, false);
    assert.ok(!/PWNED/.test(r.output), 'system() 不应被执行');
  });

  // ── 真实计算(gp 可用才跑)────────────────────────────────────────────────
  it('分解:factor 证合数(2^67-1 非素)', async () => {
    if (!gpAvailable) return;
    const r = await pariGpTool.execute({ script: 'print(factor(2^67-1))' });
    assert.equal(r.success, true);
    // 2^67-1 = 193707721 × 761838257287
    assert.match(r.output, /193707721/);
  });

  it('素性:isprime(2^61-1) 为真(Mersenne 素数)', async () => {
    if (!gpAvailable) return;
    const r = await pariGpTool.execute({ script: 'print(isprime(2^61-1))' });
    assert.equal(r.success, true);
    assert.match(r.output, /\b1\b/);
  });

  it('找反例:枚举找到使 n^2+n+41 非素的最小 n(=40)', async () => {
    if (!gpAvailable) return;
    const r = await pariGpTool.execute({
      script: 'for(n=0,100, if(!isprime(n^2+n+41), print(n); break))',
    });
    assert.equal(r.success, true);
    assert.match(r.output, /^40\b/m);
  });

  it('语法错误 → 失败 + 回显 gp 报错', async () => {
    if (!gpAvailable) return;
    const r = await pariGpTool.execute({ script: 'print(factor(' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /PARI\/GP|error|\*\*\*/i);
  });
});

describe('pariGp 语法预检(括号配平,无需 gp)', () => {
  it('未闭合 ( → 标记', () => {
    assert.match(checkGpParenBalance('for(i=1,nA, s=A[i]')!, /unclosed/);
  });
  it('多余 ) → 标记', () => {
    assert.match(checkGpParenBalance('print(1))')!, /no matching/);
  });
  it('配平脚本 → null', () => {
    assert.equal(checkGpParenBalance('for(i=1,#V, print(V[i]))'), null);
  });
  it('字符串内的括号不计数(防误报)', () => {
    assert.equal(checkGpParenBalance('print("result (a+b) = )")'), null);
  });
  it('execute 在不启动 gp 的情况下拒绝畸形脚本', async () => {
    const r = await pariGpTool.execute({ script: 'for(i=1,nA, s=A[i]' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /pre-check/);
  });
});
