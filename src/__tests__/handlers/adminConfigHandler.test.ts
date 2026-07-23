jest.mock('../../lib/crypto', () => ({
  decrypt: jest.fn((value: string) => value),
  encrypt: jest.fn((value: string) => value),
  maskApiKey: jest.fn(() => '***'),
}));

import { ObjectId } from 'mongodb';
import { JailbreakLogReviewHandler } from '../../handlers/adminConfigHandler';

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
