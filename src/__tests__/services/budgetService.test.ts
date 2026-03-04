import { BudgetService, BudgetCheckResult } from '../../services/budgetService';
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
