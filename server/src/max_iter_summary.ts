/**
 * maxIterations fallback: deterministic summary when the LLM summarisation also fails (2026-05-07)
 *
 * Scenario: a turn hits the MAX_TOOL_LOOP_ITERATIONS cap → triggers "forced summarisation"
 * (LLM runs without tools) → that LLM call also times out / errors → the user receives nothing.
 *
 * This module provides a pure function that builds a minimal structured report from the
 * tool_result history, guaranteeing the user sees at least: how many steps ran, what the
 * last action was, that the conversation has ended, and how to continue.
 */

export interface ToolResultLite {
  /** Tool name, may be empty */
  toolName: string;
  /** tool_result text (should already have ✓/⚠ prefix) */
  content: string;
}

/**
 * Render the deterministic fallback summary.
 *
 * @param totalCalls Total number of tool calls made this turn
 * @param recentResults Array of recent tool_results for this turn (in chronological order)
 * @param maxIter The iteration cap value, used in the report
 * @param tailN How many of the last steps to show; defaults to 5
 */
export function renderDeterministicMaxIterSummary(
  totalCalls: number,
  recentResults: ReadonlyArray<ToolResultLite>,
  maxIter: number,
  tailN: number = 5,
): string {
  const lastN = recentResults.slice(-tailN);
  const lines: string[] = [
    '## For User',
    '',
    `⚠ 任务已超出 ${maxIter} 轮工具调用上限,且 LLM 兜底总结也超时。共调用 ${totalCalls} 次工具。`,
    '',
    `**最近 ${Math.min(tailN, lastN.length)} 步动作**:`,
  ];
  if (lastN.length === 0) {
    lines.push('- (无可用工具结果记录)');
  } else {
    for (const r of lastN) {
      const status = r.content.startsWith('✓')
        ? '✅'
        : r.content.startsWith('⚠')
          ? '❌'
          : '·';
      const preview = r.content.replace(/\s+/g, ' ').slice(0, 100);
      lines.push(`- ${status} ${r.toolName || '?'}: ${preview}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('对话已自动收尾,本次未能完成原始请求。可以告诉我:');
  lines.push('1. 让我换个思路重试');
  lines.push('2. 把已知信息整理成结论你来接管');
  lines.push('3. 跳过这一步换个任务');
  return lines.join('\n');
}
