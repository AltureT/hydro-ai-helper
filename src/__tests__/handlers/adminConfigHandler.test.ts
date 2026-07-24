jest.mock('../../lib/crypto', () => ({
  decrypt: jest.fn((value: string) => value),
  encrypt: jest.fn((value: string) => value),
  maskApiKey: jest.fn(() => '***'),
}));
jest.mock('../../lib/rateLimitHelper', () => ({
  applyRateLimit: jest.fn().mockResolvedValue(false),
}));

import { ObjectId } from 'mongodb';
import { applyRateLimit } from '../../lib/rateLimitHelper';
import {
  AdminConfigHandler,
  JailbreakLogBulkReviewHandler,
  JailbreakLogFilterOptionsHandler,
  JailbreakLogReviewHandler,
  JailbreakLogsExportHandler,
  JailbreakLogsHandler,
  serializeSafetyLogsCsv,
} from '../../handlers/adminConfigHandler';

describe('AdminConfigHandler', () => {
  it('returns configuration metadata without eagerly querying safety logs', async () => {
    const handler = new AdminConfigHandler();
    const getConfig = jest.fn().mockResolvedValue(null);
    const getInstall = jest.fn().mockResolvedValue(null);
    const getModel = jest.fn((name: string) => {
      if (name === 'aiConfigModel') return { getConfig };
      if (name === 'pluginInstallModel') return { getInstall };
      throw new Error(`Unexpected model lookup: ${name}`);
    });
    handler.request = { headers: { accept: 'application/json' }, query: {} };
    handler.response = {};
    handler.translate = jest.fn((key: string) => key);
    handler.ctx = { Route: jest.fn(), get: getModel };

    await handler.get();

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(getModel).not.toHaveBeenCalledWith('jailbreakLogModel');
    expect(handler.response.body).toEqual(expect.objectContaining({
      config: null,
      builtinJailbreakPatterns: expect.any(Array),
    }));
    expect(handler.response.body).not.toHaveProperty('jailbreakLogs');
    expect(handler.response.body).not.toHaveProperty('recentJailbreakLogs');
  });

  it('updates custom rules without eagerly querying safety logs', async () => {
    const handler = new AdminConfigHandler();
    const updatedConfig = {
      endpoints: [],
      selectedModels: [],
      scenarioModels: {},
      apiBaseUrl: '',
      modelName: '',
      rateLimitPerMinute: 5,
      timeoutSeconds: 30,
      systemPromptTemplate: '',
      extraJailbreakPatternsText: 'custom-rule',
      budgetConfig: {},
      updatedAt: new Date('2026-07-23T00:00:00.000Z'),
    };
    const getConfig = jest.fn().mockResolvedValue(updatedConfig);
    const updateConfig = jest.fn().mockResolvedValue(undefined);
    const getModel = jest.fn((name: string) => {
      if (name === 'aiConfigModel') return { getConfig, updateConfig };
      throw new Error(`Unexpected model lookup: ${name}`);
    });
    handler.request = {
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      body: { extraJailbreakPatternsText: 'custom-rule' },
    };
    handler.response = {};
    handler.translate = jest.fn((key: string) => key);
    handler.ctx = { Route: jest.fn(), get: getModel };

    await handler.put();

    expect(updateConfig).toHaveBeenCalledWith({ extraJailbreakPatternsText: 'custom-rule' });
    expect(getModel).not.toHaveBeenCalledWith('jailbreakLogModel');
    expect(handler.response.body.config.extraJailbreakPatternsText).toBe('custom-rule');
    expect(handler.response.body).not.toHaveProperty('jailbreakLogs');
  });
});

function createLogsHandler(query: Record<string, string> = {}) {
  const handler = new JailbreakLogsHandler();
  const listWithPagination = jest.fn().mockResolvedValue({
    logs: [], total: 0, page: 1, totalPages: 0,
  });
  const getReviewSummary = jest.fn().mockResolvedValue({
    total: 10, pending: 4, confirmed: 4, falsePositive: 2, reviewed: 6, falsePositiveRate: 33.3,
  });
  const getRuleMetrics = jest.fn().mockResolvedValue([]);
  const getOperationalMetrics = jest.fn().mockResolvedValue({
    windowDays: 14,
    total: 10,
    cooldown: 2,
    appealed: 1,
    pendingAppeals: 1,
    reviewed: 6,
    averageReviewMinutes: 3,
    averageAppealReviewMinutes: 2,
    dailyTrend: [],
  });
  handler.args = { domainId: 'domain-a' };
  handler.request = { headers: {}, query };
  handler.response = {};
  handler.translate = jest.fn((key: string) => key);
  handler.ctx = {
    Route: jest.fn(),
    get: jest.fn(() => ({ listWithPagination, getReviewSummary, getRuleMetrics, getOperationalMetrics })),
  };
  return { handler, listWithPagination, getReviewSummary, getRuleMetrics, getOperationalMetrics };
}

function createReviewHandler() {
  const handler = new JailbreakLogReviewHandler();
  const review = jest.fn().mockResolvedValue(true);
  handler.user = { _id: 7 };
  handler.args = { domainId: 'domain-a' };
  handler.request = {
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    body: { reviewStatus: 'false_positive' },
  };
  handler.response = {};
  handler.translate = jest.fn((key: string) => key);
  handler.ctx = {
    Route: jest.fn(),
    get: jest.fn((name: string) => name === 'jailbreakLogModel' ? { review } : undefined),
  };
  return { handler, review };
}

describe('JailbreakLogReviewHandler', () => {
  it('reviews a log within the active domain', async () => {
    const { handler, review } = createReviewHandler();
    const id = new ObjectId().toHexString();

    await handler.post({ id });

    expect(review).toHaveBeenCalledWith(id, 'domain-a', 'false_positive', 7);
    expect(handler.response.body).toEqual({ success: true, reviewStatus: 'false_positive' });
  });

  it('rejects requests without the CSRF header', async () => {
    const { handler, review } = createReviewHandler();
    handler.request.headers = {};

    await handler.post({ id: new ObjectId().toHexString() });

    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CSRF_REJECTED');
    expect(review).not.toHaveBeenCalled();
  });

  it('rejects unsupported review states', async () => {
    const { handler, review } = createReviewHandler();
    handler.request.body = { reviewStatus: 'pending' };

    await handler.post({ id: new ObjectId().toHexString() });

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_REVIEW_STATUS');
    expect(review).not.toHaveBeenCalled();
  });

  it('does not expose logs from another domain', async () => {
    const { handler, review } = createReviewHandler();
    review.mockResolvedValue(false);

    await handler.post({ id: new ObjectId().toHexString() });

    expect(handler.response.status).toBe(404);
    expect(handler.response.body.code).toBe('JAILBREAK_LOG_NOT_FOUND');
  });
});

describe('JailbreakLogsHandler', () => {
  it('applies validated domain-scoped filters and returns review summary', async () => {
    const { handler, listWithPagination, getReviewSummary, getRuleMetrics, getOperationalMetrics } = createLogsHandler({
      page: '2',
      limit: '10',
      reviewStatus: 'pending',
      category: 'prompt_injection',
    });

    await handler.get();

    expect(listWithPagination).toHaveBeenCalledWith(2, 10, 'domain-a', {
      reviewStatus: 'pending',
      category: 'prompt_injection',
    });
    expect(getReviewSummary).toHaveBeenCalledWith('domain-a');
    expect(getRuleMetrics).toHaveBeenCalledWith('domain-a', 10);
    expect(getOperationalMetrics).toHaveBeenCalledWith('domain-a', 14);
    expect(handler.response.body.summary).toEqual(expect.objectContaining({ falsePositiveRate: 33.3 }));
    expect(handler.response.body.operationalMetrics).toEqual(expect.objectContaining({ windowDays: 14 }));
  });

  it('parses exact identity, action, source and UTC date filters', async () => {
    const { handler, listWithPagination } = createLogsHandler({
      userId: '42',
      problemId: 'P1001',
      actionTaken: 'cooldown_5m',
      detectionSource: 'conversation',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-23',
    });

    await handler.get();

    expect(listWithPagination).toHaveBeenCalledWith(1, 20, 'domain-a', {
      userId: 42,
      problemId: 'P1001',
      actionTaken: 'cooldown_5m',
      detectionSource: 'conversation',
      createdFrom: new Date('2026-07-01T00:00:00.000Z'),
      createdTo: new Date('2026-07-23T23:59:59.999Z'),
    });
  });

  it('rejects unsupported filters before querying the database', async () => {
    const { handler, listWithPagination, getReviewSummary, getRuleMetrics } = createLogsHandler({
      reviewStatus: 'deleted',
    });

    await handler.get();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_JAILBREAK_LOG_FILTER');
    expect(listWithPagination).not.toHaveBeenCalled();
    expect(getReviewSummary).not.toHaveBeenCalled();
    expect(getRuleMetrics).not.toHaveBeenCalled();
  });

  it('rejects impossible or reversed UTC date ranges', async () => {
    const invalid = createLogsHandler({ dateFrom: '2026-02-30' });
    await invalid.handler.get();
    expect(invalid.handler.response.status).toBe(400);
    expect(invalid.listWithPagination).not.toHaveBeenCalled();

    const reversed = createLogsHandler({ dateFrom: '2026-07-23', dateTo: '2026-07-01' });
    await reversed.handler.get();
    expect(reversed.handler.response.status).toBe(400);
    expect(reversed.listWithPagination).not.toHaveBeenCalled();
  });
});

describe('JailbreakLogFilterOptionsHandler', () => {
  function createFilterOptionsHandler(query: Record<string, string>) {
    const handler = new JailbreakLogFilterOptionsHandler();
    const suggestUserIds = jest.fn().mockResolvedValue([42, 142]);
    const suggestProblemIds = jest.fn().mockResolvedValue(['P1001']);
    const userFind = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { _id: 42, uname: 'alice' },
        { _id: 142, uname: 'bob' },
      ]),
    });
    const problemFind = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { docId: 1001, title: 'A + B Problem' },
      ]),
    });
    handler.args = { domainId: 'domain-a' };
    handler.request = { headers: {}, query };
    handler.response = {};
    handler.translate = jest.fn((key: string) => key);
    handler.ctx = {
      Route: jest.fn(),
      get: jest.fn(() => ({ suggestUserIds, suggestProblemIds })),
      db: {
        collection: jest.fn((name: string) => ({
          find: name === 'user' ? userFind : problemFind,
        })),
      },
    };
    return {
      handler,
      suggestUserIds,
      suggestProblemIds,
      userFind,
      problemFind,
    };
  }

  it('returns named student candidates from logs in the active domain', async () => {
    const { handler, suggestUserIds, userFind } = createFilterOptionsHandler({
      kind: 'user',
      q: '42',
    });

    await handler.get();

    expect(suggestUserIds).toHaveBeenCalledWith('domain-a', '42', 10);
    expect(userFind).toHaveBeenCalledWith(
      { _id: { $in: [42, 142] } },
      { projection: { _id: 1, uname: 1 } }
    );
    expect(handler.response.body).toEqual({
      kind: 'user',
      options: [
        { value: '42', label: 'alice' },
        { value: '142', label: 'bob' },
      ],
    });
  });

  it('returns titled problem candidates without crossing domains', async () => {
    const { handler, suggestProblemIds, problemFind } = createFilterOptionsHandler({
      kind: 'problem',
      q: '100',
      limit: '50',
    });

    await handler.get();

    expect(suggestProblemIds).toHaveBeenCalledWith('domain-a', '100', 20);
    expect(problemFind).toHaveBeenCalledWith(
      { domainId: 'domain-a', docType: 10, docId: { $in: [1001] } },
      { projection: { docId: 1, title: 1 } }
    );
    expect(handler.response.body.options).toEqual([
      { value: 'P1001', label: 'A + B Problem' },
    ]);
  });

  it('rejects empty or unsupported suggestion queries before database access', async () => {
    const { handler, suggestUserIds, suggestProblemIds } = createFilterOptionsHandler({
      kind: 'class',
      q: '',
    });

    await handler.get();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_JAILBREAK_FILTER_SUGGESTION');
    expect(suggestUserIds).not.toHaveBeenCalled();
    expect(suggestProblemIds).not.toHaveBeenCalled();
  });

  it('rejects non-numeric student prefixes before database access', async () => {
    const { handler, suggestUserIds } = createFilterOptionsHandler({
      kind: 'user',
      q: 'student',
    });

    await handler.get();

    expect(handler.response.status).toBe(400);
    expect(suggestUserIds).not.toHaveBeenCalled();
  });

  it('fails closed when the suggestion rate limiter is unavailable or exceeded', async () => {
    (applyRateLimit as jest.Mock).mockResolvedValueOnce(true);
    const { handler, suggestUserIds } = createFilterOptionsHandler({
      kind: 'user',
      q: '42',
    });

    await handler.get();

    expect(applyRateLimit).toHaveBeenCalledWith(handler, expect.objectContaining({
      op: 'ai_safety_filter_suggestions',
      failOpen: false,
    }));
    expect(suggestUserIds).not.toHaveBeenCalled();
  });
});

describe('JailbreakLogsExportHandler', () => {
  it('exports at most 5000 domain-scoped filtered rows', async () => {
    const handler = new JailbreakLogsExportHandler();
    const log = {
      _id: new ObjectId(),
      matchedPattern: 'answer',
      matchedText: 'matched',
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    };
    const listForExport = jest.fn().mockResolvedValue({
      logs: [log], total: 6001, truncated: true,
    });
    handler.args = { domainId: 'domain-a' };
    handler.request = { headers: {}, query: { userId: '42' } };
    handler.response = { addHeader: jest.fn() };
    handler.translate = jest.fn((key: string) => key);
    handler.ctx = { Route: jest.fn(), get: jest.fn(() => ({ listForExport })) };

    await handler.get();

    expect(listForExport).toHaveBeenCalledWith('domain-a', { userId: 42 }, 5000);
    expect(handler.response.type).toBe('text/csv; charset=utf-8');
    expect(handler.response.body).toContain('"eventId"');
    expect(handler.response.body).toContain('"metadata","1","6001","true"');
    expect(handler.response.addHeader).toHaveBeenCalledWith('X-AI-Helper-Export-Total', '6001');
    expect(handler.response.addHeader).toHaveBeenCalledWith('X-AI-Helper-Export-Truncated', 'true');
    expect(handler.response.addHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('ai-safety-events-')
    );
  });

  it('neutralizes spreadsheet formulas in exported cells', () => {
    const csv = serializeSafetyLogsCsv([{
      _id: new ObjectId(),
      matchedPattern: '=HYPERLINK("bad")',
      matchedText: ' +SUM(1,1)',
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    }]);

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain(' +SUM(1,1)');
  });

  it('never exports stored matched text, including legacy unsanitized values', () => {
    const csv = serializeSafetyLogsCsv([{
      _id: new ObjectId(),
      matchedPattern: 'safe-pattern',
      matchedText: 'legacy student secret test@example.com sk-abcdefghijklmnop',
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    }]);

    expect(csv).not.toContain('legacy student secret');
    expect(csv).not.toContain('test@example.com');
    expect(csv).not.toContain('sk-abcdefghijklmnop');
    expect(csv).not.toContain('matchedText');
  });

  it('stops before querying when the export rate limit is exceeded', async () => {
    const handler = new JailbreakLogsExportHandler();
    const listForExport = jest.fn();
    (applyRateLimit as jest.Mock).mockResolvedValueOnce(true);
    handler.args = { domainId: 'domain-a' };
    handler.request = { headers: {}, query: {} };
    handler.response = { addHeader: jest.fn() };
    handler.translate = jest.fn((key: string) => key);
    handler.ctx = { Route: jest.fn(), get: jest.fn(() => ({ listForExport })) };

    await handler.get();

    expect(applyRateLimit).toHaveBeenCalledWith(handler, expect.objectContaining({
      op: 'ai_safety_log_export', maxOps: 3, periodSecs: 60,
    }));
    expect(listForExport).not.toHaveBeenCalled();
  });
});

function createBulkReviewHandler() {
  const handler = new JailbreakLogBulkReviewHandler();
  const reviewMany = jest.fn().mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });
  handler.user = { _id: 7 };
  handler.args = { domainId: 'domain-a' };
  handler.request = {
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    body: {
      ids: [new ObjectId().toHexString(), new ObjectId().toHexString()],
      reviewStatus: 'confirmed',
    },
  };
  handler.response = {};
  handler.translate = jest.fn((key: string) => key);
  handler.ctx = {
    Route: jest.fn(),
    get: jest.fn(() => ({ reviewMany })),
  };
  return { handler, reviewMany };
}

describe('JailbreakLogBulkReviewHandler', () => {
  it('bulk reviews unique IDs within the active domain', async () => {
    const { handler, reviewMany } = createBulkReviewHandler();
    const firstId = handler.request.body.ids[0];
    handler.request.body.ids.push(firstId);

    await handler.post();

    expect(reviewMany).toHaveBeenCalledWith(
      expect.arrayContaining(handler.request.body.ids.slice(0, 2)),
      'domain-a',
      'confirmed',
      7
    );
    expect(reviewMany.mock.calls[0][0]).toHaveLength(2);
    expect(handler.response.body).toEqual(expect.objectContaining({ success: true, modifiedCount: 2 }));
  });

  it('rejects invalid or oversized ID batches', async () => {
    const { handler, reviewMany } = createBulkReviewHandler();
    handler.request.body.ids = ['invalid-id'];

    await handler.post();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_JAILBREAK_LOG_IDS');
    expect(reviewMany).not.toHaveBeenCalled();
  });

  it('requires the CSRF header', async () => {
    const { handler, reviewMany } = createBulkReviewHandler();
    handler.request.headers = {};

    await handler.post();

    expect(handler.response.status).toBe(403);
    expect(reviewMany).not.toHaveBeenCalled();
  });
});
