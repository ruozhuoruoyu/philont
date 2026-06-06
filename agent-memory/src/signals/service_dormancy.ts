/**
 * service_dormancy 信号 —— "agent 多久没真服务过用户" 的硅基激素源(K7.2)。
 *
 * 第一性原理:agent 的核心目的是为人类提供服务。服务停滞本身是一种"不平衡",
 * 应当累积成可观察信号 → 跨阈值时 fire interrupt → 在下次用户对话时让 agent
 * 主动 surface 未闭事项 / 上下文衔接,而不是装作什么都没发生。
 *
 * 信号源就一个标量:距上次 `role='assistant'` 真实回复的时长。
 * 公式:`dormancy = 1 - exp(-hoursSinceLastServe / halfLifeHours)`
 *
 * 半衰期 4h(默认):
 *   - 0h:    0.00
 *   - 1h:    0.22
 *   - 2h:    0.39
 *   - 4h:    0.63
 *   - 5h:    0.71  (≈ HIGH 阈值 0.7)
 *   - 9h:    0.90  (≈ CRITICAL 阈值 0.9)
 *   - 24h:   0.998
 *
 * lastAssistantTs = null 视为"从来没服务过"——刚启动的新 agent。这种情况按
 * "0 dormancy" 处理(没数据 ≠ 紧迫),让 mapper 不立即 fire。
 */

const DEFAULT_HALF_LIFE_HOURS = 4;
const HOUR_MS = 60 * 60 * 1000;

export interface ServiceDormancyOptions {
  /** 半衰期(小时),默认 4。改小 = 同时长更紧迫 */
  halfLifeHours?: number;
}

export interface ServiceDormancyBreakdown {
  /** 0-1,1 = 极紧迫(渐近不到 1) */
  dormancy: number;
  /** 距上次服务的小时数;null 时为 0 */
  hoursSinceLastServe: number;
  /** 上次 assistant 回复的 unix ms;null = 没服务过 */
  lastAssistantTs: number | null;
  /** 调试:用了多大半衰期 */
  halfLifeHoursUsed: number;
}

export interface ServiceDormancyInput {
  /** 上次 role=assistant 真实回复的 unix ms;null = 没服务过(新 agent) */
  lastAssistantTs: number | null;
  /** 当前 wall-clock unix ms */
  now: number;
}

export function computeServiceDormancy(
  input: ServiceDormancyInput,
  opts: ServiceDormancyOptions = {},
): ServiceDormancyBreakdown {
  const halfLifeHours = opts.halfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;

  if (input.lastAssistantTs == null) {
    // 没服务过(刚启动) → 0 dormancy。新 agent 不该立即被 dormancy 缠住。
    return {
      dormancy: 0,
      hoursSinceLastServe: 0,
      lastAssistantTs: null,
      halfLifeHoursUsed: halfLifeHours,
    };
  }

  const ageMs = Math.max(0, input.now - input.lastAssistantTs);
  const hours = ageMs / HOUR_MS;
  // 1 - exp(-x/halfLife):age=0 → 0;age=halfLife → 0.63;age→∞ → 1
  const dormancy = 1 - Math.exp(-hours / halfLifeHours);

  return {
    dormancy,
    hoursSinceLastServe: hours,
    lastAssistantTs: input.lastAssistantTs,
    halfLifeHoursUsed: halfLifeHours,
  };
}
