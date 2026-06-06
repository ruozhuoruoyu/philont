/**
 * @agent/tools — Agent built-in tool set
 *
 * Provides:
 *   - Filesystem tools (readFile, writeFile, deleteFile, moveFile, listDir)
 *   - Runtime tools (shell)
 *   - Network tools (http, webSearch, webFetch)
 *   - Utility tools (echo, time, json, memory)
 *   - Tool profiles (minimal, readonly, coding, full)
 *   - createToolset() factory function
 *   - SKILL.md file loader
 */

import { ToolRegistry } from '@agent/policy';
import type { Tool, SecretStore } from '@agent/policy';
import { filterByProfile } from './profiles.js';
import type { ToolProfile, ProfileSet } from './profiles.js';
import { createSecuredHttpTool, type SecuredHttpOptions } from './network/securedHttp.js';

// ── Categorized exports ───────────────────────────────
export { readFileTool, writeFileTool, deleteFileTool, moveFileTool, listDirTool, inspectPathTool, grepTool, globTool, patchTool } from './fs/index.js';
export { shellTool, processTool, z3VerifyTool, pariGpTool } from './runtime/index.js';
export { httpTool, webSearchTool, webFetchTool, downloadFileTool, createSecuredHttpTool, parseContentDisposition, filenameFromUrl, sanitizeFilename } from './network/index.js';
export type { SecuredHttpOptions } from './network/index.js';
export { echoTool, timeTool, jsonTool, memoryTool, jsonPatchTool, envTool, hashTool, askUserQuestionTool, renderQuestion, parseQuestionAnswer, createCredentialTools } from './utility/index.js';
export type { ParsedAnswer } from './utility/index.js';
export { gitTool } from './git/index.js';
export { installSkillTool, uninstallSkillTool } from './skills/index.js';
export { visionTool } from './vision/index.js';

// ── Profiles ──────────────────────────────────────────
export {
  filterByProfile,
  getProfileToolNames,
  resolveProfile,
  loadProfilesFromFile,
} from './profiles.js';
export type { ToolProfile, BuiltinProfile, ProfileDef, ProfileSet } from './profiles.js';

// ── Skills ────────────────────────────────────────────
export { parseSkillFile, loadSkills, watchSkillDir, MAX_ACTION_TEMPLATE_SIZE } from './skills/index.js';
export type { ParsedSkill } from './skills/index.js';

// ── Utils ─────────────────────────────────────────────
export {
  callAuxLLM,
  registerMainLLM,
  clearMainLLMRegistration,
  hasMainLLMRegistered,
  isAuxLLMConfigured,
  AuxLLMError,
} from './utils/aux-llm.js';
export type { AuxLLMRequest, AuxLLMCaller } from './utils/aux-llm.js';

// mini-agent-loop: sub-turn kernel (used by planAndExecute and other composite tools)
export { runMiniAgentLoop } from './utils/mini-agent-loop.js';
export { HOST_IS_WINDOWS, hostShellLabel, hostEnvPromptLine } from './utils/host.js';
export type {
  MiniLoopMessage,
  MiniLoopContentBlock,
  MiniLoopLLMResponse,
  MiniLoopLLMClient,
  MiniLoopToolRunResult,
  MiniLoopToolCallRecord,
  MiniAgentLoopOptions,
  MiniAgentLoopResult,
} from './utils/mini-agent-loop.js';

// ── Control tools (plan-then-execute and other orchestration) ─────────
export {
  createPlanAndExecuteTool,
  PlanBudgetTracker,
} from './control/planAndExecute.js';
export type {
  SubTask,
  SubTaskStatus,
  SubTaskResult,
  PlanAndExecuteDeps,
  PlanAndExecuteStructuredResult,
} from './control/planAndExecute.js';

// ── All built-in tools ────────────────────────────────
import { readFileTool, writeFileTool, deleteFileTool, moveFileTool, listDirTool, inspectPathTool, grepTool, globTool, patchTool } from './fs/index.js';
import { shellTool, processTool, z3VerifyTool, pariGpTool } from './runtime/index.js';
import { httpTool, webSearchTool, webFetchTool, downloadFileTool } from './network/index.js';
import { echoTool, timeTool, jsonTool, memoryTool, jsonPatchTool, envTool, hashTool, askUserQuestionTool } from './utility/index.js';
import { gitTool } from './git/index.js';
import { installSkillTool, uninstallSkillTool } from './skills/index.js';
import { visionTool } from './vision/index.js';

/** Full list of built-in tools */
export const builtinTools: Tool[] = [
  // fs
  readFileTool, writeFileTool, deleteFileTool, moveFileTool, listDirTool, inspectPathTool,
  grepTool, globTool, patchTool,
  // runtime
  shellTool, processTool, z3VerifyTool, pariGpTool,
  // network
  httpTool, webSearchTool, webFetchTool, downloadFileTool,
  // vision (read image + call vision model, read/network)
  visionTool,
  // utility
  echoTool, timeTool, jsonTool, memoryTool, jsonPatchTool, envTool, hashTool, askUserQuestionTool,
  // git
  gitTool,
  // skill self-management (domain='self', same level as memoryTool)
  installSkillTool, uninstallSkillTool,
];

// ── Factory function ──────────────────────────────────

export interface ToolsetOptions {
  /** Tool profile, defaults to 'full' */
  profile?: ToolProfile;
  /** Additional custom tools (plugins/untrusted sources; not allowed to declare domain='self') */
  extraTools?: Tool[];
  /**
   * Additional trusted-kernel tools (agent-memory / agent-mcp / other first-party packages)
   *
   * Allowed to declare domain='self'. The application layer (server / demo) is responsible for
   * verifying that tool sources are trustworthy before placing them here —
   * tools from agent-plugins or user config must never go in this array.
   */
  extraInternalTools?: Tool[];
  /** Existing ToolRegistry instance (creates a new one if not provided) */
  registry?: ToolRegistry;
  /** Custom profile set (supports inheriting/overriding built-in profiles) */
  customProfiles?: ProfileSet;
  /**
   * Credential store (optional)
   *
   * When provided: the http tool is replaced with its secured variant, supporting {SECRET_ID} placeholder injection.
   * See securedHttpOptions for related settings.
   */
  secretStore?: SecretStore;
  /** SecuredHttpTool configuration (allowedSecrets / redactResponse / onInject) */
  securedHttpOptions?: SecuredHttpOptions;
}

/**
 * Create and populate a ToolRegistry
 *
 * @param options  Configuration options
 * @returns        A ToolRegistry with all tools registered
 */
export function createToolset(options: ToolsetOptions = {}): ToolRegistry {
  const {
    profile = 'full',
    extraTools = [],
    extraInternalTools = [],
    registry,
    customProfiles,
    secretStore,
    securedHttpOptions,
  } = options;
  const reg = registry || new ToolRegistry();

  // Filter built-in tools by profile (custom profiles supported)
  let tools = filterByProfile(builtinTools, profile, customProfiles);

  // If a secretStore is provided, replace the http tool with its secured variant
  if (secretStore) {
    const secured = createSecuredHttpTool(secretStore, securedHttpOptions);
    tools = tools.map(t => (t.name === 'http' ? secured : t));
  }

  // Built-in tools go through the internal registration path (part of the trusted kernel set)
  for (const tool of tools) {
    reg.registerInternal(tool);
  }

  // Trusted-kernel additional tools (may declare self)
  for (const tool of extraInternalTools) {
    reg.registerInternal(tool);
  }

  // Plugin/user-sourced additional tools (self not allowed)
  for (const tool of extraTools) {
    reg.register(tool);
  }

  return reg;
}
