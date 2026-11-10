import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { QuotaUsageModel } from '../../models/quotaUsage';
import { QuotaService, type QuotaPolicySources } from '../../services/quotaService';

// 2026-11-10 23:30 北京时间
const NOW = new Date('2026-11-10T15:30:00Z');

function setup(quotaConfig: Record<string, unknown> | undefined, sources: QuotaPolicySources = {}) {
  const collection = createFakeCollection();
  const usage = new QuotaUsageModel(createFakeDb({ ai_quota_usage: collection }) as any);
  const config = { timeoutSeconds: 30, ...(quotaConfig ? { quotaConfig } : {}) };
  const configModel = { getConfig: jest.fn().mockResolvedValue(config) };
  let now = NOW;
  const service = new QuotaService(usage, configModel, sources, () => now);
  return { service, collection, configModel, setNow: (d: Date) => { now = d; } };
}

describe('QuotaService', () => {
  it('does not reserve when the daily default is unlimited, but still counts usage', async () => {
    const { service, collection } = setup({ dailyMessageLimit: 0 });
    const result = await service.reserve(1031);
    expect(result.ok).toBe(true);
    if (!('reservation' in result)) throw new Error('expected reservation');
    expect(result.reservation.id).toBeNull();
    expect(collection.updateOne).not.toHaveBeenCalled();

    const snapshot = await service.confirm(result.reservation);
    expect(snapshot).toEqual({ limit: null, used: 1, remaining: null, resetAt: '2026-11-10T16:00:00.000Z' });
  });

  it('treats a missing quota section (pre-v4 document) as unlimited', async () => {
    const { service } = setup(undefined);
    const status = await service.status(1031);
    expect(status).toEqual(expect.objectContaining({ limit: null, remaining: null, disabled: false, timezone: 'Asia/Shanghai' }));
  });

  it('reserves, confirms and reports the remaining count across domains', async () => {
    const { service } = setup({ dailyMessageLimit: 2 });
    const first = await service.reserve(1031);
    if (!('reservation' in first)) throw new Error('expected reservation');
    await expect(service.confirm(first.reservation)).resolves.toEqual({
      limit: 2, used: 1, remaining: 1, resetAt: '2026-11-10T16:00:00.000Z',
    });

    // 同一用户在另一个域：额度按用户计，不区分域
    const second = await service.reserve(1031);
    if (!('reservation' in second)) throw new Error('expected reservation');
    await service.confirm(second.reservation);

    const third = await service.reserve(1031);
    expect(third).toEqual({ ok: false, code: 'QUOTA_EXHAUSTED', limit: 2, used: 2, resetAt: new Date('2026-11-10T16:00:00Z') });
    await expect(service.status(1031)).resolves.toEqual(expect.objectContaining({ limit: 2, used: 2, remaining: 0 }));
  });

  it('releases unconfirmed reservations and makes confirm/release idempotent', async () => {
    const { service } = setup({ dailyMessageLimit: 1 });
    const first = await service.reserve(1031);
    if (!('reservation' in first)) throw new Error('expected reservation');
    await service.release(first.reservation);
    await service.release(first.reservation);
    await expect(service.confirm(first.reservation)).resolves.toBeNull();

    const again = await service.reserve(1031);
    expect(again.ok).toBe(true);
  });

  it('resets on the next local day in the configured timezone', async () => {
    const { service, setNow } = setup({ dailyMessageLimit: 1, timezone: 'Asia/Shanghai' });
    const first = await service.reserve(1031);
    if (!('reservation' in first)) throw new Error('expected reservation');
    await service.confirm(first.reservation);
    expect((await service.reserve(1031)).ok).toBe(false);

    setNow(new Date('2026-11-10T16:00:01Z')); // 北京时间 11-11 00:00:01
    expect((await service.reserve(1031)).ok).toBe(true);
  });

  it('distinguishes admin-disabled from exhausted', async () => {
    const disabled = setup({ dailyMessageLimit: 20 }, { getGroupLimits: async () => ({ grants: [], caps: [0] }) });
    await expect(disabled.service.reserve(1031)).resolves.toEqual({ ok: false, code: 'AI_DISABLED_BY_ADMIN' });
    await expect(disabled.service.status(1031)).resolves.toEqual(expect.objectContaining({ disabled: true, limit: 0, remaining: 0 }));

    const lowCredit = setup({ dailyMessageLimit: 3, guaranteeCount: 0 }, { getCreditMultiplier: async () => 0.2 });
    const result = await lowCredit.service.reserve(1031);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'QUOTA_EXHAUSTED', limit: 0 }));
  });

  it('combines overrides, groups and credit through the policy sources', async () => {
    const { service } = setup({ dailyMessageLimit: 20, guaranteeCount: 3 }, {
      getOverride: async () => null,
      getGroupLimits: async () => ({ grants: [60], caps: [] }),
      getCreditMultiplier: async () => 0.5,
    });
    await expect(service.resolve(1031)).resolves.toEqual(expect.objectContaining({ limit: 30, base: 60, source: 'grant', m: 0.5 }));
  });

  it('uses a reservation TTL of at least 10 minutes or twice the AI timeout', async () => {
    const { service, collection, configModel } = setup({ dailyMessageLimit: 5 });
    configModel.getConfig.mockResolvedValue({ timeoutSeconds: 600, quotaConfig: { dailyMessageLimit: 5 } });
    await service.reserve(1031);
    const pull = collection.updateOne.mock.calls.find((call) => call[1].$pull);
    expect(pull?.[1].$pull.reservations.at.$lt).toEqual(new Date(NOW.getTime() - 1200 * 1000));
  });

  it('reuses a config that was already loaded', async () => {
    const { service, configModel } = setup({ dailyMessageLimit: 5 });
    await service.reserve(1031, { timeoutSeconds: 30, quotaConfig: { dailyMessageLimit: 5 } } as any);
    expect(configModel.getConfig).not.toHaveBeenCalled();
  });
});
