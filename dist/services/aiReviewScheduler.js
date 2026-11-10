"use strict";
/**
 * AI 抽查调度（plan R9）：不用 Hydro worker。
 *
 * 每个进程每 5 分钟检查一次（`ctx.setInterval`，随插件卸载自动清理）：
 *   1. 接管租约已过期的进行中批次（进程崩溃或重启），断点续跑；
 *   2. 已启用且到了配置时区的运行时间、当天还没有批次、没有其他批次在跑时，
 *      插入 `daily:YYYY-MM-DD`；插入成功的进程负责执行，重复键说明其他进程已负责。
 * 执行期间每 30 秒续租；续租失败（被接管）时停止，不再写结果。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIReviewScheduler = exports.REVIEW_TICK_MS = void 0;
exports.runAtMinutes = runAtMinutes;
exports.isDue = isDue;
const configSections_1 = require("../models/configSections");
const reviewRun_1 = require("../models/reviewRun");
const timezone_1 = require("../utils/timezone");
exports.REVIEW_TICK_MS = 5 * 60 * 1000;
function runAtMinutes(runAt) {
    const match = /^(\d{2}):(\d{2})$/.exec(runAt);
    if (!match)
        return 2 * 60;
    return Number(match[1]) * 60 + Number(match[2]);
}
/** 到点判断：当天已过运行时间（错过的批次在当天稍后补跑） */
function isDue(runAt, timezone, now) {
    return (0, timezone_1.minutesOfDay)(timezone, now) >= runAtMinutes(runAt);
}
const defaultTimers = {
    setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        handle.unref?.();
        return handle;
    },
    clearInterval: (handle) => clearInterval(handle),
};
class AIReviewScheduler {
    constructor(service, runs, configModel, owner, options = {}) {
        this.service = service;
        this.runs = runs;
        this.configModel = configModel;
        this.owner = owner;
        /** 本进程正在执行的检查或批次数：大于 0 时不再开始新的检查 */
        this.running = 0;
        this.clock = options.clock || (() => new Date());
        this.timers = options.timers || defaultTimers;
    }
    /** 一次检查；同一进程内不重入 */
    async tick() {
        if (this.running > 0)
            return;
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
            const review = (0, configSections_1.normalizeAIReviewConfig)(cfg?.aiReviewConfig);
            if (!review.enabled)
                return;
            const timezone = (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig).timezone;
            const current = this.clock();
            if (!isDue(review.runAt, timezone, current))
                return;
            if (await this.runs.hasActiveRun(current))
                return;
            const id = await this.service.startDaily(this.owner);
            if (id)
                await this.runWithLease(id);
        }
        catch (err) {
            console.error('[AIReview] 调度检查失败:', err instanceof Error ? err.message : err);
        }
        finally {
            this.running -= 1;
        }
    }
    /** 手动触发的批次在当前进程后台执行 */
    runInBackground(id) {
        this.running += 1;
        this.runWithLease(id)
            .catch((err) => console.error('[AIReview] 手动批次失败:', err instanceof Error ? err.message : err))
            .finally(() => { this.running -= 1; });
    }
    async runWithLease(id) {
        let lost = false;
        const handle = this.timers.setInterval(() => {
            this.runs.renewLease(id, this.owner, this.clock())
                .then((ok) => { if (!ok)
                lost = true; })
                .catch((err) => console.warn('[AIReview] 续租失败:', err instanceof Error ? err.message : err));
        }, reviewRun_1.REVIEW_RUN_RENEW_MS);
        try {
            await this.service.execute(id, this.owner, () => !lost);
        }
        finally {
            this.timers.clearInterval(handle);
        }
    }
}
exports.AIReviewScheduler = AIReviewScheduler;
//# sourceMappingURL=aiReviewScheduler.js.map