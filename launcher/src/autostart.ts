/**
 * Login autostart — automatically launches the launcher on login (the launcher then
 * starts the agent according to its configuration).  Cross-platform:
 *   linux  → ~/.config/autostart/philont-launcher.desktop (XDG autostart)
 *   darwin → ~/Library/LaunchAgents/com.philont.launcher.plist (launchd, RunAtLoad)
 *   win32  → startup folder philont-launcher.cmd
 *
 * Launch command: defaults to `process.execPath process.argv[1]` (after packaging
 * this equals `node dist/index.js`, which is correct).  The installer can override
 * it explicitly via PHILONT_LAUNCHER_CMD (more stable).  Best-effort — returns an
 * error on failure rather than throwing.
 */
import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'fs';

function launcherCommand(): string {
  const override = process.env.PHILONT_LAUNCHER_CMD?.trim();
  if (override) return override;
  const script = process.argv[1] ?? '';
  return `"${process.execPath}" "${script}"`;
}

function entryPath(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'LaunchAgents', 'com.philont.launcher.plist');
    case 'win32':
      return join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'philont-launcher.cmd');
    default:
      return join(home, '.config', 'autostart', 'philont-launcher.desktop');
  }
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// POSIX sh single-quote wrapping: replace internal ' with '\'' (close-escape-reopen).
const shSingleQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function entryContent(): string {
  const cmd = launcherCommand();
  switch (process.platform) {
    case 'darwin':
      // ProgramArguments must be split into an array; wrap with sh -c. The cmd must be XML-escaped (paths may contain & " <)
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        '  <key>Label</key><string>com.philont.launcher</string>',
        '  <key>ProgramArguments</key>',
        `  <array><string>/bin/sh</string><string>-c</string><string>${xmlEscape(cmd)}</string></array>`,
        '  <key>RunAtLoad</key><true/>',
        '  <key>KeepAlive</key><false/>',
        '</dict></plist>',
        '',
      ].join('\n');
    case 'win32':
      // `start "" <title placeholder>` followed by the command; cmd already wraps each path in double quotes
      return `@echo off\r\nstart "" ${cmd}\r\n`;
    default:
      // Exec=sh -c '<cmd>': cmd is safely single-quoted; paths containing ' are handled without truncation
      return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=PHILONT launcher',
        `Exec=sh -c ${shSingleQuote(cmd)}`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n');
  }
}

export function isAutostartEnabled(): boolean {
  return existsSync(entryPath());
}

export function setAutostart(enabled: boolean): { ok: boolean; path: string; error?: string } {
  const path = entryPath();
  try {
    if (enabled) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, entryContent(), 'utf8');
    } else if (existsSync(path)) {
      rmSync(path);
    }
    return { ok: true, path };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}
