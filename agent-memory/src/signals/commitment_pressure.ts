/**
 * commitment_pressure —— "我还欠的事" 紧迫度。
 *
 * 第一性原理:agent 立了承诺(active pursuit) 但没闭上,内驱应该把"未闭"当成
 * 一个累积的不平衡 → 时间过去越久 + 押注越重,压力越高 → 引导 agent 主动
 * surface 这些事。
 *
 * 与传统 drive 的区别:
 *   - drive 是 turn 级的反射(看本轮 prompt 文本);信号是跨 turn 的状态量
 *     (看 SQLite 里 pursuits 的累积老化)
 *   - drive evaluator 看不到"上周立的 pursuit",信号看得到
 *
 * 计算路径(纯函数,无 IO):
 *   - 取所有 status === 'active' 的 pursuit
 *   - 单条贡献 = min(maxIndividualContribution,
 *                    stakeWeight/10 * sigmoid((ageHours - halfLife) / halfLife))
 *     直观:押注 ≥ 5、age 接近半衰期时贡献开始上扬,但单条封顶,防一条
 *     超老 pursuit 把全局打满
 *   - 总 pressure = 1 - exp(-Σ contributions)
 *     直观:复合压力,5 条中等老化能比 1 条超老化更紧迫,但永远不超 1
 *
 * 调用方(idle_consolidator)只关心 pressure 数字 + top contributors,不关心
 * 公式细节。要调"什么样算紧迫"用 ageHalfLifeHours / maxIndividualContribution
 * 两个旋钮。
 */

import type { Pursuit } from '../types.js';

export interface CommitmentPressureContributor {
  pursuitId: string;
  title: string;
  ageHours: number;
  stakeWeight: number;
  contribution: number;
}

export interface CommitmentPressureBreakdown {
  /** 0-1,1 = 极紧迫(实际上不会真的到 1,因为是 1-exp 渐近) */
  pressure: number;
  /** 按 contribution 降序的 top 候选(切前 N 由调用方决定;此处给全部) */
  contributors: CommitmentPressureContributor[];
  /** 进入计算的 active pursuit 总数(0 时 pressure=0,contributors=[]) */
  activeCount: number;
  /** 调试:用了多大的半衰期 */
  ageHalfLifeHoursUsed: number;
}

export interface CommitmentPressureOptions {
  /** 默认 72(3 天) — 老到这个时长时单条贡献函数处于拐点附近 */
  ageHalfLifeHours?: number;
  /** 单条 pursuit 最多贡献多少(0-1)。默认 0.4,防一条 pursuit 一统江山 */
  maxIndividualContribution?: number;
  /** stake_weight 的最大值,用于归一(默认 10) */
  stakeMaxWeight?: number;
}

const DEFAULT_HALF_LIFE_HOURS = 72;
const DEFAULT_MAX_INDIVIDUAL = 0.4;
const DEFAULT_STAKE_MAX = 10;

export function computeCommitmentPressure(
  pursuits: ReadonlyArray<Pursuit>,
  now: number,
  opts: CommitmentPressureOptions = {},
): CommitmentPressureBreakdown {
  const halfLifeHours = opts.ageHalfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
  const maxIndividual = opts.maxIndividualContribution ?? DEFAULT_MAX_INDIVIDUAL;
  const stakeMax = opts.stakeMaxWeight ?? DEFAULT_STAKE_MAX;

  // 只看 active 的 pursuit。root pursuit (parentPursuitId === null) 通常是 evergreen
  // 的"agent 自身",老化对它没意义,排除。
  const candidates = pursuits.filter(
    (p) => p.status === 'active' && p.parentPursuitId !== null,
  );

  if (candidates.length === 0) {
    return {
      pressure: 0,
      contributors: [],
      activeCount: 0,
      ageHalfLifeHoursUsed: halfLifeHours,
    };
  }

  const contributors: CommitmentPressureContributor[] = candidates.map((p) => {
    const ageMs = Math.max(0, now - p.lastTouchedAt);
    const ageHours = ageMs / (1000 * 60 * 60);
    const stakeRatio = Math.max(0, Math.min(1, p.stakeWeight / stakeMax));
    // 老化曲线:1 - exp(-age/halfLife)
    //   age=0:        ageScore = 0(刚立的承诺无压力)
    //   age=halfLife: ageScore ≈ 0.63
    //   age=10*half:  ageScore ≈ 1.0
    // 比 sigmoid 更符合"新鲜=零压力" 的直觉。
    const ageScore = 1 - Math.exp(-ageHours / halfLifeHours);
    const raw = stakeRatio * ageScore;
    const contribution = Math.min(maxIndividual, raw);
    return {
      pursuitId: p.id,
      title: p.title,
      ageHours,
      stakeWeight: p.stakeWeight,
      contribution,
    };
  });

  contributors.sort((a, b) => b.contribution - a.contribution);

  const sumContrib = contributors.reduce((s, c) => s + c.contribution, 0);
  // 1 - exp(-x):递减边际复合压力
  const pressure = 1 - Math.exp(-sumContrib);

  return {
    pressure,
    contributors,
    activeCount: candidates.length,
    ageHalfLifeHoursUsed: halfLifeHours,
  };
}
