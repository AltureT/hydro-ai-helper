"use strict";
/**
 * 成本分析 API Handler
 * GET /ai-helper/analytics/cost?period=day|week|month&date=YYYY-MM-DD
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CostAnalyticsHandlerPriv = exports.CostAnalyticsHandler = void 0;
const hydrooj_1 = require("hydrooj");
const domainHelper_1 = require("../utils/domainHelper");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const i18nHelper_1 = require("../utils/i18nHelper");
class CostAnalyticsHandler extends hydrooj_1.Handler {
    async get() {
        try {
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_cost_analytics', periodSecs: 60, maxOps: 10,
                failOpen: true,
                errorMessage: 'ai_helper_cost_rate_limited',
            }))
                return;
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const accept = this.request.headers.accept || '';
            const preferJson = accept.includes('application/json');
            const { period, date } = this.request.query;
            // 浏览器直接访问时返回模板
            if (!period && !preferJson) {
                this.response.template = 'ai-helper/cost_analytics.html';
                this.response.body = {};
                return;
            }
            const tokenUsageModel = this.ctx.get('tokenUsageModel');
            const aiConfigModel = this.ctx.get('aiConfigModel');
            const aiConfig = await aiConfigModel.getConfig();
            const targetDate = date || new Date().toISOString().slice(0, 10);
            const validPeriod = (period === 'week' || period === 'month') ? period : 'day';
            // 计算日期范围
            const { startDate, endDate } = this.getDateRange(targetDate, validPeriod);
            // 并行查询各维度数据
            const today = new Date().toISOString().slice(0, 10);
            const yearMonth = today.slice(0, 7);
            // topUsers / modelBreakdown 应使用 period 对应的实际范围
            // period=day 时 getDateRange 返回 30 天（给趋势图用），但 Top 用户只需今天
            const periodStart = validPeriod === 'day' ? today : startDate;
            const periodEnd = validPeriod === 'day' ? today : endDate;
            const [todayUsage, monthlyUsage, dailyTrend, topUsers, modelBreakdown,] = await Promise.all([
                tokenUsageModel.getDomainDailyUsage(domainId, today),
                tokenUsageModel.getDomainMonthlyUsage(domainId, yearMonth),
                tokenUsageModel.getDailyTrend(domainId, startDate, endDate),
                tokenUsageModel.getTopUsersByDateRange(domainId, periodStart, periodEnd, 10),
                tokenUsageModel.getModelBreakdown(domainId, periodStart, periodEnd),
            ]);
            // 计算预算使用百分比
            let budgetUsagePercent = null;
            if (aiConfig?.budgetConfig?.dailyTokenLimitPerDomain && aiConfig.budgetConfig.dailyTokenLimitPerDomain > 0) {
                budgetUsagePercent = (todayUsage.totalTokens / aiConfig.budgetConfig.dailyTokenLimitPerDomain) * 100;
            }
            // 获取用户名映射
            const userIds = topUsers.map(u => u.userId);
            const userNameMap = await this.getUserNameMap(userIds);
            const enrichedTopUsers = topUsers.map(u => ({
                ...u,
                userName: userNameMap.get(u.userId) || (0, i18nHelper_1.translateWithParams)(this, 'ai_helper_cost_user_fallback', u.userId),
            }));
            // 计算 period 汇总
            let periodTokens = 0;
            let periodCost = 0;
            let periodRequests = 0;
            if (validPeriod === 'day') {
                // "今日" 直接使用当天聚合数据，而非 dailyTrend（30天）的累加
                periodTokens = todayUsage.totalTokens;
                periodCost = todayUsage.totalCost;
                periodRequests = todayUsage.requestCount;
            }
            else {
                for (const d of dailyTrend) {
                    periodTokens += d.totalTokens;
                    periodCost += d.totalCost;
                    periodRequests += d.requestCount;
                }
            }
            // 补全日期范围内缺失的日期（填零值）
            const filledTrend = this.fillMissingDates(dailyTrend, startDate, endDate);
            this.response.body = {
                summary: {
                    totalTokens: periodTokens,
                    totalCost: Math.round(periodCost * 10000) / 10000,
                    requestCount: periodRequests,
                    avgTokensPerRequest: periodRequests > 0 ? Math.round(periodTokens / periodRequests) : 0,
                    budgetUsagePercent: budgetUsagePercent !== null ? Math.round(budgetUsagePercent * 10) / 10 : null,
                },
                today: {
                    totalTokens: todayUsage.totalTokens,
                    totalCost: Math.round(todayUsage.totalCost * 10000) / 10000,
                    requestCount: todayUsage.requestCount,
                },
                monthly: {
                    totalTokens: monthlyUsage.totalTokens,
                    totalCost: Math.round(monthlyUsage.totalCost * 10000) / 10000,
                    requestCount: monthlyUsage.requestCount,
                },
                dailyTrend: filledTrend.map(d => ({
                    ...d,
                    totalCost: Math.round(d.totalCost * 10000) / 10000,
                })),
                topUsers: enrichedTopUsers,
                modelBreakdown: modelBreakdown.map(m => ({
                    ...m,
                    estimatedCostUSD: Math.round(m.estimatedCostUSD * 10000) / 10000,
                })),
                period: validPeriod,
                dateRange: { startDate, endDate },
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[CostAnalyticsHandler] error:', err);
            this.response.status = 500;
            this.response.body = { error: this.translate('ai_helper_err_internal'), code: 'INTERNAL_ERROR' };
            this.response.type = 'application/json';
        }
    }
    getDateRange(date, period) {
        const d = new Date(date);
        let startDate;
        const endDate = date;
        if (period === 'month') {
            startDate = date.slice(0, 7) + '-01';
        }
        else if (period === 'week') {
            const weekAgo = new Date(d);
            weekAgo.setDate(weekAgo.getDate() - 6);
            startDate = weekAgo.toISOString().slice(0, 10);
        }
        else {
            // 默认显示近 30 天
            const monthAgo = new Date(d);
            monthAgo.setDate(monthAgo.getDate() - 29);
            startDate = monthAgo.toISOString().slice(0, 10);
        }
        return { startDate, endDate };
    }
    fillMissingDates(trend, startDate, endDate) {
        const dataMap = new Map(trend.map(d => [d.date, d]));
        const result = [];
        const current = new Date(startDate + 'T00:00:00');
        const end = new Date(endDate + 'T00:00:00');
        while (current <= end) {
            const dateStr = current.toISOString().slice(0, 10);
            result.push(dataMap.get(dateStr) || { date: dateStr, totalTokens: 0, totalCost: 0, requestCount: 0 });
            current.setDate(current.getDate() + 1);
        }
        return result;
    }
    async getUserNameMap(userIds) {
        const nameMap = new Map();
        if (userIds.length === 0)
            return nameMap;
        try {
            const userColl = hydrooj_1.db.collection('user');
            const users = await userColl.find({ _id: { $in: userIds } }).toArray();
            for (const user of users) {
                nameMap.set(user._id, user.uname || (0, i18nHelper_1.translateWithParams)(this, 'ai_helper_cost_user_fallback', user._id));
            }
        }
        catch (err) {
            console.error('[CostAnalyticsHandler] Failed to fetch user names:', err);
        }
        return nameMap;
    }
}
exports.CostAnalyticsHandler = CostAnalyticsHandler;
exports.CostAnalyticsHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=costAnalyticsHandler.js.map