/**
 * @agent/plugins — plugin discovery and loading
 *
 * Allows third parties to extend the agent's toolset via a plugin.json manifest
 * and a register(ctx) function.
 *
 * Default scan locations (highest → lowest priority):
 *   1. workspace plugins:  <workDir>/.philont/plugins/
 *   2. global plugins:     ~/.philont/plugins/
 *
 * Plugin structure:
 *   my-plugin/
 *   ├── plugin.json        { id, name, version, main?, requiresEnv? }
 *   └── index.js           export function register(ctx) { ... }
 */

export type {
  PluginManifest,
  PluginContext,
  PluginHookEvent,
  PluginHookHandler,
  PluginRegisterFn,
  LoadedPlugin,
  PluginSource,
} from './types.js';

export { loadManifest, validateManifest, checkEnvRequirements } from './manifest.js';
export type { ManifestValidationResult } from './manifest.js';

export { createPluginContext } from './context.js';

export {
  discoverPlugins,
  defaultPluginSources,
} from './discovery.js';
export type { DiscoveredPlugin } from './discovery.js';

export { loadPlugins, invokeHook } from './loader.js';
export type { LoadPluginsOptions, LoadPluginsResult } from './loader.js';

export { WorkerSandbox } from './sandbox/index.js';
export type { WorkerSandboxOptions, WorkerMessage, SerializedTool } from './sandbox/index.js';
