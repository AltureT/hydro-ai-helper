import { PRIV } from 'hydrooj';
import { QuotaNoticeAckHandler, QuotaStatusHandler, QuotaStatusHandlerPriv } from '../../handlers/quotaStatusHandler';

function makeHandler(quotaService: unknown, creditService?: unknown) {
  const handler = new QuotaStatusHandler();
  handler.request = { headers: {}, query: {} };
  handler.response = {};
  handler.user = { _id: 1031 };
  (handler as any).translate = (key: string) => key;
  const services: Record<string, unknown> = { quotaService, creditService };
  handler.ctx = { Route: jest.fn(), get: (name: string) => services[name] };
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
    expect(handler.response.body).toEqual({ ...status, credit: null, notices: [] });
    expect(handler.response.type).toBe('application/json');
  });

  it('adds why the quota was reduced, when it recovers and the appeal entries (FR-034)', async () => {
    const status = { limit: 19, used: 4, remaining: 15, resetAt: '2026-11-10T16:00:00.000Z', disabled: false, timezone: 'Asia/Shanghai' };
    const credit = {
      m: 0.95, reduced: true, recoveryAt: '2026-11-11T02:14:00.000Z',
      recentViolations: [{ category: 'off_topic', at: '2026-11-10T02:14:00.000Z', source: 'realtime', safetyEventId: 'abc', appealable: true, appealed: false }],
    };
    const creditService = { studentStatus: jest.fn().mockResolvedValue(credit) };
    const handler = makeHandler({ status: jest.fn().mockResolvedValue(status) }, creditService);
    await handler.get();
    expect(creditService.studentStatus).toHaveBeenCalledWith(1031);
    expect(handler.response.body).toEqual({ ...status, credit, notices: [] });
  });

  it('still returns the quota when reading credit fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status = { limit: 20, used: 0, remaining: 20, resetAt: '2026-11-10T16:00:00.000Z', disabled: false, timezone: 'Asia/Shanghai' };
    const handler = makeHandler(
      { status: jest.fn().mockResolvedValue(status) },
      { studentStatus: jest.fn().mockRejectedValue(new Error('Synthetic credit failure')) },
    );
    await handler.get();
    expect(handler.response.body).toEqual({ ...status, credit: null, notices: [] });
  });

  it('lists unacknowledged AI review penalty notices (FR-046)', async () => {
    const status = { limit: 19, used: 4, remaining: 15, resetAt: '2026-11-10T16:00:00.000Z', disabled: false, timezone: 'Asia/Shanghai' };
    const notices = [{ id: '6560f0000000000000000001', category: 'off_topic', at: '2026-11-10T02:14:00.000Z', safetyEventId: 'abc', domainId: 'oi2023' }];
    const creditService = { studentStatus: jest.fn().mockResolvedValue(null), reviewNotices: jest.fn().mockResolvedValue(notices) };
    const handler = makeHandler({ status: jest.fn().mockResolvedValue(status) }, creditService);
    await handler.get();
    expect(creditService.reviewNotices).toHaveBeenCalledWith(1031);
    expect(handler.response.body).toEqual({ ...status, credit: null, notices });
  });

  it('returns an empty notice list when reading notices fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status = { limit: 20, used: 0, remaining: 20, resetAt: '2026-11-10T16:00:00.000Z', disabled: false, timezone: 'Asia/Shanghai' };
    const handler = makeHandler(
      { status: jest.fn().mockResolvedValue(status) },
      { studentStatus: jest.fn().mockResolvedValue(null), reviewNotices: jest.fn().mockRejectedValue(new Error('Synthetic notice failure')) },
    );
    await handler.get();
    expect(handler.response.body).toEqual({ ...status, credit: null, notices: [] });
  });

  it('returns 500 with a stable code on failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = makeHandler({ status: jest.fn().mockRejectedValue(new Error('down')) });
    await handler.get();
    expect(handler.response.status).toBe(500);
    expect(handler.response.body).toEqual({ error: 'ai_helper_quota_status_failed', code: 'QUOTA_STATUS_FAILED' });
  });
});

describe('QuotaNoticeAckHandler', () => {
  function makeAck(creditService: unknown, headers: Record<string, string> = { 'x-requested-with': 'XMLHttpRequest' }) {
    const handler = new QuotaNoticeAckHandler();
    handler.request = { headers, query: {}, body: {} };
    handler.response = {};
    handler.user = { _id: 1031 };
    (handler as any).translate = (key: string) => key;
    handler.ctx = { Route: jest.fn(), get: (name: string) => (name === 'creditService' ? creditService : undefined) };
    return handler;
  }

  it('acknowledges only the current user notice', async () => {
    const creditService = { ackReviewNotice: jest.fn().mockResolvedValue(true) };
    const handler = makeAck(creditService);
    await handler.post({ id: '6560f0000000000000000001' });
    expect(creditService.ackReviewNotice).toHaveBeenCalledWith(expect.anything(), 1031);
    expect(String(creditService.ackReviewNotice.mock.calls[0][0])).toBe('6560f0000000000000000001');
    expect(handler.response.body).toEqual({ success: true });
  });

  it('returns 404 for an unknown, foreign or malformed notice', async () => {
    const creditService = { ackReviewNotice: jest.fn().mockResolvedValue(false) };
    const handler = makeAck(creditService);
    await handler.post({ id: '6560f0000000000000000002' });
    expect(handler.response.status).toBe(404);
    expect(handler.response.body).toMatchObject({ code: 'NOTICE_NOT_FOUND' });

    const malformed = makeAck(creditService);
    await malformed.post({ id: 'not-an-id' });
    expect(malformed.response.status).toBe(404);
    expect(creditService.ackReviewNotice).toHaveBeenCalledTimes(1);
  });

  it('rejects requests without the CSRF header', async () => {
    const creditService = { ackReviewNotice: jest.fn() };
    const handler = makeAck(creditService, {});
    await handler.post({ id: '6560f0000000000000000001' });
    expect(handler.response.status).toBe(403);
    expect(creditService.ackReviewNotice).not.toHaveBeenCalled();
  });
});
