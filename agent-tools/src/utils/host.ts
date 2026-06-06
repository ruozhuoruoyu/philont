/**
 * Host OS / shell detection — single source of truth.
 *
 * Purpose: let the LLM **know what OS / shell it is actually running on** so it writes the correct dialect.
 * Observed pain point: the LLM defaults to bash, causing `which`/heredoc(`<<`)/`cd /d` to all fail on
 * Windows (where commands run via cmd.exe). Instead of translating commands (fragile), we explicitly
 * tell the LLM the real platform + dialect rules — once it knows, it writes correctly.
 *
 * The philont process runs on the host; `process.platform` is the real OS. The shell tool uses Node defaults:
 * Windows → cmd.exe /c, Unix-like → /bin/sh -c.
 */

import { existsSync } from 'node:fs';

export const HOST_IS_WINDOWS = process.platform === 'win32';

/**
 * The actual shell used by the shell tool on POSIX.
 *
 * Pitfall: Node's exec defaults to `/bin/sh` — on most Linux systems `/bin/sh` is **dash**,
 * while the LLM defaults to bash syntax (`[[ ]]`, arrays, `<(...)`, `source`), which errors
 * under dash. This also contradicts the "sh/bash" dialect promised in the tool description.
 * On macOS, `/bin/sh` is bash in POSIX mode, which likewise does not support these extensions.
 *
 * Solution: on POSIX, prefer `/bin/bash` (present on Mac and the vast majority of Linux
 * desktops/servers), so the LLM's bash syntax actually works. Fall back to Node's default
 * (/bin/sh) only when bash is not found.
 * Returns undefined on Windows → Node uses cmd.exe (the host dialect hint constrains the LLM to write cmd).
 */
export const POSIX_PREFERRED_SHELL: string | undefined = (() => {
  if (HOST_IS_WINDOWS) return undefined;
  for (const sh of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
    if (existsSync(sh)) return sh;
  }
  return undefined; // fall back to Node default /bin/sh
})();

/** Short label for human / log consumption. */
export function hostShellLabel(): string {
  return HOST_IS_WINDOWS ? `Windows (cmd.exe)` : `${process.platform} (POSIX sh/bash)`;
}

/**
 * Dialect rules for the shell tool description (multi-line). Windows section highlights the key cmd vs bash pitfalls.
 */
export function hostShellGuidanceLines(): string[] {
  if (HOST_IS_WINDOWS) {
    return [
      '  - **Current host = Windows; commands run via cmd.exe /c — you MUST use cmd syntax, not bash**:',
      '      · Find a command\'s location with `where xxx` (not `which`); list a directory with `dir`;',
      '      · **No support** for heredoc (`<<`), `$(...)`, single-quoted strings, or bash chaining beyond `&&`;',
      '      · Use backslash paths in quotes: `"C:\\Users\\me\\x.py"`; add `/d` to `cd` across drives;',
      '      · Run Python with `python` (`python3` may not exist); for multi-line scripts, write a file then run it — don\'t stuff a heredoc into -c;',
      '      · When you need pipes/objects/Unix-style behavior, explicitly use `powershell -NoProfile -Command "..."`.',
    ];
  }
  return [
    `  - **Current host = ${process.platform} (Unix-like); commands run via /bin/sh -c**. Use POSIX sh/bash syntax (which/pipes/heredoc all work).`,
  ];
}

/**
 * A short one-liner injected into the system prompt (improves OS awareness salience; also influences
 * writeFile path style etc.). Keep it short when no information is lost, to save tokens.
 */
export function hostEnvPromptLine(): string {
  return HOST_IS_WINDOWS
    ? '## Runtime environment\nHost OS: **Windows** (shell is cmd.exe). Write commands/scripts/paths the Windows way: `where` not `which`, no heredoc, quote `C:\\...` paths, run Python with `python`; for more power use `powershell -Command`.'
    : `## Runtime environment\nHost OS: **${process.platform}** (POSIX sh/bash).`;
}
