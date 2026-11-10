/**
 * AI 抽查调度（plan R9）：不用 Hydro worker。
 *
 * 每个进程每 5 分钟检查一次（`ctx.setInterval`，随插件卸载自动清理）：
 *   1. 接管租约已过期的进行中批次（进程崩溃或重启），断点续跑；
 *   2. 已启用且到了配置时区的运行时间、当天还没有批次、没有其他批次在跑时，
 *      插入 `daily:YYYY-MM-DD`；插入成功的进程负责执行，重复键说明其他进程已负责。
 * 执行期间每 30 秒续租；续租失败（被接管）时停止，不再写结果。
 */

import { normalizeAIReviewConfig, normalizeQuotaConfig } from '../models/configSections';
import type { AIConfigModel } from '../models/aiConfig';
import { REVIEW_RUN_RENEW_MS, type ReviewRunModel } from '../models/reviewRun';
import { minutesOfDay } from '../utils/timezone';
import type { AIReviewService } from './aiReviewService';

export const REVIEW_TICK_MS = 5 * 60 * 1000;

export function runAtMinutes(runAt: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(runAt);
  if (!match) return 2 * 60;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 到点判断：当天已过运行时间（错过的批次在当天稍后补跑） */
export function isDue(runAt: string, timezone: string, now: Date): boolean {
  return minutesOfDay(timezone, now) >= runAtMinutes(runAt);
}

export interface SchedulerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: SchedulerTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class AIReviewScheduler {
  /** 本进程正在执行的检查或批次数：大于 0 时不再开始新的检查 */
  private running = 0;
  private readonly clock: () => Date;

  constructor(
    private readonly service: Pick<AIReviewService, 'startDaily' | 'execute'>,
    private readonly runs: Pick<ReviewRunModel, 'findExpiredRunning' | 'claimExpired' | 'renewLease' | 'hasActiveRun'>,
    private readonly configModel: Pick<AIConfigModel, 'getConfig'>,
    readonly owner: string,
    options: { clock?: () => Date; timers?: SchedulerTimers } = {},
  ) {
    this.clock = options.clock || (() => new Date());
    this.timers = options.timers || defaultTimers;
  }

  private readonly timers: SchedulerTimers;

  /** 一次检查；同一进程内不重入 */
  async tick(): Promise<void> {
    if (this.running > 0) return;
    this.running += 1;
    try {
      const now = this.clock();
      for (const run of await this.runs.findExpiredRunning(now)) {
        if (await this.runs.claimExpired(run._id, this.owner, now)) {
          console.log(`[AIReview] 接管中断的批次 ${run._id}`);
          await this.runWithLease(run._id);
        }
      }

      const cfg = await this.configModel.getConfig();
      const review = normalizeAIReviewConfig(cfg?.aiReviewConfig);
      if (!review.enabled) return;
      const timezone = normalizeQuotaConfig(cfg?.quotaConfig).timezone;
      const current = this.clock();
      if (!isDue(review.runAt, timezone, current)) return;
      if (await this.runs.hasActiveRun(current)) return;
      const id = await this.service.startDaily(this.owner);
      if (id) await this.runWithLease(id);
    } catch (err) {
      console.error('[AIReview] 调度检查失败:', err instanceof Error ? err.message : err);
    } finally {
      this.running -= 1;
    }
  }

  /** 手动触发的批次在当前进程后台执行 */
  runInBackground(id: string): void {
    this.running += 1;
    this.runWithLease(id)
      .catch((err) => console.error('[AIReview] 手动批次失败:', err instanceof Error ? err.message : err))
      .finally(() => { this.running -= 1; });
  }

  private async runWithLease(id: string): Promise<void> {
    let lost = false;
    const handle = this.timers.setInterval(() => {
      this.runs.renewLease(id, this.owner, this.clock())
        .then((ok) => { if (!ok) lost = true; })
        .catch((err) => console.warn('[AIReview] 续租失败:', err instanceof Error ? err.message : err));
    }, REVIEW_RUN_RENEW_MS);
    try {
      await this.service.execute(id, this.owner, () => !lost);
    } finally {
      this.timers.clearInterval(handle);
    }
  }
}
