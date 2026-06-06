#!/usr/bin/env node
/**
 * headless.ts — philont headless single-task CLI
 *
 * Given a task prompt, runs the agent to completion in the specified workspace and then exits.
 * Use case: integration with external agent benchmarks — those harnesses
 * require a "CLI agent: enter container → receive task → complete in workspace → exit → evaluate".
 *
 * Relationship to server: reuses chat-handler's handleChatSend (same LLM + tools + memory +
 * gate + loop); only removes the WebSocket layer and replaces it with one-shot argv-driven input.
 *
 * Usage:
 *   tsx src/headless.ts --task "..." --workspace /path --output /path/run
 *   tsx src/headless.ts --task-file task.md --workspace . --model anthropic/claude-opus-4-7
 *
 * Exit codes: 0 completed / 1 error / 2 timeout / 3 argument error
 */

import './load-env.js'; // must be first: loads dotenv override, overriding any shell/system residual env
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { AuthRequest } from './chat-handler.js';

// ── argv parsing ─────────────────────────────────────────────────────────────

const HELP = `philont headless —— 无头单任务 runner

必填(二选一):
  --task <str>           任务 prompt 文本
  --task-file <path>     从文件读任务 prompt

可选:
  --workspace <dir>      agent 的工作目录(chdir 到此;默认当前目录)
  --output <dir>         运行产物目录(默认 <workspace>/.philont-run)
  --session <id>         会话 id(默认 headless-<时间戳>)
  --model <name>         覆盖当前 LLM_PROVIDER 的模型(如 anthropic/claude-opus-4-7)
  --memory-db <path>     记忆库路径(默认 <output>/memory/memory.sqlite,即每次运行隔离)
  --timeout <sec>        硬墙钟超时,秒(默认 1200)
  --max-auth-rounds <n>  自动批准授权请求的最大轮数(默认 20)
  --preamble <path|none> benchmark 前言:文件路径覆盖默认,'none' 关闭
  --autonomous           保留 idle 自主循环(默认关闭 PHILONT_AUTONOMOUS=0)
  -h, --help             显示本帮助

模型/凭证走环境变量:LLM_PROVIDER + 对应的 *_API_KEY / *_BASE_URL / *_MODEL。
OpenRouter 示例:LLM_PROVIDER=openai OPENAI_BASE_URL=https://openrouter.ai/api
                 OPENAI_API_KEY=<key>  --model <provider/model>
`;

let parsed;
try {
  parsed = parseArgs({
    options: {
      task: { type: 'string' },
      'task-file': { type: 'string' },
      workspace: { type: 'string' },
      output: { type: 'string' },
      session: { type: 'string' },
      model: { type: 'string' },
      'memory-db': { type: 'string' },
      timeout: { type: 'string' },
      'max-auth-rounds': { type: 'string' },
      preamble: { type: 'string' },
      autonomous: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  process.stderr.write(`参数错误: ${String(e)}\n\n${HELP}`);
  process.exit(3);
}
const opt = parsed.values;

if (opt.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

function fail(msg: string): never {
  process.stderr.write(`错误: ${msg}\n\n${HELP}`);
  process.exit(3);
}

// Task text
let taskText: string;
if (opt['task-file']) {
  try {
    taskText = readFileSync(resolve(opt['task-file']), 'utf8');
  } catch (e) {
    fail(`读取 --task-file 失败: ${String(e)}`);
  }
} else if (opt.task) {
  taskText = opt.task;
} else {
  fail('必须提供 --task 或 --task-file');
}
if (!taskText.trim()) fail('任务内容为空');

const workspace = resolve(opt.workspace ?? process.cwd());
const outputDir = resolve(opt.output ?? join(workspace, '.philont-run'));
const sessionId = opt.session ?? `headless-${Date.now()}`;
const timeoutSec = Number(opt.timeout ?? '1200');
const maxAuthRounds = Number(opt['max-auth-rounds'] ?? '20');
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) fail('--timeout 必须是正数');
if (!Number.isFinite(maxAuthRounds) || maxAuthRounds < 1) fail('--max-auth-rounds 必须 ≥ 1');

// Benchmark preamble: inject "complete autonomously, do not ask questions" constraints to
// prevent the agent from blocking on a clarifying question when unattended (headless mode
// cannot answer). The task itself should be self-contained.
const DEFAULT_PREAMBLE = `[自动化数据处理任务]
你正在为一条数据处理流水线执行一个独立任务。这是普通的工作流程,跟训练 / 评测 / 越狱
全无关。要求:
- 自主完成整个任务,不要中途提问;信息不明确时做合理假设并继续。
- 所有文件操作都在指定路径(任务描述中明确指出)进行。
- 完成后用简洁的最终回复说明你做了什么、产出在哪里。

**产物路径与文件名严格化(下游程序读取产物,路径错就失败)**:
- 任务描述里出现的所有绝对路径(如 \`/root/X.xlsx\` / \`/tmp_workspace/Y.json\`)都是
  下游程序读取的**指定路径**,不可改名、不可换目录。要求 \`/root/budget_report.xlsx\`
  就写到这个路径,不能起 \`summary.xlsx\` / \`output.xlsx\` / 任务相关的语义名。
- 任务要求"创建子目录 scp-001 / scp-002 ..."时,**严格按指定命名格式**,
  不要简化成 scp-1 / scp-01.txt 之类。
- 任务要求文件后缀为 \`.tsv\` / \`.jsonl\` / \`.csv\` 时,严格匹配,不要用 \`.md\` 替代。
- 下游不读你最终给用户的话,只读这些指定路径的文件内容。所以产物放对位置
  比汇报漂亮重要 10 倍。

任务如下:
---
`;
let preamble = DEFAULT_PREAMBLE;
if (opt.preamble === 'none') {
  preamble = '';
} else if (opt.preamble) {
  try {
    preamble = readFileSync(resolve(opt.preamble), 'utf8');
  } catch (e) {
    fail(`读取 --preamble 失败: ${String(e)}`);
  }
}
const fullPrompt = preamble + taskText;

// ── Environment variables (must be set before importing chat-handler) ────────
// chat-handler reads MEMORY_DB_PATH and starts the autonomous loop at module-load time,
// so these must be set before the dynamic import.

mkdirSync(outputDir, { recursive: true });

if (!opt.autonomous && process.env.PHILONT_AUTONOMOUS === undefined) {
  // Single-task headless mode does not need the idle autonomous loop — it only wastes budget
  process.env.PHILONT_AUTONOMOUS = '0';
}

// 2026-05-28: headless defaults to autogrant. In headless single-task mode auth_pending
// is automatically "allowed" by this file's authorization replay loop anyway, but the
// pause-resume cycle splits multiple tool_use blocks emitted in one model pass → the
// resume path reassembles messages incorrectly → tool_use↔tool_result misalignment →
// Anthropic 400 (always triggered by deepseek multi-tool_use). Pre-authorizing eliminates
// the pause entirely. Set PHILONT_AUTO_GRANT=0 explicitly to disable.
if (process.env.PHILONT_AUTO_GRANT === undefined) {
  process.env.PHILONT_AUTO_GRANT = '1';
}

// Default: isolate a fresh memory DB per run; set --memory-db to a fixed path for
// "cross-run continuous learning longitudinal tests"
process.env.MEMORY_DB_PATH =
  opt['memory-db'] ?? process.env.MEMORY_DB_PATH ?? join(outputDir, 'memory', 'memory.sqlite');
// An explicit MEMORY_DB_PATH skips the mkdir inside server's default path resolver —
// create it here to avoid better-sqlite3 failing to open when the parent dir does not exist.
mkdirSync(dirname(process.env.MEMORY_DB_PATH), { recursive: true });

// --model: override the model env for the current provider (provider itself is still
// determined by LLM_PROVIDER)
if (opt.model) {
  const MODEL_ENV: Record<string, string> = {
    anthropic: 'ANTHROPIC_MODEL',
    openai: 'OPENAI_MODEL',
    minimax: 'MINIMAX_MODEL',
    glm: 'GLM_MODEL',
    zhipu: 'GLM_MODEL',
    kimi: 'KIMI_MODEL',
    moonshot: 'KIMI_MODEL',
    gemini: 'GEMINI_MODEL',
    google: 'GEMINI_MODEL',
  };
  const provider = (process.env.LLM_PROVIDER ?? '').toLowerCase();
  const envName = MODEL_ENV[provider];
  if (envName) {
    process.env[envName] = opt.model;
  } else {
    process.stderr.write(
      `[headless] 警告: --model 已忽略 —— LLM_PROVIDER='${provider || '(未设)'}' ` +
        `无对应模型 env。请改用环境变量直接设模型。\n`,
    );
  }
}

// Agent works inside workspace: fs / shell tools operate relative to process.cwd()
process.chdir(workspace);

// ── Run ──────────────────────────────────────────────────────────────────────

interface RunResult {
  outcomeType: string;
  text: string;
  auditEvents: number;
  authRounds: number;
  elapsedMs: number;
  error?: string;
}

async function run(): Promise<RunResult> {
  // Dynamic import: ensure the env vars above are in effect before chat-handler module loads
  const ch = await import('./chat-handler.js');

  const log: string[] = [];
  const logLine = (tag: string, text: string) => {
    log.push(`[${new Date().toISOString()}] ${tag} ${text}`);
  };
  logLine('task', `session=${sessionId} workspace=${workspace}`);

  let finalText = '';
  let authRequested = false;
  const onDelta = (t: string) => {
    finalText += t;
    logLine('delta', t);
  };
  const onAuth = (req: AuthRequest) => {
    authRequested = true;
    logLine('auth', `${req.toolName} (${req.capability}/${req.domain}) — auto-approved`);
  };
  const onStatus = (t: string) => logLine('status', t);
  const onTrace = (ev: unknown) => {
    try {
      logLine('trace', JSON.stringify(ev));
    } catch {
      /* ignore non-serialisable trace events */
    }
  };

  const started = Date.now();
  let lastOutcome: { outcomeType?: string; text?: string } = {};
  let lastAuditEvents = 0;
  let round = 0;

  // Authorization replay loop: headless is unattended; treat every onAuthRequest as
  // "auto-approve" — resend handleChatSend with an approval message, which causes philont's
  // pendingAuth mechanism to resume the suspended tool loop. Different (tool, cap, domain)
  // combinations each trigger a request on first encounter, so the loop may run multiple rounds.
  while (round < maxAuthRounds) {
    authRequested = false;
    finalText = '';
    const message = round === 0 ? fullPrompt : '允许';
    logLine('send', round === 0 ? '(task prompt)' : '(auth approval: allow)');

    const result = await ch.handleChatSend(
      sessionId,
      message,
      onDelta,
      onAuth,
      onStatus,
      onTrace,
    );
    lastOutcome = (result?.outcome ?? {}) as { outcomeType?: string; text?: string };
    lastAuditEvents = result?.auditEvents ?? 0;
    round++;

    if (!authRequested) break; // no pending auth → turn truly finished
    logLine('auth', `round ${round}: pending auth detected, replaying approval`);
  }
  if (round >= maxAuthRounds && authRequested) {
    logLine('warn', `reached --max-auth-rounds=${maxAuthRounds}, stopped replay (may be incomplete)`);
  }

  // Finalize: trigger fact/skill extraction + reflection write-back to memory layer
  try {
    await ch.finalizeSession(sessionId);
  } catch (e) {
    logLine('warn', `finalizeSession failed: ${String(e)}`);
  }

  // Clean shutdown — same order as server gracefulShutdown (closeIdleConsolidator must
  // be awaited before memory.close())
  try { ch.closeSkillWatchers(); } catch { /* ignore */ }
  try { ch.closeScheduler(); } catch { /* ignore */ }
  try { await ch.closeIdleConsolidator(); } catch { /* ignore */ }
  try { await ch.closeAutonomousLoop(); } catch { /* ignore */ }
  try { ch.closeFetchedStore(); } catch { /* ignore */ }
  try { ch.memory.close(); } catch { /* ignore */ }

  const elapsedMs = Date.now() - started;
  const answer = lastOutcome.text ?? finalText;

  // Write outputs to disk
  writeFileSync(join(outputDir, 'answer.txt'), answer, 'utf8');
  writeFileSync(join(outputDir, 'agent.log'), log.join('\n') + '\n', 'utf8');

  return {
    outcomeType: lastOutcome.outcomeType ?? 'unknown',
    text: answer,
    auditEvents: lastAuditEvents,
    authRounds: round,
    elapsedMs,
  };
}

// ── Main: race run() against hard timeout ────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<RunResult>((res) => {
    timer = setTimeout(
      () =>
        res({
          outcomeType: 'timeout',
          text: '',
          auditEvents: 0,
          authRounds: 0,
          elapsedMs: Date.now() - started,
          error: `exceeded --timeout=${timeoutSec}s`,
        }),
      timeoutSec * 1000,
    );
  });

  let result: RunResult;
  try {
    result = await Promise.race([run(), timeout]);
  } catch (e) {
    result = {
      outcomeType: 'error',
      text: '',
      auditEvents: 0,
      authRounds: 0,
      elapsedMs: Date.now() - started,
      error: String((e as Error)?.stack ?? e),
    };
  }
  if (timer) clearTimeout(timer);

  // result.json: run metadata (agent benchmarks and similar evaluators read workspace side effects;
  // this is philont's own run ledger — token counts are not yet exposed by the philont LLM adapter)
  writeFileSync(
    join(outputDir, 'result.json'),
    JSON.stringify(
      {
        sessionId,
        workspace,
        outcomeType: result.outcomeType,
        auditEvents: result.auditEvents,
        authRounds: result.authRounds,
        elapsedMs: result.elapsedMs,
        model: process.env[`${(process.env.LLM_PROVIDER ?? '').toUpperCase()}_MODEL`] ?? null,
        provider: process.env.LLM_PROVIDER ?? null,
        error: result.error ?? null,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  const isTimeout = result.outcomeType === 'timeout';
  const isError = result.outcomeType === 'error' || !!result.error;
  process.stderr.write(
    `[headless] 完成 outcome=${result.outcomeType} auth轮=${result.authRounds} ` +
      `耗时=${Math.round(result.elapsedMs / 1000)}s 产物=${outputDir}\n`,
  );
  if (result.error) process.stderr.write(`[headless] ${result.error}\n`);

  // If timed out, run() may still be hanging — force exit
  process.exit(isTimeout ? 2 : isError ? 1 : 0);
}

void main();
