import { FeatureStatsModel } from '../../models/featureStats';

function createMockCollection() {
  return {
    createIndex: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn(),
  };
}

function createMockDb(collection: any) {
  return { collection: jest.fn().mockReturnValue(collection) } as any;
}

describe('FeatureStatsModel', () => {
  let mockColl: ReturnType<typeof createMockCollection>;
  let model: FeatureStatsModel;

  beforeEach(() => {
    mockColl = createMockCollection();
    model = new FeatureStatsModel(createMockDb(mockColl));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ensureIndexes', () => {
    it('should create a TTL index on updatedAt', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { updatedAt: 1 },
        expect.objectContaining({ expireAfterSeconds: expect.any(Number) }),
      );
    });
  });

  describe('recordAttempt', () => {
    it('should $inc attemptCount on the per-day per-feature doc', async () => {
      await model.recordAttempt('teaching_summary');
      expect(mockColl.updateOne).toHaveBeenCalledTimes(1);
      const [filter, update, opts] = mockColl.updateOne.mock.calls[0];
      expect(String(filter._id)).toMatch(/:teaching_summary$/);
      expect(update.$inc).toEqual({ attemptCount: 1 });
      expect(update.$set).toMatchObject({ feature: 'teaching_summary' });
      expect(opts).toEqual({ upsert: true });
    });
  });

  describe('recordSuccess', () => {
    it('should $inc successCount and set lastSuccessAt', async () => {
      await model.recordSuccess('batch_summary');
      const [, update] = mockColl.updateOne.mock.calls[0];
      expect(update.$inc).toEqual({ successCount: 1 });
      expect(update.$set.lastSuccessAt).toBeInstanceOf(Date);
    });
  });

  describe('getStats24h', () => {
    it('should map today’s docs to the wire shape', async () => {
      const lastSuccess = new Date('2026-06-24T10:00:00Z');
      mockColl.find.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { feature: 'teaching_summary', attemptCount: 5, successCount: 0, lastSuccessAt: null },
          { feature: 'batch_summary', attemptCount: 3, successCount: 3, lastSuccessAt: lastSuccess },
        ]),
      });

      const stats = await model.getStats24h();

      expect(stats).toEqual([
        { feature: 'teaching_summary', attempts: 5, successes: 0, lastSuccessAt: null },
        { feature: 'batch_summary', attempts: 3, successes: 3, lastSuccessAt: lastSuccess },
      ]);
    });

    it('should return an empty array when no docs exist today', async () => {
      mockColl.find.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
      expect(await model.getStats24h()).toEqual([]);
    });
  });

  describe('getStatsRecentDays', () => {
    it('should query the last N UTC dates and include the date in results', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      mockColl.find.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { date: today, feature: 'student_chat', attemptCount: 4, successCount: 4, lastSuccessAt: null },
          { date: yesterday, feature: 'student_chat', attemptCount: 20, successCount: 19, lastSuccessAt: null },
          { date: yesterday, feature: 'testdata_generation', attemptCount: 2, successCount: 2, lastSuccessAt: null },
        ]),
      });

      const stats = await model.getStatsRecentDays(2);

      // 查询条件覆盖今天与昨天两个 UTC 日期
      const [filter] = mockColl.find.mock.calls[0];
      expect(filter.date.$in).toEqual([today, yesterday]);
      // 结果按日区分（供平台按 (date, feature) 取最大值累计）
      expect(stats).toHaveLength(3);
      expect(stats[0]).toMatchObject({ date: today, feature: 'student_chat', attempts: 4 });
      expect(stats[1]).toMatchObject({ date: yesterday, feature: 'student_chat', attempts: 20, successes: 19 });
    });
  });
});
