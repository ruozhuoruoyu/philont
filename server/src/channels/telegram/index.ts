/**
 * Telegram channel server mount entry point
 *
 * Structure mirrors wechat/index.ts:
 *   - Startup: verify token (getMe) → create TelegramClient + OutboundQueue + TelegramGateway
 *   - Bridge: gateway inbound text → policy check → construct stable sessionId → call handleChatSend
 *   - Outbound: onDelta buffers the entire turn, then extractUserSection + renderForTelegram → OutboundQueue at turn end
 *   - Authorization: onAuthRequest → cached, sent separately after turn reasoning (more prominent)
 *   - Typing: sendChatAction(typing) on inbound, improving "waiting anxiety"
 *
 * Reuses wechat's shared components: OutboundQueue / checkInboundPolicy / output_section_filter.
 * sessionId convention:
 *   `telegram:<botId>:<userId>`                 (DM)
 *   `telegram:<botId>:group:<chatId>:<userId>`  (group)
 *
 * Enable: TELEGRAM_ENABLED=1 TELEGRAM_BOT_TOKEN=<token> (see config.ts for details).
 */

import { TelegramClient } from './client.js';
import { TelegramGateway, type InboundEvent, type GatewayLogger } from './gateway.js';
import { renderForTelegram } from './render.js';
import { createTelegramMediaChannel } from './media_channel.js';
import { OutboundQueue, type RawSender } from '../wechat/outbound.js';
import { checkInboundPolicy, type PolicyConfig } from '../wechat/policy.js';
import { registerMediaChannel, unregisterMediaChannel } from '../registry.js';
import { registerPushChannel, unregisterPushChannel, type PushChannel } from '../../push/channel.js';
import { extractUserSection, recordFilterCall } from '../../output_section_filter.js';
import { runConscienceGate } from '../../conscience_gate.js';

/** AuthRequest structure from chat-handler. */
export type AuthRequestPayload = {
  toolName: string;
  capability: string;
  domain: string;
  input: unknown;
  clarification?: string;
};

/** handleChatSend injection (avoids import cycles). */
export type ChatSendFn = (
  sessionId: string,
  userMessage: string,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequestPayload) => void,
  onStatus?: (text: string) => void,
  onTrace?: (ev: unknown) => void,
) => Promise<unknown>;

export interface MountOptions {
  chatSend: ChatSendFn;
  token: string;
  policy: PolicyConfig;
  logger?: GatewayLogger;
}

export async function startTelegramGateway(opts: MountOptions): Promise<TelegramGateway> {
  const logger = opts.logger ?? defaultLogger();
  const client = new TelegramClient(opts.token);

  // Verify token + get bot identifier
  const me = await client.getMe();
  const botId = me.username ? me.username : String(me.id);
  logger.info('bot authenticated', { botId, username: me.username });

  const rawSender: RawSender = async (to, text) => {
    const r = await client.sendText(to, text);
    return { ok: r.ok, messageId: r.messageId };
  };
  const outbound = new OutboundQueue(rawSender, { chunkLimit: 4000 }); // Telegram single-message limit is 4096

  const dispatch = makeDispatcher({ botId, client, chatSend: opts.chatSend, outbound, policy: opts.policy, logger });

  const gw = new TelegramGateway({ client, dispatch, botId, logger });

  // Register media + push channel (name = telegram:<botId>)
  const mediaChannel = createTelegramMediaChannel({ botId, client });
  registerMediaChannel(mediaChannel);
  logger.info('telegram media channel registered', { name: mediaChannel.name });

  const pushChannelName = `telegram:${botId}`;
  const pushChannel: PushChannel = {
    name: pushChannelName,
    isReady: () => true,
    async pushText(peer, text) {
      try {
        const r = await outbound.sendText(peer, text);
        return {
          ok: r.chunksSent > 0,
          messageIds: r.messageIds,
          ...(r.chunksSent === 0 ? { error: 'all chunks deduped or failed' } : {}),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
  registerPushChannel(pushChannel);
  logger.info('telegram push channel registered', { name: pushChannelName });

  void gw.start().catch((e) => logger.error(`gateway crashed: ${String(e)}`, { botId }));

  const stopOnSignal = () => {
    unregisterMediaChannel(mediaChannel);
    unregisterPushChannel(pushChannelName);
    gw.stop();
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);

  logger.info('telegram gateway scheduled', {
    botId,
    policy: { dm: opts.policy.dmPolicy, group: opts.policy.groupPolicy },
  });
  return gw;
}

function makeDispatcher(opts: {
  botId: string;
  client: TelegramClient;
  chatSend: ChatSendFn;
  outbound: OutboundQueue;
  policy: PolicyConfig;
  logger: GatewayLogger;
}): (e: InboundEvent) => Promise<void> {
  const { botId, client, chatSend, outbound, policy, logger } = opts;

  const STATUS_MIN_INTERVAL_MS = 4_000;
  const STATUS_DEDUP_WINDOW_MS = 30_000;

  return async (event: InboundEvent) => {
    if (!event.text) return;

    // Policy: drop DMs / groups not in the allowlist (audit-style log)
    const decision = checkInboundPolicy({ fromUserId: event.fromUserId, groupId: event.groupId }, policy);
    if (!decision.allowed) {
      logger.info('inbound denied by policy', { from: event.fromUserId, reason: decision.reason });
      return;
    }

    const sessionId = makeSessionId(botId, event);
    const replyTo = event.chatId;

    // Typing indicator (valid for 5s; reduces wait anxiety without streaming). Fire-and-forget.
    void client.sendChatAction(replyTo, 'typing');

    const buffer: string[] = [];
    const onDelta = (chunk: string) => {
      if (chunk) buffer.push(chunk);
    };

    let pendingAuthPrompt: string | null = null;
    const onAuthRequest = (req: AuthRequestPayload) => {
      pendingAuthPrompt = renderAuthPrompt(req);
    };

    const recentStatus = new Map<string, number>();
    let lastStatusAt = 0;
    const onStatus = (text: string) => {
      if (!text || !text.trim()) return;
      const now = Date.now();
      if (now - lastStatusAt < STATUS_MIN_INTERVAL_MS) return;
      const seen = recentStatus.get(text);
      if (seen !== undefined && now - seen < STATUS_DEDUP_WINDOW_MS) return;
      lastStatusAt = now;
      recentStatus.set(text, now);
      void client.sendChatAction(replyTo, 'typing'); // extend typing
      void outbound.sendText(replyTo, text).catch((e) => logger.error(`onStatus relay failed: ${String(e)}`, { replyTo }));
    };

    try {
      await chatSend(sessionId, event.text, onDelta, onAuthRequest, onStatus);
    } catch (e) {
      logger.error(`chatSend threw: ${String(e)}`, { sessionId, from: event.fromUserId });
      void outbound.sendText(replyTo, `抱歉,刚才出错了:${truncate(String((e as Error)?.message ?? e), 200)}`);
      return;
    }

    const fullText = buffer.join('').trim();
    if (fullText.length > 0) {
      const filtered = extractUserSection(fullText);
      recordFilterCall(filtered.usedSection);
      let sectioned = filtered.text || fullText;
      // Conscience gate (L3 send-to-human exit; no-op unless PHILONT_CONSCIENCE_GATE is on, fail-open).
      const verdict = await runConscienceGate(sectioned);
      if (!verdict.allow) {
        logger.info('conscience_gate withheld outbound', { sessionId, reason: verdict.reason });
        sectioned = '(本条回复被安全审查拦下,未发送。)';
      }
      const rendered = renderForTelegram(sectioned).trim();
      if (rendered.length > 0) {
        try {
          const r = await outbound.sendText(replyTo, rendered);
          logger.info('outbound sent', { replyTo, chunks: r.chunksSent, sectionHit: filtered.usedSection });
        } catch (e) {
          logger.error(`outbound.sendText failed: ${String(e)}`, { replyTo });
        }
      }
    }

    if (pendingAuthPrompt) {
      try {
        await outbound.sendText(replyTo, pendingAuthPrompt);
      } catch (e) {
        logger.error(`auth prompt sendText failed: ${String(e)}`, { replyTo });
      }
    }
  };
}

function makeSessionId(botId: string, e: InboundEvent): string {
  if (e.groupId) return `telegram:${botId}:group:${e.groupId}:${e.fromUserId}`;
  return `telegram:${botId}:${e.fromUserId}`;
}

/** AuthRequest → human-readable Telegram authorization prompt (plain text). */
function renderAuthPrompt(req: AuthRequestPayload): string {
  const lines = [
    '🔐 需要你授权',
    `工具:${req.toolName}（${req.capability} / ${req.domain}）`,
  ];
  if (req.clarification) lines.push(req.clarification);
  let inputStr = '';
  try {
    inputStr = typeof req.input === 'string' ? req.input : JSON.stringify(req.input);
  } catch {
    inputStr = String(req.input);
  }
  if (inputStr && inputStr !== '{}') lines.push(`参数:${truncate(inputStr, 300)}`);
  lines.push('回复"同意/yes"放行,或"拒绝/no"取消。');
  return lines.join('\n');
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

function defaultLogger(): GatewayLogger {
  return {
    info: (m, meta) => console.log(`[telegram] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[telegram] ${m}`, meta ?? ''),
    error: (m, meta) => console.error(`[telegram] ${m}`, meta ?? ''),
  };
}
