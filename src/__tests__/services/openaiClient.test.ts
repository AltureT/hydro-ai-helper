jest.mock('axios');
jest.mock('../../lib/crypto', () => ({
  decrypt: jest.fn((c: string) => c.replace('enc_', 'dec_')),
}));

import axios from 'axios';
import {
  AIServiceError,
  OpenAIClient,
  MultiModelClient,
  AIClientConfig,
  ResolvedModelConfig,
  ErrorCategory,
  StreamCallbacks,
  fetchAvailableModels,
  createMultiModelClientFromConfig,
  createOpenAIClientFromConfig,
  getHttpStatusForCategory,
} from '../../services/openaiClient';

const mockedAxios = axios as jest.Mocked<typeof axios>;

// ─── Test Helpers ─────────────────────────────────────

function createAxiosError(status: number, message?: string) {
  const error: any = new Error(message || `Request failed with status code ${status}`);
  error.isAxiosError = true;
  error.response = {
    status,
    data: { error: { message: message || 'error' } },
    headers: {},
    statusText: '',
    config: {},
  };
  error.config = {};
  return error;
}

function createTimeoutError() {
  const error: any = new Error('timeout of 30000ms exceeded');
  error.isAxiosError = true;
  error.code = 'ECONNABORTED';
  error.config = {};
  return error;
}

function createNetworkError(code: string) {
  const error: any = new Error('Network Error');
  error.isAxiosError = true;
  error.code = code;
  error.config = {};
  return error;
}

const defaultConfig: AIClientConfig = {
  apiBaseUrl: 'https://api.test.com/v1',
  modelName: 'test-model',
  apiKey: 'test-key',
  timeoutSeconds: 30,
};

function makeResolvedConfig(overrides?: Partial<ResolvedModelConfig>): ResolvedModelConfig {
  return {
    endpointId: 'ep-1',
    endpointName: 'TestEndpoint',
    apiBaseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    modelName: 'test-model',
    timeoutSeconds: 30,
    ...overrides,
  };
}

function mockSuccessResponse(content: string = 'Hello!') {
  mockedAxios.post.mockResolvedValueOnce({
    data: {
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  });
}

function mockSignalAwareNeverResolve() {
  mockedAxios.post.mockImplementation((_url: any, _data: any, config: any) => {
    return new Promise((_resolve, reject) => {
      const signal = config?.signal;
      if (signal?.aborted) {
        reject(new Error('canceled'));
        return;
      }
      signal?.addEventListener('abort', () => {
        reject(new Error('canceled'));
      }, { once: true });
    });
  });
}

// ─── AIServiceError ───────────────────────────────────

describe('AIServiceError', () => {
  it('should set category, httpStatus, and name', () => {
    const error = new AIServiceError('test message', 'auth', 401);
    expect(error.name).toBe('AIServiceError');
    expect(error.message).toBe('test message');
    expect(error.category).toBe('auth');
    expect(error.httpStatus).toBe(401);
  });

  it('should mark retryable categories as isRetryable=true', () => {
    const retryable: ErrorCategory[] = ['rate_limit', 'server', 'timeout', 'network'];
    for (const cat of retryable) {
      expect(new AIServiceError('test', cat).isRetryable).toBe(true);
    }
  });

  it('should mark non-retryable categories as isRetryable=false', () => {
    const nonRetryable: ErrorCategory[] = ['auth', 'client', 'aborted', 'unknown'];
    for (const cat of nonRetryable) {
      expect(new AIServiceError('test', cat).isRetryable).toBe(false);
    }
  });

  it('should be instanceof Error', () => {
    const error = new AIServiceError('test', 'unknown');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AIServiceError);
  });

  it('should allow httpStatus to be undefined', () => {
    const error = new AIServiceError('test', 'timeout');
    expect(error.httpStatus).toBeUndefined();
  });
});

// ─── OpenAIClient ─────────────────────────────────────

describe('OpenAIClient', () => {
  let client: OpenAIClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.isAxiosError.mockImplementation((error: any) => !!error?.isAxiosError);
    mockedAxios.isCancel.mockReturnValue(false);
    client = new OpenAIClient(defaultConfig);
  });

  describe('chat()', () => {
    it('should return AI response on success', async () => {
      mockSuccessResponse('Test response');
      const result = await client.chat([{ role: 'user', content: 'Hi' }], 'System');
      expect(result.content).toBe('Test response');
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it('should pass signal to axios', async () => {
      mockSuccessResponse();
      const ac = new AbortController();
      await client.chat([{ role: 'user', content: 'Hi' }], 'System', { signal: ac.signal });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ signal: ac.signal }),
      );
    });

    it('should pass httpAgent and httpsAgent to axios', async () => {
      mockSuccessResponse();
      await client.chat([{ role: 'user', content: 'Hi' }], 'System');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          httpAgent: expect.any(Object),
          httpsAgent: expect.any(Object),
        }),
      );
    });

    it('should throw AIServiceError with category=auth on 401', async () => {
      mockedAxios.post.mockRejectedValueOnce(createAxiosError(401));
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'auth', httpStatus: 401 });
    });

    it('should throw AIServiceError with category=auth on 403', async () => {
      mockedAxios.post.mockRejectedValueOnce(createAxiosError(403));
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'auth', httpStatus: 403 });
    });

    it('should throw AIServiceError with category=rate_limit on 429', async () => {
      mockedAxios.post.mockRejectedValueOnce(createAxiosError(429));
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'rate_limit', httpStatus: 429 });
    });

    it('should throw AIServiceError with category=server on 5xx', async () => {
      mockedAxios.post.mockRejectedValueOnce(createAxiosError(503));
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'server', httpStatus: 503 });
    });

    it('should throw AIServiceError with category=client on 4xx', async () => {
      mockedAxios.post.mockRejectedValueOnce(createAxiosError(400, 'Bad request'));
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'client', httpStatus: 400 });
    });

    it('should throw AIServiceError with category=timeout on ECONNABORTED', async () => {
      mockedAxios.post.mockRejectedValueOnce(createTimeoutError());
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'timeout' });
    });

    it('should throw AIServiceError with category=aborted on cancel', async () => {
      const cancelError = new Error('canceled');
      mockedAxios.post.mockRejectedValueOnce(cancelError);
      mockedAxios.isCancel.mockReturnValueOnce(true);
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'aborted' });
    });

    it('should throw AIServiceError with category=network on ENOTFOUND', async () => {
      mockedAxios.post.mockRejectedValueOnce(createNetworkError('ENOTFOUND'));
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'network' });
    });

    it('should throw AIServiceError with category=network on ECONNREFUSED', async () => {
      mockedAxios.post.mockRejectedValueOnce(createNetworkError('ECONNREFUSED'));
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'network' });
    });

    it('should throw AIServiceError with category=server on empty response', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
      });
      await expect(client.chat([{ role: 'user', content: 'Hi' }], 'System'))
        .rejects.toMatchObject({ category: 'server' });
    });
  });
});

// ─── MultiModelClient ─────────────────────────────────

describe('MultiModelClient', () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockedAxios.isAxiosError.mockImplementation((error: any) => !!error?.isAxiosError);
    mockedAxios.isCancel.mockReturnValue(false);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('retry behavior', () => {
    it('should retry on 503 and succeed on third attempt', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);

      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(503))
        .mockRejectedValueOnce(createAxiosError(503))
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { role: 'assistant', content: 'Success after retry' }, finish_reason: 'stop' }],
          },
        });

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System');

      // Advance past backoff delays (attempt 0: ~1s, attempt 1: ~2s)
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(5000);

      const result = await chatPromise;
      expect(result.content).toBe('Success after retry');
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    });

    it('should not retry on auth error (401)', async () => {
      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-b' }),
      ]);

      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(401))
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { role: 'assistant', content: 'From model-b' }, finish_reason: 'stop' }],
          },
        });

      const result = await client.chat([{ role: 'user', content: 'Hi' }], 'System');
      expect(result.content).toBe('From model-b');
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should skip all models from same endpoint on auth error', async () => {
      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-b' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-c' }),
      ]);

      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(401))
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { role: 'assistant', content: 'From model-c' }, finish_reason: 'stop' }],
          },
        });

      const result = await client.chat([{ role: 'user', content: 'Hi' }], 'System');
      expect(result.content).toBe('From model-c');
      // model-a fails (1), model-b skipped (0), model-c success (1) = 2 calls
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should not retry on client error (404)', async () => {
      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-b' }),
      ]);

      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(404, 'Model not found'))
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { role: 'assistant', content: 'From model-b' }, finish_reason: 'stop' }],
          },
        });

      const result = await client.chat([{ role: 'user', content: 'Hi' }], 'System');
      expect(result.content).toBe('From model-b');
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should retry rate_limit errors', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);

      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(429))
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { role: 'assistant', content: 'Success' }, finish_reason: 'stop' }],
          },
        });

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System');

      await jest.advanceTimersByTimeAsync(3000);

      const result = await chatPromise;
      expect(result.content).toBe('Success');
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('total timeout', () => {
    it('should throw timeout error after 60s total', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);

      mockSignalAwareNeverResolve();
      mockedAxios.isCancel.mockReturnValue(true);

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System');
      // Eagerly attach catch to prevent unhandled rejection during timer advancement
      const errorPromise = chatPromise.catch((e: unknown) => e);

      await jest.advanceTimersByTimeAsync(61_000);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(AIServiceError);
      expect((error as AIServiceError).category).toBe('timeout');
      expect((error as AIServiceError).message).toContain('总超时');
    });
  });

  describe('external signal', () => {
    it('should throw aborted error when external signal fires', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);
      const ac = new AbortController();

      mockSignalAwareNeverResolve();
      mockedAxios.isCancel.mockReturnValue(true);

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System', { signal: ac.signal });
      const errorPromise = chatPromise.catch((e: unknown) => e);

      ac.abort();
      await jest.advanceTimersByTimeAsync(100);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(AIServiceError);
      expect((error as AIServiceError).category).toBe('aborted');
    });

    it('should throw immediately if signal already aborted', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);
      const ac = new AbortController();
      ac.abort();

      try {
        await client.chat([{ role: 'user', content: 'Hi' }], 'System', { signal: ac.signal });
        throw new Error('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AIServiceError);
        expect((error as AIServiceError).category).toBe('aborted');
      }

      // Should not have called axios at all
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('fallback with retry', () => {
    it('should fallback to second model after first exhausts retries', async () => {
      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-b' }),
      ]);

      // model-a: 3 failures (initial + 2 retries)
      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(503))
        .mockRejectedValueOnce(createAxiosError(503))
        .mockRejectedValueOnce(createAxiosError(503))
        // model-b: success
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { role: 'assistant', content: 'From model-b' }, finish_reason: 'stop' }],
          },
        });

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System');

      // Advance timers for two backoff delays
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(5000);

      const result = await chatPromise;
      expect(result.content).toBe('From model-b');
      expect(result.usedModel.modelName).toBe('model-b');
      expect(mockedAxios.post).toHaveBeenCalledTimes(4);
    });

    it('should handle mixed error types across models', async () => {
      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-b' }),
        makeResolvedConfig({ endpointId: 'ep-3', modelName: 'model-c' }),
      ]);

      mockedAxios.post
        // model-a: auth error (no retry, skip endpoint)
        .mockRejectedValueOnce(createAxiosError(401))
        // model-b: client error (no retry)
        .mockRejectedValueOnce(createAxiosError(404, 'Not found'))
        // model-c: success
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { role: 'assistant', content: 'From model-c' }, finish_reason: 'stop' }],
          },
        });

      const result = await client.chat([{ role: 'user', content: 'Hi' }], 'System');
      expect(result.content).toBe('From model-c');
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    });
  });

  describe('structured logging', () => {
    it('should log structured JSON on total failure', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);

      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(503))
        .mockRejectedValueOnce(createAxiosError(503))
        .mockRejectedValueOnce(createAxiosError(503));

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System');
      const errorPromise = chatPromise.catch((e: unknown) => e);

      await jest.advanceTimersByTimeAsync(10_000);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(AIServiceError);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[MultiModelClient] 所有模型均失败:',
        expect.stringContaining('"totalAttempts":3')
      );
    });

    it('should throw user-friendly error message based on dominant category', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);

      mockedAxios.post
        .mockRejectedValueOnce(createAxiosError(503))
        .mockRejectedValueOnce(createAxiosError(503))
        .mockRejectedValueOnce(createAxiosError(503));

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System');
      const errorPromise = chatPromise.catch((e: unknown) => e);

      await jest.advanceTimersByTimeAsync(10_000);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(AIServiceError);
      expect((error as AIServiceError).category).toBe('server');
      expect((error as AIServiceError).message).toBe('AI 服务暂时不可用，请稍后再试');
    });

    it('should include skipped endpoints in structured log', async () => {
      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
      ]);

      mockedAxios.post.mockRejectedValueOnce(createAxiosError(401));

      const chatPromise = client.chat([{ role: 'user', content: 'Hi' }], 'System');

      await expect(chatPromise).rejects.toThrow(AIServiceError);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[MultiModelClient] 所有模型均失败:',
        expect.stringContaining('"skippedEndpoints":["ep-1"]')
      );
    });
  });

  describe('constructor', () => {
    it('should throw if no models provided', () => {
      expect(() => new MultiModelClient([])).toThrow('至少需要配置一个模型');
    });
  });

  // ─── chatStream ───────────────────────────────────

  describe('chatStream', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return usedModel on first model success', async () => {
      jest.spyOn(OpenAIClient.prototype, 'chatStream').mockResolvedValueOnce(undefined as any);

      const client = new MultiModelClient([makeResolvedConfig()]);
      const callbacks: StreamCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
      const result = await client.chatStream([], 'System', { callbacks });

      expect(result.usedModel.modelName).toBe('test-model');
      expect(result.usedModel.endpointName).toBe('TestEndpoint');
    });

    it('should skip endpoint on auth error and succeed with next', async () => {
      const spy = jest.spyOn(OpenAIClient.prototype, 'chatStream')
        .mockRejectedValueOnce(new AIServiceError('auth fail', 'auth', 401))
        .mockResolvedValueOnce(undefined as any);

      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-b' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-c' }),
      ]);
      const callbacks: StreamCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
      const result = await client.chatStream([], 'System', { callbacks });

      expect(result.usedModel.modelName).toBe('model-c');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('should skip model on client error and try next', async () => {
      jest.spyOn(OpenAIClient.prototype, 'chatStream')
        .mockRejectedValueOnce(new AIServiceError('not supported', 'client', 400))
        .mockResolvedValueOnce(undefined as any);

      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-b' }),
      ]);
      const callbacks: StreamCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
      const result = await client.chatStream([], 'System', { callbacks });

      expect(result.usedModel.modelName).toBe('model-b');
    });

    it('should throw immediately on aborted error', async () => {
      jest.spyOn(OpenAIClient.prototype, 'chatStream')
        .mockRejectedValueOnce(new AIServiceError('canceled', 'aborted'));

      const client = new MultiModelClient([
        makeResolvedConfig(),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-b' }),
      ]);
      const callbacks: StreamCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };

      await expect(client.chatStream([], 'System', { callbacks }))
        .rejects.toMatchObject({ category: 'aborted' });
    });

    it('should throw dominant category when all models fail', async () => {
      jest.spyOn(OpenAIClient.prototype, 'chatStream')
        .mockRejectedValueOnce(new AIServiceError('server error', 'server', 503))
        .mockRejectedValueOnce(new AIServiceError('server error', 'server', 503));

      const client = new MultiModelClient([
        makeResolvedConfig({ endpointId: 'ep-1', modelName: 'model-a' }),
        makeResolvedConfig({ endpointId: 'ep-2', modelName: 'model-b' }),
      ]);
      const callbacks: StreamCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };

      await expect(client.chatStream([], 'System', { callbacks }))
        .rejects.toMatchObject({ category: 'server' });
    });

    it('should throw immediately if signal already aborted', async () => {
      const client = new MultiModelClient([makeResolvedConfig()]);
      const ac = new AbortController();
      ac.abort();

      const callbacks: StreamCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };

      await expect(client.chatStream([], 'System', { signal: ac.signal, callbacks }))
        .rejects.toMatchObject({ category: 'aborted' });
    });
  });
});

// ─── fetchAvailableModels ─────────────────────────────

describe('fetchAvailableModels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.isAxiosError.mockImplementation((error: any) => !!error?.isAxiosError);
  });

  it('should return filtered and sorted chat models', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'gpt-4o', object: 'model' },
          { id: 'gpt-3.5-turbo', object: 'model' },
          { id: 'text-embedding-ada-002', object: 'model' },
          { id: 'whisper-1', object: 'model' },
          { id: 'dall-e-3', object: 'model' },
        ],
      },
    });

    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(true);
    expect(result.models).toEqual(['gpt-3.5-turbo', 'gpt-4o']);
  });

  it('should include models with chat capability', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'custom-model', object: 'model', capabilities: { chat: true } },
          { id: 'custom-embed', object: 'model', capabilities: { chat: false } },
        ],
      },
    });

    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.models).toEqual(['custom-model']);
  });

  it('should exclude embedding/whisper/tts/audio models', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'gpt-4o', object: 'model' },
          { id: 'gpt-4o-audio-preview', object: 'model' },
          { id: 'text-embedding-3-large', object: 'model' },
        ],
      },
    });

    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.models).toEqual(['gpt-4o']);
  });

  it('should match ep- keyword for Volcengine endpoints', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'ep-20241234567890-xxxxx', object: 'model' },
          { id: 'some-random-model', object: 'model' },
        ],
      },
    });

    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.models).toEqual(['ep-20241234567890-xxxxx']);
  });

  it('should strip trailing slashes from URL', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } });
    await fetchAvailableModels('https://api.test.com/v1/', 'key');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models',
      expect.any(Object),
    );
  });

  it('should return error for invalid response format', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: {} });
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少 data 字段');
  });

  it('should return error on 401', async () => {
    mockedAxios.get.mockRejectedValueOnce(createAxiosError(401));
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效或已过期');
  });

  it('should return error on 403', async () => {
    mockedAxios.get.mockRejectedValueOnce(createAxiosError(403));
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('无权访问');
  });

  it('should return error on 404', async () => {
    mockedAxios.get.mockRejectedValueOnce(createAxiosError(404));
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('不支持获取模型列表');
  });

  it('should return error on 5xx', async () => {
    mockedAxios.get.mockRejectedValueOnce(createAxiosError(500));
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('获取模型列表失败');
  });

  it('should return error on timeout', async () => {
    mockedAxios.get.mockRejectedValueOnce(createTimeoutError());
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('请求超时');
  });

  it('should return error on ENOTFOUND', async () => {
    mockedAxios.get.mockRejectedValueOnce(createNetworkError('ENOTFOUND'));
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('无法连接');
  });

  it('should return generic network error for unknown axios code', async () => {
    mockedAxios.get.mockRejectedValueOnce(createNetworkError('EPIPE'));
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('网络错误');
  });

  it('should return error on non-axios error', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('unexpected'));
    const result = await fetchAvailableModels('https://api.test.com/v1', 'key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('unexpected');
  });
});

// ─── createMultiModelClientFromConfig ─────────────────

describe('createMultiModelClientFromConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeCtx(config: any) {
    return {
      get: jest.fn().mockReturnValue({
        getConfig: jest.fn().mockResolvedValue(config),
      }),
    } as any;
  }

  it('should create client from v2 multi-endpoint config', async () => {
    const config = {
      endpoints: [
        { id: 'ep-1', name: 'Primary', apiBaseUrl: 'https://api.test.com/v1', apiKeyEncrypted: 'enc_key1', models: ['gpt-4o'], enabled: true },
      ],
      selectedModels: [{ endpointId: 'ep-1', modelName: 'gpt-4o' }],
      timeoutSeconds: 45,
    };

    const client = await createMultiModelClientFromConfig(makeCtx(config));
    expect(client).toBeInstanceOf(MultiModelClient);
  });

  it('should skip disabled endpoints in v2 config', async () => {
    const config = {
      endpoints: [
        { id: 'ep-1', name: 'Disabled', apiBaseUrl: 'https://d.com', apiKeyEncrypted: 'enc_k1', models: ['m1'], enabled: false },
        { id: 'ep-2', name: 'Enabled', apiBaseUrl: 'https://e.com', apiKeyEncrypted: 'enc_k2', models: ['m2'], enabled: true },
      ],
      selectedModels: [
        { endpointId: 'ep-1', modelName: 'm1' },
        { endpointId: 'ep-2', modelName: 'm2' },
      ],
      timeoutSeconds: 30,
    };

    const client = await createMultiModelClientFromConfig(makeCtx(config));
    expect(client).toBeInstanceOf(MultiModelClient);
  });

  it('should skip endpoints with decrypt failure and warn', async () => {
    const { decrypt } = require('../../lib/crypto');
    decrypt
      .mockImplementationOnce(() => { throw new Error('decrypt failed'); })
      .mockReturnValueOnce('dec_k2');

    const config = {
      endpoints: [
        { id: 'ep-1', name: 'Bad Key', apiBaseUrl: 'https://bad.com', apiKeyEncrypted: 'bad_key', models: ['m1'], enabled: true },
        { id: 'ep-2', name: 'Good Key', apiBaseUrl: 'https://good.com', apiKeyEncrypted: 'enc_k2', models: ['m2'], enabled: true },
      ],
      selectedModels: [
        { endpointId: 'ep-1', modelName: 'm1' },
        { endpointId: 'ep-2', modelName: 'm2' },
      ],
      timeoutSeconds: 30,
    };

    const client = await createMultiModelClientFromConfig(makeCtx(config));
    expect(client).toBeInstanceOf(MultiModelClient);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('解密失败'));
  });

  it('should fallback to legacy single-endpoint config', async () => {
    const config = {
      apiBaseUrl: 'https://api.test.com/v1',
      modelName: 'gpt-4o',
      apiKeyEncrypted: 'enc_key1',
      timeoutSeconds: 30,
    };

    const client = await createMultiModelClientFromConfig(makeCtx(config));
    expect(client).toBeInstanceOf(MultiModelClient);
  });

  it('should throw when config is null', async () => {
    await expect(createMultiModelClientFromConfig(makeCtx(null)))
      .rejects.toThrow('AI 服务尚未配置');
  });

  it('should throw when legacy config is incomplete', async () => {
    const config = {
      apiBaseUrl: '',
      modelName: '',
      apiKeyEncrypted: '',
      timeoutSeconds: 30,
    };

    await expect(createMultiModelClientFromConfig(makeCtx(config)))
      .rejects.toThrow('配置不完整');
  });

  it('should throw when legacy decrypt fails', async () => {
    const { decrypt } = require('../../lib/crypto');
    decrypt.mockImplementationOnce(() => { throw new Error('bad key'); });

    const config = {
      apiBaseUrl: 'https://api.test.com/v1',
      modelName: 'gpt-4o',
      apiKeyEncrypted: 'bad_enc',
      timeoutSeconds: 30,
    };

    await expect(createMultiModelClientFromConfig(makeCtx(config)))
      .rejects.toThrow('API Key 解密失败');
  });
});

// ─── getHttpStatusForCategory ─────────────────────────

describe('getHttpStatusForCategory', () => {
  it.each<[ErrorCategory, number]>([
    ['rate_limit', 429],
    ['auth', 503],
    ['timeout', 504],
    ['network', 502],
    ['server', 502],
    ['client', 500],
    ['aborted', 499],
    ['unknown', 500],
  ])('should return %i for category "%s"', (category, expected) => {
    expect(getHttpStatusForCategory(category)).toBe(expected);
  });
});

// ─── createOpenAIClientFromConfig ─────────────────────

describe('createOpenAIClientFromConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeCtx(config: any) {
    return {
      get: jest.fn().mockReturnValue({
        getConfig: jest.fn().mockResolvedValue(config),
      }),
    } as any;
  }

  it('should create client from valid legacy config', async () => {
    const config = {
      apiBaseUrl: 'https://api.test.com/v1',
      modelName: 'gpt-4o',
      apiKeyEncrypted: 'enc_key1',
      timeoutSeconds: 45,
    };

    const client = await createOpenAIClientFromConfig(makeCtx(config));
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('should use existingConfig when provided', async () => {
    const config = {
      apiBaseUrl: 'https://api.test.com/v1',
      modelName: 'gpt-4o',
      apiKeyEncrypted: 'enc_key1',
      timeoutSeconds: 30,
    };

    const ctx = makeCtx(null);
    const client = await createOpenAIClientFromConfig(ctx, config as any);
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('should throw when config is null', async () => {
    await expect(createOpenAIClientFromConfig(makeCtx(null)))
      .rejects.toThrow('AI 服务尚未配置');
  });

  it('should throw when config is incomplete', async () => {
    await expect(createOpenAIClientFromConfig(makeCtx({ apiBaseUrl: '', modelName: '', apiKeyEncrypted: '' })))
      .rejects.toThrow('配置不完整');
  });

  it('should throw when decrypt fails', async () => {
    const { decrypt } = require('../../lib/crypto');
    decrypt.mockImplementationOnce(() => { throw new Error('bad key'); });

    const config = {
      apiBaseUrl: 'https://api.test.com/v1',
      modelName: 'gpt-4o',
      apiKeyEncrypted: 'bad_enc',
      timeoutSeconds: 30,
    };

    await expect(createOpenAIClientFromConfig(makeCtx(config)))
      .rejects.toThrow('API Key 解密失败');
  });
});
