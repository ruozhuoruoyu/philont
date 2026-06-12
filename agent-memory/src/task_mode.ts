/**
 * Task mode classify (v17, 2026-05-11): entry point for the complex-task protocol
 *
 * LLM self-assesses task complexity at the start of a turn. Complex mode (slow) activates
 * plan_protocol_gate, forcing the plan_draft → plan_review → execute → plan_close protocol.
 * fast mode is unchanged, preserving backward compatibility (old sessions / chat / simple queries
 * all default to fast).
 *
 * Design choices (Q1 answer):
 *   - LLM self-assessment, not mechanism heuristics — delegate "what counts as complex" to LLM (it knows the context best)
 *   - Safety net: Phase 6.1 auto-slow on the Nth same task_signature (prevents LLM from missing the classification)
 *
 * Persistence: in-memory (one copy per server process); not written to sqlite. Defaults to fast after restart.
 */

import type { MemoryTool } from './tools.js';

export type TaskMode = 'fast' | 'slow';

export interface TaskModeStore {
  /** Get the current mode for a session, defaulting to 'fast' */
  get(sessionId: string): TaskMode;
  /** Set the session's mode and record reason */
  set(sessionId: string, mode: TaskMode, reason: string): void;
  /** Get the reason from the most recent set call (for auditing), returns null if absent */
  getLastReason(sessionId: string): string | null;
}

/**
 * In-memory KV implementation. chat-handler holds the singleton.
 * Unbounded capacity, but session count is bounded and will not grow unbounded.
 */
export class InMemoryTaskModeStore implements TaskModeStore {
  private readonly modes = new Map<string, TaskMode>();
  private readonly reasons = new Map<string, string>();

  get(sessionId: string): TaskMode {
    return this.modes.get(sessionId) ?? 'fast';
  }

  set(sessionId: string, mode: TaskMode, reason: string): void {
    this.modes.set(sessionId, mode);
    this.reasons.set(sessionId, reason);
  }

  getLastReason(sessionId: string): string | null {
    return this.reasons.get(sessionId) ?? null;
  }
}

export interface TaskModeToolsDeps {
  store: TaskModeStore;
  /** Injected by chat-handler when creating the toolset (returns the current turn's sessionId) */
  getCurrentSessionId: () => string;
  /**
   * Phase 10 P0 (2026-05-14): active plan probe.
   * Returns: if there is an active plan (status='draft'/'executing') → the plan's brief info.
   *          no active plan → null.
   * Purpose: on slow→fast rollback, reject if there is an active plan (prevents LLM from bypassing plan_protocol_gate).
   * Injected by chat-handler: () => memory.plans.listBySession(sid)[0] ?? null, filtering out terminal states.
   *
   * Phase 12 refactor (2026-05-17): removed 60s cooldown window logic.
   * The old design was because "task_mode is independent state, LLM can call task_mode_classify('fast') to bypass protocol";
   * the cooldown was a patch. The new design directly checks plan state: active plan (draft/executing) blocks slow→fast,
   * terminal state (failed/completed) allows it — task is done, LLM can re-evaluate. No cooldown needed.
   * updatedAt field retained (visible in audit) but no longer used for lock decisions.
   */
  getActivePlan?: () => {
    id: string;
    status: string;
    reviewCount: number;
    updatedAt: number;
  } | null;
}

export function createTaskModeTools(deps: TaskModeToolsDeps): MemoryTool[] {
  const { store, getCurrentSessionId, getActivePlan } = deps;

  const tool: MemoryTool = {
    name: 'task_mode_classify',
    description:
      '自评本次任务的复杂度,决定是否进入慢思考协议(plan_draft → plan_update_step → plan_close)。' +
      '\n\n【先排除:探索/审议型问题不走 plan 协议】用户要"深入探索/深入想清楚/帮我权衡/深攻一个难题"这类**开放问题**' +
      '(产出是理解/结论,不是对外部世界的执行)→ 直接调 deep_explore(它自带分解→验证→跨轮协议,豁免 plan 门),不要 classify。' +
      'plan 协议管的是**执行型任务**(部署/注册/发消息/改数据/产出文件)。' +
      '\n\n【调用前先自问 4 题 — 任一 yes → slow】' +
      '\nQ1 任务有 ≥ 2 个**独立可验证输出**?(例:"注册+发首条" = 2;"查 X" = 1)' +
      '\nQ2 步骤间有**依赖**(B 必须等 A 的结果,如先拿 token 才能调 API)?' +
      '\nQ3 有**外部世界写操作**(创建账号 / 发消息 / 部署 / 改远端数据)?' +
      '\n   有 → 倾向 slow,除非单次一次性 + 无后续验证' +
      '\nQ4 user 给了 **guide 文档 / URL / 多步骤指令**(## 多段 / 1./2./3. 列表)?' +
      '\n\n不符合 → fast(单次工具调用 / 单一意图回答 / 闲聊 / 短答追问)。' +
      '\n\n【reason 怎么写】' +
      '\n✓ "user 给 stripe guide 含 3 步:注册 / save key / 测 webhook" — 引证据' +
      '\n✓ "单查询 \'nodejs 哪个 LTS\'" — 简洁明确' +
      '\n✗ "复杂任务" — 没具体' +
      '\n✗ "用户要做事" — 空话' +
      '\n\n【effect】' +
      '\n- slow → 机制层强制下一步只能调 plan_* / task_mode_classify / read-only 工具(plan_protocol_gate)' +
      '\n  直到 plan 进入 executing(plan_update_step status="doing")' +
      '\n- fast → 走原路径,无 plan 协议约束' +
      '\n\n**slow 是契约,不是 hint** — 想跳过 plan_draft 直接干活会被 reject。' +
      '\n分类错时正确 fallback:plan_close(failure, "分类错") → 冷却 60s → task_mode_classify(fast)。',
    schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['fast', 'slow'],
          description: '任务模式',
        },
        reason: {
          type: 'string',
          description:
            '为什么选这个模式(简短 1-2 句)。例 slow:"用户给了 mycox guide 19 个 endpoint,要分步注册+鉴权+心跳"。' +
            '例 fast:"用户问 nodejs 哪个版本,单查询即可"。',
        },
      },
      required: ['mode', 'reason'],
    },
    capability: 'write',
    domain: 'self',
    async execute(params) {
      const mode = params.mode;
      if (mode !== 'fast' && mode !== 'slow') {
        return {
          success: false,
          output: '',
          error: `mode 必须是 'fast' 或 'slow',收到: ${String(mode).slice(0, 40)}`,
        };
      }
      const reasonRaw = params.reason;
      const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
      if (!reason) {
        return {
          success: false,
          output: '',
          error: 'reason 必填且非空(简短解释为什么选这个模式)',
        };
      }
      const sessionId = getCurrentSessionId();

      // Phase 12 refactor (2026-05-17): mode is derived from plan state; no independent setter can bypass the protocol.
      //
      // Principle: validity of slow→fast switch = plan is no longer in active state.
      //   - plan.status='draft' / 'executing' → protocol in progress, not allowed to switch to fast
      //   - plan.status='failed' / 'completed' / no plan → task ended, allowed to switch to fast
      //
      // Consistent with 3×4 PermissionMatrix design philosophy: state is derived, no independent setter can intrude.
      // The old "60s cooldown window" was a patch: LLM learned to combine plan_close('failure') + task_mode_classify('fast') to bypass the protocol;
      // cooldown blocked that path. But the root cause was mode being decoupled from plan — making mode derived from plan state
      // makes cooldown unnecessary. LLM wanting to exit slow must plan_close first; after close the next turn is naturally fast.
      //
      // env PHILONT_TASK_MODE_LOCK_ON_PLAN=0 disables this check (reverts to old behaviour).
      if (
        mode === 'fast' &&
        store.get(sessionId) === 'slow' &&
        getActivePlan &&
        process.env.PHILONT_TASK_MODE_LOCK_ON_PLAN !== '0'
      ) {
        const recent = getActivePlan();
        // Only draft/executing blocks the switch; terminal plan (failed/completed) allows it, task is done.
        if (recent && (recent.status === 'draft' || recent.status === 'executing')) {
          return {
            success: false,
            output: '',
            error:
              `[task_mode_lock] 不允许 slow→fast 回退:活 plan ${recent.id}` +
              `(status=${recent.status},${recent.reviewCount} 次 review)。\n` +
              `\nplan 协议尚未结束,不能切回 fast。这是结构性约束 — mode 派生于 plan 状态,` +
              `LLM 不能用切 mode 绕过 plan 协议跑业务工具。\n\n正确做法(二选一):` +
              `\n  - 任务卡住 → 调 plan_close({ plan_id: "${recent.id}", outcome: "failure", summary: "..." })` +
              ` 关闭 plan,然后可立即 task_mode_classify(fast)` +
              `\n  - 任务还在推进 → 调 plan_revise / plan_update_step 继续推 plan,不要切 mode` +
              `\n  - 任务已完成 → 调 plan_close({ outcome: "success", summary, deliverable_status })` +
              `,close 后自然 fast`,
          };
        }
      }

      store.set(sessionId, mode, reason);
      const nextHint =
        mode === 'slow'
          ? '\n下一步:**必须**调 plan_draft 把任务拆成可验证步骤(机制层已禁其它工具直到 plan_review pass)。' +
            '\n(例外:若这其实是"深入探索/审议一个开放问题"而非执行任务,直接调 deep_explore — 它豁免 plan 门,自带更严的逐 claim 验证协议。)'
          : '\n继续按 fast 模式工作,不需要走 plan 协议。';
      return {
        success: true,
        output: `任务模式: ${mode}\n原因: ${reason}${nextHint}`,
      };
    },
  };

  return [tool];
}
