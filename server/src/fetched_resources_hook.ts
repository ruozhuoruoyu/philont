/**
 * Phase 10 M1 (2026-05-14): post-tool-execution hook that persists successful
 * webFetch / readFile results to FetchedResourceStore.
 *
 * Why at the server layer rather than agent-memory: parsing webFetch tool output
 * requires understanding the specific text format of formatPayload (URL: / Status: /
 * --- separator), which is an agent-tools implementation detail. agent-memory should
 * remain tool-agnostic.
 */

import { resolve as resolvePath } from 'node:path';
import type { FetchedResourceStore } from '@agent/memory';

export interface ParsedWebFetchOutput {
  url: string;
  finalUrl?: string;
  title?: string;
  status?: number;
  extractor?: string;
  truncated?: boolean;
  rawLength?: number;
  tookMs?: number;
  body: string;
}

/**
 * Parse the success.output text from a webFetch tool call (produced by webFetch.ts formatPayload).
 *
 * Expected format:
 *   URL: <url>
 *   [Final URL: <finalUrl>]
 *   [Title: <title>]
 *   Status: <status>
 *   Extractor: <extractor>
 *   [Truncated: true (raw length N)]
 *   Fetched in <n>ms
 *
 *   ---
 *
 *   <body>
 *
 * Parse failure (URL: header not found / --- separator not found) → returns null;
 * caller should skip persisting.
 */
export function parseWebFetchOutput(output: string): ParsedWebFetchOutput | null {
  if (!output || typeof output !== 'string') return null;
  const sepIdx = output.indexOf('\n---\n');
  if (sepIdx < 0) return null;
  const metaBlock = output.slice(0, sepIdx);
  const body = output.slice(sepIdx + '\n---\n'.length).replace(/^\n+/, '');

  const meta = parseMetaBlock(metaBlock);
  if (!meta.url) return null;

  return {
    url: meta.url,
    finalUrl: meta.finalUrl,
    title: meta.title,
    status: meta.status,
    extractor: meta.extractor,
    truncated: meta.truncated,
    rawLength: meta.rawLength,
    tookMs: meta.tookMs,
    body,
  };
}

interface MetaFields {
  url?: string;
  finalUrl?: string;
  title?: string;
  status?: number;
  extractor?: string;
  truncated?: boolean;
  rawLength?: number;
  tookMs?: number;
}

function parseMetaBlock(metaBlock: string): MetaFields {
  const out: MetaFields = {};
  for (const rawLine of metaBlock.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^URL:\s*(.+)$/))) out.url = m[1].trim();
    else if ((m = line.match(/^Final URL:\s*(.+)$/))) out.finalUrl = m[1].trim();
    else if ((m = line.match(/^Title:\s*(.+)$/))) out.title = m[1].trim();
    else if ((m = line.match(/^Status:\s*(\d+)/))) out.status = Number(m[1]);
    else if ((m = line.match(/^Extractor:\s*(.+)$/))) out.extractor = m[1].trim();
    else if ((m = line.match(/^Truncated:\s*true\s*\(raw length\s*(\d+)\)/))) {
      out.truncated = true;
      out.rawLength = Number(m[1]);
    } else if ((m = line.match(/^Fetched in\s*(\d+)ms/))) {
      out.tookMs = Number(m[1]);
    }
  }
  return out;
}

// ── Hook interface ─────────────────────────────────────────────────────────

export interface PersistHookContext {
  /** Current turn identifier (optional; stored in manifest for debugging) */
  turnId?: string | null;
  /** Current session identifier */
  sessionId?: string | null;
  /**
   * Phase 15.5 (2026-05-18): additional excluded directory prefixes (already resolved to
   * absolute paths). When the LLM reads a file under one of these directories via readFile,
   * the hook skips the put and does not copy the file into the fetched-store.
   *
   * Typical use: plan-files baseDir (`~/.philont/projects/`) — plan.md is produced by
   * PlanFileStore and should not be redundantly cached in fetched-store (would create
   * `local-plan.md` pollution in the workspace).
   */
  excludeDirs?: ReadonlyArray<string>;
}

export interface ToolCallSnapshot {
  toolName: string;
  params: Record<string, unknown>;
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Main entry point: called once after a tool executes successfully; identifies webFetch /
 * readFile calls and auto-persists their results.
 *
 * Does not throw — any failure logs a warn once and returns null; the main path is unaffected.
 *
 * Unsupported tools (downloadFile / inspectPath / others) → returns null (no-op).
 */
export function persistToolResultIfFetched(
  store: FetchedResourceStore,
  call: ToolCallSnapshot,
  ctx: PersistHookContext = {},
): void {
  if (!store.enabled) return;
  if (!call.success) return;

  try {
    if (call.toolName === 'webFetch') {
      const parsed = parseWebFetchOutput(call.output);
      if (!parsed) return;
      const r = store.put({
        sourceKind: 'url',
        sourceRef: parsed.url,
        content: parsed.body,
        mime: inferMimeFromExtractor(parsed.extractor),
        sourceTool: 'webFetch',
        httpStatus: parsed.status ?? null,
        extractor: parsed.extractor ?? null,
        turnId: ctx.turnId ?? null,
        sessionId: ctx.sessionId ?? null,
      });
      if (r) {
        console.log(
          `[fetched-store] put url=${parsed.url} filename=${r.filename} bytes=${r.byteSize}${r.charSize ? ' chars=' + r.charSize : ''}`,
        );
      }
      return;
    }

    if (call.toolName === 'readFile') {
      const rawPath = call.params?.path;
      if (typeof rawPath !== 'string' || !rawPath) return;
      const absPath = resolvePath(rawPath);
      // 2026-05-15: when the LLM reads a file inside the fetched/ directory via readFile,
      // skip the put — that file is already produced by fetched-store itself; re-putting it
      // would generate `local-` / `local-local-` recursive-prefix files polluting the workspace.
      // Cross-platform compatible (POSIX /, Windows \): compare prefix after resolvePath.
      const baseAbs = resolvePath(store.baseDir);
      if (
        absPath === baseAbs ||
        absPath.startsWith(baseAbs + '/') ||
        absPath.startsWith(baseAbs + '\\')
      ) {
        return;
      }
      // Phase 15.5 (2026-05-18): caller-specified excluded directories (e.g. plan-files
      // baseDir, ~/.philont/projects/). These are produced by philont's own stores;
      // copying them into fetched-store is meaningless and they will expire anyway.
      if (ctx.excludeDirs && ctx.excludeDirs.length > 0) {
        for (const dir of ctx.excludeDirs) {
          const dirAbs = resolvePath(dir);
          if (
            absPath === dirAbs ||
            absPath.startsWith(dirAbs + '/') ||
            absPath.startsWith(dirAbs + '\\')
          ) {
            return;
          }
        }
      }
      const r = store.put({
        sourceKind: 'local',
        sourceRef: `local:${absPath}`,
        content: call.output,
        mime: inferMimeFromPath(absPath),
        sourceTool: 'readFile',
        turnId: ctx.turnId ?? null,
        sessionId: ctx.sessionId ?? null,
      });
      if (r) {
        console.log(
          `[fetched-store] put local=${absPath} filename=${r.filename} bytes=${r.byteSize}`,
        );
      }
      return;
    }

    // Skip unrecognised tools
  } catch (e) {
    console.warn('[fetched-store] hook failed:', (e as Error).message);
  }
}

// ── MIME inference ─────────────────────────────────────────────────────────

function inferMimeFromExtractor(extractor: string | undefined): string | null {
  if (!extractor) return null;
  const e = extractor.toLowerCase();
  if (e === 'markdown' || e === 'text') return 'text/markdown';
  if (e === 'raw') return null;
  return null;
}

const EXT_TO_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  js: 'application/javascript',
  ts: 'application/typescript',
  py: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  css: 'text/css',
  toml: 'text/toml',
  ini: 'text/plain',
  conf: 'text/plain',
  log: 'text/plain',
};

function inferMimeFromPath(absPath: string): string | null {
  const m = absPath.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (!m) return null;
  return EXT_TO_MIME[m[1].toLowerCase()] ?? null;
}
