import { MigrationService, DEFAULT_DOMAIN_ID } from '../../services/migrationService';

function createMockCollection(overrides: Record<string, any> = {}) {
  return {
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    dropIndex: jest.fn().mockResolvedValue(undefined),
    ...overrides,
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
      const db = createMockDb({
        ai_conversations: conversationsColl,
        ai_rate_limit_records: rateLimitColl,
      });
      const service = new MigrationService(db);

      const result = await service.runAllMigrations();

      expect(result).toEqual({
        conversationsMigrated: 7,
        rateLimitRecordsMigrated: 2,
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
  });
});
