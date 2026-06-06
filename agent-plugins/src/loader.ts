/**
 * Plugin loader — load discovered plugin modules and execute registration
 *
 * Flow:
 *   1. discoverPlugins() discovers candidate plugin directories
 *   2. loadManifest() parses plugin.json
 *   3. Validate environment variables
 *   4. Dynamically import the entry module
 *   5. Call the register(ctx) function
 *   6. Return the list of loaded plugins
 *
 * Error isolation: a failure loading one plugin does not affect others.
 */

import { pathToFileURL } from 'node:url';
import { join, isAbsolute } from 'node:path';
import type { ToolRegistry } from '@agent/policy';
import type { LoadedPlugin, PluginRegisterFn, PluginSource, PluginSandboxMode } from './types.js';
import { loadManifest, checkEnvRequirements } from './manifest.js';
import { createPluginContext } from './context.js';
import {
  discoverPlugins,
  defaultPluginSources,
  type DiscoveredPlugin,
} from './discovery.js';
import { WorkerSandbox, type WorkerSandboxOptions } from './sandbox/index.js';

export interface LoadPluginsOptions {
  /** Tool registry (required; plugins register tools here) */
  registry: ToolRegistry;
  /** Working directory (used for workspace plugin discovery) */
  workDir?: string;
  /** Custom plugin sources (defaults used when not provided) */
  sources?: PluginSource[];
  /** Per-plugin configuration (keyed by pluginId) */
  configs?: Record<string, Record<string, unknown>>;
  /** Whether to silence load errors (default false; errors are console.error'd) */
  silent?: boolean;
  /**
   * Default sandbox mode (used when manifest.sandbox is not specified)
   * - 'direct' (default): same process and thread, zero overhead but no isolation
   * - 'worker': dedicated Worker thread, env filtering + crash isolation
   */
  defaultSandbox?: PluginSandboxMode;
  /** Worker sandbox options (global) */
  workerSandboxOptions?: WorkerSandboxOptions;
}

export interface LoadPluginsResult {
  /** Successfully loaded plugins */
  loaded: LoadedPlugin[];
  /** Failed plugins (with the error reason) */
  failed: Array<{ pluginDir: string; error: string }>;
}

/**
 * Load a single plugin
 */
async function loadOnePlugin(
  discovered: DiscoveredPlugin,
  registry: ToolRegistry,
  workDir: string,
  config?: Record<string, unknown>,
  defaultSandbox: PluginSandboxMode = 'direct',
  workerOpts?: WorkerSandboxOptions,
): Promise<{ loaded?: LoadedPlugin; error?: string }> {
  // 1. Parse manifest
  const result = await loadManifest(discovered.manifestPath);
  if (!result.valid) {
    return { error: `Invalid manifest: ${result.errors.join('; ')}` };
  }
  const manifest = result.manifest!;

  // 2. Validate environment variables
  const envCheck = checkEnvRequirements(manifest);
  if (!envCheck.ok) {
    return { error: `Missing env vars: ${envCheck.missing.join(', ')}` };
  }

  // 3. Resolve entry file
  const mainFile = manifest.main || 'index.js';
  const entryPath = isAbsolute(mainFile) ? mainFile : join(discovered.pluginDir, mainFile);

  const sandboxMode = manifest.sandbox ?? defaultSandbox;

  // 4. Worker sandbox mode
  if (sandboxMode === 'worker') {
    const sandbox = new WorkerSandbox(manifest, entryPath, workerOpts);
    try {
      await sandbox.start(workDir, config);
    } catch (e) {
      await sandbox.close();
      return { error: `Worker sandbox failed: ${e}` };
    }
    await sandbox.registerInRegistry(registry);
    return { loaded: sandbox.toLoadedPlugin(discovered.pluginDir) };
  }

  // 5. Direct mode (original behaviour)
  let mod: { register?: PluginRegisterFn; default?: PluginRegisterFn };
  try {
    mod = await import(pathToFileURL(entryPath).href);
  } catch (e) {
    return { error: `Failed to load ${entryPath}: ${e}` };
  }

  const registerFn = mod.register || mod.default;
  if (typeof registerFn !== 'function') {
    return { error: `Plugin must export register(ctx) function` };
  }

  const { ctx, loaded } = createPluginContext(
    manifest,
    discovered.pluginDir,
    registry,
    workDir,
    config,
  );

  try {
    await registerFn(ctx);
  } catch (e) {
    return { error: `register() threw: ${e}` };
  }

  return { loaded };
}

/**
 * Scan, discover, and load all plugins
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadPluginsResult> {
  const {
    registry,
    workDir = process.cwd(),
    sources = defaultPluginSources(workDir),
    configs = {},
    silent = false,
    defaultSandbox = 'direct',
    workerSandboxOptions,
  } = options;

  const discovered = await discoverPlugins(sources);

  const loaded: LoadedPlugin[] = [];
  const failed: Array<{ pluginDir: string; error: string }> = [];

  // Load in parallel (error isolation)
  const results = await Promise.allSettled(
    discovered.map(async (p) => {
      const dirName = p.pluginDir.split(/[/\\]/).pop()!;
      const config = configs[dirName];
      return {
        p,
        result: await loadOnePlugin(p, registry, workDir, config, defaultSandbox, workerSandboxOptions),
      };
    }),
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { p, result } = r.value;
      if (result.loaded) {
        loaded.push(result.loaded);
        if (!silent) {
          console.log(
            `[plugins] Loaded "${result.loaded.manifest.id}" v${result.loaded.manifest.version} (${result.loaded.tools.length} tools)`,
          );
        }
      } else {
        failed.push({ pluginDir: p.pluginDir, error: result.error || 'unknown error' });
        if (!silent) {
          console.error(`[plugins] Failed "${p.pluginDir}": ${result.error}`);
        }
      }
    } else {
      failed.push({
        pluginDir: '(unknown)',
        error: String(r.reason),
      });
    }
  }

  return { loaded, failed };
}

/**
 * Invoke a hook on all loaded plugins
 */
export async function invokeHook(
  loadedPlugins: LoadedPlugin[],
  event: Parameters<LoadedPlugin['hooks']['get']>[0],
  payload: unknown,
): Promise<void> {
  for (const plugin of loadedPlugins) {
    const handlers = plugin.hooks.get(event);
    if (!handlers) continue;
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (e) {
        console.error(`[plugins] Hook ${event} in "${plugin.manifest.id}" threw:`, e);
      }
    }
  }
}
