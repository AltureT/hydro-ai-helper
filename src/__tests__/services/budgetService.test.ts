import { BudgetService, BudgetCheckResult, effectiveUserDailyLimit } from '../../services/budgetService';
import { BudgetConfig } from '../../models/aiConfig';

function createMockTokenUsageModel(overrides: Record<string, any> = {}) {
  return {
    getUserDailyUsage: jest.fn().mockResolvedValue(null),
    getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 0 }),
    getDomainMonthlyUsage: jest.fn().mockResolvedValue({ totalTokens: 0 }),
    ...overrides,
  } as any;
}

describe('BudgetService', () => {
  describe('checkBudget — user daily limit', () => {
    it('should allow when user has no usage', async () => {
      const model = createMockTokenUsageModel();
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 10000,
      });

      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should block when user exceeds daily limit', async () => {
      const model = createMockTokenUsageModel({
        getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 10000 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 10000,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('额度已用完');
      expect(result.remaining).toBe(0);
    });

    it('should warn when user reaches soft limit (80%)', async () => {
      const model = createMockTokenUsageModel({
        getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 8500 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 10000,
      });

      expect(result.allowed).toBe(true);
      expect(result.warning).toContain('即将用尽');
      expect(result.remaining).toBe(1500);
    });

    it('should use custom soft limit percent', async () => {
      const model = createMockTokenUsageModel({
        getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 5500 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 10000,
        softLimitPercent: 50,
      });

      expect(result.allowed).toBe(true);
      expect(result.warning).toContain('即将用尽');
    });

    it('should skip check when limit is 0', async () => {
      const model = createMockTokenUsageModel();
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 0,
      });

      expect(result.allowed).toBe(true);
      expect(model.getUserDailyUsage).not.toHaveBeenCalled();
    });
  });

  describe('checkBudget — domain daily limit', () => {
    it('should block when domain exceeds daily limit', async () => {
      const model = createMockTokenUsageModel({
        getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 500000 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerDomain: 500000,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('全站');
    });

    it('should warn when domain reaches soft limit', async () => {
      const model = createMockTokenUsageModel({
        getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 420000 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerDomain: 500000,
      });

      expect(result.allowed).toBe(true);
      expect(result.warning).toContain('全站');
    });
  });

  describe('checkBudget — domain monthly limit', () => {
    it('should block when domain exceeds monthly limit', async () => {
      const model = createMockTokenUsageModel({
        getDomainMonthlyUsage: jest.fn().mockResolvedValue({ totalTokens: 5000000 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        monthlyTokenLimitPerDomain: 5000000,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('本月');
    });

    it('should warn when domain monthly nears limit', async () => {
      const model = createMockTokenUsageModel({
        getDomainMonthlyUsage: jest.fn().mockResolvedValue({ totalTokens: 4200000 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        monthlyTokenLimitPerDomain: 5000000,
      });

      expect(result.allowed).toBe(true);
      expect(result.warning).toContain('本月');
    });
  });

  describe('checkBudget — priority order', () => {
    it.each(['daily', 'monthly'])('should enforce domain %s hard limits after a user warning', async (period) => {
      const model = createMockTokenUsageModel({
        getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 850 }),
        getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: period === 'daily' ? 2000 : 850 }),
        getDomainMonthlyUsage: jest.fn().mockResolvedValue({ totalTokens: 2000 }),
      });
      const result = await new BudgetService(model).checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 1000,
        dailyTokenLimitPerDomain: 1000,
        monthlyTokenLimitPerDomain: 1000,
      });
      expect(result.allowed).toBe(false);
      expect(result.reasonKey).toBe(`ai_helper_budget_domain_${period}_exceeded`);
    });

    it('should enforce the monthly hard limit after a domain daily warning', async () => {
      const model = createMockTokenUsageModel({
        getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 850 }),
        getDomainMonthlyUsage: jest.fn().mockResolvedValue({ totalTokens: 2000 }),
      });
      const result = await new BudgetService(model).checkBudget('domain1', 1001, {
        dailyTokenLimitPerDomain: 1000,
        monthlyTokenLimitPerDomain: 1000,
      });
      expect(result.allowed).toBe(false);
      expect(result.reasonKey).toBe('ai_helper_budget_domain_monthly_exceeded');
    });

    it('should retain the first warning after checking all configured limits', async () => {
      const model = createMockTokenUsageModel({
        getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 850 }),
        getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 900 }),
        getDomainMonthlyUsage: jest.fn().mockResolvedValue({ totalTokens: 950 }),
      });
      const result = await new BudgetService(model).checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 1000,
        dailyTokenLimitPerDomain: 1000,
        monthlyTokenLimitPerDomain: 1000,
      });
      expect(result.allowed).toBe(true);
      expect(result.warningKey).toBe('ai_helper_budget_user_daily_warning');
      expect(model.getDomainDailyUsage).toHaveBeenCalledWith('domain1', expect.any(String));
      expect(model.getDomainMonthlyUsage).toHaveBeenCalledWith('domain1', expect.any(String));
    });

    it('should check user limit before domain limit', async () => {
      const model = createMockTokenUsageModel({
        getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 10000 }),
        getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 0 }),
      });
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {
        dailyTokenLimitPerUser: 10000,
        dailyTokenLimitPerDomain: 1000000,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('额度已用完');
      // Domain check should not have been called since user limit already blocked
      expect(model.getDomainDailyUsage).not.toHaveBeenCalled();
    });

    it('should return allowed when no limits configured', async () => {
      const model = createMockTokenUsageModel();
      const service = new BudgetService(model);

      const result = await service.checkBudget('domain1', 1001, {});

      expect(result.allowed).toBe(true);
    });
  });
});

describe('BudgetService — per-user overrides from access policies', () => {
  it('uses the override limit instead of the domain default', async () => {
    const model = createMockTokenUsageModel({
      getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 1500 }),
    });
    const service = new BudgetService(model);

    const raised = await service.checkBudget('domain1', 1001, { dailyTokenLimitPerUser: 1000 }, { dailyTokenLimitPerUser: 5000 });
    expect(raised.allowed).toBe(true);

    const lowered = await service.checkBudget('domain1', 1001, { dailyTokenLimitPerUser: 10000 }, { dailyTokenLimitPerUser: 1000 });
    expect(lowered.allowed).toBe(false);
    expect(lowered.reasonParams).toEqual(['1,500', '1,000']);
  });

  it('treats an override of 0 as unlimited even when the domain default is limited', async () => {
    const getUserDailyUsage = jest.fn().mockResolvedValue({ totalTokens: 999999 });
    const service = new BudgetService(createMockTokenUsageModel({ getUserDailyUsage }));
    const result = await service.checkBudget('domain1', 1001, { dailyTokenLimitPerUser: 1000 }, { dailyTokenLimitPerUser: 0 });
    expect(result.allowed).toBe(true);
    expect(getUserDailyUsage).not.toHaveBeenCalled();
  });

  it('adds today\'s extra tokens on top of the effective limit', async () => {
    const model = createMockTokenUsageModel({
      getUserDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 1200 }),
    });
    const service = new BudgetService(model);
    const result = await service.checkBudget('domain1', 1001, { dailyTokenLimitPerUser: 1000 }, { extraTokens: 500 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(300);
  });

  it('still enforces domain caps for users with a raised limit', async () => {
    const model = createMockTokenUsageModel({
      getDomainDailyUsage: jest.fn().mockResolvedValue({ totalTokens: 50000 }),
    });
    const service = new BudgetService(model);
    const result = await service.checkBudget('domain1', 1001, {
      dailyTokenLimitPerUser: 1000, dailyTokenLimitPerDomain: 50000,
    }, { dailyTokenLimitPerUser: 0, extraTokens: 100000 });
    expect(result.allowed).toBe(false);
    expect(result.reasonKey).toBe('ai_helper_budget_domain_daily_exceeded');
  });

  it('computes the effective limit for display', () => {
    expect(effectiveUserDailyLimit({ dailyTokenLimitPerUser: 1000 })).toBe(1000);
    expect(effectiveUserDailyLimit({ dailyTokenLimitPerUser: 1000 }, { extraTokens: 50 })).toBe(1050);
    expect(effectiveUserDailyLimit({}, { extraTokens: 50 })).toBe(0);
    expect(effectiveUserDailyLimit({ dailyTokenLimitPerUser: 1000 }, { dailyTokenLimitPerUser: 0, extraTokens: 50 })).toBe(0);
  });
});
