/**
 * SSE transport layer — MCP HTTP+SSE protocol (2024-11-05 spec)
 *
 * Correct handshake and message flow (not a simple POST→JSON):
 *   1. Client GET <url>, Accept: text/event-stream, opens a **persistent** SSE stream
 *   2. Server's first event `event: endpoint` carries the **POST endpoint URI** (often a relative path)
 *   3. Client **POSTs JSON-RPC requests to that endpoint** (server typically replies 202 Accepted)
 *   4. Actual **responses come back via the SSE stream matched by JSON-RPC id** (async);
 *      client matches by id to the waiting request
 *   5. Messages without an id = server notifications
 *
 * Compatibility: some implementations return JSON-RPC directly in the POST response body
 * (rather than through SSE); that case is also handled here.
 *
 * Note: MCP 2025-03 introduced a "Streamable HTTP" transport and deprecated this HTTP+SSE.
 * To connect to the new-style remote servers, a transport: 'http' would need to be added.
 * This class covers classic SSE only.
 */

import { EventEmitter } from 'node:events';
import type { McpSseConfig } from '../config.js';

/** Split an SSE buffer into complete frames plus the remaining incomplete tail. Exported for testing. */
export function parseSseFrames(buffer: string): {
  events: Array<{ event: string; data: string }>;
  rest: string;
} {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const events: Array<{ event: string; data: string }> = [];
  for (const frame of parts) {
    if (!frame.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      // ignore id: / retry: / comment lines (starting with ':')
    }
    const data = dataLines.join('\n');
    if (data) events.push({ event, data });
  }
  return { events, rest };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SseTransport extends EventEmitter {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private postUrl: string | null = null;
  private abort: AbortController | null = null;
  private sseBuffer = '';
  private isConnected = false;

  constructor(config: McpSseConfig, timeout = 30000) {
    super();
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.headers = config.headers || {};
    this.timeout = timeout;
  }

  async connect(): Promise<void> {
    this.abort = new AbortController();
    let resp: Response;
    try {
      resp = await fetch(this.baseUrl, {
        method: 'GET',
        headers: { ...this.headers, Accept: 'text/event-stream' },
        // Persistent stream: no timeout here (AbortController disconnects on close). Handshake timeout is separate.
        signal: this.abort.signal,
      });
    } catch (e) {
      throw new Error(`SSE connect failed: ${(e as Error)?.message ?? e}`);
    }
    if (!resp.ok || !resp.body) {
      throw new Error(`SSE endpoint unreachable: HTTP ${resp.status}`);
    }

    // Read stream in background (no await); parse endpoint / responses / notifications. Stream error → reject all pending requests.
    this.readLoop(resp.body).catch((e) =>
      this.failAll(new Error(`SSE stream error: ${(e as Error)?.message ?? e}`)),
    );

    // Await handshake: only considered connected once endpoint is received. Timeout or stream error → reject (caught by connectMcpServers allSettled).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('SSE handshake timeout: no endpoint event'));
      }, Math.min(this.timeout, 10000));
      const onEndpoint = () => { cleanup(); resolve(); };
      const onErr = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('endpoint', onEndpoint);
        this.off('stream-error', onErr);
      };
      this.once('endpoint', onEndpoint);
      this.once('stream-error', onErr);
    });
    this.isConnected = true;
  }

  private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.sseBuffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseFrames(this.sseBuffer);
        this.sseBuffer = rest;
        for (const ev of events) this.handleEvent(ev.event, ev.data);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(event: string, data: string): void {
    if (event === 'endpoint') {
      this.postUrl = this.resolveUrl(data);
      this.emit('endpoint');
      return;
    }
    // message: JSON-RPC response (has id matching pending) or notification (no id)
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // non-JSON line, ignore
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP error: ${msg.error.message} (code ${msg.error.code})`));
      else p.resolve(msg.result);
    } else if (msg.id === undefined) {
      this.emit('notification', msg);
    }
  }

  private resolveUrl(endpoint: string): string {
    try {
      return new URL(endpoint, this.baseUrl + '/').toString();
    } catch {
      return endpoint;
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.postUrl) throw new Error('SSE not connected (no endpoint)');
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${this.timeout}ms)`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
    });

    let resp: Response;
    try {
      resp = await fetch(this.postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body,
        signal: this.abort?.signal,
      });
    } catch (e) {
      this.clearPending(id);
      throw new Error(`SSE POST failed: ${(e as Error)?.message ?? e}`);
    }
    if (!resp.ok) {
      this.clearPending(id);
      throw new Error(`MCP SSE POST error: HTTP ${resp.status}`);
    }

    // Compatibility: server returns JSON-RPC directly in the POST response body (not via SSE).
    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const json = (await resp.json().catch(() => null)) as
        | { id?: number; result?: unknown; error?: { code: number; message: string } }
        | null;
      if (json && json.id === id) {
        this.clearPending(id);
        if (json.error) throw new Error(`MCP error: ${json.error.message} (code ${json.error.code})`);
        return json.result;
      }
    }

    // Standard path: response comes back via the SSE stream.
    return responsePromise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.postUrl) return;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    fetch(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body,
      signal: this.abort?.signal,
    }).catch(() => {
      // Notifications are fire-and-forget
    });
  }

  async close(): Promise<void> {
    this.isConnected = false;
    this.failAll(new Error('SSE transport closed'));
    this.abort?.abort();
    this.abort = null;
    this.postUrl = null;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  private clearPending(id: number): void {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // Notify the handshake waiter (if still in connect phase). Check for listeners before emitting
    // to avoid EventEmitter's special behaviour of throwing on an unlistened 'error' event —
    // using the custom 'stream-error' name instead.
    this.emit('stream-error', err);
  }
}
