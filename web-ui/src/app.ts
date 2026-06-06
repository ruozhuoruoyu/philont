/**
 * 顶层应用:在 Chat / Memory / Autonomous / Settings 之间切换。
 *
 * 首次运行:启动时问 launcher 是否已配置(有 ANTHROPIC_API_KEY)。未配置 → 强制进入
 * 设置向导(隐藏导航),填完保存并启动后切回聊天。
 * 顶栏常驻一个 agent 状态灯(轮询 launcher /status),含一键重启。
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import './chat.js';
import './memory.js';
import './autonomous.js';
import './settings.js';
import { LAUNCHER_BASE, resolveAgentPort, agentHttpBase } from './config.js';
import { LangController, t, getLang, toggleLang } from './i18n.js';

type View = 'chat' | 'memory' | 'autonomous' | 'settings';

@customElement('agent-app')
export class AgentApp extends LitElement {
  constructor() { super(); new LangController(this); } // 语言切换时自动重渲染
  @state() view: View = 'chat';
  @state() needsSetup = false;       // 未配置 → 强制向导
  @state() bootChecked = false;      // 启动检查是否完成(避免闪聊天再跳向导)
  @state() agentState = 'unknown';
  @state() launcherUp = false;       // launcher 是否可达(直跑 agent 时不可达,隐藏控制)
  @state() estopEngaged = false;     // 全局急停是否生效(autonomous 暂停中)
  @state() estopBusy = false;

  private pollTimer?: number;

  connectedCallback(): void {
    super.connectedCallback();
    void resolveAgentPort();          // 让 chat/memory/autonomous 拿到正确 agent 端口
    void this.boot();
    this.pollTimer = window.setInterval(() => void this.pollStatus(), 4000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async boot(): Promise<void> {
    try {
      const r = await fetch(`${LAUNCHER_BASE}/api/launcher/status`);
      const st = await r.json();
      this.launcherUp = true;
      this.agentState = st.state ?? 'unknown';
      if (!st.configured) {
        this.needsSetup = true;
        this.view = 'settings';
      }
    } catch {
      // launcher 不可达:多半是 dev 直跑 agent(无 launcher)。退化为纯聊天,不挡路。
      this.launcherUp = false;
    } finally {
      this.bootChecked = true;
    }
  }

  private async pollStatus(): Promise<void> {
    if (this.launcherUp) {
      try {
        const r = await fetch(`${LAUNCHER_BASE}/api/launcher/status`);
        const st = await r.json();
        this.agentState = st.state ?? 'unknown';
      } catch { /* 忽略瞬断 */ }
    }
    // 急停态直连 agent 查(独立于 launcher,dev 直跑也能用)。先确保端口已解析,
    // 否则自定义 PHILONT_PORT 下首拍会打到默认 20266 → 急停灯短暂读错。
    try {
      await resolveAgentPort();
      const r = await fetch(`${agentHttpBase()}/api/control/estop`);
      const j = await r.json();
      this.estopEngaged = !!j.engaged;
    } catch { /* agent 不可达 → 维持上次态 */ }
  }

  private async restart(): Promise<void> {
    try { await fetch(`${LAUNCHER_BASE}/api/launcher/restart`, { method: 'POST' }); } catch { /* ignore */ }
    void this.pollStatus();
  }

  /** 全局急停 / 恢复:停掉一切(所有 turn + autonomous)或解除。 */
  private async toggleEstop(): Promise<void> {
    this.estopBusy = true;
    const action = this.estopEngaged ? 'resume' : 'estop';
    try {
      const r = await fetch(`${agentHttpBase()}/api/control/${action}`, { method: 'POST' });
      const j = await r.json();
      this.estopEngaged = !!j.engaged;
    } catch { /* 失败维持原态 */ } finally {
      this.estopBusy = false;
    }
  }

  private onConfigured(): void {
    this.needsSetup = false;
    this.view = 'chat';
    void this.pollStatus();
  }

  private agentBadge() {
    const map: Record<string, [string, string]> = {
      running: [t('运行中', 'running'), 'ok'], stopped: [t('已停止', 'stopped'), 'off'],
      starting: [t('启动中', 'starting'), 'warn'], stopping: [t('停止中', 'stopping'), 'warn'],
      crashed: [t('已崩溃', 'crashed'), 'err'], unknown: ['—', 'off'],
    };
    const [text, cls] = map[this.agentState] ?? map.unknown;
    return html`<span class="agent-pill ${cls}" title=${t('agent 运行态', 'agent status')}>● ${text}</span>`;
  }

  /** 中/英切换按钮:显示「将切到的」目标语言。 */
  private langToggle() {
    return html`<button class="lang" @click=${() => toggleLang()}
      title=${t('切换语言', 'Switch language')}>${getLang() === 'zh' ? 'EN' : '中'}</button>`;
  }

  render() {
    // 启动检查未完成:留白,避免先闪聊天再跳向导
    if (!this.bootChecked) return html`<div class="app"></div>`;

    // 向导:占满,无导航
    if (this.needsSetup) {
      return html`
        <div class="app">
          <nav class="topbar">
            <div class="brand">PHILONT</div>
            <div class="right-ctl">${this.langToggle()}</div>
          </nav>
          <main>
            <settings-view wizard @configured=${this.onConfigured}></settings-view>
          </main>
        </div>`;
    }

    return html`
      <div class="app">
        <nav class="topbar">
          <div class="brand">PHILONT</div>
          <div class="nav-buttons">
            <button class=${this.view === 'chat' ? 'active' : ''} @click=${() => (this.view = 'chat')}>💬 ${t('聊天', 'Chat')}</button>
            <button class=${this.view === 'memory' ? 'active' : ''} @click=${() => (this.view = 'memory')}>🧠 ${t('记忆', 'Memory')}</button>
            <button class=${this.view === 'autonomous' ? 'active' : ''} @click=${() => (this.view = 'autonomous')}>⚙️ ${t('自主', 'Autonomy')}</button>
            <button class=${this.view === 'settings' ? 'active' : ''} @click=${() => (this.view = 'settings')}>⚙ ${t('设置', 'Settings')}</button>
          </div>
          <div class="right-ctl">
            ${this.langToggle()}
            ${this.launcherUp ? html`
              ${this.agentBadge()}
              <button class="restart" @click=${this.restart} title="重启 agent">↻</button>
            ` : null}
            <button
              class="estop ${this.estopEngaged ? 'engaged' : ''}"
              @click=${this.toggleEstop}
              ?disabled=${this.estopBusy}
              title=${this.estopEngaged
                ? t('点击恢复:解除急停,autonomous 重新运行', 'Click to resume: release e-stop, autonomous runs again')
                : t('全局急停:中止所有进行中的任务 + 暂停 autonomous', 'Global e-stop: abort all running tasks + pause autonomous')}
            >${this.estopEngaged ? t('▶ 恢复', '▶ Resume') : t('■ 急停', '■ E-stop')}</button>
          </div>
        </nav>
        <main>
          ${this.view === 'chat' ? html`<agent-chat></agent-chat>`
            : this.view === 'memory' ? html`<memory-dashboard></memory-dashboard>`
            : this.view === 'autonomous' ? html`<autonomous-dashboard></autonomous-dashboard>`
            : html`<settings-view @configured=${this.onConfigured}></settings-view>`}
        </main>
      </div>`;
  }

  static styles = css`
    :host { display: block; min-height: 100vh; background: #fafafa; }
    .app { display: flex; flex-direction: column; min-height: 100vh; }
    .topbar {
      display: flex; align-items: center; gap: 16px;
      padding: 12px 24px; background: white; border-bottom: 1px solid #e5e5e5;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    }
    .brand { font-size: 18px; font-weight: 700; color: #1976d2; letter-spacing: 0.5px; }
    .nav-buttons { display: flex; gap: 8px; }
    .nav-buttons button {
      padding: 8px 16px; background: transparent; border: 1px solid #ddd; border-radius: 6px;
      cursor: pointer; font-size: 14px; color: #555;
    }
    .nav-buttons button.active { background: #1976d2; color: white; border-color: #1976d2; }
    .nav-buttons button:hover:not(.active) { background: #f5f5f5; }
    .right-ctl { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .agent-pill { font-size: 12px; padding: 3px 10px; border-radius: 12px; background: #f3f4f6; }
    .agent-pill.ok { color: #16a34a; } .agent-pill.off { color: #6b7280; }
    .agent-pill.warn { color: #d97706; } .agent-pill.err { color: #dc2626; background: #fef2f2; }
    .restart {
      width: 28px; height: 28px; border: 1px solid #ddd; border-radius: 6px; background: #fff;
      cursor: pointer; font-size: 14px; color: #555;
    }
    .restart:hover { background: #f5f5f5; }
    .lang {
      min-width: 32px; height: 28px; padding: 0 8px; border: 1px solid #ddd; border-radius: 6px;
      background: #fff; cursor: pointer; font-size: 13px; font-weight: 600; color: #555;
    }
    .lang:hover { background: #f5f5f5; }
    /* 全局急停:常驻红按钮;生效时转琥珀"恢复" */
    .estop {
      padding: 6px 14px; border-radius: 6px; border: 1px solid #dc2626; background: #dc2626;
      color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
    }
    .estop:hover:not(:disabled) { background: #b91c1c; }
    .estop:disabled { opacity: 0.6; cursor: not-allowed; }
    .estop.engaged { background: #d97706; border-color: #d97706; }
    .estop.engaged:hover:not(:disabled) { background: #b45309; }
    main { flex: 1; }
  `;
}
