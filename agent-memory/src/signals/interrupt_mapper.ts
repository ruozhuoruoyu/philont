/**
 * InterruptMapper —— 把硅基"激素"信号 (0-1 浮点) 映射成 4 级 interrupt 触发(K7.2)。
 *
 * 设计契约:
 *   - **纯调度器**:不知道信号怎么算,只知道"信号 X 的当前值是 Y"。计算在 signals/*.ts。
 *   - **不动 messages 槽位**:fire interrupt 调 controller.send_x(),controller 自己路由。
 *     mapper 不直接产生 prompt,只负责"什么时候触发"。
 *   - **ASCII-only 状态机**:每个信号有 IDLE / NORMAL / HIGH / CRITICAL 4 态,只升级时
 *     fire,降级和不变都静默。
 *   - **Hysteresis**:防止信号在阈值边缘 ping-pong——降级阈值 = 升级阈值 - hysteresisDelta。
 *   - **Cooldown**:每信号一个,防止短时间内多次升级 fire(eg. 信号 0.4 → 0.5 → 0.6
 *     → 0.7 跨过 NORMAL 又跨过 HIGH,30s 内只 fire 一次)。
 *
 * 调用契约:
 *   - 调用方每个 idle tick / 每轮 LLM call 前 调一次 `tick(snapshot)`。
 *   - snapshot 是 `{ signalName: 0-1 number }` 的扁平 map。新加信号只要塞进 map 就识别。
 */

/** Controller 抽象——只用 4 个 send 方法,便于 mock 测试 */
export interface InterruptControllerLike {
  sendCritical(signal: { signalType: string; payload?: string }): void;
  sendHigh(signal: { signalType: string; payload?: string }): void;
  sendNormal(signal: { signalType: string; payload?: string }): void;
  sendLow(signal: { signalType: string; payload?: string }): void;
}

export type InterruptLevel = 'IDLE' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export interface SignalThresholds {
  NORMAL: number;
  HIGH: number;
  CRITICAL: number;
}

export const DEFAULT_THRESHOLDS: SignalThresholds = {
  NORMAL: 0.4,
  HIGH: 0.7,
  CRITICAL: 0.9,
};

export interface InterruptMapperConfig {
  /** per-signal 阈值表;缺省用 DEFAULT_THRESHOLDS */
  thresholds?: { [signalName: string]: SignalThresholds };
  /** 降级阈值 = 升级阈值 - hysteresisDelta;默认 0.15 */
  hysteresisDelta?: number;
  /** 同信号两次 fire 间隔最小 ms,默认 30_000 */
  cooldownMs?: number;
  /** 时钟,默认 Date.now;测试时可注入 */
  clock?: () => number;
  /**
   * 可选:信号触发时的辅助 payload 生成器(为不同信号定制 interrupt 文本)。
   * 接收 (signalName, level, value) 返回 payload 字符串。
   * 默认拼接:`"{signalName}=#{value.toFixed(2)} → {level}"`。
   */
  buildPayload?: (signalName: string, level: InterruptLevel, value: number) => string;
}

export interface FireRecord {
  signal: string;
  level: InterruptLevel;
  value: number;
  prevLevel: InterruptLevel;
  firedAtMs: number;
}

interface SignalState {
  level: InterruptLevel;
  lastFiredAtMs: number;
}

const DEFAULT_HYSTERESIS = 0.15;
const DEFAULT_COOLDOWN_MS = 30_000;

function defaultBuildPayload(
  signalName: string,
  level: InterruptLevel,
  value: number,
): string {
  return `${signalName}=${value.toFixed(2)} → ${level}`;
}

/** 把 level 映射到 AgentInterrupt signalType 的语义类别 */
function signalTypeForLevel(level: InterruptLevel, signalName: string): string {
  // service_dormancy → BoredomThreshold(语义最匹配:"无服务"近似 boredom)
  // commitment_pressure → IdentityThreat 在 HIGH+(承诺没闭=身份威胁,激进选择)
  //                       NORMAL → CuriosityTriggered(温和提示)
  // 其它信号默认走 SteerMessage。
  if (signalName === 'service_dormancy') return 'BoredomThreshold';
  if (signalName === 'commitment_pressure') {
    return level === 'CRITICAL' || level === 'HIGH'
      ? 'IdentityThreat'
      : 'SteerMessage';
  }
  return 'SteerMessage';
}

export class InterruptMapper {
  private readonly thresholds: { [name: string]: SignalThresholds };
  private readonly hysteresis: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly buildPayload: NonNullable<InterruptMapperConfig['buildPayload']>;
  private readonly state: Map<string, SignalState> = new Map();
  /** 最近一轮 tick 触发的 fire 记录,供 audit 用 */
  private lastFires: FireRecord[] = [];

  constructor(
    private readonly controller: InterruptControllerLike,
    config: InterruptMapperConfig = {},
  ) {
    this.thresholds = config.thresholds ?? {};
    this.hysteresis = config.hysteresisDelta ?? DEFAULT_HYSTERESIS;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = config.clock ?? (() => Date.now());
    this.buildPayload = config.buildPayload ?? defaultBuildPayload;
  }

  private getThresholds(signalName: string): SignalThresholds {
    return this.thresholds[signalName] ?? DEFAULT_THRESHOLDS;
  }

  /** 给定值 + 当前态,返回新 level(已应用 hysteresis 滞回) */
  private resolveLevel(
    value: number,
    current: InterruptLevel,
    th: SignalThresholds,
  ): InterruptLevel {
    // 升级路径:用原始阈值
    if (value >= th.CRITICAL) return 'CRITICAL';
    if (value >= th.HIGH && current !== 'CRITICAL') return 'HIGH';
    if (value >= th.NORMAL && current === 'IDLE') return 'NORMAL';

    // 降级路径:必须比"当前 level 的入门阈值 - hysteresis"还低,才下降
    const dropFrom = (lvlTh: number) => Math.max(0, lvlTh - this.hysteresis);
    if (current === 'CRITICAL') {
      if (value < dropFrom(th.CRITICAL)) {
        // 一档一档掉,而不是一次掉到 IDLE。掉到 HIGH 之后下一次 tick 再判
        if (value >= th.HIGH) return 'HIGH';
        if (value >= th.NORMAL) return 'NORMAL';
        return 'IDLE';
      }
      return 'CRITICAL';
    }
    if (current === 'HIGH') {
      if (value < dropFrom(th.HIGH)) {
        if (value >= th.NORMAL) return 'NORMAL';
        return 'IDLE';
      }
      return 'HIGH';
    }
    if (current === 'NORMAL') {
      if (value < dropFrom(th.NORMAL)) return 'IDLE';
      return 'NORMAL';
    }
    return current; // IDLE 不主动跳
  }

  private fireFor(level: InterruptLevel, signalName: string, value: number): void {
    const sig = {
      signalType: signalTypeForLevel(level, signalName),
      payload: this.buildPayload(signalName, level, value),
    };
    switch (level) {
      case 'CRITICAL': this.controller.sendCritical(sig); break;
      case 'HIGH':     this.controller.sendHigh(sig);     break;
      case 'NORMAL':   this.controller.sendNormal(sig);   break;
      case 'IDLE':     /* 不触发 */                       break;
    }
  }

  /**
   * 对当前所有信号值跑一遍调度。返回这一轮触发的 fire 记录(含未触发的 noop 不返回)。
   * 同时把记录缓存在 lastFires,供调用方 audit。
   *
   * @param opts.broadcast 默认 true:fire 时通过 controller 走 broadcast 通道(被 drainer 捕获)。
   *   render 路径(buildMemoryPrefix)应传 false——直接用 return 值,避免 drainer 下轮重复渲染同一 fire。
   */
  tick(
    signals: { [name: string]: number },
    opts: { broadcast?: boolean } = {},
  ): FireRecord[] {
    const broadcast = opts.broadcast ?? true;
    const now = this.clock();
    const fires: FireRecord[] = [];

    for (const [name, value] of Object.entries(signals)) {
      const th = this.getThresholds(name);
      const cur = this.state.get(name) ?? { level: 'IDLE' as InterruptLevel, lastFiredAtMs: 0 };
      const next = this.resolveLevel(value, cur.level, th);

      // 升级判断:只在 level 增加时考虑 fire
      const isUpgrade = levelRank(next) > levelRank(cur.level);
      const cooldownPassed = now - cur.lastFiredAtMs >= this.cooldownMs;

      if (isUpgrade && cooldownPassed) {
        if (broadcast) this.fireFor(next, name, value);
        const rec: FireRecord = {
          signal: name,
          level: next,
          value,
          prevLevel: cur.level,
          firedAtMs: now,
        };
        fires.push(rec);
        this.state.set(name, { level: next, lastFiredAtMs: now });
      } else {
        // 降级 / 持平 / cooldown 内升级 → 仅更新 level,不 fire,不刷 lastFiredAtMs
        if (next !== cur.level) {
          this.state.set(name, { level: next, lastFiredAtMs: cur.lastFiredAtMs });
        } else if (!this.state.has(name)) {
          this.state.set(name, cur);
        }
      }
    }

    this.lastFires = fires;
    return fires;
  }

  /** 当前每个信号的活跃 level(给 audit / 可视化用) */
  getActiveLevels(): { [name: string]: InterruptLevel } {
    const out: { [k: string]: InterruptLevel } = {};
    for (const [name, st] of this.state) {
      out[name] = st.level;
    }
    return out;
  }

  /** 最近一次 tick 触发的 fire 记录(测试用) */
  getLastFires(): ReadonlyArray<FireRecord> {
    return this.lastFires;
  }

  /** 测试用:重置所有内部状态 */
  reset(): void {
    this.state.clear();
    this.lastFires = [];
  }
}

function levelRank(l: InterruptLevel): number {
  switch (l) {
    case 'IDLE':     return 0;
    case 'NORMAL':   return 1;
    case 'HIGH':     return 2;
    case 'CRITICAL': return 3;
  }
}
