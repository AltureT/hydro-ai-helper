jest.mock('../../lib/crypto', () => ({
  decrypt: jest.fn((value: string) => value),
  encrypt: jest.fn((value: string) => value),
  maskApiKey: jest.fn(() => '***'),
}));

import { ObjectId } from 'mongodb';
import { JailbreakLogReviewHandler, JailbreakLogsHandler } from '../../handlers/adminConfigHandler';

function createLogsHandler(query: Record<string, string> = {}) {
  const handler = new JailbreakLogsHandler();
  const listWithPagination = jest.fn().mockResolvedValue({
    logs: [], total: 0, page: 1, totalPages: 0,
  });
  const getReviewSummary = jest.fn().mockResolvedValue({
    total: 10, pending: 4, confirmed: 4, falsePositive: 2, reviewed: 6, falsePositiveRate: 33.3,
  });
  handler.args = { domainId: 'domain-a' };
  handler.request = { headers: {}, query };
  handler.response = {};
  handler.translate = jest.fn((key: string) => key);
  handler.ctx = {
    Route: jest.fn(),
    get: jest.fn(() => ({ listWithPagination, getReviewSummary })),
  };
  return { handler, listWithPagination, getReviewSummary };
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
    const { handler, listWithPagination, getReviewSummary } = createLogsHandler({
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
    expect(handler.response.body.summary).toEqual(expect.objectContaining({ falsePositiveRate: 33.3 }));
  });

  it('rejects unsupported filters before querying the database', async () => {
    const { handler, listWithPagination, getReviewSummary } = createLogsHandler({
      reviewStatus: 'deleted',
    });

    await handler.get();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_JAILBREAK_LOG_FILTER');
    expect(listWithPagination).not.toHaveBeenCalled();
    expect(getReviewSummary).not.toHaveBeenCalled();
  });
});
