/**
 * SKILL.md file loader
 *
 * Reads SKILL.md files from disk (YAML frontmatter + Markdown body),
 * parses them into structured data that can be imported into agent-memory's SkillStore.
 *
 * SKILL.md format:
 * ```
 * ---
 * name: skill-name
 * description: one-line description
 * version: 1.0.0
 * metadata:
 *   tags: [tag1, tag2]
 *   category: category-name
 * ---
 *
 * # Skill Title
 *
 * ## When to Use
 * - trigger condition 1
 * - trigger condition 2
 *
 * ## Instructions
 * Action template content...
 * ```
 *
 * Load priority (high → low):
 *   1. workspace skills:  <workDir>/.philont/skills/  (philont main dir, installed by clawhub)
 *   2. workspace open:    <workDir>/skills/           (openclaw upstream convention, for compatibility)
 *   3. global skills:     ~/.philont/skills/
 *   4. bundled skills:    <agent-tools>/bundled-skills/
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * Maximum bytes for actionTemplate. Exceeding this rejects loading — purely a prompt-budget
 * protection and DB-row bloat defense, NOT a security measure (actionTemplate security relies on
 * the 3×4 permission matrix + tool grant as the backstop).
 *
 * Design rationale: **actionTemplate only enters the prompt when the LLM calls `use_skill(name)`**;
 * the system prompt index normally contains only name + description. The real cost is: after
 * use_skill, this tool_result enters history and is re-sent every subsequent turn. So the cap
 * mainly constrains:
 *   1. The size of a single use_skill tool_result (a single LLM message should not be too long,
 *      as it affects subsequent turns)
 *   2. The SQLite `memory_skills.action_template` column size (default ~1GB, not a real constraint)
 *   3. Abnormal SKILL.md (a multi-dozen-KB document used as a step template) — but this is left
 *      to the WARN threshold as an observable signal; the hard cap only blocks pathological cases
 *      (hundreds of KB of documents)
 *
 * Default 64KB: covers legitimate large skills (methodology / multi-step ETL / domain skills with
 * schema specs; a large quality-management skill was measured at 44KB), ≈16-26K tokens, ~2.5% of
 * Opus 1M context — fully affordable; maintains the same order of magnitude as WARN (16KB) at 4×.
 * The 32KB historical value was overly conservative.
 * env `PHILONT_MAX_ACTION_TEMPLATE_SIZE` can override (can be raised for large-context model deployments);
 * invalid / absent value falls back to 64KB.
 */
export const MAX_ACTION_TEMPLATE_SIZE = (() => {
  const raw = process.env.PHILONT_MAX_ACTION_TEMPLATE_SIZE;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 65536;
})();

/**
 * actionTemplate warning threshold. Exceeds → warn, not reject — gives operators an observable
 * signal for which skills are growing. The reject threshold is MAX_ACTION_TEMPLATE_SIZE.
 */
export const ACTION_TEMPLATE_WARN_SIZE = 16384;

/** Parsed skill */
export interface ParsedSkill {
  /** Skill name */
  name: string;
  /** One-line description */
  description: string;
  /**
   * Trigger-scenario text (free text describing when to use this skill).
   *
   * Source priority:
   *   1. frontmatter `when_to_use:` field (explicit)
   *   2. body `## When to Use` section (fallback, list items joined into a paragraph)
   *   3. empty string (skill does not declare when to use it)
   *
   * Uses:
   *   - Displayed alongside description when the skill index is injected into the system prompt,
   *     letting the LLM understand at the semantic level "what scenarios this skill applies to"
   *     (not keyword matching)
   *   - The trigger_condition text auto-generated when a bundled skill is installed into a routing rule
   *
   * Difference from triggerKeywords: triggerKeywords is an array of keywords (used for routing-rule
   * keyword matching); whenToUse is narrative text (used for LLM semantic judgment).
   */
  whenToUse: string;
  /** Version number */
  version?: string;
  /** Trigger keywords (extracted from the "When to Use" section) */
  triggerKeywords: string[];
  /** Action template (markdown body) */
  actionTemplate: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Source path */
  sourcePath: string;
  /**
   * Source tag (passed through from the SKILL.md frontmatter `source` field):
   *   undefined / null — written locally by hand
   *   'clawhub:<slug>@<version>' — installed by ClawHub (written into frontmatter by clawhubTool
   *     at install time so it can be recognised after a restart / hot-reload)
   */
  source?: string | null;
}

/**
 * Parse YAML frontmatter
 *
 * A simple parser with no external YAML library dependency.
 * Supports: strings, arrays ([ ] and - format), nested objects.
 *
 * Line-ending normalisation (important): Windows git checkout defaults core.autocrlf=true,
 * converting LF to CRLF. Our regex hard-codes \n, so CRLF files cause frontmatter to
 * completely fail to match, falling back to using the file basename as name (`SKILL`),
 * causing all 9 bundled SKILL.md files to collide and overwrite each other.
 * Normalise here before parsing to avoid depending on the user's git settings.
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: normalized };
  }

  const yamlBlock = match[1];
  const body = match[2];
  const meta: Record<string, unknown> = {};

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    // Array: [a, b, c]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim());
    }
    // Empty value
    else if (value === '') {
      value = undefined;
    }

    if (value !== undefined) {
      meta[key] = value;
    }
  }

  return { meta, body };
}

/**
 * Extract trigger keywords from a markdown body
 *
 * Finds the "## When to Use" section and extracts list items
 */
function extractTriggerKeywords(body: string): string[] {
  const match = body.match(/## When to Use\s*\n([\s\S]*?)(?=\n## |\n# |$)/i);
  if (!match) return [];

  const section = match[1];
  const keywords: string[] = [];
  for (const line of section.split('\n')) {
    // Only extract list items (lines starting with - or *)
    const listMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (listMatch) {
      keywords.push(listMatch[1].trim());
    }
  }
  return keywords;
}

/**
 * Extract the "When to Use" section from a markdown body as a narrative text paragraph (2026-05-09).
 *
 * Difference from extractTriggerKeywords: that one returns an array of list items (for keyword matching);
 * this one joins the whole section into a narrative text (for LLM semantic judgment + skill index injection).
 *
 * Only used as a fallback path: when the frontmatter has no explicit `when_to_use:` field.
 *
 * Implementation: joins list items + regular paragraphs within the section with "; ", removing
 * markdown list markers.
 */
function extractWhenToUseSection(body: string): string {
  const match = body.match(/## When to Use\s*\n([\s\S]*?)(?=\n## |\n# |$)/i);
  if (!match) return '';

  const section = match[1];
  const parts: string[] = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // List item → strip the - / * prefix
    const listMatch = line.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      parts.push(listMatch[1].trim());
      continue;
    }
    // Inline paragraph (non-empty, non-list) → include directly
    parts.push(line);
  }
  return parts.join('; ');
}

/**
 * Parse a single SKILL.md file
 *
 * Throws directly if actionTemplate exceeds MAX_ACTION_TEMPLATE_SIZE bytes,
 * causing loadSkillsFromDir's catch to skip this skill and log a warning.
 */
export function parseSkillFile(content: string, sourcePath: string): ParsedSkill {
  const { meta, body } = parseFrontmatter(content);

  const name = (meta.name as string) || basename(sourcePath, '.md');
  const description = (meta.description as string) || '';
  const version = meta.version as string | undefined;
  const source = (meta.source as string | undefined) ?? null;

  // 2026-05-09: prefer frontmatter `when_to_use:` field; fallback to extracting from the body
  // `## When to Use` section as narrative text; empty string if neither is present.
  const whenToUse =
    (meta.when_to_use as string | undefined)?.trim() ||
    extractWhenToUseSection(body);

  const triggerKeywords = extractTriggerKeywords(body);
  const actionTemplate = body.trim();

  const tplBytes = Buffer.byteLength(actionTemplate, 'utf8');
  if (tplBytes > MAX_ACTION_TEMPLATE_SIZE) {
    throw new Error(
      `SKILL.md actionTemplate exceeds ${MAX_ACTION_TEMPLATE_SIZE} bytes ` +
      `(${tplBytes} bytes) — refusing to load: ${sourcePath}`,
    );
  }
  if (tplBytes > ACTION_TEMPLATE_WARN_SIZE) {
    // Do not block loading; just emit an operator signal: this skill is large and worth reviewing for bloat
    console.warn(
      `[skills-loader] ${sourcePath} actionTemplate=${tplBytes}B exceeds warn threshold ${ACTION_TEMPLATE_WARN_SIZE}B,` +
      ` still loading; check whether it contains documents rather than action steps.`,
    );
  }

  // Collect all non-standard fields as metadata (name/description/version/source/when_to_use are excluded from metadata)
  const {
    name: _,
    description: __,
    version: ___,
    source: ____,
    when_to_use: _____,
    ...restMeta
  } = meta;
  const metadata = Object.keys(restMeta).length > 0 ? restMeta : undefined;

  return {
    name,
    description,
    whenToUse,
    version,
    triggerKeywords,
    actionTemplate,
    metadata,
    sourcePath,
    source,
  };
}

/**
 * Load all SKILL.md files from a directory
 *
 * Supports two structures:
 *   - Flat: skills/my-skill.md
 *   - Nested: skills/my-skill/SKILL.md
 */
async function loadSkillsFromDir(dir: string): Promise<ParsedSkill[]> {
  const skills: ParsedSkill[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return skills; // directory does not exist
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const s = await stat(fullPath).catch(() => null);
    if (!s) continue;

    if (s.isFile() && entry.endsWith('.md')) {
      // Flat mode: skills/my-skill.md
      try {
        const content = await readFile(fullPath, 'utf-8');
        skills.push(parseSkillFile(content, fullPath));
      } catch (e) {
        // size cap rejection / encoding error / other parse error → skip + warn
        console.warn(`[skills-loader] skip ${fullPath}: ${(e as Error).message}`);
      }
    } else if (s.isDirectory()) {
      // Nested mode: skills/my-skill/SKILL.md
      const skillFile = join(fullPath, 'SKILL.md');
      try {
        const content = await readFile(skillFile, 'utf-8');
        skills.push(parseSkillFile(content, skillFile));
      } catch (e) {
        // No SKILL.md (ENOENT) → silently skip; present but parse failure → warn
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.warn(`[skills-loader] skip ${skillFile}: ${err.message}`);
        }
      }
    }
  }

  return skills;
}

/**
 * Load skills from multiple directories (in priority order)
 *
 * When skills share the same name, higher-priority directories override lower-priority ones.
 *
 * @param workDir    Working directory (optional, used for workspace skills)
 * @param extraDirs  Additional skill directories
 * @returns          Deduplicated skill list
 */
export async function loadSkills(
  workDir?: string,
  extraDirs?: string[],
): Promise<ParsedSkill[]> {
  const dirs: string[] = [];

  // Priority 1 (highest): workspace .philont/skills/ (philont main directory, installed by clawhub)
  if (workDir) {
    dirs.push(join(workDir, '.philont', 'skills'));
    // Priority 2: workspace skills/ (openclaw upstream convention, for compatibility with direct `clawhub install`)
    dirs.push(join(workDir, 'skills'));
  }

  // Priority 3: global skills
  dirs.push(join(homedir(), '.philont', 'skills'));

  // Extra directories (priority 4, bundled skills go here)
  if (extraDirs) {
    dirs.push(...extraDirs);
  }

  // Load in priority order; deduplicate by name (higher-priority overrides lower-priority)
  const skillMap = new Map<string, ParsedSkill>();

  // Load lower-priority first (later entries overwrite earlier ones)
  for (const dir of dirs.reverse()) {
    const skills = await loadSkillsFromDir(dir);
    for (const skill of skills) {
      skillMap.set(skill.name, skill);
    }
  }

  return Array.from(skillMap.values());
}

/**
 * Watch a skill directory for incremental changes and invoke the callback after debounce.
 *
 * Design choices:
 *   - Does not track which specific file changed; reloads the whole directory (N is small, cost is low)
 *   - Debounce 250ms to coalesce multiple fs events from a single edit
 *   - Returns a no-op handle when the directory does not exist (some systems have no workspace skill directory)
 *
 * @returns close to release the watcher
 */
export function watchSkillDir(
  dir: string,
  onChange: (dir: string) => void,
  debounceMs = 250
): { close: () => void } {
  let timer: NodeJS.Timeout | null = null;
  // 2026-05-20 diagnostics: collect filenames from the current batch of fs events; aggregate-log once when debounce fires.
  // 10s throttle — even if the trigger source is high-frequency (self-oscillation / frequent external writes),
  // the log doesn't flood, but you can still see which files are triggering reloads to diagnose the root cause of hot-reload storms.
  let pendingEvents: string[] = [];
  let lastDiagLogAt = 0;
  const DIAG_LOG_INTERVAL_MS = 10_000;

  const schedule = (eventType?: string, filename?: string | Buffer | null) => {
    if (filename) {
      pendingEvents.push(`${eventType ?? '?'}:${String(filename)}`);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const batch = pendingEvents;
      pendingEvents = [];
      const now = Date.now();
      if (batch.length > 0 && now - lastDiagLogAt >= DIAG_LOG_INTERVAL_MS) {
        lastDiagLogAt = now;
        const uniq = [...new Set(batch)];
        const shown = uniq.slice(0, 6).join(', ');
        const more = uniq.length > 6 ? ` +${uniq.length - 6} more` : '';
        console.log(
          `[skill-watch] ${dir}: reload triggered by ${batch.length} fs event(s) → ${shown}${more}`,
        );
      }
      try {
        onChange(dir);
      } catch {
        // Internal exceptions in onChange must not kill the watcher
      }
    }, debounceMs);
  };

  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(dir, { recursive: true }, schedule);
  } catch {
    // Directory does not exist or platform does not support recursive → return no-op
    return { close: () => {} };
  }

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
    },
  };
}
