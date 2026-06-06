import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { agentWsBase, resolveAgentPort } from './config.js';
import { LangController, t } from './i18n.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** epoch ms. 旧记录可能缺省，loadMessages 会回填当前时间。 */
  timestamp: number;
}

/**
 * Tier 3/4 明细事件(2026-05-19 三流分离)。
 * 与 server 端 chat-handler.ts 的 ChannelTraceEvent 对应 —— 前后端不共享 npm 包,
 * 此处复制一份接口定义(小、稳定)。
 */
interface TraceEvent {
  kind:
    | 'tool-invocation' | 'tool-result' | 'internal-gate'
    | 'system-event' | 'auth-decision' | 'loop-control';
  text: string;
  tier: 3 | 4;
  meta?: {
    toolName?: string; success?: boolean; gateName?: string;
    severity?: string; iteration?: number;
  };
}

// marked: 保留换行作为 <br>，并把 GFM 代码块等交给 marked 默认规则
marked.setOptions({ gfm: true, breaks: true });

@customElement('agent-chat')
export class AgentChat extends LitElement {
  @state() messages: Message[] = this.loadMessages();
  @state() input = '';
  @state() connecting = true;
  // 三流分离(2026-05-19):Tier 2 进度 + Tier 3/4 debug。
  // 关键不变量:这三个 state 都**不进 messages 数组** —— 不污染气泡、不写 localStorage。
  @state() sending = false;              // turn 进行中(chat.send 已发、final 未到)→ 显示"停止"
  @state() currentStatus = '';          // Tier 2 当前进度,覆盖式,final 到达清空
  @state() traceEvents: TraceEvent[] = []; // Tier 3/4 事件,追加式,cap 200
  @state() tracePanelOpen = false;       // debug 面板折叠态

  constructor() { super(); new LangController(this); } // 语言切换时自动重渲染

  private ws?: WebSocket;
  /** 组件已卸载标志:阻止 onclose 自动重连 + resolveAgentPort 回调里再连。 */
  private closed = false;
  /** 用户手动滚上去读历史时为 false，消息到底部时恢复 true */
  private autoScroll = true;

  private loadMessages(): Message[] {
    try {
      const raw = JSON.parse(localStorage.getItem('chat_history') ?? '[]');
      if (!Array.isArray(raw)) return [];
      const now = Date.now();
      // 回填旧记录缺失的 timestamp（不再精确但排序仍保持）
      return raw.map((m: Partial<Message>, i: number) => ({
        role: m.role ?? 'assistant',
        content: m.content ?? '',
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : now - (raw.length - i) * 1000,
      })) as Message[];
    } catch {
      return [];
    }
  }

  private saveMessages() {
    localStorage.setItem('chat_history', JSON.stringify(this.messages));
  }

  connectedCallback() {
    super.connectedCallback();
    this.closed = false;
    // 先从 launcher 解析 agent 真实端口(默认 20266),再连 —— 支持自定义 PHILONT_PORT。
    // 若组件在 resolve 前已卸载,closed 阻止它再连一个无人回收的 socket。
    void resolveAgentPort().then(() => { if (!this.closed) this.connectWebSocket(); });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // 切走聊天 tab 时 Lit 会卸载本组件:关掉 ws 并阻止 onclose 自动重连,
    // 否则 socket 泄漏 + 僵尸重连循环(每次切回又新建一个)。
    this.closed = true;
    if (this.ws) {
      this.ws.onclose = null; // 防 onclose 触发重连
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = undefined;
    }
  }

  connectWebSocket() {
    if (this.closed) return;
    this.ws = new WebSocket(agentWsBase());

    this.ws.onopen = () => { this.connecting = false; };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'delta') {
        const last = this.messages[this.messages.length - 1];
        if (last?.role === 'assistant') {
          last.content += msg.text;
          this.saveMessages();
          this.requestUpdate();
        } else {
          this.messages = [...this.messages, {
            role: 'assistant',
            content: msg.text,
            timestamp: Date.now(),
          }];
          this.saveMessages();
        }
      } else if (msg.type === 'auth_request') {
        this.messages = [...this.messages, {
          role: 'assistant',
          content: `🔐 ${msg.text}`,
          timestamp: Date.now(),
        }];
        this.saveMessages();
      } else if (msg.type === 'reminder') {
        const label = msg.scheduleName ? `【${msg.scheduleName}】` : '';
        this.messages = [...this.messages, {
          role: 'assistant',
          content: `🔔 ${label} ${msg.text}`,
          timestamp: Date.now(),
        }];
        this.saveMessages();
      } else if (msg.type === 'research_grant_request') {
        // 后台研究主动申请受控工具权限。回复"同意"/"approve"即可批准(走正常对话输入)。
        const p = msg.payload ?? {};
        const ttl = p.ttlMinutes ?? 10;
        const content = t(
          `🔐 后台研究请求授权\n研究「${p.title}」需要用 \`${p.tool}\` 才能继续${p.why ? `（${p.why}）` : ''}。\n权限：execute/system · 约 ${ttl} 分钟内有效\n回复「同意」批准 / 「拒绝」拒绝。`,
          `🔐 Background research authorization\nResearch "${p.title}" needs \`${p.tool}\` to continue${p.why ? ` (${p.why})` : ''}.\nPermission: execute/system · valid ~${ttl} min\nReply "approve" to grant / "deny" to reject.`,
        );
        this.messages = [...this.messages, { role: 'assistant', content, timestamp: Date.now() }];
        this.saveMessages();
      } else if (msg.type === 'finding') {
        // 自主研究的主动发现推送(与微信/Telegram 对等)。
        this.messages = [...this.messages, {
          role: 'assistant',
          content: msg.text ?? '',
          timestamp: Date.now(),
        }];
        this.saveMessages();
      } else if (msg.type === 'milestone') {
        // deep_explore 每轮进度总结:持久气泡(onStatus 状态行 turn 结束会清空,这里改为持久消息)。
        this.messages = [...this.messages, {
          role: 'assistant',
          content: `🧩 ${msg.text ?? ''}`,
          timestamp: Date.now(),
        }];
        this.saveMessages();
      } else if (msg.type === 'status') {
        // Tier 2 进度:覆盖式 —— 只关心"现在在干啥"。final 到达时清空。
        this.currentStatus = msg.text ?? '';
      } else if (msg.type === 'trace') {
        // Tier 3/4 明细:追加式,cap 最近 200 条防无限增长。不进 messages 数组。
        if (msg.event) {
          const next = [...this.traceEvents, msg.event as TraceEvent];
          this.traceEvents = next.length > 200 ? next.slice(-200) : next;
        }
      } else if (msg.type === 'final') {
        // 后端不变量:每条 chat.send 必发一条 final。outcomeType:
        //   - 'response':正常完成,内容已通过 delta 流式给到,这里无需再渲染
        //   - 'auth_pending':等待用户授权,auth_request 已单独发,无需渲染
        //   - 'error' / 'timeout' / 'terminated':没正常完成,必须显式告诉用户
        this.currentStatus = ''; // turn 结束 → 清空进度行
        this.sending = false;     // turn 收口 → 解锁,"停止"按钮回到"发送"
        const outcome = msg.outcome ?? {};
        const outcomeType = outcome.outcomeType;
        if (outcomeType === 'error' || outcomeType === 'timeout' || outcomeType === 'terminated') {
          const icon = outcomeType === 'timeout' ? '⏱️' : '⚠️';
          const text = outcome.text || outcome.reason || t('(无详细信息)', '(no details)');
          this.messages = [...this.messages, {
            role: 'assistant',
            content: `${icon} ${text}`,
            timestamp: Date.now(),
          }];
          this.saveMessages();
        } else if (outcomeType === 'interrupted') {
          // 用户中途停止(chat.stop)。delta 可能已渲染了部分内容,这里补一行"已停止"。
          this.messages = [...this.messages, {
            role: 'assistant',
            content: `⏹️ ${outcome.text || t('已停止', 'Stopped')}`,
            timestamp: Date.now(),
          }];
          this.saveMessages();
        }
        // 'response' / 'auth_pending' 静默,前者 delta 已渲染,后者 auth_request 已渲染
      } else if (msg.type === 'error') {
        // 协议级错误(JSON 解析失败等),后端用旧 'error' channel 发的
        this.messages = [...this.messages, {
          role: 'assistant',
          content: `⚠️ ${t('服务端错误', 'Server error')}: ${msg.message ?? t('未知', 'unknown')}`,
          timestamp: Date.now(),
        }];
        this.saveMessages();
      }
    };

    this.ws.onerror = (error) => console.error('WebSocket error:', error);

    this.ws.onclose = () => {
      this.connecting = true;
      this.ws = undefined;
      this.sending = false; // 连接断了,turn 不可能再收 final → 解锁输入
      if (!this.closed) setTimeout(() => this.connectWebSocket(), 2000); // 已卸载则不重连
    };
  }

  sendMessage() {
    const text = this.input.trim();
    if (!text) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.messages = [...this.messages, {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }];
    this.saveMessages();
    this.ws.send(JSON.stringify({ type: 'chat.send', content: text }));
    this.input = '';
    this.sending = true; // turn 开始 → "发送"变"停止",直到 final 到达
  }

  /** 中途停止当前 turn(UserHardStop):发 chat.stop,server 端 abort 正在跑的 turn。 */
  stopTurn() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'chat.stop' }));
    // 不立即解锁 —— 等 server 发 final(interrupted)再 sending=false,保证状态一致。
  }

  private clearHistory() {
    if (!confirm(t('确定清空本地对话历史？', 'Clear local chat history?'))) return;
    this.messages = [];
    this.saveMessages();
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  private renderContent(m: Message) {
    if (m.role === 'user') {
      // 用户消息保持纯文本，保留换行
      return html`<span class="plain">${m.content}</span>`;
    }
    // assistant：markdown → sanitize → 注入
    const raw = marked.parse(m.content) as string;
    const clean = DOMPurify.sanitize(raw);
    return html`<div class="md">${unsafeHTML(clean)}</div>`;
  }

  // ── 滚动处理 ────────────────────────────────────────────────────────
  private onMessagesScroll(e: Event) {
    const el = e.target as HTMLElement;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    this.autoScroll = nearBottom;
  }

  updated() {
    if (!this.autoScroll) return;
    const el = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /** trace 事件按 kind 给图标(debug 面板用)。 */
  private traceKindIcon(kind: TraceEvent['kind']): string {
    switch (kind) {
      case 'tool-invocation': return '🔧';
      case 'tool-result':     return '📋';
      case 'internal-gate':   return '🛡';
      case 'system-event':    return '⚙';
      case 'auth-decision':   return '🔐';
      case 'loop-control':    return '🔁';
      default:                return '·';
    }
  }

  render() {
    return html`
      <div class="container">
        <div class="toolbar">
          <span class="status ${this.connecting ? 'off' : 'on'}">
            ${this.connecting ? t('● 连接中…', '● Connecting…') : t('● 已连接', '● Connected')}
          </span>
          <div class="spacer"></div>
          <button
            class="icon-btn small ${this.tracePanelOpen ? 'active' : ''}"
            title=${t('调试信息（工具明细 / 内部事件）', 'Debug info (tool details / internal events)')}
            @click=${() => { this.tracePanelOpen = !this.tracePanelOpen; }}
          >🐞${this.traceEvents.length > 0 ? ` ${this.traceEvents.length}` : ''}</button>
          <button class="icon-btn small" title=${t('清空本地历史', 'Clear local history')} @click=${this.clearHistory}>🗑</button>
        </div>

        <div class="messages" @scroll=${this.onMessagesScroll}>
          ${this.messages.map(m => html`
            <div class="message ${m.role}">
              <div class="meta">
                <span class="role">${m.role === 'user' ? t('你', 'You') : 'AI'}</span>
                <span class="time" title=${new Date(m.timestamp).toLocaleString()}>
                  ${this.formatTime(m.timestamp)}
                </span>
              </div>
              <div class="bubble">${this.renderContent(m)}</div>
            </div>
          `)}
        </div>

        ${this.tracePanelOpen ? html`
          <div class="trace-panel">
            <div class="trace-header">
              <span>${t('调试信息', 'Debug info')} (${this.traceEvents.length})</span>
              <button
                class="icon-btn small"
                title=${t('清空调试信息', 'Clear debug info')}
                @click=${() => { this.traceEvents = []; }}
              >${t('清空', 'Clear')}</button>
            </div>
            <div class="trace-body">
              ${this.traceEvents.length === 0
                ? html`<div class="trace-empty">${t('暂无 — 工具调用 / 内部事件会在这里显示', 'Nothing yet — tool calls / internal events will show here')}</div>`
                : this.traceEvents.map((ev) => html`
                  <div class="trace-row tier-${ev.tier}">
                    <span class="trace-icon">${this.traceKindIcon(ev.kind)}</span>
                    <span class="trace-text">${ev.text}</span>
                  </div>
                `)}
            </div>
          </div>
        ` : null}

        ${this.currentStatus ? html`
          <div class="status-line">⏳ ${this.currentStatus}</div>
        ` : null}

        <div class="input-area">
          <input
            .value=${this.input}
            @input=${(e: Event) => this.input = (e.target as HTMLInputElement).value}
            @keypress=${(e: KeyboardEvent) => e.key === 'Enter' && this.sendMessage()}
            placeholder=${t('输入消息…', 'Type a message…')}
          />
          ${this.sending
            ? html`<button class="send-btn stop-btn" @click=${this.stopTurn} ?disabled=${this.connecting} title=${t('停止当前回合', 'Stop current turn')}>⏹ ${t('停止', 'Stop')}</button>`
            : html`<button class="send-btn" @click=${this.sendMessage} ?disabled=${this.connecting}>${t('发送', 'Send')}</button>`}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      --user-bg: #0b93f6;
      --user-fg: #fff;
      --assistant-bg: #f1f3f5;
      --assistant-fg: #1a1a1a;
      --border: #e3e6ea;
      --meta: #6b7280;
      --accent: #1976d2;
    }
    .container {
      display: flex;
      flex-direction: column;
      height: 100%;
      max-width: 820px;
      margin: 0 auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", sans-serif;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      background: #fff;
      font-size: 13px;
    }
    .status { color: var(--meta); }
    .status.on { color: #16a34a; }
    .status.off { color: #dc2626; }
    .spacer { flex: 1; }
    .hint { color: var(--meta); font-size: 12px; }
    .hint.error { color: #dc2626; }
    .icon-btn {
      padding: 6px 10px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .icon-btn.small { padding: 4px 8px; font-size: 13px; }
    .icon-btn:hover { background: #f9fafb; }
    .icon-btn.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      scroll-behavior: smooth;
    }

    .message {
      display: flex;
      flex-direction: column;
      margin: 12px 0;
      max-width: 78%;
    }
    .message.user {
      align-self: flex-end;
      margin-left: auto;
      align-items: flex-end;
    }
    .message.assistant {
      align-self: flex-start;
      margin-right: auto;
      align-items: flex-start;
    }

    .meta {
      display: flex;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 11px;
      color: var(--meta);
    }
    .meta .role { font-weight: 600; }

    .bubble {
      padding: 10px 14px;
      border-radius: 14px;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .user .bubble {
      background: var(--user-bg);
      color: var(--user-fg);
      border-bottom-right-radius: 4px;
    }
    .assistant .bubble {
      background: var(--assistant-bg);
      color: var(--assistant-fg);
      border-bottom-left-radius: 4px;
    }
    .plain { white-space: pre-wrap; }

    /* Markdown 渲染内部元素 */
    .md { font-size: 14px; }
    .md p { margin: 0.4em 0; }
    .md p:first-child { margin-top: 0; }
    .md p:last-child { margin-bottom: 0; }
    .md h1, .md h2, .md h3, .md h4 {
      margin: 0.8em 0 0.3em;
      line-height: 1.25;
    }
    .md h1 { font-size: 1.3em; }
    .md h2 { font-size: 1.2em; }
    .md h3 { font-size: 1.1em; }
    .md ul, .md ol { padding-left: 1.4em; margin: 0.4em 0; }
    .md li { margin: 0.2em 0; }
    .md code {
      background: rgba(0, 0, 0, 0.06);
      padding: 1px 5px;
      border-radius: 4px;
      font-family: "SF Mono", "Fira Code", Consolas, monospace;
      font-size: 0.92em;
    }
    .md pre {
      background: #1e1e2e;
      color: #e4e4e7;
      padding: 10px 12px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 0.5em 0;
    }
    .md pre code {
      background: transparent;
      color: inherit;
      padding: 0;
      font-size: 0.9em;
    }
    .md blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 10px;
      margin: 0.4em 0;
      color: var(--meta);
    }
    .md table {
      border-collapse: collapse;
      margin: 0.5em 0;
      font-size: 0.9em;
    }
    .md th, .md td {
      border: 1px solid var(--border);
      padding: 4px 8px;
    }
    .md th { background: rgba(0, 0, 0, 0.04); }
    .md a { color: var(--accent); text-decoration: none; }
    .md a:hover { text-decoration: underline; }

    /* 三流分离(2026-05-19):Tier 2 进度行 + Tier 3/4 debug 面板 */
    .icon-btn.small.active {
      background: rgba(25, 118, 210, 0.12);
      border-radius: 4px;
    }
    .status-line {
      padding: 6px 16px;
      font-size: 13px;
      color: var(--accent);
      border-top: 1px solid var(--border);
      background: #fbfcfd;
    }
    .trace-panel {
      border-top: 1px solid var(--border);
      background: #fafbfc;
      max-height: 220px;
      overflow-y: auto;
      font-size: 12px;
    }
    .trace-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 12px;
      color: var(--meta);
      position: sticky;
      top: 0;
      background: #fafbfc;
      border-bottom: 1px solid var(--border);
    }
    .trace-body { padding: 4px 12px 8px; }
    .trace-row {
      display: flex;
      gap: 6px;
      padding: 2px 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1.5;
    }
    .trace-row.tier-4 { opacity: 0.6; }
    .trace-icon { flex-shrink: 0; }
    .trace-text { word-break: break-word; }
    .trace-empty { color: var(--meta); padding: 4px 0; }

    .input-area {
      display: flex;
      padding: 12px 16px;
      gap: 8px;
      border-top: 1px solid var(--border);
      background: #fff;
      align-items: center;
    }
    input {
      flex: 1;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: var(--accent); }

    .send-btn {
      padding: 10px 20px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      flex-shrink: 0;
    }
    .send-btn:disabled { background: #9ca3af; cursor: not-allowed; }
    .send-btn.stop-btn { background: #dc2626; } /* 停止按钮红色,与发送区分 */
  `;
}
