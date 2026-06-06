/**
 * Autonomous dashboard — 主动性层观测面板。
 *
 * 4 区块:
 *   1. Overview:今日预算 / 各 status 计数 / 全局 push 状态
 *   2. Initiatives:最近 30 条,可按 status / driver 过滤
 *   3. Failure signatures:近 24h 同根因失败聚类(谁反复撞同一面墙)
 *   4. Push subscriptions:活跃订阅 + 最近 digest/urgent 时间
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { agentHttpBase, resolveAgentPort } from './config.js';
import { LangController, t } from './i18n.js';

const API_BASE = () => `${agentHttpBase()}/api/autonomous`;

interface BudgetCaps {
  dailyTokens: number;
  dailyToolCalls: number;
  perTickTokens: number;
  perTickInitiatives: number;
  perInitiativeTokens: number;
}

interface DailyUsage {
  llmTokensUsed: number;
  toolCallsUsed: number;
  initiativesRun: number;
}

interface Overview {
  today: string;
  userId: string;
  budget: { caps: BudgetCaps; dailyUsage: DailyUsage };
  initiatives: {
    total: number;
    byStatus: Record<'pending' | 'running' | 'done' | 'failed' | 'skipped', number>;
  };
  drivers: string[];
  pushChannels: string[];
  pushSubscriptionsActive: number;
  pushSubscriptionsTotal: number;
  pushGloballyEnabled: boolean;
}

interface Initiative {
  id: string;
  kind: string;
  driver: string;
  targetRef: string;
  rationale: string;
  utility: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  budgetEstimate: number;
  budgetActual: number | null;
  outcomeSummary: string | null;
  outcomeRefs: { facts: string[]; notes: string[]; pursuits: string[] } | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface FailureGroup {
  signature: string;
  count: number;
  toolName: string;
  latestTs: number | null;
}

interface FailureResponse {
  sinceH: number;
  totalFailures: number;
  groups: FailureGroup[];
}

interface PushSubscription {
  channel: string;
  peer: string;
  enabled: boolean;
  quietStartHour: number | null;
  quietEndHour: number | null;
  timezone: string | null;
  digestMinIntervalMs: number;
  urgentMinIntervalMs: number;
  lastDigestAt: number | null;
  lastUrgentAt: number | null;
  createdAt: number;
}

@customElement('autonomous-dashboard')
export class AutonomousDashboard extends LitElement {
  @state() overview: Overview | null = null;
  @state() initiatives: Initiative[] = [];
  @state() failures: FailureResponse | null = null;
  @state() subscriptions: PushSubscription[] = [];
  @state() statusFilter: '' | Initiative['status'] = '';
  @state() driverFilter: string = '';
  @state() expanded = new Set<string>();
  @state() loading = false;
  @state() error: string | null = null;
  constructor() { super(); new LangController(this); } // 语言切换时自动重渲染
  private timer: ReturnType<typeof setInterval> | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    // 30s 自刷新
    this.timer = setInterval(() => void this.refresh(), 30_000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
  }

  async refresh() {
    this.loading = true;
    this.error = null;
    try {
      await resolveAgentPort(); // 确保拿到正确 agent 端口再请求
      await Promise.all([
        this.loadOverview(),
        this.loadInitiatives(),
        this.loadFailures(),
        this.loadSubscriptions(),
      ]);
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadOverview() {
    const r = await fetch(`${API_BASE()}/overview`);
    if (!r.ok) throw new Error(`overview ${r.status}`);
    this.overview = await r.json();
  }

  async loadInitiatives() {
    const params = new URLSearchParams({ limit: '50' });
    if (this.statusFilter) params.set('status', this.statusFilter);
    if (this.driverFilter) params.set('driver', this.driverFilter);
    const r = await fetch(`${API_BASE()}/initiatives?${params}`);
    if (!r.ok) throw new Error(`initiatives ${r.status}`);
    const data = await r.json();
    this.initiatives = data.initiatives ?? [];
  }

  async loadFailures() {
    const r = await fetch(`${API_BASE()}/failure-signatures?since-h=24&limit=30`);
    if (!r.ok) throw new Error(`failures ${r.status}`);
    this.failures = await r.json();
  }

  async loadSubscriptions() {
    const r = await fetch(`${API_BASE()}/push-subscriptions`);
    if (!r.ok) throw new Error(`subscriptions ${r.status}`);
    const data = await r.json();
    this.subscriptions = data.subscriptions ?? [];
  }

  toggleExpand(id: string) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.requestUpdate();
  }

  formatTs(ts: number | null): string {
    if (ts == null) return '—';
    const ago = Date.now() - ts;
    if (ago < 60_000) return t('刚刚', 'just now');
    if (ago < 60 * 60_000) return t(`${Math.round(ago / 60_000)} 分钟前`, `${Math.round(ago / 60_000)} min ago`);
    if (ago < 24 * 60 * 60_000) return t(`${Math.round(ago / (60 * 60_000))} 小时前`, `${Math.round(ago / (60 * 60_000))} hr ago`);
    return t(`${Math.round(ago / (24 * 60 * 60_000))} 天前`, `${Math.round(ago / (24 * 60 * 60_000))} days ago`);
  }

  renderOverview() {
    if (!this.overview) return html`<div class="loading">${t('加载中…', 'Loading…')}</div>`;
    const ov = this.overview;
    const u = ov.budget.dailyUsage;
    const c = ov.budget.caps;
    const tokenPct = c.dailyTokens > 0 ? Math.min(100, Math.round((u.llmTokensUsed * 100) / c.dailyTokens)) : 0;
    const callPct = c.dailyToolCalls > 0 ? Math.min(100, Math.round((u.toolCallsUsed * 100) / c.dailyToolCalls)) : 0;
    return html`
      <div class="card">
        <h3>${t('📊 今日预算', '📊 Today\'s Budget')} (${ov.today} UTC, user=${ov.userId})</h3>
        <div class="budget-grid">
          <div>
            <div class="label">LLM tokens</div>
            <div class="bar">
              <div class="bar-fill" style="width:${tokenPct}%"></div>
            </div>
            <div class="value">${u.llmTokensUsed} / ${c.dailyTokens}</div>
          </div>
          <div>
            <div class="label">Tool calls</div>
            <div class="bar">
              <div class="bar-fill" style="width:${callPct}%"></div>
            </div>
            <div class="value">${u.toolCallsUsed} / ${c.dailyToolCalls}</div>
          </div>
          <div>
            <div class="label">${t('Initiatives 跑过', 'Initiatives run')}</div>
            <div class="value big">${u.initiativesRun}</div>
          </div>
        </div>
        <div class="status-row">
          <span class="chip pending">pending ${ov.initiatives.byStatus.pending}</span>
          <span class="chip running">running ${ov.initiatives.byStatus.running}</span>
          <span class="chip done">done ${ov.initiatives.byStatus.done}</span>
          <span class="chip failed">failed ${ov.initiatives.byStatus.failed}</span>
          <span class="chip skipped">skipped ${ov.initiatives.byStatus.skipped}</span>
        </div>
        <div class="meta">
          <span>Drivers: ${ov.drivers.join(', ')}</span>
          <span>Push channels: ${ov.pushChannels.length > 0 ? ov.pushChannels.join(', ') : '(none)'}</span>
          <span>
            Push: ${ov.pushGloballyEnabled ? '✅ on' : '❌ off'} ·
            ${t('订阅', 'subscriptions')} ${ov.pushSubscriptionsActive}/${ov.pushSubscriptionsTotal}
          </span>
        </div>
      </div>
    `;
  }

  renderInitiatives() {
    return html`
      <div class="card">
        <h3>${t('📋 Initiatives (最近 50)', '📋 Initiatives (latest 50)')}</h3>
        <div class="filters">
          <label>
            ${t('状态:', 'Status:')}
            <select
              .value=${this.statusFilter}
              @change=${(e: Event) => {
                this.statusFilter = (e.target as HTMLSelectElement).value as Initiative['status'] | '';
                void this.loadInitiatives();
              }}
            >
              <option value="">${t('全部', 'All')}</option>
              <option value="pending">pending</option>
              <option value="running">running</option>
              <option value="done">done</option>
              <option value="failed">failed</option>
              <option value="skipped">skipped</option>
            </select>
          </label>
          <label>
            Driver:
            <select
              .value=${this.driverFilter}
              @change=${(e: Event) => {
                this.driverFilter = (e.target as HTMLSelectElement).value;
                void this.loadInitiatives();
              }}
            >
              <option value="">${t('全部', 'All')}</option>
              <option value="gap">gap</option>
              <option value="curiosity">curiosity</option>
              <option value="pursuit">pursuit</option>
              <option value="k7-bridge">k7-bridge</option>
            </select>
          </label>
        </div>
        ${this.initiatives.length === 0
          ? html`<div class="empty">${t('暂无 initiative(autonomous loop 还没跑过 / 被预算门拦)', 'No initiatives yet (autonomous loop hasn\'t run, or blocked by budget gate)')}</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>${t('时间', 'Time')}</th>
                    <th>${t('状态', 'Status')}</th>
                    <th>Driver / Kind</th>
                    <th>Utility</th>
                    <th>${t('摘要', 'Summary')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.initiatives.map(
                    (i) => html`
                      <tr class="row" @click=${() => this.toggleExpand(i.id)}>
                        <td>${this.formatTs(i.createdAt)}</td>
                        <td><span class="chip ${i.status}">${i.status}</span></td>
                        <td>
                          <code>${i.driver}</code> /
                          <code>${i.kind}</code>
                        </td>
                        <td>${i.utility.toFixed(2)}</td>
                        <td class="summary">
                          ${(i.outcomeSummary ?? i.rationale).slice(0, 80)}…
                        </td>
                      </tr>
                      ${this.expanded.has(i.id)
                        ? html`
                            <tr class="detail-row">
                              <td colspan="5">
                                <div class="detail-grid">
                                  <div><strong>targetRef:</strong> <code>${i.targetRef}</code></div>
                                  <div><strong>Rationale:</strong> ${i.rationale}</div>
                                  ${i.outcomeSummary
                                    ? html`<div><strong>Outcome:</strong> ${i.outcomeSummary}</div>`
                                    : ''}
                                  ${i.outcomeRefs
                                    ? html`<div>
                                        <strong>Refs:</strong>
                                        ${i.outcomeRefs.facts.length} facts /
                                        ${i.outcomeRefs.notes.length} notes /
                                        ${i.outcomeRefs.pursuits.length} pursuits
                                      </div>`
                                    : ''}
                                  ${i.error ? html`<div class="err"><strong>Error:</strong> ${i.error}</div>` : ''}
                                  <div class="meta-grid">
                                    <span>budget: ${i.budgetActual ?? '—'} / ${i.budgetEstimate}</span>
                                    <span>started: ${this.formatTs(i.startedAt)}</span>
                                    <span>completed: ${this.formatTs(i.completedAt)}</span>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          `
                        : ''}
                    `,
                  )}
                </tbody>
              </table>
            `}
      </div>
    `;
  }

  renderFailures() {
    if (!this.failures) return html`<div class="loading">${t('加载中…', 'Loading…')}</div>`;
    const f = this.failures;
    return html`
      <div class="card">
        <h3>${t(`⚠️ 失败签名聚类 (近 ${f.sinceH}h, 总 ${f.totalFailures} 失败)`, `⚠️ Failure Signatures (last ${f.sinceH}h, ${f.totalFailures} total)`)}</h3>
        ${f.groups.length === 0
          ? html`<div class="empty">${t('无失败 — 一切顺利', 'No failures — all clear')}</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Count</th>
                    <th>Tool</th>
                    <th>Signature</th>
                    <th>${t('最近一次', 'Latest')}</th>
                    <th>${t('提示', 'Hint')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${f.groups.map(
                    (g) => html`
                      <tr class=${g.count >= 3 ? 'highlight' : ''}>
                        <td><strong>${g.count}</strong></td>
                        <td><code>${g.toolName}</code></td>
                        <td><code>${g.signature}</code></td>
                        <td>${this.formatTs(g.latestTs)}</td>
                        <td>
                          ${g.count >= 3
                            ? t('🔁 反复撞同一面墙 — reflection 应已触发', '🔁 Hitting the same wall — reflection should have triggered')
                            : g.count === 2
                              ? t('📍 重复出现', '📍 Recurring')
                              : ''}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `}
      </div>
    `;
  }

  renderSubscriptions() {
    return html`
      <div class="card">
        <h3>${t('📨 主动推送订阅', '📨 Push Subscriptions')}</h3>
        ${this.subscriptions.length === 0
          ? html`<div class="empty">${t('无订阅。LLM 在用户明确请求时调 subscribePush 工具开通', 'No subscriptions. The LLM calls the subscribePush tool when the user explicitly requests one.')}</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Peer</th>
                    <th>${t('静默', 'Quiet')}</th>
                    <th>${t('digest 间隔', 'digest interval')}</th>
                    <th>${t('urgent 间隔', 'urgent interval')}</th>
                    <th>${t('最近 digest', 'last digest')}</th>
                    <th>${t('最近 urgent', 'last urgent')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.subscriptions.map(
                    (s) => html`
                      <tr>
                        <td><code>${s.channel}</code></td>
                        <td><code>${s.peer}</code></td>
                        <td>
                          ${s.quietStartHour !== null
                            ? `${s.quietStartHour}-${s.quietEndHour}${s.timezone ? ` (${s.timezone})` : ' UTC'}`
                            : '—'}
                        </td>
                        <td>${Math.round(s.digestMinIntervalMs / 60_000)}min</td>
                        <td>${Math.round(s.urgentMinIntervalMs / 60_000)}min</td>
                        <td>${this.formatTs(s.lastDigestAt)}</td>
                        <td>${this.formatTs(s.lastUrgentAt)}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `}
      </div>
    `;
  }

  render() {
    return html`
      <div class="dashboard">
        <header>
          <h2>${t('⚙️ 自主性观测', '⚙️ Autonomy')}</h2>
          <button @click=${() => this.refresh()} ?disabled=${this.loading}>
            ${this.loading ? t('刷新中…', 'Refreshing…') : t('🔄 手动刷新', '🔄 Refresh')}
          </button>
        </header>
        ${this.error ? html`<div class="error">⚠ ${this.error}</div>` : ''}
        ${this.renderOverview()}
        ${this.renderInitiatives()}
        ${this.renderFailures()}
        ${this.renderSubscriptions()}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #1a1a1a;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    h2 {
      margin: 0;
      font-size: 20px;
    }
    button {
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid #ddd;
      background: #fff;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover:not([disabled]) {
      background: #f5f5f5;
    }
    button[disabled] {
      opacity: 0.5;
      cursor: wait;
    }
    .card {
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .card h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      color: #555;
      font-weight: 600;
    }
    .loading,
    .empty {
      color: #888;
      font-size: 13px;
      padding: 12px 0;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #a00;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .budget-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 12px;
    }
    .budget-grid .label {
      font-size: 12px;
      color: #777;
      margin-bottom: 4px;
    }
    .budget-grid .value {
      font-size: 13px;
      color: #333;
      margin-top: 4px;
    }
    .budget-grid .value.big {
      font-size: 24px;
      font-weight: 600;
      color: #2563eb;
    }
    .bar {
      width: 100%;
      height: 6px;
      background: #eee;
      border-radius: 3px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #4ade80, #facc15 60%, #f87171 90%);
      transition: width 0.3s ease;
    }
    .status-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0;
    }
    .chip {
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
      background: #eee;
    }
    .chip.pending {
      background: #fef3c7;
      color: #92400e;
    }
    .chip.running {
      background: #dbeafe;
      color: #1e40af;
    }
    .chip.done {
      background: #dcfce7;
      color: #166534;
    }
    .chip.failed {
      background: #fee2e2;
      color: #991b1b;
    }
    .chip.skipped {
      background: #f3f4f6;
      color: #6b7280;
    }
    .meta {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      font-size: 12px;
      color: #666;
      margin-top: 8px;
    }
    .filters {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .filters select {
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid #ccc;
      margin-left: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th,
    td {
      padding: 6px 10px;
      text-align: left;
      border-bottom: 1px solid #f0f0f0;
    }
    th {
      color: #666;
      font-weight: 500;
      font-size: 12px;
      background: #fafafa;
    }
    tr.row {
      cursor: pointer;
    }
    tr.row:hover {
      background: #fafafa;
    }
    tr.detail-row {
      background: #f9fafb;
    }
    tr.detail-row td {
      padding: 12px 16px;
    }
    .detail-grid {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
    }
    .detail-grid code {
      background: #f3f4f6;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 12px;
    }
    .meta-grid {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
    }
    .err {
      color: #991b1b;
    }
    .summary {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #555;
    }
    tr.highlight {
      background: #fff3cd;
    }
    code {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
    }
  `;
}
