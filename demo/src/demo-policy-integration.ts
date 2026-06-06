/**
 * Policy 层集成演示：事前拦截 + 工具调用 + 审计日志
 *
 * 展示完整的三层架构流程：
 *   1. Rust 内核通过 onToolCheck 回调在执行前拦截
 *   2. TypeScript 策略层做权限矩阵检查
 *   3. 应用层 delegate 实现工具调用逻辑
 */

import { interruptChannelJs, runAgentLoop } from '@agent/node';
import {
  withPolicy,
  createToolChecker,
  AuditLog,
  createDefaultMatrix,
  ToolRegistry,
  type PolicyConfig,
  type Delegate,
  type StepInput,
  type StepResult
} from '@agent/policy';
import {
  readFileTool,
  writeFileTool,
  httpTool,
  shellTool,
} from '@agent/tools';

// 初始化工具注册表
const registry = new ToolRegistry();
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(httpTool);
registry.register(shellTool);

/**
 * 创建 delegate：在工具执行前调用 checker（模拟 Rust 内核的 Phase 2 authorize）
 *
 * 说明：由于工具执行发生在 TypeScript 层，事前拦截需要在 delegate.step() 内显式调用。
 * Rust FFI 的 onToolCheck 仅在 Rust 内核自己注册工具时才生效（未来扩展）。
 */
function makeDelegate(policyConfig: PolicyConfig | null): Delegate {
  const checker = policyConfig ? createToolChecker(policyConfig) : null;

  // 统一的工具执行封装：先 check，后执行
  async function runTool(toolName: string, params: Record<string, unknown>) {
    if (checker) {
      const denial = await checker({ toolName, approval: 'never', params: JSON.stringify(params) });
      if (denial !== null) {
        return { success: false, output: '', error: denial };
      }
    }
    return registry.execute(toolName, params);
  }

  return {
    async step(input: StepInput): Promise<StepResult> {
      const lastMsg = input.messages[input.messages.length - 1];
      console.log(`\n[LLM] 收到: ${lastMsg.content.slice(0, 50)}`);

      if (lastMsg.content.includes('读取文件')) {
        const result = await runTool('readFile', { path: './package.json' });
        return {
          action: 'addMessages',
          addMessages: [{
            role: 'assistant',
            content: `读取结果: ${result.success ? '成功' : '失败 - ' + result.error}`
          }]
        };
      }

      if (lastMsg.content.includes('写入文件')) {
        const result = await runTool('writeFile', { path: './test.txt', content: 'Hello' });
        return {
          action: 'done',
          outcome: { outcomeType: 'response', text: `写入${result.success ? '成功' : '失败'}` }
        };
      }

      if (lastMsg.content.includes('执行命令')) {
        const result = await runTool('shell', { command: 'ls' });
        return {
          action: 'done',
          outcome: {
            outcomeType: 'response',
            text: result.success ? `命令执行成功` : `命令被拒绝: ${result.error}`
          }
        };
      }

      return {
        action: 'done',
        outcome: { outcomeType: 'response', text: '完成' }
      };
    },

    async onInterrupt() {
      return { action: 'continue' };
    }
  };
}

// 测试场景
async function testScenario(description: string, userMessage: string, usePreCheck: boolean) {
  console.log('\n' + '='.repeat(60));
  console.log(`${description} [${usePreCheck ? '事前拦截' : '事后记录'}]`);
  console.log('='.repeat(60));

  const audit = new AuditLog();
  const matrix = createDefaultMatrix();
  const classifyTool = (name: string) => registry.classify(name);
  const policyConfig: PolicyConfig = {
    permissions: matrix,
    audit,
    classifyTool,
  };

  // 事前拦截模式：delegate 内部用 checker
  // 事后记录模式：不传 policyConfig，delegate 直接执行工具
  const innerDelegate = makeDelegate(usePreCheck ? policyConfig : null);

  // 用 withPolicy 包装（审计 + 频率限制）
  const policyDelegate = withPolicy(innerDelegate, policyConfig);

  const { receiver, controller } = interruptChannelJs();
  const messages = [{ role: 'user' as const, content: userMessage }];

  // 同时启用 TaskSandbox（演示 FFI 参数通路）
  const options: Record<string, unknown> = {};
  if (usePreCheck) {
    options.sandboxLevel = 'task';
  }

  const outcome = await runAgentLoop(
    policyDelegate, messages, null, receiver, controller, 3, options
  );

  console.log(`\n结果: ${outcome.outcomeType}`);
  if (outcome.outcomeType === 'response') {
    console.log(`回复: ${outcome.text}`);
  }
  console.log(`审计事件: ${audit.length} 条`);

  // 检查是否有 pre_execution 阶段的拒绝
  const events = audit.getEvents();
  const preExecDenials = events.filter(
    e => e.type === 'permission_denied' && e.data?.phase === 'pre_execution'
  );
  if (preExecDenials.length > 0) {
    console.log(`事前拦截次数: ${preExecDenials.length}`);
    for (const d of preExecDenials) {
      console.log(`  ↳ ${d.data.toolName}: 在执行前被拒绝`);
    }
  }
}

// 运行测试
console.log('三层架构集成测试：Rust 内核 → TypeScript 策略层 → 应用层\n');

// 事后记录模式（原有行为）
await testScenario('场景1: 读取文件（允许）', '请读取文件', false);
await testScenario('场景2: 执行命令（拒绝-事后记录）', '请执行命令', false);

// 事前拦截模式（新增能力）
await testScenario('场景3: 读取文件（允许-事前检查）', '请读取文件', true);
await testScenario('场景4: 执行命令（拒绝-事前拦截）', '请执行命令', true);

console.log('\n✅ Policy 集成测试完成\n');
