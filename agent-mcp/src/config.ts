/**
 * MCP server configuration types
 */

/** stdio transport configuration */
export interface McpStdioConfig {
  transport: 'stdio';
  /** Start command */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
}

/** SSE transport configuration */
export interface McpSseConfig {
  transport: 'sse';
  /** SSE endpoint URL */
  url: string;
  /** Request headers */
  headers?: Record<string, string>;
}

/** Individual MCP server configuration */
export interface McpServerConfig {
  /** Server name (used for logging and tool name prefix) */
  name: string;
  /** Transport configuration */
  transport: McpStdioConfig | McpSseConfig;
  /** Tool call timeout (ms), default 30000 */
  timeout?: number;
  /** Tool name prefix (to avoid collisions), defaults to name */
  toolPrefix?: string;
  /** Permission domain classification override, default 'network' */
  domain?: 'local' | 'network' | 'system';
  /**
   * Capability classification override, default 'read'.
   *
   * Important (security): philont's read-only matrix **auto-allows** read+network.
   * Browser automation servers (navigate/click/type/submit have side effects on
   * live sites) should be explicitly marked 'execute', so the first call triggers
   * onAuthRequest for user approval instead of silently passing through.
   */
  capability?: 'read' | 'write' | 'execute';
}

/** MCP bridge global configuration */
export interface McpBridgeConfig {
  servers: McpServerConfig[];
}
