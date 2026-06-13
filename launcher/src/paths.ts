/**
 * Path resolution — the launcher needs to know the locations of four things:
 *   1. ~/.philont/        Config + runtime data directory (same location as memory.sqlite / mcp.json)
 *   2. ~/.philont/.env    Authoritative config file (read/written by launcher; read by agent via PHILONT_ENV_FILE)
 *   3. agent server dir   The spawn target (dev: src/index.ts; prod: dist/index.js)
 *   4. web-ui static dir  Packaged web-ui (dist), served directly by the launcher
 *
 * Defaults are inferred from the monorepo layout (launcher, server, and web-ui are siblings).
 * Post-packaging layout may differ, so all three paths can be overridden via environment variables.
 */
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url)); // launcher/src (dev) or launcher/dist (prod)
const repoRoot = resolve(here, '..', '..');           // philont/

/** ~/.philont — root directory for config and runtime data */
export const philontHome = process.env.PHILONT_HOME
  ? resolve(process.env.PHILONT_HOME)
  : join(homedir(), '.philont');

/** ~/.philont/.env — authoritative config file */
export const envFilePath = process.env.PHILONT_ENV_FILE
  ? resolve(process.env.PHILONT_ENV_FILE)
  : join(philontHome, '.env');

/** agent server package directory (contains package.json / src / optional dist) */
export const serverDir = process.env.PHILONT_SERVER_DIR
  ? resolve(process.env.PHILONT_SERVER_DIR)
  : join(repoRoot, 'server');

/** web-ui build output directory (vite build → dist). May not yet be built. */
export const webuiDistDir = process.env.PHILONT_WEBUI_DIR
  ? resolve(process.env.PHILONT_WEBUI_DIR)
  : join(repoRoot, 'web-ui', 'dist');

/**
 * Determine how to start the agent: if dist/index.js exists → run the build output
 * with node (prod); otherwise → run src/index.ts with tsx (dev).
 * Returns { cmd, args, mode }.
 */
export function resolveAgentStartCommand(): { cmd: string; args: string[]; mode: 'prod' | 'dev' } {
  const distEntry = join(serverDir, 'dist', 'index.js');
  if (existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry], mode: 'prod' };
  }
  // dev: run the tsx CLI entry (dist/cli.mjs) directly with node, bypassing the .bin/tsx shim.
  // Key (Windows): .bin/tsx is an extensionless shell script; spawn() on it gives ENOENT
  //   (Windows only recognises tsx.cmd, which also needs shell:true + manual escaping).
  //   Running cli.mjs directly with node is cross-platform, uses an args array
  //   (safe for paths with spaces), and needs no shell.
  const srcEntry = join(serverDir, 'src', 'index.ts');
  const tsxCli = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(tsxCli)) {
    return { cmd: process.execPath, args: [tsxCli, srcEntry], mode: 'dev' };
  }
  // Fallback: server-local .bin/tsx (POSIX) / tsx.cmd (Windows); if that is also absent, hope tsx is on PATH.
  const tsxBin = join(serverDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  return { cmd: existsSync(tsxBin) ? tsxBin : 'tsx', args: [srcEntry], mode: 'dev' };
}

/**
 * Command to run the WeChat scan-login CLI in --json mode (drives the web-ui panel).
 * Same prod(dist)/dev(tsx) resolution as the agent; entry is the wechat cli, args end
 * with `login --json`.
 */
export function resolveWeChatLoginCommand(): { cmd: string; args: string[] } {
  const distEntry = join(serverDir, 'dist', 'channels', 'wechat', 'cli.js');
  if (existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry, 'login', '--json'] };
  }
  const srcEntry = join(serverDir, 'src', 'channels', 'wechat', 'cli.ts');
  const tsxCli = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(tsxCli)) {
    return { cmd: process.execPath, args: [tsxCli, srcEntry, 'login', '--json'] };
  }
  const tsxBin = join(serverDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  return { cmd: existsSync(tsxBin) ? tsxBin : 'tsx', args: [srcEntry, 'login', '--json'] };
}
