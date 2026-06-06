/**
 * Agent server process supervisor — the core of the launcher.
 *
 * Invariant: the launcher itself runs permanently; the agent server is its child
 * process.  Restart = kill child + respawn; the launcher stays online throughout
 * (still able to serve the config page).  This is the prerequisite for
 * "one-click restart after editing config".
 *
 * Crash handling: any exit that was not triggered by the user is treated as a
 * crash and triggers a backoff auto-respawn.  If the process crashes repeatedly
 * within a short window, auto-respawn is abandoned and the state is set to
 * 'crashed', preventing a crash loop from burning CPU.
 */
import { spawn, type ChildProcess } from 'child_process';
import { resolveAgentStartCommand, serverDir, envFilePath } from './paths.js';
import { readConfig } from './env-file.js';

export type AgentState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

const LOG_CAP = 400;          // Ring buffer: keep the most recent N log lines
const STOP_TIMEOUT_MS = 8000; // Time to wait for graceful exit after SIGTERM before escalating to SIGKILL
const CRASH_WINDOW_MS = 60_000;
const CRASH_MAX = 3;          // >= 3 crashes within 60 s → give up auto-respawn
const RESTART_DELAY_MS = 1500;

export class AgentSupervisor {
  private child?: ChildProcess;
  private state: AgentState = 'stopped';
  private startedAt = 0;
  private port = 20266;
  private mode: 'dev' | 'prod' = 'dev';
  private logs: string[] = [];
  /** Whether to also echo logs to the launcher's own terminal (the shell that started the service). Set PHILONT_LAUNCHER_QUIET=1 to disable. */
  private readonly echoToTerminal = process.env.PHILONT_LAUNCHER_QUIET !== '1';
  private userStopped = false;
  private crashCount = 0;
  private crashWindowStart = 0;
  private lastError = '';

  /**
   * Kill the entire process group (including the real node child process forked by tsx).
   * POSIX: after a detached spawn the child is the group leader; kill(-pid) targets the whole
   * group; falls back to killing the single process on failure.
   * Windows: no POSIX process groups; use taskkill /T to kill the process tree.
   */
  private killTree(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F']); } catch { /* ignore */ }
      return;
    }
    try {
      process.kill(-pid, signal); // negative pid = entire process group
    } catch {
      try { process.kill(pid, signal); } catch { /* already exited */ }
    }
  }

  private log(line: string, isErr = false): void {
    const text = line.replace(/\s+$/, '');
    if (!text) return;
    this.logs.push(text);
    if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
    // Echo to terminal: the agent child's stdout/stderr, received via pipe, is also visible in the shell that started the service.
    if (this.echoToTerminal) (isErr ? process.stderr : process.stdout).write(text + '\n');
  }

  /** Current agent listen port: PHILONT_PORT from config, falling back to 20266. */
  private resolvePort(): number {
    const p = Number(readConfig().PHILONT_PORT);
    return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 20266;
  }

  getStatus() {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      port: this.port,
      mode: this.mode,
      startedAt: this.startedAt || null,
      uptimeMs: this.state === 'running' && this.startedAt ? Date.now() - this.startedAt : 0,
      lastError: this.lastError || null,
      recentLogs: this.logs.slice(-60),
    };
  }

  getLogs(limit = LOG_CAP): string[] {
    return this.logs.slice(-Math.max(1, Math.min(LOG_CAP, limit)));
  }

  /** Start the agent child process. No-op if already running. */
  start(): { ok: boolean; reason?: string } {
    if (this.state === 'running' || this.state === 'starting') {
      return { ok: true, reason: 'already running' };
    }
    this.userStopped = false;
    this.state = 'starting';
    this.lastError = '';
    this.port = this.resolvePort();

    const { cmd, args, mode } = resolveAgentStartCommand();
    this.mode = mode;
    this.log(`[launcher] starting agent (${mode}): ${cmd} ${args.join(' ')} :${this.port}`);

    const child = spawn(cmd, args, {
      cwd: serverDir, // module resolution depends on this; .env path is provided separately via PHILONT_ENV_FILE
      env: {
        ...process.env,
        PHILONT_ENV_FILE: envFilePath, // tells the agent's load-env to read ~/.philont/.env
        PHILONT_PORT: String(this.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Key: in dev mode, cmd is the tsx wrapper, which forks a real node child process.
      // Without an independent process group, SIGTERM only reaches the tsx wrapper and the
      // real server becomes an orphan (cannot be killed by stop/restart).
      // detached:true makes the child the process group leader (pgid=child.pid), so the
      // whole group is killed on stop.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    this.startedAt = Date.now();

    child.stdout?.on('data', (b: Buffer) => {
      for (const l of b.toString('utf8').split('\n')) this.log(l);
    });
    child.stderr?.on('data', (b: Buffer) => {
      for (const l of b.toString('utf8').split('\n')) this.log(l, true);
    });

    child.on('spawn', () => {
      // spawn success ≠ service ready, but sufficient to advance state to 'running' (readiness confirmed when the front-end WS connects)
      this.state = 'running';
      this.log(`[launcher] agent pid=${child.pid} started`);
    });

    child.on('error', (err) => {
      this.lastError = String(err?.message ?? err);
      this.log(`[launcher] agent spawn error: ${this.lastError}`);
      this.state = 'crashed';
    });

    child.on('exit', (code, signal) => {
      this.child = undefined;
      const desc = signal ? `signal ${signal}` : `code ${code}`;
      this.log(`[launcher] agent exited (${desc})`);
      if (this.userStopped) {
        this.state = 'stopped';
        return;
      }
      // Non-user exit = crash. Back off and respawn; give up if it crashes repeatedly within a short window.
      this.lastError = `agent abnormal exit (${desc})`;
      const now = Date.now();
      if (now - this.crashWindowStart > CRASH_WINDOW_MS) {
        this.crashWindowStart = now;
        this.crashCount = 0;
      }
      this.crashCount++;
      if (this.crashCount >= CRASH_MAX) {
        this.state = 'crashed';
        this.log(`[launcher] crashed ${this.crashCount} times within ${CRASH_WINDOW_MS / 1000}s — giving up on auto-respawn`);
        return;
      }
      this.state = 'starting';
      this.log(`[launcher] auto-respawn in ${RESTART_DELAY_MS}ms (attempt ${this.crashCount})`);
      setTimeout(() => {
        if (!this.userStopped) this.start();
      }, RESTART_DELAY_MS).unref();
    });

    return { ok: true };
  }

  /** Graceful stop: SIGTERM → wait → SIGKILL on timeout. */
  async stop(): Promise<{ ok: boolean }> {
    // Set userStopped first: even if there is no live child right now (e.g. inside a
    // back-off respawn delay), this cancels the pending auto-respawn setTimeout (which
    // checks userStopped).  Without this, the agent would resurrect itself after "stop".
    this.userStopped = true;
    const child = this.child;
    if (!child || this.state === 'stopped') {
      this.state = 'stopped';
      return { ok: true };
    }
    this.state = 'stopping';
    this.log('[launcher] stopping agent (SIGTERM)…');

    const pid = child.pid;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
        this.state = 'stopped';
        resolve({ ok: true });
      };
      // Grace period after SIGTERM; escalate to SIGKILL on timeout
      const killTimer = setTimeout(() => {
        this.log('[launcher] graceful exit timed out — SIGKILL whole group');
        if (pid) this.killTree(pid, 'SIGKILL');
      }, STOP_TIMEOUT_MS);
      killTimer.unref();
      // Safety net: even if 'exit' is never received after SIGKILL (zombie / pid reuse, etc.)
      // we must resolve the promise, otherwise restart() / shutdown() awaiting stop() hang forever.
      const hardTimer = setTimeout(() => {
        this.log('[launcher] no exit event after SIGKILL — force-closing stop()');
        done();
      }, STOP_TIMEOUT_MS + 4000);
      hardTimer.unref();

      child.once('exit', done);

      if (pid) {
        this.killTree(pid, 'SIGTERM'); // kill the whole group (including the tsx-forked real server)
      } else {
        done();
      }
    });
  }

  /** Restart: stop → start. Call after config changes. */
  async restart(): Promise<{ ok: boolean }> {
    this.log('[launcher] restarting agent…');
    this.crashCount = 0; // user-initiated restart; reset crash count
    await this.stop();
    return this.start();
  }
}
