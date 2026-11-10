import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { QuotaUsageModel } from '../../models/quotaUsage';
import { QuotaService, type QuotaPolicySources } from '../../services/quotaService';

// 2026-11-10 23:30 北京时间
const NOW = new Date('2026-11-10T15:30:00Z');

function group(id: string, mode: 'grant' | 'cap', dailyLimit: number, enabled = true) {
  return { id, name: id, mode, dailyLimit, enabled, via: [{ kind: 'direct' as const }] };
}

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
    const disabled = setup({ dailyMessageLimit: 20 }, { getGroupMemberships: async () => [group('cap-0', 'cap', 0)] });
    await expect(disabled.service.reserve(1031)).resolves.toEqual({ ok: false, code: 'AI_DISABLED_BY_ADMIN' });
    await expect(disabled.service.status(1031)).resolves.toEqual(expect.objectContaining({ disabled: true, limit: 0, remaining: 0 }));

    const lowCredit = setup({ dailyMessageLimit: 3, guaranteeCount: 0 }, { getCreditMultiplier: async () => 0.2 });
    const result = await lowCredit.service.reserve(1031);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'QUOTA_EXHAUSTED', limit: 0 }));
  });

  it('combines overrides, groups and credit through the policy sources', async () => {
    const { service } = setup({ dailyMessageLimit: 20, guaranteeCount: 3 }, {
      getOverride: async () => null,
      getGroupMemberships: async () => [group('team', 'grant', 60)],
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

describe('QuotaService.explain (US3)', () => {
  const override = (input: { mode: 'limit' | 'disabled'; dailyLimit?: number; expiresAt?: Date }) => (
    { reason: '准备省赛', setBy: 2, setAt: NOW, ...input }
  );

  it('follows acceptance scenarios 1–3: grant max, then the smallest cap', async () => {
    let groups = [group('team', 'grant', 60)];
    const { service } = setup({ dailyMessageLimit: 20 }, { getGroupMemberships: async () => groups });
    await expect(service.explain(1031)).resolves.toEqual(expect.objectContaining({
      limit: 60, source: 'grant', capped: false, defaultLimit: 20,
      groups: [expect.objectContaining({ id: 'team', applied: true })],
    }));

    groups = [group('team', 'grant', 60), group('ta', 'grant', 40)];
    const two = await service.explain(1031);
    expect(two.limit).toBe(60);
    expect(two.groups.map((g) => [g.id, g.applied])).toEqual([['team', true], ['ta', false]]);

    groups = [...groups, group('watch', 'cap', 5)];
    const capped = await service.explain(1031);
    expect(capped).toEqual(expect.objectContaining({ limit: 5, source: 'grant', capped: true }));
    expect(capped.groups.filter((g) => g.applied).map((g) => g.id)).toEqual(['team', 'watch']);
  });

  it('follows acceptance scenario 4: an override wins until it expires', async () => {
    const expiresAt = new Date(NOW.getTime() + 7 * 24 * 3600 * 1000);
    const { service, setNow } = setup({ dailyMessageLimit: 20 }, {
      getOverride: async () => override({ mode: 'limit', dailyLimit: 100, expiresAt }),
      getGroupMemberships: async () => [group('watch', 'cap', 5)],
    });
    await expect(service.explain(1031)).resolves.toEqual(expect.objectContaining({
      limit: 100, source: 'override', override: expect.objectContaining({ active: true, reason: '准备省赛' }),
    }));
    expect((await service.explain(1031)).groups[0].applied).toBe(false);

    setNow(new Date(expiresAt.getTime() + 1000));
    await expect(service.explain(1031)).resolves.toEqual(expect.objectContaining({
      limit: 5, source: 'default', capped: true, override: expect.objectContaining({ active: false }),
    }));
  });

  it('reports a disabled override and a zero cap as AI switched off (scenario 7)', async () => {
    const off = setup({ dailyMessageLimit: 20 }, { getOverride: async () => override({ mode: 'disabled' }) });
    await expect(off.service.explain(1031)).resolves.toEqual(expect.objectContaining({ disabled: true, limit: 0 }));
    await expect(off.service.reserve(1031)).resolves.toEqual({ ok: false, code: 'AI_DISABLED_BY_ADMIN' });

    const paused = setup({ dailyMessageLimit: 20 }, { getGroupMemberships: async () => [group('pause', 'cap', 0, false)] });
    await expect(paused.service.explain(1031)).resolves.toEqual(expect.objectContaining({ disabled: false, limit: 20 }));
  });

  it('batches overrides and usage for an overview page', async () => {
    const getOverrides = jest.fn(async () => new Map([[1032, override({ mode: 'disabled' })]]));
    const getOverride = jest.fn();
    const { service } = setup({ dailyMessageLimit: 2 }, {
      getOverrides,
      getOverride,
      getGroupMemberships: async (uid) => (uid === 1033 ? [group('team', 'grant', 60)] : []),
    });
    const reserved = await service.reserve(1031);
    if (!('reservation' in reserved)) throw new Error('expected reservation');
    await service.confirm(reserved.reservation);
    getOverride.mockClear();

    const result = await service.explainMany([1031, 1032, 1033]);
    expect(getOverrides).toHaveBeenCalledTimes(1);
    expect(getOverride).not.toHaveBeenCalled();
    expect(result.get(1031)).toEqual(expect.objectContaining({ limit: 2, used: 1, remaining: 1, source: 'default' }));
    expect(result.get(1032)).toEqual(expect.objectContaining({ disabled: true, used: 0 }));
    expect(result.get(1033)).toEqual(expect.objectContaining({ limit: 60, source: 'grant', timezone: 'Asia/Shanghai' }));
    await expect(service.explainMany([])).resolves.toEqual(new Map());
  });
});
