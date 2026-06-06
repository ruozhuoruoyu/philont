/**
 * Worker entry point — runs plugin code in a dedicated thread
 *
 * Runs in the worker only. The main thread communicates via postMessage.
 *
 * process.env here has been isolated by new Worker({env}) to the host-declared allowlist.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type {
  WorkerMessage,
  SerializedTool,
} from './protocol.js';
import type {
  PluginContext,
  PluginHookEvent,
  PluginHookHandler,
} from '../types.js';
import type { Tool } from '@agent/policy';

if (!parentPort) {
  throw new Error('workerEntry must run in a Worker thread');
}
const port = parentPort;

const tools = new Map<string, Tool>();
const hooks = new Map<PluginHookEvent, PluginHookHandler[]>();

/** Replace all console methods with log messages sent to main, so the worker never prints directly */
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level];
  console[level] = (...args: unknown[]) => {
    try {
      port.postMessage({ type: 'log', level, args: args.map(String) } satisfies WorkerMessage);
    } catch {
      orig(...args);
    }
  };
}

function post(msg: WorkerMessage): void {
  port.postMessage(msg);
}

function serializeTool(t: Tool): SerializedTool {
  return {
    name: t.name,
    description: t.description,
    schema: t.schema,
    capability: t.capability,
    domain: t.domain,
  };
}

port.on('message', async (msg: WorkerMessage) => {
  try {
    if (msg.type === 'load') {
      // Dynamically import the plugin and call register
      const mod = await import(pathToFileURL(msg.pluginPath).href);
      const register = mod.register ?? mod.default;
      if (typeof register !== 'function') {
        post({ type: 'ready', manifestOk: false });
        return;
      }

      const ctx: PluginContext = {
        registry: null as any,          // worker has no ToolRegistry; main thread manages it
        workDir: msg.workDir,
        pluginId: msg.manifest.id,
        pluginDir: '',                  // not exposed externally
        config: msg.config,
        registerTool(t: Tool) {
          // Auto-prefix (mirrors the logic in main-side context.ts)
          const name = t.name.startsWith(msg.manifest.id + '.')
            ? t.name
            : `${msg.manifest.id}.${t.name}`;
          tools.set(name, { ...t, name });
          post({ type: 'register-tool', tool: serializeTool({ ...t, name }) });
        },
        registerHook(event: PluginHookEvent, handler: PluginHookHandler) {
          const list = hooks.get(event) ?? [];
          list.push(handler);
          hooks.set(event, list);
          post({ type: 'register-hook', event });
        },
      };

      await register(ctx);
      post({ type: 'ready', manifestOk: true });
      return;
    }

    if (msg.type === 'execute') {
      const tool = tools.get(msg.toolName);
      if (!tool) {
        post({ type: 'execute-error', id: msg.id, error: `Tool not found: ${msg.toolName}` });
        return;
      }
      try {
        const result = await tool.execute(msg.params);
        post({ type: 'execute-result', id: msg.id, result });
      } catch (e) {
        post({ type: 'execute-error', id: msg.id, error: String(e) });
      }
      return;
    }

    if (msg.type === 'hook') {
      const handlers = hooks.get(msg.event);
      if (!handlers || handlers.length === 0) {
        post({ type: 'hook-result', id: msg.id, result: null });
        return;
      }
      try {
        let last: unknown = null;
        for (const h of handlers) {
          last = await h(msg.payload);
        }
        post({ type: 'hook-result', id: msg.id, result: last });
      } catch (e) {
        post({ type: 'hook-error', id: msg.id, error: String(e) });
      }
      return;
    }

    if (msg.type === 'shutdown') {
      process.exit(0);
    }
  } catch (e) {
    // Catch-all: report any uncaught exception to main
    try {
      post({ type: 'log', level: 'error', args: [`Worker error: ${String(e)}`] });
    } catch {
      /* ignore */
    }
  }
});
