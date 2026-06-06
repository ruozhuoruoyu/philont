/**
 * FetchedResourceStore — persists fetched external resources locally
 *
 * Design follows the openclaw `~/.openclaw/workspace/` pattern:
 *   - Files are just files, stored on the local filesystem (`~/.philont/workspace/fetched/`), not stuffed into SQLite
 *   - Names preserve readable semantics (`mycox-ai-guide.md`), not hash-named
 *   - Manifest is a JSON file not a table (`_manifest.json`), zero schema migration
 *
 * Purpose: Phase 10 fixes the Phase 9.2 gap where aux cannot see fetched guide content —
 *   chat-handler hooks and persists after successful tool execution; when aux calls
 *   plan_review/verifyClose, resolveGuideText queries the manifest to get the real content
 *   and passes it to the aux LLM.
 *
 * No dedup to content-addressed (over-engineering); no encryption (future extension for privacy scenarios).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────

export interface FetchedResource {
  /** 'url' = webFetch/fetchUrl; 'local' = readFile; 'download' = downloadFile */
  sourceKind: 'url' | 'local' | 'download';
  /** Original source identifier: URL / 'local:<absPath>' / 'download:<remoteUrl>' */
  sourceRef: string;
  /** Filename after persisting (excluding directory) */
  filename: string;
  /** Absolute path after persisting */
  localPath: string;
  /** content-type (if known), e.g. text/markdown / application/pdf */
  mime: string | null;
  /** Binary vs text: binary cannot be directly used in aux prompt */
  isBinary: boolean;
  /** Byte size (on disk) */
  byteSize: number;
  /** Character count (text only) */
  charSize?: number;
  /** Tool name that fetched this resource: webFetch / readFile / fetchUrl / downloadFile */
  sourceTool: string;
  /** UTC ms, most recent fetch time */
  fetchedAt: number;
  /** Turn-level id (optional, for debugging) */
  turnId?: string | null;
  /** Session id (optional, for filtering by session) */
  sessionId?: string | null;
  /** HTTP status code (url/download only) */
  httpStatus?: number | null;
  /** Extractor used by webFetch (markdown / text / raw) */
  extractor?: string | null;
  /** Content SHA-256 hex, used for dedup detection on repeated fetches of the same URL */
  contentHash: string;
  /** Actual persisted path on download (not copied to fetched/, referenced only) */
  actualPath?: string | null;
}

export interface PutInput {
  sourceKind: 'url' | 'local' | 'download';
  sourceRef: string;
  /** Text content (preferred), mutually exclusive with contentBytes */
  content?: string;
  /** Binary content, mutually exclusive with content */
  contentBytes?: Buffer;
  mime?: string | null;
  sourceTool: string;
  httpStatus?: number | null;
  extractor?: string | null;
  turnId?: string | null;
  sessionId?: string | null;
  /** Download mode: do not write to local fetched/ directory, only record actualPath reference */
  actualPath?: string | null;
}

interface ManifestEntry {
  filename: string;
  mime: string | null;
  is_binary: boolean;
  byte_size: number;
  char_size?: number;
  source_tool: string;
  fetched_at: number;
  turn_id?: string | null;
  session_id?: string | null;
  http_status?: number | null;
  extractor?: string | null;
  content_hash: string;
  source_kind: 'url' | 'local' | 'download';
  source_ref: string;
  actual_path?: string | null;
}

// ── Config ────────────────────────────────────────────────────────────

export interface FetchedResourceStoreOptions {
  /** Root directory, default ~/.philont/workspace/fetched/ (overridden by env PHILONT_HOME) */
  baseDir?: string;
  /** Manifest write debounce ms, default 500 */
  flushDebounceMs?: number;
  /** Text size limit (bytes) — skip persisting if exceeded. Default 10MB (PHILONT_FETCHED_MAX_TEXT_MB) */
  maxTextBytes?: number;
  /** Binary size limit (bytes) — skip persisting if exceeded. Default 50MB (PHILONT_FETCHED_MAX_BIN_MB) */
  maxBinBytes?: number;
  /** Disable the entire store (equivalent to env PHILONT_FETCHED_ENABLED=0) */
  enabled?: boolean;
}

const DEFAULT_FLUSH_MS = 500;
const DEFAULT_MAX_TEXT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BIN_BYTES = 50 * 1024 * 1024;

// Common binary mime prefixes (fast check). If no match, fall back to heuristic (whether content_bytes is UTF-8).
const BINARY_MIME_PATTERNS = [
  /^application\/(pdf|zip|gzip|octet-stream|msword|vnd\.)/i,
  /^image\//i,
  /^audio\//i,
  /^video\//i,
  /^font\//i,
];

// Common mime → extension mapping (used to infer extension when URL has none)
const MIME_TO_EXT: Record<string, string> = {
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/css': 'css',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

// ── Utility functions ──────────────────────────────────────────────────────────

export function defaultBaseDir(): string {
  const home = process.env.PHILONT_HOME?.trim() || join(homedir(), '.philont');
  return join(home, 'workspace', 'fetched');
}

/** Determine whether a mime type is binary */
export function isMimeBinary(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return BINARY_MIME_PATTERNS.some((re) => re.test(mime));
}

/** Infer file extension from URL (prefer last path segment / fall back to mime) */
export function inferExtFromUrl(url: string, mime: string | null | undefined): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const ext = extname(last).replace(/^\./, '').toLowerCase();
    if (ext && /^[a-z0-9]{1,10}$/.test(ext)) return ext;
  } catch {
    /* invalid URL,go to mime fallback */
  }
  if (mime) {
    const m = mime.toLowerCase().split(';')[0].trim();
    if (MIME_TO_EXT[m]) return MIME_TO_EXT[m];
  }
  return 'bin';
}

/** URL → readable filename: hostname-pathLastTwo.ext; caller adds hash suffix on name collision */
export function fileNameFromUrl(url: string, mime: string | null | undefined): string {
  let host = '';
  let pathParts: string[] = [];
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    pathParts = u.pathname.split('/').filter(Boolean);
  } catch {
    // URL parse failed, fall back to hash
    return `url-${sha256(url).slice(0, 12)}.bin`;
  }
  const lastTwo = pathParts.slice(-2);
  const ext = inferExtFromUrl(url, mime);
  // If the last segment already has an extension, strip it before appending new ext (avoids guide.md → guide.md.md)
  if (lastTwo.length > 0) {
    const last = lastTwo[lastTwo.length - 1];
    const lastExt = extname(last);
    if (lastExt) {
      lastTwo[lastTwo.length - 1] = last.slice(0, last.length - lastExt.length);
    }
  }
  const stem = [host, ...lastTwo].filter(Boolean).join('-');
  const cleaned = sanitizeFileName(stem) || `url-${sha256(url).slice(0, 12)}`;
  // Total length cap 60 chars (excluding extension)
  const truncated = cleaned.length > 60 ? cleaned.slice(0, 52) + '-' + sha256(cleaned).slice(0, 6) : cleaned;
  return `${truncated}.${ext}`;
}

/** Local path → `local-<basename>` */
export function fileNameFromLocalPath(absPath: string): string {
  const base = basename(absPath);
  const cleaned = sanitizeFileName(base) || 'unnamed';
  const truncated = cleaned.length > 60 ? cleaned.slice(0, 52) + '-' + sha256(absPath).slice(0, 6) : cleaned;
  return `local-${truncated}`;
}

/** Replace filesystem-illegal characters with - */
function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Heuristically determine whether a buffer is valid UTF-8 text */
function isLikelyTextBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  // Sample check: first 4KB
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    // High occurrence of common control chars (excluding \t\n\r) + NUL → binary
    if (c === 0) return false;
    if (c < 0x09 || (c > 0x0d && c < 0x20)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

// ── Store implementation ────────────────────────────────────────────────────────

export class FetchedResourceStore {
  readonly baseDir: string;
  readonly enabled: boolean;
  private readonly flushDebounceMs: number;
  private readonly maxTextBytes: number;
  private readonly maxBinBytes: number;

  private manifest: Map<string, ManifestEntry> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private manifestDirty = false;
  private closed = false;

  constructor(opts: FetchedResourceStoreOptions = {}) {
    this.enabled =
      opts.enabled ?? (process.env.PHILONT_FETCHED_ENABLED !== '0');
    this.baseDir = resolve(opts.baseDir ?? defaultBaseDir());
    this.flushDebounceMs = opts.flushDebounceMs ?? DEFAULT_FLUSH_MS;
    this.maxTextBytes =
      opts.maxTextBytes ??
      mbToBytes(process.env.PHILONT_FETCHED_MAX_TEXT_MB, DEFAULT_MAX_TEXT_BYTES);
    this.maxBinBytes =
      opts.maxBinBytes ??
      mbToBytes(process.env.PHILONT_FETCHED_MAX_BIN_MB, DEFAULT_MAX_BIN_BYTES);

    if (!this.enabled) return;

    try {
      mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      // Directory creation failed → disable store, all put/find degrade to no-op
      console.warn('[fetched-store] mkdir failed, store disabled:', (e as Error).message);
      (this as { enabled: boolean }).enabled = false;
      return;
    }

    this.loadManifest();
  }

  /** Write resource: persist to disk + update manifest. Returns FetchedResource (null on failure) */
  put(input: PutInput): FetchedResource | null {
    if (!this.enabled || this.closed) return null;
    const ref = input.sourceRef.trim();
    if (!ref) return null;
    try {
      // 1. Determine filename + size check
      const { filename, isBinary, byteSize, charSize, content, contentBytes } =
        this.prepareContent(input);

      if (input.sourceKind === 'download') {
        // download: do not copy content, only record reference
        const entry: ManifestEntry = {
          filename: input.actualPath ?? '',
          mime: input.mime ?? null,
          is_binary: true,
          byte_size: byteSize,
          source_tool: input.sourceTool,
          fetched_at: Date.now(),
          turn_id: input.turnId ?? null,
          session_id: input.sessionId ?? null,
          http_status: input.httpStatus ?? null,
          content_hash: '',
          source_kind: 'download',
          source_ref: ref,
          actual_path: input.actualPath ?? null,
        };
        this.manifest.set(ref, entry);
        this.markDirty();
        return this.entryToResource(entry);
      }

      // size cap check
      const cap = isBinary ? this.maxBinBytes : this.maxTextBytes;
      if (byteSize > cap) {
        console.warn(
          `[fetched-store] skip(too-large) ref=${ref} bytes=${byteSize} cap=${cap}`,
        );
        return null;
      }

      // 2. Compute content_hash
      const data = contentBytes ?? Buffer.from(content ?? '', 'utf-8');
      const contentHash = sha256(data);

      // 3. Same ref already exists + same content_hash → only update fetched_at (IO optimization)
      const existing = this.manifest.get(ref);
      if (existing && existing.content_hash === contentHash) {
        existing.fetched_at = Date.now();
        existing.turn_id = input.turnId ?? existing.turn_id;
        existing.session_id = input.sessionId ?? existing.session_id;
        this.markDirty();
        return this.entryToResource(existing);
      }

      // 4. Choose filename (add hash suffix on collision)
      let finalName = filename;
      if (this.filenameCollidesWithDifferentRef(filename, ref)) {
        const ext = extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        finalName = `${stem}-${contentHash.slice(0, 8)}${ext}`;
      }

      // 5. Write to disk
      const filePath = join(this.baseDir, finalName);
      writeFileSync(filePath, data, { mode: 0o600 });

      // 6. Update manifest
      const entry: ManifestEntry = {
        filename: finalName,
        mime: input.mime ?? null,
        is_binary: isBinary,
        byte_size: byteSize,
        char_size: charSize,
        source_tool: input.sourceTool,
        fetched_at: Date.now(),
        turn_id: input.turnId ?? null,
        session_id: input.sessionId ?? null,
        http_status: input.httpStatus ?? null,
        extractor: input.extractor ?? null,
        content_hash: contentHash,
        source_kind: input.sourceKind,
        source_ref: ref,
      };
      // Same ref writing new content → delete old file if filename differs
      if (existing && existing.filename !== finalName) {
        try {
          rmSync(join(this.baseDir, existing.filename), { force: true });
        } catch {
          /* ignore */
        }
      }
      this.manifest.set(ref, entry);
      this.markDirty();
      return this.entryToResource(entry);
    } catch (e) {
      console.warn('[fetched-store] put failed, skipped:', (e as Error).message);
      return null;
    }
  }

  findByUrl(url: string): FetchedResource | null {
    return this.findBySourceRef(url);
  }

  findByPath(absPath: string): FetchedResource | null {
    return this.findBySourceRef(`local:${absPath}`);
  }

  findBySourceRef(ref: string): FetchedResource | null {
    if (!this.enabled) return null;
    const entry = this.manifest.get(ref.trim());
    if (!entry) return null;
    // Lazy cleanup: file not found → delete manifest entry
    if (entry.source_kind !== 'download' && !existsSync(join(this.baseDir, entry.filename))) {
      this.manifest.delete(ref);
      this.markDirty();
      return null;
    }
    return this.entryToResource(entry);
  }

  /** Read text content (calling on binary resource → throws, use getBytes instead) */
  getContent(resource: FetchedResource): string {
    if (!this.enabled) return '';
    if (resource.isBinary) {
      throw new Error(
        `FetchedResourceStore.getContent: ${resource.filename} 是二进制,改用 getBytes`,
      );
    }
    if (resource.sourceKind === 'download') {
      throw new Error('FetchedResourceStore.getContent: download 资源无 content,只有 actualPath 引用');
    }
    return readFileSync(resource.localPath, 'utf-8');
  }

  getBytes(resource: FetchedResource): Buffer {
    if (!this.enabled) return Buffer.alloc(0);
    if (resource.sourceKind === 'download') {
      throw new Error('FetchedResourceStore.getBytes: download 资源无 content,只有 actualPath 引用');
    }
    return readFileSync(resource.localPath);
  }

  listRecent(opts: {
    sinceTs?: number;
    limit?: number;
    sessionId?: string;
  } = {}): FetchedResource[] {
    if (!this.enabled) return [];
    const since = opts.sinceTs ?? 0;
    const limit = opts.limit ?? 50;
    const sessionId = opts.sessionId;
    const out: FetchedResource[] = [];
    for (const entry of this.manifest.values()) {
      if (entry.fetched_at < since) continue;
      if (sessionId && entry.session_id !== sessionId) continue;
      out.push(this.entryToResource(entry));
    }
    out.sort((a, b) => b.fetchedAt - a.fetchedAt);
    return out.slice(0, limit);
  }

  listBySession(sessionId: string): FetchedResource[] {
    return this.listRecent({ sessionId, limit: 1000 });
  }

  invalidate(sourceRef: string): boolean {
    if (!this.enabled) return false;
    const ref = sourceRef.trim();
    const entry = this.manifest.get(ref);
    if (!entry) return false;
    if (entry.source_kind !== 'download') {
      try {
        rmSync(join(this.baseDir, entry.filename), { force: true });
      } catch {
        /* ignore */
      }
    }
    this.manifest.delete(ref);
    this.markDirty();
    return true;
  }

  /** Delete resources with fetched_at < now-ttl. Returns count deleted. ttl=0 means decay disabled. */
  decayStale(now: number, ttlMs: number): number {
    if (!this.enabled || ttlMs <= 0) return 0;
    const cutoff = now - ttlMs;
    let count = 0;
    for (const [ref, entry] of this.manifest.entries()) {
      if (entry.fetched_at < cutoff) {
        if (entry.source_kind !== 'download') {
          try {
            rmSync(join(this.baseDir, entry.filename), { force: true });
          } catch {
            /* ignore */
          }
        }
        this.manifest.delete(ref);
        count++;
      }
    }
    if (count > 0) this.markDirty();
    return count;
  }

  /** Force flush manifest to disk (for graceful shutdown) */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.manifestDirty) this.flushManifestSync();
  }

  /** For testing: return a copy of the manifest */
  _snapshotManifest(): Record<string, ManifestEntry> {
    const out: Record<string, ManifestEntry> = {};
    for (const [k, v] of this.manifest.entries()) out[k] = { ...v };
    return out;
  }

  // ── Internal helpers ──

  private prepareContent(input: PutInput): {
    filename: string;
    isBinary: boolean;
    byteSize: number;
    charSize?: number;
    content?: string;
    contentBytes?: Buffer;
  } {
    // download mode: does not hold content
    if (input.sourceKind === 'download') {
      let byteSize = 0;
      try {
        if (input.actualPath && existsSync(input.actualPath)) {
          byteSize = statSync(input.actualPath).size;
        }
      } catch {
        /* ignore */
      }
      return {
        filename: '',
        isBinary: true,
        byteSize,
      };
    }

    // url / local
    const mime = input.mime ?? null;
    let buf: Buffer;
    let isBinary: boolean;
    let charSize: number | undefined;

    if (input.contentBytes) {
      buf = input.contentBytes;
      isBinary = isMimeBinary(mime) || !isLikelyTextBuffer(buf);
    } else if (typeof input.content === 'string') {
      buf = Buffer.from(input.content, 'utf-8');
      isBinary = isMimeBinary(mime);
      charSize = input.content.length;
    } else {
      throw new Error('FetchedResourceStore.put: 必须传 content 或 contentBytes');
    }

    const filename =
      input.sourceKind === 'url'
        ? fileNameFromUrl(input.sourceRef, mime)
        : fileNameFromLocalPath(stripLocalPrefix(input.sourceRef));

    return {
      filename,
      isBinary,
      byteSize: buf.length,
      charSize,
      content: typeof input.content === 'string' ? input.content : undefined,
      contentBytes: input.contentBytes,
    };
  }

  private filenameCollidesWithDifferentRef(filename: string, ref: string): boolean {
    for (const [otherRef, entry] of this.manifest.entries()) {
      if (otherRef !== ref && entry.filename === filename) return true;
    }
    return false;
  }

  private entryToResource(entry: ManifestEntry): FetchedResource {
    return {
      sourceKind: entry.source_kind,
      sourceRef: entry.source_ref,
      filename: entry.filename,
      localPath:
        entry.source_kind === 'download'
          ? entry.actual_path ?? ''
          : join(this.baseDir, entry.filename),
      mime: entry.mime,
      isBinary: entry.is_binary,
      byteSize: entry.byte_size,
      charSize: entry.char_size,
      sourceTool: entry.source_tool,
      fetchedAt: entry.fetched_at,
      turnId: entry.turn_id ?? null,
      sessionId: entry.session_id ?? null,
      httpStatus: entry.http_status ?? null,
      extractor: entry.extractor ?? null,
      contentHash: entry.content_hash,
      actualPath: entry.actual_path ?? null,
    };
  }

  private manifestPath(): string {
    return join(this.baseDir, '_manifest.json');
  }

  private loadManifest(): void {
    const path = this.manifestPath();
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, ManifestEntry>;
      for (const [k, v] of Object.entries(parsed)) {
        this.manifest.set(k, v);
      }
    } catch (e) {
      // manifest corrupted → back up original file + start fresh
      const bakPath = `${path}.bak.${Date.now()}`;
      try {
        renameSync(path, bakPath);
        console.warn(
          `[fetched-store] manifest corrupted, backed up to ${bakPath}, starting empty manifest:`,
          (e as Error).message,
        );
      } catch {
        /* ignore */
      }
    }
  }

  private markDirty(): void {
    this.manifestDirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.manifestDirty && !this.closed) this.flushManifestSync();
    }, this.flushDebounceMs);
    // Do not block the process
    this.flushTimer.unref?.();
  }

  private flushManifestSync(): void {
    if (!this.enabled) return;
    const path = this.manifestPath();
    const obj: Record<string, ManifestEntry> = {};
    for (const [k, v] of this.manifest.entries()) obj[k] = v;
    const tmp = `${path}.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
      this.manifestDirty = false;
    } catch (e) {
      console.warn('[fetched-store] manifest flush failed:', (e as Error).message);
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function mbToBytes(envValue: string | undefined, defaultBytes: number): number {
  if (!envValue) return defaultBytes;
  const n = parseFloat(envValue);
  if (!isFinite(n) || n <= 0) return defaultBytes;
  return Math.floor(n * 1024 * 1024);
}

function stripLocalPrefix(ref: string): string {
  return ref.startsWith('local:') ? ref.slice('local:'.length) : ref;
}
