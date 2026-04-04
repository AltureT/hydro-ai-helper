/**
 * Integration tests for ChatHandler and ProblemStatusHandler
 *
 * Uses mocked dependencies to test the handler's request processing flow
 * without hitting real databases or AI services.
 */

import { ObjectId } from 'mongodb';

// Must mock modules BEFORE importing the handler
jest.mock('../../lib/rateLimitHelper', () => ({
  applyRateLimit: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../services/openaiClient', () => {
  const chatMock = jest.fn().mockResolvedValue({
    content: 'AI response',
    usedModel: { endpointId: 'ep-1', endpointName: 'Test', modelName: 'gpt-4o' },
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  });
  return {
    createMultiModelClientFromConfig: jest.fn().mockResolvedValue({
      chat: chatMock,
      chatStream: jest.fn(),
    }),
    MultiModelClient: jest.fn(),
    AIServiceError: class AIServiceError extends Error {
      category: string;
      isRetryable: boolean;
      constructor(message: string, category: string, isRetryable: boolean) {
        super(message);
        this.category = category;
        this.isRetryable = isRetryable;
      }
    },
    USER_ERROR_MESSAGES: { unknown: 'AI 服务异常，请稍后再试' },
    getHttpStatusForCategory: jest.fn().mockReturnValue(500),
  };
});

jest.mock('../../services/effectivenessService', () => ({
  EffectivenessService: jest.fn().mockImplementation(() => ({
    analyzeConversation: jest.fn().mockResolvedValue(undefined),
    logJailbreakAttempt: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../services/outputSafetyService', () => ({
  OutputSafetyService: jest.fn().mockImplementation(() => ({
    sanitize: jest.fn().mockReturnValue({ content: 'AI response', rewritten: false }),
  })),
}));

jest.mock('../../services/topicGuardService', () => ({
  TopicGuardService: jest.fn().mockImplementation(() => ({
    evaluate: jest.fn().mockReturnValue({ isOffTopic: false }),
  })),
}));

jest.mock('../../services/budgetService', () => ({
  BudgetService: jest.fn().mockImplementation(() => ({
    checkBudget: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));

jest.mock('../../services/judgeInfoService', () => ({
  formatJudgeInfo: jest.fn().mockReturnValue(undefined),
}));

jest.mock('../../lib/sseHelper', () => ({
  createSSEWriter: jest.fn(),
}));

import { ChatHandler, ProblemStatusHandler } from '../../handlers/studentHandler';
import { ProblemModel, STATUS, ContestModel, db } from 'hydrooj';
import { applyRateLimit } from '../../lib/rateLimitHelper';
import { createMultiModelClientFromConfig } from '../../services/openaiClient';
import { TopicGuardService } from '../../services/topicGuardService';
import { BudgetService } from '../../services/budgetService';

const VALID_OID = new ObjectId().toHexString();

function createMockHandler(): ChatHandler {
  const handler = new ChatHandler();
  handler.user = { _id: 42 };
  handler.args = { domainId: 'test-domain' };
  handler.request = {
    body: {
      problemId: 'P1001',
      questionType: 'understand',
      userThinking: '这道题要求什么？',
      includeCode: false,
    },
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  };
  handler.response = { body: undefined, status: undefined, type: undefined };
  handler.translate = jest.fn((...args: any[]) => {
    let str = args[0] || '';
    for (let i = 1; i < args.length; i++) str = str.replace(`{${i - 1}}`, String(args[i]));
    return str;
  });
  handler.limitRate = jest.fn();

  const conversationOid = new ObjectId();
  const messageOid = new ObjectId();

  const mockConversationModel = {
    findById: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(conversationOid),
    incrementMessageCount: jest.fn().mockResolvedValue(undefined),
    updateEndTime: jest.fn().mockResolvedValue(undefined),
    incrementOffTopicStrike: jest.fn().mockResolvedValue(1),
    resetOffTopicStrike: jest.fn().mockResolvedValue(undefined),
  };

  const mockMessageModel = {
    create: jest.fn().mockResolvedValue(messageOid),
    findById: jest.fn().mockResolvedValue(null),
    findRecentByConversationId: jest.fn().mockResolvedValue([]),
  };

  const mockAiConfigModel = {
    getConfig: jest.fn().mockResolvedValue({
      _id: 'default',
      configVersion: 2,
      endpoints: [{ id: 'ep-1', name: 'Test', apiBaseUrl: 'https://api.test.com', apiKeyEncrypted: 'k', models: ['gpt-4o'], enabled: true }],
      selectedModels: [{ endpointId: 'ep-1', modelName: 'gpt-4o' }],
      rateLimitPerMinute: 5,
      timeoutSeconds: 30,
      updatedAt: new Date(),
    }),
  };

  const mockTokenUsageModel = {
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };

  handler.ctx = {
    Route: jest.fn(),
    get: jest.fn((name: string) => {
      const models: Record<string, any> = {
        conversationModel: mockConversationModel,
        messageModel: mockMessageModel,
        aiConfigModel: mockAiConfigModel,
        tokenUsageModel: mockTokenUsageModel,
      };
      return models[name];
    }),
    db: {
      collection: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
        updateOne: jest.fn().mockResolvedValue(undefined),
      }),
    },
    logger: { error: jest.fn() },
  };

  // Mock ProblemModel.get
  (ProblemModel.get as jest.Mock).mockResolvedValue({
    title: 'Test Problem',
    content: 'This is a test problem',
    docId: 1001,
  });

  return handler;
}

describe('ChatHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (applyRateLimit as jest.Mock).mockResolvedValue(false);
    (ProblemModel.get as jest.Mock).mockResolvedValue({
      title: 'Test Problem',
      content: 'This is a test problem',
      docId: 1001,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return AI response for valid understand request', async () => {
    const handler = createMockHandler();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    await handler.post();

    expect(handler.response.body).toBeDefined();
    expect(handler.response.body.conversationId).toBeTruthy();
    expect(handler.response.body.message.role).toBe('ai');
    expect(handler.response.body.message.content).toBe('AI response');
    expect(handler.response.type).toBe('application/json');
  });

  it('should block during ongoing contest', async () => {
    const handler = createMockHandler();
    const contestId = new ObjectId().toHexString();
    handler.request.body.contestId = contestId;
    (ContestModel.get as jest.Mock).mockResolvedValue({ rule: 'acm', _id: contestId });
    (ContestModel.isOngoing as jest.Mock).mockReturnValue(true);
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CONTEST_MODE_RESTRICTED');
  });

  it('should allow homework contest', async () => {
    const handler = createMockHandler();
    const contestId = new ObjectId().toHexString();
    handler.request.body.contestId = contestId;
    (ContestModel.get as jest.Mock).mockResolvedValue({ rule: 'homework', _id: contestId });
    (ContestModel.isOngoing as jest.Mock).mockReturnValue(true);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    await handler.post();

    // Should NOT block - homework is allowed
    expect(handler.response.status).not.toBe(403);
  });

  it('should return 429 when rate limited', async () => {
    const handler = createMockHandler();
    (applyRateLimit as jest.Mock).mockResolvedValue(true);
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    // applyRateLimit sets response internally and returns true
    // Handler should return null from prepareChat
    expect(applyRateLimit).toHaveBeenCalled();
  });

  it('should reject invalid question type', async () => {
    const handler = createMockHandler();
    handler.request.body.questionType = 'invalid_type';
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(500);
    expect(handler.response.body.error).toContain('ai_helper_err');
  });

  it('should truncate long code', async () => {
    const handler = createMockHandler();
    handler.request.body.includeCode = true;
    handler.request.body.code = 'x'.repeat(6000);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    await handler.post();

    expect(handler.response.body.codeWarning).toContain('ai_helper_err_code_truncated');
  });

  it('should handle clarify type requiring conversationId', async () => {
    const handler = createMockHandler();
    handler.request.body.questionType = 'clarify';
    handler.request.body.clarifyContext = {
      sourceAiMessageId: VALID_OID,
      selectedText: 'some text',
    };
    // No conversationId
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('CLARIFY_ANCHOR_INVALID');
  });

  it('should require sourceAiMessageId and selectedText for clarify', async () => {
    const handler = createMockHandler();
    handler.request.body.questionType = 'clarify';
    handler.request.body.conversationId = VALID_OID;
    handler.request.body.clarifyContext = {
      sourceAiMessageId: '',
      selectedText: '',
    };
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('CLARIFY_ANCHOR_INVALID');
  });

  it('should reject optimize when user has not AC the problem', async () => {
    const handler = createMockHandler();
    handler.request.body.questionType = 'optimize';
    handler.request.body.includeCode = true;
    handler.request.body.code = 'print("hello")';
    // db.collection('record').findOne returns null (no AC record)
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('OPTIMIZE_REQUIRES_AC');
  });

  it('should allow optimize when user has AC the problem', async () => {
    const handler = createMockHandler();
    handler.request.body.questionType = 'optimize';
    handler.request.body.includeCode = true;
    handler.request.body.code = 'print("hello")';

    // db.collection('record').findOne returns an AC record
    (db.collection as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockResolvedValue({ _id: new ObjectId() }),
    });
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    await handler.post();

    expect(handler.response.status).not.toBe(403);
    expect(handler.response.body?.message?.role).toBe('ai');
  });

  it('should reject invalid conversationId format', async () => {
    const handler = createMockHandler();
    handler.request.body.conversationId = 'not-a-valid-oid';
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_CONVERSATION_ID');
  });

  it('should reject when conversation belongs to different user', async () => {
    const handler = createMockHandler();
    const convId = new ObjectId().toHexString();
    handler.request.body.conversationId = convId;

    const mockConversationModel = handler.ctx.get('conversationModel');
    mockConversationModel.findById.mockResolvedValue({
      _id: new ObjectId(convId),
      userId: 999, // different user
      domainId: 'test-domain',
    });
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it('should reject when conversation belongs to different domain', async () => {
    const handler = createMockHandler();
    const convId = new ObjectId().toHexString();
    handler.request.body.conversationId = convId;

    const mockConversationModel = handler.ctx.get('conversationModel');
    mockConversationModel.findById.mockResolvedValue({
      _id: new ObjectId(convId),
      userId: 42, // same user
      domainId: 'other-domain', // different domain
    });
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CONVERSATION_ACCESS_DENIED');
  });

  it('should return 404 when reusing non-existent conversation', async () => {
    const handler = createMockHandler();
    handler.request.body.conversationId = VALID_OID;

    const mockConversationModel = handler.ctx.get('conversationModel');
    mockConversationModel.findById.mockResolvedValue(null);
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(404);
    expect(handler.response.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('should bypass LLM and return fixed reply on repeated off-topic', async () => {
    const handler = createMockHandler();
    jest.spyOn(console, 'log').mockImplementation();

    // Make TopicGuardService detect off-topic
    (TopicGuardService as jest.Mock).mockImplementation(() => ({
      evaluate: jest.fn().mockReturnValue({ isOffTopic: true }),
    }));

    // incrementOffTopicStrike returns 2 (consecutive off-topic >= 2)
    const mockConversationModel = handler.ctx.get('conversationModel');
    mockConversationModel.incrementOffTopicStrike.mockResolvedValue(2);

    await handler.post();

    expect(handler.response.body.message.content).toContain('ai_helper_err_off_topic_reply');
    // Should NOT call AI service
    expect(createMultiModelClientFromConfig).not.toHaveBeenCalled();
  });

  it('should return 429 when budget exceeded', async () => {
    const handler = createMockHandler();
    jest.spyOn(console, 'log').mockImplementation();

    // Mock budget check to reject
    const mockAiConfig = handler.ctx.get('aiConfigModel');
    mockAiConfig.getConfig.mockResolvedValue({
      _id: 'default',
      configVersion: 2,
      endpoints: [],
      selectedModels: [],
      rateLimitPerMinute: 5,
      timeoutSeconds: 30,
      budgetConfig: { dailyTokenLimitPerUser: 1000 },
      updatedAt: new Date(),
    });

    (BudgetService as jest.Mock).mockImplementation(() => ({
      checkBudget: jest.fn().mockResolvedValue({ allowed: false, reasonKey: 'ai_helper_budget_user_daily_exceeded', reasonParams: ['1000', '1000'] }),
    }));

    await handler.post();

    expect(handler.response.status).toBe(429);
    expect(handler.response.body.code).toBe('BUDGET_EXCEEDED');
  });

  it('should include budget warning when near limit', async () => {
    const handler = createMockHandler();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    const mockAiConfig = handler.ctx.get('aiConfigModel');
    mockAiConfig.getConfig.mockResolvedValue({
      _id: 'default',
      configVersion: 2,
      endpoints: [{ id: 'ep-1', name: 'Test', apiBaseUrl: 'https://api.test.com', apiKeyEncrypted: 'k', models: ['gpt-4o'], enabled: true }],
      selectedModels: [{ endpointId: 'ep-1', modelName: 'gpt-4o' }],
      rateLimitPerMinute: 5,
      timeoutSeconds: 30,
      budgetConfig: { dailyTokenLimitPerUser: 10000 },
      updatedAt: new Date(),
    });

    (BudgetService as jest.Mock).mockImplementation(() => ({
      checkBudget: jest.fn().mockResolvedValue({ allowed: true, warningKey: 'ai_helper_budget_user_daily_warning', warningParams: ['2000'] }),
    }));

    await handler.post();

    expect(handler.response.body.budgetWarning).toContain('ai_helper_budget_user_daily_warning');
  });

  it('should include tokenUsage in response', async () => {
    const handler = createMockHandler();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    await handler.post();

    expect(handler.response.body.tokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it('should return 404 when problem not found for optimize', async () => {
    const handler = createMockHandler();
    handler.request.body.questionType = 'optimize';
    handler.request.body.includeCode = true;
    handler.request.body.code = 'code';
    (ProblemModel.get as jest.Mock).mockResolvedValue(null);
    jest.spyOn(console, 'log').mockImplementation();

    await handler.post();

    expect(handler.response.status).toBe(404);
    expect(handler.response.body.error).toContain('ai_helper_err_problem_not_found');
  });
});

describe('ProblemStatusHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (applyRateLimit as jest.Mock).mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createStatusHandler(): ProblemStatusHandler {
    const handler = new ProblemStatusHandler();
    handler.user = { _id: 42 };
    handler.args = { domainId: 'test-domain' };
    handler.request = { headers: {} };
    handler.response = { body: undefined, status: undefined, type: undefined };
    handler.translate = jest.fn((key: string) => key);
    handler.limitRate = jest.fn();
    return handler;
  }

  it('should return hasAccepted=false when problem not found', async () => {
    const handler = createStatusHandler();
    (ProblemModel.get as jest.Mock).mockResolvedValue(null);
    jest.spyOn(console, 'log').mockImplementation();

    await handler.get({ problemId: 'P1001' });

    expect(handler.response.body).toEqual({ hasAccepted: false });
  });

  it('should return hasAccepted=true with code when user has AC', async () => {
    const handler = createStatusHandler();
    (ProblemModel.get as jest.Mock).mockResolvedValue({ docId: 1001 });
    (db.collection as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        status: 1,
        code: 'print("AC")',
        lang: 'python3',
      }),
    });
    jest.spyOn(console, 'log').mockImplementation();

    await handler.get({ problemId: 'P1001' });

    expect(handler.response.body.hasAccepted).toBe(true);
    expect(handler.response.body.acCode).toBe('print("AC")');
    expect(handler.response.body.acLang).toBe('python3');
  });

  it('should reject invalid problemId', async () => {
    const handler = createStatusHandler();

    await handler.get({ problemId: '' });

    expect(handler.response.status).toBe(400);
  });

  it('should reject overly long problemId', async () => {
    const handler = createStatusHandler();

    await handler.get({ problemId: 'x'.repeat(60) });

    expect(handler.response.status).toBe(400);
  });
});
