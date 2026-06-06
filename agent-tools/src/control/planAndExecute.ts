/**
 * planAndExecute — general-purpose long-task plan-then-execute + subagent dispatch composite tool
 *
 * Parent turn view: 1 tool_use → 1 tool_result.
 * Internally: LLM breaks the task into sub-tasks → each sub-task runs its own mini-agent-loop → results are aggregated and returned.
 *
 * Three phases:
 *   1. planPhase   — LLM outputs structured sub-tasks (JSON)
 *   2. executePhase — run in topo order; failed downstream tasks are auto-skipped (continue strategy)
 *   3. aggregatePhase — concat or llm-summary
 *
 * Intentionally not done:
 *   - parallel sub-tasks (race conditions + debugging hell)
 *   - nested planAndExecute (rejected by blacklist)
 *   - cross server-restart persistence
 *   - keyword-detection auto-trigger
 *
 * Design doc: /root/.claude/plans/misty-juggling-mist.md
 */

import type { Tool, ToolDefinition } from '@agent/policy';
import {
  runMiniAgentLoop,
  type MiniLoopLLMClient,
  type MiniLoopToolRunResult,
} from '../utils/mini-agent-loop.js';
import { callAuxLLM, AuxLLMError } from '../utils/aux-llm.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface SubTask {
  id: string;
  description: string;
  expectedOutput?: string;
  dependsOn: string[]; // references the ids of other sub-tasks
  suggestedTools?: string[];
}

interface PlanOk {
  ok: true;
  subTasks: SubTask[];
  tooSimple: boolean;
}
interface PlanErr {
  ok: false;
  error: string;
}

export type SubTaskStatus = 'success' | 'failed' | 'skipped';

export interface SubTaskResult {
  id: string;
  description: string;
  status: SubTaskStatus;
  finalText: string;
  toolCallCount: number;
  iters: number;
  hitCap: boolean;
  error?: string;
  /** When skipped due to upstream failure, records which upstream caused it */
  skippedBecauseOf?: string;
}

export interface PlanAndExecuteStructuredResult {
  plan: {
    subTaskCount: number;
    dependencyChains: number;
  };
  results: SubTaskResult[];
  totals: {
    iters: number;
    llmTokens: number;
    toolCalls: number;
    durationMs: number;
  };
}

// ── Budget ─────────────────────────────────────────────────────────────

export class PlanBudgetTracker {
  private llmTokens = 0;
  private toolCalls = 0;
  private startedAt = Date.now();

  constructor(
    private opts: {
      maxLlmTokensTotal?: number;
      maxToolCallsTotal?: number;
      maxWallclockMs?: number;
    } = {},
  ) {}

  reserveSubTask(estimateTokens: number): { allowed: boolean; reason?: string } {
    const maxTokens = this.opts.maxLlmTokensTotal ?? 30_000;
    const maxToolCalls = this.opts.maxToolCallsTotal ?? 50;
    const maxMs = this.opts.maxWallclockMs ?? 300_000;

    const wallElapsed = Date.now() - this.startedAt;
    if (wallElapsed >= maxMs) {
      return {
        allowed: false,
        reason: `wallclock reached ${wallElapsed}ms / ${maxMs}ms`,
      };
    }
    if (this.llmTokens + estimateTokens > maxTokens) {
      return {
        allowed: false,
        reason: `LLM tokens ${this.llmTokens} + est. ${estimateTokens} exceed ${maxTokens}`,
      };
    }
    if (this.toolCalls >= maxToolCalls) {
      return {
        allowed: false,
        reason: `tool calls ${this.toolCalls} reached ${maxToolCalls}`,
      };
    }
    return { allowed: true };
  }

  commit(spent: { llmTokens: number; toolCalls: number }): void {
    this.llmTokens += spent.llmTokens;
    this.toolCalls += spent.toolCalls;
  }

  remaining(): {
    tokens: number;
    toolCalls: number;
    ms: number;
  } {
    const maxTokens = this.opts.maxLlmTokensTotal ?? 30_000;
    const maxToolCalls = this.opts.maxToolCallsTotal ?? 50;
    const maxMs = this.opts.maxWallclockMs ?? 300_000;
    return {
      tokens: Math.max(0, maxTokens - this.llmTokens),
      toolCalls: Math.max(0, maxToolCalls - this.toolCalls),
      ms: Math.max(0, maxMs - (Date.now() - this.startedAt)),
    };
  }

  totals(): { llmTokens: number; toolCalls: number; durationMs: number } {
    return {
      llmTokens: this.llmTokens,
      toolCalls: this.toolCalls,
      durationMs: Date.now() - this.startedAt,
    };
  }
}

// ── Plan Phase ─────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a task decomposer. Break the user's complex task into a list of executable sub-tasks.

**Rules**:
1. Each sub-task must be completable by one isolated mini-agent-loop within ~8 tool-call steps.
2. Each sub-task must have a clear expectedOutput (an artifact or a verifiable result).
3. Minimize dependencies: declare dependsOn only when an upstream artifact is actually required.
4. Prefer the coarsest granularity: if 3 steps suffice, don't split into 5.
5. If the whole task fits in 1 sub-task, return just 1 — the caller will recognize "task too simple, should call the tool directly".

**Output format** (strict JSON, no surrounding text):
{
  "subTasks": [
    {
      "id": "st-1",
      "description": "...a single-step executable task description...",
      "expectedOutput": "...the form of the artifact (file path / data schema / conclusion)...",
      "dependsOn": [],
      "suggestedTools": ["readFile", "writeFile"]
    }
  ]
}

**dependsOn usage**: array elements are the ids of other sub-tasks (e.g. ["st-1"]). Use [] for no dependency.
**Forbidden**: circular dependencies, nesting planAndExecute, stuffing code snippets into a sub-task description (use tool calls).
**Max sub-tasks**: see the maxSubTasks limit in the user message.`;

function buildPlannerUserMessage(
  task: string,
  context: string | undefined,
  maxSubTasks: number,
): string {
  const ctx = context?.trim() ? `\n\n## Known context\n${context}` : '';
  return (
    `## Task\n${task}` +
    ctx +
    `\n\n## Constraints\n- At most ${maxSubTasks} sub-tasks\n- Strict JSON output, no markdown wrapper needed\n- For a single-step task, return just 1 sub-task`
  );
}

/**
 * 3-tier fault-tolerant JSON parsing (mirrored from agent-memory/src/autonomous/executor.ts:294).
 */
function parsePlannerOutput(text: string): unknown | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;

  try {
    return JSON.parse(text.trim());
  } catch {
    /* try next */
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* try next */
    }
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }

  return null;
}

function validateAndNormalize(raw: unknown, maxSubTasks: number): PlanOk | PlanErr {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'planner output is not an object' };
  }
  const obj = raw as Record<string, unknown>;
  const subTasksRaw = obj.subTasks;
  if (!Array.isArray(subTasksRaw) || subTasksRaw.length === 0) {
    return { ok: false, error: 'planner output is missing the subTasks array or it is empty' };
  }

  const subTasks: SubTask[] = [];
  for (const stRaw of subTasksRaw) {
    if (!stRaw || typeof stRaw !== 'object') continue;
    const st = stRaw as Record<string, unknown>;
    const id = typeof st.id === 'string' ? st.id : '';
    const description = typeof st.description === 'string' ? st.description : '';
    if (!id || !description) continue;
    const dependsOn = Array.isArray(st.dependsOn)
      ? (st.dependsOn.filter((x) => typeof x === 'string') as string[])
      : [];
    const expectedOutput =
      typeof st.expectedOutput === 'string' ? st.expectedOutput : undefined;
    const suggestedTools = Array.isArray(st.suggestedTools)
      ? (st.suggestedTools.filter((x) => typeof x === 'string') as string[])
      : undefined;
    subTasks.push({ id, description, expectedOutput, dependsOn, suggestedTools });
  }

  if (subTasks.length === 0) {
    return { ok: false, error: 'no subTasks had a valid id/description' };
  }
  if (subTasks.length > maxSubTasks) {
    // Truncate rather than reject (LLM may split into more than needed, but the first few can still be useful)
    subTasks.length = maxSubTasks;
  }

  // Validate dependsOn references are valid
  const ids = new Set(subTasks.map((s) => s.id));
  for (const st of subTasks) {
    for (const dep of st.dependsOn) {
      if (!ids.has(dep)) {
        return {
          ok: false,
          error: `sub-task '${st.id}' references a nonexistent dep '${dep}'`,
        };
      }
    }
  }

  // Validate + topo: DFS to find cycles
  const cycle = detectCycle(subTasks);
  if (cycle) {
    return { ok: false, error: `dependency graph has a cycle: ${cycle.join(' → ')}` };
  }

  return { ok: true, subTasks, tooSimple: subTasks.length === 1 };
}

function detectCycle(subTasks: SubTask[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const st of subTasks) adj.set(st.id, st.dependsOn);

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const st of subTasks) color.set(st.id, WHITE);

  function dfs(node: string, path: string[]): string[] | null {
    color.set(node, GRAY);
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // Cycle found, extract the cycle segment
        const idx = path.indexOf(next);
        return path.slice(idx).concat([next]);
      }
      if (c === WHITE) {
        const result = dfs(next, path);
        if (result) return result;
      }
    }
    path.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const st of subTasks) {
    if ((color.get(st.id) ?? WHITE) === WHITE) {
      const cycle = dfs(st.id, []);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Topological sort. Precondition: no cycles confirmed.
 */
function topoSort(subTasks: SubTask[]): SubTask[] {
  const result: SubTask[] = [];
  const inDegree = new Map<string, number>();
  const byId = new Map<string, SubTask>();
  const dependents = new Map<string, string[]>(); // dep_id → ids of sub-tasks that depend on it

  for (const st of subTasks) {
    inDegree.set(st.id, st.dependsOn.length);
    byId.set(st.id, st);
    dependents.set(st.id, []);
  }
  for (const st of subTasks) {
    for (const dep of st.dependsOn) {
      dependents.get(dep)?.push(st.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const st = byId.get(id);
    if (st) result.push(st);
    for (const downstream of dependents.get(id) ?? []) {
      const d = (inDegree.get(downstream) ?? 0) - 1;
      inDegree.set(downstream, d);
      if (d === 0) queue.push(downstream);
    }
  }
  return result;
}

// ── Factory ────────────────────────────────────────────────────────────

export interface PlanAndExecuteDeps {
  llm: MiniLoopLLMClient;
  toolRunner: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<MiniLoopToolRunResult>;
  toolDefs: ToolDefinition[];
  budgetTracker?: PlanBudgetTracker;
  defaultMaxIters?: number;
  defaultMaxSubTasks?: number;
  toolBlacklist?: ReadonlySet<string>;
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
  /** Progress callback, fired at the start and end of each sub-task */
  onProgress?: (text: string) => void;
}

const DEFAULT_BLACKLIST = new Set([
  'planAndExecute',
  'askUserQuestion',
  'installSkill',
  'uninstallSkill',
]);

export function createPlanAndExecuteTool(deps: PlanAndExecuteDeps): Tool {
  const {
    llm,
    toolRunner,
    toolDefs,
    defaultMaxIters = 8,
    defaultMaxSubTasks = 6,
    toolBlacklist = DEFAULT_BLACKLIST,
    logger,
    onProgress,
  } = deps;

  return {
    name: 'planAndExecute',
    description:
      '[When to use] Complex multi-step tasks (e.g.: generate an artifact from a source doc / cross-file refactor / a read→write→verify chain / ≥5-step flows).' +
      '\n[When not to use] Single-step operations (call the tool directly), tasks needing mid-way user input, clearly ≤3-step small tasks.' +
      '\n[Mechanism] I first plan (an LLM breaks the task into a sub-task list) → run each sub-task in an isolated mini-loop → aggregate and return. From the parent turn it completes in 1 iter, running N×8 internal steps without hitting the parent cap.' +
      '\n[Note] Sub-tasks communicate via the filesystem (write path → read path); do not stuff large artifacts into the description.',
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Full task description: goal + constraints + expected artifact' },
        context: { type: 'string', description: 'Extra context (paths of files already read / known info)' },
        maxSubTasks: {
          type: 'integer',
          minimum: 1,
          maximum: 12,
          description: 'Maximum sub-tasks to break into during planning, default 6',
        },
        maxItersPerSubTask: {
          type: 'integer',
          minimum: 2,
          maximum: 15,
          description: 'Mini-loop iteration cap per sub-task, default 8',
        },
        aggregateMode: {
          type: 'string',
          enum: ['concat', 'llm-summary'],
          description: 'Aggregation mode: concat = concatenate / llm-summary = one extra LLM call to summarize (default)',
        },
        toolWhitelist: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the sub-loop to only these tools, optional',
        },
      },
      required: ['task'],
    },
    capability: 'execute',
    domain: 'self',
    async execute(params) {
      const task = (params.task as string) ?? '';
      const context = (params.context as string) ?? '';
      const maxSubTasks = clampInt(
        params.maxSubTasks as number,
        1,
        12,
        defaultMaxSubTasks,
      );
      const maxItersPerSubTask = clampInt(
        params.maxItersPerSubTask as number,
        2,
        15,
        defaultMaxIters,
      );
      const aggregateMode =
        params.aggregateMode === 'concat' ? 'concat' : 'llm-summary';
      const userWhitelist = Array.isArray(params.toolWhitelist)
        ? new Set((params.toolWhitelist as unknown[]).filter((x): x is string => typeof x === 'string'))
        : undefined;

      if (!task.trim()) {
        return { success: false, output: '', error: 'task is required' };
      }

      const budgetTracker = deps.budgetTracker ?? new PlanBudgetTracker();

      onProgress?.(`▸ plan phase: decompose (max ${maxSubTasks} sub-tasks)`);

      const planResult = await runPlanPhase(
        llm,
        task,
        context,
        maxSubTasks,
        toolDefs,
      );

      if (!planResult.ok) {
        return {
          success: false,
          output: '',
          error: `plan phase failed: ${planResult.error}`,
        };
      }

      if (planResult.tooSimple) {
        const only = planResult.subTasks[0];
        return {
          success: true,
          output:
            `Task too simple for planAndExecute — just call the relevant tool directly.\n` +
            `The LLM's single-step suggestion: ${only.description}` +
            (only.suggestedTools?.length
              ? `\nSuggested tools: ${only.suggestedTools.join(', ')}`
              : ''),
        };
      }

      onProgress?.(`▸ plan: ${planResult.subTasks.length} sub-tasks`);
      logger?.log(
        `[plan-execute] plan: ${planResult.subTasks.map((s) => s.id).join(' → ')}`,
      );

      // Run in topological order
      const ordered = topoSort(planResult.subTasks);

      const results = await runExecutePhase({
        ordered,
        parentTask: task,
        llm,
        toolDefs,
        toolRunner,
        toolWhitelist: userWhitelist,
        toolBlacklist,
        maxIters: maxItersPerSubTask,
        budgetTracker,
        onProgress,
        logger,
      });

      onProgress?.(`▸ aggregate (${aggregateMode})`);
      const aggregated = await runAggregatePhase(task, results, aggregateMode);

      const totals = budgetTracker.totals();
      const structured: PlanAndExecuteStructuredResult = {
        plan: {
          subTaskCount: ordered.length,
          dependencyChains: countDependencyChains(ordered),
        },
        results,
        totals: {
          iters: results.reduce((sum, r) => sum + r.iters, 0),
          llmTokens: totals.llmTokens,
          toolCalls: totals.toolCalls,
          durationMs: totals.durationMs,
        },
      };

      return {
        success: true,
        output:
          aggregated +
          '\n\n--- detailed results ---\n' +
          JSON.stringify(structured, null, 2),
      };
    },
  };
}

// ── Plan phase implementation ──────────────────────────────────────────

async function runPlanPhase(
  llm: MiniLoopLLMClient,
  task: string,
  context: string,
  maxSubTasks: number,
  toolDefs: ToolDefinition[],
): Promise<PlanOk | PlanErr> {
  const userMsg = buildPlannerUserMessage(task, context, maxSubTasks);

  let plannerText: string;
  try {
    // Do not pass toolDefs (the planner only outputs JSON, does not call tools)
    const resp = await llm.send(
      PLANNER_SYSTEM_PROMPT,
      [{ role: 'user', content: userMsg }],
      [],
    );
    if (resp.type !== 'text') {
      return {
        ok: false,
        error: `planner output was not text (type=${resp.type}); it must not have tool_calls`,
      };
    }
    plannerText = resp.content;
  } catch (e) {
    return {
      ok: false,
      error: `planner LLM error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = parsePlannerOutput(plannerText);
  if (parsed === null) {
    return {
      ok: false,
      error: `could not parse planner output. First 200 chars: ${plannerText.slice(0, 200)}`,
    };
  }

  // toolDefs is not strictly required here, but kept as a hook for future suggestedTools validation (not yet implemented)
  void toolDefs;

  return validateAndNormalize(parsed, maxSubTasks);
}

// ── Execute phase implementation ──────────────────────────────────────

interface ExecutePhaseOptions {
  ordered: SubTask[];
  parentTask: string;
  llm: MiniLoopLLMClient;
  toolDefs: ToolDefinition[];
  toolRunner: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<MiniLoopToolRunResult>;
  toolWhitelist?: ReadonlySet<string>;
  toolBlacklist: ReadonlySet<string>;
  maxIters: number;
  budgetTracker: PlanBudgetTracker;
  onProgress?: (text: string) => void;
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
}

async function runExecutePhase(opts: ExecutePhaseOptions): Promise<SubTaskResult[]> {
  const {
    ordered,
    parentTask,
    llm,
    toolDefs,
    toolRunner,
    toolWhitelist,
    toolBlacklist,
    maxIters,
    budgetTracker,
    onProgress,
    logger,
  } = opts;

  const results = new Map<string, SubTaskResult>();

  for (let i = 0; i < ordered.length; i++) {
    const st = ordered[i];

    // Check if any upstream dependency failed/was skipped → auto-skip this task
    const failedDep = st.dependsOn.find((d) => {
      const r = results.get(d);
      return r && r.status !== 'success';
    });
    if (failedDep) {
      const r: SubTaskResult = {
        id: st.id,
        description: st.description,
        status: 'skipped',
        finalText: '',
        toolCallCount: 0,
        iters: 0,
        hitCap: false,
        skippedBecauseOf: failedDep,
      };
      results.set(st.id, r);
      onProgress?.(
        `▸ ${i + 1}/${ordered.length}: ${st.description.slice(0, 60)} → skipped (upstream ${failedDep} did not succeed)`,
      );
      continue;
    }

    // Budget check
    const reservation = budgetTracker.reserveSubTask(2_000); // estimate
    if (!reservation.allowed) {
      const r: SubTaskResult = {
        id: st.id,
        description: st.description,
        status: 'skipped',
        finalText: '',
        toolCallCount: 0,
        iters: 0,
        hitCap: false,
        error: `budget exhausted: ${reservation.reason}`,
      };
      results.set(st.id, r);
      onProgress?.(
        `▸ ${i + 1}/${ordered.length}: skipped (budget: ${reservation.reason})`,
      );
      continue;
    }

    // Build the sub-loop systemPrompt: original task overview + summaries of completed sub-tasks
    const completedSummaries = ordered
      .slice(0, i)
      .map((prev) => results.get(prev.id))
      .filter((r): r is SubTaskResult => r !== undefined && r.status === 'success')
      .map(
        (r) =>
          `### ${r.id}: ${r.description}\n${r.finalText.slice(0, 500)}`,
      )
      .join('\n\n');

    const systemPrompt =
      `You are executing one sub-step of the complex task "${parentTask}".\n\n` +
      `**Current sub-task**: ${st.description}\n` +
      (st.expectedOutput ? `**Expected output**: ${st.expectedOutput}\n` : '') +
      (st.suggestedTools?.length
        ? `**Suggested tools**: ${st.suggestedTools.join(', ')}\n`
        : '') +
      (completedSummaries
        ? `\n## Summary of completed upstream sub-tasks\n${completedSummaries}\n`
        : '') +
      `\nWhen done, reply in text with what you did + the artifact path (if any). Be concise, ≤300 characters.`;

    onProgress?.(
      `▸ ${i + 1}/${ordered.length}: ${st.description.slice(0, 60)} → running`,
    );

    const subResult = await runMiniAgentLoop({
      systemPrompt,
      userMessage: st.description,
      llm,
      toolDefs,
      toolRunner,
      toolWhitelist,
      toolBlacklist,
      maxIters,
    });

    budgetTracker.commit({
      llmTokens: subResult.llmTokensSpent,
      toolCalls: subResult.toolCallsSpent,
    });

    let status: SubTaskStatus;
    let error: string | undefined;
    if (subResult.error) {
      status = 'failed';
      error = subResult.error;
    } else if (subResult.hitCap) {
      status = 'failed';
      error = `sub-loop hit maxIters=${maxIters}`;
    } else if (!subResult.finalText.trim()) {
      status = 'failed';
      error = `sub-loop produced empty final text`;
    } else {
      status = 'success';
    }

    const r: SubTaskResult = {
      id: st.id,
      description: st.description,
      status,
      finalText: subResult.finalText,
      toolCallCount: subResult.toolCallHistory.length,
      iters: subResult.itersUsed,
      hitCap: subResult.hitCap,
      error,
    };
    results.set(st.id, r);

    onProgress?.(
      `▸ ${i + 1}/${ordered.length}: ${st.description.slice(0, 60)} → ${status}`,
    );
    logger?.log(
      `[plan-execute] ${st.id} ${status} iter=${subResult.itersUsed} tools=${subResult.toolCallHistory.length}`,
    );
  }

  return ordered.map((st) => results.get(st.id)!);
}

// ── Aggregate phase implementation ────────────────────────────────────

async function runAggregatePhase(
  parentTask: string,
  results: SubTaskResult[],
  mode: 'concat' | 'llm-summary',
): Promise<string> {
  if (mode === 'concat') {
    return aggregateConcat(parentTask, results);
  }
  // Fall back to concat if llm-summary fails
  try {
    return await aggregateLlmSummary(parentTask, results);
  } catch (e) {
    return (
      `(LLM aggregation failed, falling back to concat: ${e instanceof Error ? e.message : String(e)})\n\n` +
      aggregateConcat(parentTask, results)
    );
  }
}

function aggregateConcat(parentTask: string, results: SubTaskResult[]): string {
  const lines: string[] = [`# planAndExecute result: ${parentTask}\n`];
  const successCount = results.filter((r) => r.status === 'success').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  lines.push(
    `**Summary**: ${successCount} succeeded / ${failedCount} failed / ${skippedCount} skipped\n`,
  );
  for (const r of results) {
    const tag = r.status === 'success' ? '✓' : r.status === 'failed' ? '⚠' : '⊘';
    lines.push(`## ${tag} ${r.id}: ${r.description}`);
    if (r.status === 'success') {
      lines.push(r.finalText.slice(0, 1000));
    } else if (r.status === 'failed') {
      lines.push(`(failed) ${r.error ?? ''}`);
    } else {
      lines.push(
        `(skipped) ${r.skippedBecauseOf ? `upstream ${r.skippedBecauseOf} did not succeed` : r.error ?? ''}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function aggregateLlmSummary(
  parentTask: string,
  results: SubTaskResult[],
): Promise<string> {
  const successCount = results.filter((r) => r.status === 'success').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;

  const subSummaries = results
    .map((r) => {
      const tag = r.status === 'success' ? '[OK]' : r.status === 'failed' ? '[FAIL]' : '[SKIP]';
      const body =
        r.status === 'success'
          ? r.finalText.slice(0, 500)
          : (r.error ?? r.skippedBecauseOf ?? '');
      return `${tag} ${r.id}: ${r.description}\n${body}`;
    })
    .join('\n\n');

  const userPrompt =
    `## Parent task\n${parentTask}\n\n` +
    `## Sub-task results\n${subSummaries}\n\n` +
    `## Output requirements\nSummarize concisely in markdown (≤500 chars):\n` +
    `1. Overall completion (succeeded ${successCount} / failed ${failedCount} / skipped ${skippedCount})\n` +
    `2. List the concrete paths of key artifacts (if a sub-task mentioned them)\n` +
    `3. Specific failure causes + recommended next actions\n` +
    `4. Do not restate the full sub-task text; distill it`;

  try {
    const text = await callAuxLLM({
      system:
        'You are a task-execution summarizer. Be concise and direct; list actionable info. No pleasantries.',
      user: userPrompt,
      maxTokens: 1024,
    });
    return text.trim();
  } catch (e) {
    if (e instanceof AuxLLMError && e.kind === 'not_configured') {
      // No LLM configured → fall back to concat
      return aggregateConcat(parentTask, results);
    }
    throw e;
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function clampInt(
  v: number | undefined,
  min: number,
  max: number,
  def: number,
): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function countDependencyChains(ordered: SubTask[]): number {
  return ordered.reduce((sum, st) => sum + st.dependsOn.length, 0);
}

// ── Test exports ──────────────────────────────────────────────────────

export const _internal = {
  parsePlannerOutput,
  validateAndNormalize,
  detectCycle,
  topoSort,
  aggregateConcat,
};
