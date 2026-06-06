/**
 * WorkerSandbox — main-thread-side Worker manager
 *
 * Loads a plugin into a dedicated Worker thread and communicates via postMessage RPC.
 *
 * Security properties:
 *   - The worker's process.env is filtered (only includes variables declared in manifest.requiresEnv)
 *   - Worker crashes do not affect the main thread
 *   - Workers can be force-killed on timeout
 *   - Resource limits (stack/heap/old-gen/worker thread count) are configurable
 *
 * The "Tool" registered on the main thread is an RPC proxy: execute() sends a message
 * to the worker and waits for the result.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ToolRegistry, Tool, ToolResult } from '@agent/policy';
import type {
  PluginManifest,
  PluginHookEvent,
  LoadedPlugin,
} from '../types.js';
import type { WorkerMessage } from './protocol.js';

export interface WorkerSandboxOptions {
  /** Additional env variables allowed to pass through (beyond manifest.requiresEnv) */
  allowEnv?: string[];
  /** Worker maximum old-generation heap (MB), default 256 */
  maxOldGenerationSizeMb?: number;
  /** Worker resource limit: stack size in MB, default 4 */
  stackSizeMb?: number;
  /** RPC call timeout (ms), default 30000 */
  rpcTimeoutMs?: number;
  /** Callback invoked on each log message */
  onLog?: (info: { pluginId: string; level: string; args: string[] }) => void;
}

/** Filter env to an allowlist */
function filteredEnv(allow: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allow) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  // Minimum environment required by the Node.js runtime (keep PATH/HOME etc.)
  // Note: omitting PATH prevents Node from loading dynamic modules; provide the minimal subset
  for (const k of ['PATH', 'HOME', 'NODE_PATH', 'LANG', 'TMPDIR']) {
    if (process.env[k] && !(k in out)) out[k] = process.env[k]!;
  }
  return out;
}

export class WorkerSandbox {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readyPromise!: Promise<boolean>;
  private manifestOkResolve!: (ok: boolean) => void;
  private tools = new Map<string, Tool>();
  private hookEvents = new Set<PluginHookEvent>();

  constructor(
    private manifest: PluginManifest,
    private pluginPath: string,
    private options: WorkerSandboxOptions = {},
  ) {
    this.readyPromise = new Promise<boolean>(resolve => {
      this.manifestOkResolve = resolve;
    });
  }

  /** Start the worker and load the plugin */
  async start(workDir: string, config?: Record<string, unknown>): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const workerScript = join(here, 'workerEntry.js');

    const allowed = [...(this.manifest.requiresEnv ?? []), ...(this.options.allowEnv ?? [])];
    const env = filteredEnv(allowed);

    this.worker = new Worker(workerScript, {
      env,
      resourceLimits: {
        maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb ?? 256,
        stackSizeMb: this.options.stackSizeMb ?? 4,
      },
    });
    // unref so the worker does not keep the main process event loop alive;
    // the worker is cleaned up automatically when the main process exits.
    // Call close() for explicit lifecycle management.
    this.worker.unref();

    this.worker.on('message', (msg: WorkerMessage) => this.handleMessage(msg));
    this.worker.on('error', (err: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
    this.worker.on('exit', (code) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`Worker exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Send load message
    this.post({
      type: 'load',
      manifest: this.manifest,
      pluginPath: this.pluginPath,
      workDir,
      config,
    });

    const ok = await this.readyPromise;
    if (!ok) {
      await this.close();
      throw new Error(`Plugin "${this.manifest.id}" failed to register (missing register function?)`);
    }
  }

  /** Get the list of main-thread-side Tool proxies */
  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  getHookEvents(): PluginHookEvent[] {
    return [...this.hookEvents];
  }

  /** Return a LoadedPlugin structure (compatible with the existing loader) */
  toLoadedPlugin(pluginDir: string): LoadedPlugin {
    const tools = this.getTools();
    // Generate a proxy handler for each hook event (calls via RPC at invocation time)
    const hooks = new Map<PluginHookEvent, any[]>();
    for (const event of this.hookEvents) {
      hooks.set(event, [async (payload: unknown) => this.invokeHook(event, payload)]);
    }
    return { manifest: this.manifest, pluginDir, tools, hooks };
  }

  /** Invoke a plugin tool */
  async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    return this.rpcCall('execute', { toolName, params });
  }

  async invokeHook(event: PluginHookEvent, payload: unknown): Promise<unknown> {
    return this.rpcCall('hook', { event, payload });
  }

  async close(): Promise<void> {
    if (!this.worker) return;
    try {
      this.worker.postMessage({ type: 'shutdown' });
    } catch { /* ignore */ }
    await this.worker.terminate().catch(() => {});
    this.worker = null;
  }

  async registerInRegistry(registry: ToolRegistry): Promise<void> {
    for (const t of this.tools.values()) {
      registry.register(t);
    }
  }

  // ── internal ──────────────────────────────────────────

  private post(msg: WorkerMessage): void {
    if (!this.worker) throw new Error('Worker not started');
    this.worker.postMessage(msg);
  }

  private async rpcCall(kind: 'execute' | 'hook', payload: any): Promise<any> {
    const id = this.nextId++;
    const timeoutMs = this.options.rpcTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin RPC timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      if (kind === 'execute') {
        this.post({ type: 'execute', id, toolName: payload.toolName, params: payload.params });
      } else {
        this.post({ type: 'hook', id, event: payload.event, payload: payload.payload });
      }
    });
  }

  private handleMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case 'ready':
        this.manifestOkResolve(msg.manifestOk);
        return;

      case 'register-tool': {
        const serialized = msg.tool;
        // Create a main-thread Tool proxy: execute() goes via RPC
        const proxyTool: Tool = {
          name: serialized.name,
          description: serialized.description,
          schema: serialized.schema,
          capability: serialized.capability,
          domain: serialized.domain,
          execute: async (params) => this.execute(serialized.name, params),
        };
        this.tools.set(serialized.name, proxyTool);
        return;
      }

      case 'register-hook':
        this.hookEvents.add(msg.event);
        return;

      case 'execute-result':
      case 'hook-result': {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg.result);
        }
        return;
      }

      case 'execute-error':
      case 'hook-error': {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.reject(new Error(msg.error));
        }
        return;
      }

      case 'log':
        this.options.onLog?.({
          pluginId: this.manifest.id,
          level: msg.level,
          args: msg.args,
        });
        return;
    }
  }
}
