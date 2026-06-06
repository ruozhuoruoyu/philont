/**
 * Lightweight HTML → Markdown conversion
 *
 * Design goal: keep the structured information that matters most when an LLM model is the downstream consumer,
 * and strip out noise (scripts, styles, inline styles, advertisement SVGs).
 *
 * Not aiming for perfection: complex tables, nested lists, frames, etc. can degrade to plain text.
 * Complex cases are handled by the caller passing a prompt through the aux-llm distillation path.
 *
 * No external dependencies (avoiding the ~1.4MB turndown bundle); the hand-rolled implementation
 * covers ~90% of documentation sites.
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name] ?? m);
}

/** Extract the HTML <title>; returns undefined if not found */
export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  return decodeEntities(m[1].trim()).slice(0, 500);
}

interface ConvertOptions {
  /** Output mode: 'markdown' preserves link/heading/list structure; 'text' keeps readable text only */
  mode: 'markdown' | 'text';
  /** Whether to convert <a> in HTML into [text](url). Only meaningful in markdown mode */
  preserveLinks?: boolean;
  /** Context URL for resolving relative links to absolute (only when preserveLinks=true) */
  baseUrl?: string;
}

/**
 * HTML → Markdown main entry point.
 *
 * Processing order matters: strip scripts/styles first (so their < > don't interfere with
 * subsequent tag matching), then convert block-level elements to markdown, then clean up whitespace.
 */
export function htmlToMarkdown(html: string, opts: ConvertOptions): string {
  let s = html;

  // 1. Remove entire blocks that are never needed
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ''); // inline SVG is usually just icons
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Remove common non-content containers (navigation, footer, sidebar, ad slots)
  s = s.replace(/<(nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi, '');

  // 3. Headings
  for (let level = 1; level <= 6; level++) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    if (opts.mode === 'markdown') {
      s = s.replace(
        re,
        (_, inner) => `\n\n${'#'.repeat(level)} ${stripInlineTags(inner).trim()}\n\n`,
      );
    } else {
      s = s.replace(re, (_, inner) => `\n\n${stripInlineTags(inner).trim()}\n\n`);
    }
  }

  // 4. Links (process before stripping tags)
  if (opts.mode === 'markdown' && opts.preserveLinks !== false) {
    s = s.replace(
      /<a\b[^>]*?href=(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_, _q, href, text) => {
        const cleanText = stripInlineTags(text).replace(/\s+/g, ' ').trim();
        if (!cleanText) return '';
        const absHref = resolveUrl(href, opts.baseUrl);
        return `[${cleanText}](${absHref})`;
      },
    );
  }

  // 5. Code blocks / inline code
  if (opts.mode === 'markdown') {
    s = s.replace(
      /<pre[^>]*>(?:\s*<code[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi,
      (_, code) => `\n\n\`\`\`\n${stripInlineTags(code)}\n\`\`\`\n\n`,
    );
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
      const c = stripInlineTags(code).trim();
      return c ? '`' + c + '`' : '';
    });
  } else {
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) =>
      stripInlineTags(code),
    );
  }

  // 6. Lists
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
    const text = stripInlineTags(inner).replace(/\s+/g, ' ').trim();
    return text ? `\n- ${text}` : '';
  });

  // 7. Paragraphs / block-level line breaks
  s = s.replace(/<\/(p|div|section|article|tr|blockquote)>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>(\s*)/gi, '\n');
  s = s.replace(/<hr\s*\/?>(\s*)/gi, '\n\n---\n\n');

  // 8. Table cells separated by ` | ` (crude but useful)
  s = s.replace(/<\/(td|th)>/gi, ' | ');

  // 9. Strip all remaining tags
  s = s.replace(/<[^>]+>/g, '');

  // 10. Decode HTML entities
  s = decodeEntities(s);

  // 11. Collapse whitespace
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}

function stripInlineTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function resolveUrl(href: string, baseUrl?: string): string {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
