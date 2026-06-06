/**
 * McpBridge — connect to an MCP server, discover tools, register into ToolRegistry
 *
 * Analogous to Linux FUSE: mounts an external filesystem into the VFS layer.
 * McpBridge mounts tools from an external MCP server into philont's ToolRegistry.
 *
 * Lifecycle:
 *   1. connect()     — start the transport layer, send initialize
 *   2. discover()    — call tools/list to fetch the tool list
 *   3. registerAll() — wrap and register all tools into ToolRegistry
 *   4. close()       — disconnect and clean up resources
 */

import type { Tool } from '@agent/policy';
import { ToolRegistry } from '@agent/policy';
import { StdioTransport } from './transport/stdio.js';
import { SseTransport } from './transport/sse.js';
import { wrapMcpTool, type McpToolDefinition } from './wrapper.js';
import type { McpServerConfig } from './config.js';

export class McpBridge {
  private transport: StdioTransport | SseTransport;
  private tools: Tool[] = [];
  private serverName: string;
  private config: McpServerConfig;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.serverName = config.name;

    const timeout = config.timeout || 30000;

    if (config.transport.transport === 'stdio') {
      this.transport = new StdioTransport(config.transport, timeout);
    } else {
      this.transport = new SseTransport(config.transport, timeout);
    }
  }

  /** Connect to the MCP server and perform the initialize handshake */
  async connect(): Promise<void> {
    await this.transport.connect();

    // MCP initialize handshake
    await this.transport.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'philont-agent',
        version: '0.1.0',
      },
    });

    // Send initialized notification
    this.transport.notify('notifications/initialized');
  }

  /** Discover all tools on the MCP server */
  async discover(): Promise<McpToolDefinition[]> {
    const result = await this.transport.request('tools/list') as {
      tools: McpToolDefinition[];
    };
    return result?.tools || [];
  }

  /**
   * Connect + discover + wrap all tools
   *
   * @returns List of wrapped philont Tools
   */
  async connectAndDiscover(): Promise<Tool[]> {
    await this.connect();
    const mcpTools = await this.discover();

    const prefix = this.config.toolPrefix ?? this.serverName;

    this.tools = mcpTools.map((t) =>
      wrapMcpTool(t, this.transport, {
        prefix,
        domain: this.config.domain || 'network',
        capability: this.config.capability || 'read',
      }),
    );

    return this.tools;
  }

  /**
   * Connect + discover + register into ToolRegistry
   */
  async registerAll(registry: ToolRegistry): Promise<Tool[]> {
    const tools = await this.connectAndDiscover();
    for (const tool of tools) {
      registry.register(tool);
    }
    return tools;
  }

  /** Get the discovered tools */
  getTools(): Tool[] {
    return this.tools;
  }

  /** Server name */
  get name(): string {
    return this.serverName;
  }

  /** Whether connected */
  get connected(): boolean {
    return this.transport.connected;
  }

  /** Close the connection */
  async close(): Promise<void> {
    await this.transport.close();
    this.tools = [];
  }
}

/**
 * Bulk-connect multiple MCP servers
 *
 * Connects to all servers in parallel; a failure on one server does not affect others.
 * Returns all successfully connected bridge instances.
 */
export async function connectMcpServers(
  configs: McpServerConfig[],
  registry?: ToolRegistry,
): Promise<McpBridge[]> {
  const bridges: McpBridge[] = [];

  const results = await Promise.allSettled(
    configs.map(async (config) => {
      const bridge = new McpBridge(config);
      if (registry) {
        await bridge.registerAll(registry);
      } else {
        await bridge.connectAndDiscover();
      }
      return bridge;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      bridges.push(result.value);
      const toolCount = result.value.getTools().length;
      console.log(`[mcp] Connected to "${configs[i].name}" — ${toolCount} tools`);
    } else {
      console.error(`[mcp] Failed to connect to "${configs[i].name}":`, result.reason);
    }
  }

  return bridges;
}

/**
 * Close all MCP bridges
 */
export async function closeMcpBridges(bridges: McpBridge[]): Promise<void> {
  await Promise.allSettled(bridges.map((b) => b.close()));
}
