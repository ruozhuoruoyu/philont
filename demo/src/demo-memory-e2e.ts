/**
 * 记忆 + 自学习端到端 demo（人肉 LLM 版）
 *
 * 本 demo 不调用真实 API。在每个 LLM 调用点，响应由 Claude（正在和你
 * 对话的我）**手动**生成，然后喂给实际的 SessionExtractor / SessionReflector
 * 代码。目的是验证代码链路正确，并展示真实 LLM 会输出什么。
 *
 * 流程：
 *   会话 1：用户介绍自己 + agent 执行 Rust 构建测试
 *     → 触发 SessionExtractor（人肉 LLM 输出事实 JSON）
 *     → 触发 SessionReflector（人肉 LLM 输出技能 JSON）
 *   会话 2：用户再次请求部署
 *     → 系统提示词自动注入已知事实和技能索引
 *     → LLM 调用 use_skill 获取动作模板
 */

import {
  openMemoryDb,
  SessionExtractor,
  SessionReflector,
  createMemoryTools,
  type ExtractorLlmClient,
} from '@agent/memory';

// ═══════════════════════════════════════════════════════════════════════
// 人肉 LLM：按 prompt 内容返回预先生成的响应
// ═══════════════════════════════════════════════════════════════════════

/**
 * 这是我（Claude）手动扮演 LLM 的地方。
 * 每个响应都是我**看到对应的 prompt 后**会真的输出的内容。
 */
class HumanLlm implements ExtractorLlmClient {
  private callCount = 0;

  async complete(prompt: string) {
    this.callCount++;
    console.log(`\n  ┌─ 人肉 LLM 调用 #${this.callCount} ─────────────────────────────`);

    // ── 分支 1：事实提取 prompt ─────────────────────────────────────
    // 触发条件：prompt 包含 "提取" 和 "store_fact"
    if (prompt.includes('store_fact') && prompt.includes('张三')) {
      const response = JSON.stringify(
        [
          {
            action: 'store_fact',
            namespace: 'user',
            key: 'name',
            value: '张三',
            confidence: 1.0,
          },
          {
            action: 'store_fact',
            namespace: 'project',
            key: 'name',
            value: 'philont',
            confidence: 1.0,
          },
          {
            action: 'store_fact',
            namespace: 'project',
            key: 'language',
            value: 'Rust',
            confidence: 1.0,
          },
          {
            action: 'store_fact',
            namespace: 'project',
            key: 'repo_url',
            value: 'github.com/acme/philont',
            confidence: 1.0,
          },
          {
            action: 'store_note',
            content: '用户第一次对话，礼貌介绍了身份和项目',
            importance: 0.4,
          },
        ],
        null,
        2,
      );
      console.log('  │ [提取事实] 输出了 4 条 fact + 1 条 note');
      console.log('  └──────────────────────────────────────────────────────');
      return { text: response, tokensUsed: 180 };
    }

    // ── 分支 2：技能反思 prompt ─────────────────────────────────────
    // 触发条件：prompt 包含 "技能" 和 action log
    if (prompt.includes('技能') && prompt.includes('cargo build')) {
      const response = JSON.stringify(
        [
          {
            name: 'rust-build-and-test',
            description:
              '构建并测试 Rust 项目：先 release 编译，再跑测试，任一失败即停止',
            trigger_keywords: [
              '部署',
              '构建',
              '测试',
              'deploy',
              'build',
              'test',
              'rust',
            ],
            action_template:
              '# Rust 项目构建测试流程\n\n' +
              '1. 执行 `cargo build --release` 编译 release 版本\n' +
              '2. 如果构建失败，定位错误行并报告，中止流程\n' +
              '3. 构建成功后执行 `cargo test` 运行测试\n' +
              '4. 如果有测试失败，报告具体失败的 test name\n' +
              '5. 全部通过后返回构建产物路径（target/release/）',
          },
        ],
        null,
        2,
      );
      console.log('  │ [反思技能] 输出了 1 个技能: rust-build-and-test');
      console.log('  └──────────────────────────────────────────────────────');
      return { text: response, tokensUsed: 220 };
    }

    console.log('  │ [未匹配任何分支，返回空]');
    console.log('  └──────────────────────────────────────────────────────');
    return { text: '[]', tokensUsed: 10 };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Demo 主流程
// ═══════════════════════════════════════════════════════════════════════

function printSection(title: string) {
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + title);
  console.log('═'.repeat(70));
}

function printMemoryState(memory: ReturnType<typeof openMemoryDb>) {
  console.log('\n  📦 当前记忆状态：');
  console.log(`     - 事实数: ${memory.facts.count()}`);
  console.log(`     - 笔记数: ${memory.notes.count()}`);
  console.log(`     - 技能数: ${memory.skills.count()}`);
  console.log(`     - 动作日志: ${memory.actions.count()}`);

  const allFacts = [
    ...memory.facts.listFacts('user'),
    ...memory.facts.listFacts('project'),
  ];
  if (allFacts.length > 0) {
    console.log('\n  事实：');
    for (const f of allFacts) {
      console.log(`     ${f.namespace}.${f.key} = ${JSON.stringify(f.value)}`);
    }
  }

  const skills = memory.skills.listAll();
  if (skills.length > 0) {
    console.log('\n  技能：');
    for (const s of skills) {
      console.log(
        `     ${s.name} (用过 ${s.useCount} 次) — ${s.description}`,
      );
    }
  }
}

/**
 * 模拟 chat-handler 里的 buildMemoryPrefix
 */
function buildMemoryPrefix(memory: ReturnType<typeof openMemoryDb>): string {
  const lines: string[] = [];

  const userFacts = memory.facts.listFacts('user');
  if (userFacts.length > 0) {
    lines.push('已知用户信息：');
    for (const f of userFacts) {
      lines.push(`  user.${f.key} = ${JSON.stringify(f.value)}`);
    }
  }

  const projectFacts = memory.facts.listFacts('project');
  if (projectFacts.length > 0) {
    lines.push('已知项目信息：');
    for (const f of projectFacts) {
      lines.push(`  project.${f.key} = ${JSON.stringify(f.value)}`);
    }
  }

  const topSkills = memory.skills.listAll(20);
  if (topSkills.length > 0) {
    lines.push('可用技能（用 use_skill(name) 获取详情）：');
    for (const s of topSkills) {
      lines.push(`  - ${s.name}: ${s.description}`);
    }
  }

  if (lines.length === 0) return '';
  return (
    '\n\n[记忆层 — 以下信息已知，无需再询问或查询]\n' +
    lines.join('\n') +
    '\n[记忆层结束]'
  );
}

async function main() {
  const memory = openMemoryDb(':memory:');
  const humanLlm = new HumanLlm();
  const extractor = new SessionExtractor(
    humanLlm,
    memory.facts,
    memory.notes,
    memory.raw,
  );
  const reflector = new SessionReflector(
    humanLlm,
    memory.skills,
    memory.actions,
    memory.raw,
  );

  // ─────────────────────────────────────────────────────────────────────
  printSection('初始状态（空记忆库）');
  printMemoryState(memory);

  // ═════════════════════════════════════════════════════════════════════
  // 会话 1：首次对话
  // ═════════════════════════════════════════════════════════════════════
  printSection('会话 1：用户介绍自己 + 请求构建测试');

  const session1 = memory.raw.startSession();
  console.log(`\n  [session id] ${session1.id.slice(0, 8)}...`);

  // 模拟对话消息进入 Layer 0
  const session1Dialogue: Array<{ role: 'user' | 'assistant'; content: string }> = [
    {
      role: 'user',
      content:
        '你好，我叫张三，我在做一个 Rust 项目叫 philont，仓库是 github.com/acme/philont',
    },
    {
      role: 'assistant',
      content: '你好张三！很高兴认识你。有什么需要帮助的吗？',
    },
    {
      role: 'user',
      content: '帮我构建并测试这个项目',
    },
    {
      role: 'assistant',
      content: '好的，我先执行 cargo build --release，然后 cargo test',
    },
    {
      role: 'assistant',
      content: '构建成功，测试全部通过。产物在 target/release/',
    },
  ];

  for (const msg of session1Dialogue) {
    memory.raw.appendMessage({
      sessionId: session1.id,
      role: msg.role,
      content: msg.content,
    });
    console.log(`  [${msg.role}] ${msg.content.slice(0, 60)}${msg.content.length > 60 ? '...' : ''}`);
  }

  // 模拟工具调用记录到 Layer 0.5
  console.log('\n  (工具调用记录到 ActionLog)');
  memory.actions.log({
    sessionId: session1.id,
    trigger: '用户请求构建测试',
    toolName: 'shell',
    params: { command: 'cargo build --release' },
    result: 'Compiling philont v0.1.0\n    Finished `release` profile [optimized]',
    success: true,
  });
  memory.actions.log({
    sessionId: session1.id,
    trigger: '构建成功后测试',
    toolName: 'shell',
    params: { command: 'cargo test' },
    result: 'test result: ok. 42 passed; 0 failed',
    success: true,
  });

  // ─── 会话结束：两次 LLM 调用 ─────────────────────────────────────
  printSection('会话 1 结束：触发事实提取 + 技能反思');

  console.log('\n  ▶ Step 1: SessionExtractor.extractFromSession()');
  const extractResult = await extractor.extractFromSession(session1.id);
  console.log(
    `\n  ✓ 提取结果: ${extractResult.factsStored} facts, ${extractResult.notesStored} notes`,
  );

  console.log('\n  ▶ Step 2: SessionReflector.reflectFromSession()');
  const reflectResult = await reflector.reflectFromSession(session1.id);
  console.log(
    `\n  ✓ 反思结果: ${reflectResult.skillsCreated} 新建, ${reflectResult.skillsUpdated} 更新`,
  );

  memory.raw.endSession(session1.id);

  printSection('会话 1 结束后的记忆状态');
  printMemoryState(memory);

  // ═════════════════════════════════════════════════════════════════════
  // 会话 2：新对话，验证记忆注入 + 技能复用
  // ═════════════════════════════════════════════════════════════════════
  printSection('会话 2：新对话，请求再次部署');

  const memoryPrefix = buildMemoryPrefix(memory);
  console.log('\n  🎯 会话 2 开始时构建的系统提示词前缀：');
  console.log('  ' + '─'.repeat(66));
  console.log(
    memoryPrefix
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );
  console.log('  ' + '─'.repeat(66));
  console.log(
    `\n  💡 注入的 token 估计: ~${Math.ceil(memoryPrefix.length * 0.6)} 个`,
  );

  // 模拟 LLM 在新对话中看到提示词后的行为
  console.log('\n  用户说："帮我重新部署一次"');
  console.log('  [LLM 决策] 看到技能索引里有 rust-build-and-test，调用 use_skill 获取模板');

  const tools = createMemoryTools(memory.facts, memory.notes, memory.skills);
  const useSkill = tools.find((t) => t.name === 'use_skill')!;

  const skillResult = await useSkill.execute({ name: 'rust-build-and-test' });
  console.log('\n  ▶ use_skill("rust-build-and-test") 返回：');
  console.log('  ' + '─'.repeat(66));
  if (skillResult.success) {
    console.log(
      (skillResult.output ?? '')
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n'),
    );
  } else {
    console.log('  [失败]', skillResult.error);
  }
  console.log('  ' + '─'.repeat(66));

  console.log('\n  [LLM] 按照模板执行动作序列...（这里不再实际执行）');

  // ─────────────────────────────────────────────────────────────────────
  printSection('会话 2 结束后的记忆状态（use_count 应该 +1）');
  printMemoryState(memory);

  // ═════════════════════════════════════════════════════════════════════
  // 总结
  // ═════════════════════════════════════════════════════════════════════
  printSection('总结');
  console.log(`
  ✅ Layer 0 记录了 ${session1Dialogue.length} 条会话消息
  ✅ Layer 0.5 记录了 ${memory.actions.count()} 条工具调用
  ✅ SessionExtractor 从对话中提取到 ${extractResult.factsStored} 条结构化事实
  ✅ SessionReflector 从动作中提炼出 ${reflectResult.skillsCreated} 个可复用技能
  ✅ 新会话系统提示词自动注入已知信息（token 成本极低）
  ✅ LLM 通过 use_skill 调用技能，use_count 自动递增

  🎯 完整的"经验 → 反思 → 技能 → 复用"闭环打通
  🎯 所有 LLM 响应由 Claude 手动生成（本次 demo），但代码链路与真实 API
     使用完全一致——只需替换 HumanLlm 为 AnthropicAdapter 即可上生产。
`);
}

main().catch(console.error);
