/**
 * Create a desktop / application-menu shortcut (created only once; skipped if it already
 * exists) — gives non-technical users a clickable "door" back to PHILONT without having
 * to remember the localhost address.  Best-effort; failure does not affect operation.
 *
 * Disable with: PHILONT_DESKTOP_SHORTCUT=0.
 *
 * Per platform:
 *   win32  → Desktop PHILONT.url (native Internet shortcut, double-click opens browser)
 *   darwin → Desktop PHILONT.command (executable sh, double-click opens default browser)
 *   linux  → ~/.local/share/applications/philont.desktop (appears in the application menu)
 */
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, writeFileSync, chmodSync, mkdirSync } from 'fs';

export function ensureDesktopShortcut(url: string): void {
  if (process.env.PHILONT_DESKTOP_SHORTCUT === '0') return;
  try {
    const p = process.platform;
    if (p === 'win32') {
      const file = join(homedir(), 'Desktop', 'PHILONT.url');
      if (existsSync(file)) return;
      writeFileSync(file, `[InternetShortcut]\r\nURL=${url}\r\n`, 'utf8');
      console.log('[launcher] desktop shortcut created:', file);
    } else if (p === 'darwin') {
      const file = join(homedir(), 'Desktop', 'PHILONT.command');
      if (existsSync(file)) return;
      writeFileSync(file, `#!/bin/sh\nopen "${url}"\n`, 'utf8');
      chmodSync(file, 0o755);
      console.log('[launcher] desktop shortcut created:', file);
    } else {
      const dir = join(homedir(), '.local', 'share', 'applications');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = join(dir, 'philont.desktop');
      if (existsSync(file)) return;
      const content =
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=PHILONT',
          'Comment=Open PHILONT',
          `Exec=xdg-open ${url}`,
          'Terminal=false',
          'Categories=Utility;',
        ].join('\n') + '\n';
      writeFileSync(file, content, 'utf8');
      chmodSync(file, 0o755);
      console.log('[launcher] application menu entry created:', file);
    }
  } catch (e) {
    console.warn('[launcher] failed to create shortcut (ignored):', (e as Error).message);
  }
}
