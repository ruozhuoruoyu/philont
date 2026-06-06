/**
 * Tool · `replyWithMedia`
 *
 * Sends a local file as media back to the peer in the current session (in WeChat, that is
 * the current conversation user; in a group, it replies to the group).
 *
 * Design points:
 *   - Does not accept an explicit `to` parameter — the peer is automatically resolved from
 *     the sessionId via the channel registry. The LLM does not need to know (and should not
 *     see) the user's user_id.
 *   - If the current session does not belong to any channel that has registered media
 *     capability (typical case: web-ui direct connection) → return a clear error, **not a
 *     silent success**. The LLM knows it should switch to `writeFile` to save locally and
 *     tell the user the path in the response text.
 *   - The file must actually exist + be non-empty + not exceed the hard size limit —
 *     the channel performs its own size check.
 *   - capability=write, domain=network → PolicyGate will ask for authorization the first
 *     time (same as other network write operations).
 */

import type { Tool } from '@agent/policy';
import { findMediaChannel, type MediaKind } from '../channels/registry.js';
import { currentSessionId } from '../channels/turn_context.js';

const VALID_KINDS: MediaKind[] = ['image', 'file', 'voice', 'video'];

export const replyWithMediaTool: Tool = {
  name: 'replyWithMedia',
  description:
    '把本地文件作为媒体发回当前会话所在 channel 的 peer(微信里 = 当前对话用户;群里 = 群)。\n' +
    'kind 选 image/file/voice/video 之一,path 是本地绝对路径。\n' +
    '注意:仅当前会话来自支持媒体的 channel(如微信)时可用;web-ui 等不行,会返回明确错误,' +
    '此时改用 writeFile 落到本地后在回答里把路径告诉用户。',
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: VALID_KINDS,
        description: 'image=图片(jpg/png/gif),video=视频(mp4),voice=语音(silk),file=任意文件',
      },
      path: { type: 'string', description: '本地文件绝对路径' },
      fileName: {
        type: 'string',
        description: '可选:接收端显示的文件名;省略则用 path 的 basename',
      },
    },
    required: ['kind', 'path'],
  },
  capability: 'write',
  domain: 'network',

  async execute(params: Record<string, unknown>) {
    const kind = params.kind as MediaKind;
    const path = params.path as string;
    const fileName = params.fileName as string | undefined;

    if (!VALID_KINDS.includes(kind)) {
      return {
        success: false,
        output: '',
        error: `invalid kind: ${JSON.stringify(kind)}; must be one of ${VALID_KINDS.join('/')}`,
      };
    }
    if (typeof path !== 'string' || path.length === 0) {
      return { success: false, output: '', error: 'path must be a non-empty string' };
    }

    const sid = currentSessionId();
    if (!sid) {
      // Not in a turn context (called externally? should not happen)
      return {
        success: false,
        output: '',
        error: 'no active turn context — replyWithMedia must be called during a chat turn',
      };
    }

    const channel = findMediaChannel(sid);
    if (!channel) {
      return {
        success: false,
        output: '',
        error:
          `当前会话(${sid})不属于任何支持媒体发送的 channel(典型如 web-ui)。` +
          `若要把文件给用户,改用 writeFile 落到本地路径,在回答里把路径告诉用户。`,
      };
    }

    try {
      const r = await channel.send(sid, { kind, path, fileName });
      return {
        success: true,
        output: `✓ 已通过 ${channel.name} 发送 ${kind} (path=${path}${r.messageId ? `, messageId=${r.messageId}` : ''})`,
      };
    } catch (e) {
      return {
        success: false,
        output: '',
        error: `${channel.name} send failed: ${(e as Error)?.message ?? String(e)}`,
      };
    }
  },
};
