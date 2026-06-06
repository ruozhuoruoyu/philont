/**
 * shell tool — execute shell commands on the host where the philont process runs.
 *
 * Failure signals must be clear: the tool_result seen by the LLM must not be a vague "Error: <something>",
 * otherwise it may misread "no output" as "success". Contract of this tool:
 *
 *   - Non-zero exit code / exception thrown / timeout → success=false, error field contains exitCode,
 *     signal, stderr, durationMs; the LLM can see at a glance that it failed.
 *   - Command does not exist / not found on PATH → explicitly labelled "command not found" (via stderr or exception).
 *   - Empty stderr → explicitly write "(no stderr output)" rather than an empty string, to avoid narrative collapse.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import type { Tool } from '@agent/policy';
import {
  detectReplacementChar,
  prefixCommandWithUtf8,
} from '../utils/encoding.js';
import { hostShellGuidanceLines, POSIX_PREFERRED_SHELL } from '../utils/host.js';

const execAsync = promisify(exec);

/**
 * Suspicious download file size threshold. Below this value it is very likely an API error response
 * (JSON error bodies are usually 50-300 bytes; 4xx status code bodies are often under 200 bytes)
 * rather than real binary content (PDF/docx/png are all > 1KB).
 *
 * 256 bytes is an empirical threshold: real binaries are almost never this small;
 * JSON error bodies are almost always smaller. A small threshold gives high alert precision
 * (almost no false positives).
 */
const SUSPICIOUS_DOWNLOAD_BYTES = 256;

/**
 * Extract `-o <path>` / `--output <path>` / `-O <path>` output paths from a curl/wget command string.
 *
 * Design trade-offs:
 *   - Use regex rather than a proper shell parser: the quoting/escaping combinations in commands
 *     are too varied to parse 100% correctly without a real parser. We only check on "obvious matches"
 *     and let others through — it is better to miss a false positive than to falsely warn on a true positive.
 *   - Supports three quoting styles: "path with spaces", 'path', and unquoted path.
 *
 * Deliberately not matched: shell redirections `> file`, tee, complex escaped paths. In those
 * cases the LLM should stat-verify itself; the tool does not pretend to parse arbitrary shell.
 */
export function extractDownloadOutputPaths(command: string): string[] {
  const paths: string[] = [];
  // (?<=^|\s) anchors the start to avoid accidentally matching e.g. `--no-output` (defensive)
  const re = /(?:^|\s)(?:-o|--output|-O)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  for (const m of command.matchAll(re)) {
    const p = m[1] ?? m[2] ?? m[3];
    if (p && !p.startsWith('-')) paths.push(p);
  }
  return paths;
}

/**
 * Check -o output files; if size < threshold, return a warning string (one line per suspicious file);
 * return empty if nothing is suspicious.
 *
 * On ENOENT / any stat error, silently skip: the command did not actually create the file (maybe
 * curl failed but -sS swallowed it, or we parsed the path wrong) — that is outside the diagnostic
 * surface we can rescue; let the LLM verify it later.
 */
async function checkDownloadOutputs(command: string): Promise<string> {
  const paths = extractDownloadOutputPaths(command);
  if (paths.length === 0) return '';
  const warnings: string[] = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (s.isFile() && s.size < SUSPICIOUS_DOWNLOAD_BYTES) {
        warnings.push(
          `⚠ Output file '${p}' is only ${s.size} bytes — likely an API error response (a JSON error body) rather than real downloaded content. ` +
          `Check it with \`head -c 200 "${p}"\`. Real binaries (PDF/docx/png/zip) are usually > 1KB.`,
        );
      }
    } catch {
      // File not found / stat failed → silent skip; the LLM can already judge from the main output
    }
  }
  return warnings.length > 0 ? '\n--- download sanity ---\n' + warnings.join('\n') : '';
}

/**
 * Default timeout 300s (5 min).
 * Evolution: 30s (original) → 120s (curl/npm install) → 300s: office-workflow
 * multi-step shells were hitting the in-turn-reflection tool lock at the 120s
 * boundary; 5 min gives room for "seems long but actually normal" commands.
 *
 * Not extended further across the board: beyond 5 min is ML heavy load (pytorch / whisper / model downloads),
 * which the LLM should **explicitly** pass a larger timeout for (reference table in description),
 * so the mechanism layer does not decide on its behalf.
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Format a child_process.exec failure exception as structured text so the LLM immediately knows it failed. */
function formatFailure(error: any, durationMs: number, requestedTimeout: number): string {
  const exitCode = typeof error?.code === 'number' ? error.code : null;
  const signal = error?.signal ?? null;
  const killed = error?.killed === true;
  const stderr = (error?.stderr ?? '').toString().trim();
  const stdoutLeftover = (error?.stdout ?? '').toString().trim();

  const meta: string[] = [];
  if (exitCode !== null) meta.push(`exitCode=${exitCode}`);
  if (signal) meta.push(`signal=${signal}`);
  if (killed) meta.push('killed=true (likely timeout)');
  meta.push(`durationMs=${durationMs}`);

  const cause = stderr
    ? `stderr: ${stderr}`
    : exitCode === null && !signal
      ? `exception: ${error?.message ?? String(error)}`
      : '(no stderr output)';

  const tail = stdoutLeftover ? `\nstdout(partial): ${stdoutLeftover.slice(0, 800)}` : '';
  // Timed out (killed=true and duration close to the limit) → append action hint: **retry with an explicitly larger timeout**.
  // Do not let the LLM guess from a silent error: in practice LLMs have misread "killed at default timeout"
  // as "network hiccup" and retried repeatedly with the same timeout, wasting many turns.
  const timedOut = killed && durationMs >= requestedTimeout * 0.9;
  const hint = timedOut
    ? `\nhint: the command did not finish within ${requestedTimeout}ms. Retry with an explicitly larger timeout sized to the task:` +
      `\n  - ML library installs (pytorch / transformers / openai-whisper): timeout: 1200000 (20 min)` +
      `\n  - HuggingFace / ModelScope model-weight downloads:               timeout: 1800000 (30 min)` +
      `\n  - yt-dlp video / docker build / multi-GB transfers:              timeout: 900000 (15 min)` +
      `\n  - regular pip / npm install / single-page PDF parse (already >5min): timeout: 600000 (10 min)` +
      `\n  note: never retry with the original timeout — you will hit the same wall again.`
    : '';
  return `[${meta.join(', ')}] ${cause}${tail}${hint}`;
}

export const shellTool: Tool = {
  name: 'shell',
  description: [
    'Execute a shell command on the host where the philont process runs.',
    'Execution-environment constraints (the LLM must be aware):',
    '  - cwd defaults to the philont process start directory, not the user terminal\'s current directory; use absolute paths or an explicit "cd ... && cmd" when needed.',
    '  - PATH is inherited from the launching shell; executables like winget/pandoc must already be on PATH.',
    ...hostShellGuidanceLines(),
    '  - Admin/sudo operations are not auto-elevated; exitCode≠0 is a failure and comes back with exitCode and stderr.',
    '  - Default timeout=300000ms (5 minutes); on timeout it returns killed=true.',
    '  - **For long tasks, pass an explicit timeout** (ms) sized to the work:',
    '      ML library installs (pytorch/transformers/openai-whisper): 1200000 (20 min)',
    '      HuggingFace/ModelScope model-weight downloads:            1800000 (30 min)',
    '      yt-dlp video / docker build / multi-GB transfers:          900000 (15 min)',
    '      regular pip/npm install / large PDF parsing:               600000 (10 min)',
    '      short tasks (ls / stat / cat, etc.):                       you may pass 30000 to avoid hangs',
    '  - After a timeout, **never retry with the same value** — the hint in the error gives the reference thresholds; pick a larger one.',
    'Call contract: returns { success, output, error }; when success=false, output is stdout (possibly empty) and error contains exitCode/signal/stderr/durationMs.',
    'Do not claim the command succeeded when success=false — the LLM must read the success field, not guess.',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 300000 = 5 minutes). For long tasks pass an explicit value: ML installs 1200000; model downloads 1800000; video/large files 900000; general tasks 600000' },
    },
    required: ['command'],
  },
  capability: 'execute',
  domain: 'local',
  async execute(params) {
    const command = params.command as string;
    const timeout = (params.timeout as number) || DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    // Windows Chinese cmd defaults to GBK; exec-ing directly causes stdout to become
    // ������ garbage after UTF-8 decoding, polluting the context. Inject chcp 65001 before
    // the command to switch to UTF-8 codepage. On other platforms wrappedCommand === command.
    const wrappedCommand = prefixCommandWithUtf8(command);

    try {
      // shell: prefer /bin/bash on POSIX (avoids Linux dash misinterpreting LLM bash syntax);
      // undefined → Node default (POSIX /bin/sh or Windows cmd.exe). See host.ts.
      const { stdout, stderr } = await execAsync(wrappedCommand, { timeout, shell: POSIX_PREFERRED_SHELL });
      const durationMs = Date.now() - startedAt;
      // Success path: exit 0. Prefer stdout; append stderr as supplementary info (many tools
      // send progress on stderr). Completely empty output is also explicitly labelled,
      // rather than returning an empty string and letting the LLM guess.
      const out = stdout?.toString() ?? '';
      const err = stderr?.toString() ?? '';
      const trimmedOut = out.trim();
      const trimmedErr = err.trim();
      let body =
        trimmedOut && trimmedErr
          ? `${out}\n--- stderr ---\n${err}`
          : trimmedOut
            ? out
            : trimmedErr
              ? `(stdout empty)\n--- stderr ---\n${err}`
              : `(no output, exit=0, durationMs=${durationMs})`;
      // U+FFFD still appearing = codepage switch failed / output contains real binary.
      // Give the LLM an explicit signal so it does not treat the garbled text as valid output.
      if (detectReplacementChar(body)) {
        body += '\n--- note ---\nU+FFFD detected in output — likely codepage mismatch or binary stdout.';
      }
      // Download integrity check: if the command contains -o/--output <path> and the file is < 256 bytes,
      // it is very likely an API error response being mistaken for real downloaded content
      // (seen 5 times in practice: curl producing 18-byte docx without the LLM noticing).
      // Parse using command (original, not wrappedCommand): wrapped may have a chcp prefix,
      // but the -o argument is unchanged; using original reduces false-match probability.
      const downloadWarnings = await checkDownloadOutputs(command);
      if (downloadWarnings) body += downloadWarnings;
      return {
        success: true,
        output: body,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startedAt;
      return {
        success: false,
        output: (error?.stdout ?? '').toString(),
        error: formatFailure(error, durationMs, timeout),
      };
    }
  },
};
