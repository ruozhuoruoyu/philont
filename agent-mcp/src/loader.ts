/**
 * MCP configuration loader
 *
 * Parses philont's MCP server configuration for use by the application layer
 * (server / demo) as a one-time read at startup, then passed to
 * connectMcpServers() to mount as philont tools.
 *
 * Configuration sources (lowest to highest priority; later sources supplement,
 * they do not override earlier ones):
 *   1. Config file: `PHILONT_MCP_CONFIG` (explicit path) or default
 *      `~/.philont/mcp.json`. Two formats accepted:
 *        - `{ "servers": [ {McpServerConfig}, ... ] }` (McpBridgeConfig)
 *        - `[ {McpServerConfig}, ... ]` (bare array)
 *   2. Convenience flag: `PHILONT_MCP_BROWSER=1` → automatically appends a
 *      Playwright browser server (grants the agent browser capability without
 *      needing a config file). Skipped if a server named 'browser' is already
 *      declared in the config file.
 *
 * Design discipline:
 *   - **Never throws**: missing file / corrupt JSON / invalid fields → skip that
 *     source + console.warn, return what has been parsed so far (MCP is an
 *     enhancement; config problems must not block the entire server startup).
 *   - **Does not connect**: this module only parses config; actual
 *     connection/handshake is delegated to connectMcpServers().
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from './config.js';

/** Default config file path: ~/.philont/mcp.json */
export function defaultMcpConfigPath(): string {
  return join(homedir(), '.philont', 'mcp.json');
}

/**
 * Default Playwright (Microsoft official) browser MCP server.
 *
 * Pure local stdio child process, calls no paid APIs — launched via
 * `npx -y @playwright/mcp`.
 * capability='execute': navigate/click/type have side effects on live sites;
 * marking execute causes the read-only matrix to block it behind onAuthRequest
 * (read+network would be auto-allowed, which is too permissive).
 */
export function defaultPlaywrightServer(): McpServerConfig {
  return {
    name: 'browser',
    transport: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
    },
    domain: 'network',
    capability: 'execute',
    timeout: 60_000,
  };
}

/** Normalise any parsed result into McpServerConfig[] (filtering out obviously invalid entries). */
function coerceServers(raw: unknown, sourceLabel: string): McpServerConfig[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown }).servers)
      ? (raw as { servers: unknown[] }).servers
      : null;

  if (!arr) {
    console.warn(
      `[mcp] ${sourceLabel}: expected { servers: [...] } or bare array, got ${typeof raw} — skipping`,
    );
    return [];
  }

  const out: McpServerConfig[] = [];
  for (const item of arr) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as McpServerConfig).name === 'string' &&
      (item as McpServerConfig).transport &&
      typeof (item as McpServerConfig).transport === 'object'
    ) {
      out.push(item as McpServerConfig);
    } else {
      console.warn(`[mcp] ${sourceLabel}: skipping entry missing name/transport`);
    }
  }
  return out;
}

export interface LoadMcpConfigOptions {
  /** Explicit config file path (overrides env and default). */
  configPath?: string;
  /** Force-enable the Playwright browser (equivalent to PHILONT_MCP_BROWSER=1). */
  enableBrowser?: boolean;
  /** Injected environment reader (for testing); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Load the MCP server configuration list. Never throws — returns whatever has been parsed on error.
 */
export function loadMcpConfig(opts: LoadMcpConfigOptions = {}): McpServerConfig[] {
  const env = opts.env ?? process.env;
  const servers: McpServerConfig[] = [];

  // 1) Config file
  const path = opts.configPath ?? env.PHILONT_MCP_CONFIG?.trim() ?? defaultMcpConfigPath();
  if (path && existsSync(path)) {
    try {
      const text = readFileSync(path, 'utf-8');
      servers.push(...coerceServers(JSON.parse(text), `config file ${path}`));
    } catch (e) {
      console.warn(`[mcp] Failed to read/parse config file ${path}, skipping: ${(e as Error)?.message ?? e}`);
    }
  }

  // 2) PHILONT_MCP_BROWSER convenience flag
  const browserFlag = env.PHILONT_MCP_BROWSER?.trim().toLowerCase();
  const wantBrowser = opts.enableBrowser || browserFlag === '1' || browserFlag === 'true';
  if (wantBrowser && !servers.some((s) => s.name === 'browser')) {
    servers.push(defaultPlaywrightServer());
  }

  return servers;
}
