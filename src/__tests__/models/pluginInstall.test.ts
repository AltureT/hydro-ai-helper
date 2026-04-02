import { PluginInstallModel } from '../../models/pluginInstall';

function createMockCollection() {
  return {
    findOne: jest.fn(),
    insertOne: jest.fn(),
    updateOne: jest.fn(),
  };
}

function createMockDb(collection: any) {
  return {
    collection: jest.fn().mockReturnValue(collection),
    databaseName: 'test_db',
    admin: jest.fn().mockReturnValue({
      serverInfo: jest.fn().mockResolvedValue({ host: 'localhost:27017' }),
    }),
  } as any;
}

describe('PluginInstallModel', () => {
  let mockColl: ReturnType<typeof createMockCollection>;
  let model: PluginInstallModel;

  beforeEach(() => {
    mockColl = createMockCollection();
    model = new PluginInstallModel(createMockDb(mockColl));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ensureIndexes', () => {
    it('should log initialization', async () => {
      await model.ensureIndexes();
      expect(console.log).toHaveBeenCalledWith('[PluginInstallModel] Collection initialized');
    });
  });

  describe('getInstall', () => {
    it('should query by fixed id', async () => {
      const record = { _id: 'install', instanceId: 'uuid' };
      mockColl.findOne.mockResolvedValue(record);

      const result = await model.getInstall();
      expect(result).toEqual(record);
      expect(mockColl.findOne).toHaveBeenCalledWith({ _id: 'install' });
    });

    it('should return null when no record', async () => {
      mockColl.findOne.mockResolvedValue(null);
      const result = await model.getInstall();
      expect(result).toBeNull();
    });
  });

  describe('createIfMissing', () => {
    it('should create new record when none exists', async () => {
      mockColl.findOne.mockResolvedValue(null);
      mockColl.insertOne.mockResolvedValue({});

      await model.createIfMissing('1.0.0');

      expect(mockColl.insertOne).toHaveBeenCalledTimes(1);
      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted._id).toBe('install');
      expect(inserted.installedVersion).toBe('1.0.0');
      expect(inserted.lastVersion).toBe('1.0.0');
      expect(inserted.telemetryEnabled).toBe(true);
      expect(inserted.instanceId).toBeTruthy();
    });

    it('should update version when record already exists', async () => {
      mockColl.findOne.mockResolvedValue({ _id: 'install', instanceId: 'old-uuid' });

      await model.createIfMissing('2.0.0');

      expect(mockColl.insertOne).not.toHaveBeenCalled();
      expect(mockColl.updateOne).toHaveBeenCalledTimes(1);
      const updateArgs = mockColl.updateOne.mock.calls[0];
      expect(updateArgs[0]).toEqual({ _id: 'install' });
      expect(updateArgs[1].$set.lastVersion).toBe('2.0.0');
      // Should migrate from old UUID to stable hash
      expect(updateArgs[1].$set.instanceId).toBeTruthy();
      expect(updateArgs[1].$set.instanceId).not.toBe('old-uuid');
    });
  });

  describe('markFirstUse', () => {
    it('should set firstUsedAt when not already set', async () => {
      mockColl.findOne.mockResolvedValue({ _id: 'install' });

      await model.markFirstUse();

      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'install' },
        { $set: { firstUsedAt: expect.any(Date) } },
      );
    });

    it('should skip when firstUsedAt already set', async () => {
      mockColl.findOne.mockResolvedValue({ _id: 'install', firstUsedAt: new Date() });

      await model.markFirstUse();

      expect(mockColl.updateOne).not.toHaveBeenCalled();
    });

    it('should skip when no record exists', async () => {
      mockColl.findOne.mockResolvedValue(null);

      await model.markFirstUse();

      expect(mockColl.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('markLastUse', () => {
    it('should update lastUsedAt', async () => {
      await model.markLastUse();
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'install' },
        { $set: { lastUsedAt: expect.any(Date) } },
      );
    });
  });

  describe('addDomain', () => {
    it('should $addToSet domainId', async () => {
      await model.addDomain('test-domain');
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'install' },
        { $addToSet: { domainsSeen: 'test-domain' } },
      );
    });
  });

  describe('updateLastReportTime', () => {
    it('should update lastReportAt', async () => {
      await model.updateLastReportTime();
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'install' },
        { $set: { lastReportAt: expect.any(Date) } },
      );
    });
  });

  describe('updateTelemetryEnabled', () => {
    it('should set telemetryEnabled to true', async () => {
      await model.updateTelemetryEnabled(true);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'install' },
        { $set: { telemetryEnabled: true } },
      );
    });

    it('should set telemetryEnabled to false', async () => {
      await model.updateTelemetryEnabled(false);
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'install' },
        { $set: { telemetryEnabled: false } },
      );
    });
  });

  describe('updatePreferredTelemetryEndpoint', () => {
    it('should update preferred endpoint', async () => {
      await model.updatePreferredTelemetryEndpoint('https://telemetry.example.com');
      expect(mockColl.updateOne).toHaveBeenCalledWith(
        { _id: 'install' },
        { $set: { preferredTelemetryEndpoint: 'https://telemetry.example.com' } },
      );
    });
  });
});
