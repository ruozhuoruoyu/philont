/**
 * PlanFileStore — per-project plan.md long-term working notes (Phase 13, 2026-05-17)
 *
 * Design motivation
 * ────────
 * philont currently packs plan state / Lessons / failure patterns / schedule_outcomes into the prefix,
 * rebuilt every turn; prefix fluctuates 5-8KB → almost zero cache hits + LLM attention dilution.
 *
 * This module opens a **file-level** working notebook for long-lived agent roles (e.g. mycox / github-bot):
 * `~/.philont/projects/<name>/plan.md`, LLM-authored + mechanism-layer hook writes.
 * Accumulates Operational Knowledge / Lessons across sessions / fires, not broken by reflection
 * JSON parse failures.
 *
 * Relationship with DB plans: DB is the machine-validated ground truth (spec-coverage / C1-C4), plan.md is
 * the LLM's human-readable narrative. Each DB plan links to a project name via the `persisted_to` column;
 * plan_draft / plan_update_step / plan_close tools internally hook into this store.
 *
 * Design reference: FetchedResourceStore pattern — files are files, not stuffed into SQLite; names retain
 * readable semantics; Manifest is a _meta.json file, zero schema migration.
 *
 * plan.md structure (skeleton created by loadOrCreate):
 *
 *   ---
 *   project: mycox
 *   created: <ISO>
 *   updated: <ISO>
 *   status: active
 *   runs_completed: 0
 *   ---
 *
 *   # mycox
 *
 *   ## Goal
 *   ...
 *
 *   ## Operational Knowledge
 *   ...
 *
 *   ## Lessons
 *   ...
 *
 *   ## Recent Runs
 *   ### Run N - <ts> - <status>
 *   ...
 *
 *   ## Archive Summary
 *   ...
 *
 * Compaction strategy (algorithmic, no LLM needed):
 *   - Recent Runs rolls to N=10; oldest runs beyond the limit move to Archive Summary as a single line
 *   - Lessons deduplicated by SHA-256(text); duplicates skipped (no count increment, simplified)
 *   - No hard upper limit (trusts the rolling mechanism)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────

export interface PlanFileInitial {
  /** Project goal — inferred from deliverables at plan_draft time, or provided by LLM */
  goal?: string;
  /** Initial deliverables (plan_draft input parameter) */
  deliverables?: Array<{ id: string; description: string }>;
}

export interface RunEntry {
  /** Run start time (turn start point) */
  startedAt: number;
  /** Run end time */
  endedAt: number;
  /** 'ok' / 'partial' / 'failed' */
  outcome: 'ok' | 'partial' | 'failed';
  /** 1-3 line human-readable summary (http stats / failure signatures / key actions) */
  summary: string;
  /** Associated DB plan id (for traceability) */
  planId?: string;
}

export interface PlanFileStoreOptions {
  /** Base directory, default ~/.philont/projects/ (env PHILONT_PROJECTS_DIR overrides) */
  baseDir?: string;
  /** Number of Recent Runs to keep, default 10 (env PHILONT_PLAN_FILE_RUNS_KEEP overrides) */
  runsKeep?: number;
}

// ── Default configuration ─────────────────────────────────────────────────────────

export function defaultProjectsBaseDir(): string {
  const envPath = process.env.PHILONT_PROJECTS_DIR?.trim();
  if (envPath) return resolve(envPath);
  const home = process.env.PHILONT_HOME?.trim() || join(homedir(), '.philont');
  return join(home, 'projects');
}

// ── Internal helpers ─────────────────────────────────────────────────────

const KEBAB_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

function isValidProjectName(name: string): boolean {
  return KEBAB_RE.test(name);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Phase 15.6 Fix B (2026-05-18): Extract the "METHOD path" canonical key from an entry
 * for use in endpoints section dedup.
 *
 * Examples:
 *   "POST /api/posts/:public_id/upvote — toggle vote" → "POST /api/posts/:id/upvote"
 *   "POST /api/posts/aa49f397/upvote" → "POST /api/posts/:id/upvote"
 *   (8-hex id and :placeholder both normalized to :id)
 *
 * Returns null if no METHOD + path found; caller falls back to full-text hash dedup.
 */
function extractEndpointKey(text: string): string | null {
  const m = text.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/\S+)/i);
  if (!m) return null;
  const method = m[1].toUpperCase();
  // Strip trailing punctuation / quotes from path (LLM may append ",。: etc. at sentence end)
  const rawPath = m[2].replace(/[",.:;!?<>)\]]+$/, '');
  // normalize: UUID / hex-id / :placeholder all changed to :id; numeric ids also → :id
  const normPath = rawPath
    .replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '/:id') // full UUID
    .replace(/\/[0-9a-f]{8}\b/g, '/:id') // 8-hex public_id
    .replace(/\/:\w+/g, '/:id') // :anything → :id
    .replace(/\/\d+\b/g, '/:id'); // pure numeric id
  return `${method} ${normPath}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Split a markdown text into named sections. Returns Map<heading, body>.
 * heading does not include the "## " prefix; body contains all lines within the section (trailing blank lines stripped).
 * front-matter (--- ... ---) is extracted separately, stored as raw lines under key 'frontmatter'.
 */
function parseSections(md: string): { frontmatter: string; sections: Map<string, string> } {
  const lines = md.split(/\r?\n/);
  const sections = new Map<string, string>();
  let frontmatter = '';
  let i = 0;

  // Parse front-matter
  if (lines[0]?.trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j]?.trim() !== '---') j++;
    if (j < lines.length) {
      frontmatter = lines.slice(1, j).join('\n');
      i = j + 1;
    }
  }

  // Skip blank lines / # title after front-matter
  while (i < lines.length && !lines[i].startsWith('## ')) i++;

  // Split ## sections
  let currentHeading: string | null = null;
  let currentBody: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      if (currentHeading !== null) {
        sections.set(currentHeading, currentBody.join('\n').replace(/\n+$/, ''));
      }
      currentHeading = line.slice(3).trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading !== null) {
    sections.set(currentHeading, currentBody.join('\n').replace(/\n+$/, ''));
  }

  return { frontmatter, sections };
}

/** Write sections + frontmatter back to markdown (preserves section order = Map insertion order of input) */
function renderMarkdown(
  projectName: string,
  frontmatter: string,
  sections: Map<string, string>,
): string {
  const parts: string[] = [];
  parts.push('---');
  parts.push(frontmatter);
  parts.push('---');
  parts.push('');
  parts.push(`# ${projectName}`);
  parts.push('');
  for (const [heading, body] of sections) {
    parts.push(`## ${heading}`);
    parts.push('');
    if (body) {
      parts.push(body);
      parts.push('');
    }
  }
  return parts.join('\n');
}

/** Simple key:value parser for front-matter (each line `key: value`, no nesting supported) */
function parseFrontmatter(fm: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function renderFrontmatter(kv: Record<string, string>): string {
  return Object.entries(kv)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// ── PlanFileStore ──────────────────────────────────────────────────

export class PlanFileStore {
  readonly baseDir: string;
  readonly runsKeep: number;

  constructor(opts: PlanFileStoreOptions = {}) {
    this.baseDir = resolve(opts.baseDir ?? defaultProjectsBaseDir());
    this.runsKeep =
      opts.runsKeep ??
      (Number(process.env.PHILONT_PLAN_FILE_RUNS_KEEP) || 10);
  }

  /** List names of created project directories (deduplicated, sorted) */
  list(): string[] {
    if (!existsSync(this.baseDir)) return [];
    try {
      const entries = readdirSync(this.baseDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && isValidProjectName(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Compute the project directory + plan.md path (does not create them) */
  pathFor(projectName: string): { dir: string; planPath: string } {
    if (!isValidProjectName(projectName)) {
      throw new Error(
        `invalid project name "${projectName}" — must be kebab-case (1-60 chars, [a-z0-9-], no leading/trailing dash)`,
      );
    }
    const dir = join(this.baseDir, projectName);
    return { dir, planPath: join(dir, 'plan.md') };
  }

  /** Create project directory (idempotent) */
  ensureProjectDir(projectName: string): string {
    const { dir } = this.pathFor(projectName);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Read plan.md, creating an empty skeleton if it does not exist.
   * When initial is provided, it fills in the Goal / Sub-tasks sections (only if the skeleton section is empty).
   */
  loadOrCreate(projectName: string, initial?: PlanFileInitial): string {
    const { planPath } = this.pathFor(projectName);
    this.ensureProjectDir(projectName);
    if (existsSync(planPath)) {
      return readFileSync(planPath, 'utf-8');
    }
    const ts = nowIso();
    const fm: Record<string, string> = {
      project: projectName,
      created: ts,
      updated: ts,
      status: 'active',
      runs_completed: '0',
    };
    const sections = new Map<string, string>();
    sections.set('Goal', initial?.goal?.trim() ?? '(to be filled by LLM)');
    const dlb = initial?.deliverables ?? [];
    sections.set(
      'Sub-tasks',
      dlb.length > 0
        ? dlb
            .map((d) => `- [ ] **${d.id}**: ${d.description}`)
            .join('\n')
        : '(LLM to fill in at plan_draft time)',
    );
    sections.set('Operational Knowledge', '(LLM accumulated: endpoints / limits / credential names / known gotchas)');
    sections.set('Lessons', '(auto-appended by plan_close on failure; mechanism layer deduplicates by hash)');
    sections.set('Recent Runs', '(appended on plan_close; rolling window keeps latest ' + this.runsKeep + ' entries)');
    sections.set('Archive Summary', '(older runs summarized one-line each, kept permanently)');
    const md = renderMarkdown(projectName, renderFrontmatter(fm), sections);
    writeFileSync(planPath, md, 'utf-8');
    return md;
  }

  /** Read the entire file */
  getMarkdown(projectName: string): string | null {
    const { planPath } = this.pathFor(projectName);
    if (!existsSync(planPath)) return null;
    return readFileSync(planPath, 'utf-8');
  }

  /**
   * Append a run to the "## Recent Runs" section; when count exceeds runsKeep, roll: oldest entry → Archive Summary single line.
   * Run header format: `### Run <N> - <startedAt ISO> - <outcome>`
   */
  appendRun(projectName: string, entry: RunEntry): void {
    this.ensureProjectDir(projectName);
    this.loadOrCreate(projectName); // ensure file exists with skeleton
    const { planPath } = this.pathFor(projectName);
    const md = readFileSync(planPath, 'utf-8');
    const { frontmatter, sections } = parseSections(md);

    const fm = parseFrontmatter(frontmatter);
    const completedCount = Number(fm.runs_completed) || 0;
    const newCount = completedCount + 1;
    fm.runs_completed = String(newCount);
    fm.updated = nowIso();

    // Parse current Recent Runs block into individual Run list (split on `### Run N`)
    const runsBody = sections.get('Recent Runs') ?? '';
    const runBlocks = this._splitRunBlocks(runsBody);

    // New run block
    const startedIso = new Date(entry.startedAt).toISOString();
    const durationSec = Math.round((entry.endedAt - entry.startedAt) / 1000);
    const newBlock = [
      `### Run ${newCount} - ${startedIso} - ${entry.outcome} (${durationSec}s)`,
      '',
      entry.summary.trim() || '(no summary)',
      ...(entry.planId ? ['', `_plan_id: ${entry.planId}_`] : []),
    ].join('\n');

    // prepend new run (newest on top); roll: oldest beyond runsKeep moves to Archive
    const allRuns = [newBlock, ...runBlocks];
    let archived: string | null = null;
    while (allRuns.length > this.runsKeep) {
      const oldest = allRuns.pop()!;
      const oneLine = this._compressRunToOneLine(oldest);
      archived = archived ? archived + '\n' + oneLine : oneLine;
    }

    sections.set('Recent Runs', allRuns.join('\n\n'));
    if (archived) {
      const cur = sections.get('Archive Summary') ?? '';
      const cleaned = cur.includes('older runs summarized one-line each') ? '' : cur;
      sections.set(
        'Archive Summary',
        [cleaned, archived].filter(Boolean).join('\n'),
      );
    }

    const newMd = renderMarkdown(projectName, renderFrontmatter(fm), sections);
    writeFileSync(planPath, newMd, 'utf-8');
  }

  /** Parse Recent Runs body into an array of run blocks (split on ### Run) */
  private _splitRunBlocks(body: string): string[] {
    if (!body || /^\(.*plan_close.*\)$/.test(body.trim())) return [];
    const blocks: string[] = [];
    const lines = body.split(/\r?\n/);
    let cur: string[] | null = null;
    for (const line of lines) {
      if (/^### Run\b/.test(line)) {
        if (cur) blocks.push(cur.join('\n').replace(/\n+$/, ''));
        cur = [line];
      } else if (cur) {
        cur.push(line);
      }
    }
    if (cur) blocks.push(cur.join('\n').replace(/\n+$/, ''));
    return blocks;
  }

  /** Compress a run block into a single-line archive summary */
  private _compressRunToOneLine(block: string): string {
    const firstLine = block.split(/\r?\n/)[0] ?? '';
    // e.g. "### Run 3 - 2026-05-17T... - failed (98s)" → "Run 3: failed (98s) @ 2026-05-17T..."
    const m = firstLine.match(/^### Run (\d+) - (\S+) - (\w+)(?:\s*\(([^)]+)\))?/);
    if (m) {
      const [, n, ts, outcome, dur] = m;
      return `- Run ${n}: ${outcome}${dur ? ` (${dur})` : ''} @ ${ts}`;
    }
    return `- ${firstLine.replace(/^### Run /, 'Run ')}`;
  }

  /**
   * Append a lesson to the "## Lessons" section, SHA-256(text) deduplication (skip if already present).
   * Returns true if actually added.
   */
  appendLesson(projectName: string, lesson: string): boolean {
    const text = lesson.trim();
    if (!text) return false;
    this.ensureProjectDir(projectName);
    this.loadOrCreate(projectName);
    const { planPath } = this.pathFor(projectName);
    const md = readFileSync(planPath, 'utf-8');
    const { frontmatter, sections } = parseSections(md);

    const cur = sections.get('Lessons') ?? '';
    const cleaned = cur.includes('auto-appended by plan_close') ? '' : cur;

    // Dedup by sha-256(line text)
    const hash = sha256(text);
    const existingLines = cleaned.split(/\r?\n/).filter((l) => l.trim());
    const hasHashMatch = existingLines.some((l) => {
      const m = l.match(/<!--\s*hash:([0-9a-f]{8,})\s*-->/);
      return m && hash.startsWith(m[1]);
    });
    if (hasHashMatch) return false;

    const ts = new Date().toISOString().slice(0, 10);
    const newLine = `- [${ts}] ${text} <!-- hash:${hash.slice(0, 12)} -->`;
    const newBody = [cleaned, newLine].filter(Boolean).join('\n');
    sections.set('Lessons', newBody);

    const fm = parseFrontmatter(frontmatter);
    fm.updated = nowIso();
    const newMd = renderMarkdown(projectName, renderFrontmatter(fm), sections);
    writeFileSync(planPath, newMd, 'utf-8');
    return true;
  }

  /**
   * Phase 14 (2026-05-18): Append a knowledge entry to the "## Operational Knowledge" section.
   *
   * Supports subsection classification (endpoints / auth / gotchas / etc.), entry includes SHA-256
   * deduplication (same text already present → skip). Difference between Lessons and this method:
   *   - Lessons: failure learnings (auto plan_close on failure)
   *   - Knowledge: success experience (LLM proactively calls plan_knowledge, or mechanism-layer reflection fallback)
   *
   * Internal structure (markdown within Operational Knowledge section):
   *   ### endpoints
   *   - [<ts>] POST /api/posts/<id>/upvote, headers {Authorization: Bearer {mycox-api-key}} → 200 <!-- hash:xxx -->
   *   - [<ts>] ...
   *   ### auth
   *   - ...
   *   ### gotchas
   *   - ...
   *
   * Subsection headings use h3 (`### `), auto-created on first occurrence.
   *
   * Returns true if actually added (false = same hash entry already exists, skip).
   */
  appendKnowledge(
    projectName: string,
    entry: string,
    subsection: string = 'general',
  ): boolean {
    // Phase 15.6 (2026-05-18) Fix A: when LLM calls plan_knowledge, entry text often contains
    // an existing hash comment (because LLM re-reads from plan.md), e.g. `... <!-- hash:abc -->`.
    // Without stripping: same endpoint different hash → both written → duplicate entries accumulate.
    // Fix: before append, strip any `<!-- hash:[0-9a-f]+ -->` comments (strip middle / trailing),
    // then hash + dedup.
    const text = entry
      .replace(/\s*<!--\s*hash:[0-9a-f]+\s*-->\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return false;
    const sub = (subsection || 'general').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    this.ensureProjectDir(projectName);
    this.loadOrCreate(projectName);
    const { planPath } = this.pathFor(projectName);
    const md = readFileSync(planPath, 'utf-8');
    const { frontmatter, sections } = parseSections(md);

    const cur = sections.get('Operational Knowledge') ?? '';
    // Clear skeleton placeholder text
    const cleaned = cur.includes('LLM accumulated') ? '' : cur;

    // Phase 15.6 Fix B: upgrade endpoints section dedup — use normalized "METHOD path" key,
    // not full-text hash. LLM describes same endpoint differently multiple times (`upvote (toggle)` vs
    // `upvote a post`) → full-text hash does not dedup → duplicate entries. Switch to extracting METHOD + path
    // as canonical key; second write of same endpoint is skipped immediately.
    //
    // Non-endpoints sections retain full-text hash dedup (auth / gotchas / limits etc. have no regular
    // METHOD path, text dedup is more stable).
    const endpointKey = sub === 'endpoints' ? extractEndpointKey(text) : null;

    const existingLines = cleaned.split(/\r?\n/).filter((l) => l.trim());

    if (endpointKey) {
      // endpoints section: check if any existing line has same METHOD + path
      const dupe = existingLines.find((l) => {
        const k = extractEndpointKey(l);
        return k === endpointKey;
      });
      if (dupe) return false;
    } else {
      // Other sections: full-text hash dedup (inline hash comment already stripped, stable)
      const hash = sha256(text);
      const hasHashMatch = existingLines.some((l) => {
        const m = l.match(/<!--\s*hash:([0-9a-f]{8,})\s*-->/);
        return m && hash.startsWith(m[1]);
      });
      if (hasHashMatch) return false;
    }

    const ts = new Date().toISOString().slice(0, 10);
    const hash = sha256(text);
    const newLine = `- [${ts}] ${text} <!-- hash:${hash.slice(0, 12)} -->`;

    // Find or create subsection (### <sub>)
    const subHeader = `### ${sub}`;
    const lines = cleaned.split(/\r?\n/);
    let subStart = lines.findIndex((l) => l.trim() === subHeader);
    let newBody: string;
    if (subStart === -1) {
      // append new subsection at end
      const appendChunk = (cleaned ? '\n' : '') + `${subHeader}\n${newLine}`;
      newBody = (cleaned + appendChunk).trim();
    } else {
      // Found the subsection; find next ### or end of file, insert newLine at section end
      let nextSubStart = lines.findIndex(
        (l, i) => i > subStart && /^### /.test(l.trim()),
      );
      if (nextSubStart === -1) nextSubStart = lines.length;
      const newLines = [
        ...lines.slice(0, nextSubStart),
        newLine,
        ...lines.slice(nextSubStart),
      ];
      newBody = newLines.join('\n').trim();
    }

    sections.set('Operational Knowledge', newBody);
    const fm = parseFrontmatter(frontmatter);
    fm.updated = nowIso();
    writeFileSync(
      planPath,
      renderMarkdown(projectName, renderFrontmatter(fm), sections),
      'utf-8',
    );
    return true;
  }

  /**
   * Phase 15.6 Fix C (2026-05-18): Replace the ## Sub-tasks section body with the deliverables list.
   *
   * Called once after plan_revise executes successfully, rendering the newly committed plan's real deliverables
   * into plan.md. LLM firing subsequently can see the task structure directly, no longer the skeleton placeholder.
   *
   * Render format:
   *   - [ ] **<id>**: <description>
   *
   * If deliverables is empty → keep section placeholder text unchanged.
   */
  updateSubTasks(
    projectName: string,
    deliverables: ReadonlyArray<{ id: string; description: string }>,
  ): void {
    if (deliverables.length === 0) return;
    this.ensureProjectDir(projectName);
    this.loadOrCreate(projectName);
    const { planPath } = this.pathFor(projectName);
    const md = readFileSync(planPath, 'utf-8');
    const { frontmatter, sections } = parseSections(md);
    const body = deliverables
      .map((d) => `- [ ] **${d.id}**: ${d.description}`)
      .join('\n');
    sections.set('Sub-tasks', body);
    const fm = parseFrontmatter(frontmatter);
    fm.updated = nowIso();
    writeFileSync(
      planPath,
      renderMarkdown(projectName, renderFrontmatter(fm), sections),
      'utf-8',
    );
  }

  /** Full replacement of Operational Knowledge section (LLM-managed, Phase 13 compatible; new code uses appendKnowledge) */
  updateKnowledge(projectName: string, body: string): void {
    this.ensureProjectDir(projectName);
    this.loadOrCreate(projectName);
    const { planPath } = this.pathFor(projectName);
    const md = readFileSync(planPath, 'utf-8');
    const { frontmatter, sections } = parseSections(md);
    sections.set('Operational Knowledge', body.trim() || '(empty)');
    const fm = parseFrontmatter(frontmatter);
    fm.updated = nowIso();
    writeFileSync(
      planPath,
      renderMarkdown(projectName, renderFrontmatter(fm), sections),
      'utf-8',
    );
  }

  /** Update front-matter status (active / completed / failed / paused) */
  updateStatus(projectName: string, status: string): void {
    this.ensureProjectDir(projectName);
    this.loadOrCreate(projectName);
    const { planPath } = this.pathFor(projectName);
    const md = readFileSync(planPath, 'utf-8');
    const { frontmatter, sections } = parseSections(md);
    const fm = parseFrontmatter(frontmatter);
    fm.status = status;
    fm.updated = nowIso();
    writeFileSync(
      planPath,
      renderMarkdown(projectName, renderFrontmatter(fm), sections),
      'utf-8',
    );
  }
}
