/**
 * WeChat render layer (2026-05-19)
 *
 * WeChat does not support full markdown rendering — tables / multi-level headings /
 * `**bold**` are displayed as raw characters, making users think the bot is broken.
 * This module converts the markdown text produced by chat-handler into WeChat-friendly
 * plain text with light emoji formatting.
 *
 * Two responsibilities:
 *   1. renderForWeChat(md)          — markdown → WeChat text (aggressive strip strategy)
 *   2. formatToolForAuth(name, input) — render tool input params in human-readable form
 *                                       for tool authorization requests
 *
 * Pure functions, easy to test. All channel-specific render strategies are concentrated
 * in this file; other channels (web-ui etc.) are unaffected.
 */

// ── 1. markdown → WeChat text ──────────────────────────────────────────────

/**
 * Aggressive strip strategy:
 *   - **bold** / __bold__         → remove markers, keep text
 *   - *italic* / _italic_         → remove markers, keep text (word-boundary only)
 *   - # / ## / ### headings        → remove # markers, keep heading text
 *   - | A | B | table row         → convert to bullet "- A: B" (2 cols) or "- A · B · C" (>2 cols)
 *   - Table separator rows |---| → delete
 *   - `inline code`                → 「inline code」 (Chinese guillemets; WeChat displays them as-is)
 *   - ```fenced```                 → preserve (code blocks are acceptable even in WeChat plain text)
 *   - [text](url)                  → "text (url)" (WeChat does not render links; expose URL explicitly)
 *   - Collapse excess blank lines (>2 consecutive blank lines folded to 1)
 *
 * Untouched: emoji, lists (- / 1.), plain text, line-break structure.
 */
export function renderForWeChat(md: string): string {
  if (!md) return md;

  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;
  let tableHeader: string[] | null = null;

  for (const raw of lines) {
    // Code fence boundary — preserve content inside verbatim (WeChat code blocks are readable even without highlighting)
    if (/^```/.test(raw.trim())) {
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }

    // ── Table handling ─────────────────────────────────────────────
    // markdown table: first row = header, second row = |---|---| separator, rest = body
    if (isTableSeparatorLine(raw)) {
      // Discard the separator row itself. tableHeader was set on the previous line.
      continue;
    }
    if (isTableRow(raw)) {
      const cells = parseTableRow(raw);
      if (tableHeader === null) {
        // First row = header; stash it and wait to see if the next line is a separator
        tableHeader = cells;
        continue;
      }
      // Header already stashed; this is a body row → convert to bullet
      out.push(renderTableRowAsBullet(tableHeader, cells));
      continue;
    } else if (tableHeader !== null) {
      // Previous line looked like a table row but this one is not → previous line was not
      // a real table (no separator followed). It was already consumed; re-emit it as plain text.
      out.push(stripInlineMarkdown(renderTableRowAsBullet(tableHeader, [])));
      tableHeader = null;
      // Then continue processing the current line (fall through)
    }

    // ── Headings ##/### → strip # markers ───────────────────────────
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (headingMatch) {
      out.push(stripInlineMarkdown(headingMatch[2]));
      continue;
    }

    // ── Regular line: strip inline markup ────────────────────────────
    out.push(stripInlineMarkdown(raw));
  }

  // Note: tableHeader remaining at end (body already output as bullets) = normal; do not
  // re-emit header. An isolated header (no separator, no body) is handled by the
  // "saw non-table line → fallback" path above, not here.

  // Collapse ≥3 consecutive blank lines to 1 blank line
  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return joined;
}

function isTableRow(line: string): boolean {
  // At least 2 pipe characters and not entirely whitespace (avoids false-matching "| single quote")
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false;
  const inner = trimmed.slice(1, -1);
  if (inner.indexOf('|') < 0) return false; // needs at least 2 cells (1 inner |)
  return true;
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false;
  // Each cell content must only contain - : and whitespace (allows :---: / ---: / :---)
  const cells = trimmed.slice(1, -1).split('|');
  return cells.every((c) => /^[\s:-]+$/.test(c) && /-/.test(c));
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, -1);
  return inner.split('|').map((c) => stripInlineMarkdown(c.trim()));
}

function renderTableRowAsBullet(header: string[], row: string[]): string {
  if (row.length === 0) {
    // Header only, no body — emit header as a single line
    return header.join(' · ');
  }
  if (header.length === 2 && row.length === 2) {
    // 2 columns: typical key-value
    return `- ${row[0]}: ${row[1]}`;
  }
  // >2 columns: join with ·
  return `- ${row.join(' · ')}`;
}

/** Strip inline markers: **bold** / *italic* / `code` / [text](url) */
function stripInlineMarkdown(s: string): string {
  let out = s;
  // **bold** / __bold__  → bold
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/__([^_\n]+)__/g, '$1');
  // *italic* / _italic_  → italic (careful: do not match inside words)
  out = out.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[，。！？,.!?:])/g, '$1$2');
  out = out.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[，。！？,.!?:])/g, '$1$2');
  // `inline code`  → 「inline code」
  out = out.replace(/`([^`\n]+)`/g, '「$1」');
  // [text](url)  → "text (url)"
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1 ($2)');
  return out;
}

// ── 2. Tool authorization request rendering ───────────────────────────────

/**
 * Render tool input parameters in human-readable multi-line form for WeChat auth request messages.
 *
 * Covers 7 high-frequency write/execute tools + a generic fallback.
 *
 * Design principles:
 *   - One key parameter per line so the user can decide "should I allow this" at a glance
 *   - Long content truncated to 200 chars + "…"
 *   - Never throws (any input shape has a fallback)
 */
export function formatToolForAuth(name: string, input: unknown): string {
  const safe = (input ?? {}) as Record<string, unknown>;

  const lines: string[] = [];
  const head = `${iconFor(name)} ${name}`;
  lines.push(head);

  switch (name) {
    case 'writeFile':
    case 'appendFile': {
      const path = strField(safe, 'path');
      const content = strField(safe, 'content');
      if (path) lines.push(`   路径: ${path}`);
      if (content) {
        const bytes = Buffer.byteLength(content, 'utf8');
        lines.push(`   大小: ${bytes} 字节`);
        lines.push(`   内容预览: ${truncate(content, 120)}`);
      }
      break;
    }
    case 'shell':
    case 'execute': {
      const cmd = strField(safe, 'command') || strField(safe, 'cmd');
      const cwd = strField(safe, 'cwd');
      if (cmd) lines.push(`   命令: ${truncate(cmd, 200)}`);
      if (cwd) lines.push(`   目录: ${cwd}`);
      break;
    }
    case 'readFile': {
      const path = strField(safe, 'path');
      if (path) lines.push(`   路径: ${path}`);
      break;
    }
    case 'glob': {
      const pattern = strField(safe, 'pattern');
      const cwd = strField(safe, 'cwd');
      if (pattern) lines.push(`   模式: ${pattern}`);
      if (cwd) lines.push(`   目录: ${cwd}`);
      break;
    }
    case 'http':
    case 'webFetch': {
      const url = strField(safe, 'url');
      const method = strField(safe, 'method') || 'GET';
      if (url) lines.push(`   ${method.toUpperCase()} ${url}`);
      break;
    }
    case 'installSkill': {
      const skillName = strField(safe, 'name') || strField(safe, 'skill');
      const source = strField(safe, 'source') || strField(safe, 'url');
      if (skillName) lines.push(`   技能: ${skillName}`);
      if (source) lines.push(`   来源: ${source}`);
      break;
    }
    default: {
      // Generic fallback: JSON truncated to 200 chars
      const dump = safeStringify(input);
      if (dump) lines.push(`   参数: ${truncate(dump, 200)}`);
    }
  }

  return lines.join('\n');
}

function iconFor(name: string): string {
  switch (name) {
    case 'writeFile':
    case 'appendFile':
      return '📝';
    case 'shell':
    case 'execute':
      return '💻';
    case 'readFile':
      return '📖';
    case 'glob':
      return '🔍';
    case 'http':
    case 'webFetch':
      return '🌐';
    case 'installSkill':
      return '📦';
    default:
      return '⚙️';
  }
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── 3. Assemble complete auth message ─────────────────────────────────────

/**
 * Assemble the full WeChat-side auth request text. Contains:
 *   - 🔐 title line
 *   - Optional clarification line (when the previous response was not understood)
 *   - Tool details (rendered by formatToolForAuth)
 *   - Decision prompt line
 */
export function renderAuthPromptForWeChat(req: {
  toolName: string;
  capability: string;
  domain: string;
  input: unknown;
  clarification?: string;
}): string {
  const lines: string[] = [];
  lines.push('🔐 Agent 请求授权');
  if (req.clarification) {
    lines.push(req.clarification);
  }
  lines.push('');
  lines.push(formatToolForAuth(req.toolName, req.input));
  lines.push('');
  lines.push(`权限: ${req.capability}/${req.domain}`);
  lines.push('');
  lines.push('回复 "同意" / "yes" 允许;回复 "拒绝" / "no" 拒绝');
  lines.push('(10 分钟有效)');
  return lines.join('\n');
}
