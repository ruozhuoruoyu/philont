/**
 * Wraps ILinkClient.uploadAndSendMedia as a MediaChannel for the cross-channel registry.
 *
 * sessionId convention (maintained by wechat/index.ts makeSessionId):
 *   `wechat:<accountId>:<userId>`                — DM
 *   `wechat:<accountId>:group:<groupId>:<userId>` — group
 *
 * This channel's matches(sid) only recognises the `wechat:<accountId>:` prefix (account-scoped).
 * In multi-account scenarios, each account registers its own instance and handles its own sessions.
 *
 * Peer resolution:
 *   - DM: take the last segment from sid = userId; send directly to that user
 *   - Group: take the `group:<groupId>:` segment; send to the group (not a private reply)
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  type MediaChannel,
  type SendMediaArgs,
  type SendMediaResult,
  type MediaKind,
} from '../registry.js';
import {
  ILinkClient,
  MEDIA_IMAGE,
  MEDIA_VIDEO,
  MEDIA_FILE,
  MEDIA_VOICE,
} from './client.js';

/** Hard file size cap (prevents the LLM from accidentally sending a 100MB video). Can be relaxed, but conservative for now. */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Map kind to the corresponding iLink MEDIA_* constant */
function kindToMediaType(kind: MediaKind): number {
  switch (kind) {
    case 'image':
      return MEDIA_IMAGE;
    case 'video':
      return MEDIA_VIDEO;
    case 'file':
      return MEDIA_FILE;
    case 'voice':
      return MEDIA_VOICE;
  }
}

/**
 * Extract the peer (user_id or room_id) that this sid should be sent to.
 *
 * Expected sid shapes:
 *   - `wechat:<acct>:<userId>` → returns userId
 *   - `wechat:<acct>:group:<groupId>:<userId>` → returns groupId (send to group)
 *
 * acct may contain `@im.wechat` (since iLink user_ids look like that); `@` is not `:`,
 * so it does not interfere with splitting.
 */
export function parseWeChatPeer(sessionId: string, accountId: string): string | null {
  const prefix = `wechat:${accountId}:`;
  if (!sessionId.startsWith(prefix)) return null;
  const rest = sessionId.slice(prefix.length);
  if (rest.startsWith('group:')) {
    // group:<gid>:<uid>
    const afterGroup = rest.slice('group:'.length);
    const colonIdx = afterGroup.indexOf(':');
    if (colonIdx < 0) return null;
    return afterGroup.slice(0, colonIdx); // groupId
  }
  return rest; // userId (may contain @im.wechat)
}

/** Create and return a MediaChannel instance; must call registerMediaChannel(...) to activate */
export function createWeChatMediaChannel(opts: {
  accountId: string;
  client: ILinkClient;
  /** Optional: custom size cap (for testing) */
  maxBytes?: number;
  /** Optional: file read injection (for testing) */
  readFile?: (path: string) => Buffer;
  /** Optional: stat injection (for testing) */
  statFile?: (path: string) => { size: number };
}): MediaChannel {
  const { accountId, client } = opts;
  const maxBytes = opts.maxBytes ?? MAX_MEDIA_BYTES;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p));
  const statFile = opts.statFile ?? ((p: string) => statSync(p));

  const channel: MediaChannel = {
    name: `wechat:${accountId}`,
    matches(sessionId) {
      return sessionId.startsWith(`wechat:${accountId}:`);
    },
    async send(sessionId, args: SendMediaArgs): Promise<SendMediaResult> {
      const peer = parseWeChatPeer(sessionId, accountId);
      if (!peer) {
        throw new Error(`wechat send: cannot extract peer from sessionId ${sessionId}`);
      }
      // Check size before reading to avoid loading large files into RAM
      const stat = statFile(args.path);
      if (stat.size > maxBytes) {
        throw new Error(
          `wechat send: file too large (${stat.size} > ${maxBytes} bytes); refuse to send`,
        );
      }
      if (stat.size === 0) {
        throw new Error('wechat send: file is empty');
      }
      const bytes = readFile(args.path);
      const fileName = args.fileName ?? basename(args.path);
      const mediaType = kindToMediaType(args.kind);
      const r = await client.uploadAndSendMedia(peer, mediaType, bytes, {
        // fileName is required for MEDIA_FILE; harmless for other types
        fileName,
      });
      if (r.ret !== 0) {
        throw new Error(`wechat send: ret=${r.ret} errmsg=${r.errmsg ?? ''}`);
      }
      return { messageId: r.message_id };
    },
  };
  return channel;
}
