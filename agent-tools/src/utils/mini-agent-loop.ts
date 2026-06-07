/**
 * mini-agent-loop — general-purpose sub-turn execution kernel
 *
 * Purpose: run an independent LLM ↔ tool back-and-forth loop inside a tool execute() call, with its own
 * messages stack, its own iter budget, and its own abort signal. From the parent turn's perspective it
 * is always exactly 1 tool_result.
 *
 * Design boundaries (only does these):
 *   1. Maintain a local messages array, starting with [{ role:'user', content: userMessage }]
 *      systemPrompt is passed via the LLMClient's semantics — the client implementation decides whether
 *      to put it in a separate system slot (Anthropic-style) or in messages[0]
 *   2. Loop ≤ maxIters: llm.send(messages, toolDefs) →
 *        text → wrap up, return finalText
 *        toolCalls → pass through whitelist/blacklist gate → toolRunner.execute →
 *                    format tool_result → push assistant + tool_results → next iteration
 *   3. Hit maxIters → return { hitCap: true, finalText: '' }, no throw
 *   4. abortSignal fires → return { error: 'aborted' }
 *
 * Intentionally not done:
 *   - HonestyGate / EmptyConclusionGate / pendingAuth / pendingQuestion
 *   - signalBus / K7-K8 bridge / iter-warning injection
 *   - sanitizeToolInput (delegated to toolRunner wrapper)
 *   - askUserQuestion / interactive (the sub-loop is non-interactive)
 *
 * Caller responsibility: wrap the chat-handler's LLMAdapter as a MiniLoopLLMClient (structural
 * compatibility is sufficient; no new instance needs to be created).
 */

import type { ToolDefinition } from '@agent/policy';

// ── Structured message types (isomorphic to Anthropic.MessageParam, but without the SDK dependency) ──────────

/** Structural subset of Anthropic.ContentBlock: text / tool_use / tool_result */
export type MiniLoopContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; [k: string]: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; [k: string]: unknown };

/** Structurally isomorphic to Anthropic.MessageParam */
export interface MiniLoopMessage {
  role: 'user' | 'assistant';
  content: string | MiniLoopContentBlock[];
}

// ── LLM client abstraction ─────────────────────────────────────────────

export type MiniLoopLLMResponse =
  | { type: 'text'; content: string; tokensUsed?: number }
  | {
      type: 'toolCalls';
      calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      assistantMessage: MiniLoopMessage;
      tokensUsed?: number;
    };

export interface MiniLoopLLMClient {
  /**
   * @param systemPrompt The sub-loop's system section; the client decides whether to put it in a separate system field or in messages[0]
   * @param messages     The messages stack up to this point (excluding system)
   * @param toolDefs     List of callable tools
   */
  send(
    systemPrompt: string,
    messages: MiniLoopMessage[],
    toolDefs: ToolDefinition[],
    /** Forwarded to the underlying LLM HTTP call so an in-flight request is cancelled when the round deadline fires (not just checked between iterations). */
    opts?: { signal?: AbortSignal },
  ): Promise<MiniLoopLLMResponse>;
}

// ── Options + Result ───────────────────────────────────────────────────

export interface MiniLoopToolRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface MiniAgentLoopOptions {
  systemPrompt: string;
  userMessage: string;
  llm: MiniLoopLLMClient;
  toolDefs: ToolDefinition[];
  toolRunner: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<MiniLoopToolRunResult>;
  /** LLM↔tool round-trip cap per sub-task. Default 8 */
  maxIters?: number;
  /** If provided, only calls to tools in this set are allowed; calls outside the set are immediately rejected and returned as a tool_result rejection */
  toolWhitelist?: ReadonlySet<string>;
  /** Tools that are explicitly rejected (most common: planAndExecute to prevent nesting + askUserQuestion to prevent interactivity) */
  toolBlacklist?: ReadonlySet<string>;
  /** Progress callback, fired on every LLM response and every tool call */
  onStatus?: (text: string) => void;
  /**
   * Abort signal. Checked before each LLM call AND before each tool run, and forwarded into
   * llm.send so an in-flight LLM HTTP request is cancelled the moment it fires (otherwise a
   * single in-flight call — up to the LLM call timeout — keeps running past the round deadline
   * and overruns the parent turn's hard deadline). When fired, returns with error='aborted'.
   */
  abortSignal?: AbortSignal;
}

export interface MiniLoopToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  outputPreview: string; // ≤ 200 chars
}

export interface MiniAgentLoopResult {
  /** LLM final text (empty string when cap is hit or aborted) */
  finalText: string;
  /** All tools called in this run (in chronological order) */
  toolCallHistory: MiniLoopToolCallRecord[];
  /** Actual number of iterations used */
  itersUsed: number;
  /** Whether the iteration cap was hit */
  hitCap: boolean;
  /** Cumulative LLM token estimate (estimated as text length * 0.3 when the client does not report it) */
  llmTokensSpent: number;
  /** Cumulative tool call count */
  toolCallsSpent: number;
  /** Structural error: 'aborted' / 'llm_error: ...' / undefined (normal completion or cap) */
  error?: string;
}

const DEFAULT_MAX_ITERS = 8;
const PREVIEW_MAX = 200;
const TOOL_RESULT_MAX = 16_000;

/**
 * Format a tool execution result into tool_result text that is clear to the LLM.
 * Aligned with chat-handler.formatToolResultContent: ✓ TOOL OK / ⚠ TOOL FAILED.
 */
function formatToolResultContent(result: MiniLoopToolRunResult): string {
  if (result.ok) {
    const body = result.output ?? '';
    return body.length > 0 ? `✓ TOOL OK\n${body}` : '✓ TOOL OK\n(no output)';
  }
  const why = result.error?.trim() || '(no error message)';
  const stdoutTail = result.output?.trim();
  const tail = stdoutTail ? `\nSTDOUT (partial):\n${stdoutTail}` : '';
  return `⚠ TOOL FAILED — ${why}${tail}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…(truncated)' : s;
}

function previewText(s: string): string {
  const oneLine = s.replace(/\s*\n\s*/g, ' ↵ ');
  return oneLine.length > PREVIEW_MAX ? oneLine.slice(0, PREVIEW_MAX) + '…' : oneLine;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.3);
}

/**
 * Gate a single tool call: returns null to allow it, or a rejection-reason string to deny it (sent back to the LLM as a tool error)
 */
function gateToolCall(
  name: string,
  whitelist: ReadonlySet<string> | undefined,
  blacklist: ReadonlySet<string> | undefined,
): string | null {
  if (blacklist && blacklist.has(name)) {
    return `Tool '${name}' is on the sub-loop blacklist (common reasons: prevent nesting / sub-loop does not allow interactive tools)`;
  }
  if (whitelist && !whitelist.has(name)) {
    return `Tool '${name}' is not in the sub-loop whitelist. Allowed tools: ${[...whitelist].join(', ')}`;
  }
  return null;
}

export async function runMiniAgentLoop(
  opts: MiniAgentLoopOptions,
): Promise<MiniAgentLoopResult> {
  const {
    systemPrompt,
    userMessage,
    llm,
    toolDefs,
    toolRunner,
    toolWhitelist,
    toolBlacklist,
    onStatus,
    abortSignal,
  } = opts;
  const maxIters = Math.max(1, opts.maxIters ?? DEFAULT_MAX_ITERS);

  const messages: MiniLoopMessage[] = [{ role: 'user', content: userMessage }];
  const toolCallHistory: MiniLoopToolCallRecord[] = [];
  let llmTokensSpent = 0;
  let toolCallsSpent = 0;

  for (let i = 0; i < maxIters; i++) {
    if (abortSignal?.aborted) {
      return {
        finalText: '',
        toolCallHistory,
        itersUsed: i,
        hitCap: false,
        llmTokensSpent,
        toolCallsSpent,
        error: 'aborted',
      };
    }

    let response: MiniLoopLLMResponse;
    try {
      response = await llm.send(systemPrompt, messages, toolDefs, { signal: abortSignal });
    } catch (e) {
      // An aborted in-flight call surfaces here as an AbortError; report it as 'aborted'
      // (resumable) rather than a generic llm_error so the caller's deadline branch is taken.
      if (abortSignal?.aborted) {
        return {
          finalText: '',
          toolCallHistory,
          itersUsed: i,
          hitCap: false,
          llmTokensSpent,
          toolCallsSpent,
          error: 'aborted',
        };
      }
      return {
        finalText: '',
        toolCallHistory,
        itersUsed: i,
        hitCap: false,
        llmTokensSpent,
        toolCallsSpent,
        error: `llm_error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (response.tokensUsed !== undefined) {
      llmTokensSpent += response.tokensUsed;
    }

    if (response.type === 'text') {
      if (response.tokensUsed === undefined) {
        llmTokensSpent += estimateTokens(response.content);
      }
      onStatus?.(`✓ done (iter ${i + 1}/${maxIters})`);
      return {
        finalText: response.content,
        toolCallHistory,
        itersUsed: i + 1,
        hitCap: false,
        llmTokensSpent,
        toolCallsSpent,
      };
    }

    // toolCalls path: push assistant + run each tool + push tool_results
    messages.push(response.assistantMessage);

    const toolResultBlocks: MiniLoopContentBlock[] = [];
    for (const call of response.calls) {
      // Stop launching new tool runs once the deadline has fired; the tree is already
      // persisted incrementally, so returning 'aborted' here is resumable.
      if (abortSignal?.aborted) {
        return {
          finalText: '',
          toolCallHistory,
          itersUsed: i + 1,
          hitCap: false,
          llmTokensSpent,
          toolCallsSpent,
          error: 'aborted',
        };
      }
      const gateReject = gateToolCall(call.name, toolWhitelist, toolBlacklist);
      let runResult: MiniLoopToolRunResult;
      if (gateReject !== null) {
        runResult = { ok: false, output: '', error: gateReject };
      } else {
        try {
          runResult = await toolRunner(call.name, call.input);
        } catch (e) {
          runResult = {
            ok: false,
            output: '',
            error: `tool runner threw: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      toolCallsSpent += 1;
      toolCallHistory.push({
        name: call.name,
        input: call.input,
        ok: runResult.ok,
        outputPreview: previewText(runResult.ok ? runResult.output : runResult.error ?? ''),
      });
      onStatus?.(
        `${runResult.ok ? '✓' : '⚠'} ${call.name} (iter ${i + 1}/${maxIters})`,
      );

      const formatted = truncate(formatToolResultContent(runResult), TOOL_RESULT_MAX);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: formatted,
      });
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  // Hit maxIters
  onStatus?.(`⚠ hit max iters (${maxIters})`);
  return {
    finalText: '',
    toolCallHistory,
    itersUsed: maxIters,
    hitCap: true,
    llmTokensSpent,
    toolCallsSpent,
  };
}
