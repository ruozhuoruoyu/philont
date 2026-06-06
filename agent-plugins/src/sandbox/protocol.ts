/**
 * Worker ↔ Main RPC protocol
 *
 * All messages carry a type field. Request-type messages carry an id;
 * the corresponding response carries the matching id.
 */

import type { PluginManifest, PluginHookEvent } from '../types.js';

export type WorkerMessage =
  // Worker → Main
  | { type: 'ready'; manifestOk: boolean }
  | { type: 'register-tool'; tool: SerializedTool }
  | { type: 'register-hook'; event: PluginHookEvent }
  | { type: 'execute-result'; id: number; result: any }
  | { type: 'execute-error'; id: number; error: string }
  | { type: 'hook-result'; id: number; result: any }
  | { type: 'hook-error'; id: number; error: string }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; args: string[] }

  // Main → Worker
  | { type: 'load'; manifest: PluginManifest; pluginPath: string; workDir: string; config?: Record<string, unknown> }
  | { type: 'execute'; id: number; toolName: string; params: Record<string, unknown> }
  | { type: 'hook'; id: number; event: PluginHookEvent; payload: unknown }
  | { type: 'shutdown' };

/** Serialised form of a tool definition (without the execute function) */
export interface SerializedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  capability: 'read' | 'write' | 'execute';
  /**
   * Domain. 'self' is allowed here, but the main-thread ToolRegistry.register()
   * will reject it — plugins cannot use 'self' to escape the local-domain gate.
   */
  domain: 'local' | 'network' | 'system' | 'self';
}
