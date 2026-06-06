/**
 * SignalState —— Tier 2 信号化实验的进程内单例。
 *
 * 为什么不进 SQLite(v1):
 *   - 第一阶段是"信号-binding 路径是否值得"的实验,值的本质是"老化压力",
 *     重启后下一个 idle tick 自然算出来,落盘没必要
 *   - 落 SQLite 要设计 schema/写时机,V1 不值
 *   - 真正持久化等 Tier 3 信号系统铺开再说
 *
 * 为什么模块级单例:
 *   - 一个进程一个 agent 身份,信号天然全局
 *   - 不接 DI 是为了让 buildMemoryPrefix / idle_consolidator 能直接 import,
 *     不用层层透传
 *   - 测试时 reset() 清空就行,不需要构造多个实例
 */

import type { Pursuit } from '../types.js';
import {
  computeCommitmentPressure,
  type CommitmentPressureBreakdown,
  type CommitmentPressureOptions,
} from './commitment_pressure.js';

interface CommitmentPressureSnapshot {
  breakdown: CommitmentPressureBreakdown;
  computedAt: number;
}

class SignalState {
  private commitment: CommitmentPressureSnapshot | null = null;

  /**
   * 用最新的 active pursuit 列表算一次 commitment_pressure,覆盖之前的 snapshot。
   * idle_consolidator 在每个 tick 末尾调一次。
   */
  recomputeCommitmentPressure(
    pursuits: ReadonlyArray<Pursuit>,
    now: number,
    opts?: CommitmentPressureOptions,
  ): CommitmentPressureBreakdown {
    const breakdown = computeCommitmentPressure(pursuits, now, opts);
    this.commitment = { breakdown, computedAt: now };
    return breakdown;
  }

  get commitmentPressure(): number {
    return this.commitment?.breakdown.pressure ?? 0;
  }

  getCommitmentBreakdown(): CommitmentPressureBreakdown | null {
    return this.commitment?.breakdown ?? null;
  }

  /** 上次 recompute 的 wall-clock ms;null = 还没算过 */
  get commitmentLastComputedAt(): number | null {
    return this.commitment?.computedAt ?? null;
  }

  /** 测试用:清空 */
  reset(): void {
    this.commitment = null;
  }
}

/** 全局单例 */
export const signalState = new SignalState();

/** 重新导出类型方便消费方 */
export type { CommitmentPressureBreakdown, CommitmentPressureOptions };
