/**
 * Telegram channel configuration (read from env).
 *
 * Reuses wechat/policy's PolicyConfig + checkInboundPolicy (universal),
 * only changing the env prefix.
 *
 * Environment variables:
 *   TELEGRAM_ENABLED=1          Enable (otherwise the server does not mount telegram)
 *   TELEGRAM_BOT_TOKEN=<token>  Bot token obtained from @BotFather (required)
 *   TELEGRAM_DM_POLICY=allowlist|open|disabled   Default: open
 *   TELEGRAM_ALLOWED_USERS=<id1,id2>             Allowed users under allowlist (Telegram numeric user ids)
 *   TELEGRAM_GROUP_POLICY=disabled|open|allowlist Default: disabled
 *   TELEGRAM_ALLOWED_GROUPS=<chatId1,...>        Group allowlist
 */

import type { PolicyConfig, DmPolicy, GroupPolicy } from '../wechat/policy.js';

export interface TelegramConfig {
  token: string;
  policy: PolicyConfig;
}

function csv(v: string | undefined): string[] {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Read the Telegram configuration. Returns null if not enabled or token is missing (server skips mounting). */
export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const enabled = ['1', 'true', 'yes'].includes((env.TELEGRAM_ENABLED || '').trim().toLowerCase());
  if (!enabled) return null;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.warn('[telegram] TELEGRAM_ENABLED is set but TELEGRAM_BOT_TOKEN is missing; skipping mount');
    return null;
  }
  const policy: PolicyConfig = {
    dmPolicy: (env.TELEGRAM_DM_POLICY as DmPolicy) || 'open',
    groupPolicy: (env.TELEGRAM_GROUP_POLICY as GroupPolicy) || 'open',
    allowedUsers: csv(env.TELEGRAM_ALLOWED_USERS),
    allowedGroups: csv(env.TELEGRAM_ALLOWED_GROUPS),
  };
  return { token, policy };
}
