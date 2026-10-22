jest.mock('../../lib/crypto', () => ({ decrypt: () => 'synthetic-key' }));
jest.mock('../../lib/rateLimitHelper', () => ({ applyRateLimit: jest.fn().mockResolvedValue(false) }));
jest.mock('../../services/openaiClient', () => ({ fetchAvailableModels: jest.fn(), OpenAIClient: jest.fn() }));

import { FetchModelsHandler, TestConnectionHandler } from '../../handlers/adminHandler';
import { fetchAvailableModels, OpenAIClient } from '../../services/openaiClient';

function makeHandler(HandlerClass: typeof FetchModelsHandler | typeof TestConnectionHandler) {
  const handler = new HandlerClass();
  handler.request = { headers: { 'x-requested-with': 'XMLHttpRequest' }, body: { endpointId: 'ep-1' } };
  handler.response = {};
  handler.translate = (key: string) => key;
  return handler;
}

describe('Model discovery and connection handlers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('preserves manually configured IDs on refresh and persists provider capability metadata', async () => {
    const handler = makeHandler(FetchModelsHandler);
    const getEndpointById = jest.fn().mockResolvedValue({
      apiBaseUrl: 'https://api.example.com/v1', apiKeyEncrypted: 'synthetic-ciphertext', models: ['Manual/Custom-V3'],
    });
    const updateEndpoint = jest.fn().mockResolvedValue(undefined);
    handler.ctx = { Route: jest.fn(), get: () => ({ getEndpointById, updateEndpoint }) };
    (fetchAvailableModels as jest.Mock).mockResolvedValue({
      success: true, models: ['new-model'], modelChatSupport: { 'new-model': true },
    });
    await handler.post();
    expect(updateEndpoint).toHaveBeenCalledWith('ep-1', {
      models: ['Manual/Custom-V3', 'new-model'], modelChatSupport: { 'new-model': true }, modelsLastFetched: expect.any(Date),
    });
    expect(handler.response.body.models).toEqual(['Manual/Custom-V3', 'new-model']);
    expect(handler.response.body.modelChatSupport).toEqual({ 'new-model': true });
  });

  it('does not overwrite stored models when listing is unsupported', async () => {
    const handler = makeHandler(FetchModelsHandler);
    const updateEndpoint = jest.fn();
    handler.ctx = { Route: jest.fn(), get: () => ({
      getEndpointById: jest.fn().mockResolvedValue({ apiBaseUrl: 'https://api.example.com/v1', apiKeyEncrypted: 'synthetic-ciphertext' }),
      updateEndpoint,
    }) };
    (fetchAvailableModels as jest.Mock).mockResolvedValue({ success: false, errorKey: 'ai_helper_admin_models_not_supported' });
    await handler.post();
    expect(handler.response.body.success).toBe(false);
    expect(updateEndpoint).not.toHaveBeenCalled();
  });

  it('tests a saved arbitrary model ID without requiring it to appear in a fetched list', async () => {
    const handler = makeHandler(TestConnectionHandler);
    handler.ctx = { Route: jest.fn(), get: () => ({ getConfig: async () => ({
      endpoints: [{ id: 'ep-1', enabled: true, apiBaseUrl: 'https://api.example.com/v1', apiKeyEncrypted: 'synthetic-ciphertext', models: ['Manual/Custom-V3'] }],
      selectedModels: [{ endpointId: 'ep-1', modelName: 'Manual/Custom-V3' }],
    }) }) };
    const chat = jest.fn().mockResolvedValue({ content: 'OK' });
    (OpenAIClient as jest.Mock).mockImplementation(() => ({ chat }));
    await handler.post();
    expect(OpenAIClient).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'Manual/Custom-V3' }));
    expect(chat).toHaveBeenCalled();
    expect(handler.response.body.success).toBe(true);
  });
});
