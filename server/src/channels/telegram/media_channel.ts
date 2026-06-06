/**
 * Telegram MediaChannel — wraps TelegramClient's sendPhoto/sendDocument into a
 * MediaChannel for the cross-channel registry (the LLM's replyWithMedia tool routes
 * here via sessionId).
 *
 * sessionId convention (maintained by telegram/index.ts):
 *   `telegram:<botId>:<userId>`                  — DM (chatId == userId)
 *   `telegram:<botId>:group:<chatId>:<userId>`   — group (chatId == group id)
 *
 * kind mapping: image → sendPhoto; others (file/video/voice) → sendDocument (v1 simplified).
 */

import { statSync } from 'node:fs';
import {
  type MediaChannel,
  type SendMediaArgs,
  type SendMediaResult,
} from '../registry.js';
import type { TelegramClient } from './client.js';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Extract the reply chat id from a sessionId. */
export function parseTelegramChatId(sessionId: string, botId: string): string | null {
  const prefix = `telegram:${botId}:`;
  if (!sessionId.startsWith(prefix)) return null;
  const rest = sessionId.slice(prefix.length);
  if (rest.startsWith('group:')) {
    const afterGroup = rest.slice('group:'.length);
    const colonIdx = afterGroup.indexOf(':');
    if (colonIdx < 0) return null;
    return afterGroup.slice(0, colonIdx); // group chatId
  }
  return rest; // DM userId == chatId
}

export function createTelegramMediaChannel(opts: {
  botId: string;
  client: TelegramClient;
  maxBytes?: number;
  statFile?: (path: string) => { size: number };
}): MediaChannel {
  const { botId, client } = opts;
  const maxBytes = opts.maxBytes ?? MAX_MEDIA_BYTES;
  const statFile = opts.statFile ?? ((p: string) => statSync(p));

  return {
    name: `telegram:${botId}`,
    matches(sessionId) {
      return sessionId.startsWith(`telegram:${botId}:`);
    },
    async send(sessionId, args: SendMediaArgs): Promise<SendMediaResult> {
      const chatId = parseTelegramChatId(sessionId, botId);
      if (!chatId) {
        throw new Error(`telegram send: cannot extract chatId from sessionId ${sessionId}`);
      }
      const stat = statFile(args.path);
      if (stat.size > maxBytes) {
        throw new Error(`telegram send: file too large (${stat.size} > ${maxBytes} bytes)`);
      }
      if (stat.size === 0) {
        throw new Error('telegram send: file is empty');
      }
      const caption = args.fileName;
      const r =
        args.kind === 'image'
          ? await client.sendPhoto(chatId, args.path, caption)
          : await client.sendDocument(chatId, args.path, caption);
      if (!r.ok) {
        throw new Error(`telegram send failed: ${r.error ?? 'unknown'}`);
      }
      return { messageId: r.messageId };
    },
  };
}
