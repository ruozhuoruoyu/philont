/**
 * stdio transport layer — communicates with an MCP server via child-process stdin/stdout
 *
 * Uses the JSON-RPC 2.0 protocol (MCP standard)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { McpStdioConfig } from '../config.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class StdioTransport extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private config: McpStdioConfig,
    private timeout = 30000,
  ) {
    super();
  }

  /** Start the child process */
  async connect(): Promise<void> {
    const env = { ...process.env, ...this.config.env };
    const proc = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      // Windows: npx/npm etc. are .cmd scripts; bare-name spawn causes ENOENT — must go through shell.
      shell: process.platform === 'win32',
    });
    this.proc = proc;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      // MCP server's stderr is used for logging
      this.emit('log', chunk.toString());
    });

    proc.on('exit', (code) => {
      this.emit('exit', code);
      // Reject all pending requests
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Critical robustness: child process spawn failures (command not found = ENOENT,
    // common with npx on Windows) and runtime errors both emit an 'error' event on the
    // ChildProcess. **Must be listened to**, otherwise Node treats it as an unhandled
    // 'error' event and throws, crashing the host process — a failing external MCP server
    // must never bring down the whole server.
    //
    // Use a promise to distinguish: 'spawn' = started successfully; 'error' = startup
    // failed → reject, caught by connectMcpServers' allSettled (gracefully degraded to
    // "this server failed to connect").
    await new Promise<void>((resolve, reject) => {
      const onSpawnError = (err: Error) => reject(err);
      proc.once('error', onSpawnError);
      proc.once('spawn', () => {
        proc.removeListener('error', onSpawnError);
        // After startup, attach a persistent error handler: late runtime errors only reject pending requests, no longer crash.
        proc.on('error', (err: Error) => {
          for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.pending.clear();
        });
        // Give the server a moment to be ready (simple delay; ideally should await the initialize response).
        setTimeout(resolve, 100);
      });
    });
  }

  /** Send a JSON-RPC request and wait for its response */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      throw new Error('MCP server not connected');
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${this.timeout}ms)`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });

      const line = JSON.stringify(msg) + '\n';
      this.proc!.stdin!.write(line);
    });
  }

  /** Send a notification (no response needed) */
  notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const msg = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Close the connection */
  async close(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      // Allow 1 second for graceful exit
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.proc?.kill('SIGKILL');
          resolve();
        }, 1000);
        this.proc!.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.proc = null;
    }
  }

  get connected(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  private processBuffer(): void {
    // MCP uses newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Retain the potentially incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);

          if (msg.error) {
            p.reject(new Error(`MCP error: ${msg.error.message} (code ${msg.error.code})`));
          } else {
            p.resolve(msg.result);
          }
        } else if (!('id' in msg)) {
          // Notification (server → client)
          this.emit('notification', msg);
        }
      } catch {
        // Non-JSON line, ignore (may be a log line)
      }
    }
  }
}
