import { CostAnalyticsHandler } from '../../handlers/costAnalyticsHandler';

function makeHandler(reviewRunModel?: unknown, query: Record<string, string> = { period: 'week', date: '2026-11-10' }) {
  const handler = new CostAnalyticsHandler();
  const zero = { totalTokens: 0, totalCost: 0, requestCount: 0 };
  const tokenUsageModel = {
    getDomainDailyUsage: jest.fn().mockResolvedValue(zero),
    getDomainMonthlyUsage: jest.fn().mockResolvedValue(zero),
    getDailyTrend: jest.fn().mockResolvedValue([]),
    getTopUsersByDateRange: jest.fn().mockResolvedValue([]),
    getModelBreakdown: jest.fn().mockResolvedValue([]),
  };
  const services: Record<string, unknown> = {
    tokenUsageModel,
    aiConfigModel: { getConfig: jest.fn().mockResolvedValue(null) },
    reviewRunModel,
  };
  handler.request = { headers: { accept: 'application/json' }, query };
  handler.response = {};
  handler.args = { domainId: 'oi2023' };
  (handler as any).limitRate = jest.fn().mockResolvedValue(undefined);
  (handler as any).translate = (key: string) => key;
  handler.ctx = { Route: jest.fn(), get: (name: string) => services[name] } as any;
  return handler;
}

describe('CostAnalyticsHandler AI review row (FR-049)', () => {
  it('adds the AI review cost for the selected period, separate from student usage', async () => {
    const reviewRunModel = { costBetween: jest.fn().mockResolvedValue({ totalTokens: 410000, totalCost: 0.61234, runCount: 2 }) };
    const handler = makeHandler(reviewRunModel);
    await handler.get();
    expect(reviewRunModel.costBetween).toHaveBeenCalledTimes(1);
    const [from, to] = reviewRunModel.costBetween.mock.calls[0];
    expect(to.getTime() - from.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(handler.response.body.aiReview).toEqual({ totalTokens: 410000, totalCost: 0.6123, runCount: 2 });
    expect(handler.response.body.summary.totalTokens).toBe(0);
  });

  it('returns null when runs cannot be read', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = makeHandler({ costBetween: jest.fn().mockRejectedValue(new Error('Synthetic failure')) });
    await failing.get();
    expect(failing.response.body.aiReview).toBeNull();
    const missing = makeHandler(undefined);
    await missing.get();
    expect(missing.response.body.aiReview).toBeNull();
  });
});
