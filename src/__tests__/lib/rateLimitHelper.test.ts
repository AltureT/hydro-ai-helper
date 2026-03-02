import { applyRateLimit } from '../../lib/rateLimitHelper';

describe('applyRateLimit', () => {
  let mockHandler: any;

  beforeEach(() => {
    mockHandler = {
      limitRate: jest.fn(),
      response: {
        status: 200,
        body: null,
        type: '',
      },
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return false (allow) when limitRate succeeds', async () => {
    mockHandler.limitRate.mockResolvedValue(undefined);

    const blocked = await applyRateLimit(mockHandler, {
      op: 'ai_chat',
      periodSecs: 60,
      maxOps: 5,
    });

    expect(blocked).toBe(false);
    expect(mockHandler.limitRate).toHaveBeenCalledWith('ai_chat', 60, 5);
  });

  it('should pass custom key to limitRate', async () => {
    mockHandler.limitRate.mockResolvedValue(undefined);

    await applyRateLimit(mockHandler, {
      op: 'ai_chat',
      periodSecs: 60,
      maxOps: 5,
      key: '{{ip}}@{{user}}',
    });

    expect(mockHandler.limitRate).toHaveBeenCalledWith('ai_chat', 60, 5, '{{ip}}@{{user}}');
  });

  it('should return true (block) and set 429 on OpcountExceededError (by name)', async () => {
    const err = new Error('Rate limit exceeded');
    err.name = 'OpcountExceededError';
    mockHandler.limitRate.mockRejectedValue(err);

    const blocked = await applyRateLimit(mockHandler, {
      op: 'ai_chat',
      periodSecs: 60,
      maxOps: 5,
      errorMessage: '太频繁了',
    });

    expect(blocked).toBe(true);
    expect(mockHandler.response.status).toBe(429);
    expect(mockHandler.response.body).toEqual({
      error: '太频繁了',
      code: 'RATE_LIMIT_EXCEEDED',
    });
    expect(mockHandler.response.type).toBe('application/json');
  });

  it('should detect OpcountExceededError by constructor name', async () => {
    class OpcountExceededError extends Error {
      constructor() { super('exceeded'); }
    }
    mockHandler.limitRate.mockRejectedValue(new OpcountExceededError());

    const blocked = await applyRateLimit(mockHandler, {
      op: 'test_op',
      periodSecs: 60,
      maxOps: 3,
    });

    expect(blocked).toBe(true);
    expect(mockHandler.response.status).toBe(429);
  });

  it('should detect rate limit by status 429', async () => {
    const err: any = new Error('Too many requests');
    err.status = 429;
    mockHandler.limitRate.mockRejectedValue(err);

    const blocked = await applyRateLimit(mockHandler, {
      op: 'test_op',
      periodSecs: 60,
      maxOps: 3,
    });

    expect(blocked).toBe(true);
    expect(mockHandler.response.status).toBe(429);
  });

  it('should re-throw DB errors when failOpen=false (default)', async () => {
    const dbError = new Error('MongoDB connection lost');
    mockHandler.limitRate.mockRejectedValue(dbError);

    await expect(
      applyRateLimit(mockHandler, {
        op: 'ai_chat',
        periodSecs: 60,
        maxOps: 5,
      })
    ).rejects.toThrow('MongoDB connection lost');
  });

  it('should allow request on DB error when failOpen=true', async () => {
    const dbError = new Error('MongoDB connection lost');
    mockHandler.limitRate.mockRejectedValue(dbError);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const blocked = await applyRateLimit(mockHandler, {
      op: 'ai_problem_status',
      periodSecs: 60,
      maxOps: 30,
      failOpen: true,
    });

    expect(blocked).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should use default error message when none provided', async () => {
    const err = new Error('exceeded');
    err.name = 'OpcountExceededError';
    mockHandler.limitRate.mockRejectedValue(err);

    await applyRateLimit(mockHandler, {
      op: 'ai_chat',
      periodSecs: 60,
      maxOps: 5,
    });

    expect(mockHandler.response.body.error).toBe('请求太频繁，请稍后再试');
  });

  describe('ChatHandler dual-window scenario', () => {
    it('should check both main and burst limits', async () => {
      mockHandler.limitRate.mockResolvedValue(undefined);

      // Main limit
      const blocked1 = await applyRateLimit(mockHandler, {
        op: 'ai_chat', periodSecs: 60, maxOps: 5,
      });
      expect(blocked1).toBe(false);

      // Burst limit
      const blocked2 = await applyRateLimit(mockHandler, {
        op: 'ai_chat_burst', periodSecs: 10, maxOps: 2,
      });
      expect(blocked2).toBe(false);

      expect(mockHandler.limitRate).toHaveBeenCalledTimes(2);
      expect(mockHandler.limitRate).toHaveBeenCalledWith('ai_chat', 60, 5);
      expect(mockHandler.limitRate).toHaveBeenCalledWith('ai_chat_burst', 10, 2);
    });

    it('should block on burst limit even if main limit passes', async () => {
      const opcountErr = new Error('exceeded');
      opcountErr.name = 'OpcountExceededError';

      // Main passes
      mockHandler.limitRate
        .mockResolvedValueOnce(undefined)
        // Burst fails
        .mockRejectedValueOnce(opcountErr);

      const blocked1 = await applyRateLimit(mockHandler, {
        op: 'ai_chat', periodSecs: 60, maxOps: 5,
      });
      expect(blocked1).toBe(false);

      const blocked2 = await applyRateLimit(mockHandler, {
        op: 'ai_chat_burst', periodSecs: 10, maxOps: 2,
      });
      expect(blocked2).toBe(true);
      expect(mockHandler.response.status).toBe(429);
    });
  });
});
