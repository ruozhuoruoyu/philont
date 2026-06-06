/**
 * Optional capability detection — the base package ships with only the Node core;
 * z3 / Python document tools / playwright are all "on-demand capabilities".
 * This module probes whether they are present so the settings panel can show their
 * status and installation hints (rather than bundling hundreds of MB of Python science
 * stack / browser into the installer).  All probes are best-effort; a failed probe is
 * reported as "not detected".
 */
import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readConfig } from './env-file.js';

interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run a short command and capture its exit code + output. 3 s timeout; never throws. */
function probe(cmd: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let out = '', err = '';
    let done = false;
    const finish = (r: ProbeResult) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      // On Windows, shell:true is required to resolve PATH and run .cmd/.bat wrappers
      // (npx.cmd, playwright.cmd, gp.cmd) — a bare spawn looks for an exact-name .exe and
      // throws ENOENT. But shell:true also re-splits the joined command line on spaces, so
      // both the executable AND any arg containing a space must be quoted to survive as one
      // token (e.g. `-c "import z3"` would otherwise become `-c import z3`). POSIX keeps the
      // direct, no-shell spawn where the args array is already preserved verbatim.
      const useShell = process.platform === 'win32';
      const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
      const c = useShell ? q(cmd) : cmd;
      const a = useShell ? args.map(q) : args;
      child = spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'], shell: useShell });
    } catch (e) {
      return finish({ code: null, stdout: '', stderr: '', error: (e as Error).message });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish({ code: null, stdout: out, stderr: err, error: 'timeout' }); }, 3000);
    timer.unref();
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: null, stdout: out, stderr: err, error: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); finish({ code, stdout: out, stderr: err }); });
  });
}

/**
 * Resolve a PHILONT_* override. The launcher process does NOT load ~/.philont/.env into its
 * own process.env (it only forwards the path to the agent child), so settings the user saved
 * via the web-ui — PHILONT_GP / PHILONT_PLAYWRIGHT / PHILONT_PYTHON — live only in the file.
 * Prefer an OS-level env var, fall back to the .env file value.
 */
function envOverride(key: string, fileCfg: Record<string, string>): string | undefined {
  return process.env[key]?.trim() || fileCfg[key]?.trim() || undefined;
}

const pythonCandidates = (pythonOverride?: string): string[] => {
  return pythonOverride ? [pythonOverride] : ['python3', 'python'];
};

/** Default Playwright browser cache dir (overridable by PLAYWRIGHT_BROWSERS_PATH). */
function playwrightCacheDir(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override) return override;
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}

/**
 * The browser-automation MCP (@playwright/mcp) only needs the Chromium binary in the
 * Playwright browser cache — it bundles its own playwright runtime via npx. So a present
 * `chromium*` folder is the true capability signal, more reliable than probing for a global
 * `playwright` CLI the user may never have installed.
 */
function hasPlaywrightChromium(): boolean {
  try {
    const dir = playwrightCacheDir();
    return existsSync(dir) && readdirSync(dir).some((d) => /^chromium/.test(d));
  } catch {
    return false;
  }
}

export interface Capabilities {
  node: { ok: true; version: string };
  python: { found: boolean; path?: string; version?: string };
  z3: { found: boolean; hint: string };
  pari: { found: boolean; hint: string };
  playwright: { found: boolean; hint: string };
}

export async function detectCapabilities(): Promise<Capabilities> {
  const caps: Capabilities = {
    node: { ok: true, version: process.version },
    python: { found: false },
    z3: { found: false, hint: 'pip install z3-solver (for deep_explore / z3Verify formal verification)' },
    pari: { found: false, hint: 'apt install pari-gp / brew install pari (for deep_explore / pariGp number-theory computation and counterexamples); or set PHILONT_GP=<path-to-gp>' },
    playwright: { found: false, hint: 'npx playwright install chromium (for PHILONT_MCP_BROWSER browser automation); or set PHILONT_PLAYWRIGHT=<path-to-playwright-cli>' },
  };

  // Read ~/.philont/.env once: PHILONT_* overrides set via the web-ui live in this file,
  // which the launcher process never loads into its own process.env.
  const fileCfg = readConfig();
  const pyCandidates = pythonCandidates(envOverride('PHILONT_PYTHON', fileCfg));

  // python: probe candidates in order and use the first one that works
  let pythonBin: string | undefined;
  for (const bin of pyCandidates) {
    const r = await probe(bin, ['--version']);
    if (r.code === 0) {
      pythonBin = bin;
      caps.python = { found: true, path: bin, version: (r.stdout + r.stderr).trim() };
      break;
    }
  }

  // z3: try `import z3` with the discovered python (z3 may be installed under a different python candidate, so try all)
  if (pythonBin) {
    for (const bin of pyCandidates) {
      const r = await probe(bin, ['-c', 'import z3']);
      if (r.code === 0) { caps.z3.found = true; break; }
    }
  }

  // pari/gp: probe `gp --version` (PHILONT_GP overrides the binary path)
  {
    const gpBin = envOverride('PHILONT_GP', fileCfg) || 'gp';
    const r = await probe(gpBin, ['--version']);
    // gp --version may return a non-zero exit code, but the output contains "GP/PARI"; checking output is more reliable
    if (/GP\/PARI|pari/i.test(r.stdout + r.stderr)) caps.pari.found = true;
  }

  // playwright: the installed Chromium binary is the real signal (the MCP runs via npx and
  // uses these browsers). Check the cache dir first, then fall back to a CLI probe
  // (explicit override / global playwright / npx).
  {
    if (hasPlaywrightChromium()) {
      caps.playwright.found = true;
    } else {
      const pwBin = envOverride('PHILONT_PLAYWRIGHT', fileCfg);
      const candidates: Array<[string, string[]]> = pwBin
        ? [[pwBin, ['--version']]]
        : [['playwright', ['--version']], ['npx', ['--no-install', 'playwright', '--version']]];
      for (const [cmd, args] of candidates) {
        const r = await probe(cmd, args);
        if (r.code === 0 && /\d+\.\d+/.test(r.stdout)) { caps.playwright.found = true; break; }
      }
    }
  }

  return caps;
}
