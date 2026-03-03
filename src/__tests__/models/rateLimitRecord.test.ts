import { RateLimitRecordModel, getRateLimitCollection } from '../../models/rateLimitRecord';

function createMockCollection() {
  return {
    createIndex: jest.fn(),
  };
}

function createMockDb(collection: any) {
  return { collection: jest.fn().mockReturnValue(collection) } as any;
}

describe('RateLimitRecordModel', () => {
  let mockColl: ReturnType<typeof createMockCollection>;
  let model: RateLimitRecordModel;

  beforeEach(() => {
    mockColl = createMockCollection();
    model = new RateLimitRecordModel(createMockDb(mockColl));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ensureIndexes', () => {
    it('should create 3 indexes (TTL, composite unique, domainId)', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledTimes(3);
      expect(console.log).toHaveBeenCalledWith('[RateLimitRecordModel] Indexes created successfully');
    });

    it('should create TTL index with expireAfterSeconds=0', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { expireAt: 1 },
        expect.objectContaining({ expireAfterSeconds: 0 }),
      );
    });

    it('should create unique composite index', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledWith(
        { domainId: 1, userId: 1, minuteKey: 1 },
        expect.objectContaining({ unique: true }),
      );
    });
  });

  describe('getCollection', () => {
    it('should return the underlying collection', () => {
      const coll = model.getCollection();
      expect(coll).toBe(mockColl);
    });
  });
});

describe('getRateLimitCollection', () => {
  it('should return collection for ai_rate_limit_records', () => {
    const mockColl = {};
    const mockDb = { collection: jest.fn().mockReturnValue(mockColl) } as any;

    const result = getRateLimitCollection(mockDb);
    expect(result).toBe(mockColl);
    expect(mockDb.collection).toHaveBeenCalledWith('ai_rate_limit_records');
  });
});
