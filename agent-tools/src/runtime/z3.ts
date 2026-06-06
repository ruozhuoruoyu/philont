/**
 * z3Verify tool — use Z3 (SMT solver) to verify the satisfiability of logical/arithmetic constraints, or find counterexamples.
 *
 * Design contract (security + clarity for LLM):
 *   - **Fixed harness, only solves the passed-in SMT-LIB** (`Solver.from_string`) — never evals arbitrary Python.
 *     The LLM can only provide SMT-LIB v2 text (Z3 treats it as logic, no shell/file/network capability) → secure.
 *   - SMT-LIB is passed via **stdin** (not argv: avoids length limits / escaping / injection). timeout is passed via argv (pure number).
 *   - Returns a structured verdict: result = unsat / sat / unknown; sat includes model (counterexample).
 *   - python / z3 missing → success=false + clear error ("pip install z3-solver"), no throw, no pretending success.
 *
 * Usage (for reasoning):
 *   - Prove ∀x.P(x): encode ∃x.¬P(x) as constraints → unsat means the original proposition holds; sat gives a counterexample in the model.
 *   - Find a counterexample: encode the proposition as constraints directly; sat gives the counterexample.
 *   - Only applies to **decidable / bounded / arithmetic** fragments; a big number-theory conjecture (e.g. a conjecture itself) cannot be proved by Z3 (returns unknown or times out).
 */

import { spawn } from 'node:child_process';
import type { Tool } from '@agent/policy';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60000;
/** Process safety timeout = z3 internal timeout + this slack (allows time for startup + parsing). */
const PROCESS_TIMEOUT_SLACK_MS = 5000;

/** Usually `python` on Windows, `python3` on Linux/macOS; env override allowed. Candidates are tried in order. */
function pythonCandidates(): string[] {
  const env = process.env.PHILONT_PYTHON?.trim();
  return env ? [env] : ['python3', 'python'];
}

/**
 * Cache the python that is confirmed to have the z3 module; prefer it on the next call —
 * avoids hitting a python3 without z3 (common Windows Store stub) every time.
 * Key Windows fix: a candidate that "runs but has no z3" must NOT be taken as proof that
 * "z3 is not installed" — must continue to try the next candidate (z3 may be in `python` not `python3`).
 */
let cachedWorkingPython: string | null = null;

/**
 * Fixed Python harness: reads argv[1]=timeoutMs and stdin=SMT-LIB, outputs one line of JSON.
 * **Only from_string, no eval** — SMT-LIB is logic, cannot execute arbitrary code.
 */
const HARNESS = [
  'import sys, json',
  // Drain stdin first, then import z3 — otherwise if z3 is missing, sys.exit closes the pipe
  // before the parent process writes stdin → parent gets EPIPE. Reading first ensures the pipe is always drained.
  'smt = sys.stdin.read()',
  'try:',
  '    import z3',
  'except Exception as e:',
  '    sys.stdout.write(json.dumps({"error":"z3-not-installed","detail":str(e)})); sys.exit(0)',
  'try:',
  '    ms = int(sys.argv[1]) if len(sys.argv) > 1 else 5000',
  '    s = z3.Solver()',
  '    s.set("timeout", ms)',
  '    s.from_string(smt)',
  '    r = s.check()',
  '    out = {"result": str(r)}',
  '    if r == z3.sat:',
  '        out["model"] = str(s.model())',
  '    sys.stdout.write(json.dumps(out))',
  'except Exception as e:',
  '    sys.stdout.write(json.dumps({"error":"smt-error","detail":str(e)}))',
].join('\n');

interface Z3Run {
  ok: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string; // ENOENT etc. (executable not found)
}

/** Run the harness with one python candidate; ENOENT is flagged separately so the caller can try the next candidate. */
function runOnce(python: string, smtlib: string, timeoutMs: number): Promise<Z3Run> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(python, ['-c', HARNESS, String(timeoutMs)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const killTimer = setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }
    }, timeoutMs + PROCESS_TIMEOUT_SLACK_MS);

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: false, stdout, stderr, spawnError: e.code ?? String(e) });
    });
    // If the child exits before we write to stdin (e.g. z3 missing exits early), write triggers an
    // async EPIPE 'error' event — left unhandled it would crash the process. Swallow it; the verdict
    // is determined by stdout/close.
    child.stdin.on('error', () => { /* EPIPE / broken pipe: ignore */ });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: code === 0, stdout, stderr });
    });

    // SMT-LIB via stdin (not argv)
    try {
      child.stdin.write(smtlib);
      child.stdin.end();
    } catch {
      /* stdin write failure is caught by close/error */
    }
  });
}

export const z3VerifyTool: Tool = {
  name: 'z3Verify',
  description:
    'Use Z3 (an SMT solver) to decide the satisfiability of a set of SMT-LIB v2 constraints / find a counterexample. ' +
    'Returns result=unsat (unsatisfiable) / sat (satisfiable, with a model as a concrete assignment/counterexample) / unknown.\n' +
    'To prove ∀x.P(x): encode ∃x.¬P(x) as constraints → unsat means the proposition holds; sat means the model is a counterexample.\n' +
    'To find a counterexample: write the proposition as constraints, sat means a counterexample.\n' +
    'Only applies to decidable/bounded/arithmetic fragments (linear / some nonlinear int & real, bit-vectors, boolean); a big number-theory conjecture itself cannot be proved this way (unknown/timeout).\n' +
    'Input is SMT-LIB text only; it does not execute arbitrary code.',
  schema: {
    type: 'object',
    properties: {
      smtlib: {
        type: 'string',
        description:
          'SMT-LIB v2 constraint text. E.g.: (declare-const x Int)(assert (> x 0))(assert (< x 0)) — check yields unsat. ' +
          'You do not need to write (check-sat); the tool checks automatically.',
      },
      timeoutMs: {
        type: 'number',
        description: `Z3 solve timeout (milliseconds), default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ['smtlib'],
  },
  capability: 'execute',
  domain: 'local',
  async execute(params) {
    const smtlib = typeof params.smtlib === 'string' ? params.smtlib : '';
    if (!smtlib.trim()) {
      return { success: false, output: '', error: 'Need a non-empty smtlib (SMT-LIB v2 constraint text)' };
    }
    const rawTimeout =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? params.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(rawTimeout)));

    // Candidate order: known-working z3 python first; fill in the rest in default order (deduped).
    const base = pythonCandidates();
    const candidates = cachedWorkingPython
      ? [cachedWorkingPython, ...base.filter((p) => p !== cachedWorkingPython)]
      : base;

    const noZ3: string[] = []; // runs but has no z3 module
    const cantRun: string[] = []; // failed to start (ENOENT etc.)

    for (const python of candidates) {
      const run = await runOnce(python, smtlib, timeoutMs);
      if (run.spawnError) {
        cantRun.push(`${python}(${run.spawnError})`);
        continue; // failed to start → try next candidate
      }
      const text = run.stdout.trim();
      let parsed: { result?: string; model?: string; error?: string; detail?: string } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        // This python ran but output is not our JSON (may be a different interpreter/stub) → try next
        cantRun.push(`${python}(abnormal output: ${text.slice(0, 80)})`);
        continue;
      }
      if (parsed.error === 'z3-not-installed') {
        // **Key fix**: this python has no z3 — do NOT conclude "z3 is not installed"; continue to the next candidate.
        noZ3.push(python);
        continue;
      }
      // At this point: python + z3 are both OK. Cache it for future use.
      cachedWorkingPython = python;
      if (parsed.error) {
        // A real SMT parse/solve error (python+z3 are fine; the smtlib is wrong) → return immediately
        return { success: false, output: '', error: `SMT parse/solve error: ${parsed.detail ?? parsed.error}` };
      }
      const result = parsed.result ?? 'unknown';
      const verdict =
        result === 'unsat'
          ? 'unsat (unsatisfiable — if you encoded the negation of the proposition, then the original proposition holds)'
          : result === 'sat'
            ? 'sat (satisfiable — the model is a concrete assignment/counterexample)'
            : 'unknown (Z3 could not decide, or timed out)';
      const body = `result: ${result}\n${verdict}${parsed.model ? `\nmodel:\n${parsed.model}` : ''}`;
      return { success: true, output: body };
    }

    // All candidates failed: distinguish "has python but none have z3" vs "cannot start python at all"
    if (noZ3.length > 0) {
      return {
        success: false,
        output: '',
        error:
          `Z3 not installed: none of the python interpreters tried (${noZ3.join(', ')}) have the z3 module. ` +
          `pip install z3-solver into **one of those pythons**, or set PHILONT_PYTHON to an interpreter that has z3.`,
      };
    }
    return {
      success: false,
      output: '',
      error: `No usable python found (tried: ${cantRun.join('; ') || pythonCandidates().join(', ')}). Set PHILONT_PYTHON to a specific path.`,
    };
  },
};
