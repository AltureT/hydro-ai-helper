jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: any) => id),
}));

import { ConversationModel } from '../../models/conversation';

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
    findOne: jest.fn(),
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn().mockReturnValue(chainMock),
    countDocuments: jest.fn(),
    distinct: jest.fn(),
    _chain: chainMock,
  };
}

function createMockDb(collection: any) {
  return { collection: jest.fn().mockReturnValue(collection) } as any;
}

describe('ConversationModel', () => {
  let mockColl: ReturnType<typeof createMockCollection>;
  let model: ConversationModel;

  beforeEach(() => {
    mockColl = createMockCollection();
    model = new ConversationModel(createMockDb(mockColl));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── ensureIndexes ──────────────────────────────────

  describe('ensureIndexes', () => {
    it('should create all indexes and log success', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledTimes(11);
      expect(console.log).toHaveBeenCalledWith('[ConversationModel] Indexes created successfully');
    });
  });

  // ─── create ─────────────────────────────────────────

  describe('create', () => {
    it('should insert and return insertedId', async () => {
      const fakeId = 'new-conv-id';
      mockColl.insertOne.mockResolvedValue({ insertedId: fakeId });

      const data = {
        domainId: 'system',
        userId: 1,
        problemId: 'P1001',
        startTime: new Date(),
        endTime: new Date(),
        messageCount: 0,
        isEffective: false,
        tags: [],
      };

      const result = await model.create(data);
      expect(result).toBe(fakeId);
      expect(mockColl.insertOne).toHaveBeenCalledWith(data);
    });
  });

  // ─── findById ───────────────────────────────────────

  describe('findById', () => {
    it('should return conversation when found', async () => {
      const conv = { _id: 'conv-1', domainId: 'system' };
      mockColl.findOne.mockResolvedValue(conv);

      const result = await model.findById('conv-1');
      expect(result).toEqual(conv);
      expect(mockColl.findOne).toHaveBeenCalledWith({ _id: 'conv-1' });
    });

    it('should return null when not found', async () => {
      mockColl.findOne.mockResolvedValue(null);
      const result = await model.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── updateEndTime ──────────────────────────────────

  describe('updateEndTime', () => {
    it('should update endTime for given id', async () => {
      const endTime = new Date('2025-06-01');
      await model.updateEndTime('conv-1', endTime);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $set: { endTime } },
      );
    });
  });

  // ─── incrementMessageCount ──────────────────────────

  describe('incrementMessageCount', () => {
    it('should $inc messageCount by 1', async () => {
      await model.incrementMessageCount('conv-1');
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $inc: { messageCount: 1 } },
      );
    });
  });

  // ─── updateEffectiveness ────────────────────────────

  describe('updateEffectiveness', () => {
    it('should set isEffective to true', async () => {
      await model.updateEffectiveness('conv-1', true);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $set: { isEffective: true } },
      );
    });

    it('should set isEffective to false', async () => {
      await model.updateEffectiveness('conv-1', false);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $set: { isEffective: false } },
      );
    });
  });

  // ─── findByFilters ──────────────────────────────────

  describe('findByFilters', () => {
    it('should return empty list and total=0 with no filters', async () => {
      mockColl.countDocuments.mockResolvedValue(0);
      mockColl._chain.toArray.mockResolvedValue([]);

      const result = await model.findByFilters({});
      expect(result).toEqual({ conversations: [], total: 0 });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({});
    });

    it('should filter by domainId', async () => {
      mockColl.countDocuments.mockResolvedValue(5);
      mockColl._chain.toArray.mockResolvedValue([{ _id: '1' }]);

      await model.findByFilters({ domainId: 'test-domain' });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ domainId: 'test-domain' });
    });

    it('should filter by userId', async () => {
      mockColl.countDocuments.mockResolvedValue(3);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({ userId: 42 });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ userId: 42 });
    });

    it('should filter by problemId', async () => {
      mockColl.countDocuments.mockResolvedValue(1);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({ problemId: 'P1001' });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ problemId: 'P1001' });
    });

    it('should filter by classId', async () => {
      mockColl.countDocuments.mockResolvedValue(2);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({ classId: 'class-A' });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ classId: 'class-A' });
    });

    it('should filter by startDate only', async () => {
      mockColl.countDocuments.mockResolvedValue(0);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({ startDate: '2025-01-01' });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({
        startTime: { $gte: new Date('2025-01-01') },
      });
    });

    it('should filter by endDate only', async () => {
      mockColl.countDocuments.mockResolvedValue(0);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({ endDate: '2025-12-31' });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({
        startTime: { $lte: new Date('2025-12-31') },
      });
    });

    it('should filter by both startDate and endDate', async () => {
      mockColl.countDocuments.mockResolvedValue(0);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({ startDate: '2025-01-01', endDate: '2025-12-31' });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({
        startTime: { $gte: new Date('2025-01-01'), $lte: new Date('2025-12-31') },
      });
    });

    it('should combine multiple filters', async () => {
      mockColl.countDocuments.mockResolvedValue(1);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({
        domainId: 'test',
        userId: 1,
        problemId: 'P1',
        classId: 'cls',
        startDate: '2025-01-01',
      });
      expect(mockColl.countDocuments).toHaveBeenCalledWith({
        domainId: 'test',
        userId: 1,
        problemId: 'P1',
        classId: 'cls',
        startTime: { $gte: new Date('2025-01-01') },
      });
    });

    it('should calculate skip from page and limit', async () => {
      mockColl.countDocuments.mockResolvedValue(100);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({}, 3, 20);
      expect(mockColl._chain.skip).toHaveBeenCalledWith(40); // (3-1)*20
      expect(mockColl._chain.limit).toHaveBeenCalledWith(20);
    });

    it('should use default page=1 and limit=50', async () => {
      mockColl.countDocuments.mockResolvedValue(0);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({});
      expect(mockColl._chain.skip).toHaveBeenCalledWith(0);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(50);
    });

    it('should sort by startTime descending', async () => {
      mockColl.countDocuments.mockResolvedValue(0);
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findByFilters({});
      expect(mockColl._chain.sort).toHaveBeenCalledWith({ startTime: -1 });
    });
  });

  // ─── updateTeacherAnnotations ───────────────────────

  describe('updateTeacherAnnotations', () => {
    it('should update teacherNote only', async () => {
      await model.updateTeacherAnnotations('conv-1', 'Good work');
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $set: { teacherNote: 'Good work' } },
      );
    });

    it('should update tags only', async () => {
      await model.updateTeacherAnnotations('conv-1', undefined, ['tag1', 'tag2']);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $set: { tags: ['tag1', 'tag2'] } },
      );
    });

    it('should update both teacherNote and tags', async () => {
      await model.updateTeacherAnnotations('conv-1', 'Note', ['tag']);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $set: { teacherNote: 'Note', tags: ['tag'] } },
      );
    });

    it('should not call updateOne when no fields provided', async () => {
      await model.updateTeacherAnnotations('conv-1');
      expect(mockColl.updateOne).not.toHaveBeenCalled();
    });
  });

  // ─── incrementOffTopicStrike ────────────────────────

  describe('incrementOffTopicStrike', () => {
    it('should return updated strike count from result.metadata', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue({
        metadata: { offTopicStrike: 3 },
      });

      const result = await model.incrementOffTopicStrike('conv-1');
      expect(result).toBe(3);
      expect(mockColl.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $inc: { 'metadata.offTopicStrike': 1 } },
        { returnDocument: 'after' },
      );
    });

    it('should fallback to result.value.metadata.offTopicStrike', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue({
        value: { metadata: { offTopicStrike: 2 } },
      });

      const result = await model.incrementOffTopicStrike('conv-1');
      expect(result).toBe(2);
    });

    it('should fallback to 1 when no metadata', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue({});
      const result = await model.incrementOffTopicStrike('conv-1');
      expect(result).toBe(1);
    });

    it('should fallback to 1 when result is null', async () => {
      mockColl.findOneAndUpdate.mockResolvedValue(null);
      const result = await model.incrementOffTopicStrike('conv-1');
      expect(result).toBe(1);
    });
  });

  // ─── resetOffTopicStrike ────────────────────────────

  describe('resetOffTopicStrike', () => {
    it('should set metadata.offTopicStrike to 0', async () => {
      await model.resetOffTopicStrike('conv-1');
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'conv-1' },
        { $set: { 'metadata.offTopicStrike': 0 } },
      );
    });
  });

  // ─── countActiveUsers ───────────────────────────────

  describe('countActiveUsers', () => {
    it('should count distinct users within date range', async () => {
      mockColl.distinct.mockResolvedValue([1, 2, 3]);

      const result = await model.countActiveUsers(7);
      expect(result).toBe(3);
      expect(mockColl.distinct).toHaveBeenCalledWith(
        'userId',
        expect.objectContaining({ startTime: expect.objectContaining({ $gte: expect.any(Date) }) }),
      );
    });

    it('should filter by domainId when provided', async () => {
      mockColl.distinct.mockResolvedValue([1]);

      await model.countActiveUsers(30, 'test-domain');
      expect(mockColl.distinct).toHaveBeenCalledWith(
        'userId',
        expect.objectContaining({ domainId: 'test-domain' }),
      );
    });

    it('should return 0 when no active users', async () => {
      mockColl.distinct.mockResolvedValue([]);
      const result = await model.countActiveUsers(7);
      expect(result).toBe(0);
    });
  });

  // ─── getTotalConversations ──────────────────────────

  describe('getTotalConversations', () => {
    it('should count all without domain filter', async () => {
      mockColl.countDocuments.mockResolvedValue(42);
      const result = await model.getTotalConversations();
      expect(result).toBe(42);
      expect(mockColl.countDocuments).toHaveBeenCalledWith({});
    });

    it('should count filtered by domainId', async () => {
      mockColl.countDocuments.mockResolvedValue(10);
      const result = await model.getTotalConversations('my-domain');
      expect(result).toBe(10);
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ domainId: 'my-domain' });
    });
  });

  // ─── getLastConversationTime ────────────────────────

  describe('getLastConversationTime', () => {
    it('should return endTime of most recent conversation', async () => {
      const endTime = new Date('2025-06-15');
      mockColl._chain.toArray.mockResolvedValue([{ endTime }]);

      const result = await model.getLastConversationTime();
      expect(result).toEqual(endTime);
      expect(mockColl._chain.sort).toHaveBeenCalledWith({ endTime: -1 });
      expect(mockColl._chain.limit).toHaveBeenCalledWith(1);
    });

    it('should return null when no conversations exist', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      const result = await model.getLastConversationTime();
      expect(result).toBeNull();
    });

    it('should filter by domainId when provided', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      await model.getLastConversationTime('my-domain');
      expect(mockColl.find).toHaveBeenCalledWith({ domainId: 'my-domain' });
    });

    it('should use empty filter when no domainId', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      await model.getLastConversationTime();
      expect(mockColl.find).toHaveBeenCalledWith({});
    });
  });
});
