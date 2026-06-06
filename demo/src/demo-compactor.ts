/**
 * 上下文压缩 demo
 *
 * 演示：
 *   1. 长对话超过 token 阈值时自动压缩
 *   2. 头部和尾部受保护，中间被摘要化
 *   3. 摘要存入 Layer 1，可被 search_notes 召回
 *   4. token 减少 + LLM 失败的安全降级
 */

import {
  openMemoryDb,
  Compactor,
  type CompactorMessage,
  type ExtractorLlmClient,
} from '@agent/memory';

// ── 人肉摘要 LLM ───────────────────────────────────────────────────────

class HumanSummaryLlm implements ExtractorLlmClient {
  callCount = 0;
  async complete(_prompt: string) {
    this.callCount++;
    // 模拟 Claude 看到中间段对话后的输出
    const summary =
      '用户和助手在中间段讨论了 Rust 项目 philont 的代码组织，' +
      '决定采用 module-per-feature 结构。助手帮助创建了 src/auth、src/db、src/api 三个模块，' +
      '并讨论了 trait 的命名规范（动词+er 形式）。用户提到他偏好简短的函数名，避免 builder pattern 的过度使用。' +
      '最后助手帮助修复了一个生命周期错误。';
    return { text: summary, tokensUsed: 80 };
  }
}

// ── 构造一段长对话 ─────────────────────────────────────────────────────

function makeLongDialogue(): CompactorMessage[] {
  const messages: CompactorMessage[] = [
    // ── 头部（受保护） ────────────────────────
    {
      role: 'user',
      content: '你是一个 Rust 专家助手，工作目录在 /home/user/philont',
    },
    { role: 'assistant', content: '明白，我会帮你处理 Rust 相关的问题' },

    // ── 中间段（会被压缩的 12 条） ────────────
    { role: 'user', content: '我想给项目添加 auth 模块，你建议怎么组织？' },
    {
      role: 'assistant',
      content:
        '建议按照 module-per-feature 的结构，每个特性一个目录。auth 模块可以包含 mod.rs、middleware.rs、jwt.rs 等子文件。这种结构让相关代码聚集，便于维护。具体示例如下：'.repeat(
          5,
        ),
    },
    { role: 'user', content: '好的，那 db 模块呢？' },
    {
      role: 'assistant',
      content:
        '同样的模式。db 模块可以包含 connection.rs、migrations.rs、queries.rs。如果使用 sqlx，每个表对应一个 queries 子文件。这样的好处是：'.repeat(
          5,
        ),
    },
    { role: 'user', content: '我看你 trait 命名都用 -er 后缀，这是约定吗？' },
    {
      role: 'assistant',
      content:
        '是的，Rust 社区惯例是 trait 用动词的 -er 形式：Reader、Writer、Iterator、Hasher。这让 trait 看起来像"做某事的人/物"。具体例子：'.repeat(
          5,
        ),
    },
    {
      role: 'user',
      content:
        '我不太喜欢 builder pattern，函数名太长了。能用更简洁的方式吗？',
    },
    {
      role: 'assistant',
      content:
        '完全可以。Rust 不强制 builder。简单的构造可以用 ::new() 直接传所有参数；中等复杂可以用 Default + struct update syntax；只在参数特别多时才用 builder。建议如下：'.repeat(
          5,
        ),
    },
    {
      role: 'user',
      content: '我刚才那段代码的生命周期报错了，怎么修？',
    },
    {
      role: 'assistant',
      content:
        '看起来是借用范围太长。把 .iter() 改成 .iter().copied()，或者把 String 的引用改为 owned。具体修改方式：'.repeat(
          5,
        ),
    },
    { role: 'user', content: '好的，谢谢' },
    { role: 'assistant', content: '不客气' },

    // ── 尾部（受保护） ────────────────────────
    { role: 'user', content: '现在帮我看下 main.rs 的当前实现' },
    { role: 'assistant', content: '好的，我打开 main.rs 看看' },
    {
      role: 'user',
      content: '里面有什么需要改进的地方吗？',
    },
    {
      role: 'assistant',
      content: 'main 函数有点长，建议拆分出 setup_logging() 和 setup_db()',
    },
    { role: 'user', content: '你帮我重构一下' },
    { role: 'assistant', content: '好的，我开始重构' },
  ];
  return messages;
}

function printSection(title: string) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + title);
  console.log('═'.repeat(72));
}

async function main() {
  const memory = openMemoryDb(':memory:');
  const llm = new HumanSummaryLlm();
  const compactor = new Compactor(llm, memory.notes, {
    thresholdTokens: 1000, // 低阈值便于触发演示
    protectFirstN: 2,
    protectLastN: 6,
  });

  const messages = makeLongDialogue();

  printSection('压缩前');
  const tokensBefore = compactor.estimateTokens(messages);
  console.log(`  消息数: ${messages.length}`);
  console.log(`  估算 token: ${tokensBefore}`);
  console.log(`  阈值: 1000`);
  console.log(`  需要压缩: ${compactor.needsCompaction(messages) ? '✅ 是' : '❌ 否'}`);

  printSection('执行压缩');
  console.log('\n  调用 compactor.compact()...');
  const result = await compactor.compact(messages, 'demo-session');

  console.log(`\n  ✓ 压缩状态: ${result.didCompact ? '已执行' : '未执行'}`);
  console.log(`  ✓ LLM 调用次数: ${llm.callCount}`);
  console.log(`  ✓ Token 变化: ${result.tokensBefore} → ${result.tokensAfter}`);
  console.log(
    `  ✓ Token 减少: ${result.tokensBefore - result.tokensAfter} (${(
      (1 - result.tokensAfter / result.tokensBefore) * 100
    ).toFixed(1)}%)`,
  );
  console.log(`  ✓ 摘要写入笔记 id: ${result.summaryNoteId}`);

  printSection('压缩后的消息结构');
  console.log(`  消息数: ${messages.length} → ${result.compactedMessages.length}`);
  console.log('\n  消息序列：');
  for (let i = 0; i < result.compactedMessages.length; i++) {
    const m = result.compactedMessages[i];
    const text =
      typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
    const preview = text.slice(0, 80) + (text.length > 80 ? '...' : '');
    const isSummary = text.includes('上下文摘要');
    const marker = isSummary ? ' ⭐摘要' : '';
    console.log(`    ${i + 1}. [${m.role}]${marker} ${preview}`);
  }

  printSection('摘要可被 search_notes 召回');
  const searchResult = memory.notes.search('Rust');
  console.log(`\n  搜索 "Rust"：找到 ${searchResult.length} 条`);
  for (const note of searchResult) {
    console.log(`    importance=${note.importance}: ${note.content.slice(0, 100)}...`);
  }

  printSection('LLM 故障时的安全降级');
  class FailingLlm implements ExtractorLlmClient {
    async complete(): Promise<{ text: string; tokensUsed: number }> {
      throw new Error('模拟 LLM 故障');
    }
  }

  const compactor2 = new Compactor(new FailingLlm(), memory.notes, {
    thresholdTokens: 100,
    protectFirstN: 1,
    protectLastN: 1,
  });

  const messages2 = makeLongDialogue();
  const fallbackResult = await compactor2.compact(messages2);
  console.log(`\n  ✓ 压缩状态: ${fallbackResult.didCompact ? '已执行' : '未执行（安全降级）'}`);
  console.log(
    `  ✓ 消息数保持: ${messages2.length} → ${fallbackResult.compactedMessages.length}`,
  );
  console.log('  💡 LLM 故障时不抛错，原样返回消息，agent 继续运行');

  printSection('总结');
  console.log(`
  ✅ 检测：基于 token 估算自动判断是否需要压缩
  ✅ 保护：头部 ${2} 条 + 尾部 ${6} 条不动，确保系统提示和最近对话完整
  ✅ 摘要：调用 LLM 把中间段压缩为简短摘要
  ✅ 不丢失：摘要写入 memory_notes（importance=0.8），可被 search_notes 召回
  ✅ 降级：LLM 失败时返回原消息，不崩溃 agent loop
  ✅ Token 减少：${(((tokensBefore - result.tokensAfter) / tokensBefore) * 100).toFixed(1)}%

  🎯 完整闭环：检测 → 切分 → 摘要 → 替换 → 持久化 → 可召回
`);
}

main().catch(console.error);
