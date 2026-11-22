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
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it('should create new record with a unique UUID instanceId when none exists', async () => {
      mockColl.findOne.mockResolvedValue(null);
      mockColl.insertOne.mockResolvedValue({});

      await model.createIfMissing('1.0.0');

      expect(mockColl.insertOne).toHaveBeenCalledTimes(1);
      const inserted = mockColl.insertOne.mock.calls[0][0];
      expect(inserted._id).toBe('install');
      expect(inserted.installedVersion).toBe('1.0.0');
      expect(inserted.lastVersion).toBe('1.0.0');
      expect(inserted.telemetryEnabled).toBe(true);
      expect(inserted.testdataTelemetryHmacKey).toMatch(/^[a-f0-9]{64}$/);
      // instanceId must be a real random UUID, not a deterministic hash
      expect(inserted.instanceId).toMatch(UUID_RE);
    });

    it('two installs should get distinct instanceIds (no collision)', async () => {
      mockColl.findOne.mockResolvedValue(null);
      mockColl.insertOne.mockResolvedValue({});

      await model.createIfMissing('1.0.0');
      const otherModel = new PluginInstallModel(createMockDb(createMockCollection()) as any);
      const otherColl = (otherModel as any).collection;
      otherColl.findOne.mockResolvedValue(null);
      otherColl.insertOne.mockResolvedValue({});
      await otherModel.createIfMissing('1.0.0');

      const a = mockColl.insertOne.mock.calls[0][0].instanceId;
      const b = otherColl.insertOne.mock.calls[0][0].instanceId;
      expect(a).not.toBe(b);
    });

    it('should preserve a valid existing UUID instanceId on version update', async () => {
      const existingUuid = '11111111-2222-4333-8444-555555555555';
      const existingHmacKey = 'a'.repeat(64);
      mockColl.findOne.mockResolvedValue({
        _id: 'install', instanceId: existingUuid, testdataTelemetryHmacKey: existingHmacKey,
      });

      await model.createIfMissing('2.0.0');

      expect(mockColl.insertOne).not.toHaveBeenCalled();
      expect(mockColl.updateOne).toHaveBeenCalledTimes(1);
      const updateArgs = mockColl.updateOne.mock.calls[0];
      expect(updateArgs[0]).toEqual({ _id: 'install' });
      expect(updateArgs[1].$set.lastVersion).toBe('2.0.0');
      // A valid UUID must NOT be regenerated
      expect(updateArgs[1].$set).not.toHaveProperty('instanceId');
      expect(updateArgs[1].$set).not.toHaveProperty('testdataTelemetryHmacKey');
    });

    it('should migrate a legacy deterministic (sha256) instanceId to a unique UUID', async () => {
      // sha256('unknown:hydro') — the collided id all default installs shared
      const collidedHash = 'cae41ba1e0e7bb866c5ca7c703c7825a14efe4623da13b406ac6891579188fff';
      mockColl.findOne.mockResolvedValue({ _id: 'install', instanceId: collidedHash });

      await model.createIfMissing('2.0.0');

      const updateArgs = mockColl.updateOne.mock.calls[0];
      expect(updateArgs[1].$set.lastVersion).toBe('2.0.0');
      expect(updateArgs[1].$set.instanceId).toMatch(UUID_RE);
      expect(updateArgs[1].$set.instanceId).not.toBe(collidedHash);
    });

    it('backfills a private model-identity HMAC key without rotating instanceId', async () => {
      const existingUuid = '11111111-2222-4333-8444-555555555555';
      mockColl.findOne.mockResolvedValue({ _id: 'install', instanceId: existingUuid });

      await model.createIfMissing('2.0.0');

      const updates = mockColl.updateOne.mock.calls[0][1].$set;
      expect(updates.instanceId).toBeUndefined();
      expect(updates.testdataTelemetryHmacKey).toMatch(/^[a-f0-9]{64}$/);
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
