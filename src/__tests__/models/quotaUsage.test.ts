import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { QuotaUsageModel, QUOTA_USAGE_RETENTION_DAYS, quotaUsageId } from '../../models/quotaUsage';

const DATE = '2026-11-10';
const now = new Date('2026-11-10T04:00:00Z');
const staleBefore = new Date('2026-11-10T03:50:00Z');

function setup(initial: any[] = []) {
  const collection = createFakeCollection(initial);
  const db = createFakeDb({ ai_quota_usage: collection });
  return { collection, model: new QuotaUsageModel(db as any) };
}

describe('QuotaUsageModel', () => {
  it('creates the TTL and date indexes', async () => {
    const { collection, model } = setup();
    await model.ensureIndexes();
    expect(collection.createIndex).toHaveBeenCalledWith({ expireAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 }));
    expect(collection.createIndex).toHaveBeenCalledWith({ date: 1, used: -1 }, expect.any(Object));
  });

  it('reserves with a conditional $push and creates the daily document', async () => {
    const { collection, model } = setup();
    await expect(model.reserve(1031, DATE, 2, 'r1', staleBefore, now)).resolves.toBe(true);
    const doc = collection.docs[0];
    expect(doc).toEqual(expect.objectContaining({ _id: '1031:2026-11-10', uid: 1031, date: DATE, used: 0 }));
    expect(doc.reservations).toEqual([{ id: 'r1', at: now }]);
    expect(doc.expireAt.toISOString()).toBe(new Date(Date.parse('2026-11-10T00:00:00Z') + QUOTA_USAGE_RETENTION_DAYS * 86400000).toISOString());
    const conditional = collection.updateOne.mock.calls.find((call) => call[0].$expr);
    expect(conditional?.[0].$expr).toEqual({
      $lt: [{ $add: [{ $ifNull: ['$used', 0] }, { $size: { $ifNull: ['$reservations', []] } }] }, 2],
    });
  });

  it('counts in-flight reservations against the limit', async () => {
    const { model } = setup([{ _id: quotaUsageId(1031, DATE), uid: 1031, date: DATE, used: 1, reservations: [] }]);
    await expect(model.reserve(1031, DATE, 3, 'r1', staleBefore, now)).resolves.toBe(true);
    await expect(model.reserve(1031, DATE, 3, 'r2', staleBefore, now)).resolves.toBe(true);
    await expect(model.reserve(1031, DATE, 3, 'r3', staleBefore, now)).resolves.toBe(false);
  });

  it('drops stale reservations before checking the limit', async () => {
    const stale = new Date('2026-11-10T03:00:00Z');
    const { collection, model } = setup([{
      _id: quotaUsageId(1031, DATE), uid: 1031, date: DATE, used: 1, reservations: [{ id: 'old', at: stale }],
    }]);
    await expect(model.reserve(1031, DATE, 2, 'r1', staleBefore, now)).resolves.toBe(true);
    expect(collection.docs[0].reservations).toEqual([{ id: 'r1', at: now }]);
  });

  it('never lets concurrent reservations exceed the limit', async () => {
    const { collection, model } = setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => model.reserve(1031, DATE, 5, `r${i}`, staleBefore, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(collection.docs).toHaveLength(1);
    expect(collection.docs[0].reservations).toHaveLength(5);
  });

  it('rejects a zero limit without touching the database', async () => {
    const { collection, model } = setup();
    await expect(model.reserve(1031, DATE, 0, 'r1', staleBefore, now)).resolves.toBe(false);
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it('confirms by moving a reservation into used', async () => {
    const { collection, model } = setup();
    await model.reserve(1031, DATE, 5, 'r1', staleBefore, now);
    await model.reserve(1031, DATE, 5, 'r2', staleBefore, now);
    await expect(model.confirm(1031, DATE, 'r1', now)).resolves.toBe(1);
    expect(collection.docs[0].reservations.map((r: any) => r.id)).toEqual(['r2']);
  });

  it('still counts when the reservation already expired', async () => {
    const { collection, model } = setup([{ _id: quotaUsageId(1031, DATE), uid: 1031, date: DATE, used: 3, reservations: [] }]);
    await expect(model.confirm(1031, DATE, 'gone', now)).resolves.toBe(4);
    expect(collection.docs[0].used).toBe(4);
  });

  it('releases a reservation without counting it', async () => {
    const { collection, model } = setup();
    await model.reserve(1031, DATE, 1, 'r1', staleBefore, now);
    await model.release(1031, DATE, 'r1');
    expect(collection.docs[0]).toEqual(expect.objectContaining({ used: 0, reservations: [] }));
    await expect(model.reserve(1031, DATE, 1, 'r2', staleBefore, now)).resolves.toBe(true);
  });

  it('increments directly for unlimited users', async () => {
    const { collection, model } = setup();
    await expect(model.increment(1031, DATE, now)).resolves.toBe(1);
    await expect(model.increment(1031, DATE, now)).resolves.toBe(2);
    expect(collection.docs[0]).toEqual(expect.objectContaining({ uid: 1031, date: DATE, used: 2, reservations: [] }));
  });

  it('unwraps mongodb 5 ModifyResult on confirm', async () => {
    const { collection, model } = setup();
    collection.findOneAndUpdate.mockResolvedValueOnce({ ok: 1, value: { used: 7 }, lastErrorObject: {} });
    await expect(model.confirm(1031, DATE, 'r1', now)).resolves.toBe(7);
  });

  it('tolerates a duplicate-key race when creating the daily document', async () => {
    const { collection, model } = setup();
    collection.updateOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(model.reserve(1031, DATE, 5, 'r1', staleBefore, now)).resolves.toBe(false);
    // 文档其实不存在（模拟中由另一请求创建失败），条件更新匹配不到：返回 false 而不是抛错
  });
});
