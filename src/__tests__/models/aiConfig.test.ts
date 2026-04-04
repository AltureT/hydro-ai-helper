import { AIConfigModel, CURRENT_CONFIG_VERSION, type AIConfig, type APIEndpoint, type SelectedModel } from '../../models/aiConfig';

jest.mock('../../lib/crypto', () => ({
  reEncrypt: jest.fn((cipher: string) => `re_${cipher}`),
}));

function createMockCollection() {
  return {
    findOne: jest.fn(),
    updateOne: jest.fn(),
    insertOne: jest.fn(),
    deleteOne: jest.fn(),
  };
}

function createMockDb(collection: any) {
  return {
    collection: jest.fn().mockReturnValue(collection),
  } as any;
}

function makeLegacyConfig(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: 'default',
    apiBaseUrl: 'https://api.example.com',
    modelName: 'gpt-4o',
    apiKeyEncrypted: 'enc_key_123',
    rateLimitPerMinute: 10,
    timeoutSeconds: 30,
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeV2Config(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    _id: 'default',
    configVersion: CURRENT_CONFIG_VERSION,
    endpoints: [{
      id: 'ep-1',
      name: 'Test Endpoint',
      apiBaseUrl: 'https://api.example.com',
      apiKeyEncrypted: 'enc_key_123',
      models: ['gpt-4o'],
      enabled: true,
    }],
    selectedModels: [{ endpointId: 'ep-1', modelName: 'gpt-4o' }],
    rateLimitPerMinute: 10,
    timeoutSeconds: 30,
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

describe('AIConfigModel', () => {
  let mockCollection: ReturnType<typeof createMockCollection>;
  let model: AIConfigModel;

  beforeEach(() => {
    mockCollection = createMockCollection();
    const mockDb = createMockDb(mockCollection);
    model = new AIConfigModel(mockDb);
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getConfig', () => {
    it('should return null when no config exists', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      const result = await model.getConfig();

      expect(result).toBeNull();
      expect(mockCollection.findOne).toHaveBeenCalledWith({ _id: 'default' });
    });

    it('should return config directly when already v2', async () => {
      const v2Config = makeV2Config();
      mockCollection.findOne.mockResolvedValue(v2Config);

      const result = await model.getConfig();

      expect(result).toEqual(v2Config);
      expect(mockCollection.updateOne).not.toHaveBeenCalled();
    });

    it('should migrate legacy config without endpoints', async () => {
      const legacy = makeLegacyConfig();
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result).not.toBeNull();
      expect(result!.configVersion).toBe(CURRENT_CONFIG_VERSION);
      expect(result!.endpoints).toHaveLength(1);
      expect(result!.endpoints[0].apiBaseUrl).toBe('https://api.example.com');
      expect(result!.endpoints[0].apiKeyEncrypted).toBe('enc_key_123');
      expect(result!.endpoints[0].models).toEqual(['gpt-4o']);
      expect(result!.endpoints[0].enabled).toBe(true);
      expect(result!.endpoints[0].name).toBe('Default Endpoint');
      expect(result!.selectedModels).toHaveLength(1);
      expect(result!.selectedModels[0].modelName).toBe('gpt-4o');
      // Should persist migration
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'default' },
        { $set: expect.objectContaining({ configVersion: CURRENT_CONFIG_VERSION }) }
      );
    });

    it('should create empty endpoints when legacy has no apiBaseUrl', async () => {
      const legacy = makeLegacyConfig({ apiBaseUrl: '', modelName: '' });
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result!.endpoints).toHaveLength(0);
      expect(result!.selectedModels).toHaveLength(0);
    });

    it('should migrate legacy config with existing endpoints', async () => {
      const legacy = makeLegacyConfig({
        configVersion: 1,
        endpoints: [
          {
            id: 'existing-ep',
            name: 'Existing',
            apiBaseUrl: 'https://existing.com',
            apiKeyEncrypted: 'enc_existing',
            models: ['model-a', 'model-b'],
            enabled: true,
          },
        ],
        selectedModels: [{ endpointId: 'existing-ep', modelName: 'model-a' }],
      });
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result!.configVersion).toBe(CURRENT_CONFIG_VERSION);
      expect(result!.endpoints).toHaveLength(1);
      expect(result!.endpoints[0].id).toBe('existing-ep');
      expect(result!.selectedModels).toEqual([{ endpointId: 'existing-ep', modelName: 'model-a' }]);
    });

    it('should normalize endpoints without id during migration', async () => {
      const legacy = makeLegacyConfig({
        configVersion: 1,
        endpoints: [
          {
            name: 'No ID',
            apiBaseUrl: 'https://noid.com',
            apiKeyEncrypted: 'enc_noid',
            models: ['m1'],
            enabled: true,
            // Missing id
          },
        ],
      });
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result!.endpoints[0].id).toBeTruthy();
      expect(typeof result!.endpoints[0].id).toBe('string');
    });

    it('should derive selectedModels from legacy modelName when selectedModels is empty', async () => {
      const legacy = makeLegacyConfig({
        configVersion: 1,
        endpoints: [
          {
            id: 'ep-a',
            name: 'EP A',
            apiBaseUrl: 'https://a.com',
            apiKeyEncrypted: 'enc_a',
            models: ['m1'],
            enabled: true,
          },
        ],
        selectedModels: [],
        modelName: 'legacy-model',
      });
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result!.selectedModels).toEqual([
        { endpointId: 'ep-a', modelName: 'legacy-model' }
      ]);
    });

    it('should derive selectedModels from endpoint models when no modelName', async () => {
      const legacy = makeLegacyConfig({
        configVersion: 1,
        modelName: '',
        endpoints: [
          {
            id: 'ep-x',
            name: 'EP X',
            apiBaseUrl: 'https://x.com',
            apiKeyEncrypted: 'enc_x',
            models: ['auto-model'],
            enabled: true,
          },
        ],
        selectedModels: [],
      });
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result!.selectedModels).toEqual([
        { endpointId: 'ep-x', modelName: 'auto-model' }
      ]);
    });

    it('should filter selectedModels referencing non-existent endpoints', async () => {
      const legacy = makeLegacyConfig({
        configVersion: 1,
        endpoints: [
          { id: 'ep-real', name: 'Real', apiBaseUrl: 'https://r.com', apiKeyEncrypted: 'k', models: ['m'], enabled: true },
        ],
        selectedModels: [
          { endpointId: 'ep-real', modelName: 'm' },
          { endpointId: 'ep-gone', modelName: 'gone-model' },
        ],
      });
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result!.selectedModels).toEqual([
        { endpointId: 'ep-real', modelName: 'm' }
      ]);
    });

    it('should set enabled=true for endpoints with undefined enabled', async () => {
      const legacy = makeLegacyConfig({
        configVersion: 1,
        endpoints: [
          { id: 'ep-1', name: 'EP', apiBaseUrl: 'https://e.com', apiKeyEncrypted: 'k', models: [] },
        ],
      });
      mockCollection.findOne.mockResolvedValue(legacy);

      const result = await model.getConfig();

      expect(result!.endpoints[0].enabled).toBe(true);
    });
  });

  describe('updateConfig', () => {
    it('should upsert config with current version and updatedAt', async () => {
      const updated = makeV2Config();
      mockCollection.updateOne.mockResolvedValue({});
      mockCollection.findOne.mockResolvedValue(updated);

      const result = await model.updateConfig({ rateLimitPerMinute: 20 });

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'default' },
        { $set: expect.objectContaining({
          rateLimitPerMinute: 20,
          configVersion: CURRENT_CONFIG_VERSION,
        })},
        { upsert: true }
      );
      expect(result).toEqual(updated);
    });

    it('should throw when findOne returns null after update', async () => {
      mockCollection.updateOne.mockResolvedValue({});
      mockCollection.findOne.mockResolvedValue(null);

      await expect(model.updateConfig({ rateLimitPerMinute: 5 }))
        .rejects.toThrow('配置更新失败');
    });
  });

  describe('addEndpoint', () => {
    it('should add endpoint to existing config', async () => {
      const existing = makeV2Config();
      mockCollection.findOne.mockResolvedValue(existing);
      mockCollection.updateOne.mockResolvedValue({});

      const newEndpoint = await model.addEndpoint({
        name: 'New EP',
        apiBaseUrl: 'https://new.com',
        apiKeyEncrypted: 'enc_new',
        models: ['new-model'],
        enabled: true,
      });

      expect(newEndpoint.id).toBeTruthy();
      expect(newEndpoint.name).toBe('New EP');
      expect(mockCollection.updateOne).toHaveBeenCalled();
    });

    it('should initialize endpoints array when config is null', async () => {
      // First call from addEndpoint -> getConfig returns null
      // Second call from updateConfig -> findOne returns updated config
      mockCollection.findOne
        .mockResolvedValueOnce(null)  // getConfig
        .mockResolvedValueOnce(makeV2Config());  // updateConfig
      mockCollection.updateOne.mockResolvedValue({});

      const ep = await model.addEndpoint({
        name: 'First EP',
        apiBaseUrl: 'https://first.com',
        apiKeyEncrypted: 'enc_first',
        models: [],
        enabled: true,
      });

      expect(ep.name).toBe('First EP');
    });
  });

  describe('updateEndpoint', () => {
    it('should update matching endpoint', async () => {
      const config = makeV2Config();
      mockCollection.findOne.mockResolvedValue(config);
      mockCollection.updateOne.mockResolvedValue({});

      await model.updateEndpoint('ep-1', { name: 'Updated Name' });

      const updateCall = mockCollection.updateOne.mock.calls[0];
      const setData = updateCall[1].$set;
      expect(setData.endpoints[0].name).toBe('Updated Name');
    });

    it('should throw when config does not exist', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      await expect(model.updateEndpoint('ep-1', { name: 'X' }))
        .rejects.toThrow('配置不存在');
    });
  });

  describe('deleteEndpoint', () => {
    it('should remove endpoint and clean selectedModels', async () => {
      const config = makeV2Config({
        endpoints: [
          { id: 'ep-1', name: 'A', apiBaseUrl: 'a', apiKeyEncrypted: 'k', models: [], enabled: true },
          { id: 'ep-2', name: 'B', apiBaseUrl: 'b', apiKeyEncrypted: 'k', models: [], enabled: true },
        ],
        selectedModels: [
          { endpointId: 'ep-1', modelName: 'm1' },
          { endpointId: 'ep-2', modelName: 'm2' },
        ],
      });
      mockCollection.findOne.mockResolvedValue(config);
      mockCollection.updateOne.mockResolvedValue({});

      await model.deleteEndpoint('ep-1');

      const updateCall = mockCollection.updateOne.mock.calls[0];
      const setData = updateCall[1].$set;
      expect(setData.endpoints).toHaveLength(1);
      expect(setData.endpoints[0].id).toBe('ep-2');
      expect(setData.selectedModels).toEqual([{ endpointId: 'ep-2', modelName: 'm2' }]);
    });

    it('should throw when config does not exist', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      await expect(model.deleteEndpoint('ep-1'))
        .rejects.toThrow('配置不存在');
    });
  });

  describe('updateSelectedModels', () => {
    it('should update selectedModels via updateConfig', async () => {
      const config = makeV2Config();
      mockCollection.findOne.mockResolvedValue(config);
      mockCollection.updateOne.mockResolvedValue({});

      const newModels: SelectedModel[] = [
        { endpointId: 'ep-1', modelName: 'gpt-4o-mini' },
      ];
      await model.updateSelectedModels(newModels);

      const updateCall = mockCollection.updateOne.mock.calls[0];
      expect(updateCall[1].$set.selectedModels).toEqual(newModels);
    });
  });

  describe('getEndpointById', () => {
    it('should return endpoint when found', async () => {
      const config = makeV2Config();
      mockCollection.findOne.mockResolvedValue(config);

      const ep = await model.getEndpointById('ep-1');
      expect(ep).toBeTruthy();
      expect(ep!.id).toBe('ep-1');
    });

    it('should return null when config is null', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      const ep = await model.getEndpointById('ep-1');
      expect(ep).toBeNull();
    });

    it('should return null when endpoint not found', async () => {
      const config = makeV2Config();
      mockCollection.findOne.mockResolvedValue(config);

      const ep = await model.getEndpointById('nonexistent');
      expect(ep).toBeNull();
    });
  });

  describe('reEncryptAllKeys', () => {
    it('should re-encrypt endpoint keys and legacy key', async () => {
      const { reEncrypt } = require('../../lib/crypto');
      const config = makeV2Config({ apiKeyEncrypted: 'legacy_key' });
      mockCollection.findOne.mockResolvedValue(config);
      mockCollection.updateOne.mockResolvedValue({});

      const count = await model.reEncryptAllKeys();

      expect(count).toBe(2); // 1 endpoint + 1 legacy
      expect(reEncrypt).toHaveBeenCalledWith('enc_key_123');
      expect(reEncrypt).toHaveBeenCalledWith('legacy_key');
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'default' },
        { $set: expect.objectContaining({
          endpoints: expect.arrayContaining([
            expect.objectContaining({ apiKeyEncrypted: 're_enc_key_123' }),
          ]),
          apiKeyEncrypted: 're_legacy_key',
        })}
      );
    });

    it('should return 0 when config is null', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      const count = await model.reEncryptAllKeys();
      expect(count).toBe(0);
    });

    it('should skip re-encryption when cipher unchanged', async () => {
      const { reEncrypt } = require('../../lib/crypto');
      reEncrypt.mockImplementation((c: string) => c); // same cipher
      const config = makeV2Config();
      mockCollection.findOne.mockResolvedValue(config);

      const count = await model.reEncryptAllKeys();

      expect(count).toBe(0);
      expect(mockCollection.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('getResolvedModelConfigs', () => {
    it('should return ordered configs matching selectedModels', async () => {
      const config = makeV2Config({
        endpoints: [
          { id: 'ep-1', name: 'Primary', apiBaseUrl: 'https://primary.com', apiKeyEncrypted: 'k1', models: ['m1'], enabled: true },
          { id: 'ep-2', name: 'Fallback', apiBaseUrl: 'https://fallback.com', apiKeyEncrypted: 'k2', models: ['m2'], enabled: true },
        ],
        selectedModels: [
          { endpointId: 'ep-2', modelName: 'm2' },
          { endpointId: 'ep-1', modelName: 'm1' },
        ],
        timeoutSeconds: 45,
      });
      mockCollection.findOne.mockResolvedValue(config);

      const results = await model.getResolvedModelConfigs();

      expect(results).toHaveLength(2);
      expect(results[0].endpointName).toBe('Fallback');
      expect(results[0].modelName).toBe('m2');
      expect(results[1].endpointName).toBe('Primary');
      expect(results[1].modelName).toBe('m1');
      expect(results[0].timeoutSeconds).toBe(45);
    });

    it('should skip disabled endpoints', async () => {
      const config = makeV2Config({
        endpoints: [
          { id: 'ep-1', name: 'Disabled', apiBaseUrl: 'https://d.com', apiKeyEncrypted: 'k1', models: ['m1'], enabled: false },
        ],
        selectedModels: [{ endpointId: 'ep-1', modelName: 'm1' }],
      });
      mockCollection.findOne.mockResolvedValue(config);

      const results = await model.getResolvedModelConfigs();
      expect(results).toHaveLength(0);
    });

    it('should return empty array when config is null', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      const results = await model.getResolvedModelConfigs();
      expect(results).toEqual([]);
    });

    it('should skip selectedModels referencing missing endpoints', async () => {
      const config = makeV2Config({
        endpoints: [
          { id: 'ep-1', name: 'EP1', apiBaseUrl: 'https://e.com', apiKeyEncrypted: 'k', models: ['m'], enabled: true },
        ],
        selectedModels: [
          { endpointId: 'ep-missing', modelName: 'x' },
          { endpointId: 'ep-1', modelName: 'm' },
        ],
      });
      mockCollection.findOne.mockResolvedValue(config);

      const results = await model.getResolvedModelConfigs();
      expect(results).toHaveLength(1);
      expect(results[0].endpointId).toBe('ep-1');
    });
  });

  describe('initializeDefaultConfig', () => {
    it('should create default config when none exists', async () => {
      mockCollection.findOne.mockResolvedValue(null);
      mockCollection.insertOne.mockResolvedValue({});

      await model.initializeDefaultConfig({
        rateLimitPerMinute: 5,
        timeoutSeconds: 30,
      });

      expect(mockCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: 'default',
          configVersion: CURRENT_CONFIG_VERSION,
          endpoints: [],
          selectedModels: [],
          rateLimitPerMinute: 5,
          timeoutSeconds: 30,
        })
      );
    });

    it('should skip initialization when config already exists', async () => {
      mockCollection.findOne.mockResolvedValue(makeV2Config());

      await model.initializeDefaultConfig({
        rateLimitPerMinute: 5,
        timeoutSeconds: 30,
      });

      expect(mockCollection.insertOne).not.toHaveBeenCalled();
    });
  });

  describe('deleteConfig', () => {
    it('should delete the fixed config record', async () => {
      mockCollection.deleteOne.mockResolvedValue({});

      await model.deleteConfig();

      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: 'default' });
    });
  });

  describe('ensureIndexes', () => {
    it('should log initialization message', async () => {
      await model.ensureIndexes();
      expect(console.log).toHaveBeenCalledWith('[AIConfigModel] Collection initialized');
    });
  });
});
