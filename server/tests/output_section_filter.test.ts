/**
 * 输出两段式过滤单测
 *
 * 解决"LLM 全量输出推到微信前端淹没用户"。约定:LLM 输出 `## 给用户` +
 * `## 工作日志`,过滤器抽前者推前端;LLM 没遵守约定时 fallback 取最后一段。
 *
 * 不变量:
 *   - 标准两段格式正确抽出 user 段
 *   - 缺段时 fallback 命中最后一段非空且非 heading 的文本
 *   - usedSection 标志正确反映 hit/fallback
 *   - 多 heading 不会越界(只取 user 段到下一 heading 之间)
 *   - 空字符串 / 非 string 安全返回
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUserSection,
  recordFilterCall,
  getFallbackRate,
  _resetMetricsForTests,
} from '../src/output_section_filter.js';

// ── happy path ──────────────────────────────────────────────────────────────

test('filter: 标准两段格式 → 抽出 user 段, usedSection=true', () => {
  const text = `## 给用户
已完成 PDF → Word 转换,文件保存到 /tmp/out.docx。

## 工作日志
试了 3 种方法。pdf2docx 在扫描版上失败(无文本层),
camscanner skill 成功,耗时 12s,文件 87KB。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.match(r.text, /已完成 PDF/);
  assert.doesNotMatch(r.text, /pdf2docx/);
  assert.doesNotMatch(r.text, /工作日志/);
});

test('filter(i18n): 英文段标 ## For User / ## Work Log 也能抽出 user 段', () => {
  const text = `## For User
Converted the PDF to Word, saved to /tmp/out.docx.

## Work Log
Tried 3 methods; pdf2docx failed on the scanned input, camscanner skill worked.`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.match(r.text, /Converted the PDF/);
  assert.doesNotMatch(r.text, /pdf2docx/); // work log 切走
  assert.doesNotMatch(r.text, /Work Log/);
});

test('filter(i18n): 缺 user 段时取英文 Work Log 之前内容(策略2)', () => {
  const text = `Here is the short answer for you.

## Work Log
internal reasoning dump`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, false);
  assert.match(r.text, /short answer/);
  assert.doesNotMatch(r.text, /internal reasoning/);
});

test('filter: 段标前后多余空行不影响', () => {
  const text = `

## 给用户

精简结论。

## 工作日志

详细日志。
`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.equal(r.text, '精简结论。');
});

test('filter: 只有 给用户 段(没有工作日志) → 抽全部', () => {
  const text = `## 给用户
完成。这是给用户的全部内容。
第二行也属于给用户。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.match(r.text, /完成/);
  assert.match(r.text, /第二行/);
});

test('filter: 给用户段内含 ## 子标题(一句话结论/分层评分)→ 全部保留,只切工作日志(prod 回归)', () => {
  // 2026-06-03 prod bug:LLM 用 ## 子标题组织答案正文,旧代码在第一个 ## 就 break,
  // 把 100+ 字答案砍成只剩引言(微信只收到 50-85 字)。
  const text = `## 给用户
好的,我读完了整篇论文。下面是分层评估。

---

# 论文最终评估

## 一句话结论
这是一个小步前进,不是重大突破。

## 分层评分
- 严谨性:6/10
- 创新性:4/10

## 工作日志
读了 49147 字节的 tex,检查了 D3 段。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.match(r.text, /一句话结论/);     // 子标题保留
  assert.match(r.text, /小步前进/);       // 正文保留
  assert.match(r.text, /分层评分/);       // 后续子标题也保留
  assert.match(r.text, /6\/10/);
  assert.doesNotMatch(r.text, /工作日志/); // 工作日志仍被切掉
  assert.doesNotMatch(r.text, /49147/);
  assert.ok(r.text.length > 50, `应是完整答案而非引言,实际=${r.text.length}`);
});

test('filter: 给用户段只是开场白 + 真答案塞进工作日志 → 推全文(prod 回归)', () => {
  // 2026-06-03 prod:LLM 把真答案塞进 ## 工作日志,## 给用户 只留一句开场白(28/41 字)
  // → 用户只收到开场白。安全网:给用户段极短 + 全文长得多 → 推全文。
  const text = `## 给用户
好的,让我认真思考后给出判断。

## 工作日志
### 核心判断:没有突破
核心方法没有对哥德巴赫猜想产生真正的证明突破。它产生了两个有价值的副产品:第一是 Phase 1 空类恢复率框架,这部分是原创的,把空类例外集和恢复率挂钩的思路此前没见过;第二是一个把 CRT 筛法和特征和例外集挂钩的统一视角,在技术上是新的组合。
但致命鸿沟在于 Perelli-Pintz 例外集的恢复率没有定理保证,只有数值巧合。这意味着整条证明链在最关键的一步上是断的:你能数值上观察到恢复率足够,但没有任何定理告诉你它一定成立。要弥合这一步,需要一个关于特征和例外集分布的新定理,而这正是难度所在。所以诚实地说,这是一篇有价值的框架论文,但不是猜想的证明。`;
  const r = extractUserSection(text);
  // 给用户段(≈18字)是开场白,真答案在工作日志 → 应推全文(usedSection=false)
  assert.equal(r.usedSection, false);
  assert.match(r.text, /没有突破/);        // 工作日志里的真答案出来了
  assert.match(r.text, /致命鸿沟/);
  assert.ok(r.text.length > 100, `应是全文非开场白,实际=${r.text.length}`);
});

test('filter: 给用户段是完整答案(虽配长工作日志)→ 仍只推给用户段(不误触发安全网)', () => {
  // 反向:给用户段本身就是完整答案(>80字),工作日志是真·内部 → 不该触发安全网。
  const userAns = '诚实回答:没有真正的新突破。之前的推理留下了 215 个已证节点,但核心鸿沟仍未弥合,Perelli-Pintz 例外集的恢复率没有定理保证。这是框架贡献,不是猜想证明。';
  const text = `## 给用户\n${userAns}\n\n## 工作日志\n详细推导省略,内部 scratch。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.match(r.text, /没有真正的新突破/);
  assert.doesNotMatch(r.text, /内部 scratch/); // 工作日志仍被切掉
});

// ── 策略 2:工作日志切分点 ──────────────────────────────────────────────────

test('filter: 没有 ## 给用户 段,有 ## 工作日志 → 取工作日志之前(策略 2)', () => {
  const text = `您说得对,我确实回复了!上一条消息是正常发出去的。

## 工作日志
检查了 sectionHit 命中情况。日志详情:`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, false);
  assert.match(r.text, /您说得对/);
  assert.doesNotMatch(r.text, /sectionHit/);
  assert.doesNotMatch(r.text, /工作日志/);
});

test('filter: 工作日志在前(没用户内容铺垫)+ 后续段落 → 退到策略 3 整段', () => {
  const text = `## 工作日志
detail 1
detail 2

## 其它段
some other thing

最终段落。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, false);
  // 策略 2 之前为空 → 策略 3 剔所有 heading,返回所有内容
  assert.match(r.text, /detail 1/);
  assert.match(r.text, /最终段落/);
  assert.doesNotMatch(r.text, /^##/m);
});

// ── 策略 3:无 heading 整段返回 ────────────────────────────────────────────

test('filter: 没有任何 heading → 整段返回(策略 3)', () => {
  const text = `先做了 X。
再做了 Y。

最终结论是 Z 完成。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, false);
  assert.match(r.text, /先做了 X/);
  assert.match(r.text, /Z 完成/);
});

test('filter: 单段无 heading → 全文返回', () => {
  const text = '就一段话,没标题。';
  const r = extractUserSection(text);
  assert.equal(r.usedSection, false);
  assert.equal(r.text, '就一段话,没标题。');
});

test('filter: 给用户段为空 + 工作日志有内容 → 策略 2 退化到 3,返回所有非 heading', () => {
  const text = `## 给用户

## 工作日志
日志内容。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, false);
  // 策略 2 之前空,退到 3 → 返回 "日志内容。"
  // 这是有意的:LLM 写了空 user 段 + 有内容 work log,我们宁可推日志(可能有信息)
  // 也不让 user 看到完全空回复(更糟的 UX)
  assert.match(r.text, /日志内容/);
  assert.doesNotMatch(r.text, /^##/m);
});

// ── 实战回归(从 prod log 抓的真实样本)──────────────────────────────────

test('filter: 实战样本 — 100+ 字回复无格式 → 整段返回(不再被砍 15 字)', () => {
  // 来自 2026-05-07 prod log:fullLen=144 但旧 fallback 砍成 17 字
  const text = `您说得对,我确实回复了!我上一条消息是正常发出去的。

您最初说"为啥出错了"——请问您指的是什么出错了?是:

1. **某个文件操作**出错?
2. **某个工具调用**出错?
3. **其他什么**?`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, false);
  assert.ok(r.text.length > 100, `应近原长,实际=${r.text.length}`);
  assert.match(r.text, /您说得对/);
  assert.match(r.text, /某个工具调用/);
});

// ── 边界 ──────────────────────────────────────────────────────────────────

test('filter: 空字符串 → 空 + false', () => {
  const r = extractUserSection('');
  assert.equal(r.usedSection, false);
  assert.equal(r.text, '');
});

test('filter: 非 string → 空 + false', () => {
  const r = extractUserSection(null as unknown as string);
  assert.equal(r.usedSection, false);
  assert.equal(r.text, '');
});

test('filter: 只有 whitespace → 空 + false', () => {
  const r = extractUserSection('   \n\n   ');
  assert.equal(r.usedSection, false);
  assert.equal(r.text, '');
});

test('filter: 给用户段后续还有 ## 给用户(重复)→ 取第一段', () => {
  const text = `## 给用户
第一段。

## 工作日志
日志。

## 给用户
第二段(LLM 错误重复)。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.match(r.text, /第一段/);
  assert.doesNotMatch(r.text, /第二段/);
});

test('filter: ## 给用户 出现在工作日志段引用中 → 不会误识别(因为有 heading 在前)', () => {
  // 这种情况现实中边缘:LLM 在 work log 里引用了 user-facing 段标题作为字面量。
  // 我们的实现按行匹配 `^##\s*给用户\s*$`,确实会命中。这里测试当前行为
  // 是"先到的 给用户 段先赢",不要求 LLM 不再做这种事。
  const text = `## 工作日志
讨论了一下 ## 给用户 段的格式约定。

## 给用户
真正的结论在这。`;
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  assert.match(r.text, /真正的结论/);
});

// ── metric ──────────────────────────────────────────────────────────────────

test('metric: hits/total/rate 正确累计', () => {
  _resetMetricsForTests();
  recordFilterCall(true);  // hit
  recordFilterCall(true);  // hit
  recordFilterCall(false); // miss
  recordFilterCall(false); // miss
  const stats = getFallbackRate();
  assert.equal(stats.total, 4);
  assert.equal(stats.hits, 2);
  assert.equal(stats.rate, 0.5);
});

test('metric: 0 调用 → rate=0', () => {
  _resetMetricsForTests();
  const stats = getFallbackRate();
  assert.equal(stats.total, 0);
  assert.equal(stats.hits, 0);
  assert.equal(stats.rate, 0);
});

// Phase 11(2026-05-14):fallback truncate
test('truncate: 完全无两段式 + 长文本 → 取末尾 + 提示', () => {
  const longText = 'a'.repeat(1500); // 远超默认 800 cap
  const r = extractUserSection(longText);
  assert.equal(r.usedSection, false);
  assert.match(r.text, /完整内容 1500 字已记录/);
  assert.match(r.text, /\.\.\./);
  assert.match(r.text, /细说/);
  // truncated text 应远小于原文
  assert.ok(r.text.length < 600);
});

test('truncate: 无两段式 + 短文本(≤ 800)→ 不 truncate', () => {
  const shortText = 'a'.repeat(500);
  const r = extractUserSection(shortText);
  assert.equal(r.usedSection, false);
  assert.equal(r.text, shortText);
  assert.doesNotMatch(r.text, /完整内容/);
});

test('truncate: env PHILONT_OUTPUT_FALLBACK_TRUNCATE_AT 调阈值', () => {
  const orig = process.env.PHILONT_OUTPUT_FALLBACK_TRUNCATE_AT;
  process.env.PHILONT_OUTPUT_FALLBACK_TRUNCATE_AT = '100';
  try {
    const r = extractUserSection('a'.repeat(200));
    assert.equal(r.usedSection, false);
    assert.match(r.text, /完整内容 200 字/);
  } finally {
    if (orig === undefined) delete process.env.PHILONT_OUTPUT_FALLBACK_TRUNCATE_AT;
    else process.env.PHILONT_OUTPUT_FALLBACK_TRUNCATE_AT = orig;
  }
});

test('truncate: 含 `## 给用户` 段(策略 1)不走 truncate 路径', () => {
  const text = '## 给用户\n' + 'a'.repeat(1500);
  const r = extractUserSection(text);
  assert.equal(r.usedSection, true);
  // 含 1500 字 a,但是策略 1 抽出来,不被 truncate
  assert.ok(r.text.length > 1000);
  assert.doesNotMatch(r.text, /完整内容/);
});
