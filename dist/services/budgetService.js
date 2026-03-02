"use strict";
/**
 * BudgetService - Token 预算控制服务
 *
 * 两级机制:
 * - 软限 (默认 80%): allowed=true + warning
 * - 硬限 (100%): allowed=false + reason
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BudgetService = void 0;
class BudgetService {
    constructor(tokenUsageModel) {
        this.tokenUsageModel = tokenUsageModel;
    }
    async checkBudget(domainId, userId, budgetConfig) {
        const today = new Date().toISOString().slice(0, 10);
        const softPercent = budgetConfig.softLimitPercent ?? 80;
        // 1. 检查用户日限额
        if (budgetConfig.dailyTokenLimitPerUser && budgetConfig.dailyTokenLimitPerUser > 0) {
            const userUsage = await this.tokenUsageModel.getUserDailyUsage(domainId, userId, today);
            const used = userUsage?.totalTokens ?? 0;
            const limit = budgetConfig.dailyTokenLimitPerUser;
            if (used >= limit) {
                return {
                    allowed: false,
                    reason: `今天的 AI 额度已用完（已使用 ${used.toLocaleString()} / ${limit.toLocaleString()} tokens）`,
                    remaining: 0,
                };
            }
            const softThreshold = Math.floor(limit * softPercent / 100);
            if (used >= softThreshold) {
                const remaining = limit - used;
                return {
                    allowed: true,
                    warning: `AI 额度即将用尽（剩余约 ${remaining.toLocaleString()} tokens）`,
                    remaining,
                };
            }
        }
        // 2. 检查域日限额
        if (budgetConfig.dailyTokenLimitPerDomain && budgetConfig.dailyTokenLimitPerDomain > 0) {
            const domainUsage = await this.tokenUsageModel.getDomainDailyUsage(domainId, today);
            const used = domainUsage.totalTokens;
            const limit = budgetConfig.dailyTokenLimitPerDomain;
            if (used >= limit) {
                return {
                    allowed: false,
                    reason: '今日全站 AI 额度已用完，请明天再试',
                    remaining: 0,
                };
            }
            const softThreshold = Math.floor(limit * softPercent / 100);
            if (used >= softThreshold) {
                return {
                    allowed: true,
                    warning: '全站 AI 额度即将用尽，请节约使用',
                };
            }
        }
        // 3. 检查域月限额
        if (budgetConfig.monthlyTokenLimitPerDomain && budgetConfig.monthlyTokenLimitPerDomain > 0) {
            const yearMonth = today.slice(0, 7); // YYYY-MM
            const monthlyUsage = await this.tokenUsageModel.getDomainMonthlyUsage(domainId, yearMonth);
            const used = monthlyUsage.totalTokens;
            const limit = budgetConfig.monthlyTokenLimitPerDomain;
            if (used >= limit) {
                return {
                    allowed: false,
                    reason: '本月全站 AI 额度已用完，请联系管理员',
                    remaining: 0,
                };
            }
            const softThreshold = Math.floor(limit * softPercent / 100);
            if (used >= softThreshold) {
                return {
                    allowed: true,
                    warning: '本月全站 AI 额度即将用尽',
                };
            }
        }
        return { allowed: true };
    }
}
exports.BudgetService = BudgetService;
//# sourceMappingURL=budgetService.js.map