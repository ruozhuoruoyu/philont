/**
 * pariGp tool — use PARI/GP for number-theory/algebra computation and counterexample search
 * (the "computational verification teeth" of deep_explore).
 *
 * Role: fills the blind spot of z3Verify in number theory. Z3 is SMT (decidable/bounded arithmetic);
 * pari/gp is a number-theory CAS —— large-integer factoring, primality proof (isprime via APR-CL/ECPP,
 * with certificate), elliptic curves, modular forms, L-functions, p-adic, finite fields...
 * Used to **compute concrete values / enumerate to find counterexamples / rigorously decide a single instance**.
 * It is **not** a formal prover of general propositions: a big conjecture cannot be proved this way,
 * but it can compute instances, find counterexamples, and give strong evidence.
 *
 * Security contract (needs more care than z3 — GP has built-in system()/extern()/install() that can run a shell):
 *   - **-D secure=1**: enable secure mode, disabling system/extern/install/file-write. In non-interactive
 *     (stdin) mode it cannot be turned off by a script (turning off secure requires interactive confirmation,
 *     unavailable in batch mode) → sub-LLM cannot escape into the shell via gp.
 *   - **-f**: skip the user ~/.gprc, making behaviour predictable and not weakened by local config.
 *   - **-q**: silent (no banner/prompt), clean output.
 *   - **parisizemax** caps memory to prevent OOM; **process-level SIGKILL timeout** prevents infinite loops
 *     (GP has no simple internal timeout flag).
 *   - Script is passed via **stdin** (not argv: avoids length/escaping/injection); gp exits automatically on EOF.
 *   - gp missing → success=false + clear error (how to install), no throw, no pretending success.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Tool } from '@agent/policy';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60000;
/** Process safety timeout = computation timeout + this slack (allows time to start). */
const PROCESS_TIMEOUT_SLACK_MS = 2000;

/** gp executable candidates; env PHILONT_GP overrides (points to a specific path or directory). */
function gpCandidates(): string[] {
  const env = process.env.PHILONT_GP?.trim();
  if (!env) return ['gp'];
  // If the user set PHILONT_GP to the directory containing gp, auto-append the executable name.
  if (!/[/\\]gp(\.exe)?$/i.test(env)) {
    const exe = process.platform === 'win32' ? 'gp.exe' : 'gp';
    return [env, join(env, exe)];
  }
  return [env];
}

/** PARI stack limit (prevents OOM); env PHILONT_GP_PARISIZEMAX overrides, default 1G. */
const PARISIZEMAX = process.env.PHILONT_GP_PARISIZEMAX?.trim() || '1G';

/** Cache the gp path that is confirmed to work, prefer it on subsequent calls (avoid hitting ENOENT every time). */
let cachedWorkingGp: string | null = null;

interface GpRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string; // ENOENT etc. (executable not found)
  timedOut?: boolean;
}

/** Run a script with one gp candidate; ENOENT is flagged separately so the caller can try the next candidate. */
function runOnce(gp: string, script: string, timeoutMs: number): Promise<GpRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(
      gp,
      ['-q', '-f', '-D', 'secure=1', '-D', `parisizemax=${PARISIZEMAX}`],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const killTimer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }
    }, timeoutMs + PROCESS_TIMEOUT_SLACK_MS);

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: false, stdout, stderr, spawnError: e.code ?? String(e) });
    });
    // If the child exits early (e.g. gp missing), write triggers an async EPIPE 'error' — swallow it; the verdict is determined by close.
    child.stdin.on('error', () => { /* EPIPE: ignore */ });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, timedOut });
    });

    // Script is passed via stdin; gp quits automatically on EOF.
    try {
      child.stdin.write(script.endsWith('\n') ? script : script + '\n');
      child.stdin.end();
    } catch {
      /* stdin write failure is caught by close/error */
    }
  });
}

/**
 * Cheap pre-flight syntax check: reject an obviously-malformed script (unbalanced parens/brackets)
 * BEFORE spawning gp, so a missing `)` doesn't burn an execution iteration (the dominant deep_explore
 * pariGp failure was `for(i=1,nA,` → "unexpected end of file, expecting )"). String literals, C-style
 * block comments and GP backslash line comments are stripped first so their brackets don't miscount.
 * Returns a short error message, or null when balanced. Safe to hard-reject on: a syntactically valid
 * GP script always has balanced ()/[] outside strings/comments.
 */
export function checkGpParenBalance(script: string): string | null {
  const stripped = script
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\\\\[^\n]*/g, ' ') // \\ line comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""'); // string literals
  let round = 0;
  let square = 0;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '(') round++;
    else if (c === ')') {
      round--;
      if (round < 0) return 'a `)` has no matching `(` — check parenthesis balance';
    } else if (c === '[') square++;
    else if (c === ']') {
      square--;
      if (square < 0) return 'a `]` has no matching `[`';
    }
  }
  if (round > 0) return `${round} unclosed "(" — every for / if / sum must be closed; count your parentheses`;
  if (square > 0) return `${square} unclosed "["`;
  return null;
}

export const pariGpTool: Tool = {
  name: 'pariGp',
  description:
    'Use PARI/GP for number-theory/algebra computation and counterexample search: large-integer factoring (factor), primality proof (isprime, with a certificate), ' +
    'elliptic curves (ellinit/ellrank, etc.), modular forms, L-functions, p-adic, continued fractions, finite fields, …\n' +
    'Typical use: compute concrete values to verify/refute a proposition, enumerate a range to find counterexamples, rigorously decide a single instance.\n' +
    'The script is the GP language; **use print(...) to explicitly output your conclusion** (otherwise there may be no output).\n' +
    'Security sandbox: secure mode disables system/extern (cannot run a shell, cannot read/write files).\n' +
    'Note: it is a **compute/refute** tool, not a formal prover of general statements — a big conjecture itself cannot be proved, but it can compute instances, find counterexamples, and give strong evidence.',
  schema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'GP script (PARI/GP language). E.g.: print(factor(2^67-1)) — outputs the factorization of that Mersenne number (proving it composite); ' +
          'print(isprime(2^61-1)) — a primality test. Use print() to explicitly output your conclusion.',
      },
      timeoutMs: {
        type: 'number',
        description: `Computation timeout (milliseconds), default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ['script'],
  },
  capability: 'execute',
  domain: 'local',
  async execute(params) {
    const script = typeof params.script === 'string' ? params.script : '';
    if (!script.trim()) {
      return { success: false, output: '', error: 'Need a non-empty script (GP script)' };
    }
    // Pre-flight: reject unbalanced parens/brackets before spawning gp (saves a failed iteration).
    const syntaxIssue = checkGpParenBalance(script);
    if (syntaxIssue) {
      return { success: false, output: '', error: `PARI/GP pre-check: ${syntaxIssue}. Not executed — fix and resend.` };
    }
    const rawTimeout =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? params.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(rawTimeout)));

    const base = gpCandidates();
    const candidates = cachedWorkingGp
      ? [cachedWorkingGp, ...base.filter((g) => g !== cachedWorkingGp)]
      : base;

    const cantRun: string[] = [];
    for (const gp of candidates) {
      const run = await runOnce(gp, script, timeoutMs);
      if (run.spawnError) {
        cantRun.push(`${gp}(${run.spawnError})`);
        continue; // failed to start → try next candidate
      }
      // At this point gp started at least; remember it.
      cachedWorkingGp = gp;
      if (run.timedOut) {
        return {
          success: false,
          output: run.stdout.trim(),
          error: `PARI/GP computation timed out (>${timeoutMs}ms); process killed. Narrow the range or raise timeoutMs.`,
        };
      }
      const out = run.stdout.trim();
      const err = run.stderr.trim();
      // gp writes errors to stderr, typically like "*** at top-level: ... *** ... error".
      if (/\*\*\*/.test(err) || (!run.ok && err)) {
        return { success: false, output: out, error: `PARI/GP error: ${err.slice(0, 600)}` };
      }
      return { success: true, output: out || '(no output — remember to print(...) your conclusion)' };
    }

    return {
      success: false,
      output: '',
      error:
        `No usable gp (PARI/GP) executable found (tried: ${cantRun.join('; ') || base.join(', ')}). ` +
        `Install PARI/GP (apt install pari-gp / brew install pari), or set PHILONT_GP to the gp path.`,
    };
  },
};
