import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { agentHttpBase, resolveAgentPort } from './config.js';
import { LangController, t } from './i18n.js';

const API_BASE = () => `${agentHttpBase()}/api/memory`;

interface Stats {
  facts: number;
  skills: number;
  notes: number;
  actions: number;
  calendar: number;
  schedules: number;
  namespaces: string[];
}

interface Fact {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  confidence: number;
  createdAt: number;
  occurredAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  lastAccessedAt: number | null;
  decayTauDays: number | null;
  forgottenAt: number | null;
  factKind: 'state' | 'event';
}

interface OccurrenceEvent {
  id: string;
  title: string;
  occurrenceStartsAt: number;
  occurrenceEndsAt: number | null;
  rrule: string | null;
  timezone: string;
  relatedFactId: string | null;
}

interface Schedule {
  id: string;
  name: string;
  cronExpr: string | null;
  nextRunAt: number;
  lastRunAt: number | null;
  actionType: 'prompt' | 'tool_call' | 'reflect';
  payload: unknown;
  enabled: boolean;
}

interface ForgetCandidate {
  fact: Fact;
  score: number;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  actionTemplate: string;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

interface Note {
  id: string;
  content: string;
  importance: number;
  sessionId: string | null;
  createdAt: number;
}

interface Session {
  id: string;
  startedAt: number;
  endedAt: number | null;
}

type Tab = 'facts' | 'skills' | 'notes' | 'sessions' | 'calendar' | 'forget';

@customElement('memory-dashboard')
export class MemoryDashboard extends LitElement {
  constructor() { super(); new LangController(this); } // 语言切换时自动重渲染
  @state() activeTab: Tab = 'facts';
  @state() stats: Stats | null = null;
  @state() factsByNamespace: Record<string, Fact[]> = {};
  @state() skills: Skill[] = [];
  @state() notes: Note[] = [];
  @state() sessions: Session[] = [];
  @state() calendarEvents: OccurrenceEvent[] = [];
  @state() schedules: Schedule[] = [];
  @state() forgetCandidates: ForgetCandidate[] = [];
  @state() calendarDays = 7;
  @state() searchQuery = '';
  @state() searchResults: Note[] = [];
  @state() selectedSkill: Skill | null = null;
  @state() loading = false;
  @state() error: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  async refresh() {
    this.loading = true;
    this.error = null;
    try {
      await resolveAgentPort(); // 确保拿到正确 agent 端口再请求
      await Promise.all([
        this.loadStats(),
        this.loadFacts(),
        this.loadSkills(),
        this.loadNotes(),
        this.loadSessions(),
        this.loadCalendar(),
        this.loadSchedules(),
        this.loadForgetCandidates(),
      ]);
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadStats() {
    const r = await fetch(`${API_BASE()}/stats`);
    this.stats = await r.json();
  }

  async loadFacts() {
    const r = await fetch(`${API_BASE()}/facts`);
    const data = await r.json();
    this.factsByNamespace = data.grouped ?? {};
  }

  async loadSkills() {
    const r = await fetch(`${API_BASE()}/skills`);
    const data = await r.json();
    this.skills = data.skills ?? [];
  }

  async loadNotes() {
    const r = await fetch(`${API_BASE()}/notes`);
    const data = await r.json();
    this.notes = data.notes ?? [];
  }

  async loadSessions() {
    const r = await fetch(`${API_BASE()}/sessions`);
    const data = await r.json();
    this.sessions = data.sessions ?? [];
  }

  async loadCalendar() {
    const r = await fetch(`${API_BASE()}/calendar?days=${this.calendarDays}`);
    const data = await r.json();
    this.calendarEvents = data.events ?? [];
  }

  async loadSchedules() {
    const r = await fetch(`${API_BASE()}/schedules`);
    const data = await r.json();
    this.schedules = data.schedules ?? [];
  }

  async loadForgetCandidates() {
    const r = await fetch(`${API_BASE()}/forget-candidates`);
    const data = await r.json();
    this.forgetCandidates = data.candidates ?? [];
  }

  async factAction(id: string, action: 'pin' | 'unpin' | 'forget' | 'unforget') {
    await fetch(`${API_BASE()}/facts/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
    });
    await Promise.all([
      this.loadFacts(),
      this.loadForgetCandidates(),
      this.loadStats(),
    ]);
  }

  async toggleSchedule(id: string, enabled: boolean) {
    await fetch(`${API_BASE()}/schedules/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    await this.loadSchedules();
  }

  async deleteSchedule(id: string) {
    if (!confirm(t(`确定删除任务 "${id}" 吗？`, `Delete task "${id}"?`))) return;
    await fetch(`${API_BASE()}/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await Promise.all([this.loadSchedules(), this.loadStats()]);
  }

  async searchNotes() {
    if (!this.searchQuery.trim()) {
      this.searchResults = [];
      return;
    }
    const r = await fetch(
      `${API_BASE()}/notes/search?q=${encodeURIComponent(this.searchQuery)}`,
    );
    const data = await r.json();
    this.searchResults = data.results ?? [];
  }

  async deleteSkill(name: string) {
    if (!confirm(t(`确定删除技能 "${name}" 吗？`, `Delete skill "${name}"?`))) return;
    await fetch(`${API_BASE()}/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    await this.loadSkills();
    await this.loadStats();
    this.selectedSkill = null;
  }

  formatTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  formatValue(v: unknown): string {
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  }

  renderStats() {
    if (!this.stats) return null;
    return html`
      <div class="stats">
        <div class="stat-card">
          <div class="stat-num">${this.stats.facts}</div>
          <div class="stat-label">${t('事实', 'Facts')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${this.stats.skills}</div>
          <div class="stat-label">${t('技能', 'Skills')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${this.stats.notes}</div>
          <div class="stat-label">${t('笔记', 'Notes')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${this.stats.actions}</div>
          <div class="stat-label">${t('动作日志', 'Action Log')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${this.stats.calendar ?? 0}</div>
          <div class="stat-label">${t('日历事件', 'Calendar Events')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${this.stats.schedules ?? 0}</div>
          <div class="stat-label">${t('定时任务', 'Scheduled Tasks')}</div>
        </div>
      </div>
    `;
  }

  renderFacts() {
    const namespaces = Object.keys(this.factsByNamespace);
    if (namespaces.length === 0) {
      return html`<div class="empty">${t('还没有结构化事实', 'No structured facts yet')}</div>`;
    }
    return html`
      ${namespaces.map(
        (ns) => html`
          <div class="ns-section">
            <h3>${ns}.*</h3>
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Kind</th>
                  <th>${t('有效期', 'Validity')}</th>
                  <th>${t('状态', 'Status')}</th>
                  <th>${t('操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                ${this.factsByNamespace[ns].map((f) => {
                  const pinned = f.decayTauDays !== null && f.decayTauDays < 0;
                  const validity =
                    f.factKind === 'event'
                      ? f.occurredAt
                        ? this.formatTime(f.occurredAt)
                        : '—'
                      : [
                          f.validFrom ? this.formatTime(f.validFrom) : '…',
                          f.validUntil ? this.formatTime(f.validUntil) : t('永久', 'Forever'),
                        ].join(' → ');
                  return html`
                    <tr class=${pinned ? 'pinned' : ''}>
                      <td><code>${f.key}</code></td>
                      <td>${this.formatValue(f.value)}</td>
                      <td>${f.factKind}</td>
                      <td class="meta-cell">${validity}</td>
                      <td>
                        ${pinned ? html`<span class="badge pinned">📌 pin</span>` : ''}
                        ${f.confidence < 1.0
                          ? html`<span class="badge">c=${f.confidence.toFixed(2)}</span>`
                          : ''}
                      </td>
                      <td class="actions">
                        ${pinned
                          ? html`<button @click=${() => this.factAction(f.id, 'unpin')}>${t('取消 pin', 'Unpin')}</button>`
                          : html`<button @click=${() => this.factAction(f.id, 'pin')}>pin</button>`}
                        <button class="danger-small" @click=${() => this.factAction(f.id, 'forget')}>
                          ${t('遗忘', 'Forget')}
                        </button>
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          </div>
        `,
      )}
    `;
  }

  renderCalendar() {
    const pending = this.schedules.filter((s) => s.enabled);
    return html`
      <div class="cal-controls">
        <label>
          ${t('未来窗口(天):', 'Window (days):')}
          <input
            type="number"
            min="1"
            max="90"
            .value=${String(this.calendarDays)}
            @change=${async (e: Event) => {
              this.calendarDays = Number((e.target as HTMLInputElement).value) || 7;
              await this.loadCalendar();
            }}
          />
        </label>
      </div>
      <h3>${t('日历事件', 'Calendar Events')} (${this.calendarEvents.length})</h3>
      ${this.calendarEvents.length === 0
        ? html`<div class="empty">${t('窗口内无日历事件', 'No calendar events in window')}</div>`
        : html`
            <table>
              <thead>
                <tr><th>${t('时间', 'Time')}</th><th>${t('标题', 'Title')}</th><th>${t('时区', 'Timezone')}</th><th>${t('重复', 'Repeat')}</th></tr>
              </thead>
              <tbody>
                ${this.calendarEvents.map(
                  (e) => html`
                    <tr>
                      <td>${this.formatTime(e.occurrenceStartsAt)}</td>
                      <td>${e.title}</td>
                      <td>${e.timezone}</td>
                      <td>${e.rrule ?? t('一次性', 'One-time')}</td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          `}
      <h3 style="margin-top: 24px;">${t('定时任务', 'Scheduled Tasks')} (${t(`${pending.length} 启用 / ${this.schedules.length} 总`, `${pending.length} enabled / ${this.schedules.length} total`)})</h3>
      ${this.schedules.length === 0
        ? html`<div class="empty">${t('没有定时任务', 'No scheduled tasks')}</div>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>${t('名称', 'Name')}</th><th>${t('下次运行', 'Next Run')}</th><th>${t('类型', 'Type')}</th><th>Cron</th>
                  <th>${t('状态', 'Status')}</th><th>${t('操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                ${this.schedules.map(
                  (s) => html`
                    <tr class=${s.enabled ? '' : 'disabled'}>
                      <td>${s.name}</td>
                      <td>${this.formatTime(s.nextRunAt)}</td>
                      <td>${s.actionType}</td>
                      <td><code>${s.cronExpr ?? t('一次性', 'One-time')}</code></td>
                      <td>${s.enabled ? t('✓ 启用', '✓ Enabled') : t('⏸ 禁用', '⏸ Disabled')}</td>
                      <td class="actions">
                        <button @click=${() => this.toggleSchedule(s.id, !s.enabled)}>
                          ${s.enabled ? t('禁用', 'Disable') : t('启用', 'Enable')}
                        </button>
                        <button class="danger-small" @click=${() => this.deleteSchedule(s.id)}>
                          ${t('删除', 'Delete')}
                        </button>
                      </td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          `}
    `;
  }

  renderForget() {
    if (this.forgetCandidates.length === 0) {
      return html`<div class="empty">${t('没有低分候选 — 记忆层很健康 👍', 'No low-score candidates — memory is healthy 👍')}</div>`;
    }
    return html`
      <div class="forget-hint">
        ${t(
          '下列事实按综合分数(confidence × exp(-age/τ))落在遗忘阈值以下。可勾选"遗忘"软删除(30 天内可撤销),或 pin 防止再次被识别为候选。',
          'These facts fall below the forget threshold by combined score (confidence × exp(-age/τ)). You can "Forget" to soft-delete (reversible within 30 days), or pin to keep them from being flagged again.',
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>${t('分数', 'Score')}</th><th>Namespace</th><th>Key</th><th>Value</th>
            <th>${t('最近访问', 'Last Accessed')}</th><th>${t('操作', 'Actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${this.forgetCandidates.map(
            (c) => html`
              <tr>
                <td><strong>${c.score.toFixed(4)}</strong></td>
                <td>${c.fact.namespace}</td>
                <td><code>${c.fact.key}</code></td>
                <td>${this.formatValue(c.fact.value)}</td>
                <td class="meta-cell">
                  ${c.fact.lastAccessedAt ? this.formatTime(c.fact.lastAccessedAt) : t('从未', 'Never')}
                </td>
                <td class="actions">
                  <button @click=${() => this.factAction(c.fact.id, 'pin')}>📌 pin</button>
                  <button class="danger-small" @click=${() => this.factAction(c.fact.id, 'forget')}>
                    ${t('遗忘', 'Forget')}
                  </button>
                </td>
              </tr>
            `
          )}
        </tbody>
      </table>
    `;
  }

  renderSkills() {
    if (this.skills.length === 0) {
      return html`<div class="empty">${t('还没有提炼出任何技能', 'No skills distilled yet')}</div>`;
    }
    return html`
      <div class="skill-grid">
        ${this.skills.map(
          (s) => html`
            <div
              class="skill-card ${this.selectedSkill?.id === s.id ? 'selected' : ''}"
              @click=${() => (this.selectedSkill = s)}
            >
              <div class="skill-header">
                <strong>${s.name}</strong>
                <span class="badge">${t(`用过 ${s.useCount} 次`, `Used ${s.useCount}×`)}</span>
              </div>
              <div class="skill-desc">${s.description}</div>
              <div class="skill-keywords">
                ${s.triggerKeywords.map((k) => html`<span class="kw">${k}</span>`)}
              </div>
            </div>
          `,
        )}
      </div>
      ${this.selectedSkill
        ? html`
            <div class="skill-detail">
              <div class="skill-detail-header">
                <h3>${this.selectedSkill.name}</h3>
                <button class="danger" @click=${() => this.deleteSkill(this.selectedSkill!.name)}>
                  ${t('删除', 'Delete')}
                </button>
              </div>
              <pre>${this.selectedSkill.actionTemplate}</pre>
              <div class="meta">
                ${t('创建于', 'Created')} ${this.formatTime(this.selectedSkill.createdAt)}
                ${this.selectedSkill.lastUsedAt
                  ? ` · ${t('最近使用', 'Last used')} ${this.formatTime(this.selectedSkill.lastUsedAt)}`
                  : ''}
              </div>
            </div>
          `
        : null}
    `;
  }

  renderNotes() {
    return html`
      <div class="search-bar">
        <input
          .value=${this.searchQuery}
          placeholder=${t('搜索笔记...', 'Search notes...')}
          @input=${(e: Event) => (this.searchQuery = (e.target as HTMLInputElement).value)}
          @keypress=${(e: KeyboardEvent) => e.key === 'Enter' && this.searchNotes()}
        />
        <button @click=${this.searchNotes}>${t('搜索', 'Search')}</button>
      </div>
      ${this.searchResults.length > 0
        ? html`
            <div class="search-results">
              <h3>${t('搜索结果', 'Search Results')}（${this.searchResults.length}）</h3>
              ${this.searchResults.map(
                (n) => html`
                  <div class="note">
                    <div class="note-content">${n.content}</div>
                    <div class="meta">
                      importance ${n.importance.toFixed(2)} ·
                      ${this.formatTime(n.createdAt)}
                    </div>
                  </div>
                `,
              )}
            </div>
          `
        : null}
      <h3>${t('最近笔记（按重要性）', 'Recent Notes (by importance)')}</h3>
      ${this.notes.length === 0
        ? html`<div class="empty">${t('还没有笔记', 'No notes yet')}</div>`
        : this.notes.map(
            (n) => html`
              <div class="note">
                <div class="note-content">${n.content}</div>
                <div class="meta">
                  importance ${n.importance.toFixed(2)} ·
                  ${this.formatTime(n.createdAt)}
                </div>
              </div>
            `,
          )}
    `;
  }

  renderSessions() {
    if (this.sessions.length === 0) {
      return html`<div class="empty">${t('还没有会话历史', 'No session history yet')}</div>`;
    }
    return html`
      <table>
        <thead>
          <tr>
            <th>Session ID</th>
            <th>${t('开始', 'Started')}</th>
            <th>${t('结束', 'Ended')}</th>
            <th>${t('状态', 'Status')}</th>
          </tr>
        </thead>
        <tbody>
          ${this.sessions.map(
            (s) => html`
              <tr>
                <td><code>${s.id.slice(0, 8)}...</code></td>
                <td>${this.formatTime(s.startedAt)}</td>
                <td>${s.endedAt ? this.formatTime(s.endedAt) : '—'}</td>
                <td>${s.endedAt ? t('✓ 已结束', '✓ Ended') : t('⚙ 进行中', '⚙ Active')}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  render() {
    return html`
      <div class="container">
        <header>
          <h1>${t('记忆 Dashboard', 'Memory Dashboard')}</h1>
          <button @click=${this.refresh}>${t('刷新', 'Refresh')}</button>
        </header>
        ${this.error ? html`<div class="error">${this.error}</div>` : null}
        ${this.renderStats()}
        <nav class="tabs">
          <button
            class=${this.activeTab === 'facts' ? 'active' : ''}
            @click=${() => (this.activeTab = 'facts')}
          >
            ${t('事实', 'Facts')} (${this.stats?.facts ?? 0})
          </button>
          <button
            class=${this.activeTab === 'skills' ? 'active' : ''}
            @click=${() => (this.activeTab = 'skills')}
          >
            ${t('技能', 'Skills')} (${this.stats?.skills ?? 0})
          </button>
          <button
            class=${this.activeTab === 'notes' ? 'active' : ''}
            @click=${() => (this.activeTab = 'notes')}
          >
            ${t('笔记', 'Notes')} (${this.stats?.notes ?? 0})
          </button>
          <button
            class=${this.activeTab === 'calendar' ? 'active' : ''}
            @click=${() => (this.activeTab = 'calendar')}
          >
            ${t('日程', 'Calendar')} (${(this.stats?.calendar ?? 0) + (this.stats?.schedules ?? 0)})
          </button>
          <button
            class=${this.activeTab === 'forget' ? 'active' : ''}
            @click=${() => (this.activeTab = 'forget')}
          >
            ${t('遗忘池', 'Forget Pool')} (${this.forgetCandidates.length})
          </button>
          <button
            class=${this.activeTab === 'sessions' ? 'active' : ''}
            @click=${() => (this.activeTab = 'sessions')}
          >
            ${t('会话', 'Sessions')}
          </button>
        </nav>
        <div class="content">
          ${this.loading ? html`<div class="loading">${t('加载中...', 'Loading...')}</div>` : null}
          ${this.activeTab === 'facts' ? this.renderFacts() : null}
          ${this.activeTab === 'skills' ? this.renderSkills() : null}
          ${this.activeTab === 'notes' ? this.renderNotes() : null}
          ${this.activeTab === 'calendar' ? this.renderCalendar() : null}
          ${this.activeTab === 'forget' ? this.renderForget() : null}
          ${this.activeTab === 'sessions' ? this.renderSessions() : null}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      font-family: system-ui, -apple-system, sans-serif;
      color: #1a1a1a;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      padding: 20px;
      background: #f5f7fa;
      border-radius: 8px;
      text-align: center;
    }
    .stat-num {
      font-size: 32px;
      font-weight: bold;
      color: #1976d2;
    }
    .stat-label {
      font-size: 14px;
      color: #666;
      margin-top: 4px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      border-bottom: 2px solid #eee;
      margin-bottom: 24px;
    }
    .tabs button {
      padding: 12px 20px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      cursor: pointer;
      font-size: 14px;
    }
    .tabs button.active {
      color: #1976d2;
      border-bottom-color: #1976d2;
      font-weight: 600;
    }
    .content {
      min-height: 400px;
    }
    .loading,
    .empty {
      text-align: center;
      padding: 40px;
      color: #999;
    }
    .error {
      background: #ffebee;
      color: #c62828;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 16px;
    }
    .ns-section {
      margin-bottom: 32px;
    }
    .ns-section h3 {
      color: #1976d2;
      font-family: monospace;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid #eee;
    }
    th {
      background: #f5f7fa;
      font-weight: 600;
      font-size: 13px;
    }
    code {
      font-family: 'SF Mono', Monaco, monospace;
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 13px;
    }
    .skill-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .skill-card {
      padding: 16px;
      background: #f5f7fa;
      border: 2px solid transparent;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .skill-card:hover {
      background: #e3f2fd;
    }
    .skill-card.selected {
      border-color: #1976d2;
      background: #e3f2fd;
    }
    .skill-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .badge {
      font-size: 11px;
      background: #1976d2;
      color: white;
      padding: 2px 8px;
      border-radius: 10px;
    }
    .skill-desc {
      font-size: 13px;
      color: #555;
      margin-bottom: 8px;
    }
    .skill-keywords {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .kw {
      font-size: 11px;
      background: #fff;
      border: 1px solid #ddd;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .skill-detail {
      background: white;
      border: 1px solid #1976d2;
      border-radius: 8px;
      padding: 24px;
      margin-top: 16px;
    }
    .skill-detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .skill-detail h3 {
      margin: 0 0 8px 0;
    }
    .skill-detail pre {
      background: #f5f7fa;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 13px;
    }
    .meta {
      font-size: 12px;
      color: #888;
      margin-top: 8px;
    }
    button {
      padding: 8px 16px;
      background: #1976d2;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    button.danger {
      background: #d32f2f;
    }
    button:hover {
      opacity: 0.9;
    }
    .search-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .search-bar input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    .note {
      padding: 12px 16px;
      background: #f5f7fa;
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .note-content {
      font-size: 13px;
      line-height: 1.5;
    }
    .search-results {
      background: #fff8e1;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 24px;
    }
    .search-results h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
    }

    /* Phase 7: pin / forget / calendar / schedules */
    tr.pinned {
      background: #fff9e6;
    }
    tr.disabled {
      opacity: 0.5;
    }
    td.actions {
      white-space: nowrap;
    }
    td.actions button {
      padding: 4px 8px;
      font-size: 12px;
      margin-right: 4px;
      cursor: pointer;
      border: 1px solid #ccc;
      background: #fff;
      border-radius: 4px;
    }
    td.actions button:hover {
      background: #f0f0f0;
    }
    .danger-small {
      color: #c62828;
      border-color: #ef9a9a !important;
    }
    .danger-small:hover {
      background: #ffebee !important;
    }
    td.meta-cell {
      font-size: 12px;
      color: #666;
    }
    .badge.pinned {
      background: #ffe082;
      color: #795548;
    }
    .cal-controls {
      margin-bottom: 16px;
    }
    .cal-controls input {
      width: 60px;
      padding: 4px 8px;
      margin-left: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    .forget-hint {
      padding: 12px 16px;
      background: #fff3e0;
      border-left: 4px solid #ff9800;
      margin-bottom: 16px;
      font-size: 13px;
      line-height: 1.5;
    }
  `;
}
