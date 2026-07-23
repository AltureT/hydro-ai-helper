jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: any) => id),
}));

import { JailbreakLogModel } from '../../models/jailbreakLog';

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
  return {
    createIndex: jest.fn(),
    insertOne: jest.fn(),
    find: jest.fn().mockReturnValue(chainMock),
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(),
    _chain: chainMock,
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
      expect(mockColl.createIndex).toHaveBeenCalledTimes(4);
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, userId: 1, createdAt: -1 },
        { name: 'idx_domain_user_createdAt' }
      );
      expect(console.log).toHaveBeenCalledWith('[JailbreakLogModel] Indexes ensured');
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, reviewStatus: 1, category: 1, createdAt: -1 },
        { name: 'idx_domain_review_category_createdAt' }
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
      mockColl.updateOne.mockResolvedValue({ matchedCount: 1 });
      const reviewedAt = new Date('2026-07-23T01:00:00Z');

      const result = await model.review('log-1', 'domain-a', 'confirmed', 7, reviewedAt);

      expect(result).toBe(true);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'log-1', domainId: 'domain-a' },
        { $set: { reviewStatus: 'confirmed', reviewedAt, reviewedBy: 7 } }
      );
    });

    it('should cancel the cooldown when a log is marked false positive', async () => {
      mockColl.updateOne.mockResolvedValue({ matchedCount: 1 });

      await model.review('log-2', 'domain-a', 'false_positive', 7);

      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'log-2', domainId: 'domain-a' },
        expect.objectContaining({
          $set: expect.objectContaining({ reviewStatus: 'false_positive', reviewedBy: 7 }),
          $unset: { blockedUntil: '' },
        })
      );
    });

    it('should report when no domain-scoped log was found', async () => {
      mockColl.updateOne.mockResolvedValue({ matchedCount: 0 });
      await expect(model.review('missing', 'domain-a', 'confirmed', 7)).resolves.toBe(false);
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
  });

  describe('getReviewSummary', () => {
    it('should calculate a domain-scoped false-positive rate from reviewed logs', async () => {
      mockColl.countDocuments
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(8)
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(3);

      const summary = await model.getReviewSummary('domain-a');

      expect(summary).toEqual({
        total: 20,
        pending: 8,
        confirmed: 9,
        falsePositive: 3,
        reviewed: 12,
        falsePositiveRate: 25,
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
});
