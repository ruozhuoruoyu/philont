/**
 * chat.send handler - tool call loop + dynamic authorization (non-blocking)
 *
 * Authorization flow:
 *   1. Insufficient permissions → save paused state, send auth_request, return
 *   2. Next user message → detect pendingAuth → classify intent → continue or reject
 */

import {
  AuditLog,
  createReadOnlyMatrix, checkPermission,
  createToolChecker,
  GrantStore, LLMIntentClassifier, KeywordIntentClassifier,
  SecretStore,
  createDefaultChain,
  createPathAclValidator,
  createDangerousCommandValidator,
  DEFAULT_DANGEROUS_PATTERNS,
  type ToolCheckInput,
} from '@agent/policy';
import type { ToolDefinition, ToolResult } from '@agent/policy';
import type { ReasoningSession } from '@agent/memory';
import {
  createToolset,
  loadSkills,
  watchSkillDir,
  installSkillTool,
  uninstallSkillTool,
  createPlanAndExecuteTool,
  PlanBudgetTracker,
  createCredentialTools,
  hostEnvPromptLine,
  type MiniLoopLLMClient,
  type MiniLoopLLMResponse,
  type MiniLoopMessage,
  type ReasoningConfig,
} from '@agent/tools';
import {
  openMemoryDb,
  resolveDefaultMemoryPath,
  migrateLegacyMemoryDb,
  SessionExtractor,
  SessionReflector,
  SessionPursuitExtractor,
  SessionDriveReflector,
  SelfReflector,
  Compactor,
  importSkills,
  startScheduler,
  createMemoryTools,
  createPushTools,
  createResearchTools,
  createTaskModeTools,
  createPlanTools,
  InMemoryTaskModeStore,
  loadConstitution,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  DEFAULT_CONSTITUTION_VALUES,
  DEFAULT_CONSTITUTION_RED_LINES,
  TsDriveRuntime,
  TsTaskCommitmentDrive,
  startAutonomousLoop,
  StandardExecutor,
  DEFAULT_TOOL_WHITELIST,
  GapDriver,
  CuriosityDriver,
  PursuitDriver,
  DEFAULT_PURSUIT_CONFIG,
  collectK7BridgeInitiatives,
  pursuitProgressWriter,
  parsePursuitTargetRef,
  DEFAULT_RESEARCH_GRANT_TTL_MS,
  FetchedResourceStore,
  runMetaConfigObserver,
  runBugDetector,
  countSameRootCauseFailures,
  groupFailures,
  isResearchTool,
  hasResearchCallInTurn,
  buildResearchReminder,
  type AutonomousLoopHandle,
  type ToolRunner,
  type ToolRunResult,
  type InterruptSink,
  type HonestyEvaluation,
  verifySelfSummaryIntegrity,
  evaluateEmptyConclusion,
  evaluateOutputFormat,
  type ExtractorLlmClient,
  type Fact,
  type FiredDrive,
  type RecentMessage,
  type Schedule,
  type TsToolCallSummary,
} from '@agent/memory';
import type { Tool } from '@agent/policy';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

// __dirname does not exist under ESM; manually reconstruct the directory of this module for bundled-skill path resolution.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
import { createLLMAdapter, ContextTooLargeError, type NativeMessage, type LLMResponse } from './llm-adapter.js';
import { registerMainLLM, renderQuestion, parseQuestionAnswer, callAuxLLM, isAuxLLMConfigured, type AuxLLMRequest } from '@agent/tools';
import { loadMcpConfig, connectMcpServers, closeMcpBridges, type McpBridge } from '@agent/mcp';
import {
  truncateToolResultContent,
  evictOldToolResults,
  evictForEmergency,
  estimateTotalTokens,
  DEFAULTS as BUDGET,
} from './message-budget.js';
import {
  GLOBAL_TIMELINE_SESSION_ID,
  TimelineRetriever,
  startIdleConsolidator,
  signalState,
  computeServiceDormancy,
  InterruptMapper,
  detectTimeRetrospectiveQuery,
} from '@agent/memory';
import { evaluateHonesty, detectHalfFinishedTurn, findCompletionClaim } from '@agent/memory';
import {
  extractScheduleIdFromSession,
  summarizeTurnTrace,
  renderScheduleOutcomesSection,
  type ToolCallTrace,
} from '@agent/memory';
import { extractFailureSignature } from '@agent/memory';
import { detectRecurringUserPatterns } from '@agent/memory';
import { reconcilePredictiveWakeups } from '@agent/memory';
import {
  buildUserPatternObservationSection,
  detectPatternConfirmation,
  listPendingPatterns,
  markPatternStatus,
  savePatternCandidate,
} from './user_pattern_inject.js';
// 2026-05-29 soft-disable Rust: interrupt broadcast pipe replaced with pure-TS stand-in (see interrupt_channel.ts).
// Production no longer has a runtime dependency on @agent/node; Rust kernel is kept in the repo for future untrusted-sandbox use.
import { interruptChannelJs, type JsInterruptController } from './interrupt_channel.js';
import { InterruptDrainer } from './interrupt_drainer.js';
import { runInTurnContext, currentSessionId, currentTurnStatus } from './channels/turn_context.js';
import {
  autoClassify as autoClassifyTaskMode,
  quickSignatureHash as quickTaskSignatureHash,
} from './task_mode_classifier.js';
import { replyWithMediaTool } from './tools/reply_with_media.js';
import { setConscienceLlm } from './conscience_gate.js';
import { createAutoAdvanceLoop } from './deep_explore_autoadvance.js';
import { semanticToolPhrase, semanticToolFailPhrase, summarizingPhrase, type PhraseLang } from './channel_phrases.js';
import { wrapSkillToolWithReload } from './skill_install_wrapper.js';
import { recentAttachments } from './channels/recent_attachments.js';
import { persistToolResultIfFetched } from './fetched_resources_hook.js';
import {
  detectUnclosedQuestion,
  findLastAssistantText,
  findLastUserText,
  renderBindingContext,
  renderAskGuardRejection,
} from './short_answer_binding.js';
import { buildRoutingInjection } from './routing_inject.js';
import {
  buildFailureRecoveryInjection,
  detectUserDissatisfaction,
} from './failure_recovery_inject.js';
import {
  detectInTurnFailurePattern,
  type InTurnToolRecord,
} from './in_turn_reflection.js';
import { maybeRunReflection } from './reflection_runner.js';
import {
  buildAutonomousProgressInjection,
  buildK7BridgeReviewSection,
  buildResearchPendingGrantSection,
  buildReasoningProgressSection,
} from './autonomous_progress_inject.js';
import { createDeepExploreTool } from './deep_explore.js';
import {
  renderResearchGrantPrompt,
  reconstructDmSessionId,
  decideResearchGrantAction,
  type PendingResearchGrant,
} from './research_grant.js';
import { PushDispatcher } from './push/dispatcher.js';
import { serviceDriverTick } from './push/service_driver.js';
import {
  resolveAutonomousBudgetCaps,
  describeBudgetCapsOverrides,
} from './autonomous_budget_env.js';
import {
  sanitizeToolInput,
  sanitizeAssistantMessageBlocks,
} from './sanitize_tool_input.js';
import { renderDeterministicMaxIterSummary } from './max_iter_summary.js';
import { resolveResponseLanguage, buildLanguageDirective } from './response_language.js';

const llm = createLLMAdapter();

// Register the main model caller as the auxiliary LLM client for @agent/tools.
// When AUX_LLM_BASE_URL/AUX_LLM_API_KEY/AUX_LLM_MODEL env vars are not configured,
// callAuxLLM inside agent-tools (WebFetch distillation, other features) falls back here.
//
// Note: LLMAdapter.send does not distinguish system/user roles; it prepends the system content to the user content.
// For cases requiring a dedicated system slot, configure AUX_LLM_* to call a small model directly.
registerMainLLM(async (req: AuxLLMRequest) => {
  const userContent = req.system ? `${req.system}\n\n${req.user}` : req.user;
  const messages: NativeMessage[] = [{ role: 'user', content: userContent }];
  const resp = await llm.send(messages);
  if (resp.type === 'text') return resp.content;
  // Aux LLM calls do not pass tools; tool calls should never appear in theory.
  // If they do, treat stop reason as empty so callAuxLLM throws invalid_response and the caller decides how to degrade.
  return '';
});

// 2026-05-13: print aux LLM config state at startup to make it easy to diagnose whether Phase 9.2 is truly active
// (mycox production user complained "set the env but didn't see [plan-aux] log" → usually env was set in the
// shell but not inherited by the server process, or base_url was mistyped).
// aux LLM startup config is still usable for callAuxLLM (webFetch distillation, etc.), but the plan protocol path
// was entirely removed in M2 (2026-05-15). PHILONT_PLAN_AUX_LLM env is deprecated.
const _auxConfigured = isAuxLLMConfigured();
console.log(
  `[plan-aux] config: env_aux=${_auxConfigured ? `on (model=${process.env.AUX_LLM_MODEL})` : 'off (fallback to main LLM)'} (plan protocol no longer depends on aux; removed in M2)`,
);

/**
 * Format a tool execution result into a tool_result text the LLM can clearly read.
 *
 * Key invariant: the LLM must be able to tell immediately from the content prefix whether the tool succeeded or failed.
 * The old version used only a weak `Error: ${e}` prefix, and e.stderr was often empty, causing failures to look like
 * successes. The new version enforces ✓ / ⚠ visually distinct prefixes; failures always include the reason.
 */
function formatToolResultContent(result: { success: boolean; output?: string; error?: string }): string {
  if (result.success) {
    const body = result.output ?? '';
    return body.length > 0 ? `✓ TOOL OK\n${body}` : '✓ TOOL OK\n(no output)';
  }
  const why = result.error?.trim() || '(no error message)';
  const stdoutTail = result.output?.trim();
  const tail = stdoutTail ? `\nSTDOUT (partial):\n${stdoutTail}` : '';
  return `⚠ TOOL FAILED — ${why}${tail}`;
}

/**
 * Pre-invocation line formatter used by onDelta.
 *
 * Previously only emitted `[calling: shell]`; seeing 10 identical lines users had no way to tell if the LLM was retrying the same command.
 * Now extracts key parameters by tool type into a single line for real-time user inspection:
 *   - shell: `[shell] $ <first 200 chars of command>`
 *   - writeFile / patch / readFile / glob / grep: extracts path / pattern
 *   - others: `[<name>] <first 150 chars of input JSON>`
 *
 * Length limit is built in to prevent large inputs (e.g. writing a large text file) from flooding the frontend.
 */
function summarizeToolInvocation(name: string, input: Record<string, unknown>): string {
  const trim1 = (s: string, n: number): string =>
    s.length > n ? s.slice(0, n) + '…' : s;

  if (name === 'shell' && typeof input.command === 'string') {
    const oneLine = input.command.replace(/\s*\n\s*/g, ' ↵ ');
    return `[shell] $ ${trim1(oneLine, 220)}`;
  }
  if ((name === 'writeFile' || name === 'patch' || name === 'jsonPatch') &&
      typeof input.path === 'string') {
    return `[${name}] ${input.path}`;
  }
  if (name === 'readFile' && typeof input.path === 'string') {
    return `[readFile] ${input.path}`;
  }
  if (name === 'glob' && typeof input.pattern === 'string') {
    return `[glob] ${input.pattern}`;
  }
  if (name === 'grep' && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `[grep] /${trim1(input.pattern, 80)}/${path}`;
  }
  if (name === 'webFetch' && typeof input.url === 'string') {
    return `[webFetch] ${trim1(input.url, 160)}`;
  }
  if (name === 'webSearch' && typeof input.query === 'string') {
    return `[webSearch] ${trim1(input.query, 120)}`;
  }
  if ((name === 'downloadFile') && typeof input.url === 'string') {
    const dst = typeof input.path === 'string' ? ` → ${input.path}` : '';
    return `[downloadFile] ${trim1(input.url, 120)}${dst}`;
  }
  if (name === 'process' && typeof input.action === 'string') {
    const tgt = typeof input.target === 'string' ? ` ${input.target}` : '';
    return `[process] ${input.action}${tgt}`;
  }
  // Generic fallback: tool name + first 150 chars of input JSON
  let inputStr = '';
  try {
    inputStr = JSON.stringify(input);
  } catch {
    inputStr = '<unserializable>';
  }
  return `[${name}] ${trim1(inputStr, 150)}`;
}

/**
 * Post-invocation one-line result summary used by onDelta.
 *   - Success: `  ✓ <first N chars of output, newlines replaced with ↵>` (empty output → just `  ✓`)
 *   - Failure: `  ⚠ <first N chars of error>`
 * 200-char limit — much shorter than what the LLM receives; enough to judge success/failure/current action.
 */
function summarizeToolResult(result: { success: boolean; output?: string; error?: string }): string {
  const trim1 = (s: string, n: number): string =>
    s.length > n ? s.slice(0, n) + '…' : s;
  const oneLine = (s: string): string => s.trim().replace(/\s*\n\s*/g, ' ↵ ');

  if (result.success) {
    const body = oneLine(result.output ?? '');
    return body ? `  ✓ ${trim1(body, 200)}` : '  ✓';
  }
  const why = oneLine(result.error ?? '(no error)');
  return `  ⚠ ${trim1(why, 200)}`;
}

/**
 * Collect all tool_results from the tail of messages in reverse order for the current turn, **including tool name + content**.
 * "Current turn" boundary = the most recent user message with string content (the original user input,
 * not the tool_result array form).
 *
 * Algorithm: first scan all messages in the current turn to build a tool_use_id → toolName map,
 *       then output (toolName, content) in chronological order. When tool_use_id cannot be matched,
 *       toolName is left empty (affects verify determination but not success/failure counting).
 *
 * Used by HonestyGate: success/failure markers via ✓/⚠ prefixes, verify-before-claim via toolName.
 *
 * Exported for testing only.
 */
export function extractRecentToolResults(
  messages: NativeMessage[],
): Array<{ toolName: string; content: string; toolInput?: Record<string, unknown> }> {
  // Find the start of the current turn (scan backwards from tail for the most recent string-content user message)
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') {
      turnStart = i + 1; // current turn starts immediately after this user message
      break;
    }
  }

  // Scan current-turn messages to build id→{name, input} map (P0.3: include input as well,
  //   so HonestyGate can identify shell write commands)
  const idToToolInfo = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && typeof block === 'object' && (block as any).type === 'tool_use') {
        const id = (block as any).id;
        const name = (block as any).name;
        const input = (block as any).input;
        if (typeof id === 'string' && typeof name === 'string') {
          idToToolInfo.set(id, {
            name,
            input: (input && typeof input === 'object' ? input : {}) as Record<string, unknown>,
          });
        }
      }
    }
  }

  // Collect tool_result in chronological order
  const out: Array<{ toolName: string; content: string; toolInput?: Record<string, unknown> }> = [];
  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && typeof block === 'object' && (block as any).type === 'tool_result') {
        const id = (block as any).tool_use_id;
        const info = (typeof id === 'string' && idToToolInfo.get(id)) || null;
        const toolName = info?.name ?? '';
        const toolInput = info?.input;
        const c = (block as any).content;
        if (typeof c === 'string') {
          out.push({ toolName, content: c, toolInput });
        } else if (Array.isArray(c)) {
          for (const sub of c) {
            if (sub && typeof sub === 'object' && (sub as any).type === 'text' && typeof (sub as any).text === 'string') {
              out.push({ toolName, content: (sub as any).text, toolInput });
            }
          }
        }
      }
    }
  }
  return out;
}

// ── Memory layer initialization ──────────────────────────────────────────────────────────────
// Default path changed from ./memory.sqlite to ~/.philont/memory/memory.sqlite.
// If the user has not explicitly set MEMORY_DB_PATH, migrate the old DB under CWD (if present);
// when a path is explicitly configured, no automatic migration is triggered — configuration is fully respected.
const MEMORY_DB_PATH = (() => {
  if (process.env.MEMORY_DB_PATH) return process.env.MEMORY_DB_PATH;
  const target = resolveDefaultMemoryPath();
  migrateLegacyMemoryDb(target);
  return target;
})();

export const memory = openMemoryDb(MEMORY_DB_PATH, {
  backup: {
    intervalMs: Number(process.env.MEMORY_BACKUP_INTERVAL_MS) || 6 * 60 * 60 * 1000,
    retain: Number(process.env.MEMORY_BACKUP_RETAIN) || 28,
    // dir defaults to <dbDir>/backups
  },
});

// Adapt LLM to the ExtractorLlmClient interface
const extractorLlm: ExtractorLlmClient = {
  async complete(prompt: string) {
    const resp = await llm.send([{ role: 'user', content: prompt }]);
    return {
      text: resp.type === 'text' ? resp.content : '',
      tokensUsed: 0, // LLM adapter does not expose token counts; estimation can be added later
    };
  },
};

// Wire the conscience gate's judge LLM (the gate stays a no-op unless PHILONT_CONSCIENCE_GATE is on).
setConscienceLlm(extractorLlm);

// Intrinsic-drive audit log: all cross-session self-domain internal writes (extractor/reflector/compactor)
// are recorded through this AuditLog. SHA-256 chain covers all Internal-origin events.
export const internalAudit = new AuditLog();

// ── Pursuit / Constitution startup: soul identity registration ─────────────────────────
//
// Since v7 the root row of the pursuit table is the agent identity. initSchema inside openMemoryDb()
// already ensures the bootstrap root ("default") exists. Here we read the four constitution fields
// of root, compute SHA-256, and record a constitution_load audit event — serving as a soul integrity
// credential. Within a session the constitution is treated as frozen; even if the DB is changed externally, the change
// takes effect only after the next restart.
const bootRoot = memory.pursuits.getDefaultRoot();
if (bootRoot) {
  const loaded = loadConstitution(
    memory.pursuits,
    BOOTSTRAP_ROOT_PURSUIT_ID,
    internalAudit,
  );
  console.log(
    `[pursuit] bootstrap root=${bootRoot.id} title="${bootRoot.title}" ` +
      `constitution_hash=${loaded.hash.slice(0, 12)}...`,
  );
} else {
  // Should never reach here — initSchema guarantees the bootstrap root exists
  console.warn(
    '[pursuit] bootstrap root pursuit missing, memory-db init may have failed',
  );
}
/** Exposed for downstream use (future TS-side drive runtime, reflector drive_bounds validation, etc.) */
export const constitution = bootRoot
  ? loadConstitution(memory.pursuits, BOOTSTRAP_ROOT_PURSUIT_ID).fields
  : null;

const extractor = new SessionExtractor(
  extractorLlm,
  memory.facts,
  memory.notes,
  memory.raw,
  {
    timezone: process.env.AGENT_TIMEZONE || 'UTC',
    calendar: memory.calendar,
    auditHook: internalAudit,
  },
);

const reflector = new SessionReflector(
  extractorLlm,
  memory.skills,
  memory.actions,
  memory.raw,
  { auditHook: internalAudit },
);

// v7: pursuit proposer (shadow state) — at session end, identify unclosed inquiry topics from the conversation
const pursuitExtractor = new SessionPursuitExtractor(
  extractorLlm,
  memory.pursuits,
  memory.raw,
  { auditHook: internalAudit, rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
);

// v7: drive reflector — scan drive_outcomes to back-fill utility + tune parameters within constitution.driveBounds
const driveReflector = new SessionDriveReflector(
  memory.driveOutcomes,
  memory.driveConfigs,
  memory.pursuits,
  { auditHook: internalAudit, rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
);

// K3: emergent identity reflector — at session end, synthesize skills/pursuits to produce first-person self-description,
// and write to memory_facts['self.*']. Non-reflector paths cannot write; the agent can read.
const selfReflector = new SelfReflector(
  extractorLlm,
  memory.facts,
  memory.skills,
  memory.pursuits,
  memory.actions,
  memory.driveOutcomes,
  { auditHook: internalAudit, rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
);

// K3 cleanup: at startup, verify that sourceRefs in self.summary / strengths / growth_edges
// still reference valid skills / pursuits. High stale rate → asynchronously trigger reflectSelf regeneration,
// without blocking startup. Prevents "ghost references" from being endlessly injected into LLM context.
{
  const integrity = verifySelfSummaryIntegrity({
    facts: memory.facts,
    skills: memory.skills,
    pursuits: memory.pursuits,
  });
  if (integrity.totalRefs === 0) {
    console.log('[self-integrity] no self.* facts to verify (fresh agent or first run)');
  } else {
    console.log(
      `[self-integrity] ${integrity.validRefs}/${integrity.totalRefs} refs valid (score=${integrity.integrityScore.toFixed(2)})`,
    );
    if (integrity.staleRefs.length > 0) {
      console.warn(`[self-integrity] stale refs: ${integrity.staleRefs.join(', ')}`);
    }
  }
  internalAudit.append('self_domain_access', {
    source: 'self_summary_integrity',
    origin: 'Internal',
    toolName: 'startup_check',
    totalRefs: integrity.totalRefs,
    validRefs: integrity.validRefs,
    staleRefs: integrity.staleRefs,
    integrityScore: integrity.integrityScore,
  });
  // Stale rate ≥ 30% (integrityScore < 0.7) → regenerate asynchronously. Fire-and-forget, does not block startup.
  if (integrity.totalRefs > 0 && integrity.integrityScore < 0.7) {
    console.warn(
      `[self-integrity] score=${integrity.integrityScore.toFixed(2)} < 0.7, triggering async reflectSelf`,
    );
    selfReflector.reflect().then(
      (r) => console.log(`[self-integrity] async reflect done: updated=${r.updated} sourceIntegrity=${r.sourceIntegrity?.toFixed(2)}`),
      (e) => console.warn('[self-integrity] async reflect failed:', e),
    );
  }
}

// v7: per-turn drive runtime (TS side) — evaluates drives and injects Internal-origin messages each turn
// within the server's own synchronous chat loop. Attached before/after LLM calls in handleChatSendInner.
//
// Kernel drives (species-level character, every philont agent should mount these):
//   - TaskCommitmentDrive (competitive drive / task commitment)
//   - CuriosityDrive (curiosity)
// More drives can be registered later or dynamically loaded from memory_drive_configs (TS version of DeclarativeEngine).
//
// Note: TsOpenLoopDrive (dangling-question retrieval, ported from Rust) was previously mounted and removed on 2026-05-03 —
// trigger conditions were extremely strict (combined hit rate < 1% of conversations), overlapped with existing K0 timeline recall / K3 pursuits /
// askUserQuestion mechanisms, and the original semantic "user has not replied for a long time" could not cover the more
// realistic "user short-answer treated as new topic by LLM" problem. Maintenance cost > benefit.
//
// maxInjectionsPerTurn=2: up to 2 intrinsic-drive messages may be injected per turn; higher-Utility winner goes first.
const driveRuntime = new TsDriveRuntime(memory.driveOutcomes, {
  rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  auditHook: internalAudit,
  maxInjectionsPerTurn: 2,
});
// K2a: competitive drive (kernel character, to be migrated to Rust). Detects the previous-turn "punt task back to user"
// pattern and injects "think of another approach". See kernel_drives.ts.
driveRuntime.register(
  new TsTaskCommitmentDrive('task-commitment', {
    cooldownMs: 90_000,
    minMessageLen: 8,
  }),
);
// Note: K2c TsCuriosityDrive (turn-time "nudge LLM to look it up") was removed on 2026-05-06,
// replaced by the CuriosityDriver in K8 proactivity layer (agent-memory/src/autonomous/) —
// the latter is an idle-time driver that actually runs webSearch / searchNotes, not an injection reminder.
// See startAutonomousLoop below.

// Context compactor: summarize the middle segments when the conversation exceeds the threshold
const compactor = new Compactor(extractorLlm, memory.notes, {
  // 2026-05-13: 100K → 180K + add hard-cap 250K safety net + protectLastN 6→10.
  // Background: mycox production observed compression triggering mid tool-loop (107K→24K), summarizing plan_id
  // into the summary; LLM then called plan_update_step from memory and failed 4 times. Fix:
  //   1) Use soft threshold (180K) at turn-entry "quiet period" — not mid plan/tool chain
  //   2) In-turn tool loop only triggers at hard cap (250K) as a safety net against window overflow
  //   3) protectLastN 6→10 gives active plan/tool chain tail more room to avoid compression
  // env overrides still available: COMPACT_THRESHOLD_TOKENS / COMPACT_HARD_THRESHOLD_TOKENS.
  thresholdTokens: Number(process.env.COMPACT_THRESHOLD_TOKENS) || 180_000,
  hardThresholdTokens: Number(process.env.COMPACT_HARD_THRESHOLD_TOKENS) || 250_000,
  protectFirstN: 2,   // preserve system prompt + first turn
  protectLastN: 10,   // preserve the most recent ~5 conversation turns (gives active plan/tool chain tail room)
}, { auditHook: internalAudit });

// ── K7 interrupt infrastructure (2026-04-27) ─────────────────────────────────────────
// Uses real Rust FFI: JsInterruptController is the napi wrapper of agent-core. mapper fires interrupt
// through it → broadcasts to drainer's 4 callbacks → drainer buffers →
// chat-handler drains during buildMemoryPrefix → outputs to system section (not the user-role slot).
//
// receiver is currently unused (server does not run agent-core's run_agent_loop); kept for future reuse
// when Rust kernel drives are integrated via the same channel pair.
const { controller: interruptController, receiver: _interruptReceiver } = interruptChannelJs();
const interruptDrainer = new InterruptDrainer(interruptController);
const interruptMapper = new InterruptMapper(interruptController, {
  // Default thresholds: NORMAL=0.4 / HIGH=0.7 / CRITICAL=0.9 + hysteresis 0.15 + cooldown 30s
});

// Reader of "last service time" used by idle_consolidator
function lastAssistantTs(): number | null {
  const m = memory.raw.getLastMessageByRole('assistant');
  return m ? m.timestamp : null;
}

/** mapper FireRecord → kind string (for audit / rendering), consistent with the logic inside mapper */
function signalKindForFire(signalName: string, level: 'IDLE' | 'NORMAL' | 'HIGH' | 'CRITICAL'): string {
  if (signalName === 'service_dormancy') return 'BoredomThreshold';
  if (signalName === 'commitment_pressure') {
    return level === 'CRITICAL' || level === 'HIGH' ? 'IdentityThreat' : 'SteerMessage';
  }
  return 'SteerMessage';
}

function levelToSeverityStr(level: 'IDLE' | 'NORMAL' | 'HIGH' | 'CRITICAL'): string {
  return level.toLowerCase();
}

/** Snapshot of all current signals used by mapper.tick */
function collectSignalSnapshot(): { [name: string]: number } {
  const dorm = computeServiceDormancy({
    lastAssistantTs: lastAssistantTs(),
    now: Date.now(),
  });
  return {
    commitment_pressure: signalState.commitmentPressure,
    service_dormancy: dorm.dormancy,
  };
}

// K0.6: idle_consolidator — replaces the old "ws.close → finalizeSession" path.
// A background timer checks idleness (time since the latest message on the raw global timeline); when idle exceeds the threshold
// + new messages accumulated reach minNewMessages → run extractor + reflector + onConsolidate
// hooks (used to attach pursuitExtractor / selfReflector / driveReflector). cursor
// progress is stored in memory_facts['system.last_consolidated_ts'], idempotent across restarts.
const idleConsolidator = startIdleConsolidator({
  raw: memory.raw,
  facts: memory.facts,
  extractor,
  reflector,
  idleThresholdMs: Number(process.env.IDLE_CONSOLIDATE_THRESHOLD_MS) || 5 * 60_000,
  minNewMessages: Number(process.env.IDLE_CONSOLIDATE_MIN_MSGS) || 4,
  tickIntervalMs: Number(process.env.IDLE_CONSOLIDATE_TICK_MS) || 60_000,
  async onConsolidate({ fromTs, toTs }) {
    // K3 self-description reflection: not bounded by time window; synthesizes all skills/pursuits to produce
    try {
      const r = await selfReflector.reflect();
      if (r.updated) {
        console.log(
          `[idle-consolidator] self-reflect: sourceIntegrity=${r.sourceIntegrity.toFixed(2)}`,
        );
      }
    } catch (e) {
      console.error('[idle-consolidator] self-reflect failed', e);
    }
    // pursuit proposal (bounded by time window)
    try {
      const r = await pursuitExtractor.extractFromTimeRange(fromTs, toTs);
      if (r.pursuitsProposed > 0) {
        console.log(`[idle-consolidator] new shadow pursuits: ${r.pursuitsProposed}`);
      }
    } catch (e) {
      console.error('[idle-consolidator] pursuit-extract failed', e);
    }
    // drive reflection (scan unscored outcomes to back-fill utility + tune parameters)
    try {
      const r = await driveReflector.reflect();
      if (r.outcomesScored > 0 || r.driveParamsTuned > 0) {
        console.log(
          `[idle-consolidator] drive-reflect: scored=${r.outcomesScored}, tuned=${r.driveParamsTuned}`,
        );
      }
    } catch (e) {
      console.error('[idle-consolidator] drive-reflect failed', e);
    }
    // Tier 2 signal: recompute commitment_pressure during idle period and record audit event
    // making "how many open items the agent has accumulated this week" an observable trace.
    try {
      const active = memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID);
      const breakdown = signalState.recomputeCommitmentPressure(active, Date.now());
      internalAudit.append('self_domain_write', {
        source: 'signal_recompute',
        origin: 'Internal',
        toolName: 'signal_computed',
        signal: 'commitment_pressure',
        value: breakdown.pressure,
        activeCount: breakdown.activeCount,
        topContributors: breakdown.contributors.slice(0, 3).map((c) => ({
          id: c.pursuitId,
          title: c.title,
          ageH: Math.round(c.ageHours),
          stake: c.stakeWeight,
          contrib: Number(c.contribution.toFixed(3)),
        })),
      });
      if (breakdown.pressure > 0.3) {
        console.log(
          `[signal] commitment_pressure=${breakdown.pressure.toFixed(2)} (${breakdown.activeCount} active)`,
        );
      }
    } catch (e) {
      console.error('[signal] commitment_pressure recompute failed', e);
    }
    // K7.2: aggregate all signals → mapper.tick → fire interrupt to controller →
    // broadcast to drainer. This is the only trigger point for the "hormone → interrupt" chain (during idle).
    try {
      const snapshot = collectSignalSnapshot();
      const fires = interruptMapper.tick(snapshot);
      for (const f of fires) {
        internalAudit.append('self_domain_write', {
          source: 'interrupt_mapper',
          origin: 'Internal',
          toolName: 'signal_threshold_crossed',
          signal: f.signal,
          severity: f.level,
          prevSeverity: f.prevLevel,
          value: f.value,
          firedAtMs: f.firedAtMs,
        });
        console.log(
          `[interrupt] fire ${f.level} on ${f.signal} (value=${f.value.toFixed(2)}, was ${f.prevLevel})`,
        );
      }
    } catch (e) {
      console.error('[interrupt] mapper.tick failed', e);
    }
    // 2026-05-06 D.1: routing rule time decay. No activity for 30 days → demote one level; 90 days → retired.
    // Idempotent — multiple ticks within the same idle window will not repeat the demotion (updated_at is already fresh after demotion).
    try {
      const r = memory.routingRules.decayStale(Date.now());
      if (r.demoted > 0 || r.retired > 0) {
        internalAudit.append('self_domain_write', {
          source: 'routing_decay',
          origin: 'Internal',
          toolName: 'routing_rules_decayed',
          demoted: r.demoted,
          retired: r.retired,
        });
        console.log(
          `[routing-decay] demoted=${r.demoted} retired=${r.retired}`,
        );
      }
    } catch (e) {
      console.error('[routing-decay] failed', e);
    }
    // 2026-05-29 predictive proactive: deadline pursuit → schedule soft wake-up.
    // For active pursuits with a deadline and high enough stake, schedule a one-shot autonomous_turn
    // ahead of the deadline for read-only preparation. Reconcile to desired state (idempotent): create if absent / reschedule if deadline changed
    // / cancel if pursuit closed or stake lowered / sweep orphans. Does not touch interrupts or the turn loop.
    try {
      const active = memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID);
      const r = reconcilePredictiveWakeups({
        pursuits: active,
        now: Date.now(),
        schedules: memory.schedules,
      });
      if (r.created > 0 || r.updated > 0 || r.cancelled > 0) {
        internalAudit.append('self_domain_write', {
          source: 'predictive_wakeup',
          origin: 'Internal',
          toolName: 'predictive_wakeup_reconciled',
          created: r.created,
          updated: r.updated,
          cancelled: r.cancelled,
        });
        console.log(
          `[predictive-wakeup] created=${r.created} updated=${r.updated} cancelled=${r.cancelled}`,
        );
      }
    } catch (e) {
      console.error('[predictive-wakeup] reconcile failed', e);
    }
    // 2026-05-06 Phase C: ServiceDriver — when the agent has been dormant for a long time and accumulated ≥ N done initiatives,
    // proactively send a digest push to (channel, peer) pairs with opt-in subscriptions.
    // dispatcher internally re-checks enabled / frequency / quiet / dedup; here we only decide "is it worth enqueuing".
    try {
      const r = await serviceDriverTick({
        raw: memory.raw,
        initiatives: autonomousLoop.initiatives,
        dispatcher: pushDispatcher,
      });
      if (r.triggered) {
        internalAudit.append('self_domain_write', {
          source: 'service_driver',
          origin: 'Internal',
          toolName: 'service_checkin_enqueued',
          dormantHours: r.dormantHours,
          findings: r.findings,
          dispatchDelivered: r.dispatchDelivered,
          dispatchSkipped: r.dispatchSkipped,
        });
      }
    } catch (e) {
      console.error('[service-driver] tick failed', e);
    }
    // 2026-05-07 path 7: user behavior observation — detect repeated action chains across turns, write candidates to
    // facts.user.patterns, to be rendered in the next user-turn buildMemoryPrefix.
    // Runs at most once every ≥ 24h to prevent noise (each idle tick is 60s, ~1440 ticks/day).
    try {
      const lastTickKey = 'system.user_pattern_last_tick_ts';
      const lastTick = memory.facts.getFact('system', 'user_pattern_last_tick_ts');
      const lastTs = lastTick && typeof (lastTick.value as { ts?: number })?.ts === 'number'
        ? ((lastTick.value as { ts: number }).ts)
        : 0;
      if (Date.now() - lastTs > 24 * 60 * 60 * 1000) {
        const candidates = detectRecurringUserPatterns({
          raw: memory.raw,
          actions: memory.actions,
          windowDays: 30,
          minOccurrences: 3,
        });
        for (const c of candidates) {
          // Skip already confirmed/declined ones
          const existing = memory.facts.getFact('user.patterns', c.signature);
          if (existing) {
            const v = existing.value as { status?: string } | undefined;
            if (v?.status === 'confirmed' || v?.status === 'declined') continue;
          }
          savePatternCandidate(memory.facts, c);
        }
        memory.facts.storeFact({
          namespace: 'system',
          key: 'user_pattern_last_tick_ts',
          value: { ts: Date.now() },
          confidence: 1,
        });
        if (candidates.length > 0) {
          console.log(`[user-pattern] propose ${candidates.length} pending`);
        }
        // expire pending items with no response for 7+ days → 'expired' (avoid long-term accumulation)
        const pending = listPendingPatterns(memory.facts);
        const sevenDaysAgo = Date.now() - 7 * 86400_000;
        for (const p of pending) {
          if (p.proposedAt < sevenDaysAgo) {
            markPatternStatus(memory.facts, p.signature, 'expired');
          }
        }
      }
    } catch (e) {
      console.error('[user-pattern] tick failed', e);
    }

    // 2026-05-12 Phase 8 M3: MetaConfigObserver — scan internalAudit for patterns,
    // automatically write config_rules (provisional). Only proposes when same pattern appears ≥ threshold times; dedup idempotent.
    // env PHILONT_META_OBSERVER=0 to disable. Failures are swallowed in try/catch, main flow unaffected.
    if (process.env.PHILONT_META_OBSERVER !== '0') {
      try {
        const result = runMetaConfigObserver({
          auditEvents: internalAudit.getEvents(),
          configRules: memory.configRules,
        });
        if (result.insertedRuleIds.length > 0) {
          console.log(
            `[meta-config] inserted ${result.insertedRuleIds.length} new provisional rule(s):`,
            result.proposals.map((p) => `${p.pattern}:${p.scope}=${JSON.stringify(p.value)}`),
          );
          internalAudit.append('self_domain_write', {
            source: 'meta_config_observer',
            origin: 'Internal',
            toolName: 'config_rule_proposed',
            insertedCount: result.insertedRuleIds.length,
            skippedExisting: result.skippedExisting,
            proposals: result.proposals.map((p) => ({
              pattern: p.pattern,
              scope: p.scope,
              value: p.value,
              evidence: p.evidence,
            })),
          });
        }
      } catch (e) {
        console.error('[meta-config] observer tick failed', e);
      }
    }

    // 2026-05-12 Phase 8 M4 (= 8B): BugDetector — scan internalAudit for logic-layer bugs,
    // output a precise bug report (file_hint + expected/actual + fix_proposal).
    // Does not write code; only emits audit event 'bug_report_generated' so engineers can locate and fix within 1 minute.
    // dedup maintained across ticks: bugReportRecentKeys module-level Set (24h TTL; currently reset on idle)
    // env PHILONT_BUG_DETECTOR=0 to disable.
    if (process.env.PHILONT_BUG_DETECTOR !== '0') {
      try {
        const result = runBugDetector({
          auditEvents: internalAudit.getEvents(),
          recentlyReported: bugReportRecentKeys,
        });
        for (const report of result.reports) {
          bugReportRecentKeys.add(report.key);
          console.warn(
            `[bug-detector] ${report.pattern} (${report.severity}): ${report.title}`,
          );
          internalAudit.append('bug_report_generated', {
            source: 'bug_detector',
            origin: 'Internal',
            toolName: 'bug_report_generated',
            pattern: report.pattern,
            key: report.key,
            title: report.title,
            severity: report.severity,
            expected: report.expected,
            actual: report.actual,
            fileHint: report.fileHint,
            fixProposal: report.fixProposal,
            count: report.count,
            firstSeen: report.firstSeen,
            lastSeen: report.lastSeen,
            evidence: report.evidence.slice(0, 5),
          });
        }
      } catch (e) {
        console.error('[bug-detector] tick failed', e);
      }
    }
  },
});

// 2026-05-12 Phase 8 M4: bug report dedup state (maintained across idle ticks).
// Reset every 24h to prevent unbounded growth. Can also be manually cleared by admin (reportedBugKeys.clear()).
const bugReportRecentKeys = new Set<string>();
setInterval(() => {
  bugReportRecentKeys.clear();
}, 24 * 60 * 60_000).unref();

// Adapt the memory tools provided by agent-memory (store_fact/get_fact/list_facts/search_notes/
// search_skills/use_skill/create_calendar_event/list_upcoming/schedule_reminder)
// to the agent-policy Tool interface, and add them to the toolset.
// Memory tools have domain='self'; they must enter the registry via extraInternalTools (using registerInternal).
const memoryToolAdapters: Tool[] = createMemoryTools(
  memory.facts,
  memory.notes,
  memory.skills,
  memory.calendar,
  memory.schedules,
  memory.raw,
).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    // Phase 13.5 (2026-05-18): schedule_reminder post-hook — if the LLM did not pass a project but the current session
    // has an active plan.persistedTo, automatically fill in schedule.project.
    // When a scheduled session fires later, chat-handler.buildMemoryPrefix uses this project to
    // look up plan.md and inject it into the prefix. Mechanism-layer safety net: even if the LLM forgets to pass project, the plan.md pipeline still works.
    if (
      t.name === 'schedule_reminder' &&
      r.success &&
      r.data &&
      typeof r.data === 'object' &&
      !(params as { project?: string }).project
    ) {
      try {
        const sched = r.data as { id?: string; project?: string | null };
        if (sched.id && !sched.project) {
          const sid = currentSessionId();
          if (sid) {
            const activePlan = memory.plans.listBySession(sid, { limit: 1 })[0];
            if (activePlan?.persistedTo) {
              memory.schedules.setProject(sched.id, activePlan.persistedTo);
              console.log(
                `[schedule-project-autofill] schedule=${sched.id} project=${activePlan.persistedTo} ` +
                  `(from session active plan, no project passed by LLM)`,
              );
            }
          }
        }
      } catch (e) {
        console.warn('[schedule-project-autofill] failed (ignored):', e);
      }
    }
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// 2026-05-07:SecretStore + saveCredential / removeCredential / listCredentialNames
// Tools (domain='self', only user-driven turns may record credentials; autonomous_turn blacklist prohibits them).
// Persisted to ~/.philont/secrets.json (AES-256-GCM encrypted; master key provided by
// PHILONT_MASTER_KEY env or ~/.philont/secret.key).
const SECRETS_PATH = join(homedir(), '.philont', 'secrets.json');
const secretStore = new SecretStore({ path: SECRETS_PATH });
console.log(`[secrets] SecretStore loaded ${secretStore.list().length} entries from ${SECRETS_PATH}`);
const credentialToolAdapters: Tool[] = createCredentialTools(secretStore);

// 2026-05-06 Phase C: subscribePush / unsubscribePush tools (domain='self').
// The LLM calls them when the user **explicitly** requests notifications. description is strictly constrained.
const pushToolAdapters: Tool[] = createPushTools(memory.pushSubscriptions).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// GrantStore singleton: dynamic authorization (with TTL decay). Shared by PolicyGate auth flow + proactive research "request permission".
// Defined before researchToolAdapters / PursuitDriver / executor so they can consume it.
const globalGrants = new GrantStore();

// 2026-05-30 proactive research loop: research_focus + grant_research_tool tools (domain='self').
// When the user explicitly requests "continuously research X", the LLM calls research_focus to register an active-research pursuit;
// the autonomous loop's PursuitDriver then advances it each tick. When background research needs a gated tool, it requests permission;
// the user calls grant_research_tool (passing globalGrants) to grant a bounded audited authorization within the conversation.
const researchToolAdapters: Tool[] = createResearchTools(memory.pursuits, globalGrants).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// 2026-05-11 (v17 complex-task protocol): task_mode_classify + plan_* tool suite.
// When the LLM opens a turn in slow mode it calls task_mode_classify('slow') → plan_draft → plan_review
// → execute → plan_close. The mechanism-layer plan_protocol_gate (dispatch section) enforces completion of the flow.
//
// Task mode store is a module-scoped in-memory KV (per session); the current turn sid is retrieved via ALS.
// PlanStore has been mounted to memory.plans inside openMemoryDb (schema v17).
const taskModeStore = new InMemoryTaskModeStore();
const taskModeToolAdapters: Tool[] = createTaskModeTools({
  store: taskModeStore,
  getCurrentSessionId: () => currentSessionId() ?? 'unknown',
  // Phase 10 P0 (2026-05-14): check for active plan when reverting slow→fast.
  // Plan in draft/reviewed/executing → reject (prevents LLM from bypassing plan_protocol_gate by switching mode).
  // 2026-05-14 production fix: even if plan is already closed to failed/completed, if updatedAt is within the
  // cooling window (default 60s), still return it — triggers the lock, blocking the plan_close→mode-switch bypass.
  getActivePlan: () => {
    const sid = currentSessionId();
    if (!sid) return null;
    const p = memory.plans.listBySession(sid, { limit: 1 })[0];
    if (!p) return null;
    // Return regardless of status (the lock inside decides based on status + cooling);
    // caller only queries when mode='fast' && current store='slow', does not affect other paths.
    return {
      id: p.id,
      status: p.status,
      reviewCount: p.reviewHistory.length,
      updatedAt: p.updatedAt,
    };
  },
}).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));
// v19 (2026-05-13): per-session signalBus map. outer handleChatSend sets it at each
// turn entry and deletes it in the finally block. createPlanTools is called once at module load;
// when plan_close.execute runs it looks up this Map via currentSessionId() to get the current turn's
// honesty / interruptDrained signals → converts to PlanCloseSignals for strict validation.
const activeSignalBuses = new Map<string, TurnSignalBus>();

// Interrupt teeth (2026-05-29): per-session turn AbortController.
// outer handleChatSend creates a new one at each turn entry and deletes it in the finally block.
// User mid-turn stop (UserHardStop) goes: ws `chat.stop` → abortActiveTurn(sessionId) →
// .abort() → (1) passed to the LLM HTTP call to cancel in-flight requests, (2) runToolLoop checks .aborted
// at each iteration / tool boundary to exit early.
// This is the TS implementation of the K7 CRITICAL channel in production (Rust loop refactor frozen).
const activeTurnAborters = new Map<string, AbortController>();

/** Get the AbortSignal for the current turn (used for boundary checks in sendLlmWithRescue / runToolLoop). */
function turnAbortSignal(sessionId: string): AbortSignal | undefined {
  return activeTurnAborters.get(sessionId)?.signal;
}

/**
 * Identify abort exceptions caused by "user mid-turn stop".
 * Anthropic SDK throws APIUserAbortError; fetch (OpenAI-compatible endpoint) throws DOMException with name='AbortError'.
 * Both are treated uniformly as UserHardStop, mapped to interrupted outcome (not an error).
 */
export function isAbortError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/**
 * Stop the current turn mid-flight (UserHardStop). Called by ws `chat.stop`.
 * Returns true if the session currently has an active turn and an abort has been issued.
 */
export function abortActiveTurn(sessionId: string): boolean {
  const aborter = activeTurnAborters.get(sessionId);
  if (!aborter || aborter.signal.aborted) return false;
  aborter.abort();
  return true;
}

/**
 * Global emergency stop: abort **all** turns currently running across all sessions. Returns the count of actual aborts issued.
 * Together with autonomousLoop.pause(), forms the "one-click stop everything" mechanism.
 */
export function abortAllTurns(): number {
  let n = 0;
  for (const aborter of activeTurnAborters.values()) {
    if (!aborter.signal.aborted) { aborter.abort(); n++; }
  }
  return n;
}

// Phase 11 (2026-05-14): per-session messages reference, for plan_review tool to query
// "recent assistant text" to detect the self-review section. outer handleChatSend sets it at each
// turn entry and deletes in the finally block. Returns a reference to the current messages array (no copy).
const activeSessionMessages = new Map<string, NativeMessage[]>();

// Phase 12 refactor (2026-05-17): plan_protocol_gate switched to 3×4 capability/domain decision.
//
// Old implementation used a hardcoded whitelist by tool name (PLAN_PROTOCOL_READONLY_EXEMPT), decoupled from agent-policy's
// 3×4 PermissionMatrix — adding any read-only tool required changing the gate whitelist,
// and self×write (store_fact / saveCredential, etc.) was incorrectly blocked, violating the 3×4 principle
// (self domain = agent self-state, non-externalizing, write does not need approval).
//
// New rules (layered):
//   1. plan_* / task_mode_classify: protocol-layer tools, always passed through
//   2. askUserQuestion: even if classified as read, questioning the user is not allowed during the plan-drafting phase (semantic special case)
//   3. read any domain → pass (research / read facts, no mutation)
//   4. write × self → pass (memory self-managed, consistent with 3×4 self×write not requiring approval)
//   5. others (write × local/network, execute × *) → block, subject to plan state constraints
//
// Relationship to 3×4: gate adds plan-state constraints on top of 3×4. Tools already blocked by 3×4 (write network /
// execute) do not need the gate to repeat; those allowed by 3×4 but crossing plan boundaries (write local / execute local)
// get additional gate constraints. The two layers are orthogonally composable.
//
// Phase 18 (2026-05-27): isPlanGateExempt / isReadOnlyShellCommand extracted to a separate module
// to prevent unit tests from hanging due to top-level DB side-effects when importing chat-handler.ts.
// Uses import + re-export internally to keep call sites unchanged — `export ... from` alone does not bring the
// binding into this module's scope, and the 4 gate call sites would get ReferenceError.
import { isPlanGateExempt, isReadOnlyShellCommand } from './plan_gate.js';
export { isPlanGateExempt, isReadOnlyShellCommand };

// Phase 10 M1 (2026-05-14): persist fetched resources to local disk.
// Intercepts successful webFetch / readFile tool_results → saves to ~/.philont/workspace/fetched/.
// plan_aux_llm.resolveGuideText queries this store to get the actual guide.md content for aux.
// env PHILONT_FETCHED_ENABLED=0 to disable (reverts to Phase 9.2 "not fetched" placeholder behavior).
const fetchedStore = new FetchedResourceStore();
console.log(
  `[fetched-store] config: enabled=${fetchedStore.enabled ? 'on' : 'off'} baseDir=${fetchedStore.baseDir}`,
);

const planToolAdapters: Tool[] = createPlanTools({
  plans: memory.plans,
  skills: memory.skills,
  getCurrentSessionId: () => currentSessionId() ?? 'unknown',
  // M4 (2026-05-15): spec-coverage R1 validates minimum deliverables count for slow tasks
  getIsSlow: () => {
    const sid = currentSessionId();
    if (!sid) return false;
    return taskModeStore.get(sid) === 'slow';
  },
  getCloseTimeSignals: () => {
    const sid = currentSessionId();
    if (!sid) return null;
    const bus = activeSignalBuses.get(sid);
    if (!bus) return null;
    // sameRootCauseFailures: computed in real time at close moment over a 24h / 30-entry window (the true signal
    // before turn finalization; does not depend on a post-turn-end copy).
    let sameRoot = 0;
    try {
      const sinceTs = Date.now() - 24 * 60 * 60_000;
      const recent = memory.actions.listRecentFailures({ sinceTs, limit: 30 });
      sameRoot = countSameRootCauseFailures(recent);
    } catch {
      // Failures in computing the failure window are swallowed; does not affect close — close-time validation falls back to
      // checking only step / evidence / honesty.
    }
    return {
      honestyReason: bus.honesty?.evaluation.reason ?? null,
      honestySeverity: bus.honesty?.evaluation.severity ?? null,
      sameRootCauseFailures: sameRoot,
    };
  },
  // Phase 9.2 M3 (2026-05-13) pre-wired: plan_close immediately writes back to signalBus on invocation;
  // turn finalization fallback uses this to determine "did the LLM call plan_close".
  markPlanCloseCalled: () => {
    const sid = currentSessionId();
    if (!sid) return;
    const bus = activeSignalBuses.get(sid);
    if (bus) bus.planCloseCalled = true;
  },
  // Phase 13(2026-05-17):per-project plan.md hook
  planFiles: memory.planFiles,
  // M2 / Phase 11 (2026-05-15) removed: auxLLMFn / fetchedStoreLookup /
  // getRecentAssistantText — aux LLM re-review + self-review checks entirely removed;
  // the nested-call trap was empirically ineffective.
}).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// All tools registered → access control delegated to PolicyGate's 3×4 matrix + GrantStore authorization flow.
// Design rationale: profile is "which tools exist"; PermissionMatrix is "whether they can execute".
// Having profile do access control = silently swallowing tools; users never know the agent has capabilities like shell/process/patch
// — the authorization flow never gets a chance to trigger.
//
// Current createReadOnlyMatrix(): read=local/network/self, write=self only, execute=all blocked.
// So writeFile/shell/git/process etc. trigger onAuthRequest to ask the user on the first call;
// user replies "allow" → grants.grant(tool, capability, domain) authorizes this session for 10 minutes.
//
// The old utility/memory (volatile Map) is still included automatically from full, but we additionally inject
// persistent agent-memory tools via extraInternalTools — the conflict between the two sets of memory tools needs attention;
// createToolset below should prefer extraInternalTools, overriding same-named builtins.
// replyWithMedia is a channel-aware tool: whether it succeeds depends on whether the current sessionId
// corresponds to a channel with media-sending capability registered (e.g. wechat). Under a web-ui session
// it returns a clear "this session does not support sending media" error; the LLM falls back to writeFile + text notification.
// capability=write/domain=network → PolicyGate sends onAuthRequest on first call.
const channelTools: Tool[] = [replyWithMediaTool];

// installSkill / uninstallSkill wrappers: **synchronously await reloadSkillsFromDisk** after execute,
// eliminating the "installed but not usable" inconsistency window. See skill_install_wrapper.ts.
const installSkillSync = wrapSkillToolWithReload(installSkillTool, reloadSkillsFromDisk);
const uninstallSkillSync = wrapSkillToolWithReload(uninstallSkillTool, reloadSkillsFromDisk);

const tools = createToolset({
  profile: 'server',
  customProfiles: {
    server: {
      extends: 'coding',
      // Remove volatile memory (Map): its semantics look nearly identical to the persistent store_fact/get_fact/search_notes
      // to the LLM; keeping it would tempt it to store important facts in the Map, which are lost on next startup.
      // Remove original installSkill/uninstallSkill: fs-only, install→use not visible within the same turn.
      // extraInternalTools below replaces them with wrapped versions that synchronously reload after execution.
      exclude: ['memory', 'installSkill', 'uninstallSkill'],
    },
  },
  extraInternalTools: [
    ...memoryToolAdapters,
    ...pushToolAdapters,
    ...researchToolAdapters,
    ...credentialToolAdapters,
    ...taskModeToolAdapters,
    ...planToolAdapters,
    ...channelTools,
    installSkillSync,
    uninstallSkillSync,
  ],
  // 2026-05-07: hook up SecretStore so the http tool uses the secured variant, supporting {SECRET_NAME}
  // placeholders. Credentials written by saveCredential can be referenced directly in http headers / body.
  secretStore,
});

// ── planAndExecute composite tool(2026-05-07)─────────────────────────────
// Parent turn calls once → internally plans + runs sub-tasks via a mini-agent-loop → aggregates and returns.
// From the parent turn's perspective, 1 iteration completes without hitting the MAX_TOOL_LOOP_ITERATIONS cap.
//
// Design doc: /root/.claude/plans/misty-juggling-mist.md (planAndExecute plan)
//
// Sub-loop blacklist:
//   - planAndExecute (prevent nested recursion with unbounded budget)
//   - askUserQuestion (sub-loop is non-interactive)
//   - installSkill / uninstallSkill (self domain cannot be written by sub-loop)
const PLAN_EXEC_BLACKLIST: ReadonlySet<string> = new Set([
  'planAndExecute',
  'askUserQuestion',
  'installSkill',
  'uninstallSkill',
  // Credential recording is only allowed in user-driven turns; sub-loop inside planAndExecute / autonomous turns
  // cannot modify secrets.
  'saveCredential',
  'removeCredential',
]);

// 2026-05-10: autonomous turn (system:scheduled:*) tool blacklist.
// K0 session filtering (408eb0a) cuts off cross-session contamination; but autonomous heartbeats
// could still go astray if the LLM takes a wrong path (e.g. calling writeFile / shell to work around an API failure).
// Production mycox heartbeat called writeFile → auth_pending → turn blocked; confirms the blacklist
// is still a necessary defense-in-depth.
//
// Blacklist principles:
//  - askUserQuestion: autonomous has no user to ask
//  - cancel_schedule / schedule_reminder: prevent self-destruction + prevent uncontrolled creation of new schedules
//  - saveCredential / removeCredential / installSkill / uninstallSkill: writing
//    self / credentials only allowed in user-driven turns
//  - shell / writeFile / patch / editFile: heavy side-effects; if autonomous errs
//    there is no user rescue; read-only tools (http / readFile / listDir, etc.) suffice
//  - forgetFact: prevent losing user memory
//  - planAndExecute: prevent nested unbounded budget
const AUTONOMOUS_TURN_BLACKLIST_HARDCODED: ReadonlySet<string> = new Set([
  'askUserQuestion',
  'cancel_schedule',
  'schedule_reminder',
  'saveCredential',
  'removeCredential',
  'installSkill',
  'uninstallSkill',
  'forgetFact',
  'shell',
  'writeFile',
  'patch',
  'editFile',
  'planAndExecute',
  // 2026-05-15 production supplement: mycox-heartbeat called env to find invite_code → hit auth flow →
  // autonomous turn had no one to approve → auth_pending dead-loop consumed 27s + 7 same-root-cause failures.
  // env has no legitimate use in autonomous (credentials go through listCredentialNames + secret placeholders);
  // direct rejection is far safer than triggering auth.
  'env',
]);

// 2026-05-12 Phase 8 M2: autonomous_blacklist changed from hardcoded to hardcoded + DB overlay.
// hardcoded is the baseline (always blocks); DB rules are added via configRules.getProductionRules,
// allowing MetaConfigObserver (Phase 8 M3) to automatically add rules based on audit patterns.
// PHILONT_SELF_CONFIG=0 reverts to pure hardcoded.
let AUTONOMOUS_TURN_BLACKLIST: Set<string> = new Set(AUTONOMOUS_TURN_BLACKLIST_HARDCODED);

function reloadAutonomousBlacklist(): void {
  if (process.env.PHILONT_SELF_CONFIG === '0') {
    AUTONOMOUS_TURN_BLACKLIST = new Set(AUTONOMOUS_TURN_BLACKLIST_HARDCODED);
    return;
  }
  const merged = new Set(AUTONOMOUS_TURN_BLACKLIST_HARDCODED);
  try {
    for (const rule of memory.configRules.getProductionRules('autonomous_blacklist')) {
      if (typeof rule.value === 'string' && rule.value.length > 0) {
        merged.add(rule.value);
      }
    }
  } catch (e) {
    console.warn('[config] reloadAutonomousBlacklist failed, fallback to hardcoded:', e);
  }
  AUTONOMOUS_TURN_BLACKLIST = merged;
}

// 2026-05-12 Phase 8 M2: task_mode_classifier.skip_patterns — list of sessionId prefixes;
// if matched, autoClassify is skipped.
//
// History: hardcoded included 'system:scheduled:' / 'system:cron:', with the original intent "schedule turns are
// already structured; no need to classify again." **Overturned by production** (2026-05-15 mycox-heartbeat):
// schedule turn's user message is an instruction template written by the LLM itself (containing guide / keywords);
// without upgrading to slow it hits a wall directly (http × 3 → 404 → in-turn-reflection only upgrades to slow after 3 failures, wasted).
// → Remove 'system:scheduled:' (let the classifier read the user message; high probability of hitting guide-hint
// + heavy-keyword and naturally upgrading to slow). Keep empty array as future hook (env=DB can add custom skips).
//
// Default empty — loaded from DB at startup; when PHILONT_SELF_CONFIG=0, not loaded, keeps hardcoded fallback.
const CLASSIFIER_SKIP_PATTERNS_HARDCODED: readonly string[] = [];
let classifierSkipPatterns: readonly string[] = CLASSIFIER_SKIP_PATTERNS_HARDCODED;

function reloadClassifierSkipPatterns(): void {
  if (process.env.PHILONT_SELF_CONFIG === '0') {
    classifierSkipPatterns = CLASSIFIER_SKIP_PATTERNS_HARDCODED;
    return;
  }
  const merged: string[] = [...CLASSIFIER_SKIP_PATTERNS_HARDCODED];
  try {
    for (const rule of memory.configRules.getProductionRules('task_mode_classifier.skip_patterns')) {
      if (typeof rule.value === 'string' && rule.value.length > 0) {
        if (!merged.includes(rule.value)) merged.push(rule.value);
      }
    }
  } catch (e) {
    console.warn('[config] reloadClassifierSkipPatterns failed, fallback to hardcoded:', e);
  }
  classifierSkipPatterns = merged;
}

// Load at startup + automatically refresh on changed events
reloadAutonomousBlacklist();
reloadClassifierSkipPatterns();
memory.configRules.on('changed', (e: { type: string }) => {
  // Any change triggers a synchronous refresh (coarse-grained, simple and stable)
  reloadAutonomousBlacklist();
  reloadClassifierSkipPatterns();
});

// LLMAdapter does not directly support an independent system field; systemPrompt is prepended to the messages[0] user-segment prefix.
const miniLoopLLM: MiniLoopLLMClient = {
  async send(systemPrompt: string, messages: MiniLoopMessage[], toolDefsForSub, opts?: { signal?: AbortSignal; reasoning?: ReasoningConfig }) {
    const adjusted: NativeMessage[] = messages.length > 0
      ? messages.map((m, i) => {
          if (i === 0 && m.role === 'user' && typeof m.content === 'string') {
            return {
              role: 'user',
              content: `# Sub-task System Instructions\n${systemPrompt}\n\n# Sub-task Task\n${m.content}`,
            };
          }
          return m as NativeMessage;
        })
      : [{ role: 'user', content: systemPrompt }];

    // Forward the sub-loop abort signal so the deep_explore round deadline cancels the
    // in-flight HTTP call (LLMAdapter.send honours opts.signal), instead of the call running
    // to its own timeout and overrunning the parent turn's 20-min hard deadline.
    // 2026-06-07: also forward per-scenario reasoning so deep_explore rounds / skeptics can
    // request explicit max/high thinking effort (runMiniAgentLoop threads opts.reasoning here).
    const resp = await llm.send(adjusted, toolDefsForSub, { signal: opts?.signal, reasoning: opts?.reasoning });
    // LLMResponse and MiniLoopLLMResponse are structurally isomorphic
    return resp as unknown as MiniLoopLLMResponse;
  },
};

const subTurnToolRunner = async (
  name: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; output: string; error?: string }> => {
  try {
    const r = await tools.execute(name, input);
    return {
      ok: !!r.success,
      output: r.output ?? '',
      error: r.error,
    };
  } catch (e) {
    return { ok: false, output: '', error: String(e) };
  }
};

const planAndExecuteTool = createPlanAndExecuteTool({
  llm: miniLoopLLM,
  toolRunner: subTurnToolRunner,
  toolDefs: tools.list()
    .filter((t) => !PLAN_EXEC_BLACKLIST.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: JSON.stringify(t.schema),
    })),
  budgetTracker: new PlanBudgetTracker(),
  defaultMaxIters: 8,
  defaultMaxSubTasks: 6,
  toolBlacklist: PLAN_EXEC_BLACKLIST,
  logger: {
    log: (m) => console.log(`[plan-execute] ${m}`),
    warn: (m) => console.warn(`[plan-execute] ${m}`),
  },
  onProgress: (text) => console.log(`[plan-execute] ${text}`),
});

// domain='self' → registerInternal path (plugin/external are not allowed to declare self)
tools.registerInternal(planAndExecuteTool);

// ── Deep reasoning subsystem (isolated; env flag on by default; only disabled with PHILONT_DEEP_EXPLORE='0') ──────────
// deep_explore tool is registered by default; skipped only when PHILONT_DEEP_EXPLORE='0' is explicitly set. Reuses miniLoopLLM +
// subTurnToolRunner; tool subset = autonomous read-only whitelist + verification teeth (z3Verify/pariGp) ∩ registered tools.
// z3Verify/pariGp are **not** in DEFAULT_TOOL_WHITELIST (so background autonomous cannot access them); they are explicitly included here for deep_explore.
// Background auto-advance (Part 2) reaches the round runner through this handle; set when deep_explore
// is enabled, read by the (default-off) auto-advance loop started further down.
let deepExploreAdvanceSession: ((session: ReasoningSession) => Promise<ToolResult>) | null = null;
if (process.env.PHILONT_DEEP_EXPLORE !== '0') {
  const deepExploreVerifyTools = new Set(['z3Verify', 'pariGp', 'magnitude', 'lemmaLookup']);
  const readOnlyToolDefs: ToolDefinition[] = tools.list()
    .filter((t) => DEFAULT_TOOL_WHITELIST.has(t.name) || deepExploreVerifyTools.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.schema) }));
  const { tool: deepExploreTool, advanceSession: deepExploreAdvance } = createDeepExploreTool({
    reasoning: memory.reasoning,
    miniLoopLLM,
    subTurnToolRunner,
    readOnlyToolDefs,
    // 2026-06-07: close the failure-learning loop for compute tools — log pariGp/z3 failures to
    // the action ledger (reflector distils durable lessons) and surface learned lessons back into
    // the round prompt (collectComputeLessons).
    actions: memory.actions,
    skills: memory.skills,
    onStatus: (text) => console.log(`[deep-explore] ${text}`),
    // Surface each round's progress summary to the user. Without this the 12-min rounds are
    // silent — the user only saw the next auth prompt. web-ui gets a persistent chat bubble (its
    // onStatus is an ephemeral status line, cleared at turn end); other channels (WeChat) use
    // onStatus, which they deliver as a real message. currentSessionId/onStatus come from the ALS.
    onMilestone: (text) => {
      const sid = currentSessionId();
      const webuiSend = sid ? webuiClients.get(sid) : undefined;
      if (webuiSend) {
        webuiSend({ type: 'milestone', text });
      } else {
        const s = currentTurnStatus();
        if (s) s(text);
      }
    },
  });
  tools.registerInternal(deepExploreTool);
  deepExploreAdvanceSession = deepExploreAdvance;
  console.log('[deep-explore] enabled (on by default; set PHILONT_DEEP_EXPLORE=0 to disable)');
}

const toolDefs: ToolDefinition[] = tools.list().map(t => ({
  name: t.name,
  description: t.description,
  parameters: JSON.stringify(t.schema),
}));

// ── MCP external tool mounting (async, non-blocking) ──────────────────────────────────────────
// agent-mcp bridge mounts the tools of external MCP servers (e.g. Playwright browser) as philont tools.
// The connection is async while tools / toolDefs are built synchronously at module load — so this is fire-and-
// forget: after connecting, register into the same registry + push into the same toolDefs array reference
// (const binding but mutable content; per-turn sendLlmWithRescue holds the same reference), naturally
// visible to turns seconds later. Failure does not block or crash (connectMcpServers uses allSettled internally).
//
// Security: MCP tools use the normal register() (external untrusted source, self domain prohibited); browser-type configs
// set capability='execute' → under the read-only matrix, the first call triggers onAuthRequest rather than auto-allowing.
// autonomous loop uses an independent whitelist (DEFAULT_TOOL_WHITELIST, which does not include MCP tool names); background
// does not browse live websites.
let mcpBridges: McpBridge[] = [];
const mcpServerConfigs = loadMcpConfig();
if (mcpServerConfigs.length > 0) {
  connectMcpServers(mcpServerConfigs)
    .then((bridges) => {
      mcpBridges = bridges;
      let mounted = 0;
      // Name-based dedup: after sanitizing tool names, collisions may occur (with each other or with built-in tools);
      // if duplicate tool names enter toolDefs simultaneously, the LLM receives a duplicate tool name and returns 400.
      // Existing tool names take precedence; duplicates are skipped.
      const existingNames = new Set(toolDefs.map((d) => d.name));
      for (const bridge of bridges) {
        for (const tool of bridge.getTools()) {
          if (existingNames.has(tool.name)) {
            console.warn(`[mcp] skipped duplicate tool name ${tool.name} (conflicts with existing tool)`);
            continue;
          }
          try {
            tools.register(tool);
            toolDefs.push({
              name: tool.name,
              description: tool.description,
              parameters: JSON.stringify(tool.schema),
            });
            existingNames.add(tool.name);
            mounted++;
          } catch (e) {
            console.warn(`[mcp] register tool ${tool.name} failed: ${(e as Error)?.message ?? e}`);
          }
        }
      }
      if (mounted > 0) {
        console.log(`[mcp] mounted ${mounted} external tool(s) from ${bridges.length} server(s)`);
      }
    })
    .catch((e) => console.warn(`[mcp] connection failed: ${(e as Error)?.message ?? e}`));
}

/** Close all MCP connections (subprocesses / SSE) during graceful shutdown. Called by index.ts. */
export function closeMcpBridgesOnShutdown(): Promise<void> {
  return closeMcpBridges(mcpBridges);
}

const permissions = createReadOnlyMatrix();

// 2026-06-09: wire the validator chain into the server for the first time. Previously
// `createToolChecker` was called WITHOUT a validatorChain, so pathAcl / dangerousCommands / etc.
// existed but ran only in demos — never in production. This is the conservative "safe-deny" config
// agreed with the maintainer (see SECURITY-DESIGN.md §5):
//   - dangerousCommands: ONLY the hard-deny catastrophic patterns (rm -rf /, mkfs, dd on /dev,
//     fork bomb, base64|sh, eval $(curl), writes to /etc · /boot · ~/.ssh, secret-file exfil).
//     The grant-action patterns (git --force, sudo, …) are filtered OUT so nothing here ever needs an
//     approval flow — this checker has no onApprovalNeeded, so a require-grant would just dead-end.
//   - pathAcl: sensitive-path denylist (~/.ssh, .env, /etc/shadow, .aws/credentials, …). Closes the
//     real gap that `readFile ~/.ssh/id_rsa` succeeded today. workspaceOnly stays OFF (would over-block).
//     KNOWN TRADEOFF: this also blocks legitimate `.env` reads via the file tools.
// NOT wired yet (breakage risk — localhost/MCP, webhooks): SSRF, urlAllowlist, egress allowlist,
// workspaceOnly. See SECURITY-DESIGN.md for the staged plan.
const conservativeValidatorChain = createDefaultChain({
  pathAcl: createPathAclValidator({}),
  dangerousCommands: createDangerousCommandValidator({
    patterns: DEFAULT_DANGEROUS_PATTERNS.filter((p) => p.defaultAction === 'deny'),
  }),
});

// ── K8 proactivity layer: autonomous loop ────────────────────────────────────────────
// Runs independent ticks during idle time (default 5 min); GapDriver / CuriosityDriver scan memory
// state to find "knowledge gaps / tokens that repeatedly appear but have never been researched / long-stale high-stake pursuits",
// use read-only tools constrained by a whitelist + a single LLM call to actually investigate, produce facts/notes into the DB,
// and fire interrupts so the next turn sees "what I just did on my own" in the system prefix.
//
// Old TsCuriosityDrive (turn-time nudge to LLM) was removed on 2026-05-06. This layer is its
// complete rewrite: upgraded from "reactive reminder" to "proactive investigation".
//
// Key constraints:
//   - Strict tool whitelist (webSearch/webFetch/searchNotes/searchSkills/searchKB/
//     getFact/listFacts/readFile); write tools are unconditionally rejected
//   - Three-level budget hard thresholds (daily/per-tick/per-initiative) + PHILONT_AUTONOMOUS=0 kill switch
//   - 24h dedup per targetRef to prevent repeatedly running the same target
//   - LLM output is forced into structured JSON; facts with empty sourceRefs are silently discarded (prevents hallucination)
const autonomousToolRunner: ToolRunner = {
  async run(toolName: string, params: unknown): Promise<ToolRunResult> {
    try {
      const result = await tools.execute(
        toolName,
        params as Record<string, unknown>,
      );
      return {
        ok: !!result.success,
        output: result.output ?? '',
        error: result.error,
      };
    } catch (e) {
      return { ok: false, output: '', error: String(e) };
    }
  },
};

/**
 * Maximum number of tool-call rounds per turn (each round = one LLM call + running several tools).
 * Old default of 10 was too tight; production PPT generation / long workflows often take 12-15 steps and get truncated.
 *
 * env override: PHILONT_TOOL_LOOP_MAX (range 5-100), default 20.
 */
const MAX_TOOL_LOOP_ITERATIONS: number = (() => {
  const raw = process.env.PHILONT_TOOL_LOOP_MAX;
  if (!raw) return 20;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 5 || n > 100) {
    console.warn(
      `[config] PHILONT_TOOL_LOOP_MAX="${raw}" out of range (allowed 5-100), using default 20`,
    );
    return 20;
  }
  return n;
})();

// Phase 10 (2026-05-14): separate tool loop cap configuration for slow mode.
//
// Background: mycox production found complex tasks (reading multiple sub-documents referenced in guide + plan-aux repeated
// revise + register + post + heartbeat + failure recovery) insufficient at 20 iterations. Meanwhile giving 40 to simple fast
// tasks wastes resources. Natural tiering by auto-task-mode:
//   fast → MAX_TOOL_LOOP_ITERATIONS (default 20, env PHILONT_TOOL_LOOP_MAX override)
//   slow → MAX_TOOL_LOOP_ITERATIONS_SLOW (default 40, env PHILONT_TOOL_LOOP_MAX_SLOW override)
//
// Default slow=40 = 2x fast, leaving room for plan-aux repeated revise (6-10 iter) + sub-document reading
// (3-5) + actual execution (8-15) + failure recovery (2-5).
const MAX_TOOL_LOOP_ITERATIONS_SLOW: number = (() => {
  const raw = process.env.PHILONT_TOOL_LOOP_MAX_SLOW;
  if (!raw) return Math.min(MAX_TOOL_LOOP_ITERATIONS * 2, 60);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 10 || n > 100) {
    console.warn(
      `[config] PHILONT_TOOL_LOOP_MAX_SLOW="${raw}" out of range (allowed 10-100), using default ${Math.min(MAX_TOOL_LOOP_ITERATIONS * 2, 60)}`,
    );
    return Math.min(MAX_TOOL_LOOP_ITERATIONS * 2, 60);
  }
  return n;
})();
console.log(
  `[config] MAX_TOOL_LOOP_ITERATIONS=${MAX_TOOL_LOOP_ITERATIONS}(fast)/ ${MAX_TOOL_LOOP_ITERATIONS_SLOW}(slow)`,
);

/**
 * Phase 10: get the effective tool loop cap by task mode.
 * slow mode → MAX_TOOL_LOOP_ITERATIONS_SLOW (default 40); others → MAX_TOOL_LOOP_ITERATIONS (default 20).
 * Caller snapshots this once at runToolLoop entry into a local var to avoid cap jumping if mode changes mid-turn.
 */
function effectiveMaxIter(sessionId: string): number {
  return taskModeStore.get(sessionId) === 'slow'
    ? MAX_TOOL_LOOP_ITERATIONS_SLOW
    : MAX_TOOL_LOOP_ITERATIONS;
}

// Autonomous driver registry — single source of truth; dashboard / tests / loop all reference it.
// PursuitDriver injects an isGranted callback: used to query GrantStore when replaying proactive research "request permission".
const AUTONOMOUS_DRIVERS = [
  new GapDriver(),
  new CuriosityDriver(),
  new PursuitDriver(DEFAULT_PURSUIT_CONFIG, (tool) => globalGrants.isGranted(tool)),
] as const;
export const autonomousDriverNames: readonly string[] = AUTONOMOUS_DRIVERS.map((d) => d.name);

// 2026-05-06 Phase C: proactive push dispatcher. env PHILONT_PUSH_ENABLED controls the global switch.
// Default OFF — even when enabled, per-(channel, peer) opt-in is required for actual pushes.
const pushDispatcher = new PushDispatcher({
  subscriptions: memory.pushSubscriptions,
  logger: {
    log: (m) => console.log(`[push] ${m}`),
    warn: (m) => console.warn(`[push] ${m}`),
    error: (m, e) => console.error(`[push] ${m}`, e),
  },
});

// ── Proactive research "request permission" integration with WeChat ─────────────────────────────────────────────────
//
// When background research needs a gated tool (running Lean/Z3, etc.) → executor returns needsGrant → here:
//   (1) Register the request as a pendingResearchGrant (keyed by the subscribed WeChat user's stable sessionId,
//       structurally identical to turn-level pendingAuth, but **without** the tool-chain resume burden — continuation
//       is handled automatically by the next autonomous tick's driver replay);
//   (2) pushDispatcher proactively pushes an authorization card (reusing subscription/rate-limiting/quiet/dedup).
//       If no subscription exists, the push cannot be sent → automatically falls back to "in-conversation authorization"
//       (prompt pending section + grant_research_tool fallback).
// User replies "approve/reject" on WeChat → handleChatSendInner entry deterministic routing (see below).
// Pure logic (rendering / sessionId reconstruction / verdict) extracted to research_grant.ts for independent testing.
const pendingResearchGrants = new Map<string, PendingResearchGrant>();
/** Do not consume if pending is too old (a user replying "approve" after a long time is likely out of context). Reuses the research authorization TTL. */
const RESEARCH_GRANT_PENDING_TTL_MS = DEFAULT_RESEARCH_GRANT_TTL_MS;

// ── Web-ui proactive push bridge ─────────────────────────────────────────────────────────────
//
// pushDispatcher fans out only to registered PushChannels (WeChat / Telegram). The web-ui has no
// persistent channel or push subscription — its session ids are ephemeral, one per WS connection —
// so proactive, turn-external messages (background research grant requests, autonomous findings)
// never reached it. We keep a live registry of connected web-ui sessions: index.ts registers each
// WS connection, and the proactive emitters below fan out to them too. For grant requests we also
// register the pending under the web-ui session, so a typed "approve" matches at the
// handleChatSendInner entry exactly like a WeChat/Telegram reply.
export interface WebuiProactiveMessage {
  type: 'research_grant_request' | 'finding' | 'milestone';
  /** Pre-rendered text (findings / milestones) — shown verbatim. */
  text?: string;
  /** Structured fields (grant request) — the front-end renders these bilingually. */
  payload?: Record<string, unknown>;
}
const webuiClients = new Map<string, (msg: WebuiProactiveMessage) => void>();

/** Register a connected web-ui session to receive proactive pushes. Returns an unregister fn. */
export function registerWebuiClient(
  sessionId: string,
  send: (msg: WebuiProactiveMessage) => void,
): () => void {
  webuiClients.set(sessionId, send);
  return () => { webuiClients.delete(sessionId); };
}

/**
 * needsGrant outcome → register pending + proactively push. Failure only logged; main flow unaffected.
 * Reconstruct stable sessionId (`wechat:<accountId>:<userId>`) for subscribed WeChat DM user when registering pending,
 * so that when the user replies on WeChat the pending can be matched by sessionId (same keying as pendingAuth).
 */
function enqueueResearchGrantPush(
  targetRef: string,
  requested: { tool: string; why: string },
): void {
  const parsed = parsePursuitTargetRef(targetRef);
  if (!parsed || parsed.kind !== 'question' || !parsed.questionId) return;
  const pursuit = memory.pursuits.get(parsed.pursuitId);
  const title = pursuit?.title ?? 'research';
  const { tool, why } = requested;

  // Register pending for subscribed WeChat DM users (reconstruct stable sessionId). Group subscriptions / non-WeChat channels are skipped.
  for (const sub of memory.pushSubscriptions.listActive()) {
    const sid = reconstructDmSessionId(sub.channel, sub.peer);
    if (!sid) continue;
    pendingResearchGrants.set(sid, {
      pursuitId: parsed.pursuitId,
      questionId: parsed.questionId,
      tool,
      why,
      ts: Date.now(),
    });
  }

  // Web-ui: register pending under each connected web-ui session + show the request card.
  // (Mirrors the WeChat/Telegram path; the front-end renders the structured payload bilingually.)
  for (const [sid, send] of webuiClients) {
    pendingResearchGrants.set(sid, {
      pursuitId: parsed.pursuitId,
      questionId: parsed.questionId,
      tool,
      why,
      ts: Date.now(),
    });
    send({
      type: 'research_grant_request',
      payload: { title, tool, why, ttlMinutes: Math.round(RESEARCH_GRANT_PENDING_TTL_MS / 60000) },
    });
  }

  void pushDispatcher
    .enqueue({
      severity: 'urgent',
      kind: 'research_grant_request',
      targetRef: `research-grant:${parsed.pursuitId}:${tool}`,
      text: renderResearchGrantPrompt(title, tool, why, RESEARCH_GRANT_PENDING_TTL_MS),
    })
    .catch((e) => console.warn('[research-grant] push enqueue failed', e));
}

/** PursuitProgressWriter instance (reused by the onOutcome composite hook). */
const pursuitWriter = pursuitProgressWriter(memory.pursuits);

const autonomousInterruptSink: InterruptSink = {
  fire(severity, payload) {
    const summary =
      payload.summary.length > 200
        ? payload.summary.slice(0, 200) + '…'
        : payload.summary;
    const text = `[autonomous:${payload.kind}] ${summary} (initiative=${payload.initiativeId})`;
    if (severity === 'high') {
      interruptController.sendHigh({ signalType: 'AutonomousFinding', payload: text });
      // Web-ui: surface the finding to any connected web-ui session (no subscription/rate-limit;
      // the user is actively looking at the chat). WeChat/Telegram still go through pushDispatcher below.
      for (const [, send] of webuiClients) {
        send({ type: 'finding', text: `🔔 ${summary}` });
      }
      // Proactive push (urgent): actually sends only when there is an opt-in subscription and rate limit not exceeded.
      // dispatcher internally checks global kill / frequency / quiet / dedup; failure is only audited and does not affect main flow.
      void pushDispatcher
        .enqueue({
          severity: 'urgent',
          kind: payload.kind,
          targetRef: payload.initiativeId,
          text: `🔔 ${summary}`,
        })
        .then((r) => {
          if (r.delivered > 0) {
            internalAudit.append('self_domain_write', {
              source: 'push_dispatcher',
              origin: 'Internal',
              toolName: 'push_delivered',
              severity: 'urgent',
              kind: payload.kind,
              initiativeId: payload.initiativeId,
              delivered: r.delivered,
              skipped: r.skipped.length,
              failed: r.failed,
            });
          }
        })
        .catch((e) => console.warn('[push] urgent dispatch threw', e));
    } else {
      interruptController.sendNormal({ signalType: 'AutonomousObservation', payload: text });
    }
  },
};

const autonomousExecutor = new StandardExecutor({
  facts: memory.facts,
  notes: memory.notes,
  llm: extractorLlm,
  tools: autonomousToolRunner,
  // Proactive research "request permission": let executor include user-authorized gated tools in the effective whitelist.
  isToolGranted: (tool) => globalGrants.isGranted(tool),
});

// 2026-05-06: autonomous budget caps support env override; see autonomous_budget_env.ts
const _autonomousBudgetCaps = resolveAutonomousBudgetCaps();
console.log(`[autonomous] ${describeBudgetCapsOverrides(_autonomousBudgetCaps)}`);

export const autonomousLoop: AutonomousLoopHandle = startAutonomousLoop({
  db: memory.db,
  facts: memory.facts,
  notes: memory.notes,
  raw: memory.raw,
  skills: memory.skills,
  routingRules: memory.routingRules,
  pursuits: memory.pursuits,
  drivers: AUTONOMOUS_DRIVERS,
  executor: autonomousExecutor,
  interrupt: autonomousInterruptSink,
  budgetCaps: _autonomousBudgetCaps,
  // 2026-05-06 PursuitProgressWriter:pursuit:* initiative done → addEvidence +
  // bumpProgress (automatically updates last_touched_ts), so the next PursuitDriver tick does not immediately hit
  // the same pursuit. Failure only logged; main flow unaffected.
  // Composite hook: after writer (writes pursuit / question.pendingTool), if it is a proactive research "request
  // permission" (needsGrant) → proactively push WeChat authorization card + register pending (in-conversation authorization still serves as fallback).
  onOutcome: (init, result) => {
    pursuitWriter(init, result);
    if (result.needsGrant && result.requestedTool) {
      try {
        enqueueResearchGrantPush(init.targetRef, result.requestedTool);
      } catch (e) {
        console.warn('[research-grant] enqueue failed', e);
      }
    }
  },
  audit: {
    onTick(e) {
      if (e.proposalsCollected === 0 && e.initiativesRun === 0) return;
      internalAudit.append('self_domain_write', {
        source: 'autonomous_loop',
        origin: 'Internal',
        toolName: 'autonomous_tick',
        proposalsCollected: e.proposalsCollected,
        initiativesRun: e.initiativesRun,
        skipped: e.skipped,
        failed: e.failed,
        llmTokensSpent: e.llmTokensSpent,
        toolCallsSpent: e.toolCallsSpent,
        budgetExhausted: e.budgetExhausted,
        durationMs: e.durationMs,
      });
      if (e.initiativesRun > 0) {
        console.log(
          `[autonomous] tick: ran=${e.initiativesRun} skipped=${e.skipped} failed=${e.failed} tokens=${e.llmTokensSpent} ${e.durationMs}ms`,
        );
      }
    },
  },
});
autonomousLoop.start();

// Background auto-advance for opted-in reasoning sessions (Part 2). Default-off:
// PHILONT_DEEP_EXPLORE_AUTO_ADVANCE gates the whole loop, and each session is opt-in via
// deep_explore action=auto_on. When off, the loop never arms → zero behaviour change.
export const deepExploreAutoAdvance = createAutoAdvanceLoop({
  reasoning: memory.reasoning,
  advanceSession: (s) =>
    deepExploreAdvanceSession
      ? deepExploreAdvanceSession(s)
      : Promise.resolve({ success: false, output: '', error: 'deep_explore disabled' }),
  runInContext: runInTurnContext,
  notify: (text, opts) => {
    for (const [, send] of webuiClients) send({ type: 'milestone', text });
    if (opts?.important) {
      void pushDispatcher
        .enqueue({
          severity: 'urgent',
          kind: 'deep_explore:auto_advance',
          targetRef: `deep_explore:auto:${Date.now()}`,
          text,
        })
        .catch(() => {});
    }
  },
});
deepExploreAutoAdvance.start();

const intentClassifier = process.env.LLM_PROVIDER === 'anthropic'
  ? new LLMIntentClassifier(async (prompt) => {
      const resp = await llm.send([{ role: 'user', content: prompt }]);
      return resp.type === 'text' ? resp.content : 'unclear';
    })
  : new KeywordIntentClassifier();

// ── Session state ──────────────────────────────────────────────────────────────────
//
// K0: LLM working context is no longer held across ws turns; instead, each turn recalls from the raw global timeline.
// `sessions: Map<sid, NativeMessage[]>` removed — it was a byproduct of the ws connection lifecycle,
// causing the agent to "short-term amnesiac" immediately after network jitter / sleep / tab switch.
// See plan: K0 working memory architecture de-sessionization.
//
// K0.4: authorization uses time-based TTL rather than binding to ws connection — users who reconnect within the
// 10-minute window do not need to re-authorize. `pendingAuth` is still keyed by ws sid: the same agent runs
// the auth flow with only one user at a time; sid is an appropriate reverse-lookup key.
// (globalGrants has been moved up to be defined before researchToolAdapters.)

/** TimelineRetriever singleton: pulls context fragments from the raw global timeline before each LLM call */
const timelineRetriever = new TimelineRetriever(memory.raw);

/**
 * Timeline recall budget is adjustable via environment variables.
 * K8 tuning (2026-04-27): out-of-box defaults 8K + 4K ≈ 12K tokens (with the 30-entry hard cap in timeline.ts),
 * so that the most recent ~10-15 turns clearly dominate LLM attention. The old 80K + 40K empirically caused
 * the 3 most recent key messages to be drowned out by hundreds of irrelevant old history entries.
 */
const TIMELINE_RECENT_BUDGET = Number(process.env.TIMELINE_RECENT_BUDGET) || 8_000;
const TIMELINE_RECALL_BUDGET = Number(process.env.TIMELINE_RECALL_BUDGET) || 4_000;

/** Paused state: waiting for the user to authorize a tool call */
interface PendingAuth {
  capability: string;
  domain:     string;
  toolName:   string;
  toolCallId: string;
  /** Original input of the suspended tool; used to reconstruct the call and retry execution after authorization */
  input: Record<string, unknown>;
  /** Remaining calls to continue executing after authorization is granted */
  remainingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** toolResults already collected (processed before authorization) */
  collectedResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
  /** Current iteration round */
  iteration: number;
  /**
   * K0: snapshot of the complete messages array at suspend time (including systemPrompt + history + user message +
   * assistant tool_use blocks). Reused directly on authorization resume, not rebuilt — otherwise tool_use
   * and tool_result pairing can become misaligned due to timeline recall fluctuations → LLM 400.
   */
  inflightMessages: NativeMessage[];
  /** Suspend timestamp; used to expire a stale pending so a later natural-language message is not trapped in the auth flow. */
  ts: number;
}

const pendingAuth = new Map<string, PendingAuth>();

/**
 * pendingAuth TTL — matches the "(valid for 10 min)" shown on the auth card. After this, a pending
 * tool is abandoned and the user's next message is handled as a normal turn (no auth re-prompt),
 * so questions like "is the session still active?" are answered instead of being bounced as
 * "please reply allow/deny". Keyed by ws sid like the rest of the auth state.
 */
const PENDING_AUTH_TTL_MS = 10 * 60_000;

/** deep_explore grant window — longer than the 12-min round deadline so one approval covers a multi-round session (see the pendingAuth grant path). */
const DEEP_EXPLORE_GRANT_TTL_MS = 60 * 60_000;

/**
 * Paused state: triggered by the askUserQuestion tool; waits for the user to choose an option or provide a free-text answer in the next message.
 *
 * Sibling pattern to pendingAuth: both save inflightMessages + remainingCalls +
 * collectedResults so the next turn can directly resume into runToolLoop.
 *
 * At most one per session at a time; not mutually exclusive here (in theory askUserQuestion's
 * read/local path will not trigger pendingAuth), but outer handleChatSend checks pendingAuth first.
 */
interface PendingQuestion {
  toolCallId: string;
  question: string;
  options: ReadonlyArray<{ label: string; description?: string }>;
  allowFreeText: boolean;
  remainingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  collectedResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
  iteration: number;
  inflightMessages: NativeMessage[];
  /** Creation timestamp, used for expiry detection */
  createdAt: number;
}

const pendingQuestion = new Map<string, PendingQuestion>();
/** Maximum wait time for the user to reply to askUserQuestion; expired requests are treated as "abandoned" */
const QUESTION_TTL_MS = 10 * 60_000;

// Track active sessions for extraction at session end
const activeSessions = new Set<string>();

// ── Skill hot-reload ──────────────────────────────────────────────────────────
// skillsRevision increments on every skill set change (create/update/delete).
// Each session tracks its own "last seen" revision; if they differ when processing a new message → inject an update notification.
let skillsRevision = 0;
const sessionSkillsRevision = new Map<string, number>();

memory.skills.on('changed', () => {
  skillsRevision++;
});

// Filesystem watcher: when the user creates/edits a SKILL.md under .philont/skills/ → re-import
const workspaceSkillsDir = join(process.cwd(), '.philont', 'skills');
const globalSkillsDir = join(homedir(), '.philont', 'skills');
// Built-in skills: published under agent-tools/bundled-skills/ as philont's out-of-the-box knowledge base.
// Priority < workspace < global; any user-level directory's same-name skill can override it.
// Path is relative to server/src/chat-handler.ts → ../../agent-tools/bundled-skills
const bundledSkillsDir = join(MODULE_DIR, '..', '..', 'agent-tools', 'bundled-skills');

async function reloadSkillsFromDisk(): Promise<void> {
  try {
    const parsed = await loadSkills(process.cwd(), [bundledSkillsDir]);
    // Note: even if parsed.length === 0, run the prune below — when all external skill files are deleted at once,
    // the DB must still be cleaned up.
    let imported = { created: [] as string[], updated: [] as string[] };
    if (parsed.length > 0) {
      // 2026-05-09 v15: pass routingRules → when bundled / locally handwritten skills are loaded,
      // automatically write a 'auto:bundled:<name>' routing rule with confidence='tentative'
      // (based on the SKILL.md frontmatter `when_to_use:` text). Reflection-generated skills
      // do not go through this path (routing_bundled skips 'self:*' sources).
      imported = importSkills(memory.skills, parsed, {
        onConflict: 'replace',
        routingRules: memory.routingRules,
      });
    }

    // Prune: compare disk with the "external skills" in SkillStore (source IS NOT NULL);
    // the diff is orphan rows — directories deleted by uninstallSkill / manual user rm / clawhub uninstall
    // but DB rows still remain. Delete each skill individually to refresh the index.
    //
    // Safety guarantee: locally handwritten / reflection-generated (source IS NULL) skills never appear in
    // listExternalSkills() results and will never be accidentally deleted.
    const parsedNames = new Set(parsed.map((p) => p.name));
    const orphans = memory.skills.listExternalSkills().filter((s) => !parsedNames.has(s.name));
    for (const orphan of orphans) {
      memory.skills.deleteSkill(orphan.name);
    }

    if (imported.created.length + imported.updated.length + orphans.length > 0) {
      console.log(
        `[skills-hotreload] ${imported.created.length} created, ${imported.updated.length} updated, ` +
        `${orphans.length} prune (${orphans.map((s) => s.name).join(',')})`
      );
    }
  } catch (e) {
    console.warn('[skills-hotreload] load failed:', e);
  }
}

// Explicitly run once at startup — bundled skills are in SkillStore at least after the first startup.
// This is a fire-and-forget promise (does not block module loading; ready for use by subsequent turns).
reloadSkillsFromDisk().then(() => {
  const all = memory.skills.listAll(200);
  console.log(`[skills] startup loaded total ${all.length} skills (incl. bundled)`);
}).catch((e) => {
  console.warn('[skills] startup load failed:', e);
});

// fs.watch throws on non-existent directories → degrades to no-op; files created under that path later will not trigger.
// ensureDir at startup serves as fallback: keeps the watcher truly alive rather than "apparently mounted but actually dead".
for (const dir of [workspaceSkillsDir, globalSkillsDir]) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn(`[skills] ensureDir failed ${dir}:`, e);
  }
}

// Start watchers for two directories; if a directory does not exist, no-op (in theory should not happen after ensureDir)
const workspaceWatcher = watchSkillDir(workspaceSkillsDir, reloadSkillsFromDisk);
const globalWatcher = watchSkillDir(globalSkillsDir, reloadSkillsFromDisk);

/** Release watchers on process exit (for testing or lifecycle management) */
export function closeSkillWatchers(): void {
  workspaceWatcher.close();
  globalWatcher.close();
}

// ── Scheduler: proactive time-driven behavior ────────────────────────────────────
/**
 * Reminder emitter that proactively pushes to the frontend. The WS layer in index.ts subscribes to this emitter;
 * the scheduler proactively pushes via WS to active sessions each time a 'prompt'-type task expires.
 */
export interface ReminderPayload {
  scheduleName: string;
  text: string;
  at: number;
}
export const reminderEmitter = new EventEmitter();

const scheduler = startScheduler(
  memory.schedules,
  async (s: Schedule) => {
    const payload = (s.payload ?? {}) as Record<string, unknown>;
    const label = `[schedule ${s.name}]`;
    switch (s.actionType) {
      case 'prompt': {
        const message = typeof payload.message === 'string'
          ? payload.message
          : `Scheduled reminder: ${s.name}`;
        console.log(`${label} prompt → "${message}"`);
        reminderEmitter.emit('reminder', {
          scheduleName: s.name,
          text: message,
          at: Date.now(),
        } satisfies ReminderPayload);
        return;
      }
      case 'reflect': {
        const targetSessionId = typeof payload.sessionId === 'string'
          ? payload.sessionId
          : null;
        if (targetSessionId) {
          try {
            const result = await reflector.reflectFromSession(targetSessionId);
            console.log(
              `${label} reflect on ${targetSessionId}: ${result.skillsCreated} created`
            );
          } catch (e) {
            console.warn(`${label} reflect failed:`, e);
          }
        } else {
          console.log(`${label} reflect: missing payload.sessionId, skipped`);
        }
        return;
      }
      case 'tool_call': {
        // Security-sensitive: MVP only records audit log; actual execution deferred to Phase 6.5 integration with PolicyGate
        console.warn(
          `${label} tool_call scheduled and due but not executed (policy layer not wired in). ` +
            `payload: ${JSON.stringify(payload).slice(0, 200)}`
        );
        return;
      }
      case 'autonomous_turn': {
        // 2026-05-07: system-driven real chat turn, not a passive reminder.
        // Runs the full chat-handler: routing inject / failure_recovery / drives /
        // tools all present, but sessionId is independent (system:scheduled:<name>) and does not mix with user sessions.
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
        if (!prompt.trim()) {
          console.warn(`${label} autonomous_turn: missing payload.prompt, skipped`);
          return;
        }
        const replyChannel = payload.replyChannel === 'summary' ? 'summary' : 'silent';
        const turnSessionId = `system:scheduled:${s.name}`;
        const startTs = Date.now();
        let finalText = '';
        try {
          await handleChatSend(
            turnSessionId,
            prompt,
            // onDelta: write to timeline; silent mode does not push to channel
            (token) => { finalText += token; },
            // onAuthRequest: autonomous turn is non-interactive; directly deny (audit recorded)
            (req) => {
              console.warn(
                `${label} autonomous turn triggered auth request (denied): tool=${req.toolName} ` +
                  `cap=${req.capability}/${req.domain}`,
              );
            },
            // onStatus: only logged to console; not pushed to channel
            (status) => { console.log(`${label} status: ${status}`); },
          );
          const dur = Date.now() - startTs;
          console.log(`${label} autonomous_turn done durationMs=${dur} replyText=${finalText.length}b`);
          internalAudit.append('schedule_autonomous_turn_done', {
            scheduleName: s.name,
            sessionId: turnSessionId,
            durationMs: dur,
            replyTextLen: finalText.length,
            replyChannel,
          });
          // v16: one success resets failure count + clears pause
          try { memory.schedules.recordSuccess(s.id); } catch (e) {
            console.warn(`${label} recordSuccess failed (ignored):`, (e as Error)?.message ?? e);
          }
          // when replyChannel='summary', push to user via reminderEmitter (reuses the prompt channel)
          if (replyChannel === 'summary' && finalText.trim()) {
            reminderEmitter.emit('reminder', {
              scheduleName: s.name,
              text: finalText.slice(0, 500),
              at: Date.now(),
            } satisfies ReminderPayload);
          }
        } catch (e) {
          const dur = Date.now() - startTs;
          console.error(`${label} autonomous_turn failed durationMs=${dur}:`, (e as Error)?.message ?? e);
          internalAudit.append('schedule_autonomous_turn_failed', {
            scheduleName: s.name,
            sessionId: turnSessionId,
            durationMs: dur,
            error: String((e as Error)?.message ?? e).slice(0, 200),
          });
          // v16: each failure increments the counter → auto-pauses for 1h when threshold is reached
          try {
            const before = s.pausedUntil ?? 0;
            const updated = memory.schedules.recordFailure(s.id, Date.now());
            const after = updated?.pausedUntil ?? 0;
            if (updated && after > before && after > Date.now()) {
              const remainMin = Math.round((after - Date.now()) / 60000);
              console.warn(
                `${label} 🛑 ${updated.consecutiveFailures} consecutive failures, auto-paused for ${remainMin} minutes (until ${new Date(after).toISOString()})`,
              );
              internalAudit.append('schedule_auto_paused', {
                scheduleName: s.name,
                scheduleId: s.id,
                consecutiveFailures: updated.consecutiveFailures,
                pausedUntil: after,
                pauseDurationMs: after - Date.now(),
              });
            }
          } catch (e2) {
            console.warn(`${label} recordFailure failed (ignored):`, (e2 as Error)?.message ?? e2);
          }
        }
        return;
      }
    }
  },
  {
    intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS) || 30_000,
  }
);

/** Stop the scheduler on process exit */
export function closeScheduler(): void {
  scheduler.stop();
}

/** Stop the idle-consolidator timer + wait for in-flight ticks to drain during graceful shutdown. Idempotent. */
export async function closeIdleConsolidator(): Promise<void> {
  await idleConsolidator.stop();
}

/** Shut down the autonomous loop. Idempotent. */
export async function closeAutonomousLoop(): Promise<void> {
  await autonomousLoop.stop();
  deepExploreAutoAdvance.stop();
}

/**
 * Shut down FetchedResourceStore — flush manifest to disk. Idempotent.
 * gracefulShutdown should be called before memory.close().
 */
export function closeFetchedStore(): void {
  fetchedStore.close();
}

// ── Drive runtime helpers ───────────────────────────────────────────────────

/**
 * Take the last N entries from messages[] (filter to text-role messages and normalize to role+content) for drive observation.
 * Filters out structured messages like tool_result; keeps only user/assistant text.
 */
function toRecentMessages(
  messages: NativeMessage[],
  limit: number,
): RecentMessage[] {
  const out: RecentMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : // content may be an array (tool_use / tool_result); only take the string path here
          null;
    if (text === null) continue;
    out.push({ role: m.role, content: text });
  }
  out.reverse();
  return out;
}

/**
 * Collect observations after a drive fires this turn:
 *   - fact / note ids created this turn (after turnStartTs) → source of positive signals
 *   - tool call summary for this turn (from memory.actions) → success ratio
 * Does not collect pursuit progress: the current per-turn path has no pursuit progress writes;
 * Reflector will scan at the session level.
 */
function collectTurnObservations(
  sessionId: string,
  turnStartTs: number,
): { toolCalls: TsToolCallSummary[]; newFactIds: string[]; newNoteIds: string[] } {
  const db = memory.db;
  const newFacts = db
    .prepare<[number]>(
      `SELECT id FROM memory_facts WHERE created_at >= ? ORDER BY created_at`,
    )
    .all(turnStartTs) as Array<{ id: string }>;
  const newNotes = db
    .prepare<[number]>(
      `SELECT id FROM memory_notes WHERE created_at >= ? ORDER BY created_at`,
    )
    .all(turnStartTs) as Array<{ id: string }>;
  // K0: actions are recorded under GLOBAL_TIMELINE_SESSION_ID; timestamp window delineates the current turn
  const actions = db
    .prepare<[string, number]>(
      `SELECT tool_name, success, result FROM memory_actions
       WHERE session_id = ? AND timestamp >= ?
       ORDER BY timestamp`,
    )
    .all(GLOBAL_TIMELINE_SESSION_ID, turnStartTs) as Array<{
    tool_name: string;
    success: number;
    result: string | null;
  }>;
  return {
    toolCalls: actions.map((a) => ({
      toolName: a.tool_name,
      success: a.success === 1,
      resultSnippet: (a.result ?? '').slice(0, 120),
    })),
    newFactIds: newFacts.map((f) => f.id),
    newNoteIds: newNotes.map((n) => n.id),
  };
}

/**
 * Construct "skill directory updated" notification text for mid-session injection.
 * Only lists name + one-line description to control token cost.
 */
function buildSkillUpdateMessage(): string {
  const topSkills = memory.skills.listAll(10);
  if (topSkills.length === 0) return '';
  const lines = topSkills.map((s) => `  - ${s.name}: ${s.description}`);
  return (
    '[Memory Update] Available skill catalog has changed, current top 10:\n' +
    lines.join('\n') +
    '\n(Use use_skill(name) to retrieve the action template)'
  );
}

/**
 * Build the memory prefix: compress known structured facts into the system prompt.
 *
 * Only reads active facts in the user.* and project.* namespaces, with a compact format
 * guaranteed to be < 500 tokens. Called once at session start; unchanged for the entire session,
 * leveraging prompt cache to avoid cost amplification.
 *
 * Appended at the end: "state from the last conversation" — reads the most recent note
 * with id like `session-summary-<other-session>` from the notes table (written by Compactor / finalizeSession),
 * allowing a new session to continue from where the previous conversation left off.
 */
/**
 * Memory prefix hard limit: prevents "memory contamination" across sessions from blowing up the LLM window right from session start.
 * This is **the most fatal bug source** caught in production: Compactor wrote an oversized summary note for a very long conversation;
 * loading that note in a new session immediately consumed 2M+ tokens.
 *
 * - Per session-summary injection cap: 3KB (a genuinely useful summary will not exceed this)
 * - Per userFacts / projectFacts value injection cap: 1KB
 * - Total prefix cap: 40KB (approx. 12K tokens, leaving the vast majority of the window for conversation)
 */
const MEMORY_PREFIX_TOTAL_CAP = 40_000;
const SESSION_SUMMARY_INJECT_CAP = 3_000;
const FACT_VALUE_INJECT_CAP = 1_000;
/**
 * Phase 13 plan.md auto-inject cap (2026-05-23): scheduled session injects the full plan.md;
 * production mycox after N runs saw Lessons + Recent Runs grow to 25KB, which together with other sections
 * pushed the prefix past the 40K cap. Truncated here — the LLM gets enough to work with from the capped version
 * (Goal/Sub-tasks/Operational Knowledge are all within the first 18K); the full text is fetched explicitly via readFile.
 * 20K chars ≈ 6K tokens.
 */
const PLAN_MD_INJECT_CAP = 20_000;

function truncateForInjection(text: string, cap: number, label: string): string {
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n...[${label} too long, truncated: original ${text.length} chars → keeping first ${cap}]`
  );
}

/**
 * Split the raw memory prefix by `## heading` into sections, returning each section's heading + char count.
 * Used only for overflow debugging at the end of buildMemoryPrefix; not in the hot path.
 *
 * headings shorter than 60 chars are truncated for display; the first section (content before the first `## `,
 * usually a wrapper marker) is labeled `<preamble>`.
 */
export function splitPrefixBySection(raw: string): Array<{ title: string; chars: number }> {
  const segments: Array<{ title: string; chars: number }> = [];
  const headingRe = /^## (.+)$/gm;
  let lastIdx = 0;
  let lastTitle = '<preamble>';
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(raw)) !== null) {
    const start = m.index;
    if (start > lastIdx) {
      segments.push({ title: lastTitle, chars: start - lastIdx });
    }
    lastTitle = m[1].trim().slice(0, 60);
    lastIdx = start;
  }
  if (lastIdx < raw.length) {
    segments.push({ title: lastTitle, chars: raw.length - lastIdx });
  }
  return segments.sort((a, b) => b.chars - a.chars);
}

/**
 * K0/K0.7: no longer depends on currentSessionId. The LLM sees a continuous timeline;
 * the concept of "last session" no longer exists — history is naturally brought back by TimelineRetriever.
 *
 * prefix now only serves as a "highly condensed long-term fact index": facts / skills / negative skills /
 * self.summary. session-summary notes are no longer specially injected — the retriever treats them as ordinary notes.
 */
function buildMemoryPrefix(signalBus?: TurnSignalBus): string {
  const lines: string[] = [];

  // Runtime environment (always-on, ≤1 line): informs the LLM of the true host OS / shell so it writes correct command dialect.
  // Production pain point: LLM defaults to bash; on Windows which/heredoc/cd /d all error.
  lines.push(hostEnvPromptLine());
  lines.push('');

  // Phase 12 cont (2026-05-17): inject "this schedule's historical trace" at the top of scheduled sessions.
  // Mechanism-layer lesson accumulation channel — auto-capture (handleChatSend turn finalization record) + auto-render (inject here),
  // does not depend on the LLM reflection distillation chain. Ordinary user sessions skip this.
  {
    const sidForSched = currentSessionId();
    if (sidForSched) {
      const scheduleId = extractScheduleIdFromSession(sidForSched);
      if (scheduleId) {
        try {
          const outcomes = memory.scheduleOutcomes.recent(scheduleId, 5);
          if (outcomes.length > 0) {
            lines.push(renderScheduleOutcomesSection(outcomes, scheduleId));
            lines.push('');
          }
        } catch (e) {
          console.warn(
            `[schedule-outcomes] inject failed (ignored):`,
            (e as Error)?.message ?? e,
          );
        }
      }
    }
  }

  // Phase 13 (2026-05-17) / Phase 13.5 (2026-05-18): active project plan.md injection.
  // - scheduled session: auto-inject full plan.md (LLM must read; accumulates Lessons/Knowledge)
  // - user-driven session: only include path link; LLM decides whether to readFile based on complexity
  //
  // Phase 13.5 bug fix: scheduled session sessionId looks like `system:scheduled:mycox-
  // checkin`, which differs from the original placeholder plan's sessionId; listBySession never finds it.
  // Fix: **scheduled sessions prefer the schedule.project path** (the schedule table
  // stores the project association); non-scheduled sessions use the old listBySession path.
  {
    const sidForPlan = currentSessionId();
    if (sidForPlan) {
      try {
        let project: string | null = null;
        let isScheduled = false;
        const schedId = extractScheduleIdFromSession(sidForPlan);
        if (schedId) {
          isScheduled = true;
          // Phase 13.5: scheduled session → find schedule by name, get schedule.project
          const sched = memory.schedules.findByName(schedId);
          if (sched?.project) project = sched.project;
        }
        if (!project) {
          // Non-scheduled, or schedule has no project binding → use old path (session's active plan)
          const activePlan = memory.plans.listBySession(sidForPlan, { limit: 1 })[0];
          if (activePlan?.persistedTo) project = activePlan.persistedTo;
        }
        if (project) {
          if (isScheduled) {
            // scheduled turn: auto-inject plan.md (LLM has no chance to skip)
            // Phase 13.6 (2026-05-23): cap PLAN_MD_INJECT_CAP to prevent 60K+ prefix.
            // Header sections (Goal/Sub-tasks/Operational Knowledge/Lessons) are within the first 18K;
            // tail sections Recent Runs / Archive Summary are truncated; LLM can readFile for the full text when needed.
            const md = memory.planFiles.getMarkdown(project);
            if (md) {
              const projectsBase = memory.planFiles.baseDir;
              const planPath = join(projectsBase, project, 'plan.md');
              const truncated = md.length > PLAN_MD_INJECT_CAP;
              const injectMd = truncated
                ? md.slice(0, PLAN_MD_INJECT_CAP) +
                  `\n\n[... plan.md remaining ${md.length - PLAN_MD_INJECT_CAP} chars truncated — readFile("${planPath}") for full content]\n`
                : md;
              lines.push(`## Project plan.md (${project}, auto-inject${truncated ? ', truncated' : ''})`);
              lines.push('');
              lines.push(injectMd);
              lines.push('');
              lines.push(
                `↑ This is the project's accumulated work notes. Lessons / Operational Knowledge persist across fires;` +
                  ` repeated failures mean you **did not read Lessons** — re-read before starting.` +
                  (truncated ? ` This section is truncated; for full Recent Runs use \`readFile("${planPath}")\`.` : ''),
              );
              lines.push('');
            }
          } else {
            // user-driven turn: link only, LLM readFile on demand
            const projectsBase = memory.planFiles.baseDir;
            const planPath = join(projectsBase, project, 'plan.md');
            lines.push(`## Active project plan`);
            lines.push(`project: \`${project}\``);
            lines.push(`plan.md: \`${planPath}\``);
            lines.push(
              `Lessons / Operational Knowledge / Recent Runs are all in the file.` +
                ` Use \`readFile\` when needed. Details are not repeated in the prefix to save tokens / preserve cache hit.`,
            );
            lines.push('');
          }
        }
      } catch (e) {
        console.warn(
          `[plan-files] inject failed (ignored):`,
          (e as Error)?.message ?? e,
        );
      }
    }
  }

  // ── Complex-task protocol entry point (v17 Phase 4, 2026-05-11) ──────────────────────────
  // Task mode self-assessment + active plan state. **This section must appear at the top of the prefix** — the LLM
  // only learns that the task_mode_classify / plan_* protocol exists after seeing this section. Otherwise the mechanism-layer
  // plan_protocol_gate is never activated (LLM does not call task_mode_classify('slow') → mode stays fast → gate not entered).
  //
  // Production (2026-05-11 mycox) showed: without this section, LLM sees guide.md and directly webFetches
  // without following the protocol; with this section, LLM proactively calls task_mode_classify.
  const sidForMode = currentSessionId();
  const currentMode = sidForMode ? taskModeStore.get(sidForMode) : 'fast';
  lines.push('## Task Mode Self-Assessment (v17 Complex Task Protocol)');
  if (currentMode === 'fast') {
    lines.push(`Current mode: **fast**`);
    lines.push('');
    lines.push('If this task matches any of the criteria below, **call `task_mode_classify({ mode: "slow", reason })` as the first step** before starting work.');
    lines.push('');
    lines.push('[4 self-check questions — any yes → slow]');
    lines.push('Q1 How many **independently verifiable outputs** does this task have? ≥ 2 → slow');
    lines.push('Q2 Are there **dependencies between steps** (B must wait for A\'s result)? Yes → slow');
    lines.push('Q3 Does the task involve **writes to the external world** (create account / send message / deploy / modify remote data)?');
    lines.push('   Yes → lean slow, unless the write is a single one-shot action with no subsequent verification');
    lines.push('Q4 Has the user provided a **guide document / URL / multi-step instructions** (## multi-section / 1./2./3. list)?');
    lines.push('   Yes → slow, must follow every item in the document');
    lines.push('');
    lines.push('Does not match → fast (single tool call / single-intent answer is sufficient).');
    lines.push('');
    lines.push('Once slow is activated, the mechanism layer enforces: plan_draft (with deliverables) → plan_update_step → plan_close (with deliverable_status). **Skipping the protocol = tool rejected by plan_protocol_gate**.');
  } else {
    // slow mode: show active plan state + next step guidance
    const sessionPlans = sidForMode
      ? memory.plans.listBySession(sidForMode, { limit: 1 })
      : [];
    const lastPlan = sessionPlans[0];
    lines.push(`Current mode: **slow**`);
    if (!lastPlan) {
      lines.push('**Plan not yet created** — call `plan_draft({ steps, task_signature, guide_ref })` immediately to break it down. The mechanism layer has blocked all other tools until the first `plan_update_step(status="doing")` (draft→executing transition is automatic).');
    } else if (lastPlan.status === 'draft') {
      // M4(2026-05-15) spec-coverage: distinguish placeholder plan vs real plan
      if (lastPlan.isPlaceholder) {
        lines.push(
          `Active plan: ${lastPlan.id} status **draft / placeholder plan (isPlaceholder=true)** ` +
            `(${lastPlan.steps.length} generic skeleton steps, 0 deliverables)`,
        );
        if (lastPlan.guideRef) {
          lines.push(`guide_ref: ${lastPlan.guideRef}`);
        }
        lines.push('');
        lines.push('The placeholder plan must be converted into a real plan that reflects the actual task structure. Steps in order:');
        lines.push('');
        lines.push('### 1. Read the full guide first');
        lines.push('');
        {
          const gref = lastPlan.guideRef ?? '';
          if (/^https?:\/\//i.test(gref)) {
            lines.push(`Call \`webFetch("${gref}")\`. The host automatically stores it in fetched-store; read the body returned by webFetch directly.`);
          } else if (gref.startsWith('skill:')) {
            lines.push(`Call \`use_skill("${gref.slice(6)}")\` to read the full content.`);
          } else if (gref) {
            lines.push('The guide content is a user message fragment (already in context). Proceed directly to step 2.');
          } else {
            lines.push('guide_ref is missing — confirm the task source with the user, or proceed to step 2 and break down deliverables based on the user message.');
          }
        }
        lines.push('');
        lines.push('Do NOT:');
        lines.push('- `readFile` to guess fetched-store paths (fetched-store is empty in new sessions; filenames are managed by the mechanism layer and cannot be guessed)');
        lines.push('- `plan_revise` from memory (without reading the guide you cannot know the deliverables — they will be incomplete)');
        lines.push('- Call `plan_update_step` / business tools directly (placeholder plan will reject; work done without reading the guide is unrelated to the task)');
        lines.push('- **Miss ongoing / credential deliverables** (see # 2 below) — missing them = subsequent 401 / heartbeat cannot start');
        lines.push('');
        lines.push('### 2. List deliverables');
        lines.push('');
        lines.push('Go through the guide section by section and ask:');
        lines.push('- What verifiable output does this section require?');
        lines.push('- How do we know it is done? (return value / file / fact / remote state)');
        lines.push('- Is the id kebab-case, ≥ 8 chars, and not a catch-all?');
        lines.push('');
        lines.push('**Two types of deliverables commonly missed — if you see any of the following keywords you MUST add one**:');
        lines.push('- Guide contains `Part N routine` / `check-in` / `periodic` / `ongoing` / `every N minutes` / `heartbeat`');
        lines.push('  → Must have a **schedule_reminder** deliverable (otherwise the user turn ending = task stops = ongoing commitment not fulfilled)');
        lines.push('- Guide contains `register` / `auth` returning `token` / `api_key` / `secret` / `credential`');
        lines.push('  → Must have a **saveCredential** deliverable (not stored in SecretStore → subsequent http `{SECRET_ID}` placeholder has no value → 401 Authentication required)');
        lines.push('');
        lines.push('### 3. plan_revise to convert to real plan');
        lines.push('');
        lines.push('`plan_revise({plan_id, new_steps, new_deliverables, reason})`');
        lines.push('- `new_deliverables` = complete set of truly deliverable items from the guide');
        lines.push('- `new_steps[i].covers` = deliverable ids covered by this step');
        lines.push('- `reason` = "guide reveals need to do X/Y/Z"');
        lines.push('');
        lines.push('### 4. plan_update_step("doing") — begin execution');
        lines.push('');
        lines.push('plan automatically transitions to executing.');
        lines.push('');
        lines.push('### Deliverable examples (external service integration + ongoing operation; prerequisite: guide fully read)');
        lines.push('');
        lines.push('- `register-account`: register an account on the external service and obtain account_id');
        lines.push('- `save-credentials`: register returns token/api_key — **immediately** `saveCredential` to SecretStore');
        lines.push('- `verify-auth`: call one read-only API to confirm the key is valid');
        lines.push('- `first-write-op`: perform one minimal write operation to verify the full chain');
        lines.push('- `setup-heartbeat`: register a periodic check-in via `schedule_reminder` (only if the guide mentions routine / periodic tasks)');
        lines.push('');
        lines.push('Name ids after your actual task — do not copy the example ids above.');
      } else {
        lines.push(
          `Active plan: ${lastPlan.id} status **draft** (${lastPlan.steps.length} steps, ${lastPlan.deliverables.length} deliverables)`,
        );
        lines.push('**Next step: call plan_update_step({step_id, status:"doing"})** to begin execution. plan.status will automatically transition to executing.');
      }
    } else if (lastPlan.status === 'executing') {
      const doneCount = lastPlan.steps.filter((s) => s.status === 'done').length;
      lines.push(
        `Active plan: ${lastPlan.id} status **${lastPlan.status}** (${doneCount}/${lastPlan.steps.length} done)`,
      );
      const next = lastPlan.steps.find(
        (s) => s.status === 'pending' || s.status === 'doing',
      );
      if (next) {
        lines.push(`Next step: [${next.id}] ${next.description} (${next.status})`);
      }
      lines.push('Use `plan_update_step` to advance / `plan_revise` to modify the plan / `plan_close` to finalize.');
    } else {
      // completed / failed
      lines.push(
        `Active plan: ${lastPlan.id} status **${lastPlan.status}** (finalized). If this is a new task, call task_mode_classify to re-assess.`,
      );
    }

    // Phase 15 (2026-05-18): slow task execution discipline. Analogous to Claude Code programming; fully generic,
    // contains no project-specific keywords. Historical LLM drift pattern: after 50s of slow task, LLM only reads guide → outputs
    // "let me first look at other communities" (commitment-style language) → turn ends. This section explicitly states the
    // "complete in one go" principle + autonomous problem-solving discipline + prohibition of commitment phrasing; half-finished detector handles genuine drift.
    lines.push('');
    lines.push('### Slow task execution discipline (analogous to Claude Code programming)');
    lines.push('');
    lines.push('**Complete in a single turn**:');
    lines.push('- A slow task = one complete "code execution". The plan is the code; tool calls are the runtime');
    lines.push('- All deliverables MUST be completed within this turn. Channels are fire-and-forget (user sends and leaves)');
    lines.push('- Analogy: Claude Code given "write a script" does not "research first and write later" — it goes: plan + write + run + debug');
    lines.push('');
    lines.push('**Solve problems autonomously** (do not wait for user prompts):');
    lines.push('- Tool failure = error → read the error, change approach, retry');
    lines.push('- Missing information → webSearch / read referenced docs / try endpoint variants');
    lines.push('- Auth failure → listCredentialNames to get credential names, try different headers (Authorization Bearer / X-API-Key / X-Auth-Token etc.)');
    lines.push('- Truly stuck (missing input only the user can provide) → askUserQuestion, **do not promise "later"**');
    lines.push('');
    lines.push('**Forbidden final text patterns** (mechanism layer half-finished detector triggers cap=1 regen):');
    lines.push('- ❌ "let me first X" / "I\'ll first Y then Z" / "I need to understand first"');
    lines.push('- ❌ "next I will" / "next I\'ll" / "let me look at"');
    lines.push('- ❌ "next time" / "later" / "soon" / "in a moment"');
    lines.push('');
    lines.push('**Allowed final text**:');
    lines.push('- ✅ "Completed X, N/M deliverables done" (specific progress + plan_close)');
    lines.push('- ✅ "Stuck: <reason> + already tried <method>" (plan_close(failure))');
    lines.push('- ✅ askUserQuestion (genuinely missing user input)');
  }
  lines.push('');

  // ── Recent cross-channel uploaded files ──────────────────────────────────────
  // Solves the reference ambiguity problem: "user uploads a PDF on WeChat + says 'the one I just uploaded' on web-ui":
  // K0 timeline is global, but the retriever does keyword recall; pronouns ("this"/"the recent one") have no semantic signal and frequently miss.
  // Always-on here: exposes the 3 most recent attachments within 1h at the top of the prefix so the LLM can see their paths at a glance.
  const fresh = recentAttachments({ limit: 3, ttlMs: 60 * 60_000 });
  if (fresh.length > 0) {
    lines.push('## Recently uploaded files (cross-channel)');
    const now = Date.now();
    for (const att of fresh) {
      const ageMin = Math.max(1, Math.round((now - att.ts) / 60_000));
      const channelLabel = att.channel.split(':')[0]; // wechat / webui …
      lines.push(`  · ${att.filename} @ ${att.path} (${channelLabel}, ${ageMin} min ago)`);
    }
    lines.push('When the user says "the file I just uploaded / this file", it most likely refers to one of the above. Do not glob the entire filesystem.');
    lines.push('');
  }

  // ── Phase 10 M2 (2026-05-15): cross-turn / cross-session fetched resources ─────────
  // Fixes heartbeat scheduled task bug: guide.md fetched by webFetch in the main session was stored in
  // FetchedResourceStore, but the scheduled task session could not see it → LLM guessed the API
  // endpoint → 404 wall-loop. Always-on: renders top 5 within 7 days in the prefix, cross-session.
  try {
    const FETCHED_TTL_MS = 7 * 24 * 60 * 60_000;
    const fetched = fetchedStore.listRecent({
      sinceTs: Date.now() - FETCHED_TTL_MS,
      limit: 5,
    });
    if (fetched.length > 0) {
      lines.push('## Resources I have previously fetched (cross-turn / cross-session, within 7 days)');
      const now = Date.now();
      for (const r of fetched) {
        const ageMin = Math.max(1, Math.round((now - r.fetchedAt) / 60_000));
        const ageLabel =
          ageMin < 60
            ? `${ageMin} min ago`
            : ageMin < 24 * 60
              ? `${Math.round(ageMin / 60)} hr ago`
              : `${Math.round(ageMin / 1440)} days ago`;
        const sizeLabel = r.isBinary
          ? `${Math.round(r.byteSize / 1024)}K binary`
          : `${r.charSize ?? r.byteSize}c`;
        const binTag = r.isBinary ? ' [binary]' : '';
        lines.push(
          `  · ${r.sourceRef}${binTag}\n` +
            `    → local: ${r.localPath} (${sizeLabel}, ${ageLabel}, via ${r.sourceTool})`,
        );
      }
      lines.push(
        '**readFile the local path before using** — do not re-fetch the same URL with webFetch.' +
          ' When you need guide / API doc content: if a relevant resource is listed here, readFile the full text (more reliable than guessing endpoints from memory).',
      );
      lines.push('');
    }
  } catch (e) {
    console.warn('[memory-prefix] fetched-store render failed, skipped:', e);
  }

  // 2026-05-23: project facts use top-N by recency cap; user facts are not capped.
  //
  // Design rationale:
  // - user.* are mostly "identity/config-type" facts (name / role / timezone / locale / preferences);
  //   written once and used permanently, rarely updated. Sorting by createdAt would push critical facts
  //   like timezone down as new "behavioral user.* facts" (e.g. user.recent_interest) are written — unacceptable.
  //   user count is usually small (< 30 entries); not capping is only ~10K total.
  // - project.* are frequently written as new research/context by the LLM / extractor; they need a cap.
  //   top-20 by createdAt prioritizes the most recently relevant context; the LLM can call listFacts for older entries.
  //
  // Fallback: user.* also has a "100-entry ceiling" to prevent pathological cases; not triggered under normal use.
  const PROJECT_FACTS_TOP_N = 20;
  const USER_FACTS_SAFETY_CAP = 100;
  const renderFactsSection = (
    ns: 'user' | 'project',
    headingLabel: string,
    topN: number,
  ) => {
    const all = memory.facts.listFacts(ns);
    if (all.length === 0) return;
    // 2026-05-23: sort key is lastAccessedAt desc (fallback to createdAt for old DBs with NULL).
    // "Accessed = explicitly read by getFact / written by storeFact", reflecting actual usage patterns. Better than
    // pure createdAt at preserving identity/config-type facts that are "written once but read often".
    const key = (f: Fact) => f.lastAccessedAt ?? f.createdAt;
    const top = [...all].sort((a, b) => key(b) - key(a)).slice(0, topN);
    lines.push(`## ${headingLabel}`);
    for (const f of top) {
      const valueStr = truncateForInjection(
        JSON.stringify(f.value),
        FACT_VALUE_INJECT_CAP,
        `${ns}.${f.key}`,
      );
      lines.push(`  ${ns}.${f.key} = ${valueStr}`);
    }
    if (all.length > topN) {
      lines.push(
        `  ... (${all.length - topN} older facts not injected — use \`listFacts({namespace:"${ns}"})\` to retrieve all when needed)`,
      );
    }
    lines.push('');
  };
  renderFactsSection('user', 'Known user information', USER_FACTS_SAFETY_CAP);
  renderFactsSection('project', 'Known project information', PROJECT_FACTS_TOP_N);

  // Skill index: only injects name + one-line description; minimal token cost.
  // The LLM calls use_skill(name) itself to get details when needed.
  // positive and negative are injected separately: positive via index (use_skill to pull details);
  // negative are hard constraints ("do not do this again") that the LLM must see every time,
  // so the key section of action_template is injected directly (rather than just listing the name).
  // ── Extended capabilities section (above the regular skill index; visual priority) ──
  //
  // Separate clawhub / github-skills from the regular index, rendering them as an independent "meta-skill" section.
  // This fix is based on observed production behavior:
  //   1) clawhub's triggerKeywords are generic descriptions ("user asks about something unfamiliar");
  //      FTS5 keyword search in search_skills cannot find it for any specific domain query → LLM thinks clawhub
  //      is "irrelevant" and ignores it.
  //   2) Even when it appears in the regular index, buried among 20 lines the LLM tends to "skim past it and use search_skills
  //      to find the next skill", never forming the reflex of "use use_skill to go outside".
  //   3) When the user explicitly says "try using clawhub", the agent still calls search_skills — showing the LLM
  //      does not distinguish "clawhub-the-meta-skill" vs "a search_skills index entry"; an explicit
  //      mental model clarification is needed.
  //
  // Design: always-render (not affected by top-20 ranking), standalone H2 section, explicitly stating:
  //   - entry action (use_skill not search_skills)
  //   - 5 specific trigger conditions (covering the LLM's common "I don't know how" branches)
  //   - mental model ("clawhub is a meta-skill for finding new skills, not a regular domain skill")
  const clawhubSkill = memory.skills.getByName('clawhub');
  const githubSkill = memory.skills.getByName('github-skills');
  if (clawhubSkill || githubSkill) {
    lines.push('## Extended capabilities — use these when local skills are insufficient');
    lines.push('');
    lines.push('Entry points (call directly, do NOT search_skills first):');
    if (clawhubSkill) {
      lines.push(`  - \`use_skill('clawhub')\` → install a new skill from the ClawHub public skill library`);
    }
    if (githubSkill) {
      lines.push(`  - \`use_skill('github-skills')\` → install SKILL.md from a GitHub repository`);
    }
    lines.push('');
    lines.push('When to use (any match triggers, **no user prompt needed**):');
    lines.push('  - search_skills returns empty, or results are unsuitable / failed when tried');
    lines.push('  - User asks about an unfamiliar domain not covered by the local skill library');
    lines.push('  - A tool call fails and a different approach is needed (network blocked / no permission / unsupported)');
    lines.push('  - You are about to say "I can\'t / can\'t find / unfamiliar with / temporarily unable / no ready-made X"');
    lines.push('  - User hints "is there another way / look at others / try X"');
    lines.push('');
    lines.push('Mental model: these two are meta-skills for "learning new capabilities externally". **Invoke with use_skill**');
    lines.push('(not ordinary skills in the search_skills index). Takes effect immediately after loading, no user consent required.');
    lines.push('This is the standard way to extend your capabilities — not overstepping, not a burden.');
    lines.push('');
  }

  // Regular skill index: exclude meta-skills already shown in the "extended capabilities" section to avoid duplication
  const META_SKILL_NAMES = new Set(['clawhub', 'github-skills']);
  const SKILL_INDEX_MAX_LINES = 15;
  const SKILL_WHEN_TO_USE_TRUNC = 120;
  const allTop = memory.skills.listAll(40);
  const positives = allTop
    .filter((s) =>
      s.kind !== 'negative'
      && !META_SKILL_NAMES.has(s.name)
      // 2026-05-11: playbooks go in their own dedicated section "## Lessons I've Learned Before", not mixed into the skill index.
      // Otherwise playbooks would be sorted by useCount too; always 0 → ranked last, never making top-15, effectively invisible.
      && s.maturity !== 'playbook'
    )
    .slice(0, SKILL_INDEX_MAX_LINES);
  if (positives.length > 0) {
    lines.push('Available skills (use use_skill(name) to get details):');
    for (const s of positives) {
      // Source label: source looks like 'clawhub:foo@1.0.0' / 'github:owner/repo@sha' /
      // 'url:https://...'; displayed as [clawhub] / [github] / [url]. Locally handwritten / reflection-generated
      // (source IS NULL) have no label — keeps index lines concise.
      const tag = s.source
        ? ` [${s.source.split(':')[0]}]`
        : '';
      lines.push(`  - ${s.name}${tag}: ${s.description}`);
      // 2026-05-09 v15: when when_to_use is present, append a scenario line (LLM semantic judgment of when to use this skill).
      // Without it, only the description line is shown (reflection-generated skills / old SKILL.md without the field
      // all gracefully degrade).
      if (s.whenToUse && s.whenToUse.trim()) {
        const trimmed = s.whenToUse.trim();
        const display = trimmed.length > SKILL_WHEN_TO_USE_TRUNC
          ? trimmed.slice(0, SKILL_WHEN_TO_USE_TRUNC) + '…'
          : trimmed;
        lines.push(`    When to use: ${display}`);
      }
    }
  }

  // 2026-05-11 (v17 complex-task protocol Phase 5.5): dedicated "❌ My previous failure patterns" section.
  // Renders playbooks distilled from plan_close('failure') (source LIKE 'plan-failure:%'),
  // complementing the "📚 Lessons I've Learned Before" section below — the former is a strong signal of "fell into the same trap last time on this task";
  // the latter is "reflection summary" ordinary lessons. Failure-pattern section comes first (higher priority) with fewer entries (top-3).
  //
  // Makes the LLM see "how the same type of task failed last time" at turn start, reducing the probability of repeating mistakes.
  // Implementation: filter the maturity='playbook' pool for source LIKE 'plan-failure:%', take top 3 by created_at DESC.
  const FAILURE_MODE_TOP_N = 3;
  const playbookPool = memory.skills.listByMaturity('playbook', 30);
  const failurePlaybooks = playbookPool
    .filter((p) => p.source?.startsWith('plan-failure:'))
    .slice(0, FAILURE_MODE_TOP_N);
  if (failurePlaybooks.length > 0) {
    lines.push('');
    lines.push('## ❌ My past failure patterns');
    lines.push('(Failure patterns distilled from past plan_close(failure) turns. If the current task matches a task_signature below, **read this section first** to avoid repeating the same mistakes.)');
    for (const fb of failurePlaybooks) {
      const sigMatch = fb.name.match(/^playbook-(.+?)-fail-[a-z0-9]+$/);
      const sigPrefix = sigMatch ? ` [${sigMatch[1]}]` : '';
      lines.push(`· ${fb.name}${sigPrefix}`);
      const body = fb.description.trim();
      const indented = body
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      lines.push(indented);
    }
    lines.push('');
  }

  // 2026-05-11: Playbook rendered as a standalone section. A playbook is a "experience note" from reflection distillation, hint-only
  // (isCallableMaturity returns false; the LLM cannot call it via use_skill). Previously mixed into the skill index
  // sorted by useCount; playbook useCount is always 0, forever ranked last, never making top-15 — **effectively invisible**.
  // Now rendered as an independent section, complementing the routing section: routing teaches "what should be used";
  // playbook teaches "what should be avoided / watched out for".
  //
  // Exclude plan-failure playbooks already rendered in the "## ❌ My previous failure patterns" section above (avoid duplicate exposure).
  const PLAYBOOK_TOP_N = 5;
  const failureNames = new Set(failurePlaybooks.map((p) => p.name));
  const playbooks = memory.skills
    .listByMaturity('playbook', PLAYBOOK_TOP_N + failurePlaybooks.length)
    .filter((p) => !failureNames.has(p.name))
    .slice(0, PLAYBOOK_TOP_N);
  if (playbooks.length > 0) {
    lines.push('');
    lines.push('## Lessons I have learned');
    lines.push('(These are lessons distilled from past reflections, not callable skills. When you see a matching "when" situation, remember to follow the "next time" action.)');
    for (const pb of playbooks) {
      // description has already been assembled as "lesson\napplicable: ...\nnext time: ..." in the applyReflection phase.
      // Directly indent-inject here.
      const body = pb.description.trim();
      // Extract task_signature as prefix (playbook name looks like 'playbook-<sig>-<hash>';
      // extract sig for the LLM to see).
      const sigMatch = pb.name.match(/^playbook-(.+?)-[a-z0-9]+$/);
      const sigPrefix = sigMatch ? ` [${sigMatch[1]}]` : '';
      lines.push(`· ${pb.name}${sigPrefix}`);
      const indented = body
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      lines.push(indented);
    }
    lines.push('');
  }

  const negatives = memory.skills.listNegative(20);
  if (negatives.length > 0) {
    lines.push('⚠️ The user has previously corrected these behaviors — avoid repeating them in the following situations:');
    for (const s of negatives) {
      lines.push(`  - ${s.name}: ${s.description}`);
      // negative templates are short (three-section format); injecting them in full is cost-manageable
      const tpl = s.actionTemplate.trim();
      if (tpl) {
        const indented = tpl
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n');
        lines.push(indented);
      }
    }
  }

  // K0: no longer specially injecting "state from the last conversation" — the LLM sees a continuous global timeline;
  // the retriever brings back relevant old fragments (including historical session-summary notes) on demand;
  // no need to hard-code the most recent summary into the prefix.

  // K7.3: interrupt-driven intrinsic-drive injection path.
  // Flow:
  //   1) Recompute all signals (commitment_pressure / service_dormancy)
  //   2) Drain accumulated fires from the drainer (triggered during idle period)
  //   3) mapper.tick(broadcast=false) to get the just-fired signals for this turn
  //   4) Render into the system section by severity bucket (not the user-role slot)
  //
  // Invariant: `messages[]` always contains only real user + real assistant + real tool messages. drive / interrupt
  // are 100% in the systemPrompt+memoryPrefix section. This fixes the class of bugs where drive mis-fires are treated by the LLM as
  // "user's words" causing a doubling-down response.
  try {
    // (1) Refresh signal state (commitment_pressure is refreshed uniformly outside mapper)
    const active = memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID);
    signalState.recomputeCommitmentPressure(active, Date.now());

    // (2) Drain idle-period accumulated fires
    const drained = interruptDrainer.drain();

    // 2026-05-06 D.2: report drain count to reflection trigger (critical+high+normal
    // > 0 means interruptDrained for this turn). low does not count — that is a harmless intrinsic-drive observation.
    if (signalBus) {
      signalBus.interruptDrainedCount =
        drained.critical.length + drained.high.length + drained.normal.length;
    }

    // (3) tick mapper without broadcasting (to avoid drainer re-sending next turn)
    const snapshot = collectSignalSnapshot();
    const justFired = interruptMapper.tick(snapshot, { broadcast: false });

    // (4) Render by severity. Both sources restore rich payload by "signal kind".
    type AnySig = { kind: string; payload: string; severity: string };
    const drainAsAny = (arr: typeof drained.critical): AnySig[] =>
      arr.map((s) => ({ kind: s.kind, payload: s.payload, severity: s.severity }));
    const justAsAny: AnySig[] = justFired.map((f) => ({
      kind: signalKindForFire(f.signal, f.level),
      payload: `${f.signal}=${f.value.toFixed(2)} → ${f.level}`,
      severity: levelToSeverityStr(f.level),
    }));

    const all = {
      critical: [...drainAsAny(drained.critical), ...justAsAny.filter((s) => s.severity === 'critical')],
      high:     [...drainAsAny(drained.high),     ...justAsAny.filter((s) => s.severity === 'high')],
      normal:   [...drainAsAny(drained.normal),   ...justAsAny.filter((s) => s.severity === 'normal')],
      low:      [...drainAsAny(drained.low),      ...justAsAny.filter((s) => s.severity === 'low')],
    };

    // CRITICAL → pinned at top
    if (all.critical.length > 0) {
      const sigBreakdown = signalState.getCommitmentBreakdown();
      const dorm = computeServiceDormancy({ lastAssistantTs: lastAssistantTs(), now: Date.now() });
      lines.unshift(''); // visual spacer
      for (const s of all.critical) {
        if (s.payload.startsWith('service_dormancy')) {
          lines.unshift(`## ⚠️ I have not served you for ${dorm.hoursSinceLastServe.toFixed(1)} hours`);
          if (sigBreakdown && sigBreakdown.contributors.length > 0) {
            lines.push('Open items (by urgency):');
            for (const c of sigBreakdown.contributors.slice(0, 3)) {
              const ageStr = c.ageHours < 24 ? `${Math.round(c.ageHours)}h` : `${Math.round(c.ageHours / 24)}d`;
              lines.push(`  - ${c.title} (pending ${ageStr})`);
            }
          }
          lines.push('What might you need? Or should we handle these first?');
        } else {
          lines.unshift(`## ⚠️ Must handle immediately: ${s.kind}(${s.payload})`);
        }
      }
    }

    // HIGH → middle section "## Needs Attention"
    if (all.high.length > 0) {
      lines.push('## Needs attention');
      for (const s of all.high) {
        if (s.payload.startsWith('commitment_pressure')) {
          const sb = signalState.getCommitmentBreakdown();
          lines.push(`  · My outstanding commitments (urgency ${sb?.pressure.toFixed(2) ?? '?'}):`);
          if (sb) {
            for (const c of sb.contributors.slice(0, 3)) {
              const ageStr = c.ageHours < 24 ? `${Math.round(c.ageHours)}h` : `${Math.round(c.ageHours / 24)}d`;
              lines.push(`    - ${c.title} (pending ${ageStr}, stake ${c.stakeWeight}/10)`);
            }
          }
        } else if (s.payload.startsWith('service_dormancy')) {
          const dorm = computeServiceDormancy({ lastAssistantTs: lastAssistantTs(), now: Date.now() });
          lines.push(`  · I have not truly served you for ${dorm.hoursSinceLastServe.toFixed(1)} hours`);
        } else {
          lines.push(`  · ${s.kind}: ${s.payload}`);
        }
      }
    }

    // NORMAL → bottom "## Intrinsic-drive observation"
    if (all.normal.length > 0) {
      lines.push('## Intrinsic-drive observation');
      for (const s of all.normal) {
        if (s.payload.startsWith('commitment_pressure')) {
          const sb = signalState.getCommitmentBreakdown();
          lines.push(`  · ${sb?.activeCount ?? 0} open items, urgency ${sb?.pressure.toFixed(2) ?? '?'}`);
        } else {
          lines.push(`  · ${s.kind}: ${s.payload}`);
        }
      }
    }

    // LOW → audit only, not rendered
    if (all.low.length > 0) {
      internalAudit.append('self_domain_write', {
        source: 'interrupt_drainer',
        origin: 'Internal',
        toolName: 'interrupt_drained_low',
        count: all.low.length,
      });
    }

    // Also write an audit record for each fired signal
    if (justFired.length > 0) {
      for (const f of justFired) {
        internalAudit.append('self_domain_write', {
          source: 'interrupt_mapper',
          origin: 'Internal',
          toolName: 'signal_threshold_crossed',
          signal: f.signal,
          severity: f.level,
          prevSeverity: f.prevLevel,
          value: f.value,
          firedAtMs: f.firedAtMs,
          source_path: 'render',
        });
      }
    }
  } catch (e) {
    console.error('[interrupt] prefix render path error', e);
  }

  // K3: self-awareness (self.* facts by SelfReflector) — lets the agent read "what I have become".
  // This is not a role assignment; it is a mirror of emergent identity. The agent can read but not write.
  const selfFact = memory.facts.getFact('self', 'summary');
  if (selfFact) {
    const val = selfFact.value as { content?: string | string[] };
    if (typeof val.content === 'string' && val.content.trim()) {
      lines.push('## Who I am now (self-knowledge from past experience)');
      lines.push(val.content);
      const strengthsFact = memory.facts.getFact('self', 'strengths');
      if (strengthsFact) {
        const s = strengthsFact.value as { content?: string | string[] };
        if (Array.isArray(s.content) && s.content.length > 0) {
          lines.push('My strengths: ' + s.content.join(', '));
        }
      }
      const edgesFact = memory.facts.getFact('self', 'growth_edges');
      if (edgesFact) {
        const e = edgesFact.value as { content?: string | string[] };
        if (Array.isArray(e.content) && e.content.length > 0) {
          lines.push('Still learning: ' + e.content.join(', '));
        }
      }
    }
  }

  // K8 proactivity layer: display outputs produced by the autonomous loop since the last user message.
  // Two parallel sections:
  //   1. K7→K8 bridge review section — agent self-correction records (higher signal, placed first)
  //   2. General autonomous research section — proactive output from Gap/Curiosity etc. (placed second)
  // Either section contributes zero characters when empty; entire block omitted when both are empty.
  try {
    const lastUserMsg = memory.raw.getLastMessageByRole('user');
    const sinceTs = lastUserMsg ? lastUserMsg.timestamp - 60_000 : 0;

    const reviewSection = buildK7BridgeReviewSection(autonomousLoop.initiatives, {
      sinceTs,
      topK: 3,
      maxChars: 800,
    });
    if (reviewSection) {
      lines.push('');
      lines.push(reviewSection);
    }

    const progressSection = buildAutonomousProgressInjection(autonomousLoop.initiatives, {
      sinceTs,
      topK: 3,
      maxChars: 800,
    });
    if (progressSection) {
      lines.push('');
      lines.push(progressSection);
    }

    // Proactive research "request permission": background executor requested a gated tool → render "## Pending Background Research Approvals",
    // guiding the user to call grant_research_tool to approve. Data source = pursuit.openQuestions[].pendingTool.
    const researchRoot = memory.pursuits.getDefaultRoot();
    if (researchRoot) {
      const grantSection = buildResearchPendingGrantSection(memory.pursuits, researchRoot.id, {
        topK: 5,
        maxChars: 1000,
      });
      if (grantSection) {
        lines.push('');
        lines.push(grantSection);
      }
    }

    // Deep reasoning subsystem: informs the next turn that an active reasoning session exists and can be continued.
    // When env flag is off, the reasoning table is empty → listActiveSessions is empty → returns empty string, zero cost.
    const reasoningSection = buildReasoningProgressSection(memory.reasoning, { maxChars: 800, ownerSessionId: currentSessionId() });
    if (reasoningSection) {
      lines.push('');
      lines.push(reasoningSection);
    }
  } catch (e) {
    console.warn('[autonomous] progress inject failed, skipped', e);
  }

  // 2026-05-07 path 7: user behavior observation candidate — render "Patterns I've Observed" section;
  // the LLM responds with "learn/decline" when it sees it on the next user turn.
  try {
    const pending = listPendingPatterns(memory.facts);
    if (pending.length > 0) {
      const observation = buildUserPatternObservationSection(pending, { maxPatterns: 2 });
      if (observation.matched) {
        lines.push('');
        lines.push(observation.text);
      }
    }
  } catch (e) {
    console.warn('[user-pattern] inject failed, skipped', e);
  }

  if (lines.length === 0) return '';

  const raw =
    '\n\n[Memory layer — the following is already known; no need to ask or query again]\n' +
    lines.join('\n') +
    '\n[End of memory layer]';

  // When over the limit (or when PHILONT_PREFIX_TRACE=1 is explicitly set), split by `## heading` and output the char count
  // of each section to assist diagnosing "which section is bloating". Trace is not re-emitted — only runs on warn / explicit trace.
  const shouldTrace =
    raw.length > MEMORY_PREFIX_TOTAL_CAP || process.env.PHILONT_PREFIX_TRACE === '1';
  if (shouldTrace) {
    try {
      const segments = splitPrefixBySection(raw);
      const summary = segments
        .slice(0, 10) // top 10 segments is enough to identify the culprit
        .map((s) => `${s.title}=${s.chars}`)
        .join(', ');
      console.warn(`[memory-prefix] segments total=${raw.length} chars: ${summary}`);
    } catch (e) {
      console.warn('[memory-prefix] segment trace failed, ignored', (e as Error)?.message ?? e);
    }
  }

  // Total limit gate — even when each section was truncated, the sum can still exceed the limit.
  // Exceeding the total limit necessarily indicates a bug (too many facts? a section truncation not effective?); this is the last line of defense.
  if (raw.length > MEMORY_PREFIX_TOTAL_CAP) {
    console.warn(
      `[memory-prefix] over cap ${raw.length} → ${MEMORY_PREFIX_TOTAL_CAP} chars, force truncated`,
    );
    return (
      raw.slice(0, MEMORY_PREFIX_TOTAL_CAP) +
      `\n...[memory prefix too long, truncated. Original ${raw.length} chars]\n[End of memory layer]`
    );
  }
  console.log(`[memory-prefix] size=${raw.length} chars`);
  return raw;
}

/**
 * In-flight compaction check: when the **current turn's working context** (messages array) grows beyond the threshold,
 * summarize the middle section while preserving the head and tail.
 *
 * After K0, messages are per-turn fresh; this compaction mainly protects a single turn's tool loop
 * from being blown up by oversized tool_results. Long-term compaction of the raw global timeline is delegated to
 * an offline path outside idle_consolidator (K0.5+ future work: compactTimelineRange + TimelineRetriever detecting
 * "this period is covered by a summary stand-in" and replacing with the summary). Currently raw only stores text
 * not tool_use/tool_result blocks, and TimelineRetriever has its own token budget,
 * so the LLM window will not blow up from long-tail messages in the near term.
 *
 * Note: mutates the original array (length + splice) for compatibility with existing callers.
 */
/**
 * Context compaction scheduling. Two modes:
 *   - 'soft' (default, used at turn-entry "quiet period"): compacts when thresholdTokens is reached.
 *     The user message has just arrived and the LLM has not started; plan/tool chain is not mid-execution;
 *     summarizing the middle section at this point does not corrupt precise IDs.
 *   - 'hard' (used inside the turn tool loop): only compacts when hardThresholdTokens is reached,
 *     as a safety net to prevent the LLM context window from truly overflowing. Below this threshold
 *     **no compaction** within the turn — protects plan_id / tool_result chain in the tail protectLastN
 *     entries from being compressed, avoiding corruption of precise protocol IDs.
 *
 * evictOldToolResults runs in both modes (idempotent; only replaces early tool_result with placeholders,
 * keeps the most recent K entries intact, does not touch the tool_use block containing plan_id).
 */
async function maybeCompact(
  messages: NativeMessage[],
  sessionId: string,
  mode: 'soft' | 'hard' = 'soft',
): Promise<void> {
  const shouldCompact =
    mode === 'hard'
      ? compactor.needsHardCompaction(messages as unknown as { role: string; content: unknown }[])
      : compactor.needsCompaction(messages as unknown as { role: string; content: unknown }[]);

  if (shouldCompact) {
    const result = await compactor.compact(
      messages as unknown as { role: string; content: unknown }[],
      sessionId,
    );
    if (result.didCompact) {
      console.log(
        `[memory] compress session=${sessionId} mode=${mode}: ${result.tokensBefore} → ${result.tokensAfter} tokens (note=${result.summaryNoteId})`,
      );
      messages.length = 0;
      messages.push(...(result.compactedMessages as unknown as NativeMessage[]));
    }
  }

  // Capacity eviction: total tokens exceed budget → replace old tool_result content with placeholders,
  // keeping the most recent K entries intact. Idempotent; multiple calls are no-op. Runs in both modes.
  const eviction = evictOldToolResults(messages);
  if (eviction.didEvict) {
    console.log(
      `[memory] evict old tool_result session=${sessionId}: ${eviction.tokensBefore} → ${eviction.tokensAfter} tokens (${eviction.evictedCount} items)`,
    );
  }
}

/**
 * Hard timeout (milliseconds) for a single LLM call. The Anthropic SDK usually throws on network errors,
 * but occasionally socket hangs or stream stops advancing — await would never return,
 * the turn loop silently hangs, and the frontend spins forever. This provides a fallback timeout for each call;
 * when exceeded, LlmTimeoutError is thrown so the outer layer takes the error path and emits final to the client.
 */
// 2026-05-07: 60s → 90s. Anthropic stream occasionally waits 30-90s before first token;
// 60s was too sensitive, causing false-positive timeouts when upstream genuinely needs a slow response → retry also waits 60s,
// total 120s = 40% of the 5-min hard deadline. 90s allows most slow responses to complete without retry.
//
// 2026-05-27 round 1: 90s → 180s, adjustable by env (after Phase 18 lazy gate LLM probes more data)
// 2026-05-27 round 2: 180s → 300s (Medical production saw 180s × 2 retries not enough)
// 2026-05-27 round 3: **changed to adaptive**. Medical still frequently hits 300s; root cause = LLM single-call output is large
//   (writing a 6KB Python script ~2300 tokens + reasoning + summary ~1000 tokens = 3000+
//    token output); a slow provider at 10 t/s needs 300s+ per call; 300s is not enough.
//
// Adaptive formula (based on LLM_MAX_OUTPUT_TOKENS budget size):
//   timeout = base_overhead + max_tokens × per_token_estimate
//          = 30s + 4096 × 100ms (assuming worst-case rate of 10 t/s) = 440s
//
// Direct Sonnet 4.6 (~50 t/s) in practice only uses ~80s; giving 440s is redundant but harmless (only an upper bound).
// Slow relay (10 t/s) uses it fully. env override retained (for precise control when needed).
//
// PHILONT_LLM_CALL_TIMEOUT_MS: overrides the entire computed result (clamped to 30s-600s)
// PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN: overrides per_token_estimate (default 100ms = 10 t/s)
// Linked to PHILONT_LLM_MAX_TOKENS in llm-adapter.ts: when the reasoning model budget is set large (16000+),
// output budget grows → single generation takes longer → timeout must scale accordingly.
const LLM_MAX_OUTPUT_TOKENS = (() => {
  const raw = process.env.PHILONT_LLM_MAX_TOKENS;
  if (!raw) return 4096;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 256 && n <= 32768) return n;
  return 4096;
})();
const LLM_BASE_OVERHEAD_MS = 30_000; // fixed overhead: network + input processing + time to first token
const LLM_TIMEOUT_CLAMP_MIN_MS = 60_000;
// Cap raised to 15min: reasoning model 16000 tokens × ~40ms/token (production deepseek ~27 t/s)
// ≈ 640s, with thinking headroom. Note: when single LLM call is ≤ 15min, multi-step tasks need a larger
// task_timeout (benchmark harness task-timeout, e.g. 3600s).
const LLM_TIMEOUT_CLAMP_MAX_MS = 900_000;

function computeLlmCallTimeoutMs(): number {
  // Explicit env override takes priority
  const raw = process.env.PHILONT_LLM_CALL_TIMEOUT_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= LLM_TIMEOUT_CLAMP_MIN_MS && n <= LLM_TIMEOUT_CLAMP_MAX_MS) {
      return n;
    }
    console.warn(
      `[llm] PHILONT_LLM_CALL_TIMEOUT_MS=${raw} invalid (allowed ${LLM_TIMEOUT_CLAMP_MIN_MS}-${LLM_TIMEOUT_CLAMP_MAX_MS}), using adaptive`,
    );
  }
  // Adaptive: base + max_tokens × per_token_estimate
  const rawRate = process.env.PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN;
  let msPerToken = 100; // default 100ms/token = 10 t/s (worst-case assumption for slow proxy)
  if (rawRate) {
    const r = parseFloat(rawRate);
    if (Number.isFinite(r) && r >= 5 && r <= 500) {
      msPerToken = r;
    } else {
      console.warn(`[llm] PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN=${rawRate} invalid (allowed 5-500), using default 100`);
    }
  }
  const computed = LLM_BASE_OVERHEAD_MS + LLM_MAX_OUTPUT_TOKENS * msPerToken;
  return Math.max(LLM_TIMEOUT_CLAMP_MIN_MS, Math.min(LLM_TIMEOUT_CLAMP_MAX_MS, computed));
}

const LLM_CALL_TIMEOUT_MS = computeLlmCallTimeoutMs();
console.log(
  `[llm] call timeout: ${LLM_CALL_TIMEOUT_MS}ms` +
    ` (formula: ${LLM_BASE_OVERHEAD_MS}ms base + ${LLM_MAX_OUTPUT_TOKENS} tokens × ${
      process.env.PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN ?? '100'
    }ms/token, clamp [${LLM_TIMEOUT_CLAMP_MIN_MS}, ${LLM_TIMEOUT_CLAMP_MAX_MS}],` +
    ` env override: ${process.env.PHILONT_LLM_CALL_TIMEOUT_MS ?? 'no'})`,
);

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call exceeded ${ms}ms timeout`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Hard deadline for an entire turn. In extreme cases runToolLoop may repeatedly cycle tool_use → failure → tool_use again;
 * even with maxIterations=10, slow individual LLM calls can stretch total time to hours. This adds a hard deadline
 * for the entire turn; when reached, forcibly interrupts and emits a timeout outcome so the user can continue rather than watching a spinner.
 */
// 2026-05-07: 5 min → 10 min. Production logs show 5 min frequently hit — complex tasks
// (especially planAndExecute with 6 sub-tasks × 8 iter) + occasional LLM timeout retries +
// memory compaction + skill hotreload + tool calls (shell python large files can take 30-60s)
// accumulate to more than 5 min. 10 min gives genuine complex tasks room; simple tasks still return in seconds to tens of seconds,
// impact is minimal.
// 2026-05-24: 10 min → 20 min. Benchmark testing of bibtex / scp_crawl-type multi-page
// web scraping tasks showed the LLM tends to fetch N URLs in a single turn loop; hitting the 10-min wall directly fails the task.
// Extended to 20 min to let the LLM finish. Simple tasks are unaffected (naturally a few seconds to tens of seconds).
const TURN_HARD_DEADLINE_MS = 20 * 60_000;

export class TurnDeadlineError extends Error {
  constructor(ms: number) {
    super(`turn exceeded ${ms}ms hard deadline`);
    this.name = 'TurnDeadlineError';
  }
}

/** Promise.race with timeout — note the underlying request is still running; only the main loop is unblocked. */
function withTimeout<T>(p: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    timeout,
  ]);
}

/**
 * 2026-06-07: Main-turn reasoning was previously implicit-always-on (the provider defaulted thinking on for
 * every turn). It is now made EXPLICIT so it can be tuned per channel and, importantly, so we always send a
 * concrete reasoning config — which also avoids DeepSeek's reasoning_content echo-400 trap (an absent config
 * let stale reasoning_content leak back into the request). Tunable via PHILONT_CHAT_REASONING ∈
 * {off,low,medium,high,max}; default `high` preserves the prior implicit-on quality. Cheap channels can set `off`.
 */
function mainTurnReasoning(): ReasoningConfig {
  const raw = (process.env.PHILONT_CHAT_REASONING ?? 'high').trim().toLowerCase();
  if (raw === 'off') return { enabled: false };
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') {
    return { enabled: true, effort: raw };
  }
  // Unrecognised value → fall back to the default (high).
  return { enabled: true, effort: 'high' };
}

/**
 * Wrapper around llm.send:
 *   1. Each call is wrapped with a LLM_CALL_TIMEOUT_MS hard timeout (prevents socket hang from deadlocking the entire turn).
 *   2. If the provider throws ContextTooLargeError (400/413 + "too large"), trigger
 *      full tool_result eviction + one retry (retry also wrapped with timeout).
 *
 * If retry still fails / times out, throw; the outer handleChatSend try/catch rolls back this turn and
 * feeds back to the user, preventing the session from permanently stalling.
 */
async function sendLlmWithRescue(
  messages: NativeMessage[],
  tools: ToolDefinition[],
  sessionId: string,
  /**
   * 2026-05-19 three-stream separation: sendLlmWithRescue only produces Tier 4 system events (timeout retry /
   * context eviction), not Tier 1 results. Fourth parameter changed from onDelta to optional onTrace.
   */
  onTrace?: TraceFn,
): Promise<LLMResponse> {
  // Interrupt teeth: if this turn is stopped by the user, signal is passed to the underlying LLM HTTP to cancel the in-flight call.
  const signal = turnAbortSignal(sessionId);
  // 2026-06-07: send an explicit per-turn reasoning config (see mainTurnReasoning) instead of relying on the
  // provider's implicit always-on thinking; tunable via PHILONT_CHAT_REASONING.
  const reasoning = mainTurnReasoning();
  const call = () =>
    withTimeout(llm.send(messages, tools, { signal, reasoning }), LLM_CALL_TIMEOUT_MS, () => new LlmTimeoutError(LLM_CALL_TIMEOUT_MS));
  try {
    return await call();
  } catch (e) {
    // User mid-turn stop cancelled the in-flight LLM call → propagate directly; do not record noisy api_error audit.
    // handleChatSend catch will map it to interrupted outcome.
    if (isAbortError(e)) throw e;
    if (e instanceof LlmTimeoutError) {
      // Real scenario: Anthropic stream occasionally returns only after waiting tens of seconds for the first token.
      // After the first 60s timeout fires, retry once directly — the dangling old request is GC'd by the SDK;
      // the new request returns in a second or two in most cases. Only when both timeout does it propagate to the outer layer.
      console.warn(`[llm] timeout session=${sessionId} after ${LLM_CALL_TIMEOUT_MS}ms — retrying once`);
      onTrace?.({
        kind: 'system-event',
        tier: 4,
        text: `LLM call timed out (${LLM_CALL_TIMEOUT_MS / 1000}s), retrying`,
      });
      try {
        const r = await call();
        console.log(`[llm] timeout retry session=${sessionId} succeeded`);
        return r;
      } catch (e2) {
        if (e2 instanceof LlmTimeoutError) {
          console.warn(`[llm] timeout retry session=${sessionId} also failed after ${LLM_CALL_TIMEOUT_MS}ms — giving up`);
          internalAudit.append('task_failure_mode', {
            sessionId,
            kind: 'llm_timeout',
            ts: Date.now(),
            detail: `LLM call timed out twice (${LLM_CALL_TIMEOUT_MS}ms each)`,
          });
        }
        throw e2;
      }
    }
    if (!(e instanceof ContextTooLargeError)) {
      // Other API errors (e.g. 400 "Improperly formed request" / 5xx upstream) — also counted as task failure
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'llm_api_error',
        ts: Date.now(),
        detail: String((e as Error)?.message ?? e).slice(0, 200),
      });
      throw e;
    }
    const before = estimateTotalTokens(messages);
    console.warn(
      `[llm] ContextTooLargeError session=${sessionId} tokens≈${before}: ${e.message.slice(0, 200)} — emergency evict retry`,
    );
    onTrace?.({
      kind: 'system-event',
      tier: 4,
      text: 'Context exceeded model window; evicting old tool results and retrying (keeping last 2 tool results)',
    });
    const r = evictForEmergency(messages);
    console.log(
      `[llm] emergency evict session=${sessionId}: ${r.tokensBefore} → ${r.tokensAfter} tokens (${r.evictedCount} items, keep recent ${BUDGET.emergencyKeepRecent})`,
    );
    try {
      return await call();
    } catch (e3) {
      // Still fails after emergency eviction → record task failure (api_error type, details include ContextTooLarge context)
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'llm_api_error',
        ts: Date.now(),
        detail: `ContextTooLarge eviction retry failed: ${String((e3 as Error)?.message ?? e3).slice(0, 150)}`,
      });
      throw e3;
    }
  }
}

/**
 * Session end: batch extraction (facts) + reflection (skills) + backfill session summary
 *
 * Three independent LLM calls (failures are isolated from each other):
 *   1. extractor.extractFromSession → facts
 *   2. reflector.reflectFromSession → skills
 *   3. backfillSessionSummary       → session-summary note (if Compactor has not written one yet)
 */
export async function finalizeSession(sessionId: string): Promise<void> {
  if (!activeSessions.has(sessionId)) return;
  activeSessions.delete(sessionId);
  await runFinalize(sessionId);
  sessionSkillsRevision.delete(sessionId);
}

/**
 * Core steps of finalize (does not check activeSessions); orphan scan also reuses this path.
 */
async function runFinalize(sessionId: string): Promise<void> {
  memory.raw.endSession(sessionId);

  try {
    const result = await extractor.extractFromSession(sessionId);
    console.log(
      `[memory] session=${sessionId} fact extraction: ${result.factsStored} facts, ${result.notesStored} notes`,
    );
  } catch (e) {
    console.error(`[memory] fact extraction failed session=${sessionId}:`, e);
  }

  try {
    const result = await reflector.reflectFromSession(sessionId);
    console.log(
      `[memory] session=${sessionId} skill reflection: ${result.skillsCreated} created, ${result.skillsUpdated} updated`,
    );
  } catch (e) {
    console.error(`[memory] skill reflection failed session=${sessionId}:`, e);
  }

  // v7: pursuit proposal (shadow state) — independent LLM pass; failure does not affect other steps
  try {
    const result = await pursuitExtractor.extractFromSession(sessionId);
    if (result.pursuitsProposed > 0) {
      console.log(
        `[pursuit] session=${sessionId} created shadow pursuit: ${result.pursuitsProposed}`,
      );
    }
  } catch (e) {
    console.error(`[pursuit] proposal failed session=${sessionId}:`, e);
  }

  // v7: drive reflection — scans unscored outcomes to backfill utility + adjusts drive_config parameters.
  // No LLM involved; purely heuristic + EWMA, so it can run after any session ends.
  try {
    const result = await driveReflector.reflect();
    if (result.outcomesScored > 0 || result.driveParamsTuned > 0) {
      console.log(
        `[drive-reflect] scored=${result.outcomesScored}, ewma_updated=${result.driveEwmaUpdated}, tuned=${result.driveParamsTuned}, skipped_oob=${result.tuneSkippedOutOfBounds}`,
      );
    }
  } catch (e) {
    console.error(`[drive-reflect] reflection failed:`, e);
  }

  // K3: self-description reflection — synthesizes skills/pursuits to produce a first-person self-description with sourceRefs,
  // writes to memory_facts['self.*']. Next session's buildMemoryPrefix will inject it into the LLM.
  try {
    const result = await selfReflector.reflect();
    if (result.updated) {
      console.log(
        `[self-reflect] session=${sessionId} summary updated (sourceIntegrity=${result.sourceIntegrity.toFixed(2)}, strengths=${result.strengths.length}, edges=${result.growthEdges.length})`,
      );
    }
  } catch (e) {
    console.error(`[self-reflect] self-reflection failed session=${sessionId}:`, e);
  }

  try {
    await backfillSessionSummary(sessionId);
  } catch (e) {
    console.error(`[memory] session summary backfill failed session=${sessionId}:`, e);
  }
}

/**
 * If this session has no session-summary note yet (meaning Compactor has not compacted it),
 * run a short LLM call to generate one, for the next session to pick up.
 * Sessions already written by Compactor are no-op here (getNoteById hits).
 */
async function backfillSessionSummary(sessionId: string): Promise<void> {
  const existing = memory.notes.getNoteById(`session-summary-${sessionId}`);
  if (existing) return;

  const messages = memory.raw.getMessages(sessionId);
  if (messages.length < 2) return;

  const dialogue = messages
    .map((m) => {
      const content =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}] ${content}`;
    })
    .join('\n');

  const prompt =
    'Below is a completed conversation. Summarize it in 3-5 sentences: the main task, what was completed, any open items or threads to continue next time.\n' +
    'Output narrative prose — no markdown headings or lists. If there are unanswered user questions or promised deliverables, name them explicitly.\n\n' +
    dialogue +
    '\n\nSummary:';

  const resp = await extractorLlm.complete(prompt);
  const summary = resp.text.trim();
  if (!summary) return;

  const note = memory.notes.upsertNote(`session-summary-${sessionId}`, {
    content: summary,
    importance: 1.0,
    sessionId,
  });
  internalAudit.append('self_domain_write', {
    source: 'finalize_session',
    origin: 'Internal',
    toolName: 'store_note',
    sessionId,
    noteId: note.id,
  });
}

/**
 * Orphan session cleanup: when the server restarts / crashes / WebSocket closes abnormally, the session's
 * ended_at is not written and extractor/reflector have not run. On a new WebSocket connection,
 * scan the most recent sessions with ended_at IS NULL that "appear dead" and finalize them.
 *
 * Strategy:
 *   - Finalize the most recent 1 orphan synchronously so its summary can enter the current buildMemoryPrefix
 *   - Finalize the rest asynchronously in the background to avoid blocking the first message response
 */
const ORPHAN_IDLE_MS = 30 * 60 * 1000;

async function scanOrphanSessions(): Promise<void> {
  const candidates = memory.raw
    .listSessions({ limit: 5 })
    .filter((s) =>
      s.endedAt === null &&
      !activeSessions.has(s.id) &&
      // K0: the GLOBAL timeline is never treated as an orphan for extraction — its "full message set" is
      // the agent's entire lifetime; batch-finalizing it once drains all history, overloading the LLM and cost.
      // Instead it is advanced by idle_consolidator (K0.6) with a time window.
      s.id !== GLOBAL_TIMELINE_SESSION_ID,
    );
  if (candidates.length === 0) return;

  const now = Date.now();
  const stale: string[] = [];
  for (const s of candidates) {
    const msgs = memory.raw.getMessages(s.id);
    if (msgs.length === 0) continue;
    let lastTs = 0;
    for (const m of msgs) if (m.timestamp > lastTs) lastTs = m.timestamp;
    if (now - lastTs < ORPHAN_IDLE_MS) continue;
    stale.push(s.id);
  }
  if (stale.length === 0) return;

  const [first, ...rest] = stale;
  try {
    await runFinalize(first);
    console.log(`[memory] orphan finalized (blocking): ${first}`);
  } catch (e) {
    console.error(`[memory] orphan finalize failed ${first}:`, e);
  }

  for (const id of rest) {
    runFinalize(id)
      .then(() => console.log(`[memory] orphan finalized (background): ${id}`))
      .catch((e) => console.error(`[memory] orphan finalize failed ${id}:`, e));
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────────

/**
 * K0: reconstruct working context before each LLM call.
 * Do not cache the messages array across turns — that is a websocket connection artifact that
 * slices the agent's "self" into protocol fragments. Each turn recalls fragments from the raw global timeline and assembles systemPrompt + memoryPrefix.
 */
function buildFreshMessages(
  userMessageForRecall: string,
  sessionId: string,
  signalBus?: TurnSignalBus,
): NativeMessage[] {
  const memoryPrefix = buildMemoryPrefix(signalBus);
  // 2026-05-09: autonomous turns (system:scheduled:*) only look at their own sessionId's
  // history. K0 timeline is global by default, but cross-session recall pulls other sessions'
  // (e.g. wechat) conversations into messages, misused by short_answer_binding / LLM reasoning
  // (observed in production: mycox heartbeat killed itself — the agent treated wechat's previous
  // turn "I'll switch for you" as the current turn's intent, and the first tool was cancel_schedule).
  // See plan misty-juggling-mist.md for details.
  const isAutonomous = sessionId.startsWith('system:scheduled:');
  const restrictToSessionIds = isAutonomous ? [sessionId] : undefined;

  const tz = process.env.AGENT_TIMEZONE || 'UTC';
  const nowIso = new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
  const timeContext =
    `\nCurrent time: ${nowIso} (${tz}).` +
    ` To get real-time time, call the time tool with timezone=${tz}.`;

  // philont's charter (constitution) — injected into the identity prompt every turn so it actually
  // shapes behaviour. Source of truth is the pursuit-root constitution (frozen at load); falls back to
  // the version-controlled defaults when the live root's fields are still NULL (e.g. an older DB), so the
  // charter takes effect without a DB migration. See agent-memory/src/constitution_defaults.ts.
  const charterValues = constitution?.values ?? DEFAULT_CONSTITUTION_VALUES;
  const charterRedLines =
    constitution?.redLines && constitution.redLines.length
      ? constitution.redLines
      : DEFAULT_CONSTITUTION_RED_LINES;
  const charterBlock =
    `\n\n## Your charter — who you are and how you serve (constitution)\n${charterValues}` +
    (charterRedLines.length
      ? `\n\nRed lines — never cross these:\n${charterRedLines.map((r) => `- ${r}`).join('\n')}`
      : '');

  const init: NativeMessage[] = [
    {
      role: 'user',
      content:
        `You are philont — a persistent, self-directed AI agent, not a stateless assistant.` +
        ` You carry long-term memory across conversations and days — a timeline of what happened, plus facts, notes, and skills you have learned —` +
        ` and you act on your own initiative: pursuing research and deep exploration over many turns, and resuming unfinished work even days later.` +
        ` What sets you apart is that you learn from your own work, especially your failures, distilling reusable skills and rules so you don't repeat mistakes.` +
        ` That learning depends on honesty: never claim success you didn't achieve, and never fabricate a result — an honest failure teaches you, a pretended one corrupts your memory.` +
        ` You stay with one user across channels (WeChat, Telegram, web) and act through a broad, permission-gated toolset` +
        ` — files, shell, web, persistent memory, skills, vision, and mounted MCP servers. Working directory: ${process.cwd()}.` +
        charterBlock +
        `\n\nTool-use principles:` +
        `\n- Do not call tools for ordinary chit-chat. (Exception: persisting a durable fact the user just revealed is never "chit-chat" — store_fact it even mid-conversation; see the proactive-memory principle below.)` +
        `\n- When the user asks you to "remember / note down / set" any fact (name, preference, role, project info, etc.),` +
        ` you MUST immediately call store_fact to persist it. Put things about the user under namespace=user, project-related under project, role/identity under user.role.` +
        `\n\n**Proactive-memory principle** — because you persist over time and build up an understanding of your user, call store_fact immediately (even without "remember") whenever the user reveals something durable about themselves or their work:` +
        `\n  1) **Preferences**: "I prefer X over Y / I'd rather not / I always ..."` +
        `\n     → store_fact(namespace=user, key=preferences.<topic>, value={likes:[...], dislikes:[...]})` +
        `\n     Example: "I prefer concise answers and metric units" → user.preferences.style = {likes:["concise","metric units"]}` +
        `\n     **First get_fact the existing value, merge, then store_fact to overwrite** (otherwise you lose info)` +
        `\n  2) **Constraints**: "no meetings before 10am / never force-push to main / keep this repo private"` +
        `\n     → user.constraints.<topic> (a hard rule to respect in future work — must record)` +
        `\n  3) **Attributes/identity**: "I'm in Beijing / I'm a backend engineer / my timezone is UTC+8"` +
        `\n     → user.location / user.role / user.timezone` +
        `\n  4) **Plans/events**: "shipping the release next Tuesday" / "reviewing the draft tonight"` +
        `\n     → fact_kind=event, occurred_at as ISO8601 absolute time` +
        `\n  5) **Negative preferences and constraints matter most**: when the user rejects or rules something out, almost always record it — ignoring it later breaks trust.` +
        `\n- When the user asks "who am I / do you remember", first list_facts or get_fact, then answer.` +
        `\n- Before giving advice or recommendations, list_facts(user) to honor the user's recorded preferences/constraints and avoid suggesting something they ruled out.` +
        `\n- Use webSearch when you need to search the web or get up-to-date info; use webFetch to read a specific page.` +
        `\n- Saying "ok, got it" without calling the tool = not remembered. You must go through the tool.` +
        `\n- Reminders schedule_reminder: when the user says "every X minutes / every X / daily" you MUST pass interval_ms (milliseconds),` +
        ` not at; use at only for "after X / at a specific time". Same-named tasks auto-replace, so don't worry about duplicates.` +
        `\n- To cancel a reminder you MUST use cancel_schedule (pass name for fuzzy match);` +
        ` never use schedule_reminder to "cancel" — that only creates another pointless task.` +
        `\n\n**Task-start priority (strict order)**:` +
        `\n  1. **First search_skills + use_skill** — for any task, check for an existing skill first.` +
        ` Bundled skills (service-onboarding / skill-creator / clawhub / web-research / git-workflow, etc.) cover common domains.` +
        ` **If a "When to Use" matches, use_skill — don't planAndExecute around the skill.**` +
        `\n  2. **Simple tasks: call the tool directly** — single-step or ≤3-step clear flows: readFile / writeFile / shell / http / get_fact, etc.` +
        `\n  3. **Complex multi-step with no existing skill** → use \`planAndExecute({task: "..."})\` to auto-plan + dispatch.` +
        `\n` +
        `\n**Counter-example (hit in production)**: the user says "register per the <service> guide" (any external-service doc) → calling planAndExecute to break it into 5 steps bypasses the \`service-onboarding\` skill,` +
        ` and you miss step 5 (create the heartbeat schedule). **Correct**: use_skill('service-onboarding'), which teaches all 6 steps including the heartbeat.` +
        ` **Generic process docs** (SOP / runbook / API manual, no-credential + periodic-heartbeat) similarly should be turned into a reusable skill via use_skill('doc-to-skill') rather than run from memory.` +
        `\n` +
        `\n**When to use planAndExecute**:` +
        `\n  - **When**: the task needs ≥5 tool steps and no skill matches. E.g.:` +
        ` cross-file refactors, read→write→verify chains, bulk source conversion, research reports.` +
        `\n  - **Mechanism**: it first uses an LLM to break the task into sub-tasks, then runs an isolated sub-loop per sub-task;` +
        ` **from the parent turn's view it completes in 1 iter**, so it won't hit the main loop cap (default 20).` +
        `\n  - **When not**: a skill matches / single-step / tasks needing mid-way user input / clearly ≤3-step small tasks.` +
        `\n\n**Reply-format contract (applies to all channels)**: your final text reply MUST use this two-section markdown:\n` +
        `\n## For User\n` +
        `<content for the user-facing client. WeChat and similar terminals push **only** this section — anything outside it is NEVER delivered. Default concise (≤ ~200 chars, conclusion + necessary progress). **BUT when the user asked for an analysis / report / detailed answer, this section must carry the COMPLETE deliverable** — never a one-line conclusion with the substance left in Work Log (the user cannot see it; they will rightly complain the analysis is missing).>\n` +
        `\n## Work Log\n` +
        `<full reasoning / table restatement / tool-result dump / self-check. Goes **only** to the timeline, not pushed to the user. May be detailed.>\n` +
        `\nThe two-section format applies only to the **final natural-language reply**; during tool-calling, emit tool_use as usual without these headings.\n` +
        `If there is no work to log, the "## Work Log" section may just say "none". But the "## For User" section MUST have content,` +
        ` otherwise the fallback mechanism may take the last section and accidentally expose it to the user.` +
        // i18n: prompt language (English) is decoupled from reply language — the user-facing "## For User"
        // section follows the channel/user language (WeChat → Chinese). See response_language.ts (and docs/i18n/glossary.md for terminology).
        buildLanguageDirective(resolveResponseLanguage({ channel: sessionId })) +
        timeContext +
        memoryPrefix,
    },
    { role: 'assistant', content: 'Understood. I\'ll use the two-section format: ## For User + ## Work Log. The For-User section stays concise (≤ ~200 characters), conclusions and key progress only; the Work-Log section keeps full reasoning and tool-result detail, not sent to the user. I\'ll follow the store_fact / list_facts memory principles too.' },
  ];

  // Timeline recall: user turns use the global continuous history; autonomous turns strictly limit to this session
  const recalled = timelineRetriever.retrieve({
    recentBudgetTokens: TIMELINE_RECENT_BUDGET,
    recallBudgetTokens: TIMELINE_RECALL_BUDGET,
    recallQuery: userMessageForRecall,
    restrictToSessionIds,
  });
  for (const m of recalled.messages) {
    init.push({ role: m.role, content: m.content });
  }
  console.log(
    `[timeline] retrieved ${recalled.recencyCount} recent + ${recalled.recallCount} recall msgs (~${recalled.totalTokens} tokens${
      isAutonomous ? `, scoped to ${sessionId}` : ''
    })`,
  );

  return init;
}

/**
 * Tool authorization request structure (2026-05-19 WeChat-side UX refactor):
 *   - chat-handler no longer formats a human-readable string; instead passes a struct to the channel
 *   - the channel decides how to render it (WeChat uses formatToolForAuth to expand parameter details;
 *     web-ui keeps backward compatibility with the existing string text UX)
 *   - clarification non-empty = "previous response was not understood, ask again" (original line 3887 path)
 */
export type AuthRequest = {
  toolName: string;
  capability: string;
  domain: string;
  input: unknown;
  clarification?: string;
};

/**
 * Tier 3/4 detail events (2026-05-19 three-stream separation architecture).
 *
 * Three-stream separation: onDelta=Tier1 result / onStatus=Tier2 progress / onTrace=Tier3 detail + Tier4 internal.
 * onTrace is consumed only by debug / observability panels (web-ui debug panel). Channels may not implement
 * onTrace at all (WeChat does not) — does not affect the main flow; `onTrace?.(...)` optional chaining is zero-cost.
 */
export interface ChannelTraceEvent {
  /** Event category. Determines the icon / grouping in the frontend collapsible panel. */
  kind:
    | 'tool-invocation'   // pre-invocation tool detail (Tier 3)
    | 'tool-result'       // tool result detail (Tier 3)
    | 'internal-gate'     // internal-drive gate fired: Honesty/EmptyConclusion/... (Tier 4)
    | 'system-event'      // system event: LLM timeout / context window exceeded / fallback degradation (Tier 4)
    | 'auth-decision'     // authorization result: granted / denied (Tier 4)
    | 'loop-control';     // turn control: iter-warning / plan degradation / same-root-cause (Tier 4)
  /** Human-readable single-line text. Final display form; rendered directly by the frontend. */
  text: string;
  /** Tier marker. 3 = detail, 4 = internal (frontend may render darker). */
  tier: 3 | 4;
  /** Structured extra info; frontend may optionally use for chip / tooltip. All fields optional. */
  meta?: {
    toolName?: string;
    success?: boolean;
    gateName?: string;
    severity?: string;
    iteration?: number;
  };
}

/** onTrace callback type. Optional — if the channel does not pass it, no trace overhead is incurred. */
export type TraceFn = (ev: ChannelTraceEvent) => void;

export async function handleChatSend(
  sessionId: string,
  userMessage: string,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequest) => void,
  /**
   * 2026-05-07 addition: intermediate progress status push (optional). Unlike onDelta —
   * onDelta is the LLM's final reply token stream (channels typically buffer until turn end),
   * onStatus is an instantaneous "what the agent is doing right now" event (should be pushed
   * immediately to reduce user wait anxiety).
   *
   * After 2026-05-19 three-stream separation: onStatus content is unified as semantic progress
   * phrases ("searching the web…"); no longer contains tool names / internal counts.
   *
   * Channel implementations include their own throttling logic (same tool not re-pushed within
   * 5s on the same channel, etc.). Not provided = no intermediate status pushed (backward-compatible).
   */
  onStatus?: (text: string) => void,
  /**
   * 2026-05-19 three-stream separation addition: Tier 3/4 detail events (optional).
   * Tool invocation/result details + internal-drive gate / system events / auth ack / turn degradation markers.
   * Not passed for WeChat (naturally shielded); passed for web-ui → debug panel.
   */
  onTrace?: TraceFn,
) {
  // ALS wraps the entire turn body — lets channel-aware tools (e.g. replyWithMedia)
  // retrieve the current sid from currentSessionId(); the registry routes to the corresponding
  // channel's peer based on that sid. All existing handleChatSendInner / runToolLoop paths
  // run inside this scope, so sid does not need to be passed individually.
  return runInTurnContext(sessionId, async () => {
  const audit = new AuditLog();

  // First time seeing this ws sid → run orphan scan + register active session for finalize tracking
  if (!activeSessions.has(sessionId)) {
    await scanOrphanSessions();
    activeSessions.add(sessionId);
    sessionSkillsRevision.set(sessionId, skillsRevision);
  }
  const grants = globalGrants;

  // 2026-05-06 D.2: turn-local signal container created in the outer layer; the drain path
  // inside buildFreshMessages / buildMemoryPrefix writes interruptDrainedCount into it,
  // and the inner honesty / K7-bridge paths also write to it. Inner finally block consumes all at once.
  const signalBus: TurnSignalBus = {};

  // v19 (2026-05-13): plan_close close-time strict validation needs to read the current turn's
  // signalBus (honesty fired? sameRootCause?) at the instant the LLM calls the plan_close tool.
  // createPlanTools is one-time at module load and cannot capture a per-turn bus — use a
  // session→bus map + currentSessionId() to look it up on demand inside tool execute.
  activeSignalBuses.set(sessionId, signalBus);

  // Interrupt teeth: one new AbortController per turn. ws `chat.stop` fires abortActiveTurn
  // to trigger it, canceling in-flight LLM calls + letting runToolLoop stop early at a boundary. Deleted in finally.
  activeTurnAborters.set(sessionId, new AbortController());

  // K0: rebuild messages fresh each turn — prefer the inflight saved in pending-auth /
  // pending-question state (those carry tool_use that must have matching tool_result to resume),
  // otherwise recall from the global timeline.
  const pending = pendingAuth.get(sessionId);
  const pendingQ = pendingQuestion.get(sessionId);

  // 2026-05-12 Phase 7 hardened 1: automatic task mode classifier.
  // Evaluated before buildFreshMessages so that the "task mode self-assessment" section
  // inside buildMemoryPrefix sees the correct mode (slow → renders "plan not yet created, call plan_draft now").
  //
  // Skip conditions:
  //   - pending / pendingQ: mid-turn resume, not a new task entry point
  //   - already slow: do not re-classify (keep what the LLM explicitly set)
  //   - PHILONT_AUTO_TASK_MODE=0: disabled by env
  //
  // Misclassify fast→slow = soft cost (turn runs longer); misclassify slow→fast = impossible (one-directional).
  if (
    process.env.PHILONT_AUTO_TASK_MODE !== '0' &&
    !pending &&
    !pendingQ &&
    taskModeStore.get(sessionId) === 'fast' &&
    !classifierSkipPatterns.some((p) => sessionId.startsWith(p))  // Phase 8 M2: DB can add skip patterns
  ) {
    const sig = quickTaskSignatureHash(userMessage);
    const cls = autoClassifyTaskMode({
      userMessage,
      taskSignatureCandidate: sig,
      plans: memory.plans,
    });
    if (cls.isSlow) {
      taskModeStore.set(
        sessionId,
        'slow',
        `auto:heuristic:${cls.reasons.join(',')}`,
      );
      audit.append('self_domain_write', {
        source: 'auto_task_mode',
        origin: 'Internal',
        toolName: 'task_mode_auto_slow',
        sessionId,
        reasons: cls.reasons,
        signatureCandidate: sig,
      });
      console.log(
        `[auto-task-mode] session=${sessionId} fast→slow reasons=[${cls.reasons.join(',')}]`,
      );

      // 2026-05-12 Phase 8.5: **auto-create a placeholder plan** at the same time as upgrading to slow.
      // Production (mycox) revealed: after seeing a gate reject, the LLM chose to "try a different tool"
      // instead of calling plan_draft. Fix: **the mechanism layer pre-creates the plan template** so the
      // LLM enters the turn already seeing an existing plan and can only do plan_review/revise — no bypass.
      //
      // Disabled by env PHILONT_AUTO_PLAN_ON_SLOW=0.
      // Dedup: skip when there is already an active plan (draft/reviewed/executing).
      if (process.env.PHILONT_AUTO_PLAN_ON_SLOW !== '0') {
        try {
          const existingPlans = memory.plans.listBySession(sessionId, { limit: 1 });
          const last = existingPlans[0];
          const needsNewPlan =
            !last ||
            last.status === 'completed' ||
            last.status === 'failed';
          if (needsNewPlan) {
            // Extract URL: using \S+ greedily includes trailing punctuation (",。;:'""<>()`)
            // causing a mismatch with the URL actually requested by webFetch → fetched-store findByUrl fails.
            // Fix: disallow these common punctuation characters inside the URL.
            const guideUrlRaw = userMessage.match(/https?:\/\/[^\s,;:'"<>()`，。；：、]+/)?.[0];
            // Strip trailing period once more (a URL at end of sentence may have a trailing "." causing visual confusion)
            const guideUrl = guideUrlRaw?.replace(/[.,;:!?]+$/, '') || guideUrlRaw;
            const taskSig = `auto-slow-${sig}`;
            // Phase 13.5 (2026-05-17): classifier infers project name → pre-fills persistedTo,
            // so plan.md starts even when the LLM does not proactively pass persist:true —
            // mechanism layer as fallback. Only triggered by heavy-keyword strong project intent, reducing false positives.
            //
            // Phase 14 (2026-05-18): for scheduled sessions (user message contains no URL),
            // the placeholder now inherits schedule.project — so the placeholder created by
            // scheduled fires + Recent Runs / Lessons automatically flows back into mycox/plan.md.
            let projectHint = cls.projectHint ?? null;
            if (!projectHint) {
              const schedId = extractScheduleIdFromSession(sessionId);
              if (schedId) {
                try {
                  const sched = memory.schedules.findByName(schedId);
                  if (sched?.project) {
                    projectHint = sched.project;
                    console.log(
                      `[auto-plan-on-slow] inherit project=${projectHint} from schedule "${schedId}"`,
                    );
                  }
                } catch (e) {
                  console.warn('[auto-plan-on-slow] schedule.project lookup failed:', e);
                }
              }
            }
            const placeholder = memory.plans.create({
              sessionId,
              taskSignature: taskSig,
              guideRef: guideUrl ?? `user-msg:${userMessage.slice(0, 80)}`,
              persistedTo: projectHint,
              // M3 / Phase 11 (2026-05-15): placeholder plan marked isPlaceholder=true.
              // M4 spec-coverage check R1 skips the deliverables ≥ 1 enforcement (allows empty).
              // The LLM must provide new_deliverables via plan_revise to convert it before a success close.
              isPlaceholder: true,
              // Generic protocol skeleton (2026-05-12 correction): do NOT hardcode any domain-specific actions
              // (mycox / SOUL / heartbeat / posting / register / heartbeat etc. are domain knowledge
              // that the LLM must identify from the user message + referenced documents).
              // This only describes the **protocol contract**: understand → find existing → decompose → execute → close.
              steps: [
                {
                  id: 'understand',
                  description:
                    'deliverables = actions **literally** mentioned in the user message. ' +
                    'guides / reference documents are **reference manuals** for later steps, not deliverable sources — a document saying "how to X" does not mean you must do X. ' +
                    'Execution order = literal order in the user message (follow explicit ordering keywords like "then" / "and then" / "next").' +
                    '\n\n**Phase 16: operational-handoff is mandatory** (if the task involves persistent behavior):' +
                    '\nIf the task / guide contains keywords like `schedule_reminder` / `periodic` / `routine` / `heartbeat` / `check-in`:' +
                    '\n→ deliverables **must** include an `operational-handoff` entry:' +
                    '\n   "**After the first successful call to each business endpoint**, immediately call `plan_knowledge(project, entry, section)` to write each endpoint\'s ' +
                    'method + path + headers + auth scheme into plan.md Operational Knowledge"' +
                    '\n→ **Reason**: scheduled fires are fresh sessions (no onboarding-turn context); they can only find the correct endpoint+auth from the plan.md cookbook. Without this entry, subsequent fires will hit 401 loops.' +
                    '\n→ The mechanism layer\'s plan_close will verify this section is non-empty; missing it will reject a success close.',
                },
                {
                  id: 'find-existing',
                  description:
                    'Call search_skills to find reusable existing solutions; if a match is found and when_to_use matches → use_skill to follow the template; ' +
                    'if no match or not applicable → continue to the next steps.',
                },
                {
                  id: 'decompose',
                  description:
                    'Call plan_revise to replace this placeholder plan with a task-specific plan (pass new_deliverables + new_steps + reason). ' +
                    'Requirements: each deliverable is a concrete output of a **literal action from the user message**; each step.covers links to a deliverable; ' +
                    'things inferred from a guide ("should also do X") **do not count as deliverables** (those are the manual, not the task).',
                },
                {
                  id: 'execute',
                  description:
                    'Execute the revised plan step by step: each step starts with plan_update_step(doing) (plan automatically becomes executing), ' +
                    'and is completed with plan_update_step(done, evidence). If the same root cause fails ≥ 2 times → call plan_revise to change approach.',
                },
                {
                  id: 'close-with-persistence',
                  description:
                    'When all steps are done → call plan_close(outcome, summary, deliverable_status). ' +
                    '**Critical**: before closing, if the task requires **any persistent behavior** (periodic execution / monitoring / check-in etc.), ' +
                    'you must call schedule_reminder to set the appropriate cadence (otherwise the task is left half-done). ' +
                    'Close a failed task with plan_close(failure); this distills a failure-mode playbook for future similar tasks.',
                },
              ],
            });
            audit.append('self_domain_write', {
              source: 'auto_plan_on_slow',
              origin: 'Internal',
              toolName: 'auto_plan_created_on_slow',
              sessionId,
              planId: placeholder.id,
              taskSignature: taskSig,
              guideUrl: guideUrl ?? null,
              stepCount: placeholder.steps.length,
              projectHint: projectHint ?? null,
            });
            console.log(
              `[auto-plan-on-slow] session=${sessionId} created placeholder plan ${placeholder.id} (${placeholder.steps.length} steps, guideUrl=${guideUrl ?? 'none'}, project=${projectHint ?? 'none'})`,
            );
            // Phase 13.5: projectHint matched → mechanism layer loadOrCreate plan.md;
            // the LLM no longer needs to pass persist:true; plan_revise/update/close hooks
            // check that persistedTo is non-empty and append accordingly.
            if (projectHint) {
              try {
                memory.planFiles.loadOrCreate(projectHint, {
                  goal: `(auto-derived from guide URL) ${userMessage.slice(0, 160)}`,
                });
                console.log(
                  `[plan-files] auto-loadOrCreate project=${projectHint} (heavy-keyword + URL-path heuristic)`,
                );
              } catch (e) {
                console.error('[plan-files] auto-loadOrCreate failed (ignored):', e);
              }
            }
          }
        } catch (e) {
          console.error('[auto-plan-on-slow] failed (ignored):', e);
        }
      }
    }
  }

  const messages: NativeMessage[] = pending
    ? [...pending.inflightMessages]
    : pendingQ
    ? [...pendingQ.inflightMessages]
    : buildFreshMessages(userMessage, sessionId, signalBus);

  // Phase 11 (2026-05-14): per-turn messages reference for plan_review tool to check
  // "most recent assistant text" when detecting the self-review section.
  activeSessionMessages.set(sessionId, messages);

  // Layer 0 global timeline appends user message (placed in outer to ensure pending paths are also persisted)
  memory.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'user',
    content: userMessage,
  });

  // Helpful for locating turn boundaries during testing: start log includes user message preview + whether it resumes pending
  const turnStartedAt = Date.now();
  const userPreview = userMessage.length > 80 ? userMessage.slice(0, 80) + '…' : userMessage;
  console.log(
    `[turn] session=${sessionId} start ${pending ? '(resume pending auth)' : '(fresh)'} user="${userPreview.replace(/\n/g, ' ')}"`,
  );

  try {
    const result = await withTimeout(
      handleChatSendInner(
        sessionId, userMessage, audit, messages, grants, onDelta, onAuthRequest,
        signalBus, onStatus, onTrace,
      ),
      TURN_HARD_DEADLINE_MS,
      () => new TurnDeadlineError(TURN_HARD_DEADLINE_MS),
    );
    const dur = Date.now() - turnStartedAt;
    const textPreview = (result.outcome as any).text
      ? `text="${String((result.outcome as any).text).slice(0, 80).replace(/\n/g, ' ')}…"`
      : '';
    // 2026-05-27: add tool summary on turn done, replacing the wall of tool call logs (original [tool] log lines remain;
    // this gives ops an at-a-glance view of "what was called in this turn overall").
    const toolSummary = summarizeTurnTools(signalBus.inTurnRecords ?? []);
    console.log(
      `[turn] session=${sessionId} done outcome=${result.outcome.outcomeType} durationMs=${dur} auditEvents=${result.auditEvents} ${toolSummary} ${textPreview}`,
    );

    // Phase 12 cont (2026-05-17): scheduled sessions automatically capture the current turn outcome to
    // ScheduleOutcomeStore. On the next fire of the same schedule, buildMemoryPrefix reads the most recent
    // N entries and injects them at the top — a mechanism-layer "lesson accumulation" channel that does not depend on the reflection distillation chain.
    // Failures do not affect the main flow.
    //
    // Phase 14: scheduled success signal is also computed here — using the summary result. Passed downstream
    // to trigger the reflection plan_knowledge distillation path.
    let scheduledSuccessTurn = false;
    try {
      const scheduleId = extractScheduleIdFromSession(sessionId);
      if (scheduleId) {
        const records = signalBus.inTurnRecords ?? [];
        const traces: ToolCallTrace[] = records.map((r) => {
          const trace: ToolCallTrace = {
            toolName: r.toolName,
            success: r.success,
          };
          if (r.toolName === 'http') {
            const input = r.toolInput ?? {};
            const method = String((input as Record<string, unknown>).method ?? 'GET');
            const url =
              typeof (input as Record<string, unknown>).url === 'string'
                ? ((input as Record<string, unknown>).url as string)
                : undefined;
            trace.httpMethod = method;
            trace.httpUrl = url;
            // http tool error format: "HTTP <STATUS> <METHOD> <URL>" (securedHttp.ts)
            if (!r.success && r.resultText) {
              const m = r.resultText.match(/HTTP (\d+)/);
              if (m) trace.httpStatus = parseInt(m[1], 10);
              const sig = extractFailureSignature('http', r.resultText);
              if (sig) trace.errorSignature = sig;
            } else if (r.success) {
              trace.httpStatus = 200; // successful http defaults to 200 (exact status not parsed; sufficient for aggregation)
            }
          }
          return trace;
        });
        const summary = summarizeTurnTrace(traces);
        memory.scheduleOutcomes.record({
          scheduleId,
          firedAt: turnStartedAt,
          durationMs: dur,
          outcome: summary.outcome,
          httpOkCount: summary.httpOkCount,
          httpFailCount: summary.httpFailCount,
          httpStatusCounts: summary.httpStatusCounts,
          failureSignatures: summary.failureSignatures,
          textSummary: summary.textSummary,
        });
        // Phase 14: scheduled session has ≥ 1 successful http + outcome is not fail → trigger
        // plan_knowledge distillation path (reflection prompt guides LLM to extract endpoints from ✓ TOOL OK)
        scheduledSuccessTurn =
          (summary.outcome === 'ok' || summary.outcome === 'partial') &&
          summary.httpOkCount >= 1;
        console.log(
          `[schedule-outcomes] session=${sessionId} scheduleId=${scheduleId} ` +
            `outcome=${summary.outcome} httpOk=${summary.httpOkCount} ` +
            `httpFail=${summary.httpFailCount} sigs=[${summary.failureSignatures.join(',')}]`,
        );
      }
    } catch (e) {
      console.warn(
        `[schedule-outcomes] capture failed (ignored):`,
        (e as Error)?.message ?? e,
      );
    }

    // Reflection trigger (fire-and-forget): evaluated only when the turn reaches a natural end (response / question_pending);
    // not evaluated for interrupted states like auth_pending / question_timeout. Failures never affect the main flow.
    const outcomeType = result.outcome.outcomeType;
    if (outcomeType === 'response') {
      // 2026-05-06 sameRootCauseFailures integration: scans up to 30 failed tool calls within the last 24h,
      // clusters by (toolName + errorClass) signature, and takes the count of the largest same-signature group.
      // This is a cross-turn signal (memory_actions global timeline) implementing "repeated same-wall collision"
      // detection — e.g. shell `command not found: rg` across 5 different turns = signal=5;
      // triggers reflection to have the LLM write a "rg unavailable → switch to grep" routing rule.
      let sameRootCauseFailures = 0;
      try {
        const sinceTs = Date.now() - 24 * 60 * 60_000;
        const recent = memory.actions.listRecentFailures({ sinceTs, limit: 30 });
        sameRootCauseFailures = countSameRootCauseFailures(recent);
      } catch (e) {
        console.warn('[reflection] sameRootCauseFailures computation failed, ignored', e);
      }

      // 2026-05-11 Phase 3: routing rule outcome backflow.
      // If routing inject hit a rule at the start of this turn (signalBus.activeRuleIds), determine the outcome
      // based on strong turn-close signals and feed back to the routing_rules state machine.
      //
      // Determination principle: **prefer false negatives over false positives** — only strong failure signals
      // mark failure; others default to success.
      //   Strong failure signals:
      //     - HonestyGate fired (honesty issue)
      //     - sameRootCauseFailures >= 2 (repeated same-root-cause failures)
      //     - InterruptDrained (K7 signal drained ≥ 1 entry)
      //     - emptyConclusionFired (empty conclusion regen)
      //
      // If any strong failure signal triggered → mark all activeRuleIds as failure (this turn took a wrong path)
      // Otherwise → mark all as success (turn closed normally; rule recommendation was effective)
      //
      // This is the key step from routing_rules.recordRuleOutcome having 0 callers to a true closed loop:
      // without outcome backflow, the 5-tier confidence state machine is dead data.
      if (signalBus.activeRuleIds && signalBus.activeRuleIds.length > 0) {
        const strongFailure =
          signalBus.honesty !== undefined ||
          sameRootCauseFailures >= 2 ||
          (signalBus.interruptDrainedCount ?? 0) > 0 ||
          signalBus.emptyConclusionFired === true;
        const outcome = !strongFailure;
        for (const ruleId of signalBus.activeRuleIds) {
          try {
            memory.routingRules.recordRuleOutcome(ruleId, outcome);
          } catch (e) {
            console.warn(
              `[routing-outcome] recordRuleOutcome(${ruleId}, ${outcome}) failed, ignored:`,
              (e as Error)?.message,
            );
          }
        }
        internalAudit.append('self_domain_write', {
          source: 'routing_outcome',
          origin: 'Internal',
          toolName: outcome ? 'routing_rule_success' : 'routing_rule_failure',
          sessionId,
          ruleIds: signalBus.activeRuleIds,
          honestyFired: signalBus.honesty !== undefined,
          sameRootCauseFailures,
          interruptDrained: (signalBus.interruptDrainedCount ?? 0) > 0,
          emptyConclusionFired: signalBus.emptyConclusionFired === true,
        });
        console.log(
          `[routing-outcome] session=${sessionId} ruleIds=[${signalBus.activeRuleIds.join(',')}] outcome=${outcome ? 'success' : 'failure'}`,
        );
      }

      // 2026-05-15: turnDegraded signal synthesis — if any mechanism-layer "forced wrap-up" signal fires,
      // reflection takes the negative distillation path and rejects new_skill / skill_refine.
      const turnDegraded =
        signalBus.planCircuitBroken === true
        || signalBus.inTurnToolBlockFired === true
        || signalBus.planAutoClosedFailure === true;

      void maybeRunReflection({
        sessionId,
        messages,
        userMessage,
        skills: memory.skills,
        routingRules: memory.routingRules,
        plans: memory.plans,
        planFiles: memory.planFiles,
        appendAudit: (eventType, payload) => internalAudit.append(eventType, payload),
        // D.2 (2026-05-06): all 4/4 trigger inputs connected
        // Phase 14 (2026-05-18): scheduledSuccess connects to the plan_knowledge distillation path
        signals: {
          honestyFired: signalBus.honesty !== undefined,
          interruptDrained: (signalBus.interruptDrainedCount ?? 0) > 0,
          turnStartTs: turnStartedAt,
          sameRootCauseFailures,
          turnDegraded,
          scheduledSuccess: scheduledSuccessTurn,
        },
      });
    }

    return result;
  } catch (e) {
    // K0: messages are fresh each turn; no rollback needed. Still must clear pendingAuth/
    // pendingQuestion, otherwise the next message will erroneously enter the grant/deny or question branch.
    pendingAuth.delete(sessionId);
    pendingQuestion.delete(sessionId);
    const dur = Date.now() - turnStartedAt;
    // Interrupt teeth: user mid-turn stop cancelled the in-flight LLM call → clean exit as interrupted,
    // not an error. The runToolLoop boundary-check path already returns interrupted directly and does not reach here;
    // this path specifically handles "abort hitting in-flight LLM HTTP and throwing AbortError".
    if (isAbortError(e)) {
      console.log(`[turn] session=${sessionId} stopped by user durationMs=${dur}`);
      return {
        outcome: { outcomeType: 'interrupted', reason: 'user_stop', text: 'Stopped' },
        auditEvents: audit.length,
      };
    }
    if (e instanceof TurnDeadlineError) {
      console.warn(`[turn] session=${sessionId} hit ${TURN_HARD_DEADLINE_MS}ms deadline durationMs=${dur}`);
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'turn_deadline',
        ts: Date.now(),
        detail: `turn 跑了 ${dur}ms 撞 ${TURN_HARD_DEADLINE_MS}ms 硬上限`,
      });
    } else {
      console.error(`[turn] session=${sessionId} failed durationMs=${dur}:`, (e as any)?.message ?? e);
      // Generic exception fallback audit (cases already emitted inside sendLlmWithRescue as llm_timeout / llm_api_error
      // will not reach here again; but K7-bridge failures / question flow exceptions etc. will fall here)
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'turn_error',
        ts: Date.now(),
        detail: String((e as Error)?.message ?? e).slice(0, 200),
      });
    }
    throw e;
  } finally {
    // v19 (2026-05-13): clean up the session mapping used for close-time signal queries to prevent memory leaks.
    activeSignalBuses.delete(sessionId);
    activeSessionMessages.delete(sessionId);
    activeTurnAborters.delete(sessionId);
  }
  }, onStatus); // end runInTurnContext (onStatus is exposed to nested tools via currentTurnStatus)
}

/**
 * Actual logic of handleChatSend; the outer layer is responsible for messages snapshot/rollback.
 */
async function handleChatSendInner(
  sessionId: string,
  userMessage: string,
  audit: AuditLog,
  messages: NativeMessage[],
  grants: GrantStore,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequest) => void,
  signalBus: TurnSignalBus,
  onStatus?: (text: string) => void,
  onTrace?: TraceFn,
) {
  // signalBus is created and passed in by outer handleChatSend. It accumulates K7 reactive signals for this turn
  // (honesty fire / interrupt drain count), used for:
  //   1. K7→K8 bridge (finally block)
  //   2. reflection trigger input (D.2)

  // Resolve the language for user-facing status phrases (onStatus).
  // WeChat channel uses Chinese; all other channels use English.
  const statusLang: PhraseLang = resolveResponseLanguage({ channel: sessionId }) === 'Chinese' ? 'zh' : 'en';

  // Skill hot-reload: if the revision has changed, inject a skill catalog update notification before this turn's message
  const seen = sessionSkillsRevision.get(sessionId) ?? 0;
  if (seen < skillsRevision) {
    const update = buildSkillUpdateMessage();
    if (update) {
      messages.push({ role: 'user', content: update });
      messages.push({ role: 'assistant', content: 'Acknowledged, skill catalog refreshed.' });
    }
    sessionSkillsRevision.set(sessionId, skillsRevision);
  }

  // Reminders no longer injected into LLM history: changed to reminderEmitter → WS pushes proactively to UI,
  // avoiding pollution of prompt cache and LLM context.
  //
  // K0: user message already persisted to the raw global timeline by outer handleChatSend; not appended again here.

  // Phase 11(2026-05-14):cross-turn-reflection trigger
  //
  // Background: production mycox heartbeat schedule — schedule fires a new turn every N minutes;
  // LLM repeatedly hits the same 404 (POST /api/comments "Post not found"). in-turn-reflection
  // only blocks remaining http calls in the current turn, but the next schedule turn resets → infinite loop.
  //
  // Fix: check sameRootCauseFailures within 24h for the same session at turn start.
  // ≥ threshold (default 3) + active plan → mechanism layer automatically:
  //   1. plan_close('failure', '[cross-turn-reflection] ...')
  //   2. Inject user-role reminder to make this turn's LLM:
  //      - Report the blocker using ## For User
  //      - In a schedule turn → call cancel_schedule to pause this schedule
  //      - Write store_note for diagnosis
  //
  // env PHILONT_CROSS_TURN_REFLECTION=0 to disable / *_THRESHOLD=N to adjust threshold (default 3).
  // pending* resume paths are skipped (user has explicitly agreed to continue).
  const _pendingForReflectCheck = pendingAuth.get(sessionId);
  const _pendingQForReflectCheck = pendingQuestion.get(sessionId);
  if (
    !_pendingForReflectCheck &&
    !_pendingQForReflectCheck &&
    process.env.PHILONT_CROSS_TURN_REFLECTION !== '0'
  ) {
    try {
      const sinceTs = Date.now() - 24 * 60 * 60_000;
      const recentSessionFails = memory.actions.listRecentFailures({
        sinceTs,
        limit: 50,
        sessionId,
      });
      const sameRoot = countSameRootCauseFailures(recentSessionFails);
      const threshold = Math.max(
        2,
        Number(process.env.PHILONT_CROSS_TURN_REFLECTION_THRESHOLD) || 3,
      );
      if (sameRoot >= threshold) {
        const groups = groupFailures(recentSessionFails);
        const topGroup = groups[0];
        const topSig = topGroup?.signature ?? 'unknown';
        const topToolName = topSig.split(':')[0] ?? 'unknown';
        const lastPlan = memory.plans.listBySession(sessionId, { limit: 1 })[0];
        const planActive =
          lastPlan &&
          (lastPlan.status === 'draft' || lastPlan.status === 'executing');
        // 1. Auto-close active plan
        if (planActive) {
          // M4 (2026-05-15): deliverable_status all marked not-attempted (mechanism-layer fallback close)
          const allNotAttempted = Object.fromEntries(
            lastPlan!.deliverables.map((d) => [d.id, 'not-attempted' as const]),
          );
          memory.plans.close(
            lastPlan!.id,
            'failure',
            `[cross-turn-reflection] 跨 turn 同根因失败 ${sameRoot} 次 (signature=${topSig}),` +
              `机制层自动 close plan 防 schedule 死循环。`,
            allNotAttempted,
          );
          console.warn(
            `[cross-turn-reflection] session=${sessionId} plan=${lastPlan!.id} → close failure (sameRoot=${sameRoot}, sig=${topSig})`,
          );
          audit.append('self_domain_write', {
            source: 'cross_turn_reflection',
            origin: 'Internal',
            toolName: 'plan_auto_close_cross_turn',
            sessionId,
            planId: lastPlan!.id,
            sameRootCauseCount: sameRoot,
            signature: topSig,
          });
        } else {
          console.warn(
            `[cross-turn-reflection] session=${sessionId} sameRoot=${sameRoot} (sig=${topSig}) but no active plan, only injecting reminder`,
          );
        }
        // 2. Inject reminder
        const isSchedule = sessionId.startsWith('system:scheduled:');
        const reminder =
          `[drive cross-turn-reflection] This session has seen **${sameRoot} same-root-cause failures in 24 h** (signature=${topSig}).` +
          `\nThis is a cross-turn loop pattern — you keep hitting the same error with the same tool. **Change direction this turn**:\n` +
          `  1. Use the \`## For User\` section to tell the user what you are stuck on (brief description of the failure pattern + how you plan to change approach / what you need)\n` +
          (isSchedule
            ? `  2. **This turn was triggered by a schedule** → strongly recommend calling cancel_schedule to pause this schedule (prevents it from firing every N minutes and burning tokens)\n`
            : '') +
          `  3. Call store_note(importance=high) to write a diagnostic note — future turns on similar tasks can look it up\n` +
          `  4. **Do not call ${topToolName} again** (same-root-cause ≥ ${threshold} times; you will not unblock yourself this way)` +
          (planActive
            ? `\n\n**The old plan ${lastPlan!.id} has been automatically closed as failure by the mechanism layer.** To continue, first draft a new plan_draft based on this reflection (with a different step direction).`
            : '') +
          `\n\nThis reminder is a mandatory mechanism-layer injection and is not surfaced to the user. Set env PHILONT_CROSS_TURN_REFLECTION=0 to disable.`;
        messages.push({ role: 'user', content: reminder });
        onTrace?.({
          kind: 'internal-gate', tier: 4,
          text: `cross-turn-reflection 触发(同根因失败 ${sameRoot} 次,${topSig})`,
          meta: { gateName: 'CrossTurnReflection' },
        });
      }
    } catch (e) {
      console.warn('[cross-turn-reflection] check failed, skipped:', (e as Error).message);
    }
  }

  // ── Check for pending authorization requests ──────────────────────────────────────────────────
  const pending = pendingAuth.get(sessionId);
  if (pending) {
    pendingAuth.delete(sessionId);

    // Expired pending → abandon it and handle the message as a normal turn (the auth card said
    // "valid for 10 min"). Without this, a stale pending makes every later message run through
    // the allow/deny classifier.
    const expired = Date.now() - pending.ts > PENDING_AUTH_TTL_MS;
    const context = `Tool "${pending.toolName}" (${pending.capability}/${pending.domain})`;
    const intent  = expired ? 'unclear' : await intentClassifier.classify(userMessage, context);

    if (intent === 'grant') {
      // deep_explore runs multi-round sessions where a single round can outlast the default
      // 10-min grant (round deadline is 12 min), forcing a re-auth every round. Give it a longer
      // window so one approval covers the session.
      const grantTtlMs = pending.toolName === 'deep_explore' ? DEEP_EXPLORE_GRANT_TTL_MS : undefined;
      grants.grant(pending.toolName, pending.capability as any, pending.domain as any, userMessage, grantTtlMs);
      const grantMinutes = Math.round((grantTtlMs ?? 10 * 60_000) / 60_000);
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: `Granted ${pending.toolName} (valid for ${grantMinutes} min)`,
        meta: { toolName: pending.toolName },
      });
      // Reconstruct the suspended tool as a call and place it back at the front of the queue, then re-enter runToolLoop with the remaining calls.
      // Must preserve it; otherwise the tool_use in the previous assistant message will have no matching tool_result,
      // and the next llm.send will be rejected by the API with "empty final user message" or structure mismatch.
      const resumeCalls = [
        { id: pending.toolCallId, name: pending.toolName, input: pending.input },
        ...pending.remainingCalls,
      ];
      return runToolLoop(
        sessionId, messages, grants, audit,
        resumeCalls,
        pending.collectedResults,
        pending.iteration,
        onDelta, onAuthRequest,
        signalBus, onStatus, onTrace, statusLang,
      );
    } else if (intent === 'deny') {
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: `已拒绝 ${pending.toolName}`,
        meta: { toolName: pending.toolName },
      });
      // Push the rejection result + placeholder results for all remaining calls together, letting the LLM give a final response directly
      const allResults = [
        ...pending.collectedResults,
        { type: 'tool_result' as const, tool_use_id: pending.toolCallId, content: `用户明确拒绝了此操作，不要重试，直接告知用户操作已被用户取消。` },
        ...pending.remainingCalls.map(c => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: `已跳过（前置工具被用户拒绝）`,
        })),
      ];
      messages.push({ role: 'user', content: allResults });
      const resp = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);
      if (resp.type === 'text') {
        messages.push({ role: 'assistant', content: resp.content });
        onDelta(resp.content);
      } else {
        // LLM still wants to call tools; force terminate and give a hint
        const fallback = '操作已被您取消。';
        messages.push({ role: 'assistant', content: fallback });
        onDelta(fallback);
      }
      return { outcome: { outcomeType: 'denied' }, auditEvents: audit.length };
    }
    // unclear (or expired): the reply is not a recognizable allow/deny. Do NOT re-prompt and
    // re-arm the pending — that traps natural-language messages ("is the session still active?",
    // "give me a progress update") in an endless "please reply allow/deny" loop. Instead abandon
    // the suspended tool and fall through to a normal turn so the message is actually answered.
    // (Safe: messages are rebuilt fresh each turn — K0 — so the dropped tool_use needs no cleanup.
    // If the user really meant to run the tool, the LLM re-issues the call and re-triggers auth.)
    onTrace?.({
      kind: 'auth-decision', tier: 4,
      text: expired
        ? `Pending auth for ${pending.toolName} expired (>${Math.round(PENDING_AUTH_TTL_MS / 60_000)} min); handling message as a normal turn`
        : `Reply to ${pending.toolName} auth was not allow/deny; handling message as a normal turn`,
      meta: { toolName: pending.toolName },
    });
    // fall through to normal turn processing below
  }

  // ── Proactive research "request permission": user replies "agree/deny" on WeChat against a background-pushed auth card ──────
  // Mirrors pendingAuth but lighter: no tool-chain resume (continuation is done automatically by the next autonomous tick's driver replay);
  // only needs to write a grant / revoke request. Deterministic (reuses intentClassifier), no LLM involved.
  // unclear / expired → pass through to normal turn (pending-approval prompt section + grant_research_tool fallback).
  const rg = pendingResearchGrants.get(sessionId);
  if (rg) {
    // Quick-check for expiry first (avoids unnecessary LLM intent calls); only classify intent if not expired.
    const expired = Date.now() - rg.ts > RESEARCH_GRANT_PENDING_TTL_MS;
    const intent = expired
      ? 'unclear'
      : await intentClassifier.classify(
          userMessage,
          `Background research requests use of tool "${rg.tool}" (execute/system)`,
        );
    const action = decideResearchGrantAction(rg, intent, Date.now(), RESEARCH_GRANT_PENDING_TTL_MS);

    if (action === 'grant') {
      pendingResearchGrants.delete(sessionId);
      grants.grant({
        toolName: rg.tool,
        capability: 'execute',
        domain: 'system',
        reason: `research:${rg.pursuitId}`,
        ttlMs: DEFAULT_RESEARCH_GRANT_TTL_MS,
      });
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: `Granted background research use of ${rg.tool} (research ${rg.pursuitId})`,
        meta: { toolName: rg.tool },
      });
      const reply = statusLang === 'zh'
        ? `已授权后台研究使用 ${rg.tool}，接下来会用它继续推进研究。`
        : `Granted. Background research will use ${rg.tool} to continue.`;
      messages.push({ role: 'assistant', content: reply });
      onDelta(reply);
      return { outcome: { outcomeType: 'response' }, auditEvents: audit.length };
    } else if (action === 'deny') {
      pendingResearchGrants.delete(sessionId);
      // Revoke the request: clear question.pendingTool → driver no longer replays, pending-approval section no longer shown.
      try {
        memory.pursuits.setQuestionPendingTool(rg.pursuitId, rg.questionId, null);
      } catch (e) {
        console.warn('[research-grant] withdraw request failed', e);
      }
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: `Denied background research use of ${rg.tool} (research ${rg.pursuitId})`,
        meta: { toolName: rg.tool },
      });
      const reply = statusLang === 'zh'
        ? `好的，已拒绝。后台研究不会使用 ${rg.tool}。`
        : `OK, denied. Background research will not use ${rg.tool}.`;
      messages.push({ role: 'assistant', content: reply });
      onDelta(reply);
      return { outcome: { outcomeType: 'response' }, auditEvents: audit.length };
    } else if (action === 'expired') {
      pendingResearchGrants.delete(sessionId); // stale pending; clear it and pass through
    }
    // passthrough / expired: not consumed (or already cleared); pass through to normal turn (LLM sees pending-approval section)
  }

  // ── Check for pending askUserQuestion replies ──────────────────────────────────
  // Design mirrors pendingAuth: stores inflightMessages + remainingCalls; on resume,
  // wraps the user reply as a tool_result and injects it, then continues runToolLoop.
  const pendingQ = pendingQuestion.get(sessionId);
  if (pendingQ) {
    pendingQuestion.delete(sessionId);

    // Timeout: treat as "give up" — return a cancelled placeholder for the current tool_call + skip
    // remaining calls; let the LLM decide how to proceed based on history.
    if (Date.now() - pendingQ.createdAt > QUESTION_TTL_MS) {
      const cancelledResults = [
        ...pendingQ.collectedResults,
        {
          type: 'tool_result' as const,
          tool_use_id: pendingQ.toolCallId,
          content: '用户长时间未回复(已超时)。请基于已有信息继续或告知用户操作未完成。',
        },
        ...pendingQ.remainingCalls.map((c) => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: '已跳过(前置 askUserQuestion 超时)',
        })),
      ];
      messages.push({ role: 'user', content: cancelledResults });
      // Treat the current user message as a new turn entry point; let the LLM continue on its own
      messages.push({ role: 'user', content: userMessage });
      const resp = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);
      if (resp.type === 'text') {
        messages.push({ role: 'assistant', content: resp.content });
        onDelta(resp.content);
      }
      return { outcome: { outcomeType: 'question_timeout' }, auditEvents: audit.length };
    }

    const parsed = parseQuestionAnswer(
      userMessage,
      pendingQ.question,
      pendingQ.options,
      pendingQ.allowFreeText,
    );

    if (parsed.kind === 'reprompt') {
      // Parse failed → re-send the same question and put pending back to continue waiting
      onDelta(parsed.message);
      pendingQuestion.set(sessionId, pendingQ);
      return { outcome: { outcomeType: 'question_pending' }, auditEvents: 0 };
    }

    // option or freetext → treat the answer as a tool_result, continue runToolLoop
    const allResults = [
      ...pendingQ.collectedResults,
      {
        type: 'tool_result' as const,
        tool_use_id: pendingQ.toolCallId,
        content: parsed.content,
      },
    ];
    return runToolLoop(
      sessionId, messages, grants, audit,
      pendingQ.remainingCalls,
      allResults,
      pendingQ.iteration,
      onDelta, onAuthRequest,
      signalBus, onStatus, onTrace, statusLang,
    );
  }

  // ── Normal message: enter the tool call loop ────────────────────────────────────────────

  // P0.2: user message references past conversations (recall verbs + past-tense adverbs) → force a system section hint
  // that the agent must first call recall_sessions, rather than saying "I have no context" and pushing back to the user.
  // Injected at the end of the messages[0] system context section, not into the user-role slot.
  const retroHit = detectTimeRetrospectiveQuery(userMessage);
  if (retroHit && messages[0]) {
    messages[0] = {
      ...messages[0],
      content:
        messages[0].content +
        `\n\n## ⚠️ 用户在引用过去对话(命中"${retroHit.snippet}")` +
        `\n用户的当前消息引用了过往对话。请**立即调用 recall_sessions**` +
        `(query 用消息里的关键名词,limit=5)查清楚再回答。**不要**说"我看不到` +
        `之前的聊天记录"——你完全有 recall_sessions 工具可用,直接用。`,
    };
    internalAudit.append('self_domain_write', {
      source: 'recall_trigger',
      origin: 'Internal',
      toolName: 'recall_trigger_fired',
      sessionId,
      snippet: retroHit.snippet,
      userMessageLength: userMessage.length,
    });
    console.log(`[recall-trigger] session=${sessionId} matched "${retroHit.snippet}", injected proactive recall hint`);
  }

  // Short-answer binding: if the previous assistant message has an unclosed question, hint the LLM to treat
  // this turn's user message as a reply rather than a new topic. Injected into the system section (messages[0]), not the user slot.
  // Only triggers when messages[0] already exists (not the first turn where system is absent) and there is a preceding natural-language assistant message.
  const priorAssistant = findLastAssistantText(messages);
  // 2026-06-07: only bind when the user message is plausibly a SHORT ANSWER to the prior question.
  // detectUnclosedQuestion is structural (any trailing "?" on the assistant side) and topic-blind,
  // so a NEW user question got mis-bound to an unrelated prior one — e.g. the meta-question
  // "llm适配好了吗？" was bound to a prior "…GL(2) spectral theory?" math question. If the user
  // message is itself a question (ends with ?/？), it cannot be a short answer → skip binding.
  const userIsItselfAQuestion = /[?？]\s*$/.test(userMessage.trim());
  if (priorAssistant && messages[0] && !userIsItselfAQuestion) {
    const detected = detectUnclosedQuestion(priorAssistant);
    if (detected.hasQuestion) {
      messages[0] = {
        ...messages[0],
        content: messages[0].content + renderBindingContext(detected.snippet, userMessage),
      };
      internalAudit.append('self_domain_write', {
        source: 'short_answer_binding',
        origin: 'Internal',
        toolName: 'short_answer_binding_fired',
        sessionId,
        priorQuestion: detected.snippet,
        userReplyLen: userMessage.length,
      });
      console.log(
        `[short-answer-binding] session=${sessionId} matched previous turn's question "${detected.snippet.slice(0, 40)}…", injected binding hint`,
      );
    }
  }

  // Routing rule injection: extract keywords from the user message → match top-K active rules → inject into system section.
  // No injection if 0 rules match (0 token impact). Zero matches are expected during early rule accumulation.
  if (messages[0]) {
    const inj = buildRoutingInjection(userMessage, memory.routingRules);
    if (inj.matched > 0) {
      messages[0] = {
        ...messages[0],
        content: messages[0].content + inj.text,
      };
      // 2026-05-11: store matched rule ids in signalBus; at turn close, call recordRuleOutcome based on
      // this turn's outcome to feed back (Phase 3 closes the routing confidence state machine loop).
      signalBus.activeRuleIds = inj.ruleIds;
      internalAudit.append('self_domain_write', {
        source: 'routing_rule_injection',
        origin: 'Internal',
        toolName: 'routing_rules_injected',
        sessionId,
        ruleIds: inj.ruleIds,
        matched: inj.matched,
      });
      console.log(
        `[routing-inject] session=${sessionId} injected ${inj.matched} routing rules (ids=${inj.ruleIds.join(',')})`,
      );
    }
  }

  // task_pattern_hint (keyword-triggered hardcoded tool hints) removed 2026-05-07 —
  // replaced by planAndExecute (generic plan-then-execute composite tool); the system
  // prompt already has a section teaching the LLM to prefer it for complex tasks; keyword detection is unnecessary.

  // User dissatisfaction detection: user message contains obvious complaint / retry / negation signals → write task_failure_mode
  // audit; this turn is immediately hit by failure_recovery_inject below (same audit is immediately visible).
  // Detected via regex:
  //   - Chinese "still / again / not yet" + "success / no good / failed"
  //   - "you didn't before / you didn't follow up"
  //   - "retry / redo / redo from scratch / try a different method / this time"
  //   - "right or not / wrong / not like this / not what was asked"
  //   - "failed" single word
  // This is a soft-failure signal (user expressing dissatisfaction), different from task_pattern_hint keyword detection:
  // this is a strong signal of "user has already given failure feedback" and does not trigger spuriously.
  if (detectUserDissatisfaction(userMessage)) {
    internalAudit.append('task_failure_mode', {
      sessionId,
      kind: 'user_dissatisfaction',
      ts: Date.now(),
      detail: userMessage.slice(0, 100),
    });
  }

  // 2026-05-07 path 7: user responds with "learn/decline" → mark candidate state.
  // After confirm, injects a hint in the system section for the LLM to call skill-creator; decline marks as declined.
  try {
    const response = detectPatternConfirmation(userMessage);
    if (response.kind !== 'none') {
      const pending = listPendingPatterns(memory.facts);
      if (pending.length > 0) {
        // Find target candidate: use sig if present, otherwise take the most recent 1
        const target = response.signature
          ? pending.find((p) => p.signature === response.signature) ?? pending[0]
          : pending[0];
        if (response.kind === 'confirm') {
          markPatternStatus(memory.facts, target.signature, 'confirmed');
          internalAudit.append('self_domain_write', {
            source: 'user_pattern_confirmation',
            origin: 'External',
            toolName: 'pattern_confirmed',
            sessionId,
            signature: target.signature,
          });
          // Inject hint for the LLM to immediately call skill-creator, writing the candidate as SKILL.md
          if (messages[0]) {
            const c = target.candidate;
            messages[0] = {
              ...messages[0],
              content: messages[0].content +
                `\n\n## ✅ 用户确认学习模式 ${target.signature}\n` +
                `候选信息:\n` +
                `- 关键词: ${c.keywords.slice(0, 5).join(', ')}\n` +
                `- 工具序列: ${c.toolSequence.join(' → ') || '(无)'}\n` +
                `- 出现 ${c.occurrences} 次, 示例: ${c.examples.slice(0, 2).map((e) => `"${e.userMessage}"`).join(' / ')}\n\n` +
                `**本轮请**:\n` +
                `1. use_skill('skill-creator')\n` +
                `2. 按其指引把上述模式写成 SKILL.md(name = pattern-${target.signature})\n` +
                `3. 通过 installSkill 工具持久化\n` +
                `4. 告知用户已学完`,
            };
          }
          console.log(`[user-pattern] confirmed signature=${target.signature}`);
        } else {
          markPatternStatus(memory.facts, target.signature, 'declined');
          internalAudit.append('self_domain_write', {
            source: 'user_pattern_decline',
            origin: 'External',
            toolName: 'pattern_declined',
            sessionId,
            signature: target.signature,
          });
          console.log(`[user-pattern] declined signature=${target.signature}`);
        }
      }
    }
  } catch (e) {
    console.warn('[user-pattern] confirmation check failed, skipped', e);
  }

  // Failure recovery injection: if there is a task_failure_mode audit within the last 30 min for this session
  // (iter cap hit / turn deadline / LLM timeout / API error / reflection triggered /
  //  tool failure burst / user dissatisfaction) → inject a strong hint for the LLM to use planAndExecute
  // or searchSkills this turn rather than repeating the same mistake. Data-driven; zero false positives (only triggers after actually hitting a wall).
  if (messages[0]) {
    const recovery = buildFailureRecoveryInjection(internalAudit, sessionId, userMessage);
    if (recovery.matched) {
      messages[0] = {
        ...messages[0],
        content: messages[0].content + recovery.text,
      };
      internalAudit.append('failure_recovery_injected', {
        sessionId,
        failureCount: recovery.recentFailures.length,
        kinds: recovery.recentFailures.map((f) => f.kind),
      });
      console.log(
        `[failure-recovery] session=${sessionId} injected ${recovery.recentFailures.length} failure hints (kinds=${recovery.recentFailures.map((f) => f.kind).join(',')})`,
      );
    }
  }

  messages.push({ role: 'user', content: userMessage });

  // v7: drive runtime evaluation — let intrinsic-drives score and inject before user message is queued and LLM is called.
  // The triggered outcome will be fed back as this turn's observation (tool call success/failure + fact delta)
  // via afterTurn in the finally block, for SessionDriveReflector to score and tune parameters later.
  const turnStartTs = Date.now();
  const fired = driveRuntime.beforeTurn({
    sessionId,
    recentMessages: toRecentMessages(messages, 12),
    iteration: 0,
    activePursuits: memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID),
    recentToolCalls: [],
  });
  if (fired.length === 0) {
    console.log(
      `[drive] session=${sessionId} 0 fired (evaluated ${driveRuntime.listEngines().length} engines)`,
    );
  } else {
    for (const f of fired) {
      // Flatten key snapshot fields into one line (fields differ per drive; JSON.stringify truncated to 200 chars)
      let snap = '';
      try {
        snap = JSON.stringify(f.triggerSnapshot).slice(0, 200);
      } catch {
        snap = '<unserializable>';
      }
      console.log(
        `[drive] session=${sessionId} FIRE ${f.driveId} utility=${f.utility.toFixed(2)} snapshot=${snap}`,
      );
    }
  }
  // K7.3 constitutional amendment: **never** push drive output to the user-role slot.
  // PDF→Word case revealed: LLM treated drive injection as a user question and kept doubling down when probed.
  // Root cause: drive output in user role + at tail position = LLM attention lock.
  //
  // New path: append all fires to the end of messages[0] ("system context"). The LLM can still
  // see the intrinsic-drive observation (influencing its response) but **will not treat it as user words**.
  // Also no longer sent to the frontend via onDelta (intrinsic drive is agent internal state and should not be visible as a conversation bubble).
  // Also no longer written to the raw timeline.
  if (fired.length > 0 && messages[0]) {
    const driveLines = ['', '## 内驱观察(本轮)'];
    for (const f of fired) {
      driveLines.push(`  · [${f.driveId}] ${f.injectedMessage}`);
    }
    messages[0] = {
      ...messages[0],
      content: messages[0].content + driveLines.join('\n'),
    };
  }

  try {
    // Compaction check: summarize the middle section when the message count is too large
    await maybeCompact(messages, sessionId);

    const response = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);

    if (response.type === 'text') {
      // Anti-fabrication: a no-tool first response that claims deep_explore round/session results
      // is invented (no deep_explore ran). Replace with an honest message before it goes out.
      const safeText = guardDeepExploreFabrication(response.content, signalBus);
      messages.push({ role: 'assistant', content: safeText });
      onDelta(safeText);
      // Layer 0 append: assistant text response goes into the global timeline
      memory.raw.appendMessage({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        role: 'assistant',
        content: safeText,
      });
      return { outcome: { outcomeType: 'response', text: safeText }, auditEvents: audit.length };
    }

    // 2026-05-07 #1 cont: tool_use.input in the assistantMessage returned by the LLM provider
    // is occasionally a string (multiple JSONs concatenated); pushing it directly into messages causes the next LLM call
    // to hit 400 Improperly formed request. Sanitize before pushing.
    const sanitizedAsst = sanitizeAssistantMessageBlocks(response.assistantMessage);
    if (sanitizedAsst.stats.fixed > 0 || sanitizedAsst.stats.rejected > 0) {
      console.warn(
        `[input-fix] assistantMessage tool_use blocks: total=${sanitizedAsst.stats.totalToolUse} ` +
          `fixed=${sanitizedAsst.stats.fixed} rejected=${sanitizedAsst.stats.rejected}`,
      );
    }
    messages.push(sanitizedAsst.msg);

    return await runToolLoop(
      sessionId, messages, grants, audit,
      response.calls, [], 0,
      onDelta, onAuthRequest,
      signalBus, onStatus, onTrace, statusLang,
    );
  } finally {
    // v7: drive triggered this turn → collect this turn's observation feedback and feed back to drive runtime.
    // The Reflector will later score the outcome's effectivenessScore, merge via EWMA,
    // and adjust drive_config parameters within constitution.driveBounds.
    let observations: ReturnType<typeof collectTurnObservations> | null = null;
    if (fired.length > 0) {
      try {
        observations = collectTurnObservations(sessionId, turnStartTs);
        driveRuntime.afterTurn(fired, observations);
      } catch (e) {
        console.warn('[drive] afterTurn failed:', e);
      }
    }

    // K7→K8 bridge: converts K7 reactive fire signals for this turn (TaskCommitment fired / honesty etc.)
    // into K8 InitiativeProposals and inserts them directly into the autonomousLoop's initiative queue.
    // The next autonomous tick will pick them up and run read-only tools
    // (webSearch / inspectPath / searchSkills etc.) to actually verify / leave audit notes,
    // patching the gap where "K7 injects advice to the LLM, but the LLM may not change anyway".
    //
    // Does not block the main path: all errors are swallowed and only logged.
    try {
      if (fired.length > 0 || signalBus.honesty) {
        const proposals = collectK7BridgeInitiatives({
          fired,
          honesty: signalBus.honesty
            ? {
                eval: signalBus.honesty.evaluation,
                toolResults: signalBus.honesty.toolResults,
                assistantText: signalBus.honesty.assistantText,
              }
            : undefined,
          observations: observations ?? { toolCalls: [] },
          recentDoneTargetRefs: autonomousLoop.initiatives.listRecentSettledTargetRefs(),
          turnRef: `${sessionId}:${turnStartTs}`,
        });
        for (const p of proposals) {
          try {
            const inserted = autonomousLoop.initiatives.insert(p);
            internalAudit.append('self_domain_write', {
              source: 'k7_bridge',
              origin: 'Internal',
              toolName: 'k7_bridge_enqueued',
              sessionId,
              initiativeId: inserted.id,
              kind: p.kind,
              targetRef: p.targetRef,
              utility: p.utility,
            });
            console.log(
              `[k7-bridge] enqueued ${p.kind} (id=${inserted.id} util=${p.utility})`,
            );
          } catch (e) {
            console.warn('[k7-bridge] insert failed:', e);
          }
        }
      }
    } catch (e) {
      console.warn('[k7-bridge] collect failed, skipped:', e);
    }

    // Phase 9.2 M3 (2026-05-13): turn-close fallback — LLM did not explicitly call plan_close
    // but has an active plan (reviewed / executing / draft) + strong signal (honesty fired OR
    // sameRootCauseFailures ≥ 2) → mechanism layer automatically calls plan.close(failure).
    //
    // Fixes production mycox hole #2: LLM finishes tools and directly exits with outcome=response,
    // never calling plan_close → all outer loop close-time strict validation is dead code.
    // env PHILONT_PLAN_AUTO_CLOSE_ON_TURN_END=0 to disable.
    if (
      process.env.PHILONT_PLAN_AUTO_CLOSE_ON_TURN_END !== '0' &&
      !signalBus.planCloseCalled
    ) {
      try {
        const recentPlans = memory.plans.listBySession(sessionId, { limit: 1 });
        const lastPlan = recentPlans[0];
        if (
          lastPlan &&
          (lastPlan.status === 'draft' || lastPlan.status === 'executing')
        ) {
          let strongSignal: string | null = null;
          if (signalBus.honesty) {
            const ev = signalBus.honesty.evaluation;
            strongSignal = `honesty fired (severity=${ev.severity} reason=${ev.reason})`;
          } else {
            try {
              const sinceTs = Date.now() - 24 * 60 * 60_000;
              const recent = memory.actions.listRecentFailures({
                sinceTs,
                limit: 30,
              });
              const sameRoot = countSameRootCauseFailures(recent);
              if (sameRoot >= 2) {
                strongSignal = `sameRootCauseFailures=${sameRoot}`;
              }
            } catch {
              /* ignore */
            }
          }
          // 2026-05-13 / M3 Phase 11 (2026-05-15) second-layer fallback: plan still in draft state
          // = LLM never called plan_update_step(status='doing') to move the plan into
          // executing → treated as the protocol being bypassed (M3 state machine tightened: plan_protocol_gate
          // already blocks all non-protocol tools). Force close failure to prevent schedule infinite loops.
          if (!strongSignal && lastPlan.status === 'draft') {
            strongSignal = 'protocol_bypassed (plan in draft, never entered executing)';
          }
          if (strongSignal) {
            // M4 (2026-05-15): deliverable_status all marked not-attempted (mechanism-layer fallback)
            const allNotAttempted = Object.fromEntries(
              lastPlan.deliverables.map((d) => [d.id, 'not-attempted' as const]),
            );
            const closed = memory.plans.close(
              lastPlan.id,
              'failure',
              `[auto-close] turn 结束 LLM 未显式调 plan_close + ${strongSignal}`,
              allNotAttempted,
            );
            if (closed) {
              signalBus.planAutoClosedFailure = true;
              internalAudit.append('self_domain_write', {
                source: 'plan_auto_close_on_turn_end',
                origin: 'Internal',
                toolName: 'plan_auto_close_on_turn_end',
                sessionId,
                planId: lastPlan.id,
                previousStatus: lastPlan.status,
                strongSignal,
              });
              console.log(
                `[plan-auto-close] session=${sessionId} plan ${lastPlan.id} (was ${lastPlan.status}) → failed; trigger=${strongSignal}`,
              );
            }
          }
        }
      } catch (e) {
        console.warn('[plan-auto-close] failed, skipped:', e);
      }
    }
  }
}

// ── Tool execution loop (resumable from mid-point) ──────────────────────────────────────────────

/**
 * Accumulation container for K7 reactive signals within a single turn.
 *
 * runToolLoop writes to it when honesty/empty etc. gates fire; handleChatSendInner
 * reads it in the finally block and passes it to the K7→K8 bridge (collectK7BridgeInitiatives) to produce K8 initiatives.
 *
 * Not persisted; discarded at turn end. Multiple fires take **the most recent one** (each gate
 * has an attempts<1 cap within runToolLoop, firing at most once, so "most recent" == unique).
 */
/**
 * 2026-05-27: print a human-readable summary line at turn end, replacing the "waterfall of tool call logs".
 *
 * Gives ops / debuggers an at-a-glance view of:
 *   - How many tools were called this turn (total + read/write/execute breakdown)
 *   - How many succeeded and how many failed
 *   - Which tools failed (deduplicated)
 *   - The first error for failures (truncated to 60 chars)
 *
 * Not printed at per-tool-call granularity — those already go to onTrace / [tool] log lines.
 */
function summarizeTurnTools(records: InTurnToolRecord[]): string {
  if (!records.length) return 'tools=0';
  let ok = 0;
  let fail = 0;
  let read = 0;
  let write = 0;
  let exec = 0;
  const failedTools = new Set<string>();
  let firstError: string | null = null;
  for (const r of records) {
    if (r.success) {
      ok++;
    } else {
      fail++;
      failedTools.add(r.toolName);
      if (!firstError && r.resultText) {
        firstError = r.resultText.slice(0, 60).replace(/\s+/g, ' ');
      }
    }
    const c = tools.classify(r.toolName);
    if (c?.capability === 'read') read++;
    else if (c?.capability === 'write') write++;
    else if (c?.capability === 'execute') exec++;
  }
  const parts: string[] = [`tools=${records.length}`];
  parts.push(`ok=${ok}`);
  if (fail > 0) parts.push(`fail=${fail}`);
  parts.push(`(read=${read},write=${write},exec=${exec})`);
  if (failedTools.size > 0) {
    const list = [...failedTools].slice(0, 3).join(',');
    parts.push(`failed=[${list}${failedTools.size > 3 ? ',…' : ''}]`);
  }
  if (firstError) {
    parts.push(`firstErr="${firstError}"`);
  }
  return parts.join(' ');
}

interface TurnSignalBus {
  honesty?: {
    evaluation: HonestyEvaluation;
    toolResults: Array<{ toolName: string; content: string; toolInput?: Record<string, unknown> }>;
    assistantText: string;
  };
  /**
   * Total critical+high+normal count from InterruptDrainer.drain() this turn.
   * Updated by buildMemoryPrefix at drain time. ≥ 1 is treated as interruptDrained.
   */
  interruptDrainedCount?: number;
  /**
   * 2026-05-11: list of rule IDs that routing_inject matched and injected this turn.
   * At turn close, calls recordRuleOutcome based on this turn's outcome (strong success/failure signal) to feed back,
   * making the routing_rules 5-tier confidence state machine actually live (previously had 0 callers).
   */
  activeRuleIds?: number[];
  /** 2026-05-11: EmptyConclusionGate fire that occurred this turn (feeds back strong failure signal) */
  emptyConclusionFired?: boolean;
  /**
   * Phase 9.2 M1 (2026-05-13): whether the LLM has explicitly called plan_close this turn.
   * Written back by markPlanCloseCalled at the plan_close.execute entry point.
   * Turn-close fallback (M3) uses this to determine "whether an active plan needs auto-close".
   */
  planCloseCalled?: boolean;
  /**
   * 2026-05-15: mechanism-layer "forced demotion" signals for this turn (passed to turn-close to compute turnDegraded,
   * which is forwarded to reflection_runner so reflection takes the negative distillation path and rejects new_skill/skill_refine).
   *
   * These signals indicate the turn did not end normally with the LLM giving a conclusion; instead it was caught by mechanisms:
   *   - planCircuitBroken: plan_* tools repeatedly failed, triggering circuit-breaker to force fast mode
   *   - inTurnToolBlockFired: same-root-cause failures ≥ threshold triggered in-turn-tool-block to disable tools
   *   - planAutoClosedFailure: turn-end turn-close fallback automatically closed plan with failure
   */
  planCircuitBroken?: boolean;
  inTurnToolBlockFired?: boolean;
  planAutoClosedFailure?: boolean;
  /**
   * Phase 12 cont (2026-05-17): full tool call trace within the turn.
   * runToolLoop pushes one entry at each tool execution point; at handleChatSend turn close,
   * if sessionId is a scheduled session, summarizes and writes to ScheduleOutcomeStore.
   * Multiple runToolLoop calls within a single turn (auth resume / question resume) share the same array.
   */
  inTurnRecords?: InTurnToolRecord[];
}

/** True when a tool call would advance a deep_explore round (the expensive ~15-min mini-loop), vs read-only status/finalize. */
function isDeepExploreAdvance(call: { name: string; input: unknown }): boolean {
  if (call.name !== 'deep_explore') return false;
  const action = String((call.input as { action?: unknown } | null)?.action ?? '');
  return action === 'start' || action === 'continue' || action === 'discover';
}
const DEEP_EXPLORE_ONE_ROUND_MSG =
  'Each turn advances deep_explore by at most one round (~15 min) to stay under the turn time limit. ' +
  'This turn already ran one round and saved the tree. Tell the user the round is done and to reply "continue" ' +
  'to advance the next round in a fresh turn — do NOT call deep_explore(start/continue/discover) again this turn. ' +
  'IMPORTANT: this blocked call did NOT run a round — when summarizing, count ONLY the one round that actually ran ' +
  '(do not report blocked attempts as extra rounds).';

/**
 * 2026-06-08: anti-fabrication gate (mechanism layer — prompt-level guidance kept failing).
 * Observed: on "继续"/"启动" the model returns text (tools=0, ~15s) that INVENTS a deep_explore
 * round result from the saved-snapshot numbers — "第N轮 / 时间帽 / x开→y开 / 已启动 session <id>" —
 * presenting fake math progress as real. These markers can only be TRUE if deep_explore actually
 * ran this turn. So: if the response claims them AND no deep_explore tool ran this turn → it's
 * fabrication; replace with an honest message. A response that DID call deep_explore (calledDeepExplore)
 * is never gated — a real round legitimately reports "第N轮…". Markers are deliberately specific
 * (round/session events), not generic words like 死胡同/已证, to avoid false-positives on summaries.
 */
const DEEP_EXPLORE_FABRICATION_RE =
  /时间帽|第\s*\d+\s*轮|\d+\s*开\s*(?:→|->|—>)\s*\d+\s*开|已启动[^。\n]{0,40}session\s*[0-9a-fA-F][0-9a-fA-F-]{5,}/;
const DEEP_EXPLORE_FABRICATION_REPLY =
  '## For User\n' +
  '我这一回合并没有真正运行 deep_explore——"第N轮 / 已证 / 时间帽 / x开→y开 / 已启动 session" 这类是**已保存的状态快照,不是这次跑出来的**。' +
  '要真正推进,请回复"继续",我会**实际调用 deep_explore 跑一轮**(约需数分钟);要看当前真实进度,我去调 deep_explore(action=status)。\n\n' +
  '## Work Log\n' +
  '[fabrication-gate] 本回合未实际调用 deep_explore 却声称了回合/会话结果 → 已拦截并替换为如实说明。';

/** Returns the safe outgoing text: if it fabricates deep_explore progress (claims a round/session result with no deep_explore call this turn), replace it with an honest message. */
function guardDeepExploreFabrication(text: string, signalBus: TurnSignalBus): string {
  const calledDeepExplore = (signalBus.inTurnRecords ?? []).some((r) => r.toolName === 'deep_explore');
  if (calledDeepExplore || !DEEP_EXPLORE_FABRICATION_RE.test(text)) return text;
  console.warn(
    '[fabrication-gate] blocked fabricated deep_explore progress (response claimed round/session results but no deep_explore call this turn)',
  );
  return DEEP_EXPLORE_FABRICATION_REPLY;
}

async function runToolLoop(
  sessionId: string,
  messages: NativeMessage[],
  grants: GrantStore,
  audit: AuditLog,
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  collectedResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>,
  startIteration: number,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequest) => void,
  signalBus: TurnSignalBus,
  onStatus?: (text: string) => void,
  onTrace?: TraceFn,
  statusLang: PhraseLang = 'en',
): Promise<{ outcome: { outcomeType: string; text?: string; reason?: string }; auditEvents: number }> {

  // Create pre-intercept checker (reuses createToolChecker for unified logic)
  const checker = createToolChecker({
    permissions,
    audit,
    classifyTool: (name) => tools.classify(name),
    grantStore: grants,
    validatorChain: conservativeValidatorChain,
  });

  // Phase 10 (2026-05-14): take cap based on task mode. Snapshot at entry to avoid mid-turn mode changes
  // causing cap jumps (bad UX if LLM sees N/X warning and then X changes).
  const effectiveMax = effectiveMaxIter(sessionId);

  const toolResults = [...collectedResults];
  // EmptyConclusionGate: accumulated tool call count across the entire runToolLoop.
  // collectedResults already includes tool_results executed before the resume (auth resume case); counted first.
  let totalToolCallsThisTurn = collectedResults.length;
  // 2026-06-08: at most ONE advancing deep_explore round per turn. A single 15-min round fits under
  // the 20-min turn hard deadline, but the model would chain a 2nd round in the same turn ("reply
  // continue" → it calls deep_explore(continue) again) → 2×15min > 20min → TurnDeadlineError ("抱歉
  // 出错"). Counter is runToolLoop-scoped (= one chat turn); read-only actions (status/finalize)
  // don't count. Autonomous ticks don't go through runToolLoop, so they're unaffected.
  let deepExploreAdvancesThisTurn = 0;

  // 2026-05-10: in-turn failure pattern detector uses this turn-internal tool call trace.
  // Pushes one entry after each tool execution (success or fail); detectInTurnFailurePattern
  // scans for same-root-cause failures ≥ threshold → injects "reflect rather than retry" hint.
  //
  // 2026-05-17 Phase 12 cont: shared into signalBus; used as ScheduleOutcomeStore data source
  // at handleChatSend turn close (scheduled sessions automatically capture outcome).
  // Multiple runToolLoop entries via auth/question resume share the same array; trace is not lost.
  signalBus.inTurnRecords = signalBus.inTurnRecords ?? [];
  const inTurnRecords = signalBus.inTurnRecords;

  const isAutonomousTurn = sessionId.startsWith('system:scheduled:');

  // Interrupt teeth (2026-05-29): this turn was stopped by the user (UserHardStop) → exit early at each iteration /
  // tool boundary. In-flight LLM calls are cancelled via signal passed to HTTP (see
  // sendLlmWithRescue); these boundary checks handle the "stalled between tool calls / before next LLM call" scenario.
  const stopped = () => turnAbortSignal(sessionId)?.aborted === true;
  const interruptedReturn = () => ({
    outcome: { outcomeType: 'interrupted' as const, reason: 'user_stop', text: '已停止' },
    auditEvents: audit.length,
  });
  if (stopped()) return interruptedReturn();

  for (const call of calls) {
    if (stopped()) return interruptedReturn();
    const classification = tools.classify(call.name);

    // 2026-05-10: autonomous turn blacklist interception. Return failure as tool_result; the LLM
    // adapts to this turn's constraint without interrupting the turn (unlike auth_pending which halts the entire schedule).
    if (isAutonomousTurn && AUTONOMOUS_TURN_BLACKLIST.has(call.name)) {
      const reason =
        `Autonomous heartbeat turn 不允许调 ${call.name}。\n` +
        `理由:此 turn 由 schedule 触发,无用户在场,改 self 时序 / 写 fs / askUserQuestion 都不安全。\n` +
        `对策:用只读工具(http / readFile / listDir / get_fact / list_facts / search_notes)继续本轮观察,` +
        `把需要"取消 schedule / 录凭证 / 写文件"的事写成 store_note(importance=high),等用户下次回话再处理。`;
      console.warn(
        `[autonomous-blacklist] session=${sessionId} rejected ${call.name}`,
      );
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: reason,
      });
      totalToolCallsThisTurn++;
      memory.actions.log({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        toolName: call.name,
        params: call.input,
        result: 'rejected_by_autonomous_blacklist',
        success: false,
      });
      audit.append('self_domain_write', {
        source: 'autonomous_blacklist',
        origin: 'Internal',
        toolName: 'autonomous_tool_blocked',
        sessionId,
        blockedTool: call.name,
      });
      continue;
    }
    if (!classification) {
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: Unknown tool '${call.name}'` });
      totalToolCallsThisTurn++;
      continue;
    }

    // 2026-05-13 constitutional amendment bug: plan_protocol_gate previously only checked in secondary iter (line ~4452)
    // → all tools in the first iter were let through; LLM's first response could bypass the entire plan
    // protocol (production mycox: webFetch 200 passed + then fabricated "complete"). Added first iter check.
    // Logic is an exact mirror of secondary iter; shares the same semantics.
    //
    // Phase 12 (2026-05-17): allowance rules changed to 3×4 capability/domain (see isPlanGateExempt).
    // read any domain + write×self are allowed; webFetch / readFile /
    // search_skills / store_fact etc. required by LLM before writing a plan are no longer erroneously blocked by the gate.
    //
    // 2026-05-14 debug: added trace log to investigate suspicion of auth_pending resume path bypassing gate
    // (enable with PHILONT_PLAN_GATE_TRACE=1).
    {
      const mode = taskModeStore.get(sessionId);
      const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
      const lastPlan = sessionPlans[0];
      const exempt = isPlanGateExempt(call.name, classification, call.input);
      if (process.env.PHILONT_PLAN_GATE_TRACE === '1') {
        console.log(
          `[plan-gate-trace][first-iter] tool=${call.name} mode=${mode} plan=${lastPlan?.id ?? 'none'} planStatus=${lastPlan?.status ?? 'none'} reviewCount=${lastPlan?.reviewHistory.length ?? 0} exempt=${exempt}`,
        );
      }
    }
    if (taskModeStore.get(sessionId) === 'slow') {
      const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
      const lastPlan = sessionPlans[0];
      // M3 / Phase 11 (2026-05-15) tightened: only 'executing' allows execution-type tools.
      // 'draft' still rejects (forces LLM to call plan_update_step status='doing' to enter executing);
      // failed/completed/none all require a new plan_draft.
      const planAllowsExec = lastPlan?.status === 'executing';
      const needsPlanReview = !planAllowsExec;
      const exempt = isPlanGateExempt(call.name, classification, call.input);
      if (needsPlanReview && !exempt) {
        const baseReason = !lastPlan
          ? `slow 模式下尚未调 plan_draft 拆解任务。`
          : lastPlan.status === 'draft'
            ? `plan ${lastPlan.id} 状态 draft(${lastPlan.steps.length} 步,尚未开始执行)。`
            : lastPlan.status === 'failed'
              ? `plan ${lastPlan.id} 已 close=failed。这个 plan 已弃,但本任务未完成 — 需要新 plan_draft 接续。`
              : lastPlan.status === 'completed'
                ? `plan ${lastPlan.id} 已 close=completed。如果你要做新任务,先 plan_draft 拆步;别直接跑工具。`
                : `plan ${lastPlan.id} 状态 ${lastPlan.status} 不在允许执行集合(executing)。`;
        const planStateHint = !lastPlan
          ? 'plan_draft({deliverables, steps, task_signature, guide_ref}) — 创建 plan'
          : lastPlan.isPlaceholder
            ? `plan_revise({plan_id:"${lastPlan.id}", new_steps, new_deliverables, reason}) — 转正占位 plan(必须提供 new_deliverables)`
            : lastPlan.status === 'draft'
              ? `plan_update_step({plan_id:"${lastPlan.id}", step_id, status:"doing"}) — 开始执行第一步`
              : `plan_revise({plan_id:"${lastPlan.id}", ...}) — 修订 plan 路径`;
        const closeHint = lastPlan
          ? `plan_close({plan_id:"${lastPlan.id}", outcome:"failure", summary:"分类错误"})`
          : '(当前无活 plan,跳到第 2 步)';
        const reason =
          `[plan_protocol_gate] ${baseReason}\n` +
          `本工具 ${call.name} 已被机制层禁用,直到 plan 进入 executing 状态。\n\n` +
          `**这不是 bug,是 slow 协议设计。** 你现在有 3 个选择:\n\n` +
          `A) 本任务**需要 plan**(多 deliverable 或多步依赖):\n` +
          `   1. ${planStateHint}\n` +
          `   2. plan_update_step({plan_id, step_id, status:"doing"}) — 开始执行\n` +
          `   3. 然后 ${call.name} 自动放行\n\n` +
          `B) 本任务**不需要 plan**(单次调用就够,或调研类只读):\n` +
          `   1. ${closeHint} — 关掉占位 plan(close 后即可切 fast,无冷却)\n` +
          `   2. task_mode_classify({mode:"fast", reason:"..."})\n` +
          `   3. 重试 ${call.name}\n\n` +
          `C) 你**卡住了**:\n` +
          `   - list_facts / search_skills 查相关历史\n` +
          `   - webFetch guide_ref 重新读指引\n` +
          `   - 调 plan_revise 改 plan(若现 plan 路径错了)\n\n` +
          `**不要直接重试 ${call.name} 不变** — 会再次被拦。`;
        console.warn(
          `[plan_protocol_gate] session=${sessionId} rejected ${call.name} (slow + planStatus=${lastPlan?.status ?? 'none'})[first-iter]`,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reason,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reason,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_plan_protocol_gate',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'plan_protocol_gate',
          origin: 'Internal',
          toolName: 'plan_protocol_gate_blocked',
          sessionId,
          blockedTool: call.name,
          planStatus: lastPlan?.status ?? 'no-plan',
          planId: lastPlan?.id ?? null,
          iter: 'first',
        });
        continue;
      }
    }

    // Pre-intercept: use createToolChecker for unified checking
    const { capability, domain } = classification;
    const denial = await checker({ toolName: call.name, approval: 'never', params: JSON.stringify(call.input) });
    // 2026-05-28: headless/benchmark autogrant. In unattended sandbox containers, auth_pending
    // would be auto-"allowed" and replayed by headless anyway; but **the pause-resume itself** splits multiple
    // tool_use blocks from one model response across the pause boundary → on resume, messages are reassembled with
    // tool_use ↔ tool_result mismatches → Anthropic 400 (deepseek always hits this when emitting multiple tool_use at once;
    // Claude emitting one at a time does not). PHILONT_AUTO_GRANT=1 passes through directly, eliminating the pause → multiple
    // tool_use blocks processed in order in the same runToolLoop pass, naturally paired correctly.
    // Sandbox/benchmark use only; never enable in production (equivalent to full permissions with no human approval).
    const autoGrant = process.env.PHILONT_AUTO_GRANT === '1';
    const allowed = denial === null || autoGrant;
    if (autoGrant && denial !== null) {
      console.warn(
        `[auto-grant] session=${sessionId} allowed ${call.name} (${capability}×${domain})— PHILONT_AUTO_GRANT=1, sandbox unattended`,
      );
    }

    if (!allowed) {
      // Pause: save state, wait for user authorization
      const remainingCalls = calls.slice(calls.indexOf(call) + 1);
      pendingAuth.set(sessionId, {
        capability, domain,
        toolName:   call.name,
        toolCallId: call.id,
        input:      call.input,
        remainingCalls,
        collectedResults: toolResults,
        iteration: startIteration,
        // K0: save the current messages array in full; on authorization resume use it directly without rebuilding,
        // to avoid tool_use / tool_result pairing mismatches.
        inflightMessages: [...messages],
        ts: Date.now(),
      });

      onAuthRequest({ toolName: call.name, capability, domain, input: call.input });
      return { outcome: { outcomeType: 'auth_pending' }, auditEvents: audit.length };
    }

    // ── askUserQuestion special path: ask then stop, wait for the user's next message to resume ──────────
    if (call.name === 'askUserQuestion') {
      // GUARD: the previous assistant already contained a question + user has already replied → reject a second prompt.
      // Fixes the anti-pattern of "agent asked a question, user answered, agent then asks askUserQuestion pretending not to know".
      // Note: messages.length-1 is the current assistant (containing this tool_use); look back from its predecessor.
      const priorAssistantText = findLastAssistantText(messages, messages.length - 1);
      if (priorAssistantText) {
        const detected = detectUnclosedQuestion(priorAssistantText);
        if (detected.hasQuestion) {
          const lastUserMsg = findLastUserText(messages, messages.length - 1) ?? '';
          const rejection = renderAskGuardRejection(detected.snippet, lastUserMsg);
          console.log(
            `[ask-guard] session=${sessionId} rejected askUserQuestion (prior question: "${detected.snippet.slice(0, 40)}…")`,
          );
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: 'ask-guard 拦截一次 askUserQuestion 二次追问',
            meta: { gateName: 'AskGuard' },
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: rejection,
          });
          totalToolCallsThisTurn++;
          memory.actions.log({
            sessionId: GLOBAL_TIMELINE_SESSION_ID,
            toolName: call.name,
            params: call.input,
            result: 'rejected_by_ask_guard',
            success: false,
          });
          audit.append('self_domain_write', {
            source: 'ask_guard',
            origin: 'Internal',
            toolName: 'ask_guard_blocked',
            sessionId,
            priorQuestion: detected.snippet,
            userReply: lastUserMsg.slice(0, 200),
          });
          continue;
        }
      }

      // First call this tool's own execute (pure schema validation); treat failures as normal tool errors
      const validation = await tools.execute(call.name, call.input);
      if (!validation.success) {
        console.log(`[tool] askUserQuestion → fail: ${validation.error ?? ''}`);
        onTrace?.({
          kind: 'tool-result', tier: 3,
          text: summarizeToolResult(validation),
          meta: { toolName: call.name, success: false },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: truncateToolResultContent(formatToolResultContent(validation)),
        });
        totalToolCallsThisTurn++;
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: validation.error ?? null,
          success: false,
        });
        continue;
      }

      const question = String(call.input.question ?? '').trim();
      const optionsRaw = (call.input.options ?? []) as ReadonlyArray<{
        label: string;
        description?: string;
      }>;
      const allowFreeText = Boolean(call.input.allowFreeText);
      const rendered = renderQuestion(question, optionsRaw, allowFreeText);
      console.log(
        `[tool] askUserQuestion → pending (${optionsRaw.length} options${allowFreeText ? ', free-text ok' : ''})`,
      );
      // Deliver the question text directly to the user (do not prepend "📞 calling askUserQuestion";
      // that line is meaningless to the user and obscures the actual question)
      onDelta(rendered);

      const remainingCalls = calls.slice(calls.indexOf(call) + 1);
      pendingQuestion.set(sessionId, {
        toolCallId: call.id,
        question,
        options: optionsRaw,
        allowFreeText,
        remainingCalls,
        collectedResults: toolResults,
        iteration: startIteration,
        inflightMessages: [...messages],
        createdAt: Date.now(),
      });

      memory.actions.log({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        toolName: call.name,
        params: call.input,
        result: '__pending_user_response__',
        success: true,
      });

      return { outcome: { outcomeType: 'question_pending' }, auditEvents: audit.length };
    }

    const inputPreview = JSON.stringify(call.input).slice(0, 300);
    console.log(`[tool] ${call.name}(${inputPreview})`);
    // 2026-05-19 three-stream separation: tool call details → Tier 3 onTrace; semantic progress → Tier 2 onStatus
    onTrace?.({
      kind: 'tool-invocation', tier: 3,
      text: summarizeToolInvocation(call.name, call.input),
      meta: { toolName: call.name },
    });
    onStatus?.(semanticToolPhrase(call.name, call.input, statusLang));

    // 2026-05-07 #1: tool input defense layer. LLM providers occasionally concatenate multiple tool_use
    // arguments into a single string; passing it directly to tools.execute would throw TypeError and
    // corrupt messages history → next LLM call hits 400. Intercept and fix here.
    const sanitized = sanitizeToolInput(call.input);
    let result;
    if (sanitized.input === null) {
      console.warn(
        `[tool] ${call.name} → input rejected: ${sanitized.reason ?? 'unknown'} (path=${sanitized.path})`,
      );
      result = {
        success: false,
        output: '',
        error: `tool input 格式错误,已拦截: ${sanitized.reason ?? 'unknown'}`,
        duration: 0,
      };
    } else {
      if (sanitized.path !== 'object') {
        console.warn(
          `[tool] ${call.name} → input sanitized: path=${sanitized.path}` +
            (sanitized.truncatedTailLen ? ` truncated=${sanitized.truncatedTailLen}` : ''),
        );
      }
      if (isDeepExploreAdvance(call) && deepExploreAdvancesThisTurn >= 1) {
        console.warn(`[deep-explore] blocked 2nd advance this turn (one round/turn cap)`);
        result = { success: true, output: DEEP_EXPLORE_ONE_ROUND_MSG, duration: 0 };
      } else {
        if (isDeepExploreAdvance(call)) deepExploreAdvancesThisTurn++;
        result = await tools.execute(call.name, sanitized.input);
      }
    }
    const outPreview = (result.success ? result.output : result.error) ?? '';
    console.log(
      `[tool] ${call.name} → ${result.success ? 'ok' : 'fail'}: ${String(outPreview).slice(0, 200)}`
    );
    onTrace?.({
      kind: 'tool-result', tier: 3,
      text: summarizeToolResult(result),
      meta: { toolName: call.name, success: result.success },
    });
    if (!result.success) {
      onStatus?.(semanticToolFailPhrase(call.name, statusLang));
    }
    // Phase 10 M1 (2026-05-14): successful webFetch / readFile automatically persisted to FetchedResourceStore.
    // Failed / other tool: no-op. Hook is fully try/catch internally; main path is unaffected.
    // Phase 15.5 (2026-05-18): exclude the plan-files baseDir (plan.md is a PlanFileStore output
    // and should not be copied to local-plan.md in the workspace by fetched-store).
    persistToolResultIfFetched(
      fetchedStore,
      {
        toolName: call.name,
        params: call.input,
        success: result.success,
        output: result.output ?? '',
        error: result.error,
      },
      { sessionId, excludeDirs: [memory.planFiles.baseDir] },
    );
    const rawResultText = formatToolResultContent(result);
    toolResults.push({
      type: 'tool_result',
      tool_use_id: call.id,
      content: truncateToolResultContent(rawResultText),
    });
    totalToolCallsThisTurn++;
    // 2026-05-10: trace used by the in-turn failure pattern detector. Signature extraction needs raw
    // error / output text (extractFailureSignature normalizes it), so raw is passed.
    // 2026-05-17: http tool additionally stores toolInput (method/url) for
    // ScheduleOutcome aggregation at scheduled turn close.
    inTurnRecords.push({
      toolName: call.name,
      success: result.success,
      resultText: result.success ? (result.output ?? '') : (result.error ?? result.output ?? ''),
      toolInput: call.name === 'http' ? (call.input as Record<string, unknown>) : undefined,
    });
    // Layer 0.5: action persisted to global timeline; selected by time window during reflection
    memory.actions.log({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      toolName: call.name,
      params: call.input,
      result: (result.success ? result.output : result.error)?.slice(0, 500) ?? null,
      success: result.success,
    });
  }

  // All tools executed; push into message history and continue LLM conversation.
  // Defensive check: empty toolResults means the tool_use from the previous assistant message was all discarded
  // (e.g. an early grant path bug that did not put the pending call back in the queue); sending this to the LLM
  // would get "empty final user message" / structure mismatch 400. Fail fast to let the outer layer roll back.
  if (toolResults.length === 0) {
    throw new Error(
      `runToolLoop: refusing to push empty tool_result (calls=${calls.length}, collected=${collectedResults.length}) — upstream bug`,
    );
  }
  messages.push({ role: 'user', content: toolResults });

  // K2 HonestyGate: budget for final-text regeneration within the same turn. 0 = not used yet, 1 = already used.
  // Set cap=1 to prevent honesty/pledge infinite loops (the LLM will only ever be forced to rewrite once).
  let honestyAttempts = 0;
  // Tier 1.3 EmptyConclusionGate: budget for "empty conclusion" regeneration within the same turn; cap=1.
  // Counted independently from honestyAttempts; the two diagnose different conditions (lying vs not saying).
  let emptyConclusionAttempts = 0;
  // Phase 11 (2026-05-14): OutputFormatGate budget for "long text without a `## For User` section"
  // regeneration within the same turn; cap=1. Independent of the two above. env PHILONT_OUTPUT_FORMAT_GATE=0 to disable.
  let outputFormatAttempts = 0;
  // Phase 15 (2026-05-18): HalfFinishedGate budget for "slow task commitment-type final text + 0 actual progress"
  // regeneration within the same turn; cap=1. env PHILONT_HALF_FINISHED_GATE=0 to disable.
  // Successful plan_update_step count is derived from signalBus.inTurnRecords (no separate counter needed).
  let halfFinishedAttempts = 0;
  // Phase 17 (2026-05-18): PlanFailureFalseClaimGate budget for "plan was mechanically forced to failed
  // (circuit breaker), or LLM never properly converted the plan, but final text contains a completion claim"
  // regeneration within the same turn; cap=1.
  // Production mycox onboarding: plan-circuit-breaker fired but LLM output "MycoX registration complete";
  // honesty did not count register 404 as failure → lie slipped through. This gate uses mechanism-layer signals (circuit breaker /
  // placeholder plan still in draft) to directly determine a lie, without relying on honesty's tool result count.
  let planFailureFalseClaimAttempts = 0;

  // 2026-05-07: give the LLM one warning at max-3 (approaching the iter limit) so it wraps up rather than
  // continuing to explore. Injected only once to prevent spam.
  let iterWarningInjected = false;
  // 2026-05-10: in-turn failure pattern → reflection reminder. Injected only once per turn.
  let reflectionReminderInjected = false;
  // 2026-05-11: in-turn-reflection upgraded — once triggered, remaining calls to **the same tool** within this turn
  // are short-circuited by the mechanism layer (synthetic fail) to prevent the LLM from continuing to hit the wall.
  // Trigger logic: reflection.signature looks like `<toolName>:<errorClass>` → extract toolName
  // as the block list for the remainder of this turn. Auto-cleared on the next user turn (variable is turn-local).
  let blockedToolAfterReflection: string | null = null;
  // Phase 11 (2026-05-14): ResearchBeforeRetry — must do research before retrying business tools after failure.
  // in-turn-reflection triggered + no research calls this turn → set flag.
  // Any business tool (non-research / non-plan-gate-exempt) is blocked until the LLM makes one
  // research tool call (readFile / webFetch / search_skills / list_facts etc.).
  // env PHILONT_RESEARCH_BEFORE_RETRY=0 to disable.
  let researchRequiredBeforeBusinessTool = false;
  let researchTriggerContext: { failedTool: string; signature: string } | null =
    null;
  // 2026-05-12 Phase 7 hardening 2: after in-turn-reflection fires, automatically promote to slow + create a placeholder plan
  // (or inject a plan_revise hint for an already-reviewed plan). Triggered only once per turn.
  let autoRevisePlanInjected = false;
  // Phase 11 constitutional amendment (2026-05-15): plan factory circuit breaker.
  // Production (mycox-heartbeat) revealed: after failure, LLM enters "plan_draft fails → plan_revise fails →
  // plan_close fails → auto-revise-on-fail creates another placeholder → fails again" infinite loop;
  // 8 plans / N reflections / massive token waste. This mechanism triggers when same-turn plan_* failures accumulate ≥ N → force fast mode +
  // inject wrap-up hint. env PHILONT_PLAN_CIRCUIT_BREAKER_AT to set threshold (default 3; set 0 to disable).
  // Triggered only once per turn.
  let planCircuitBroken = false;
  for (let i = startIteration + 1; i < effectiveMax; i++) {
    // Interrupt teeth: user stopped → exit before the next LLM call.
    if (stopped()) return interruptedReturn();
    // 2026-05-13: within the tool loop, compaction only triggers at the hard-cap (default 250K) as a safety net
    // to prevent the LLM context window from truly overflowing. Soft-threshold (default 180K) compaction is reserved
    // for the "quiet period" at turn entry — to avoid compaction mid-plan/tool chain breaking precise IDs like plan_id.
    await maybeCompact(messages, sessionId, 'hard');

    // Phase 11 constitutional amendment (2026-05-15): plan factory circuit breaker.
    // Same-turn accumulation of ≥ N plan_* failures → force fast mode (allow business tools) + inject wrap-up hint.
    // Unlike in-turn-reflection (which uses same-root-cause signatures), this mechanism specifically monitors the plan factory loop
    // (plan_draft failures / plan_revise failures / plan_close failures all counted regardless of cause).
    if (!planCircuitBroken) {
      const threshold = Number(process.env.PHILONT_PLAN_CIRCUIT_BREAKER_AT ?? 3);
      if (threshold > 0) {
        const planFailures = inTurnRecords.filter(
          (r) => r.toolName.startsWith('plan_') && !r.success,
        ).length;
        if (planFailures >= threshold) {
          planCircuitBroken = true;
          signalBus.planCircuitBroken = true;
          const wasMode = taskModeStore.get(sessionId);
          if (wasMode === 'slow') {
            taskModeStore.set(
              sessionId,
              'fast',
              `auto:plan-circuit-breaker:${planFailures}-failures`,
            );
          }
          console.warn(
            `[plan-circuit-breaker] session=${sessionId} plan_* failed ${planFailures}x, downgrade ${wasMode}→fast + inject wrap-up hint`,
          );
          audit.append('self_domain_write', {
            source: 'plan_circuit_breaker',
            origin: 'Internal',
            toolName: 'plan_circuit_breaker_tripped',
            sessionId,
            planFailures,
            wasMode,
          });
          messages.push({
            role: 'user',
            content:
              `[plan-circuit-breaker] 你已经在本 turn 内累计 ${planFailures} 次 plan_* 工具失败` +
              `(plan_draft / plan_revise / plan_close 之类)。机制层判定 plan 协议在本 turn 已不可恢复,` +
              `**降级回 fast 模式** + 不再强制 plan 协议。\n\n` +
              `下一步必须直接收尾:\n` +
              `  1. 若任务已部分完成 → 用 \`## For User\` 段如实汇报已完成的部分 + 未完成的部分,**不要再调任何 plan_* 工具**\n` +
              `  2. 若需要持续性任务(周期 check-in 等)→ 调 schedule_reminder 设定,然后再 \`## For User\` 段\n` +
              `  3. **禁止**继续 plan_draft / plan_revise / plan_close — 已被本 turn 拉黑\n\n` +
              `下次同类任务时,reflection 路径会蒸馏出 routing_rule 帮你绕过本次的失败模式。`,
          });
          onTrace?.({
            kind: 'loop-control', tier: 4,
            text: `plan 工具失败 ${planFailures}x,机制层降级收尾`,
          });
        }
      }
    }

    // 2026-05-10: in-turn reflection trigger — **when same-root-cause failures ≥ 2** (i.e. the first repeat)
    // give a one-shot reminder "reflect before acting, do not just retry". Generic mechanism (applies to any
    // tool / service / skill). Complements turn-close reflection.ts:
    //   - reflection.ts: post-hoc, writes routing rule / playbook at turn close for next time
    //   - in-turn (this mechanism): mid-turn stop, LLM immediately self-corrects this turn
    // Reason for threshold 2 not 3: 1 failure LLM naturally pivots (transient glitch); 2 same-signature
    // is the earliest evidence of "LLM not self-correcting". Each wasted retry is expensive.
    if (!reflectionReminderInjected) {
      const reflection = detectInTurnFailurePattern(inTurnRecords, 2);
      if (reflection.triggered) {
        reflectionReminderInjected = true;
        messages.push({ role: 'user', content: reflection.reminder! });
        onTrace?.({
          kind: 'loop-control', tier: 4,
          text: `同根因失败 ${reflection.count}x,触发反思提醒`,
        });
        // 2026-05-11: extract toolName from the signature head as the block list for the rest of this turn.
        // Signature looks like `http:http-401` / `webFetch:other:...` / `shell:cmd-not-found:rg`;
        // toolName is before the first colon. Graceful degradation on failure: if parsing fails, do not block; only inject reminder.
        if (reflection.signature) {
          const colonIdx = reflection.signature.indexOf(':');
          if (colonIdx > 0) {
            blockedToolAfterReflection = reflection.signature.slice(0, colonIdx);
            signalBus.inTurnToolBlockFired = true;
            console.warn(
              `[in-turn-tool-block] session=${sessionId} remaining calls to ${blockedToolAfterReflection} this turn are mechanism-layer disabled`,
            );

            // Phase 11 (2026-05-14): simultaneously check if ResearchBeforeRetry is needed.
            // Trigger condition: in-turn-reflection fire + no research calls this turn
            if (
              process.env.PHILONT_RESEARCH_BEFORE_RETRY !== '0' &&
              !researchRequiredBeforeBusinessTool &&
              !hasResearchCallInTurn(inTurnRecords)
            ) {
              researchRequiredBeforeBusinessTool = true;
              researchTriggerContext = {
                failedTool: blockedToolAfterReflection,
                signature: reflection.signature,
              };
              console.warn(
                `[research-before-retry] session=${sessionId} triggered: no research call this turn, business tools blocked after ${reflection.signature}`,
              );
              audit.append('self_domain_write', {
                source: 'research_before_retry',
                origin: 'Internal',
                toolName: 'research_before_retry_fired',
                sessionId,
                failedTool: blockedToolAfterReflection,
                signature: reflection.signature,
              });
            }
          }
        }
        console.warn(
          `[in-turn-reflection] session=${sessionId} signature=${reflection.signature} count=${reflection.count}`,
        );
        audit.append('self_domain_write', {
          source: 'in_turn_reflection',
          origin: 'Internal',
          toolName: 'reflection_reminder_injected',
          sessionId,
          signature: reflection.signature ?? '',
          count: reflection.count ?? 0,
        });

        // 2026-05-12 Phase 7 hardening 2: in-turn-reflection fires → auto-promote to slow + create placeholder plan
        // (or inject plan_revise hint for an already-reviewed plan).
        // Co-exists with blockedToolAfterReflection: tool layer blocks the specific tool + protocol layer forces revise.
        // Triggered only once per turn. env flag PHILONT_AUTO_REVISE_ON_FAIL=0 to disable.
        //
        // 2026-05-15 skip benign misses: research/lookup tools (get_fact/list_facts/search_* etc.)
        // "not found" is fundamentally "no results", not "hitting a wall". Treating it as a wall would
        // erroneously promote simple queries (e.g. "look up my info") to slow + placeholder plan + block subsequent store_fact.
        // The correct response to a benign miss is the LLM informing the user nothing is stored / storing it, not changing the protocol.
        //
        // 2026-05-15 (tail fix): skip "mechanism-layer intentional reject" type signatures.
        // Production mycox: after plan completed, LLM calls http to verify → plan_protocol_gate rejects
        // → in-turn-reflection same-root-cause 2x → auto-revise-on-fail creates another placeholder plan.
        // Infinite loop risk. These rejects are not real wall collisions; they are ON-PURPOSE protocol-layer stops
        // and should not trigger plan escalation.
        // Signature head pattern: `<tool>:other:[<mechanism>_<name>]` (square bracket + mechanism name marker).
        const isMechanismReject = /:other:\[(plan_protocol_gate|in_turn_tool_block|autonomous_blacklist|research[_-]?before[_-]?retry)\b/i.test(
          reflection.signature ?? '',
        );
        const isBenignMiss =
          /^(get_fact|list_facts|search_notes|search_skills|search_kb|recall_sessions):/i.test(
            reflection.signature ?? '',
          ) ||
          /(?::|^)(未找到|not_found|not found|empty|no results?)\b/i.test(
            reflection.signature ?? '',
          ) ||
          isMechanismReject;
        if (isBenignMiss) {
          const skipReason = isMechanismReject ? 'mechanism-layer active reject' : 'benign miss';
          console.log(
            `[auto-revise-on-fail] session=${sessionId} skipped (${skipReason}, no escalation): ${reflection.signature}`,
          );
        }
        if (
          process.env.PHILONT_AUTO_REVISE_ON_FAIL !== '0' &&
          !autoRevisePlanInjected &&
          reflection.signature &&
          !isBenignMiss
        ) {
          autoRevisePlanInjected = true;
          const sigHash = createHash('sha1')
            .update(reflection.signature)
            .digest('hex')
            .slice(0, 8);

          // 2.1 Auto-promote to slow (if currently fast)
          if (taskModeStore.get(sessionId) === 'fast') {
            taskModeStore.set(
              sessionId,
              'slow',
              `auto:in-turn-fail:${reflection.signature}`,
            );
            audit.append('self_domain_write', {
              source: 'auto_revise_on_fail',
              origin: 'Internal',
              toolName: 'task_mode_auto_slow_after_fail',
              sessionId,
              signature: reflection.signature,
            });
            console.log(
              `[auto-revise-on-fail] session=${sessionId} fast→slow due to ${reflection.signature}`,
            );
          }

          // 2.2 Get active plan + branch handling
          try {
            const sessionPlans = memory.plans.listBySession(sessionId, {
              limit: 1,
            });
            const lastPlan = sessionPlans[0];

            if (
              !lastPlan ||
              lastPlan.status === 'completed' ||
              lastPlan.status === 'failed'
            ) {
              // Path A: no active plan → create a "diagnose-fix-retry" three-step placeholder plan
              const placeholder = memory.plans.create({
                sessionId,
                taskSignature: `recovery-${sigHash}`,
                guideRef: `auto-recovery:${reflection.signature}`,
                // M3 / Phase 11 (2026-05-15): placeholder plan marked with isPlaceholder=true.
                isPlaceholder: true,
                steps: [
                  {
                    id: 'diagnose',
                    description: `诊断 ${reflection.signature} 根因(看最近 ${reflection.count} 条失败 tool_result,抽 errorClass + 路径/参数差异)`,
                  },
                  {
                    id: 'revise',
                    description: `调 plan_revise 把 steps 改成绕过此根因的新方案(换工具 / 换参数 / 换 endpoint)`,
                  },
                  {
                    id: 'retry',
                    description: `按新 plan 执行 1-2 步验证;仍失败 → plan_close failure 写 playbook`,
                  },
                ],
              });
              audit.append('self_domain_write', {
                source: 'auto_revise_on_fail',
                origin: 'Internal',
                toolName: 'auto_recovery_plan_created',
                sessionId,
                planId: placeholder.id,
                signature: reflection.signature,
              });
              console.log(
                `[auto-revise-on-fail] session=${sessionId} created placeholder plan ${placeholder.id} sig=${reflection.signature}`,
              );
            } else if (lastPlan.status === 'executing') {
              // Path B: active plan in executing → inject user-role hint (M3 removed 'reviewed')
              const guide = [
                `[内驱 auto-revise-hint] 你的活 plan ${lastPlan.id} (executing) 在执行中遭遇 ${reflection.count}x 同根因失败 (${reflection.signature})。`,
                `**立即调 plan_revise({ plan_id: "${lastPlan.id}", new_steps: [...], reason: "${reflection.signature} 同根因失败" })** 替换 steps,绕过此根因。`,
                `revise 后 plan 回 draft,调 plan_update_step(status="doing") 重新执行。`,
              ].join('\n');
              messages.push({ role: 'user', content: guide });
              audit.append('self_domain_write', {
                source: 'auto_revise_on_fail',
                origin: 'Internal',
                toolName: 'auto_revise_hint_injected',
                sessionId,
                planId: lastPlan.id,
                signature: reflection.signature,
              });
            }
            // Path C: lastPlan.status === 'draft' → no intervention; plan_protocol_gate
            // naturally forces LLM to call plan_update_step (to enter executing) or plan_revise (to change the approach)
          } catch (e) {
            console.warn(
              `[auto-revise-on-fail] session=${sessionId} failed (ignored):`,
              e,
            );
          }
        }
      }
    }

    // Approaching limit warning: insert a system reminder at max-3
    if (!iterWarningInjected && i >= effectiveMax - 3) {
      iterWarningInjected = true;
      messages.push({
        role: 'user',
        content:
          `[drive iter-warning] You have used ${i}/${effectiveMax} tool-call rounds and are approaching the limit.\n` +
          `**Wrap up immediately**: organize the information you have collected into a reply for the user (## For User / ## Work Log two-section format). ` +
          `Do not make any more pointless tool calls. If you must call one more, pick the 1-2 most critical, then produce your final reply.\n` +
          `This is an intra-turn internal correction. Do not surface this reminder to the user.`,
      });
      onStatus?.(summarizingPhrase(statusLang));
    }

    const response = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);

    if (response.type === 'text') {
      // K2 HonestyGate: verify "completion claim vs actual tool results" **before** onDelta pushes text to the user.
      // If high severity hits and budget is not used → inject a reminder message to make the LLM
      // regenerate once so the lie never leaves.
      if (honestyAttempts < 1) {
        const recentToolResults = extractRecentToolResults(messages);
        // Ground truth for the deep_explore honesty checks: the owner-scoped active reasoning session's
        // tree state (null if none). Lets the gate catch "全部闭合 / proved / 最终判决" claims the tree
        // doesn't support, and round-result narration with no actual round this turn.
        const ownerReasoning = memory.reasoning.getMostRecentActiveSession(sessionId);
        const honesty = evaluateHonesty(response.content, {
          toolResults: recentToolResults,
          reasoningState: ownerReasoning ? memory.reasoning.summarizeSession(ownerReasoning.id) : null,
        });
        if (!honesty) {
          // Explicitly print "passed" status so tests can see the gate actually ran + no false positives
          const okN = recentToolResults.filter((r) => r.content.startsWith('✓')).length;
          const failN = recentToolResults.filter((r) => r.content.startsWith('⚠')).length;
          console.log(
            `[honesty] session=${sessionId} passed (${okN} ok / ${failN} fail / ${recentToolResults.length} total)`,
          );
        }
        if (honesty) {
          honestyAttempts++;
          audit.append('self_domain_write', {
            source: 'honesty_gate',
            origin: 'Internal',
            toolName: 'honesty_gate_fired',
            sessionId,
            severity: honesty.severity,
            reason: honesty.reason,
            failCount: honesty.failCount,
            okCount: honesty.okCount,
            matchedClaim: honesty.matchedClaim,
          });
          console.warn(
            `[honesty] session=${sessionId} fired severity=${honesty.severity} reason=${honesty.reason} failCount=${honesty.failCount} okCount=${honesty.okCount} claim="${honesty.matchedClaim}"`,
          );
          // K7→K8 bridge: write fire to signalBus so the finally block produces a K8 initiative.
          // Take **the most recent** fire (honestyAttempts cap is 1 per turn; at most one overwrite).
          signalBus.honesty = {
            evaluation: honesty,
            toolResults: recentToolResults,
            assistantText: response.content,
          };
          // Leave what the LLM was about to say in messages (so it knows it almost lied / lacked verification),
          // then append an Internal-origin user message demanding a rewrite or verification first. The LLM
          // on the next iteration will see this reminder + its previous draft + actual tool results.
          messages.push({ role: 'assistant', content: response.content });
          // K9 Path B: upgrade "reactive negation" to "negation + step-by-step guidance";
          // following a procedure is more actionable for the LLM than simply saying "don't lie".
          // Each severity level has its own standard correction routine.
          let reminder: string;
          if (honesty.reason === 'fabricated_size_claim') {
            reminder =
              `[drive Honesty/fabricated_size] You just said "${honesty.matchedClaim}", but ${honesty.evidence}\n\n` +
              `**Verification steps (execute in order)**:\n` +
              `  1. Check the actual "bytes" value in the most recent stat / dir / ls / readFile / tool JSON output;\n` +
              `  2. **Compute the ratio**: claimed value ÷ actual value. E.g. claimed 577 KB / actual 18 bytes ≈ 30,000×.\n` +
              `     - Ratio < 1.5×: likely a unit conversion or rounding error — rewrite with the correct value;\n` +
              `     - Ratio > 10×: **this is fabrication, not an error** — tell the user the actual size in bytes;\n` +
              `  3. When rewriting, use the number the tool actually returned (rounding is fine, but do not invent a number);\n` +
              `  4. If the tool returned an anomalous value (e.g. an 18-byte .docx — files < 256 bytes are usually a JSON error body, not real binary),\n` +
              `     tell the user honestly "this looks wrong — the API may have returned an error response" — **do not pretend success**.\n\n` +
              `This is an intra-turn internal correction. Do not surface this reminder to the user.`;
          } else if (honesty.severity === 'high') {
            reminder =
              `[drive Honesty/high] Your draft reply contains a completion claim "${honesty.matchedClaim}", but ${honesty.evidence}\n\n` +
              `**Verification steps (execute in order)**:\n` +
              `  1. Re-read each tool_result prefix: ✓ TOOL OK / ⚠ TOOL FAILED;\n` +
              `  2. List the names of failing commands + exit code / error message (copy key sentences from ⚠ sections);\n` +
              `  3. In one sentence, distinguish: **what succeeded / what failed / what the user should do next**;\n` +
              `  4. Do not repeat "${honesty.matchedClaim}" — a success claim inconsistent with the failure count is a falsehood;\n` +
              `  5. If there is an untried reasonable path (different command / path / permissions), try one more tool call.\n\n` +
              `This is an intra-turn internal correction. Do not surface this reminder to the user.`;
          } else if (honesty.reason === 'memory_claim_without_write') {
            reminder =
              `[drive Honesty/memory_claim] You said "${honesty.matchedClaim}" but did not call store_fact — ${honesty.evidence}\n\n` +
              `**Pick one of two paths — do not straddle**:\n` +
              `  Path A · Actually persist: call store_fact(namespace, key, value), then reply to the user;\n` +
              `    - Preference/constraint → namespace=user, key=preferences.X / constraints.X\n` +
              `    - Project-related → namespace=project\n` +
              `    - Before writing, call get_fact to check existing value and merge rather than overwrite\n` +
              `  Path B · Correct yourself: honestly tell the user "I cannot persist that — please remind me next time" — do not pretend to have remembered.\n\n` +
              `This is an intra-turn internal correction. Do not surface this reminder to the user.`;
          } else {
            reminder =
              `[drive Honesty/${honesty.reason}] Your draft reply contains a completion claim "${honesty.matchedClaim}", but ${honesty.evidence}\n\n` +
              `**Principle: your reply must state facts, not subjective assertions.**\n` +
              `  ✓ Factual: "wrote /tmp/out.json (2.3 KB); stat shows mtime=now"\n` +
              `  ✗ Subjective: "done" / "completed" / "handled" — the user cannot verify these\n\n` +
              `**Ask yourself — if the user goes to verify right now, is this claim true?**\n` +
              `  - Not sure → you must verify first, then reply\n` +
              `  - Sure → include the evidence in your reply\n\n` +
              `**Artifact verification steps (execute in order)**:\n` +
              `  1. Call an observation tool to confirm the artifact exists and is reasonable:\n` +
              `     - File: readFile(path) or glob(pattern) or shell "stat path"\n` +
              `     - Edit: readFile to check that the expected new content is present\n` +
              `     - Create: glob to confirm the file is really at the expected path\n` +
              `     - API: call the read endpoint again to verify (e.g. GET /resource/{id})\n` +
              `  2. If verification reveals a problem → tell the user honestly and correct it — do not conceal;\n` +
              `  3. If verification confirms the claim → include concrete numbers / ids / paths / timestamps in your reply:\n` +
              `     ✓ "POST /register returned 201, user_id=abc123, stored via store_fact to project.<svc>.user_id"\n` +
              `     ✓ "wrote /tmp/out.json 2.3 KB, inspectPath confirms mtime=now + size > 0"\n` +
              `     ✗ "registration done" — no facts, same as saying nothing\n\n` +
              `This is an intra-turn internal correction. Do not surface this reminder to the user.`;
          }
          messages.push({ role: 'user', content: reminder });
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: `Honesty gate triggered (${honesty.severity}), verifying / rewriting`,
            meta: { gateName: 'Honesty', severity: honesty.severity },
          });
          continue;
        }
      }

      // Tier 1.3 EmptyConclusionGate: last line of defense before final emit —
      // HonestyGate handles "lying"; EmptyConclusionGate handles "did a bunch of things but said nothing".
      // In the PDF→Word case, after 3 shell calls the LLM returned only ".".
      if (emptyConclusionAttempts < 1) {
        const empty = evaluateEmptyConclusion({
          toolCallsThisTurn: totalToolCallsThisTurn,
          finalText: response.content,
        });
        if (empty.shouldRegenerate) {
          emptyConclusionAttempts++;
          // 2026-05-11 Phase 3: mark signalBus so that routing outcome backflow at turn close knows this turn failed
          signalBus.emptyConclusionFired = true;
          audit.append('self_domain_write', {
            source: 'empty_conclusion_gate',
            origin: 'Internal',
            toolName: 'empty_conclusion_gate_fired',
            sessionId,
            reason: empty.reason,
            toolCallsThisTurn: totalToolCallsThisTurn,
            finalTextLength: empty.detail?.finalTextLength ?? 0,
          });
          console.warn(
            `[empty-conclusion] session=${sessionId} fired reason=${empty.reason} toolCalls=${totalToolCallsThisTurn} finalLen=${empty.detail?.finalTextLength}`,
          );
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content:
              `[drive EmptyConclusion] You made ${totalToolCallsThisTurn} tool calls this turn, but your final reply was ` +
              (empty.reason === 'empty_after_tools' ? 'completely empty' : `too short (only "${response.content.trim()}")`) +
              `. In one sentence, tell the user: what those calls did, what the result was, and what happens next.\n` +
              `This is an intra-turn internal correction. Do not surface this reminder to the user.`,
          });
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: 'EmptyConclusion gate triggered, adding summary',
            meta: { gateName: 'EmptyConclusion' },
          });
          continue;
        }
      }

      // Phase 15 (2026-05-18) HalfFinishedGate: "half-done and stopped" detection for slow tasks.
      //
      // Production root cause: after a few tool calls the LLM outputs "let me look first / I'm about to X" commitment text
      // and ends the turn, but the channel is fire-and-forget so the user never returns for the next turn.
      // Task hanging = heartbeat not started = onboarding half-done.
      //
      // Detection conditions (all generic; see half_finished_gate.ts):
      //   mode=slow + placeholder plan still in draft + commitment-type phrasing + 0 plan_update_step + no completion claim
      // Hit → cap=1 regen; inject strong constraint prompt to make the LLM actually advance the plan.
      //
      // env PHILONT_HALF_FINISHED_GATE=0 to disable.
      if (
        halfFinishedAttempts < 1 &&
        process.env.PHILONT_HALF_FINISHED_GATE !== '0'
      ) {
        try {
          const sidForHF = sessionId;
          const currentModeHF = taskModeStore.get(sidForHF);
          const sessionPlansHF = memory.plans.listBySession(sidForHF, { limit: 1 });
          const activePlanHF = sessionPlansHF[0];
          const planUpdateStepOk = (signalBus.inTurnRecords ?? []).filter(
            (r) => r.toolName === 'plan_update_step' && r.success,
          ).length;
          const hf = detectHalfFinishedTurn(response.content, {
            mode: currentModeHF === 'slow' ? 'slow' : 'fast',
            hasPlaceholderPlanInDraft:
              !!activePlanHF &&
              activePlanHF.status === 'draft' &&
              activePlanHF.isPlaceholder === true,
            hasPlanUpdateStepCallInTurn: planUpdateStepOk > 0,
          });
          if (hf) {
            halfFinishedAttempts++;
            audit.append('self_domain_write', {
              source: 'half_finished_gate',
              origin: 'Internal',
              toolName: 'half_finished_gate_fired',
              sessionId,
              reason: hf.reason,
              matchedPhrase: hf.matchedPhrase,
              planUpdateStepOk,
              activePlanId: activePlanHF?.id ?? null,
            });
            console.warn(
              `[half-finished] session=${sessionId} fired reason=${hf.reason} phrase="${hf.matchedPhrase}" planUpdateOk=${planUpdateStepOk}`,
            );
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
              role: 'user',
              content:
                `[drive HalfFinished] You just output "${hf.matchedPhrase}" — but this turn has a placeholder plan for a slow task,` +
                ` no plan_revise to promote it, and 0 plan_update_steps — equivalent to leaving without doing anything.\n\n` +
                `**This channel is fire-and-forget** — the user sends a message and moves on. "Let me look at this first / I'll do it next..." = task left hanging.\n\n` +
                `**Analogy: coding in Claude Code** — the plan is the code, tool calls are the runtime. You would not "study it and write it another day"; you plan + write + run + debug right now.\n\n` +
                `**This turn you must choose one of two paths**:\n` +
                `1. Make real progress — call plan_revise to split deliverables → plan_update_step("doing") → tool calls → plan_close\n` +
                `2. Genuinely blocked — call askUserQuestion (specifying what user input is missing) or plan_close(failure, "<specific blocker>")\n\n` +
                `**Do not repeat** promise-style phrases / "let me / I'll / next / later" etc. Reorganize your response.\n\n` +
                `This is an intra-turn internal correction. Do not surface this reminder to the user.`,
            });
            onTrace?.({
              kind: 'internal-gate', tier: 4,
              text: 'HalfFinished gate triggered, forcing substantive progress this turn',
              meta: { gateName: 'HalfFinished' },
            });
            continue;
          }
        } catch (e) {
          console.warn('[half-finished] detector failed (ignored):', e);
        }
      }

      // Phase 17 (2026-05-18) PlanFailureFalseClaimGate: plan was mechanically forced to failed
      // (circuit breaker), or placeholder plan still in draft + LLM never called plan_close,
      // but final text contains a completion claim → cap=1 regen forces an honest admission of failure.
      //
      // Complements HonestyGate: HonestyGate relies on tool_result fail count; production revealed
      // register 404 and similar failures sometimes do not enter the fail count (extractRecentToolResults window /
      // formatToolResultContent prefix boundary etc.). This gate directly uses mechanism-layer signals (planCircuitBroken /
      // placeholder + no close) to determine failure state, **without relying on toolResults count**, plugging the honesty gap.
      //
      // env PHILONT_PLAN_FAILURE_GATE=0 to disable.
      if (
        planFailureFalseClaimAttempts < 1 &&
        process.env.PHILONT_PLAN_FAILURE_GATE !== '0'
      ) {
        try {
          const sidForFG = sessionId;
          const claim = findCompletionClaim(response.content);
          // Signal 1: plan-circuit-breaker fired
          const circuitBroken = signalBus.planCircuitBroken === true;
          // Signal 2: placeholder plan still in draft + LLM never truly called plan_close
          let placeholderUnclosed = false;
          if (!circuitBroken && !signalBus.planCloseCalled) {
            const sessionPlans = memory.plans.listBySession(sidForFG, { limit: 1 });
            const active = sessionPlans[0];
            placeholderUnclosed =
              !!active &&
              active.isPlaceholder === true &&
              (active.status === 'draft' || active.status === 'executing');
          }
          const fired = (circuitBroken || placeholderUnclosed) && !!claim;
          if (fired) {
            planFailureFalseClaimAttempts++;
            const reason = circuitBroken
              ? 'circuit_breaker_fired'
              : 'placeholder_plan_unclosed';
            audit.append('self_domain_write', {
              source: 'plan_failure_false_claim_gate',
              origin: 'Internal',
              toolName: 'plan_failure_false_claim_gate_fired',
              sessionId,
              reason,
              matchedClaim: claim,
            });
            console.warn(
              `[plan-failure-false-claim] session=${sessionId} fired reason=${reason} claim="${claim}"`,
            );
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
              role: 'user',
              content:
                `[drive PlanFailureFalseClaim] Your final text contains "${claim}", but the mechanism layer determined that this turn's plan failed ` +
                `(${
                  circuitBroken
                    ? 'plan circuit-breaker fired = plan_* tools repeatedly failed; the task was not actually completed'
                    : 'placeholder plan is still draft + you never called plan_close = task left half-done'
                }).\n\n` +
                `**Do not lie**: this turn was a failure. Rewrite the final text:\n` +
                `1. **Do not include** completion claims like "completed / succeeded / done / finished"\n` +
                `2. Honestly state which deliverables failed, which were not done, and the root cause (from tool error / circuit-breaker reason)\n` +
                `3. If user action is needed (e.g. new invite_code / new credential / different param) → use \`## For User\` to write clearly "please provide X"\n` +
                `4. If some steps (e.g. schedule_reminder) succeeded while others failed → say honestly "setup partially succeeded, but register failed → heartbeat not started"\n\n` +
                `This is an intra-turn internal correction. Do not surface this reminder to the user.`,
            });
            onTrace?.({
              kind: 'internal-gate', tier: 4,
              text: 'PlanFailureFalseClaim gate triggered, forcing honest failure acknowledgement',
              meta: { gateName: 'PlanFailureFalseClaim' },
            });
            continue;
          }
        } catch (e) {
          console.warn('[plan-failure-false-claim] detector failed (ignored):', e);
        }
      }

      // Phase 11 OutputFormatGate: last line of defense before final emit —
      // long final text (> 500 chars) but no `## For User` section → regenerate once; force the LLM
      // to use the standard two-section format. EmptyConclusionGate handles "said nothing"; OutputFormatGate handles
      // "said something but no section breaks" (WeChat and similar channels rely on ## For User to extract push content).
      //
      // env PHILONT_OUTPUT_FORMAT_GATE=0 to disable.
      if (
        outputFormatAttempts < 1 &&
        process.env.PHILONT_OUTPUT_FORMAT_GATE !== '0'
      ) {
        const fmt = evaluateOutputFormat({ finalText: response.content });
        if (fmt.shouldRegenerate) {
          outputFormatAttempts++;
          audit.append('self_domain_write', {
            source: 'output_format_gate',
            origin: 'Internal',
            toolName: 'output_format_gate_fired',
            sessionId,
            reason: fmt.reason,
            finalTextLength: fmt.detail?.finalTextLength ?? 0,
          });
          console.warn(
            `[output-format] session=${sessionId} fired reason=${fmt.reason} finalLen=${fmt.detail?.finalTextLength}`,
          );
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content:
              `[drive OutputFormat] Your reply was ${fmt.detail?.finalTextLength} characters but did not use the required two-section format ` +
              `(missing \`## For User\` heading). The frontend extracts content from the \`## For User\` section to push to users; ` +
              `without it, the full text is sent as a fallback (verbose and unfocused).\n\n` +
              `**Please rewrite your final reply** using the strict two-section format:\n` +
              `\n  ## For User\n` +
              `  (Core conclusion pushed to the user — ≤ 200 chars, action result + key evidence + next step)\n` +
              `\n  ## Work Log\n` +
              `  (Full process / tool call details / intermediate data — goes into timeline; user does not see this)\n` +
              `\nThis is an intra-turn internal correction. Do not surface this reminder to the user.`,
          });
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: 'OutputFormat gate triggered, rewriting two-section format',
            meta: { gateName: 'OutputFormat' },
          });
          continue;
        }
      }

      // Anti-fabrication: block a tool-loop text response that claims deep_explore round/session
      // results when no deep_explore tool actually ran this turn (e.g. it called list_facts then
      // invented "第N轮/时间帽"). A response that did call deep_explore reports legitimately.
      const safeText = guardDeepExploreFabrication(response.content, signalBus);
      messages.push({ role: 'assistant', content: safeText });
      onDelta(safeText);
      // Layer 0 append: assistant text response goes into the global timeline
      memory.raw.appendMessage({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        role: 'assistant',
        content: safeText,
      });
      return { outcome: { outcomeType: 'response', text: safeText }, auditEvents: audit.length };
    }

    // Same as #1: subsequent loop iterations also need to sanitize assistantMessage tool_use blocks
    const sanitizedAsst2 = sanitizeAssistantMessageBlocks(response.assistantMessage);
    if (sanitizedAsst2.stats.fixed > 0 || sanitizedAsst2.stats.rejected > 0) {
      console.warn(
        `[input-fix] assistantMessage tool_use blocks: total=${sanitizedAsst2.stats.totalToolUse} ` +
          `fixed=${sanitizedAsst2.stats.fixed} rejected=${sanitizedAsst2.stats.rejected}`,
      );
    }
    messages.push(sanitizedAsst2.msg);

    const nextResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

    for (const call of response.calls) {
      // Interrupt teeth: user stopped → no longer execute subsequent tools; exit early.
      if (stopped()) return interruptedReturn();
      const classification = tools.classify(call.name);
      if (!classification) {
        nextResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: Unknown tool '${call.name}'` });
        totalToolCallsThisTurn++;
        continue;
      }

      // 2026-05-10: autonomous turn blacklist check must also be applied inside the main loop branch
      // (previously only checked on initial calls; subsequent iterations were missed)
      if (isAutonomousTurn && AUTONOMOUS_TURN_BLACKLIST.has(call.name)) {
        const reason =
          `Autonomous heartbeat turns may not call ${call.name}. ` +
          `Continue with read-only tools (http / readFile / list_facts / get_fact / search_notes / search_skills), ` +
          `or use store_note(importance=high) to leave a note for the user to handle next turn.`;
        console.warn(
          `[autonomous-blacklist] session=${sessionId} rejected ${call.name} (in main loop)`,
        );
        nextResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reason,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reason,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_autonomous_blacklist',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'autonomous_blacklist',
          origin: 'Internal',
          toolName: 'autonomous_tool_blocked',
          sessionId,
          blockedTool: call.name,
        });
        continue;
      }

      // Phase 11 ResearchBeforeRetry(2026-05-14):
      // - calls research tool → unlocks flag (LLM has shown research intent)
      // - calls business tool (non-research, non-plan-gate exempt) and flag=true → blocked
      // - calls plan-gate exempt (plan_* / task_mode_classify) → not affected
      if (
        researchRequiredBeforeBusinessTool &&
        researchTriggerContext &&
        !isResearchTool(call.name) &&
        !isPlanGateExempt(call.name, classification, call.input)
      ) {
        const reminder = buildResearchReminder(
          researchTriggerContext.failedTool,
          researchTriggerContext.signature,
          call.name,
        );
        console.warn(
          `[research-before-retry] session=${sessionId} rejected ${call.name} (must research first, signature ${researchTriggerContext.signature})`,
        );
        nextResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reminder,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reminder,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_research_before_retry',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'research_before_retry',
          origin: 'Internal',
          toolName: 'research_before_retry_blocked',
          sessionId,
          blockedTool: call.name,
          failedTool: researchTriggerContext.failedTool,
          signature: researchTriggerContext.signature,
        });
        continue;
      }
      if (researchRequiredBeforeBusinessTool && isResearchTool(call.name)) {
        // LLM chose to do research → unlock. Reset flag; next business tool call will be allowed.
        researchRequiredBeforeBusinessTool = false;
        console.log(
          `[research-before-retry] session=${sessionId} unlocked: ${call.name} is a research tool, business tools allowed`,
        );
      }

      // 2026-05-11: in-turn-reflection upgraded — once triggered, remaining calls to **the same tool** within this turn
      // are short-circuited by the mechanism layer (intercepted before PolicyGate). toolName from the signature head determines which.
      // Graceful degradation: if parsing fails → blockedToolAfterReflection stays null; normal flow unaffected.
      if (blockedToolAfterReflection !== null && call.name === blockedToolAfterReflection) {
        const reason =
          `[in-turn-reflection blocked] This turn has detected ≥ 2 same-root-cause failures from ${call.name}; the mechanism layer has disabled this tool until the next user turn.\n` +
          `Do not call ${call.name} again into the same wall. Instead, do one of the following:\n` +
          `  (a) Use store_note(importance=high) to record the root cause you identified (wrong auth? wrong endpoint? credential stored with prefix?), so the user sees it next turn\n` +
          `  (b) Use other tools (list_facts / get_fact / listCredentialNames / search_skills) to gather diagnostic information\n` +
          `  (c) Use the ## For User section to tell the user the blocker and what you need, then close out this turn`;
        console.warn(
          `[in-turn-tool-block] session=${sessionId} rejected ${call.name} (mechanism-layer disabled after in-turn-reflection)`,
        );
        nextResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reason,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reason,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_in_turn_reflection',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'in_turn_tool_block',
          origin: 'Internal',
          toolName: 'in_turn_tool_blocked',
          sessionId,
          blockedTool: call.name,
        });
        continue;
      }

      // 2026-05-11: plan_protocol_gate — slow mode + plan not reviewed → only allow plan_* /
      // task_mode_classify. Forces the plan-review-execute-close protocol (six-step closed loop, inspired by OpenClaw).
      //
      // Trigger conditions:
      //   1. This session's taskMode === 'slow' (set by LLM proactively via classify)
      //   2. AND (no plan) OR (latest plan.status === 'draft')
      //   3. AND current tool is not in the plan_protocol exempt set (plan_* + task_mode_classify
      //      + Phase 10 P0 read-only research set)
      //
      // Unlock conditions: plan_update_step(status='doing') → status='executing' (M3 direct transition),
      // or task_mode_classify(fast) actively rolls back.
      //
      // fast mode / old sessions (no plan but mode=fast) are completely unaffected.
      //
      // Phase 10 P0 (2026-05-14): allow read-only research tools to prevent LLM from writing a plan from memory.
      // 2026-05-14 debug: PHILONT_PLAN_GATE_TRACE=1 enables detailed log to investigate resume path bypassing gate.
      {
        const mode = taskModeStore.get(sessionId);
        const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
        const lastPlan = sessionPlans[0];
        const exempt = isPlanGateExempt(call.name, classification, call.input);
        if (process.env.PHILONT_PLAN_GATE_TRACE === '1') {
          console.log(
            `[plan-gate-trace][secondary-iter] tool=${call.name} mode=${mode} plan=${lastPlan?.id ?? 'none'} planStatus=${lastPlan?.status ?? 'none'} reviewCount=${lastPlan?.reviewHistory.length ?? 0} exempt=${exempt}`,
          );
        }
      }
      if (taskModeStore.get(sessionId) === 'slow') {
        const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
        const lastPlan = sessionPlans[0];
        // M3 / Phase 11 (2026-05-15) tightened: only 'executing' passes through (same as first-iter).
        const planAllowsExec = lastPlan?.status === 'executing';
        const needsPlanReview = !planAllowsExec;
        const exempt = isPlanGateExempt(call.name, classification, call.input);
        if (needsPlanReview && !exempt) {
          const baseReason = !lastPlan
            ? `In slow mode, plan_draft has not been called to break down the task.`
            : lastPlan.status === 'draft'
              ? `plan ${lastPlan.id} is in draft status (${lastPlan.steps.length} steps, execution not started).`
              : lastPlan.status === 'failed'
                ? `plan ${lastPlan.id} was closed as failed. This plan is abandoned, but the task is unfinished — create a new plan_draft to continue.`
                : lastPlan.status === 'completed'
                  ? `plan ${lastPlan.id} was closed as completed. If you are starting a new task, call plan_draft first; do not run tools directly.`
                  : `plan ${lastPlan.id} is in status ${lastPlan.status} which is not in the allowed-execution set (executing).`;
          const planStateHint = !lastPlan
            ? 'plan_draft({deliverables, steps, task_signature, guide_ref}) — create a plan'
            : lastPlan.isPlaceholder
              ? `plan_revise({plan_id:"${lastPlan.id}", new_steps, new_deliverables, reason}) — promote the placeholder plan (new_deliverables required)`
              : lastPlan.status === 'draft'
                ? `plan_update_step({plan_id:"${lastPlan.id}", step_id, status:"doing"}) — start executing the first step`
                : `plan_revise({plan_id:"${lastPlan.id}", ...}) — revise the plan path`;
          const closeHint = lastPlan
            ? `plan_close({plan_id:"${lastPlan.id}", outcome:"failure", summary:"misclassified task"})`
            : '(no active plan — skip to step 2)';
          const reason =
            `[plan_protocol_gate] ${baseReason}\n` +
            `Tool ${call.name} has been disabled by the mechanism layer until the plan reaches executing status.\n\n` +
            `**This is not a bug — it is the slow protocol design.** You have 3 choices:\n\n` +
            `A) This task **needs a plan** (multiple deliverables or multi-step dependencies):\n` +
            `   1. ${planStateHint}\n` +
            `   2. plan_update_step({plan_id, step_id, status:"doing"}) — start execution\n` +
            `   3. Then ${call.name} will be unblocked automatically\n\n` +
            `B) This task **does not need a plan** (single call, or read-only research):\n` +
            `   1. ${closeHint} — close the placeholder plan\n` +
            `   2. Wait 60 s cooldown, then call task_mode_classify({mode:"fast", reason:"..."})\n` +
            `   3. Retry ${call.name}\n\n` +
            `C) You are **stuck**:\n` +
            `   - list_facts / search_skills to look up relevant history\n` +
            `   - webFetch guide_ref to re-read the guide\n` +
            `   - plan_revise to revise the plan (if the current path is wrong)\n\n` +
            `**Do not retry ${call.name} unchanged** — it will be blocked again.`;
          console.warn(
            `[plan_protocol_gate] session=${sessionId} rejected ${call.name} (slow + planStatus=${lastPlan?.status ?? 'none'})`,
          );
          nextResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: reason,
          });
          totalToolCallsThisTurn++;
          inTurnRecords.push({
            toolName: call.name,
            success: false,
            resultText: reason,
          });
          memory.actions.log({
            sessionId: GLOBAL_TIMELINE_SESSION_ID,
            toolName: call.name,
            params: call.input,
            result: 'rejected_by_plan_protocol_gate',
            success: false,
          });
          audit.append('self_domain_write', {
            source: 'plan_protocol_gate',
            origin: 'Internal',
            toolName: 'plan_protocol_gate_blocked',
            sessionId,
            blockedTool: call.name,
            planStatus: lastPlan?.status ?? 'no-plan',
            planId: lastPlan?.id ?? null,
          });
          continue;
        }
      }

      const { capability, domain } = classification;
      const denial2 = await checker({ toolName: call.name, approval: 'never', params: JSON.stringify(call.input) });
      // 2026-05-28: secondary-iter also uses autogrant (consistent with first-iter 4898).
      // Previously only changed first-iter, missing this one → write/execute in the 2nd+ LLM call
      // still paused → multiple tool_use 401. Sandbox benchmarks must allow both places for fully pause-free operation.
      const autoGrant2 = process.env.PHILONT_AUTO_GRANT === '1';
      const allowed = denial2 === null || autoGrant2;
      if (autoGrant2 && denial2 !== null) {
        console.warn(
          `[auto-grant] session=${sessionId} allowed ${call.name} (${capability}×${domain})[secondary-iter]— PHILONT_AUTO_GRANT=1`,
        );
      }

      if (!allowed) {
        const remainingCalls = response.calls.slice(response.calls.indexOf(call) + 1);
        pendingAuth.set(sessionId, {
          capability, domain,
          toolName:   call.name,
          toolCallId: call.id,
          input:      call.input,
          remainingCalls,
          collectedResults: nextResults,
          iteration: i,
          inflightMessages: [...messages],
          ts: Date.now(),
        });

        onAuthRequest({ toolName: call.name, capability, domain, input: call.input });
        return { outcome: { outcomeType: 'auth_pending' }, auditEvents: audit.length };
      }

      // 2026-05-19 three-stream separation: tool details → onTrace; semantic progress → onStatus
      onTrace?.({
        kind: 'tool-invocation', tier: 3,
        text: summarizeToolInvocation(call.name, call.input),
        meta: { toolName: call.name },
      });
      onStatus?.(semanticToolPhrase(call.name, call.input, statusLang));
      // Same as main loop: sanitize tool input (prevent multiple JSON concatenation)
      const sanitized2 = sanitizeToolInput(call.input);
      let result;
      if (sanitized2.input === null) {
        console.warn(
          `[tool] ${call.name} → input rejected: ${sanitized2.reason ?? 'unknown'} (path=${sanitized2.path})`,
        );
        result = {
          success: false,
          output: '',
          error: `tool input format error, blocked: ${sanitized2.reason ?? 'unknown'}`,
          duration: 0,
        };
      } else {
        if (sanitized2.path !== 'object') {
          console.warn(
            `[tool] ${call.name} → input sanitized: path=${sanitized2.path}`,
          );
        }
        if (isDeepExploreAdvance(call) && deepExploreAdvancesThisTurn >= 1) {
          console.warn(`[deep-explore] blocked 2nd advance this turn (one round/turn cap)`);
          result = { success: true, output: DEEP_EXPLORE_ONE_ROUND_MSG, duration: 0 };
        } else {
          if (isDeepExploreAdvance(call)) deepExploreAdvancesThisTurn++;
          result = await tools.execute(call.name, sanitized2.input);
        }
      }
      onTrace?.({
        kind: 'tool-result', tier: 3,
        text: summarizeToolResult(result),
        meta: { toolName: call.name, success: result.success },
      });
      if (!result.success) {
        onStatus?.(semanticToolFailPhrase(call.name, statusLang));
      }
      const rawResultText = formatToolResultContent(result);
      nextResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: truncateToolResultContent(rawResultText),
      });
      totalToolCallsThisTurn++;
      // 2026-05-10: trace for in-turn failure pattern detector (subsequent turns within the main loop also tracked)
      // 2026-05-17: http tool stores toolInput for ScheduleOutcome aggregation at scheduled turn close
      inTurnRecords.push({
        toolName: call.name,
        success: result.success,
        resultText: result.success ? (result.output ?? '') : (result.error ?? result.output ?? ''),
        toolInput: call.name === 'http' ? (call.input as Record<string, unknown>) : undefined,
      });
      // Layer 0.5: subsequent turn actions go into the global timeline
      memory.actions.log({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        toolName: call.name,
        params: call.input,
        result: (result.success ? result.output : result.error)?.slice(0, 500) ?? null,
        success: result.success,
      });
    }

    if (nextResults.length === 0) {
      // Production (2026-05-08): after the rescue mechanism, response.type='toolCalls' occasionally appears but
      // calls is empty (LLM outputs stop_reason=tool_use but content has no tool_use blocks,
      // or all calls were discarded by sanitize). Throwing would kill the entire turn and the user gets nothing.
      // Changed to break out of the loop and fall back to deterministic summary, describing what was already done.
      console.warn(
        `[runToolLoop] iter=${i}: response.type=toolCalls but calls=${response.calls.length} → degrading to summary fallback`,
      );
      onTrace?.({
        kind: 'loop-control', tier: 4,
        text: 'LLM returned empty tool_calls, falling back to deterministic summary',
      });
      break;
    }
    messages.push({ role: 'user', content: nextResults });
  }

  // maxIterations fallback: force the LLM to summarize all its previous attempts in text-only mode once;
  // no further tool calls allowed (tool_choice='none' is not supported by the current adapter; use a strong system section
  // prompt + pass no tools instead). This gives the user a meaningful wrap-up narrative rather than a cold
  // "⚠️ maxIterations"。
  onStatus?.(summarizingPhrase(statusLang));
  onTrace?.({
    kind: 'loop-control', tier: 4,
    text: `Reached the ${effectiveMax}-round tool limit, forcing a summary`,
    meta: { iteration: effectiveMax },
  });

  // task failure audit: hitting the iter cap → failure_recovery_inject hits on the next turn,
  // injecting "hit cap last time, use planAndExecute this turn" hint.
  {
    const recentToolNames: string[] = [];
    for (let j = messages.length - 1; j >= 0 && recentToolNames.length < 5; j--) {
      const m = messages[j];
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && typeof block === 'object' && (block as any).type === 'tool_use') {
            const n = (block as any).name;
            if (typeof n === 'string') recentToolNames.unshift(n);
            if (recentToolNames.length >= 5) break;
          }
        }
      }
    }
    internalAudit.append('task_failure_mode', {
      sessionId,
      kind: 'iter_cap_hit',
      ts: Date.now(),
      detail: `hit ${effectiveMax}-round tool limit; last ${recentToolNames.length} tools: ${recentToolNames.join(' → ')}`,
    });
  }
  try {
    messages.push({
      role: 'user',
      content:
        `[drive maxIterations fallback] You have made ${totalToolCallsThisTurn} consecutive tool calls without giving the user a text reply.` +
        `\n**No more tool calls are allowed.** Write a paragraph telling the user:` +
        `\n  - Which commands / paths you tried (list the 3-5 most important ones)` +
        `\n  - The specific reason each one failed (copy key phrases from the tool_result)` +
        `\n  - What the user can do next (try manually / change approach / provide more information)` +
        `\nThis is an intra-turn internal correction. Do not surface this reminder to the user.`,
    });
    // Call LLM, pass no tools, force text-only output
    const summary = await sendLlmWithRescue(messages, [], sessionId, onTrace);
    if (summary.type === 'text') {
      // Invariant: must call onDelta before returning outcome.text — the frontend treats
      // `final outcome=response` as "content already delivered via delta stream" and stays silent.
      // This line was once omitted here, causing the maxIterations fallback summary to never reach the frontend.
      const safeText = guardDeepExploreFabrication(summary.content, signalBus);
      onDelta(safeText);
      memory.raw.appendMessage({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        role: 'assistant',
        content: safeText,
      });
      return {
        outcome: { outcomeType: 'response', text: safeText },
        auditEvents: audit.length,
      };
    }
    // If the LLM still wants to call tools (theoretically should not, since toolDefs is empty), it falls to the original maxIterations
  } catch (e) {
    // 2026-05-07: when the LLM fallback summary also fails (60s timeout / API error), use a deterministic
    // summary assembled from tool_result history to give to the user. **Never let the user receive nothing at all**.
    console.warn('[maxIterations fallback] LLM summary failed, falling back to deterministic summary:', e);
    onTrace?.({
      kind: 'system-event', tier: 4,
      text: `LLM summary failed (${String(e).slice(0, 120)}), falling back to local deterministic summary`,
    });
    const recentResults = extractRecentToolResults(messages);
    const detSummary = renderDeterministicMaxIterSummary(
      totalToolCallsThisTurn,
      recentResults,
      effectiveMax,
    );
    onDelta(detSummary);
    memory.raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'assistant',
      content: detSummary,
    });
    return {
      outcome: { outcomeType: 'response', text: detSummary },
      auditEvents: audit.length,
    };
  }
  return { outcome: { outcomeType: 'terminated', reason: 'maxIterations' }, auditEvents: audit.length };
}

// renderDeterministicMaxIterSummary has been extracted to server/src/max_iter_summary.ts
