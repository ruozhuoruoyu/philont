/**
 * Shell output encoding utilities
 *
 * Background: Windows systems with Chinese locale default cmd to GBK; child-process stdout decoded
 * by Node's UTF-8 decoder becomes ������ garbage that pollutes the context. Linux/macOS default
 * to UTF-8, so these functions are no-ops on non-Windows platforms.
 *
 * Core strategy: inject a codepage switch before the command so the child cmd outputs UTF-8 directly.
 *  - cmd.exe    → `chcp 65001 >nul && <cmd>`
 *  - PowerShell → `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); <cmd>`
 *
 * `chcp 65001` only takes effect for the current cmd process — the parent shell's codepage is
 * unaffected after the child exits. It is safe to inject this on every exec call.
 */

const REPLACEMENT_CHAR = '�'; // U+FFFD REPLACEMENT CHARACTER ('�')

export type ShellKind = 'cmd' | 'pwsh' | 'bash' | 'zsh' | 'sh';

/**
 * Heuristically determine which shell the command intends to use.
 *
 * Primarily checks the first token of the command — if it explicitly starts with `powershell`/`pwsh`,
 * treat it as PowerShell; otherwise use the platform default shell (cmd on Windows, bash on Unix-like).
 */
export function detectShellKind(command: string): ShellKind {
  const firstToken = command.trimStart().split(/[\s|&;]/, 1)[0]?.toLowerCase() ?? '';
  if (firstToken === 'powershell' || firstToken === 'pwsh') return 'pwsh';
  if (firstToken === 'cmd' || firstToken === 'cmd.exe') return 'cmd';
  if (process.platform === 'win32') return 'cmd';
  return 'bash';
}

/**
 * Inject a UTF-8 codepage switch before the command. Only takes effect on Windows; other platforms
 * return the command unchanged.
 *
 * Commands that already contain a chcp call are not injected again (avoids `chcp 65001 && chcp 65001 && ...`).
 */
export function prefixCommandWithUtf8(command: string, shell?: ShellKind): string {
  if (process.platform !== 'win32') return command;

  const kind = shell ?? detectShellKind(command);
  const trimmed = command.trimStart();

  // Commands that already set chcp / OutputEncoding should not be injected again
  if (/^chcp\s+\d+/i.test(trimmed)) return command;
  if (/OutputEncoding\s*=/.test(trimmed)) return command;

  if (kind === 'cmd') {
    return `chcp 65001 >nul && ${command}`;
  }
  if (kind === 'pwsh') {
    return `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); ${command}`;
  }
  // bash/sh on Windows (Git Bash, WSL) is generally already UTF-8; leave it alone
  return command;
}

/** Whether U+FFFD (the decoding-failure placeholder) appears in the string. */
export function detectReplacementChar(text: string): boolean {
  return text.includes(REPLACEMENT_CHAR);
}

/** Replace U+FFFD with a readable placeholder (for end-user-facing rendering). */
export function sanitizeReplacementChar(text: string, placeholder = '?'): string {
  return text.split(REPLACEMENT_CHAR).join(placeholder);
}
