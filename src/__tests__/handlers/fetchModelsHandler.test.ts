jest.mock('../../lib/crypto', () => ({ decrypt: () => 'synthetic-key' }));
jest.mock('../../lib/rateLimitHelper', () => ({ applyRateLimit: jest.fn().mockResolvedValue(false) }));
jest.mock('../../services/openaiClient', () => ({
  AIServiceError: jest.requireActual('../../services/openaiClient').AIServiceError,
  fetchAvailableModels: jest.fn(),
  OpenAIClient: jest.fn(),
}));

import { FetchModelsHandler, TestConnectionHandler } from '../../handlers/adminHandler';
import { AIServiceError, fetchAvailableModels, OpenAIClient } from '../../services/openaiClient';

function makeHandler(HandlerClass: typeof FetchModelsHandler | typeof TestConnectionHandler) {
  const handler = new HandlerClass();
  handler.request = { headers: { 'x-requested-with': 'XMLHttpRequest' }, body: { endpointId: 'ep-1' } };
  handler.response = {};
  handler.translate = (key: string) => (key.endsWith('_detail') ? `${key}:{0}|{1}` : key);
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
    const chatStream = jest.fn().mockResolvedValue(undefined);
    (OpenAIClient as jest.Mock).mockImplementation(() => ({ chat, chatStream }));
    await handler.post();
    expect(OpenAIClient).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'Manual/Custom-V3' }));
    expect(chat).toHaveBeenCalled();
    expect(chatStream).toHaveBeenCalled();
    expect(handler.response.body.success).toBe(true);
  });

  const savedConfig = {
    endpoints: [
      { id: 'ep-old', name: 'Old', enabled: false, apiBaseUrl: 'https://old.example.com/v1', apiKeyEncrypted: 'synthetic-ciphertext', models: ['old-model'] },
      { id: 'ep-new', name: 'New', enabled: true, apiBaseUrl: 'https://new.example.com/v1', apiKeyEncrypted: 'synthetic-ciphertext', models: ['new-model'] },
    ],
    selectedModels: [
      { endpointId: 'ep-old', modelName: 'old-model' },
      { endpointId: 'ep-new', modelName: 'new-model' },
    ],
  };

  it('names the tested endpoint and model and shows the provider error when the call fails', async () => {
    const handler = makeHandler(TestConnectionHandler);
    handler.ctx = { Route: jest.fn(), get: () => ({ getConfig: async () => savedConfig }) };
    const chat = jest.fn().mockRejectedValue(new AIServiceError('API Key 无效或已过期', 'auth', 401, {
      upstreamMessage: 'Insufficient account balance',
    }));
    (OpenAIClient as jest.Mock).mockImplementation(() => ({ chat }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handler.post();
    warn.mockRestore();
    expect(OpenAIClient).toHaveBeenCalledWith(expect.objectContaining({ apiBaseUrl: 'https://new.example.com/v1', modelName: 'new-model' }));
    expect(handler.response.body).toEqual({
      success: false,
      message: 'ai_helper_admin_test_call_failed_detail:New / new-model|API Key 无效或已过期：Insufficient account balance',
    });
  });

  it('does not repeat a provider message that the error text already contains', async () => {
    const handler = makeHandler(TestConnectionHandler);
    handler.ctx = { Route: jest.fn(), get: () => ({ getConfig: async () => savedConfig }) };
    const chat = jest.fn().mockRejectedValue(new AIServiceError('AI API 错误 (HTTP 400): model not found', 'client', 400, {
      upstreamMessage: 'model not found',
    }));
    (OpenAIClient as jest.Mock).mockImplementation(() => ({ chat }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handler.post();
    warn.mockRestore();
    expect(handler.response.body.message).toBe('ai_helper_admin_test_call_failed_detail:New / new-model|AI API 错误 (HTTP 400): model not found');
  });

  it('names the tested model on success', async () => {
    const handler = makeHandler(TestConnectionHandler);
    handler.ctx = { Route: jest.fn(), get: () => ({ getConfig: async () => savedConfig }) };
    (OpenAIClient as jest.Mock).mockImplementation(() => ({
      chat: jest.fn().mockResolvedValue({ content: 'pong' }),
      chatStream: jest.fn().mockResolvedValue(undefined),
    }));
    await handler.post();
    expect(handler.response.body).toEqual({ success: true, message: 'ai_helper_admin_test_success_detail:New / new-model|{1}' });
  });

  it('fails when regular calls work but the streaming call that student chat uses does not', async () => {
    const handler = makeHandler(TestConnectionHandler);
    handler.ctx = { Route: jest.fn(), get: () => ({ getConfig: async () => savedConfig }) };
    (OpenAIClient as jest.Mock).mockImplementation(() => ({
      chat: jest.fn().mockResolvedValue({ content: 'pong' }),
      chatStream: jest.fn().mockRejectedValue(new AIServiceError('AI 返回内容为空', 'server', undefined, {
        upstreamMessage: '收到 0 个数据事件，响应开头: event: x',
      })),
    }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handler.post();
    warn.mockRestore();
    expect(handler.response.body).toEqual({
      success: false,
      message: 'ai_helper_admin_test_stream_failed_detail:New / new-model|AI 返回内容为空：收到 0 个数据事件，响应开头: event: x',
    });
  });
});
