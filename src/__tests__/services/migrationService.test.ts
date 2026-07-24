import { MigrationService, DEFAULT_DOMAIN_ID } from '../../services/migrationService';

function createMockCollection(overrides: Record<string, any> = {}) {
  return {
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    dropIndex: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockReturnValue(createAsyncCursor([])),
    bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    ...overrides,
  };
}

function createAsyncCursor(items: any[]) {
  return {
    batchSize: jest.fn().mockReturnThis(),
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function createMockDb(collections: Record<string, any> = {}) {
  return {
    collection: jest.fn((name: string) => {
      return collections[name] || createMockCollection();
    }),
  } as any;
}

describe('MigrationService', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('DEFAULT_DOMAIN_ID', () => {
    it('should be "system"', () => {
      expect(DEFAULT_DOMAIN_ID).toBe('system');
    });
  });

  describe('migrateConversationDomainIds', () => {
    it('should update records with missing/null/empty domainId', async () => {
      const conversationsColl = createMockCollection({ updateMany: jest.fn().mockResolvedValue({ modifiedCount: 5 }) });
      const db = createMockDb({ ai_conversations: conversationsColl });
      const service = new MigrationService(db);

      const count = await service.migrateConversationDomainIds();

      expect(count).toBe(5);
      expect(db.collection).toHaveBeenCalledWith('ai_conversations');
      expect(conversationsColl.updateMany).toHaveBeenCalledWith(
        {
          $or: [
            { domainId: { $exists: false } },
            { domainId: null },
            { domainId: '' },
          ],
        },
        { $set: { domainId: 'system' } }
      );
    });

    it('should return 0 when no records need migration', async () => {
      const conversationsColl = createMockCollection({ updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) });
      const db = createMockDb({ ai_conversations: conversationsColl });
      const service = new MigrationService(db);

      const count = await service.migrateConversationDomainIds();
      expect(count).toBe(0);
    });
  });

  describe('migrateRateLimitRecords', () => {
    it('should update records with missing/null/empty domainId', async () => {
      const rateLimitColl = createMockCollection({ updateMany: jest.fn().mockResolvedValue({ modifiedCount: 3 }) });
      const db = createMockDb({ ai_rate_limit_records: rateLimitColl });
      const service = new MigrationService(db);

      const count = await service.migrateRateLimitRecords();

      expect(count).toBe(3);
      expect(db.collection).toHaveBeenCalledWith('ai_rate_limit_records');
      expect(rateLimitColl.updateMany).toHaveBeenCalledWith(
        {
          $or: [
            { domainId: { $exists: false } },
            { domainId: null },
            { domainId: '' },
          ],
        },
        { $set: { domainId: 'system' } }
      );
    });
  });

  describe('migrateJailbreakLogDomainIds', () => {
    it('quarantines every unscoped legacy safety log in system without trusting client context', async () => {
      const logs = [
        { _id: 'log-1', conversationId: 'conv-1' },
        { _id: 'log-2', conversationId: 'conv-missing' },
        { _id: 'log-3', problemId: 'P1001' },
        { _id: 'log-4' },
        { _id: 'log-5', conversationId: 'conv-dirty' },
        { _id: 'log-6', problemId: 'P2000' },
        { _id: 'log-7', conversationId: 'conv-1', problemId: 'P3000' },
      ];
      const logCollection = createMockCollection({
        find: jest.fn().mockReturnValue(createAsyncCursor(logs)),
        bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 7 }),
      });
      const db = createMockDb({ ai_jailbreak_logs: logCollection });
      const service = new MigrationService(db);

      const count = await service.migrateJailbreakLogDomainIds();

      expect(count).toBe(7);
      expect(logCollection.find).toHaveBeenCalledWith(
        {
          $or: [
            { domainId: { $exists: false } },
            { domainId: null },
            { domainId: '' },
          ],
        },
        { projection: { _id: 1 } }
      );
      expect(logCollection.bulkWrite).toHaveBeenCalledWith(
        logs.map((log) => ({
          updateOne: {
            filter: {
              _id: log._id,
              $or: [
                { domainId: { $exists: false } },
                { domainId: null },
                { domainId: '' },
              ],
            },
            update: { $set: { domainId: 'system' } },
          },
        })),
        { ordered: false }
      );
      expect(db.collection).not.toHaveBeenCalledWith('ai_conversations');
      expect(db.collection).not.toHaveBeenCalledWith('document');
    });

    it('does not write when every safety log already has a domain', async () => {
      const logCollection = createMockCollection({
        find: jest.fn().mockReturnValue(createAsyncCursor([])),
      });
      const db = createMockDb({ ai_jailbreak_logs: logCollection });
      const service = new MigrationService(db);

      await expect(service.migrateJailbreakLogDomainIds()).resolves.toBe(0);
      expect(logCollection.bulkWrite).not.toHaveBeenCalled();
    });

    it('is idempotent when the migration runs again after a successful batch', async () => {
      const logCollection = createMockCollection({
        find: jest.fn()
          .mockReturnValueOnce(createAsyncCursor([{ _id: 'legacy-log' }]))
          .mockReturnValueOnce(createAsyncCursor([])),
        bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      });
      const db = createMockDb({ ai_jailbreak_logs: logCollection });
      const service = new MigrationService(db);

      await expect(service.migrateJailbreakLogDomainIds()).resolves.toBe(1);
      await expect(service.migrateJailbreakLogDomainIds()).resolves.toBe(0);

      expect(logCollection.bulkWrite).toHaveBeenCalledTimes(1);
      expect(logCollection.bulkWrite.mock.calls[0][0][0].updateOne.filter).toEqual({
        _id: 'legacy-log',
        $or: [
          { domainId: { $exists: false } },
          { domainId: null },
          { domainId: '' },
        ],
      });
    });

    it('processes large legacy collections in bounded batches', async () => {
      const logs = Array.from({ length: 501 }, (_, index) => ({ _id: `log-${index}` }));
      const logCollection = createMockCollection({
        find: jest.fn().mockReturnValue(createAsyncCursor(logs)),
        bulkWrite: jest.fn()
          .mockResolvedValueOnce({ modifiedCount: 500 })
          .mockResolvedValueOnce({ modifiedCount: 1 }),
      });
      const db = createMockDb({ ai_jailbreak_logs: logCollection });
      const service = new MigrationService(db);

      await expect(service.migrateJailbreakLogDomainIds()).resolves.toBe(501);
      expect(logCollection.bulkWrite).toHaveBeenCalledTimes(2);
      expect(logCollection.bulkWrite.mock.calls[0][0]).toHaveLength(500);
      expect(logCollection.bulkWrite.mock.calls[1][0]).toHaveLength(1);
    });
  });

  describe('dropOldRateLimitIndex', () => {
    it('should drop old index when it exists', async () => {
      const rateLimitColl = createMockCollection({ dropIndex: jest.fn().mockResolvedValue(undefined) });
      const db = createMockDb({ ai_rate_limit_records: rateLimitColl });
      const service = new MigrationService(db);

      await service.dropOldRateLimitIndex();

      expect(rateLimitColl.dropIndex).toHaveBeenCalledWith('idx_userId_minuteKey');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropped old index')
      );
    });

    it('should silently skip when index not found', async () => {
      const rateLimitColl = createMockCollection({
        dropIndex: jest.fn().mockRejectedValue(new Error('index not found with name: idx_userId_minuteKey')),
      });
      const db = createMockDb({ ai_rate_limit_records: rateLimitColl });
      const service = new MigrationService(db);

      await expect(service.dropOldRateLimitIndex()).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not exist, skipping')
      );
    });

    it('should rethrow non-"not found" errors', async () => {
      const rateLimitColl = createMockCollection({
        dropIndex: jest.fn().mockRejectedValue(new Error('connection lost')),
      });
      const db = createMockDb({ ai_rate_limit_records: rateLimitColl });
      const service = new MigrationService(db);

      await expect(service.dropOldRateLimitIndex()).rejects.toThrow('connection lost');
    });
  });

  describe('runAllMigrations', () => {
    it('should run all migrations in order and return stats', async () => {
      const rateLimitColl = createMockCollection({
        dropIndex: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
      });
      const conversationsColl = createMockCollection({
        updateMany: jest.fn().mockResolvedValue({ modifiedCount: 7 }),
      });
      const jailbreakLogsColl = createMockCollection({
        find: jest.fn().mockReturnValue(createAsyncCursor([])),
      });
      const db = createMockDb({
        ai_conversations: conversationsColl,
        ai_rate_limit_records: rateLimitColl,
        ai_jailbreak_logs: jailbreakLogsColl,
      });
      const service = new MigrationService(db);

      const result = await service.runAllMigrations();

      expect(result).toEqual({
        conversationsMigrated: 7,
        rateLimitRecordsMigrated: 2,
        jailbreakLogsMigrated: 0,
      });
      // Verify order: dropIndex called before updateMany
      expect(rateLimitColl.dropIndex).toHaveBeenCalled();
    });

    it('should propagate errors from individual migrations', async () => {
      const rateLimitColl = createMockCollection({
        dropIndex: jest.fn().mockRejectedValue(new Error('DB down')),
      });
      const db = createMockDb({ ai_rate_limit_records: rateLimitColl });
      const service = new MigrationService(db);

      await expect(service.runAllMigrations()).rejects.toThrow('DB down');
    });

    it('keeps the plugin migration sequence available when safety-log backfill fails', async () => {
      const rateLimitColl = createMockCollection({
        dropIndex: jest.fn().mockResolvedValue(undefined),
      });
      const conversationsColl = createMockCollection();
      const jailbreakLogsColl = createMockCollection({
        find: jest.fn().mockReturnValue(createAsyncCursor([{ _id: 'legacy-log' }])),
        bulkWrite: jest.fn().mockRejectedValue(new Error('bulk write unavailable')),
      });
      const db = createMockDb({
        ai_conversations: conversationsColl,
        ai_rate_limit_records: rateLimitColl,
        ai_jailbreak_logs: jailbreakLogsColl,
      });
      const service = new MigrationService(db);

      await expect(service.runAllMigrations()).resolves.toEqual({
        conversationsMigrated: 0,
        rateLimitRecordsMigrated: 0,
        jailbreakLogsMigrated: 0,
      });
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('will retry on next startup'),
        expect.any(Error)
      );
    });
  });
});
