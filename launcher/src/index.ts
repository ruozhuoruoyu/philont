/**
 * Philont launcher (supervisor) entry point.
 *
 *  - Serves on PHILONT_LAUNCHER_PORT (default 20267):
 *      · Control-plane API: /api/launcher/{status,config,start,stop,restart,logs}
 *      · Static web-ui (web-ui/dist), with SPA fallback to index.html
 *  - On startup: ensures ~/.philont exists → if configured (ANTHROPIC_API_KEY present)
 *    starts the agent; otherwise waits in "needs configuration" state for the front-end
 *    to submit PUT /config + restart.
 *
 * Phase 1 scope: control-plane + process supervision + config read/write.
 * Auto-open browser / system tray deferred to phase 3.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { join, normalize, extname } from 'path';
import { AgentSupervisor } from './supervisor.js';
import {
  ensurePhilontHome,
  readMaskedConfig,
  updateConfig,
  validateConfig,
  isConfigured,
} from './env-file.js';
import { webuiDistDir, philontHome, envFilePath } from './paths.js';
import { openBrowser } from './open-browser.js';
import { ensureDesktopShortcut } from './desktop-shortcut.js';
import { detectCapabilities } from './capabilities.js';
import { isAutostartEnabled, setAutostart } from './autostart.js';
import { WeChatLoginSession } from './wechat-login.js';

const LAUNCHER_PORT = Number(process.env.PHILONT_LAUNCHER_PORT) || 20267;
const supervisor = new AgentSupervisor();
const wechatLogin = new WeChatLoginSession();

// ── helpers ────────────────────────────────────────────────────────────
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Control-plane is local-only. Phase 1 keeps '*' so the web-ui dev server (5173) can
    // make cross-origin calls; once web-ui is served same-origin by the launcher in phase 2,
    // tighten this to localhost.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = '';
    const MAX = 256 * 1024;
    req.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      if (buf.length > MAX) { req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        const p = JSON.parse(buf);
        resolve(p && typeof p === 'object' ? (p as Record<string, unknown>) : {});
      } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ── Control-plane API ───────────────────────────────────────────────────
async function handleLauncherApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method === 'OPTIONS') { sendJson(res, 200, {}); return true; }

  if (req.method === 'GET' && path === '/api/launcher/status') {
    sendJson(res, 200, {
      ...supervisor.getStatus(),
      configured: isConfigured(),
      philontHome,
      envFile: envFilePath,
    });
    return true;
  }

  if (req.method === 'GET' && path === '/api/launcher/config') {
    const { values, hasKey } = readMaskedConfig();
    sendJson(res, 200, { values, hasKey, configured: isConfigured() });
    return true;
  }

  if (req.method === 'PUT' && path === '/api/launcher/config') {
    const body = await readJsonBody(req);
    const values = (body.values && typeof body.values === 'object'
      ? body.values
      : body) as Record<string, string>;
    // Only accept string values
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) clean[k] = v;
    }
    const errors = validateConfig(clean);
    if (errors.length) { sendJson(res, 400, { ok: false, errors }); return true; }
    const result = updateConfig(clean);
    sendJson(res, 200, {
      ok: true,
      written: result.written,
      skipped: result.skipped,
      configured: isConfigured(),
      restartRequired: supervisor.getStatus().state === 'running',
    });
    return true;
  }

  if (req.method === 'POST' && path === '/api/launcher/start') {
    if (!isConfigured()) { sendJson(res, 409, { ok: false, reason: 'not configured: missing main model API key (the key that matches LLM_PROVIDER)' }); return true; }
    sendJson(res, 200, supervisor.start());
    return true;
  }

  if (req.method === 'POST' && path === '/api/launcher/stop') {
    sendJson(res, 200, await supervisor.stop());
    return true;
  }

  if (req.method === 'POST' && path === '/api/launcher/restart') {
    if (!isConfigured()) { sendJson(res, 409, { ok: false, reason: 'not configured: missing main model API key (the key that matches LLM_PROVIDER)' }); return true; }
    sendJson(res, 200, await supervisor.restart());
    return true;
  }

  if (req.method === 'GET' && path === '/api/launcher/logs') {
    sendJson(res, 200, { logs: supervisor.getLogs() });
    return true;
  }

  // ── Optional capability detection (python / z3 / playwright) ──
  if (req.method === 'GET' && path === '/api/launcher/capabilities') {
    sendJson(res, 200, await detectCapabilities());
    return true;
  }

  // ── Login autostart ─────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/launcher/autostart') {
    sendJson(res, 200, { enabled: isAutostartEnabled() });
    return true;
  }
  if (req.method === 'POST' && path === '/api/launcher/autostart') {
    const body = await readJsonBody(req);
    const r = setAutostart(body.enabled !== false);
    sendJson(res, r.ok ? 200 : 500, { enabled: isAutostartEnabled(), ...r });
    return true;
  }

  // ── WeChat scan-login (drives the web-ui QR panel) ───────────
  if (req.method === 'POST' && path === '/api/launcher/wechat/login') {
    sendJson(res, 200, wechatLogin.start());
    return true;
  }
  if (req.method === 'GET' && path === '/api/launcher/wechat/login/status') {
    sendJson(res, 200, wechatLogin.getState());
    return true;
  }
  if (req.method === 'POST' && path === '/api/launcher/wechat/login/cancel') {
    sendJson(res, 200, wechatLogin.cancel());
    return true;
  }

  return false;
}

// ── Static web-ui (SPA fallback) ────────────────────────────────────────
async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  if (!existsSync(webuiDistDir)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>PHILONT launcher</title>` +
      `<body style="font-family:system-ui;max-width:640px;margin:64px auto;padding:0 16px;color:#333">` +
      `<h1>PHILONT launcher is running</h1>` +
      `<p>web-ui has not been built. Run <code>npm install &amp;&amp; npm run build</code> inside <code>web-ui/</code> first, then refresh this page.</p>` +
      `<p>Control-plane API: <code>/api/launcher/status</code></p></body>`,
    );
    return;
  }
  // Prevent directory traversal + cross-platform root path handling.
  // Note: on Windows, normalize('/') === '\\', so the old `rel === '/'` check missed the
  // root path case; filePath degraded to the directory itself → readFile(dir) threw EISDIR → 404.
  // Fix: strip leading slashes/backslashes first (root → rel empty → serve index.html),
  // then guard against '..' traversal.
  const rel = normalize(decodeURIComponent(urlPath))
    .replace(/^[/\\]+/, '')          // strip leading separators (root path becomes empty)
    .replace(/^(\.\.[/\\])+/, '');   // prevent directory traversal
  let filePath = rel ? join(webuiDistDir, rel) : join(webuiDistDir, 'index.html');
  if (!filePath.startsWith(webuiDistDir)) filePath = join(webuiDistDir, 'index.html');
  // SPA fallback: file not found **or is a directory** (e.g. request lands on a sub-directory) → index.html.
  // statSync catches the "path exists but is a directory" case that would cause readFile EISDIR.
  let isDir = false;
  try { isDir = existsSync(filePath) && statSync(filePath).isDirectory(); } catch { /* ignore */ }
  if (!existsSync(filePath) || isDir) filePath = join(webuiDistDir, 'index.html');

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/launcher/')) {
    try {
      const handled = await handleLauncherApi(req, res, url.pathname);
      if (!handled) sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }
  await serveStatic(res, url.pathname);
});

// ── boot ──────────────────────────────────────────────────────────────────
ensurePhilontHome();
server.listen(LAUNCHER_PORT, () => {
  const url = `http://localhost:${LAUNCHER_PORT}`;
  console.log(`[launcher] control-plane + web-ui: ${url}`);
  console.log(`[launcher] config file: ${envFilePath}`);
  if (isConfigured()) {
    console.log('[launcher] configured — starting agent');
    supervisor.start();
  } else {
    console.log('[launcher] needs configuration (ANTHROPIC_API_KEY missing) — fill in via web-ui; the agent will become startable automatically');
  }
  // Phase 3: discoverability — create desktop shortcut (once only) + auto-open browser.
  // System tray deferred to phase 4 (requires cross-platform native helper; cannot be validated in headless environments).
  ensureDesktopShortcut(url);
  openBrowser(url);
});

// ── Graceful shutdown: stop the agent child first, then exit ─────────────
let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[launcher] received ${sig}, shutting down`);
  try { await supervisor.stop(); } catch (e) { console.warn('[launcher] stop agent:', e); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
