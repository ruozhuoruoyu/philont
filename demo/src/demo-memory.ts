/**
 * 记忆层成本对比 demo
 *
 * 演示核心理念：把 LLM 读记忆变成确定性 API 查找，token 成本骤降。
 *
 * 场景 A（无记忆层）：每次问用户信息都要把对话历史塞进 LLM，重复付费
 * 场景 B（有记忆层）：对话结束后提取到结构化存储，后续查询零 LLM 成本
 */

import {
  openMemoryDb,
  SessionExtractor,
  createMemoryTools,
  type ExtractorLlmClient,
} from '@agent/memory';

// ── Mock LLM：模拟 token 成本计量 ───────────────────────────────────────

interface MockLlmStats {
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

class MockLlm implements ExtractorLlmClient {
  stats: MockLlmStats = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };

  /** 每个中文字约 0.6 token，英文单词约 1.3 token（粗略估算） */
  private countTokens(text: string): number {
    return Math.ceil(text.length * 0.6);
  }

  async complete(prompt: string) {
    this.stats.totalCalls++;
    const promptTokens = this.countTokens(prompt);
    this.stats.totalPromptTokens += promptTokens;

    // 模拟提取响应
    let text = '';
    if (prompt.includes('提取')) {
      // 提取场景：识别 prompt 中的事实
      const facts: Array<{ namespace: string; key: string; value: string }> = [];
      if (prompt.includes('张三')) {
        facts.push({ namespace: 'user', key: 'name', value: '张三' });
      }
      if (prompt.includes('github.com/acme/core')) {
        facts.push({
          namespace: 'project',
          key: 'repo_url',
          value: 'github.com/acme/core',
        });
      }
      if (prompt.includes('北京')) {
        facts.push({ namespace: 'user', key: 'city', value: '北京' });
      }
      if (prompt.includes('Rust')) {
        facts.push({
          namespace: 'project',
          key: 'tech_stack',
          value: ['Rust', 'TypeScript'],
        });
      }
      text = JSON.stringify(
        facts.map((f) => ({ action: 'store_fact', ...f })),
      );
    } else {
      // 普通对话：返回一个假回答
      text = '好的，我已经记住了。';
    }

    this.stats.totalCompletionTokens += this.countTokens(text);
    return { text, tokensUsed: this.stats.totalCompletionTokens };
  }

  reset() {
    this.stats = {
      totalCalls: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    };
  }

  /** 按 Claude Sonnet 定价估算（$3/M input, $15/M output） */
  estimateCost(): number {
    const inputCost = (this.stats.totalPromptTokens / 1_000_000) * 3;
    const outputCost = (this.stats.totalCompletionTokens / 1_000_000) * 15;
    return inputCost + outputCost;
  }
}

// ── 场景 A：无记忆层 ────────────────────────────────────────────────────

async function scenarioA_NoMemory(mock: MockLlm, queries: string[]) {
  mock.reset();
  console.log('\n📋 场景 A：无记忆层（每次查询都重新注入对话历史）');
  console.log('─'.repeat(60));

  // 模拟初始对话，记录成 history（在后续每次 LLM 调用都需要全量注入）
  const history = [
    { role: 'user', content: '你好，我叫张三，我住在北京' },
    { role: 'assistant', content: '你好张三，很高兴认识你' },
    { role: 'user', content: '我的项目地址是 github.com/acme/core，主要用 Rust' },
    { role: 'assistant', content: '好的，我记住了' },
  ];

  // 每次查询都把完整历史注入
  for (const query of queries) {
    const prompt =
      history.map((m) => `[${m.role}] ${m.content}`).join('\n') +
      `\n[user] ${query}\n[assistant]`;
    await mock.complete(prompt);
  }

  console.log(`  LLM 调用次数: ${mock.stats.totalCalls}`);
  console.log(`  总 prompt tokens: ${mock.stats.totalPromptTokens}`);
  console.log(`  总 completion tokens: ${mock.stats.totalCompletionTokens}`);
  console.log(`  估算成本: $${mock.estimateCost().toFixed(6)}`);

  return { ...mock.stats, cost: mock.estimateCost() };
}

// ── 场景 B：有记忆层 ────────────────────────────────────────────────────

async function scenarioB_WithMemory(mock: MockLlm, queries: string[]) {
  mock.reset();
  console.log('\n✨ 场景 B：有记忆层（一次提取，后续零 LLM 成本）');
  console.log('─'.repeat(60));

  const { facts, notes, raw } = openMemoryDb(':memory:');

  // Step 1: 写入原始日志
  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '你好，我叫张三，我住在北京',
  });
  raw.appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '你好张三',
  });
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '项目地址是 github.com/acme/core，用 Rust',
  });

  // Step 2: 会话结束触发提取（一次 LLM 调用）
  const extractor = new SessionExtractor(mock, facts, notes, raw);
  const extractResult = await extractor.extractFromSession(session.id);
  console.log(`  [提取阶段] 一次 LLM 调用，存储 ${extractResult.factsStored} 条事实`);

  const extractTokensUsed = mock.stats.totalPromptTokens;
  const extractCost = mock.estimateCost();

  // Step 3: 后续查询全部走结构化 API（零 LLM 成本）
  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;

  let structuredCalls = 0;
  for (const query of queries) {
    // 模拟 agent 根据查询类型直接走结构化
    if (query.includes('叫什么') || query.includes('名字')) {
      await getFact.execute({ namespace: 'user', key: 'name' });
      structuredCalls++;
    } else if (query.includes('项目') || query.includes('地址') || query.includes('仓库')) {
      await getFact.execute({ namespace: 'project', key: 'repo_url' });
      structuredCalls++;
    } else if (query.includes('哪') || query.includes('城市')) {
      await getFact.execute({ namespace: 'user', key: 'city' });
      structuredCalls++;
    }
  }

  console.log(`  [查询阶段] 结构化 API 调用次数: ${structuredCalls}，LLM 调用次数: 0`);
  console.log(`  LLM 调用次数: ${mock.stats.totalCalls}（仅提取一次）`);
  console.log(`  总 prompt tokens: ${mock.stats.totalPromptTokens}`);
  console.log(`  总 completion tokens: ${mock.stats.totalCompletionTokens}`);
  console.log(`  估算成本: $${mock.estimateCost().toFixed(6)}`);

  return { ...mock.stats, cost: mock.estimateCost() };
}

// ── 主流程 ──────────────────────────────────────────────────────────────

function buildQueries(n: number): string[] {
  const base = [
    '我叫什么名字？',
    '我住哪个城市？',
    '我的项目地址是？',
    '我的名字',
    '我在哪个城市工作',
    '项目仓库地址',
  ];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out;
}

async function main() {
  console.log('═'.repeat(68));
  console.log('  记忆层成本对比 Demo');
  console.log('═'.repeat(68));
  console.log(
    '\n模拟场景：用户和 agent 初次对话建立档案，后续反复查询已知信息。',
  );
  console.log(
    '随着查询次数增加，结构化记忆的一次性提取成本摊薄，优势出现。\n',
  );

  const mock = new MockLlm();

  // ── 详细展示一次运行（10 次查询的情况）──────────────────────────────
  const demoQueries = buildQueries(10);
  console.log('━'.repeat(68));
  console.log(`  详细：10 次查询的情况`);
  console.log('━'.repeat(68));
  const a10 = await scenarioA_NoMemory(mock, demoQueries);
  const b10 = await scenarioB_WithMemory(mock, demoQueries);

  // ── 扫描不同规模，展示交叉点 ───────────────────────────────────────
  console.log('\n' + '━'.repeat(68));
  console.log('  规模扫描：查询次数 vs 成本（美元）');
  console.log('━'.repeat(68));
  console.log(
    `  ${'查询数'.padEnd(10)}${'A: 无记忆'.padEnd(18)}${'B: 有记忆'.padEnd(18)}节省`,
  );
  console.log('  ' + '─'.repeat(60));

  const scales = [1, 5, 10, 20, 50, 100, 500, 1000];
  let breakEven: number | null = null;
  for (const n of scales) {
    const queries = buildQueries(n);
    const aStats = await scenarioA_Silent(mock, queries);
    const bStats = await scenarioB_Silent(mock, queries);
    const saved = aStats.cost - bStats.cost;
    const savedPct = (saved / aStats.cost) * 100;
    const marker = saved > 0 && breakEven === null ? '  ← 交叉点' : '';
    if (saved > 0 && breakEven === null) breakEven = n;
    console.log(
      `  ${String(n).padEnd(10)}$${aStats.cost.toFixed(6).padEnd(16)}$${bStats.cost
        .toFixed(6)
        .padEnd(16)}${saved > 0 ? '+' : ''}${savedPct.toFixed(1)}%${marker}`,
    );
  }

  console.log('\n' + '═'.repeat(68));
  console.log('  关键洞察');
  console.log('═'.repeat(68));
  if (breakEven !== null) {
    console.log(`  💡 约在 ${breakEven} 次查询后结构化方案开始节省成本`);
  }
  console.log('  💡 查询次数越多，结构化方案的 ROI 越高（接近 100% 节省）');
  console.log('  💡 真实系统中，一条 user.name 可能被访问数千次，差距指数级放大');
  console.log(
    '  💡 结构化方案的核心价值：LLM 只在"理解新内容"时付费，不在"复述已知"时付费',
  );
  console.log('═'.repeat(68) + '\n');
}

/** Silent 版本：不打印中间过程，只返回统计 */
async function scenarioA_Silent(mock: MockLlm, queries: string[]) {
  mock.reset();
  const history = [
    { role: 'user', content: '你好，我叫张三，我住在北京' },
    { role: 'assistant', content: '你好张三' },
    { role: 'user', content: '项目地址 github.com/acme/core，用 Rust' },
    { role: 'assistant', content: '好' },
  ];
  for (const query of queries) {
    const prompt =
      history.map((m) => `[${m.role}] ${m.content}`).join('\n') +
      `\n[user] ${query}\n[assistant]`;
    await mock.complete(prompt);
  }
  return { ...mock.stats, cost: mock.estimateCost() };
}

async function scenarioB_Silent(mock: MockLlm, queries: string[]) {
  mock.reset();
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '你好，我叫张三，我住在北京',
  });
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '项目地址 github.com/acme/core，用 Rust',
  });
  const extractor = new SessionExtractor(mock, facts, notes, raw);
  await extractor.extractFromSession(session.id);

  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;
  for (const query of queries) {
    if (query.includes('名字') || query.includes('叫')) {
      await getFact.execute({ namespace: 'user', key: 'name' });
    } else if (query.includes('项目') || query.includes('仓库')) {
      await getFact.execute({ namespace: 'project', key: 'repo_url' });
    } else if (query.includes('城市') || query.includes('哪')) {
      await getFact.execute({ namespace: 'user', key: 'city' });
    }
  }
  return { ...mock.stats, cost: mock.estimateCost() };
}

main().catch(console.error);
