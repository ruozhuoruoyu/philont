/**
 * WeChat scan-login session manager.
 *
 * Runs the server's `wechat cli login --json` as a child process and translates its
 * JSONL event stream into a single in-memory session the web-ui can poll. This keeps
 * the tested login state machine (login.ts) and its credential-writing in one place;
 * the launcher only supervises the child and exposes its phase.
 *
 * Single-session by design (desktop, one user): a second start() while one is active
 * just returns the current state. The child caps itself at ~480s (QR_TOTAL_TIMEOUT_MS),
 * so a stuck session cannot leak forever.
 */
import { spawn, type ChildProcess } from 'child_process';
import { resolveWeChatLoginCommand, serverDir, envFilePath } from './paths.js';
import { readConfig } from './env-file.js';

export type LoginPhase =
  | 'idle'       // nothing running
  | 'starting'   // child spawned, no QR yet
  | 'waiting'    // QR shown, awaiting scan
  | 'scanned'    // scanned on phone, awaiting confirm
  | 'confirmed'  // logged in, credentials written
  | 'expired'    // QR expired (a fresh one follows, or gave up)
  | 'error';     // login failed / child died

export interface LoginState {
  phase: LoginPhase;
  qrcodeUrl?: string;
  qrcodeDataUri?: string; // server-fetched QR image inlined (browser need not reach the CDN)
  attempt?: number;
  accountId?: string;
  baseUrl?: string;
  error?: string;
  startedAt?: number;
}

// Config keys worth forwarding to the login CLI (which reads them from process.env).
const FORWARD_ENV = ['WECHAT_BASE_URL', 'WECHAT_ACCOUNT_ID', 'PHILONT_WECHAT_ROOT'] as const;

export class WeChatLoginSession {
  private child?: ChildProcess;
  private state: LoginState = { phase: 'idle' };
  private buf = '';

  getState(): LoginState {
    return this.state;
  }

  /** Start (or return the in-flight) login. Idempotent while a child is alive. */
  start(): LoginState {
    if (this.child && this.isActive()) return this.state;

    const { cmd, args } = resolveWeChatLoginCommand();
    const cfg = readConfig();
    const env: NodeJS.ProcessEnv = { ...process.env, PHILONT_ENV_FILE: envFilePath };
    for (const k of FORWARD_ENV) {
      if (cfg[k]) env[k] = cfg[k];
    }

    this.buf = '';
    this.state = { phase: 'starting', startedAt: Date.now() };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: serverDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      this.state = { phase: 'error', error: `spawn failed: ${String(e)}` };
      return this.state;
    }
    this.child = child;

    child.stdout?.on('data', (b: Buffer) => this.ingest(b.toString('utf8')));
    child.stderr?.on('data', () => { /* human banner is suppressed in --json; ignore noise */ });

    child.on('error', (err) => {
      this.state = { ...this.state, phase: 'error', error: String(err?.message ?? err) };
    });

    child.on('exit', (code) => {
      this.child = undefined;
      // A clean confirm already set phase=confirmed; a reported error set phase=error.
      // Any other exit (non-zero, or zero without a confirmed event) is a failure.
      if (this.state.phase !== 'confirmed' && this.state.phase !== 'error') {
        this.state = { ...this.state, phase: 'error', error: `login exited (code ${code ?? 'null'})` };
      }
    });

    return this.state;
  }

  /** Cancel an in-flight login (kills the child); no-op if none. */
  cancel(): LoginState {
    const child = this.child;
    if (child?.pid && this.isActive()) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
    this.child = undefined;
    this.state = { phase: 'idle' };
    return this.state;
  }

  private isActive(): boolean {
    return this.state.phase === 'starting' || this.state.phase === 'waiting' || this.state.phase === 'scanned';
  }

  /** Parse newline-delimited JSON events from the child's stdout. */
  private ingest(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(line); } catch { continue; } // ignore non-JSON noise
      this.apply(evt);
    }
  }

  private apply(evt: Record<string, unknown>): void {
    // Once confirmed/error, ignore stragglers (e.g. a late inlined-QR fetch resolving
    // after login confirmed would otherwise flip the phase back to 'waiting').
    if (this.state.phase === 'confirmed' || this.state.phase === 'error') return;
    switch (evt.type) {
      case 'qr': {
        // A 'qr' event carries either a fresh url (→ adopt attempt, clear any stale inlined
        // image) or the inlined dataUri for one attempt; they arrive as two separate events.
        const next: LoginState = { ...this.state, phase: 'waiting', error: undefined };
        if (typeof evt.url === 'string') {
          next.qrcodeUrl = evt.url;
          next.qrcodeDataUri = undefined;
          if (typeof evt.attempt === 'number') next.attempt = evt.attempt;
        }
        if (typeof evt.dataUri === 'string') {
          // Accept the inlined image only if it belongs to the QR currently shown — a slow
          // fetch for a previous attempt must not overwrite the refreshed QR.
          if (evt.attempt == null || evt.attempt === next.attempt) next.qrcodeDataUri = evt.dataUri;
        }
        this.state = next;
        break;
      }
      case 'status': {
        const phase = evt.phase;
        if (phase === 'scanned') this.state = { ...this.state, phase: 'scanned' };
        else if (phase === 'waiting') this.state = { ...this.state, phase: 'waiting' };
        else if (phase === 'expired') this.state = { ...this.state, phase: 'expired' };
        // 'redirect' / 'confirmed' are transient here; a 'qr' or 'confirmed' event follows.
        break;
      }
      case 'confirmed':
        this.state = {
          ...this.state,
          phase: 'confirmed',
          accountId: typeof evt.accountId === 'string' ? evt.accountId : undefined,
          baseUrl: typeof evt.baseUrl === 'string' ? evt.baseUrl : undefined,
          qrcodeUrl: undefined,
          qrcodeDataUri: undefined,
          error: undefined,
        };
        break;
      case 'error':
        this.state = {
          ...this.state,
          phase: 'error',
          error: `${String(evt.reason ?? 'error')}${evt.detail ? ` — ${String(evt.detail)}` : ''}`,
        };
        break;
    }
  }
}
