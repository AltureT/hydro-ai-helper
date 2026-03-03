import { TokenUsageModel, RecordUsageParams } from '../../models/tokenUsage';

function createChainMock() {
  const mock: any = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    project: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return mock;
}

function createMockCollection() {
  const chainMock = createChainMock();
  return {
    createIndex: jest.fn(),
    insertOne: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn().mockReturnValue(chainMock),
    aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    _chain: chainMock,
  };
}

describe('TokenUsageModel', () => {
  let usageColl: ReturnType<typeof createMockCollection>;
  let dailyAggColl: ReturnType<typeof createMockCollection>;
  let model: TokenUsageModel;

  beforeEach(() => {
    usageColl = createMockCollection();
    dailyAggColl = createMockCollection();

    const mockDb = {
      collection: jest.fn((name: string) => {
        if (name === 'ai_token_usage') return usageColl;
        if (name === 'ai_usage_daily_agg') return dailyAggColl;
        throw new Error(`Unexpected collection: ${name}`);
      }),
    } as any;

    model = new TokenUsageModel(mockDb);
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── ensureIndexes ──────────────────────────────────

  describe('ensureIndexes', () => {
    it('should create indexes on both collections', async () => {
      await model.ensureIndexes();
      expect(usageColl.createIndex).toHaveBeenCalledTimes(4);
      expect(dailyAggColl.createIndex).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith('[TokenUsageModel] Indexes created successfully');
    });
  });

  // ─── recordUsage ────────────────────────────────────

  describe('recordUsage', () => {
    const baseParams: RecordUsageParams = {
      domainId: 'system',
      userId: 1,
      conversationId: 'conv-1' as any,
      messageId: 'msg-1' as any,
      endpointId: 'ep-1',
      endpointName: 'Test',
      modelName: 'gpt-4o-mini',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      questionType: 'understand',
      latencyMs: 500,
    };

    it('should insert fine-grained record with TTL expireAt', async () => {
      await model.recordUsage(baseParams);

      expect(usageColl.insertOne).toHaveBeenCalledTimes(1);
      const inserted = usageColl.insertOne.mock.calls[0][0];
      expect(inserted.domainId).toBe('system');
      expect(inserted.modelName).toBe('gpt-4o-mini');
      expect(inserted.expireAt).toBeInstanceOf(Date);
      const diffMs = inserted.expireAt.getTime() - inserted.timestamp.getTime();
      const diffDays = diffMs / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(90, 0);
    });

    it('should upsert daily aggregate with $inc', async () => {
      await model.recordUsage(baseParams);

      expect(dailyAggColl.updateOne).toHaveBeenCalledTimes(1);
      const [filter, update, options] = dailyAggColl.updateOne.mock.calls[0];

      const dateStr = new Date().toISOString().slice(0, 10);
      expect(filter._id).toBe(`system:1:${dateStr}`);

      expect(update.$inc.totalPromptTokens).toBe(100);
      expect(update.$inc.totalCompletionTokens).toBe(50);
      expect(update.$inc.totalTokens).toBe(150);
      expect(update.$inc.requestCount).toBe(1);

      expect(update.$set.domainId).toBe('system');
      expect(update.$set.userId).toBe(1);
      expect(update.$set.date).toBe(dateStr);

      expect(options.upsert).toBe(true);
    });

    it('should include estimatedCostUSD in inserted record', async () => {
      await model.recordUsage(baseParams);

      const inserted = usageColl.insertOne.mock.calls[0][0];
      expect(typeof inserted.estimatedCostUSD).toBe('number');
      expect(inserted.estimatedCostUSD).toBeGreaterThan(0);
    });

    it('should include classId when provided', async () => {
      await model.recordUsage({ ...baseParams, classId: 'class-A' });
      const inserted = usageColl.insertOne.mock.calls[0][0];
      expect(inserted.classId).toBe('class-A');
    });
  });

  // ─── getUserDailyUsage ──────────────────────────────

  describe('getUserDailyUsage', () => {
    it('should query by composite aggId', async () => {
      const mockResult = { _id: 'system:1:2025-06-01', totalTokens: 500 };
      dailyAggColl.findOne.mockResolvedValue(mockResult);

      const result = await model.getUserDailyUsage('system', 1, '2025-06-01');
      expect(result).toEqual(mockResult);
      expect(dailyAggColl.findOne).toHaveBeenCalledWith({ _id: 'system:1:2025-06-01' });
    });

    it('should return null when no record', async () => {
      dailyAggColl.findOne.mockResolvedValue(null);
      const result = await model.getUserDailyUsage('system', 1, '2025-06-01');
      expect(result).toBeNull();
    });
  });

  // ─── getDomainDailyUsage ────────────────────────────

  describe('getDomainDailyUsage', () => {
    it('should return aggregated usage', async () => {
      const aggToArray = jest.fn().mockResolvedValue([
        { totalTokens: 1000, totalCost: 0.05, requestCount: 10 },
      ]);
      dailyAggColl.aggregate.mockReturnValue({ toArray: aggToArray });

      const result = await model.getDomainDailyUsage('system', '2025-06-01');
      expect(result).toEqual({ totalTokens: 1000, totalCost: 0.05, requestCount: 10 });
    });

    it('should return zero defaults when no records', async () => {
      const aggToArray = jest.fn().mockResolvedValue([]);
      dailyAggColl.aggregate.mockReturnValue({ toArray: aggToArray });

      const result = await model.getDomainDailyUsage('system', '2025-06-01');
      expect(result).toEqual({ totalTokens: 0, totalCost: 0, requestCount: 0 });
    });

    it('should match by domainId and date', async () => {
      const aggToArray = jest.fn().mockResolvedValue([]);
      dailyAggColl.aggregate.mockReturnValue({ toArray: aggToArray });

      await model.getDomainDailyUsage('my-domain', '2025-06-01');
      const pipeline = dailyAggColl.aggregate.mock.calls[0][0];
      expect(pipeline[0].$match).toEqual({ domainId: 'my-domain', date: '2025-06-01' });
    });
  });

  // ─── getDomainMonthlyUsage ──────────────────────────

  describe('getDomainMonthlyUsage', () => {
    it('should aggregate with regex for yearMonth', async () => {
      const aggToArray = jest.fn().mockResolvedValue([
        { totalTokens: 5000, totalCost: 0.25, requestCount: 50 },
      ]);
      dailyAggColl.aggregate.mockReturnValue({ toArray: aggToArray });

      const result = await model.getDomainMonthlyUsage('system', '2025-06');
      expect(result).toEqual({ totalTokens: 5000, totalCost: 0.25, requestCount: 50 });

      const pipeline = dailyAggColl.aggregate.mock.calls[0][0];
      expect(pipeline[0].$match.date.$regex).toBe('^2025-06');
    });

    it('should return zero defaults when no records', async () => {
      const aggToArray = jest.fn().mockResolvedValue([]);
      dailyAggColl.aggregate.mockReturnValue({ toArray: aggToArray });

      const result = await model.getDomainMonthlyUsage('system', '2025-06');
      expect(result).toEqual({ totalTokens: 0, totalCost: 0, requestCount: 0 });
    });
  });

  // ─── getTopUsers ────────────────────────────────────

  describe('getTopUsers', () => {
    it('should return top users sorted by totalTokens', async () => {
      const users = [
        { userId: 1, totalTokens: 1000, requestCount: 10, estimatedCostUSD: 0.05 },
        { userId: 2, totalTokens: 500, requestCount: 5, estimatedCostUSD: 0.025 },
      ];
      dailyAggColl._chain.toArray.mockResolvedValue(users);

      const result = await model.getTopUsers('system', '2025-06-01', 5);
      expect(result).toEqual(users);
      expect(dailyAggColl.find).toHaveBeenCalledWith({ domainId: 'system', date: '2025-06-01' });
      expect(dailyAggColl._chain.sort).toHaveBeenCalledWith({ totalTokens: -1 });
      expect(dailyAggColl._chain.limit).toHaveBeenCalledWith(5);
    });

    it('should use default limit of 10', async () => {
      dailyAggColl._chain.toArray.mockResolvedValue([]);
      await model.getTopUsers('system', '2025-06-01');
      expect(dailyAggColl._chain.limit).toHaveBeenCalledWith(10);
    });
  });

  // ─── getDailyTrend ──────────────────────────────────

  describe('getDailyTrend', () => {
    it('should return daily trend data with correct pipeline', async () => {
      const trend = [
        { date: '2025-06-01', totalTokens: 100, totalCost: 0.01, requestCount: 5 },
      ];
      const aggToArray = jest.fn().mockResolvedValue(trend);
      dailyAggColl.aggregate.mockReturnValue({ toArray: aggToArray });

      const result = await model.getDailyTrend('system', '2025-06-01', '2025-06-30');
      expect(result).toEqual(trend);

      const pipeline = dailyAggColl.aggregate.mock.calls[0][0];
      expect(pipeline[0].$match).toEqual({
        domainId: 'system',
        date: { $gte: '2025-06-01', $lte: '2025-06-30' },
      });
      expect(pipeline[1].$group._id).toBe('$date');
    });
  });

  // ─── getModelBreakdown ──────────────────────────────

  describe('getModelBreakdown', () => {
    it('should query usageCollection with timestamp range', async () => {
      const breakdown = [
        { modelName: 'gpt-4o', totalTokens: 500, requestCount: 3, estimatedCostUSD: 0.05 },
      ];
      const aggToArray = jest.fn().mockResolvedValue(breakdown);
      usageColl.aggregate.mockReturnValue({ toArray: aggToArray });

      const result = await model.getModelBreakdown('system', '2025-06-01', '2025-06-30');
      expect(result).toEqual(breakdown);

      const pipeline = usageColl.aggregate.mock.calls[0][0];
      expect(pipeline[0].$match.domainId).toBe('system');
      expect(pipeline[0].$match.timestamp.$gte).toEqual(new Date('2025-06-01'));
      expect(pipeline[0].$match.timestamp.$lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    });
  });

  // ─── estimateCost (static) ──────────────────────────

  describe('estimateCost', () => {
    const P = 1000;
    const C = 500;

    it('should calculate gpt-4o-mini cost', () => {
      const cost = TokenUsageModel.estimateCost('gpt-4o-mini', P, C);
      expect(cost).toBeCloseTo(P * (0.15 / 1e6) + C * (0.60 / 1e6), 10);
    });

    it('should calculate gpt-4o cost', () => {
      const cost = TokenUsageModel.estimateCost('gpt-4o', P, C);
      expect(cost).toBeCloseTo(P * (2.50 / 1e6) + C * (10.00 / 1e6), 10);
    });

    it('should calculate gpt-4-turbo cost', () => {
      const cost = TokenUsageModel.estimateCost('gpt-4-turbo-preview', P, C);
      expect(cost).toBeCloseTo(P * (2.00 / 1e6) + C * (8.00 / 1e6), 10);
    });

    it('should calculate gpt-4-1 cost', () => {
      const cost = TokenUsageModel.estimateCost('gpt-4-1-preview', P, C);
      expect(cost).toBeCloseTo(P * (2.00 / 1e6) + C * (8.00 / 1e6), 10);
    });

    it('should calculate gpt-4 cost', () => {
      const cost = TokenUsageModel.estimateCost('gpt-4-0613', P, C);
      expect(cost).toBeCloseTo(P * (30.00 / 1e6) + C * (60.00 / 1e6), 10);
    });

    it('should calculate gpt-3.5 cost', () => {
      const cost = TokenUsageModel.estimateCost('gpt-3.5-turbo', P, C);
      expect(cost).toBeCloseTo(P * (0.50 / 1e6) + C * (1.50 / 1e6), 10);
    });

    it('should calculate deepseek cost', () => {
      const cost = TokenUsageModel.estimateCost('deepseek-chat', P, C);
      expect(cost).toBeCloseTo(P * (0.27 / 1e6) + C * (1.10 / 1e6), 10);
    });

    it('should calculate claude-3-5-sonnet cost', () => {
      const cost = TokenUsageModel.estimateCost('claude-3-5-sonnet-20240620', P, C);
      expect(cost).toBeCloseTo(P * (3.00 / 1e6) + C * (15.00 / 1e6), 10);
    });

    it('should calculate claude-sonnet cost', () => {
      const cost = TokenUsageModel.estimateCost('claude-sonnet-4', P, C);
      expect(cost).toBeCloseTo(P * (3.00 / 1e6) + C * (15.00 / 1e6), 10);
    });

    it('should calculate claude-3-haiku cost', () => {
      const cost = TokenUsageModel.estimateCost('claude-3-haiku-20240307', P, C);
      expect(cost).toBeCloseTo(P * (0.25 / 1e6) + C * (1.25 / 1e6), 10);
    });

    it('should calculate claude-haiku cost', () => {
      const cost = TokenUsageModel.estimateCost('claude-haiku-4', P, C);
      expect(cost).toBeCloseTo(P * (0.25 / 1e6) + C * (1.25 / 1e6), 10);
    });

    it('should calculate doubao cost', () => {
      const cost = TokenUsageModel.estimateCost('doubao-pro-128k', P, C);
      expect(cost).toBeCloseTo(P * (0.80 / 1e6) + C * (2.00 / 1e6), 10);
    });

    it('should calculate ep- (Volcengine endpoint) cost', () => {
      const cost = TokenUsageModel.estimateCost('ep-20241234567890', P, C);
      expect(cost).toBeCloseTo(P * (0.80 / 1e6) + C * (2.00 / 1e6), 10);
    });

    it('should calculate qwen cost', () => {
      const cost = TokenUsageModel.estimateCost('qwen-max', P, C);
      expect(cost).toBeCloseTo(P * (0.50 / 1e6) + C * (2.00 / 1e6), 10);
    });

    it('should calculate glm cost', () => {
      const cost = TokenUsageModel.estimateCost('glm-4', P, C);
      expect(cost).toBeCloseTo(P * (0.50 / 1e6) + C * (0.50 / 1e6), 10);
    });

    it('should use default pricing for unknown models', () => {
      const cost = TokenUsageModel.estimateCost('unknown-model-xyz', P, C);
      expect(cost).toBeCloseTo(P * (1.00 / 1e6) + C * (3.00 / 1e6), 10);
    });

    it('should be case-insensitive', () => {
      const cost1 = TokenUsageModel.estimateCost('GPT-4O-MINI', P, C);
      const cost2 = TokenUsageModel.estimateCost('gpt-4o-mini', P, C);
      expect(cost1).toBe(cost2);
    });
  });
});
