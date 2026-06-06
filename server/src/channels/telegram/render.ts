/**
 * renderForTelegram — formats LLM markdown output into Telegram-friendly plain text.
 *
 * Strategy: send plain text (no parse_mode, zero escaping risk). So this only does
 * "de-noise + readability":
 *   - Strip **bold** / __bold__ / *italic* markers (keep the text)
 *   - Headings `## X` → `X`
 *   - Inline `code` keeps backticks (backticks are harmless in Telegram plain text and
 *     actually hint that it is code)
 *   - Markdown tables → compact "col1 | col2" per line
 *   - Code fences ``` are preserved (clear even in Telegram plain text)
 *   - Collapse 3+ consecutive blank lines
 *
 * Differences from wechat_render: Telegram is more tolerant of long text / line breaks,
 * so tables do not need to be converted to bullets and inline code backticks do not need
 * to be stripped. Hence this renderer is lighter.
 */

export function renderForTelegram(markdown: string): string {
  if (!markdown) return '';
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    const line = raw;
    const fence = line.trimStart().startsWith('```');
    if (fence) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line); // preserve content inside code fences as-is
      continue;
    }

    let s = line;
    // Headings: strip leading #
    s = s.replace(/^\s{0,3}#{1,6}\s+/, '');
    // Table separator rows (|---|---|) are dropped entirely
    if (/^\s*\|?\s*:?-{2,}.*\|/.test(s)) continue;
    // Table data rows: strip leading/trailing | and join cells with " | "
    if (/^\s*\|.*\|\s*$/.test(s)) {
      s = s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()).join(' | ');
    }
    // Strip **bold** / __bold__ / *italic* / _italic_ markers (keep text)
    s = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
    s = s.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1$2');
    out.push(s);
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // collapse excess blank lines
    .trim();
}
