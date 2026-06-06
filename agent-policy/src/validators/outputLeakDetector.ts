/**
 * Output Leak Detector — secret redaction after tool execution
 *
 * Unlike leakDetector (inbound, inspects parameters), this wrapper runs after
 * the tool's execute() returns:
 *   - Scans ToolResult.output
 *   - block pattern hit → replaces the entire output with an error
 *   - redact pattern hit → replaces matched portions with [REDACTED]
 *
 * Application-layer usage:
 *   const safeExec = wrapToolWithOutputScan(tool.execute);
 *   const result = await safeExec(params);
 */

import type { Tool, ToolResult } from '../tools/types.js';
import { redactOutput, scanText, DEFAULT_LEAK_PATTERNS } from './leakDetector.js';
import type { LeakPattern, LeakAction } from './leakDetector.js';

export interface OutputScanOptions {
  patterns?: LeakPattern[];
  /** How to handle a block hit: replace = swap entire output for an error; redact = apply redact processing */
  blockAction?: 'replace' | 'redact';
  /** Custom action overrides */
  actionOverrides?: Record<string, LeakAction>;
  /** Scan callback (can be used for auditing) */
  onHit?: (info: { toolName: string; patternIds: string[] }) => void;
}

/**
 * Create a tool wrapper that scans output after execute()
 */
export function wrapToolWithOutputScan(
  tool: Tool,
  options: OutputScanOptions = {},
): Tool {
  const patterns = options.patterns ?? DEFAULT_LEAK_PATTERNS;
  const blockAction = options.blockAction ?? 'replace';
  const overrides = options.actionOverrides;

  return {
    ...tool,
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const result = await tool.execute(params);
      if (!result.output) return result;

      const hits = scanText(result.output, patterns, overrides);
      if (hits.length === 0) return result;

      const patternIds = [...new Set(hits.map(h => h.patternId))];
      options.onHit?.({ toolName: tool.name, patternIds });

      const hasBlock = hits.some(h => h.action === 'block');
      if (hasBlock && blockAction === 'replace') {
        return {
          success: false,
          output: '',
          error: `Output contained forbidden secrets (${patternIds.join(', ')}); result suppressed.`,
        };
      }

      // redact: replace matched portions
      return {
        ...result,
        output: redactOutput(result.output, patterns, overrides),
      };
    },
  };
}

/**
 * Wrap all tools in a registry in bulk
 */
export function wrapAllToolsWithOutputScan(
  tools: Tool[],
  options: OutputScanOptions = {},
): Tool[] {
  return tools.map(t => wrapToolWithOutputScan(t, options));
}
