/**
 * mock-agent-node.ts — @agent/node 的 TypeScript 模拟实现
 *
 * 目的：无需编译 Rust native module 即可运行 Demo，验证三层架构设计。
 * 切换方式：将所有 import 从 './mock-agent-node.js' 替换为 '@agent/node'
 *
 * 行为与 Rust 实现完全对等：
 *   - CRITICAL 优先于 HIGH 优先于 NORMAL（biased 语义）
 *   - HIGH 信号在 await step() 期间到达，于下一轮迭代开头处理
 *   - NORMAL 信号在 step() 完成后 drain（不打断步骤）
 *   - step() 返回 addMessages 时追加到 context 后继续
 */

// ── 共享类型（与 @agent/node 自动生成的 .d.ts 一致）─────────────────────────

export interface JsMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string | null;
  toolName?: string | null;
}

export interface JsToolDefinition {
  name: string;
  description: string;
  parameters: string;
}

export interface JsStepInput {
  messages:  JsMessage[];
  tools:     JsToolDefinition[];
  iteration: number;
  mode:      'Normal' | 'Quick';
}

export type JsStepResult =
  | { action: 'continue' }
  | { action: 'done';             outcome: JsLoopOutcome }
  | { action: 'addMessages';      addMessages: JsMessage[] }
  | { action: 'continueWithHint'; expectedMs: number };

export type JsLoopOutcome =
  | { outcomeType: 'response';      text: string }
  | { outcomeType: 'interrupted';   signalType: string; signalPayload?: string | null }
  | { outcomeType: 'suspended';     reason: string }
  | { outcomeType: 'terminated';    reason: string }
  | { outcomeType: 'maxIterations' };

export interface JsAgentInterrupt {
  signalType: string;
  payload?:   string | null;
}

export interface JsInterruptInput {
  signal:   JsAgentInterrupt;
  messages: JsMessage[];
}

export type JsInterruptAction =
  | { action: 'continue' }
  | { action: 'injectMessage'; message: string }
  | { action: 'terminate';     reason: string }
  | { action: 'suspend';       reason: string };

// ── 中断通道 ──────────────────────────────────────────────────────────────────

/** 优先级队列（对应 Rust 的 4 个 mpsc 通道） */
interface PriorityQueues {
  critical: JsAgentInterrupt[];
  high:     JsAgentInterrupt[];
  normal:   JsAgentInterrupt[];
  low:      JsAgentInterrupt[];
}

export class JsInterruptController {
  constructor(private readonly q: PriorityQueues) {}

  sendCritical(signal: JsAgentInterrupt): void { this.q.critical.push(signal); }
  sendHigh    (signal: JsAgentInterrupt): void { this.q.high.push(signal); }
  sendNormal  (signal: JsAgentInterrupt): void { this.q.normal.push(signal); }
  sendLow     (signal: JsAgentInterrupt): void { this.q.low.push(signal); }

  /** 便捷：立即停止 */
  hardStop(): void {
    this.sendCritical({ signalType: 'UserHardStop' });
  }
  /** 便捷：引导消息（HIGH） */
  steer(message: string): void {
    this.sendHigh({ signalType: 'SteerMessage', payload: message });
  }
}

export class JsInterruptReceiver {
  /** 仅内部可用 */
  constructor(readonly _queues: PriorityQueues) {}
}

/** 创建一对 (controller, receiver) */
export function interruptChannelJs(): {
  controller: JsInterruptController;
  receiver:   JsInterruptReceiver;
} {
  const q: PriorityQueues = { critical: [], high: [], normal: [], low: [] };
  return {
    controller: new JsInterruptController(q),
    receiver:   new JsInterruptReceiver(q),
  };
}

// ── run_agent_loop ────────────────────────────────────────────────────────────

export interface Delegate {
  step:        (input: JsStepInput)      => Promise<JsStepResult>;
  onInterrupt: (input: JsInterruptInput) => Promise<JsInterruptAction>;
}

/**
 * 中断驱动的 Agent 主循环（TypeScript 模拟 Rust tokio::select! biased）
 *
 * 优先级：CRITICAL > HIGH > NORMAL(step) > NORMAL drain > LOW
 */
export async function runAgentLoop(
  delegate:      Delegate,
  initialMsgs:   JsMessage[],
  systemPrompt:  string | null,
  receiver:      JsInterruptReceiver,
  maxIterations: number,
): Promise<JsLoopOutcome> {
  const q = receiver._queues;

  // 运行时消息上下文（Rust 侧由 AgentContext 维护）
  const messages: JsMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...initialMsgs]
    : [...initialMsgs];

  let nextMode: 'Normal' | 'Quick' = 'Normal';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const mode = nextMode;
    nextMode = 'Normal';

    // ── CRITICAL：立即终止 ─────────────────────────────────────────────────
    const critical = q.critical.shift();
    if (critical) {
      return { outcomeType: 'interrupted', signalType: critical.signalType, signalPayload: critical.payload };
    }

    // ── HIGH：处理完继续，下一步切换为 Quick ──────────────────────────────
    const high = q.high.shift();
    if (high) {
      const action = await delegate.onInterrupt({ signal: high, messages: [...messages] });
      if (action.action === 'terminate')     return { outcomeType: 'terminated', reason: action.reason };
      if (action.action === 'suspend')       return { outcomeType: 'suspended',  reason: action.reason };
      if (action.action === 'injectMessage') messages.push({ role: 'user', content: action.message });
      nextMode = 'Quick'; // HIGH 处理后快速确认
      continue;
    }

    // ── NORMAL：执行 step（在 await 期间，setTimeout 可以填充中断队列）───
    const result = await delegate.step({
      messages: [...messages],
      tools: [],
      iteration,
      mode,
    });

    // ── CRITICAL 补检：step await 期间到达的 CRITICAL（近似 biased select）──
    const criticalMid = q.critical.shift();
    if (criticalMid) {
      return { outcomeType: 'interrupted', signalType: criticalMid.signalType, signalPayload: criticalMid.payload };
    }

    // ── NORMAL drain：step 完成后处理 NORMAL 级内驱信号 ───────────────────
    let sig: JsAgentInterrupt | undefined;
    while ((sig = q.normal.shift()) !== undefined) {
      const action = await delegate.onInterrupt({ signal: sig, messages: [...messages] });
      if (action.action === 'terminate')     return { outcomeType: 'terminated', reason: action.reason };
      if (action.action === 'suspend')       return { outcomeType: 'suspended',  reason: action.reason };
      if (action.action === 'injectMessage') messages.push({ role: 'user', content: action.message });
    }

    // ── 处理 step 结果 ────────────────────────────────────────────────────
    if (result.action === 'done')         return result.outcome;
    if (result.action === 'addMessages')  messages.push(...result.addMessages);
    // 'continue' | 'continueWithHint' → 继续下一轮
  }

  return { outcomeType: 'maxIterations' };
}
