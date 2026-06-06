/**
 * Plugin context implementation
 *
 * Provides plugins with controlled API access. All tool registrations
 * automatically receive the plugin ID as a prefix to avoid conflicts
 * between multiple plugins.
 */

import type { Tool, ToolRegistry } from '@agent/policy';
import type {
  PluginContext,
  PluginHookEvent,
  PluginHookHandler,
  LoadedPlugin,
  PluginManifest,
} from './types.js';

export function createPluginContext(
  manifest: PluginManifest,
  pluginDir: string,
  registry: ToolRegistry,
  workDir: string,
  config?: Record<string, unknown>,
): { ctx: PluginContext; loaded: LoadedPlugin } {
  const tools: Tool[] = [];
  const hooks = new Map<PluginHookEvent, PluginHookHandler[]>();

  const ctx: PluginContext = {
    registry,
    workDir,
    pluginId: manifest.id,
    pluginDir,
    config,

    registerTool(tool: Tool): void {
      // Automatically add the plugin prefix (if the tool name does not already have it)
      const name = tool.name.startsWith(manifest.id + '.')
        ? tool.name
        : `${manifest.id}.${tool.name}`;
      const prefixed: Tool = { ...tool, name };
      registry.register(prefixed);
      tools.push(prefixed);
    },

    registerHook(event: PluginHookEvent, handler: PluginHookHandler): void {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event)!.push(handler);
    },
  };

  const loaded: LoadedPlugin = {
    manifest,
    pluginDir,
    tools,
    hooks,
  };

  return { ctx, loaded };
}
