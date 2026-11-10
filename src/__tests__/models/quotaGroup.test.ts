import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { QuotaGroupModel, QuotaGroupNameTakenError, toObjectId } from '../../models/quotaGroup';

function setup() {
  const collection = createFakeCollection();
  const model = new QuotaGroupModel(createFakeDb({ ai_quota_groups: collection }) as any);
  return { collection, model };
}

const NOW = new Date('2026-11-10T08:00:00Z');

describe('QuotaGroupModel', () => {
  it('creates indexes: unique name and member lookup', async () => {
    const { collection, model } = setup();
    await model.ensureIndexes();
    expect(collection.createIndex).toHaveBeenCalledWith({ name: 1 }, expect.objectContaining({ unique: true }));
    expect(collection.createIndex).toHaveBeenCalledWith({ memberUids: 1 }, expect.anything());
  });

  it('creates a group with empty members and rejects duplicate names', async () => {
    const { model } = setup();
    const group = await model.create({ name: '竞赛队', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2, now: NOW });
    expect(group).toEqual(expect.objectContaining({ name: '竞赛队', memberUids: [], linkedGroups: [], createdAt: NOW }));
    await expect(model.create({ name: '竞赛队', mode: 'cap', dailyLimit: 5, enabled: true, createdBy: 2 }))
      .rejects.toBeInstanceOf(QuotaGroupNameTakenError);
  });

  it('maps a duplicate-key error from the unique index to a name clash', async () => {
    const { collection, model } = setup();
    collection.insertOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(model.create({ name: 'race', mode: 'grant', dailyLimit: 1, enabled: true, createdBy: 2 }))
      .rejects.toBeInstanceOf(QuotaGroupNameTakenError);
  });

  it('updates fields and returns before/after; renaming onto another group fails', async () => {
    const { model } = setup();
    const a = await model.create({ name: 'A', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await model.create({ name: 'B', mode: 'cap', dailyLimit: 5, enabled: true, createdBy: 2 });
    const result = await model.update(a._id, { dailyLimit: 80, enabled: false }, NOW);
    expect(result?.before).toEqual(expect.objectContaining({ dailyLimit: 60, enabled: true }));
    expect(result?.after).toEqual(expect.objectContaining({ dailyLimit: 80, enabled: false, updatedAt: NOW }));
    await expect(model.update(a._id, { name: 'B' })).rejects.toBeInstanceOf(QuotaGroupNameTakenError);
    // 改回自己的名字不算冲突
    await expect(model.update(a._id, { name: 'A' })).resolves.not.toBeNull();
  });

  it('adds and removes members atomically, reporting only actual changes', async () => {
    const { collection, model } = setup();
    const group = await model.create({ name: 'A', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await expect(model.addMembers(group._id, [1031, 1032])).resolves.toEqual([1031, 1032]);
    await expect(model.addMembers(group._id, [1032, 1033])).resolves.toEqual([1033]);
    await expect(model.removeMembers(group._id, [1031, 9999])).resolves.toEqual([1031]);
    expect(collection.docs[0].memberUids).toEqual([1032, 1033]);
    const update = collection.findOneAndUpdate.mock.calls[0][1];
    expect(update.$addToSet).toEqual({ memberUids: { $each: [1031, 1032] } });
    expect(update.$set).toBeDefined();
    expect(update.memberUids).toBeUndefined();
  });

  it('links and unlinks Hydro groups without duplicates', async () => {
    const { collection, model } = setup();
    const group = await model.create({ name: 'A', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await expect(model.link(group._id, { domainId: 'oi2023', name: '2023级1班' })).resolves.toBe(true);
    await expect(model.link(group._id, { domainId: 'oi2023', name: '2023级1班' })).resolves.toBe(false);
    await expect(model.link(group._id, { domainId: 'oi2024', name: '2023级1班' })).resolves.toBe(true);
    expect(collection.docs[0].linkedGroups).toHaveLength(2);
    await expect(model.unlink(group._id, { domainId: 'oi2023', name: '2023级1班' })).resolves.toBe(true);
    await expect(model.unlink(group._id, { domainId: 'oi2023', name: '2023级1班' })).resolves.toBe(false);
    expect(collection.docs[0].linkedGroups).toEqual([{ domainId: 'oi2024', name: '2023级1班' }]);
  });

  it('returns null for writes to a missing group and rejects malformed ids', async () => {
    const { model } = setup();
    const missing = toObjectId('64b7f0c2a1b2c3d4e5f60718')!;
    await expect(model.addMembers(missing, [1031])).resolves.toBeNull();
    await expect(model.link(missing, { domainId: 'd', name: 'g' })).resolves.toBeNull();
    await expect(model.delete(missing)).resolves.toBeNull();
    expect(toObjectId('not-an-id')).toBeNull();
    await expect(model.get('not-an-id')).resolves.toBeNull();
  });
});
