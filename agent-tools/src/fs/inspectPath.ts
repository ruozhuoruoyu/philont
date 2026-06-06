/**
 * inspectPath — read-only path inspection tool (added 2026-05-06, used by K7→K8 bridge).
 *
 * Design scenario: when K7 HonestyGate catches a fabricated_size_claim ("file is 577KB" but actually 18 bytes),
 * the K8 bridge dispatches the autonomous loop executor to call this tool to verify the real size.
 * The executor tool whitelist is strictly read-only; this tool fills the need for a "lightweight sanity-check
 * of file size + first few hundred bytes of content" without the injection risk of opening a shell subset whitelist.
 *
 * Behavior:
 *   - stat() to get size / mtime / file type (file / directory / other)
 *   - if the file is non-empty → read first 200 bytes, heuristically detect text/binary;
 *     return a utf-8 preview for text, or hex (first 64 bytes) for binary
 *   - does not exist → success=true + exists=false (not an error; LLM gets the conclusion directly)
 *   - real errors (permission denied, etc.) → success=false
 *
 * Output is a fixed JSON string (easy for LLM to parse, no need to call a second tool).
 */

import { stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

const PREVIEW_BYTES = 200;
const HEX_PREVIEW_BYTES = 64;

export const inspectPathTool: Tool = {
  name: 'inspectPath',
  description:
    'Read-only path inspection: returns the file size, mtime, and type; for a non-empty file also returns ' +
    'a preview of the first 200 bytes (text/binary auto-detected). Made for sanity-checking "claimed size vs actual". Zero side effects.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The absolute path to inspect. If it does not exist, returns exists=false instead of erroring.',
      },
    },
    required: ['path'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const path = params.path as string;
    if (!path || typeof path !== 'string') {
      return {
        success: false,
        output: '',
        error: 'inspectPath: path is required',
      };
    }

    try {
      const st = await stat(path);
      const result: Record<string, unknown> = {
        path,
        exists: true,
        type: st.isDirectory()
          ? 'directory'
          : st.isFile()
            ? 'file'
            : st.isSymbolicLink()
              ? 'symlink'
              : 'other',
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
      };

      if (st.isFile() && st.size > 0) {
        const fd = await open(path, 'r');
        try {
          const buf = Buffer.alloc(Math.min(PREVIEW_BYTES, st.size));
          const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
          const sample = buf.subarray(0, bytesRead);
          if (bytesRead > 0) {
            result.previewBytes = bytesRead;
            if (looksTextual(sample)) {
              result.previewKind = 'text';
              result.preview = sample.toString('utf-8');
            } else {
              result.previewKind = 'binary';
              result.previewHex = sample
                .subarray(0, Math.min(HEX_PREVIEW_BYTES, bytesRead))
                .toString('hex');
            }
          }
        } finally {
          await fd.close();
        }
      }

      return { success: true, output: JSON.stringify(result, null, 2) };
    } catch (e) {
      const msg = String(e);
      if (msg.includes('ENOENT')) {
        return {
          success: true,
          output: JSON.stringify({ path, exists: false }, null, 2),
        };
      }
      return {
        success: false,
        output: '',
        error: `inspectPath failed: ${msg}`,
      };
    }
  },
};

/**
 * Heuristically determine whether a buffer is text: allow \t \n \r + printable ASCII + high ASCII (UTF-8 multi-byte).
 *
 * False-positive rate of this simplified check:
 *   - Occasional "binary that looks like text" (e.g. UTF-16 BOM) will be treated as text — OK, the LLM
 *     can still detect the strange characters
 *   - Real binaries (PDF / docx / png) typically have \0 / control characters in the first 200 bytes → hit the binary path
 */
function looksTextual(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13) continue; // \t \n \r
    if (b >= 32 && b < 127) continue; // printable ASCII
    if (b >= 0x80) continue; // utf-8 multi-byte
    return false; // \0 / control characters
  }
  return true;
}
