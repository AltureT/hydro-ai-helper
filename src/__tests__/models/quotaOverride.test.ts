import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { QuotaOverrideModel } from '../../models/quotaOverride';

const NOW = new Date('2026-11-10T08:00:00Z');
const LATER = new Date('2026-11-17T08:00:00Z');

function setup() {
  const collection = createFakeCollection();
  const model = new QuotaOverrideModel(createFakeDb({ ai_quota_overrides: collection }) as any);
  return { collection, model };
}

describe('QuotaOverrideModel', () => {
  it('uses a TTL index on expiresAt so overrides without expiry never expire', async () => {
    const { collection, model } = setup();
    await model.ensureIndexes();
    expect(collection.createIndex).toHaveBeenCalledWith({ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 }));
  });

  it('upserts one override per user and returns the previous one', async () => {
    const { collection, model } = setup();
    await expect(model.set(1031, { mode: 'limit', dailyLimit: 100, expiresAt: LATER, reason: '准备省赛', setBy: 2, setAt: NOW }))
      .resolves.toBeNull();
    const previous = await model.set(1031, { mode: 'disabled', reason: '家长要求暂停使用', setBy: 2, setAt: NOW });
    expect(previous).toEqual(expect.objectContaining({ mode: 'limit', dailyLimit: 100 }));
    expect(collection.docs).toHaveLength(1);
    // 改为禁用时去掉次数；不设到期时去掉旧的到期时间
    expect(collection.docs[0]).toEqual({ _id: 1031, mode: 'disabled', reason: '家长要求暂停使用', setBy: 2, setAt: NOW });
  });

  it('lists only active overrides and their uids by mode', async () => {
    const { model } = setup();
    await model.set(1031, { mode: 'limit', dailyLimit: 100, expiresAt: LATER, reason: 'a', setBy: 2, setAt: NOW });
    await model.set(1032, { mode: 'disabled', reason: 'b', setBy: 2, setAt: NOW });
    await model.set(1033, { mode: 'disabled', expiresAt: new Date('2026-11-09T00:00:00Z'), reason: 'expired', setBy: 2, setAt: NOW });
    const active = await model.listActive(NOW);
    expect(active.total).toBe(2);
    expect(active.items.map((item) => item._id).sort()).toEqual([1031, 1032]);
    await expect(model.activeUids(NOW, 'disabled')).resolves.toEqual([1032]);
  });

  it('clears and reports what was removed', async () => {
    const { model } = setup();
    await model.set(1031, { mode: 'disabled', reason: 'b', setBy: 2, setAt: NOW });
    await expect(model.clear(1031)).resolves.toEqual(expect.objectContaining({ _id: 1031, mode: 'disabled' }));
    await expect(model.clear(1031)).resolves.toBeNull();
    await expect(model.getMany([1031])).resolves.toEqual([]);
  });
});
