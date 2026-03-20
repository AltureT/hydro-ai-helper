/**
 * 成本分析 API Handler
 * GET /ai-helper/analytics/cost?period=day|week|month&date=YYYY-MM-DD
 */

import { Handler, PRIV, db } from 'hydrooj';
import { getDomainId } from '../utils/domainHelper';
import { TokenUsageModel } from '../models/tokenUsage';
import { AIConfigModel } from '../models/aiConfig';
import { applyRateLimit } from '../lib/rateLimitHelper';

export class CostAnalyticsHandler extends Handler {
  async get() {
    try {
      if (await applyRateLimit(this, {
        op: 'ai_cost_analytics', periodSecs: 60, maxOps: 10,
        failOpen: true,
        errorMessage: '请求太频繁，请稍后再试',
      })) return;

      const domainId = getDomainId(this);

      const accept = this.request.headers.accept || '';
      const preferJson = accept.includes('application/json');

      const { period, date } = this.request.query as {
        period?: string;
        date?: string;
      };

      // 浏览器直接访问时返回模板
      if (!period && !preferJson) {
        this.response.template = 'ai-helper/cost_analytics.html';
        this.response.body = {};
        return;
      }

      const tokenUsageModel: TokenUsageModel = this.ctx.get('tokenUsageModel');
      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
      const aiConfig = await aiConfigModel.getConfig();

      const targetDate = date || new Date().toISOString().slice(0, 10);
      const validPeriod = (period === 'week' || period === 'month') ? period : 'day';

      // 计算日期范围
      const { startDate, endDate } = this.getDateRange(targetDate, validPeriod);

      // 并行查询各维度数据
      const today = new Date().toISOString().slice(0, 10);
      const yearMonth = today.slice(0, 7);

      const [
        todayUsage,
        monthlyUsage,
        dailyTrend,
        topUsers,
        modelBreakdown,
      ] = await Promise.all([
        tokenUsageModel.getDomainDailyUsage(domainId, today),
        tokenUsageModel.getDomainMonthlyUsage(domainId, yearMonth),
        tokenUsageModel.getDailyTrend(domainId, startDate, endDate),
        tokenUsageModel.getTopUsers(domainId, today, 10),
        tokenUsageModel.getModelBreakdown(domainId, startDate, endDate),
      ]);

      // 计算预算使用百分比
      let budgetUsagePercent: number | null = null;
      if (aiConfig?.budgetConfig?.dailyTokenLimitPerDomain && aiConfig.budgetConfig.dailyTokenLimitPerDomain > 0) {
        budgetUsagePercent = (todayUsage.totalTokens / aiConfig.budgetConfig.dailyTokenLimitPerDomain) * 100;
      }

      // 获取用户名映射
      const userIds = topUsers.map(u => u.userId);
      const userNameMap = await this.getUserNameMap(userIds);

      const enrichedTopUsers = topUsers.map(u => ({
        ...u,
        userName: userNameMap.get(u.userId) || `用户 ${u.userId}`,
      }));

      // 计算 period 汇总
      let periodTokens = 0;
      let periodCost = 0;
      let periodRequests = 0;
      for (const d of dailyTrend) {
        periodTokens += d.totalTokens;
        periodCost += d.totalCost;
        periodRequests += d.requestCount;
      }

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
        dailyTrend: dailyTrend.map(d => ({
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
    } catch (err) {
      console.error('[CostAnalyticsHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: '服务器内部错误' };
      this.response.type = 'application/json';
    }
  }

  private getDateRange(date: string, period: string): { startDate: string; endDate: string } {
    const d = new Date(date);
    let startDate: string;
    const endDate = date;

    if (period === 'month') {
      startDate = date.slice(0, 7) + '-01';
    } else if (period === 'week') {
      const weekAgo = new Date(d);
      weekAgo.setDate(weekAgo.getDate() - 6);
      startDate = weekAgo.toISOString().slice(0, 10);
    } else {
      // 默认显示近 30 天
      const monthAgo = new Date(d);
      monthAgo.setDate(monthAgo.getDate() - 29);
      startDate = monthAgo.toISOString().slice(0, 10);
    }

    return { startDate, endDate };
  }

  private async getUserNameMap(userIds: number[]): Promise<Map<number, string>> {
    const nameMap = new Map<number, string>();
    if (userIds.length === 0) return nameMap;

    try {
      const userColl = db.collection('user');
      const users = await userColl.find({ _id: { $in: userIds } }).toArray();
      for (const user of users) {
        nameMap.set(user._id as number, (user as Record<string, unknown>).uname as string || `用户 ${user._id}`);
      }
    } catch (err) {
      console.error('[CostAnalyticsHandler] Failed to fetch user names:', err);
    }

    return nameMap;
  }
}

export const CostAnalyticsHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
