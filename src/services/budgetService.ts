/**
 * BudgetService - Token 预算控制服务
 *
 * 两级机制:
 * - 软限 (默认 80%): allowed=true + warning
 * - 硬限 (100%): allowed=false + reason
 */

import { TokenUsageModel } from '../models/tokenUsage';
import { BudgetConfig } from '../models/aiConfig';

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  reasonKey?: string;
  reasonParams?: (string | number)[];
  warning?: string;
  warningKey?: string;
  warningParams?: (string | number)[];
  remaining?: number;
}

/**
 * 按用户/用户组策略解析出的个人额度覆盖（见 accessPolicyService）
 */
export interface UserBudgetOverride {
  /** 覆盖 budgetConfig.dailyTokenLimitPerUser；undefined = 沿用域默认，0 = 不限 */
  dailyTokenLimitPerUser?: number;
  /** 今日追加额度，叠加在生效的个人日上限之上（上限为 0/不限时无意义） */
  extraTokens?: number;
}

/**
 * 计算生效的个人日上限：覆盖值优先，> 0 时叠加今日追加额度；0 = 不限
 */
export function effectiveUserDailyLimit(budgetConfig: BudgetConfig, override?: UserBudgetOverride): number {
  const base = override?.dailyTokenLimitPerUser ?? budgetConfig.dailyTokenLimitPerUser ?? 0;
  if (!base || base <= 0) return 0;
  return base + Math.max(0, override?.extraTokens ?? 0);
}

export class BudgetService {
  constructor(private tokenUsageModel: TokenUsageModel) {}

  async checkBudget(
    domainId: string,
    userId: number,
    budgetConfig: BudgetConfig,
    override?: UserBudgetOverride,
  ): Promise<BudgetCheckResult> {
    const today = new Date().toISOString().slice(0, 10);
    const softPercent = budgetConfig.softLimitPercent ?? 80;
    let warning: BudgetCheckResult | undefined;

    // 1. 检查用户日限额（域默认，或按用户/用户组策略覆盖；域日/月限额仍然叠加生效）
    const userDailyLimit = effectiveUserDailyLimit(budgetConfig, override);
    if (userDailyLimit > 0) {
      const userUsage = await this.tokenUsageModel.getUserDailyUsage(domainId, userId, today);
      const used = userUsage?.totalTokens ?? 0;
      const limit = userDailyLimit;

      if (used >= limit) {
        return {
          allowed: false,
          reason: `今天的 AI 额度已用完（已使用 ${used.toLocaleString()} / ${limit.toLocaleString()} tokens）`,
          reasonKey: 'ai_helper_budget_user_daily_exceeded',
          reasonParams: [used.toLocaleString(), limit.toLocaleString()],
          remaining: 0,
        };
      }

      const softThreshold = Math.floor(limit * softPercent / 100);
      if (used >= softThreshold) {
        const remaining = limit - used;
        warning = {
          allowed: true,
          warning: `AI 额度即将用尽（剩余约 ${remaining.toLocaleString()} tokens）`,
          warningKey: 'ai_helper_budget_user_daily_warning',
          warningParams: [remaining.toLocaleString()],
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
          reasonKey: 'ai_helper_budget_domain_daily_exceeded',
          remaining: 0,
        };
      }

      const softThreshold = Math.floor(limit * softPercent / 100);
      if (used >= softThreshold && !warning) {
        warning = {
          allowed: true,
          warning: '全站 AI 额度即将用尽，请节约使用',
          warningKey: 'ai_helper_budget_domain_daily_warning',
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
          reasonKey: 'ai_helper_budget_domain_monthly_exceeded',
          remaining: 0,
        };
      }

      const softThreshold = Math.floor(limit * softPercent / 100);
      if (used >= softThreshold && !warning) {
        warning = {
          allowed: true,
          warning: '本月全站 AI 额度即将用尽',
          warningKey: 'ai_helper_budget_domain_monthly_warning',
        };
      }
    }

    return warning ?? { allowed: true };
  }
}
