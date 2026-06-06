/**
 * Tool registry
 *
 * Two registration paths:
 *   - register(tool)           Plugin / third-party registration; **domain='self' is forbidden**
 *   - registerInternal(tool)   Kernel-trusted toolset registration (agent-memory/agent-tools/agent-mcp etc.);
 *                              domain='self' is permitted
 *
 * The `self` domain = agent self-state (memory / calendar / skill / schedule).
 * Allowing any plugin to declare self would let them escape the local-domain gate via
 * the self domain, so it is restricted to an allowlist.
 */

import type { Tool, ToolResult } from './types.js';
import type { ToolClassification } from '../matrix.js';

export class RegistryViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryViolationError';
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /**
   * Register a tool (default path: third-party/plugin source)
   *
   * Throws RegistryViolationError if the tool declares domain='self'.
   * Kernel-trusted tools should use registerInternal() instead.
   */
  register(tool: Tool): void {
    if (tool.domain === 'self') {
      throw new RegistryViolationError(
        `Tool '${tool.name}' cannot declare domain='self' via register(); use registerInternal() (kernel-trusted path). ` +
        `The 'self' domain is reserved for agent-memory/agent-tools/agent-mcp-class packages.`
      );
    }
    // Dynamic classification must not fall back to self either
    if (tool.classify) {
      this.tools.set(tool.name, this.wrapClassifyGuard(tool, /*allowSelf*/ false));
      return;
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register a kernel-trusted tool (domain='self' is permitted)
   *
   * Only called by kernel packages such as agent-memory / agent-tools / agent-mcp.
   */
  registerInternal(tool: Tool): void {
    if (tool.classify) {
      this.tools.set(tool.name, this.wrapClassifyGuard(tool, /*allowSelf*/ true));
      return;
    }
    this.tools.set(tool.name, tool);
  }

  private wrapClassifyGuard(tool: Tool, allowSelf: boolean): Tool {
    if (allowSelf) return tool;
    // If a plugin's classify() dynamically returns self, intercept at runtime too
    const origClassify = tool.classify!;
    return {
      ...tool,
      classify: (params) => {
        const cls = origClassify(params);
        if (cls.domain === 'self') {
          throw new RegistryViolationError(
            `Tool '${tool.name}' (plugin) returned domain='self' from classify(); not allowed.`
          );
        }
        return cls;
      },
    };
  }

  /** Get a tool */
  get(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  /**
   * Classify a tool (used for permission checks)
   *
   * If the tool implements `classify(params)`, dynamic classification is used first
   * (more accurate, e.g. http POST → write). Falls back to the static capability/domain fields.
   */
  classify(name: string, params?: Record<string, unknown>): ToolClassification | null {
    const tool = this.tools.get(name);
    if (!tool) return null;
    if (tool.classify && params !== undefined) {
      return tool.classify(params);
    }
    return {
      capability: tool.capability,
      domain: tool.domain,
    };
  }

  /** List all tools */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Execute a tool */
  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Tool '${name}' not found`,
      };
    }

    const start = Date.now();
    try {
      const result = await tool.execute(params);
      return {
        ...result,
        duration: Date.now() - start,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: String(error),
        duration: Date.now() - start,
      };
    }
  }
}
