/**
 * Automatically opens the system browser to the launcher page on startup — the first
 * discoverability measure in the "browser + small launcher" model (paired with the desktop
 * shortcut).  Best-effort; failure or a headless environment does not affect the launcher.
 *
 * Disable with: PHILONT_NO_OPEN=1 or PHILONT_OPEN_BROWSER=0.
 */
import { spawn } from 'child_process';

export function openBrowser(url: string): void {
  if (process.env.PHILONT_NO_OPEN === '1' || process.env.PHILONT_OPEN_BROWSER === '0') {
    console.log('[launcher] skipping auto-open browser (PHILONT_NO_OPEN)');
    return;
  }
  const p = process.platform;
  // Linux without a display (headless server / container) → skip; xdg-open would error and serve no purpose
  if (p === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log(`[launcher] no display environment (DISPLAY not set) — skipping auto-open. Visit manually: ${url}`);
    return;
  }

  let cmd: string;
  let args: string[];
  if (p === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (p === 'win32') {
    // The first quoted arg to `start` is the window title (left empty); otherwise a URL with spaces would be treated as the title
    cmd = 'cmd'; args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open'; args = [url];
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.warn(`[launcher] failed to open browser (ignored): ${e.message}`));
    child.unref();
    console.log(`[launcher] attempted to open browser at ${url}`);
  } catch (e) {
    console.warn('[launcher] failed to open browser (ignored):', (e as Error).message);
  }
}
