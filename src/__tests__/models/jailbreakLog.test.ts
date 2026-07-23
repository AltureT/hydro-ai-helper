jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: any) => id),
}));

import {
  JailbreakLogModel,
  resolveJailbreakLogRetentionDays,
  sanitizeSafetyLogSnippet,
} from '../../models/jailbreakLog';

function createChainMock() {
  const mock: any = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return mock;
}

function createMockCollection() {
  const chainMock = createChainMock();
  const aggregateChain = { toArray: jest.fn().mockResolvedValue([]) };
  return {
    createIndex: jest.fn(),
    insertOne: jest.fn(),
    find: jest.fn().mockReturnValue(chainMock),
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
    findOneAndUpdate: jest.fn(),
    aggregate: jest.fn().mockReturnValue(aggregateChain),
    _chain: chainMock,
    _aggregateChain: aggregateChain,
  };
}

function createMockDb(collection: any) {
  return { collection: jest.fn().mockReturnValue(collection) } as any;
}

describe('JailbreakLogModel', () => {
  let mockColl: ReturnType<typeof createMockCollection>;
  let model: JailbreakLogModel;

  beforeEach(() => {
    mockColl = createMockCollection();
    model = new JailbreakLogModel(createMockDb(mockColl));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ensureIndexes', () => {
    it('should create tenant-aware query and cooldown indexes', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledTimes(9);
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, userId: 1, createdAt: -1 },
        { name: 'idx_domain_user_createdAt' }
      );
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, createdAt: -1 },
        { name: 'idx_domain_createdAt' }
      );
      expect(console.log).toHaveBeenCalledWith('[JailbreakLogModel] Indexes ensured');
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, reviewStatus: 1, category: 1, createdAt: -1 },
        { name: 'idx_domain_review_category_createdAt' }
      );
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { expiresAt: 1 },
        { name: 'idx_expiresAt_ttl', expireAfterSeconds: 0 }
      );
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, studentAppealedAt: -1, createdAt: -1 },
        { name: 'idx_domain_appealed_createdAt' }
      );
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, problemId: 1, createdAt: -1 },
        { name: 'idx_domain_problem_createdAt' }
      );
    });
  });

  describe('create', () => {
    it('should insert and return insertedId', async () => {
      mockColl.insertOne.mockResolvedValue({ insertedId: 'log-1' });

      const result = await model.create({
        matchedPattern: 'test-pattern',
        matchedText: 'matched text',
      });
      expect(result).toBe('log-1');
      expect(mockColl.insertOne).toHaveBeenCalledTimes(1);
      expect(mockColl.insertOne.mock.calls[0][0].reviewStatus).toBe('pending');
      expect(mockColl.insertOne.mock.calls[0][0].expiresAt).toBeInstanceOf(Date);
    });

    it('should include optional fields when provided', async () => {
      mockColl.insertOne.mockResolvedValue({ insertedId: 'log-2' });

      await model.create({
        domainId: 'domain-a',
        userId: 42,
        problemId: 'P1001',
        conversationId: 'conv-1',
        questionType: 'debug',
        matchedPattern: 'pattern',
        matchedText: 'text',
        category: 'prompt_injection',
        riskScore: 85,
        actionTaken: 'blocked',
      });

      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted.userId).toBe(42);
      expect(inserted.domainId).toBe('domain-a');
      expect(inserted.problemId).toBe('P1001');
      expect(inserted.conversationId).toBe('conv-1');
      expect(inserted.questionType).toBe('debug');
      expect(inserted.category).toBe('prompt_injection');
      expect(inserted.riskScore).toBe(85);
    });

    it('should leave conversationId undefined when not provided', async () => {
      mockColl.insertOne.mockResolvedValue({ insertedId: 'log-3' });

      await model.create({ matchedPattern: 'p', matchedText: 't' });
      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted.conversationId).toBeUndefined();
    });

    it('should use provided createdAt or default to now', async () => {
      mockColl.insertOne.mockResolvedValue({ insertedId: 'log-4' });
      const customDate = new Date('2025-01-01');

      await model.create({ matchedPattern: 'p', matchedText: 't', createdAt: customDate });
      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted.createdAt).toEqual(customDate);
    });

    it('should default createdAt to now when not provided', async () => {
      mockColl.insertOne.mockResolvedValue({ insertedId: 'log-5' });
      const before = new Date();

      await model.create({ matchedPattern: 'p', matchedText: 't' });
      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('privacy and retention', () => {
    it('redacts common sensitive values and caps stored snippets', () => {
      const snippet = sanitizeSafetyLogSnippet(
        `mail test@example.com phone 13812345678 id 330106199001011234 key sk-abcdefghijklmnop ${'x'.repeat(400)}`
      );

      expect(snippet).toContain('[email]');
      expect(snippet).toContain('[phone]');
      expect(snippet).toContain('[id]');
      expect(snippet).toContain('[secret]');
      expect(snippet.length).toBeLessThanOrEqual(256);
    });

    it('resolves retention days with safe defaults and bounds', () => {
      expect(resolveJailbreakLogRetentionDays(undefined)).toBe(180);
      expect(resolveJailbreakLogRetentionDays('invalid')).toBe(180);
      expect(resolveJailbreakLogRetentionDays('1')).toBe(7);
      expect(resolveJailbreakLogRetentionDays('5000')).toBe(3650);
      expect(resolveJailbreakLogRetentionDays('45.9')).toBe(45);
    });

    it('stores a redacted snippet and expiry based on creation time', async () => {
      const retentionModel = new JailbreakLogModel(createMockDb(mockColl), 30);
      const createdAt = new Date('2026-07-01T00:00:00Z');
      mockColl.insertOne.mockResolvedValue({ insertedId: 'retained-log' });

      await retentionModel.create({
        matchedPattern: 'pattern',
        matchedText: 'contact test@example.com',
        createdAt,
      });

      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted.matchedText).toBe('contact [email]');
      expect(inserted.expiresAt).toEqual(new Date('2026-07-31T00:00:00Z'));
    });

    it('backfills one gradual expiry for legacy logs', async () => {
      const retentionModel = new JailbreakLogModel(createMockDb(mockColl), 30);
      const now = new Date('2026-07-01T00:00:00Z');
      mockColl.updateMany.mockResolvedValue({ modifiedCount: 4 });

      await expect(retentionModel.backfillExpiry(now)).resolves.toBe(4);
      expect(mockColl.updateMany).toHaveBeenCalledWith(
        { expiresAt: { $exists: false } },
        { $set: { expiresAt: new Date('2026-07-31T00:00:00Z') } }
      );
    });
  });

  describe('listRecent', () => {
    it('should return recent logs sorted by createdAt desc', async () => {
      const logs = [{ _id: '1' }, { _id: '2' }];
      mockColl._chain.toArray.mockResolvedValue(logs);

      const result = await model.listRecent(10);
      expect(result).toEqual(logs);
      expect(mockColl._chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(mockColl._chain.limit).toHaveBeenCalledWith(10);
    });

    it('should use default limit of 20', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      await model.listRecent();
      expect(mockColl._chain.limit).toHaveBeenCalledWith(20);
    });

    it('should scope recent logs to the requested domain', async () => {
      await model.listRecent(20, 'domain-a');
      expect(mockColl.find).toHaveBeenCalledWith({ domainId: 'domain-a' });
    });
  });

  describe('penalty queries', () => {
    it('should atomically keep a sliding ten-minute window across wall-clock boundaries', async () => {
      const now = new Date('2026-07-23T10:01:00Z');
      mockColl.findOneAndUpdate.mockResolvedValue({
        _id: 'domain-a:42:answer_seeking',
        count: 2,
      });

      const sequence = await model.nextPenaltySequence('domain-a', 42, 'answer_seeking', now);

      expect(sequence.currentCount).toBe(2);
      const [filter, pipeline, options] = mockColl.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ _id: 'domain-a:42:answer_seeking' });
      expect(pipeline[0].$set.events.$concatArrays[0].$filter.cond).toEqual({
        $gte: ['$$event.at', new Date('2026-07-23T09:51:00Z')],
      });
      expect(options).toEqual({ upsert: true, returnDocument: 'after' });
    });

    it('should count high-confidence events by domain, user and category', async () => {
      mockColl.countDocuments.mockResolvedValue(2);
      const since = new Date('2026-07-23T00:00:00Z');

      const count = await model.countRecentByCategories(
        'domain-a',
        42,
        ['prompt_injection', 'prompt_exfiltration'],
        since
      );

      expect(count).toBe(2);
      expect(mockColl.countDocuments).toHaveBeenCalledWith({
        domainId: 'domain-a',
        userId: 42,
        category: { $in: ['prompt_injection', 'prompt_exfiltration'] },
        confidence: 'high',
        reviewStatus: { $ne: 'false_positive' },
        createdAt: { $gte: since },
      });
    });

    it('should find only active cooldowns in the same domain', async () => {
      const now = new Date('2026-07-23T00:00:00Z');
      mockColl.findOne.mockResolvedValue({ blockedUntil: new Date('2026-07-23T00:01:00Z') });

      const result = await model.findActiveCooldown('domain-a', 42, now);

      expect(result).toBeTruthy();
      expect(mockColl.findOne).toHaveBeenCalledWith(
        {
          domainId: 'domain-a',
          userId: 42,
          blockedUntil: { $gt: now },
          reviewStatus: { $ne: 'false_positive' },
        },
        { sort: { blockedUntil: -1 } }
      );
    });
  });

  describe('review', () => {
    it('should confirm a log only within the requested domain', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue({ _id: 'log-1' });
      const reviewedAt = new Date('2026-07-23T01:00:00Z');

      const result = await model.review('log-1', 'domain-a', 'confirmed', 7, reviewedAt);

      expect(result).toBe(true);
      expect(mockColl.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: 'log-1',
          domainId: 'domain-a',
          $or: [
            { reviewStatus: 'pending' },
            { reviewStatus: { $exists: false } },
          ],
        },
        { $set: { reviewStatus: 'confirmed', reviewedAt, reviewedBy: 7 } },
        { returnDocument: 'before' }
      );
    });

    it('should cancel the cooldown when a log is marked false positive', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue({ _id: 'log-2' });

      await model.review('log-2', 'domain-a', 'false_positive', 7);

      expect(mockColl.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'log-2', domainId: 'domain-a' }),
        expect.objectContaining({
          $set: expect.objectContaining({ reviewStatus: 'false_positive', reviewedBy: 7 }),
          $unset: { blockedUntil: '' },
        }),
        { returnDocument: 'before' }
      );
    });

    it('should roll back the atomic penalty counter when a log is marked false positive', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue({
        _id: 'log-2',
        penaltyCounterId: 'counter-1',
        penaltyEventId: 'event-1',
      });
      mockColl.updateOne.mockResolvedValue({ matchedCount: 1 });

      await model.review('log-2', 'domain-a', 'false_positive', 7);

      expect(mockColl.updateOne).toHaveBeenLastCalledWith(
        { _id: 'counter-1' },
        expect.arrayContaining([
          expect.objectContaining({ $set: expect.objectContaining({ events: expect.any(Object) }) }),
        ])
      );
    });

    it('should report when no pending domain-scoped log was found', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue(null);
      await expect(model.review('missing', 'domain-a', 'confirmed', 7)).resolves.toBe(false);
    });

    it('should bulk review each pending ID through an atomic terminal transition', async () => {
      mockColl.findOneAndUpdate
        .mockResolvedValueOnce({ _id: 'log-1' })
        .mockResolvedValueOnce({ _id: 'log-2' });
      const reviewedAt = new Date('2026-07-23T01:00:00Z');

      const result = await model.reviewMany(
        ['log-1', 'log-2'],
        'domain-a',
        'false_positive',
        7,
        reviewedAt
      );

      expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
      expect(mockColl.findOneAndUpdate).toHaveBeenCalledTimes(2);
    });

    it('should allow a student to appeal only their own pending unappealed log', async () => {
      mockColl.updateOne.mockResolvedValue({ matchedCount: 1 });
      const appealedAt = new Date('2026-07-23T02:00:00Z');

      const result = await model.appealByStudent(
        'log-3',
        'domain-a',
        42,
        'contact test@example.com',
        appealedAt
      );

      expect(result).toBe('submitted');
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        {
          _id: 'log-3',
          domainId: 'domain-a',
          userId: 42,
          $or: [
            { reviewStatus: 'pending' },
            { reviewStatus: { $exists: false } },
          ],
          studentAppealedAt: { $exists: false },
        },
        {
          $set: {
            studentAppealedAt: appealedAt,
            studentAppealReason: 'contact [email]',
          },
        }
      );
    });

    it('should treat retrying an existing own pending appeal as idempotent success', async () => {
      mockColl.updateOne.mockResolvedValue({ matchedCount: 0 });
      mockColl.findOne.mockResolvedValue({ _id: 'log-4', studentAppealedAt: new Date() });

      await expect(model.appealByStudent('log-4', 'domain-a', 42)).resolves.toBe('already_submitted');
      expect(mockColl.findOne).toHaveBeenCalledWith(expect.objectContaining({
        _id: 'log-4',
        domainId: 'domain-a',
        userId: 42,
        studentAppealedAt: { $exists: true },
      }));
    });
  });

  describe('listWithPagination', () => {
    it('should return paginated results with metadata', async () => {
      const logs = [{ _id: '1' }];
      mockColl._chain.toArray.mockResolvedValue(logs);
      mockColl.countDocuments.mockResolvedValue(25);

      const result = await model.listWithPagination(2, 10);
      expect(result.logs).toEqual(logs);
      expect(result.total).toBe(25);
      expect(result.page).toBe(2);
      expect(result.totalPages).toBe(3);
      expect(mockColl._chain.skip).toHaveBeenCalledWith(10);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(10);
    });

    it('should clamp page to minimum 1', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);

      const result = await model.listWithPagination(0, 10);
      expect(result.page).toBe(1);
    });

    it('should clamp limit to maximum 100', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);

      await model.listWithPagination(1, 200);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(100);
    });

    it('should use defaults when no args', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);

      await model.listWithPagination();
      expect(mockColl._chain.skip).toHaveBeenCalledWith(0);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(20);
    });

    it('should scope pagination and totals to one domain', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);

      await model.listWithPagination(1, 20, 'domain-a');

      expect(mockColl.find).toHaveBeenCalledWith({ domainId: 'domain-a' });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ domainId: 'domain-a' });
    });

    it('should filter pending legacy and current logs by category', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);

      await model.listWithPagination(1, 20, 'domain-a', {
        reviewStatus: 'pending',
        category: 'prompt_injection',
      });

      const expectedFilter = {
        domainId: 'domain-a',
        category: 'prompt_injection',
        $or: [
          { reviewStatus: 'pending' },
          { reviewStatus: { $exists: false } },
        ],
      };
      expect(mockColl.find).toHaveBeenCalledWith(expectedFilter);
      expect(mockColl.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });

    it('should filter confirmed logs directly', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);

      await model.listWithPagination(1, 20, 'domain-a', { reviewStatus: 'confirmed' });

      expect(mockColl.find).toHaveBeenCalledWith({
        domainId: 'domain-a',
        reviewStatus: 'confirmed',
      });
    });

    it('should expose a queue containing only pending student appeals', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);

      await model.listWithPagination(1, 20, 'domain-a', { appealedOnly: true });

      const expectedFilter = {
        domainId: 'domain-a',
        studentAppealedAt: { $exists: true },
        $or: [
          { reviewStatus: 'pending' },
          { reviewStatus: { $exists: false } },
        ],
      };
      expect(mockColl.find).toHaveBeenCalledWith(expectedFilter);
      expect(mockColl.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });

    it('should combine exact identity, action, source and UTC date filters', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      mockColl.countDocuments.mockResolvedValue(0);
      const createdFrom = new Date('2026-07-01T00:00:00.000Z');
      const createdTo = new Date('2026-07-23T23:59:59.999Z');

      await model.listWithPagination(1, 20, 'domain-a', {
        userId: 42,
        problemId: 'P1001',
        actionTaken: 'cooldown_5m',
        detectionSource: 'conversation',
        createdFrom,
        createdTo,
      });

      expect(mockColl.find).toHaveBeenCalledWith({
        domainId: 'domain-a',
        userId: 42,
        problemId: 'P1001',
        actionTaken: 'cooldown_5m',
        detectionSource: 'conversation',
        createdAt: { $gte: createdFrom, $lte: createdTo },
      });
    });

    it('should cap CSV export queries and preserve domain filters', async () => {
      mockColl._chain.toArray.mockResolvedValue([{ _id: '1' }]);
      mockColl.countDocuments.mockResolvedValue(6000);

      await expect(model.listForExport('domain-a', { userId: 42 }, 99999)).resolves.toEqual({
        logs: [{ _id: '1' }],
        total: 6000,
        truncated: true,
      });
      expect(mockColl.find).toHaveBeenCalledWith({ domainId: 'domain-a', userId: 42 });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ domainId: 'domain-a', userId: 42 });
      expect(mockColl._chain.limit).toHaveBeenCalledWith(5000);
    });
  });

  describe('getReviewSummary', () => {
    it('should calculate a domain-scoped false-positive rate from reviewed logs', async () => {
      mockColl.countDocuments
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(8)
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2);

      const summary = await model.getReviewSummary('domain-a');

      expect(summary).toEqual({
        total: 20,
        pending: 8,
        confirmed: 9,
        falsePositive: 3,
        reviewed: 12,
        falsePositiveRate: 25,
        appealedPending: 2,
      });
      expect(mockColl.countDocuments).toHaveBeenNthCalledWith(1, { domainId: 'domain-a' });
      expect(mockColl.countDocuments).toHaveBeenNthCalledWith(2, {
        domainId: 'domain-a',
        $or: [
          { reviewStatus: 'pending' },
          { reviewStatus: { $exists: false } },
        ],
      });
    });

    it('should return zero rate when no logs have been reviewed', async () => {
      mockColl.countDocuments
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      await expect(model.getReviewSummary('domain-a')).resolves.toEqual(
        expect.objectContaining({ reviewed: 0, falsePositiveRate: 0 })
      );
    });
  });

  describe('getRuleMetrics', () => {
    it('should calculate rule-level false-positive rates for one domain', async () => {
      mockColl._aggregateChain.toArray.mockResolvedValue([
        {
          _id: { matchedPattern: 'ignore.*prompt', category: 'prompt_injection' },
          total: 10,
          pending: 2,
          confirmed: 6,
          falsePositive: 2,
        },
      ]);

      const metrics = await model.getRuleMetrics('domain-a', 10);

      expect(metrics).toEqual([{
        matchedPattern: 'ignore.*prompt',
        category: 'prompt_injection',
        total: 10,
        pending: 2,
        confirmed: 6,
        falsePositive: 2,
        reviewed: 8,
        falsePositiveRate: 25,
      }]);
      expect(mockColl.aggregate.mock.calls[0][0][0]).toEqual({ $match: { domainId: 'domain-a' } });
      expect(mockColl.aggregate.mock.calls[0][0]).toContainEqual({ $limit: 10 });
    });
  });

  describe('getOperationalMetrics', () => {
    it('returns domain-scoped trends and review latency in minutes', async () => {
      mockColl._aggregateChain.toArray.mockResolvedValue([{
        summary: [{
          total: 12,
          cooldown: 3,
          appealed: 2,
          pendingAppeals: 1,
          reviewed: 7,
          averageReviewMs: 180000,
          averageAppealReviewMs: 90000,
        }],
        dailyTrend: [{ date: '2026-07-23', total: 4, cooldown: 1, appealed: 1, falsePositive: 1 }],
      }]);
      const now = new Date('2026-07-23T12:00:00.000Z');

      const metrics = await model.getOperationalMetrics('domain-a', 14, now);

      expect(metrics).toEqual({
        windowDays: 14,
        total: 12,
        cooldown: 3,
        appealed: 2,
        pendingAppeals: 1,
        reviewed: 7,
        averageReviewMinutes: 3,
        averageAppealReviewMinutes: 1.5,
        dailyTrend: [{ date: '2026-07-23', total: 4, cooldown: 1, appealed: 1, falsePositive: 1 }],
      });
      expect(mockColl.aggregate.mock.calls[0][0][0]).toEqual({
        $match: {
          domainId: 'domain-a',
          createdAt: {
            $gte: new Date('2026-07-09T12:00:00.000Z'),
            $lte: now,
          },
        },
      });
    });

    it('returns zero-safe defaults when the window has no events', async () => {
      mockColl._aggregateChain.toArray.mockResolvedValue([{ summary: [], dailyTrend: [] }]);

      await expect(model.getOperationalMetrics('domain-a')).resolves.toEqual(expect.objectContaining({
        total: 0,
        averageReviewMinutes: null,
        averageAppealReviewMinutes: null,
        dailyTrend: [],
      }));
    });
  });
});
