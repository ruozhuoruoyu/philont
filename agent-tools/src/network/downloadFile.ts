/**
 * downloadFile tool — stream the contents of a URL to local disk.
 *
 * Division of responsibility with webFetch:
 *   - webFetch: fetches **text** content into the LLM context (HTML→text, API JSON, etc.)
 *   - downloadFile: writes any byte stream **to disk**, never puts content into the LLM context;
 *     returns only the on-disk path + size + content-type, letting the LLM decide what to do next
 *     (readFile part of it, shell-call pdftotext, or hand it back to the user)
 *
 * Filename/path resolution (highest → lowest priority):
 *   1. Explicit full path given in dest (relative paths are still rejected)
 *   2. HTTP response header Content-Disposition: filename=
 *      (RFC 6266 + RFC 5987-encoded filename*= both supported)
 *   3. Last segment of the URL pathname (arxiv.org/pdf/2601.07372.pdf → 2601.07372.pdf)
 *   4. Fallback: download-<urlhash>.<ext> (ext inferred from content-type)
 *
 * Default download directory:
 *   - Environment variable PHILONT_DOWNLOAD_DIR
 *   - Otherwise ~/.philont/downloads/
 *
 * Name collision: by default appends -1, -2, ... suffixes until unique (avoids silent overwrite data loss);
 * overwrite=true explicitly allows overwriting.
 *
 * Design notes:
 *   - Streaming write: does not buffer the full content in memory; stable even for hundreds of MB
 *   - Size cap: 100MB by default, prevents accidentally pulling large images
 *   - Follows redirects (Node 18+ fetch follows by default)
 *   - Automatically creates parent directory
 *   - Atomic write: first writes to .partial, then renames on success; auto-cleans up on failure
 */

import type { Tool } from '@agent/policy';
import { createWriteStream } from 'node:fs';
import { rename, unlink, mkdir, stat as fsStat } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_TIMEOUT_MS = 120_000;          // 2 min
const MAX_FILENAME_LEN = 200;                // leave ~50 bytes for the -N suffix
const MAX_COLLISION_TRIES = 100;

/** Default download directory: env var takes priority, otherwise ~/.philont/downloads */
function defaultDownloadDir(): string {
  const env = process.env.PHILONT_DOWNLOAD_DIR;
  if (env && isAbsolute(env)) return env;
  return join(homedir(), '.philont', 'downloads');
}

/** content-type → file extension mapping; only common formats listed; returns empty string for unknown */
const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/octet-stream': '.bin',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
};

/**
 * Parse the filename from the Content-Disposition header.
 * Prefers RFC 5987 filename*=UTF-8''xxx (supports non-ASCII), then quoted, then bare value.
 * Returns null on failure.
 */
export function parseContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  // RFC 5987: filename*=charset'lang'percent-encoded-value
  const enc = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (enc) {
    try {
      return decodeURIComponent(enc[2].trim());
    } catch {
      // fall through
    }
  }
  // RFC 6266 quoted form (unchanged)
  const quoted = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1];
  // bare token (unchanged)
  const bare = header.match(/filename\s*=\s*([^;]+)/i);
  if (bare) return bare[1].trim();
  return null;
}

/** Extract the last segment of the URL pathname as the filename. Returns null on failure. */
export function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const last = parts[parts.length - 1];
    if (!last) return null;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return null;
  }
}

/**
 * Filename sanitize:
 *   - Path separators / \ → _ (prevent directory traversal)
 *   - Control characters \x00-\x1F, \x7F → _
 *   - Leading . / whitespace → stripped
 *   - Trailing . / whitespace → stripped (Windows hostility: cannot end with . or space)
 *   - "." / ".." → treated as illegal, returns empty string
 *   - Length capped at 200 (leaving room for -N suffix); extension preserved
 */
export function sanitizeFilename(name: string): string {
  if (!name) return '';
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[\\/\x00-\x1F\x7F]/g, '_');
  out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (out === '' || out === '.' || out === '..') return '';
  if (out.length > MAX_FILENAME_LEN) {
    const ext = extname(out);
    // Extensions longer than 16 chars are basically noise (URL noise / fragment), drop them
    const safeExt = ext.length <= 16 ? ext : '';
    const stem = out.slice(0, MAX_FILENAME_LEN - safeExt.length);
    out = stem + safeExt;
  }
  return out;
}

/** Fallback filename: download-<6-char url-hash>.<ext-from-mime> */
function fallbackFilename(url: string, contentType: string | null): string {
  const mime = (contentType ?? '').toLowerCase().split(';')[0].trim();
  const ext = MIME_EXT[mime] ?? '';
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  const tag = (hash >>> 0).toString(36).slice(0, 6);
  return `download-${tag}${ext}`;
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await fsStat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

/** Append -1, -2, ... on name collision until the path is unique; cap prevents infinite loop */
async function uniquePath(candidate: string): Promise<string> {
  if (!(await pathExists(candidate))) return candidate;
  const ext = extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  for (let i = 1; i <= MAX_COLLISION_TRIES; i++) {
    const next = `${stem}-${i}${ext}`;
    if (!(await pathExists(next))) return next;
  }
  throw new Error(`unable to find unique filename for ${candidate} after ${MAX_COLLISION_TRIES} tries`);
}

/** Determine the final absolute on-disk path (the parent directory may not yet exist when this returns) */
async function deriveTargetPath(
  url: string,
  dest: string | undefined,
  contentDisposition: string | null,
  contentType: string | null,
  overwrite: boolean,
): Promise<string> {
  let parentDir: string;
  let explicitFilename: string | null = null;

  if (dest !== undefined) {
    // Determine directory vs file path: trailing separator or existing directory → treat as directory
    const looksLikeDir =
      dest.endsWith('/') || dest.endsWith(sep) || (await isDir(dest));
    if (looksLikeDir) {
      parentDir = dest;
    } else {
      parentDir = dirname(dest);
      explicitFilename = basename(dest);
    }
  } else {
    parentDir = defaultDownloadDir();
  }

  let filename = explicitFilename ? sanitizeFilename(explicitFilename) : '';
  if (!filename) {
    const fromCD = sanitizeFilename(parseContentDisposition(contentDisposition) ?? '');
    if (fromCD) filename = fromCD;
  }
  if (!filename) {
    const fromURL = sanitizeFilename(filenameFromUrl(url) ?? '');
    if (fromURL) filename = fromURL;
  }
  if (!filename) {
    filename = fallbackFilename(url, contentType);
  }

  const candidate = join(parentDir, filename);
  return overwrite ? candidate : uniquePath(candidate);
}

export const downloadFileTool: Tool = {
  name: 'downloadFile',
  description:
    'Stream the bytes of a URL to local disk without reading the content into context. ' +
    'Use for downloading PDFs / images / archives / any binary or large text file. ' +
    'dest is optional — by default it lands in PHILONT_DOWNLOAD_DIR (default ~/.philont/downloads); ' +
    'the filename comes from the Content-Disposition response header, else the last URL segment, auto-avoiding name collisions. ' +
    'Returns only { path, bytes, contentType }; uses no LLM tokens.',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to download' },
      dest: {
        type: 'string',
        description:
          'Local absolute path. Either a full file path (/tmp/x.pdf) or a directory (/tmp/) — the latter triggers an auto filename. ' +
          'Omit this field → lands in PHILONT_DOWNLOAD_DIR / ~/.philont/downloads. The parent directory is created automatically.',
      },
      maxBytes: {
        type: 'number',
        description: `Maximum bytes to download; exceeding it aborts and deletes the partial file. Default ${DEFAULT_MAX_BYTES}`,
      },
      timeoutMs: {
        type: 'number',
        description: `Overall timeout (milliseconds), default ${DEFAULT_TIMEOUT_MS}`,
      },
      userAgent: {
        type: 'string',
        description: 'Custom User-Agent (default PhilontAgent/1.0)',
      },
      referer: { type: 'string', description: 'Custom Referer header' },
      overwrite: {
        type: 'boolean',
        description: 'Whether to overwrite an existing same-named file. Default false (appends a -1/-2 suffix)',
      },
    },
    required: ['url'],
  },
  capability: 'write',
  domain: 'network',
  async execute(params) {
    const url = params.url as string;
    const dest = params.dest as string | undefined;
    const maxBytes = (params.maxBytes as number) || DEFAULT_MAX_BYTES;
    const timeoutMs = (params.timeoutMs as number) || DEFAULT_TIMEOUT_MS;
    const userAgent =
      (params.userAgent as string) || 'Mozilla/5.0 (compatible; PhilontAgent/1.0)';
    const referer = params.referer as string | undefined;
    const overwrite = Boolean(params.overwrite);

    if (dest !== undefined && !isAbsolute(dest)) {
      return {
        success: false,
        output: '',
        error: `dest must be absolute path, got: ${dest}`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let partial: string | null = null;

    try {
      const headers: Record<string, string> = {
        'User-Agent': userAgent,
        Accept: '*/*',
      };
      if (referer) headers.Referer = referer;

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status} ${response.statusText}`,
        };
      }

      if (!response.body) {
        return { success: false, output: '', error: 'Empty response body' };
      }

      const contentType = response.headers.get('content-type') || 'unknown';
      const contentLength = Number(response.headers.get('content-length')) || 0;
      if (contentLength > maxBytes) {
        return {
          success: false,
          output: '',
          error: `Content-Length ${contentLength} exceeds maxBytes ${maxBytes}`,
        };
      }

      const finalPath = await deriveTargetPath(
        url,
        dest,
        response.headers.get('content-disposition'),
        contentType,
        overwrite,
      );
      partial = `${finalPath}.partial`;

      await mkdir(dirname(finalPath), { recursive: true });

      let written = 0;
      let aborted = false;
      const meter = new Readable({
        read() {},
      });

      const reader = response.body.getReader();
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            written += value.byteLength;
            if (written > maxBytes) {
              aborted = true;
              meter.destroy(
                new Error(`exceeded maxBytes ${maxBytes} (written=${written})`),
              );
              try {
                await reader.cancel();
              } catch {
                // ignore
              }
              return;
            }
            meter.push(value);
          }
          meter.push(null);
        } catch (e) {
          meter.destroy(e as Error);
        }
      })();

      await pipeline(meter, createWriteStream(partial));

      if (aborted) {
        await unlink(partial).catch(() => undefined);
        return {
          success: false,
          output: '',
          error: `Download exceeded maxBytes ${maxBytes}`,
        };
      }

      await rename(partial, finalPath);

      return {
        success: true,
        output: JSON.stringify(
          {
            path: finalPath,
            bytes: written,
            contentType,
          },
          null,
          2,
        ),
      };
    } catch (e) {
      if (partial) {
        await unlink(partial).catch(() => undefined);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        output: '',
        error: `Download failed: ${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
