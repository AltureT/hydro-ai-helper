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
    countDocuments: jest.fn(),
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
    it('should create 2 indexes', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith('[JailbreakLogModel] Indexes ensured');
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
    });

    it('should include optional fields when provided', async () => {
      mockColl.insertOne.mockResolvedValue({ insertedId: 'log-2' });

      await model.create({
        userId: 42,
        problemId: 'P1001',
        conversationId: 'conv-1',
        questionType: 'debug',
        matchedPattern: 'pattern',
        matchedText: 'text',
      });

      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted.userId).toBe(42);
      expect(inserted.problemId).toBe('P1001');
      expect(inserted.conversationId).toBe('conv-1');
      expect(inserted.questionType).toBe('debug');
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
  });
});
