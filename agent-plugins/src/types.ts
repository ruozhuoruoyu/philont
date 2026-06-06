/**
 * Plugin system type definitions
 */

import type { Tool, ToolRegistry } from '@agent/policy';

/** Plugin sandbox mode */
export type PluginSandboxMode = 'direct' | 'worker';

/** Plugin manifest (plugin.json) */
export interface PluginManifest {
  /** Plugin ID (unique; used as the tool prefix) */
  id: string;
  /** Display name */
  name: string;
  /** Version */
  version: string;
  /** Description */
  description?: string;
  /** Entry file path (relative to plugin.json), default index.js */
  main?: string;
  /** Required environment variables (only these are forwarded in worker sandbox mode) */
  requiresEnv?: string[];
  /** List of provided tool names (documentation only, not enforced) */
  providesTools?: string[];
  /** Author */
  author?: string;
  /** Homepage */
  homepage?: string;
  /** Sandbox mode: direct=same process and thread, worker=dedicated Worker thread */
  sandbox?: PluginSandboxMode;
}

/** Plugin runtime context (passed to the register() function) */
export interface PluginContext {
  /** Tool registry (plugins write to it indirectly via ctx.registerTool()) */
  registry: ToolRegistry;
  /** Working directory */
  workDir: string;
  /** Plugin ID (automatically prepended as prefix) */
  pluginId: string;
  /** Plugin directory */
  pluginDir: string;
  /** Plugin configuration (passed in from the host application) */
  config?: Record<string, unknown>;

  /** Register a tool (automatically adds the plugin prefix to avoid conflicts) */
  registerTool(tool: Tool): void;
  /** Register a lifecycle hook */
  registerHook(event: PluginHookEvent, handler: PluginHookHandler): void;
}

/** Plugin hook events */
export type PluginHookEvent =
  | 'pre_tool_call'
  | 'post_tool_call'
  | 'on_session_start'
  | 'on_session_end';

/** Hook handler function */
export type PluginHookHandler = (payload: unknown) => unknown | Promise<unknown>;

/** Plugin entry function signature */
export type PluginRegisterFn = (ctx: PluginContext) => void | Promise<void>;

/** Record of a loaded plugin */
export interface LoadedPlugin {
  manifest: PluginManifest;
  pluginDir: string;
  tools: Tool[];
  hooks: Map<PluginHookEvent, PluginHookHandler[]>;
}

/** Plugin discovery source */
export interface PluginSource {
  /** Source name (used for logging) */
  label: string;
  /** Plugin root directory */
  path: string;
  /** Priority; higher overrides lower (default 0) */
  priority?: number;
}
