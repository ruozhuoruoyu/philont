/**
 * McpToolWrapper — wrap an MCP tool as a philont Tool interface
 *
 * MCP tool definition → philont Tool mapping:
 *   name        → toolPrefix + '.' + mcp_tool_name
 *   description → mcp_tool_description
 *   schema      → mcp_tool_inputSchema
 *   execute     → send tools/call via transport
 */

import type { Tool, ToolResult } from '@agent/policy';
import type { StdioTransport } from './transport/stdio.js';
import type { SseTransport } from './transport/sse.js';
import type { Capability, Domain } from '@agent/policy';

/** MCP tool definition (from the tools/list response) */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

type Transport = StdioTransport | SseTransport;

/**
 * Normalise an MCP tool's inputSchema to meet LLM tool-calling parameter requirements.
 *
 * Motivation: the inputSchema from the MCP server is passed verbatim as
 * input_schema / function.parameters to the LLM. Strict compat endpoints (e.g. DeepSeek
 * validating against OpenAI rules) require parameters to be a top-level
 * `type: "object"` JSON Schema; missing type, or meta-fields like `$schema`, may trigger
 * a 400 rejection. This performs the minimal, safe normalisation: guarantee object shape,
 * strip commonly-rejected meta-fields. Never mutates properties content.
 */
function normalizeInputSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { type: 'object', properties: {} };
  }
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  // Top level must be an object schema
  if (out.type !== 'object') out.type = 'object';
  if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) {
    out.properties = {};
  }
  // Strip meta-fields that strict validators frequently reject (do not affect parameter semantics)
  delete out.$schema;
  delete out.$id;
  return out;
}

/**
 * Wrap an MCP tool definition as a philont Tool
 */
export function wrapMcpTool(
  mcpTool: McpToolDefinition,
  transport: Transport,
  options: {
    prefix?: string;
    capability?: Capability;
    domain?: Domain;
    timeout?: number;
  } = {},
): Tool {
  const {
    prefix,
    capability = 'read',
    domain = 'network',
  } = options;

  // Tool name must match the LLM tool-calling convention ^[a-zA-Z0-9_-]+$ (validated by OpenAI/Anthropic etc.).
  // Use '_' as the prefix separator (not '.': dot is outside the allowed charset and causes API 400).
  // Also sanitise the final name: replace any illegal character with '_' to handle unusual naming
  // from MCP servers.
  // Note: execute() still calls the MCP server using the original mcpTool.name;
  // sanitisation only affects the philont-side tool name.
  const rawName = prefix ? `${prefix}_${mcpTool.name}` : mcpTool.name;
  const toolName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');

  return {
    name: toolName,
    description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
    schema: normalizeInputSchema(mcpTool.inputSchema),
    capability,
    domain,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await transport.request('tools/call', {
          name: mcpTool.name, // call MCP server using the original name
          arguments: params,
        }) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };

        // MCP tool result format: { content: [{ type: 'text', text: '...' }], isError?: boolean }
        const content = result?.content || [];
        const text = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join('\n');

        return {
          success: !result?.isError,
          output: text || JSON.stringify(result),
          error: result?.isError ? text : undefined,
        };
      } catch (error) {
        return {
          success: false,
          output: '',
          error: `MCP tool call failed: ${error}`,
        };
      }
    },
  };
}
