/**
 * @agent/mcp — MCP (Model Context Protocol) bridge layer
 *
 * Mounts tools from external MCP servers into philont's ToolRegistry.
 * Analogous to Linux FUSE: external filesystem → VFS layer.
 *
 * Provides:
 *   - McpBridge          Single MCP server connection management
 *   - connectMcpServers  Bulk-connect multiple MCP servers
 *   - closeMcpBridges    Bulk-close connections
 *   - wrapMcpTool        Wrap an MCP tool as a philont Tool
 *
 * Transport layer:
 *   - StdioTransport     Child-process stdin/stdout communication
 *   - SseTransport       HTTP SSE communication
 */

export { McpBridge, connectMcpServers, closeMcpBridges } from './bridge.js';
export { wrapMcpTool, type McpToolDefinition } from './wrapper.js';
export { StdioTransport } from './transport/stdio.js';
export { SseTransport } from './transport/sse.js';
export {
  loadMcpConfig,
  defaultMcpConfigPath,
  defaultPlaywrightServer,
  type LoadMcpConfigOptions,
} from './loader.js';
export type {
  McpServerConfig,
  McpStdioConfig,
  McpSseConfig,
  McpBridgeConfig,
} from './config.js';
