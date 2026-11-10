import { PRIV } from 'hydrooj';
import { QuotaStatusHandler, QuotaStatusHandlerPriv } from '../../handlers/quotaStatusHandler';

function makeHandler(quotaService: unknown) {
  const handler = new QuotaStatusHandler();
  handler.request = { headers: {}, query: {} };
  handler.response = {};
  handler.user = { _id: 1031 };
  (handler as any).translate = (key: string) => key;
  handler.ctx = { Route: jest.fn(), get: (name: string) => (name === 'quotaService' ? quotaService : undefined) };
  return handler;
}

describe('QuotaStatusHandler', () => {
  it('requires a signed-in user', () => {
    expect(QuotaStatusHandlerPriv).toBe(PRIV.PRIV_USER_PROFILE);
  });

  it('returns the current user status', async () => {
    const status = { limit: 20, used: 8, remaining: 12, resetAt: '2026-11-10T16:00:00.000Z', disabled: false, timezone: 'Asia/Shanghai' };
    const quotaService = { status: jest.fn().mockResolvedValue(status) };
    const handler = makeHandler(quotaService);
    await handler.get();
    expect(quotaService.status).toHaveBeenCalledWith(1031);
    expect(handler.response.body).toEqual(status);
    expect(handler.response.type).toBe('application/json');
  });

  it('returns 500 with a stable code on failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = makeHandler({ status: jest.fn().mockRejectedValue(new Error('down')) });
    await handler.get();
    expect(handler.response.status).toBe(500);
    expect(handler.response.body).toEqual({ error: 'ai_helper_quota_status_failed', code: 'QUOTA_STATUS_FAILED' });
  });
});
