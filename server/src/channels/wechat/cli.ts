#!/usr/bin/env node
/**
 * WeChat CLI sub-commands
 *
 *   npm run wechat:login           Scan-code login (interactive)
 *   npm run wechat:list            List logged-in accounts
 *   npm run wechat:logout <id>     Delete an account (local only)
 *
 * The three sub-commands are distinguished by argv[2]; the primary entry point is login.
 */

import { ILinkClient } from './client.js';
import { loginWithQrCode } from './login.js';
import {
  DEFAULT_BASE_URL,
  deleteAccount,
  isValidAccountId,
  listAccounts,
  readCredentials,
  writeCredentials,
} from './state.js';

async function main() {
  const cmd = process.argv[2] ?? 'login';
  switch (cmd) {
    case 'login':
      // --json: emit machine-readable JSONL events (qr / status / confirmed / error)
      // on stdout instead of the human banner. Used by the launcher to drive the
      // web-ui scan-login panel.
      await cmdLogin(process.argv.includes('--json'));
      break;
    case 'list':
      cmdList();
      break;
    case 'logout': {
      const id = process.argv[3];
      if (!id) {
        console.error('Usage: npm run wechat:logout <accountId>');
        process.exit(2);
      }
      cmdLogout(id);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

async function cmdLogin(json = false): Promise<void> {
  // In --json mode, every line on stdout is one JSON event the launcher parses.
  const emit = (o: unknown): void => { process.stdout.write(`${JSON.stringify(o)}\n`); };

  // Allow env to override baseUrl (overseas / self-hosted deployments)
  const baseUrl = process.env.WECHAT_BASE_URL || DEFAULT_BASE_URL;
  const accountIdOverride = process.env.WECHAT_ACCOUNT_ID;
  if (accountIdOverride && !isValidAccountId(accountIdOverride)) {
    if (json) emit({ type: 'error', reason: 'bad_account_id', detail: accountIdOverride });
    else console.error(`Invalid accountId: ${accountIdOverride} (only [A-Za-z0-9_.-]{1,64} allowed)`);
    process.exit(2);
  }

  if (!json) console.log(`\n🔑 WeChat scan-QR login\n   base: ${baseUrl}\n`);

  const client = new ILinkClient({ baseUrl });
  const r = await loginWithQrCode({
    client,
    baseUrl,
    accountIdOverride,
    render: json
      ? ({ qrcodeUrl, qrcodeToken, attempt }) => emit({ type: 'qr', url: qrcodeUrl, token: qrcodeToken, attempt })
      : undefined,
    onStatus: json ? (phase) => emit({ type: 'status', phase }) : undefined,
  });

  if (!r.ok) {
    if (json) emit({ type: 'error', reason: r.reason, detail: r.detail });
    else console.error(`\n❌ Login failed: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
    process.exit(1);
  }

  writeCredentials(r.credentials);
  if (json) {
    emit({ type: 'confirmed', accountId: r.credentials.accountId, baseUrl: r.credentials.baseUrl });
    return;
  }
  console.log(`\n✅ Login succeeded`);
  console.log(`   accountId : ${r.credentials.accountId}`);
  console.log(`   baseUrl   : ${r.credentials.baseUrl}`);
  console.log(`   token     : ${maskToken(r.credentials.token)}`);
  console.log(`   location  : ~/.philont/wechat/accounts/${r.credentials.accountId}/credentials.json`);
  console.log(`\nNext step — start the gateway (pick one):`);
  console.log(`   bash / zsh:    WECHAT_ENABLED=1 npm run dev`);
  console.log(`   PowerShell:    $env:WECHAT_ENABLED="1"; npm run dev`);
  console.log(`   cmd.exe:       set WECHAT_ENABLED=1 && npm run dev`);
}

function cmdList(): void {
  const ids = listAccounts();
  if (ids.length === 0) {
    console.log('(No accounts yet. Run npm run wechat:login first)');
    return;
  }
  console.log(`Logged-in accounts (total ${ids.length}):`);
  for (const id of ids) {
    const creds = readCredentials(id);
    if (creds) {
      const ageDays = Math.floor((Date.now() - creds.createdAt) / 86_400_000);
      console.log(`  - ${id}    (token=${maskToken(creds.token)}, age=${ageDays}d, base=${creds.baseUrl})`);
    } else {
      console.log(`  - ${id}    (credentials file corrupted / missing)`);
    }
  }
}

function cmdLogout(id: string): void {
  if (!isValidAccountId(id)) {
    console.error(`Invalid accountId: ${id}`);
    process.exit(2);
  }
  if (!readCredentials(id) && !listAccounts().includes(id)) {
    console.error(`Account does not exist: ${id}`);
    process.exit(1);
  }
  deleteAccount(id);
  console.log(`✅ Account deleted: ${id}`);
}

function maskToken(t: string): string {
  if (t.length <= 8) return '****';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function printHelp(): void {
  console.log(`
philont wechat CLI

Usage:
  npm run wechat:login              Scan QR to log in a new account (env: WECHAT_BASE_URL / WECHAT_ACCOUNT_ID can override)
  npm run wechat:list               List logged-in accounts
  npm run wechat:logout <accountId> Delete an account's local credentials

Environment variables:
  WECHAT_BASE_URL       Default ${DEFAULT_BASE_URL}
  WECHAT_ACCOUNT_ID     Force this accountId when logging in (otherwise uses ilink_user_id)
  PHILONT_WECHAT_ROOT    Credentials storage directory (default ~/.philont/wechat)
`);
}

main().catch((e) => {
  console.error('\n💥 Internal error:', e);
  process.exit(1);
});
