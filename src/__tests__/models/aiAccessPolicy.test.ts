import { AIAccessPolicyModel } from '../../models/aiAccessPolicy';
import { AIAccessAuditModel } from '../../models/aiAccessAudit';

function createCollection() {
  const chain: any = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    createIndex: jest.fn(),
    find: jest.fn().mockReturnValue(chain),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    deleteOne: jest.fn(),
    insertOne: jest.fn(),
    _chain: chain,
  };
}

describe('AIAccessPolicyModel', () => {
  let coll: ReturnType<typeof createCollection>;
  let model: AIAccessPolicyModel;

  beforeEach(() => {
    coll = createCollection();
    model = new AIAccessPolicyModel({ collection: jest.fn(() => coll) } as any);
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a unique index on domainId + scope + target', async () => {
    await model.ensureIndexes();
    expect(coll.createIndex).toHaveBeenCalledWith(
      { domainId: 1, scope: 1, target: 1 },
      expect.objectContaining({ unique: true }),
    );
  });

  it('finds the user policy and policies of the user\'s groups in one query', async () => {
    await model.findForUser('d1', 42, ['A', 'B']);
    expect(coll.find).toHaveBeenCalledWith({
      domainId: 'd1',
      $or: [{ scope: 'user', target: 42 }, { scope: 'group', target: { $in: ['A', 'B'] } }],
    });

    await model.findForUser('d1', 42, []);
    expect(coll.find).toHaveBeenLastCalledWith({ domainId: 'd1', $or: [{ scope: 'user', target: 42 }] });
  });

  it('sets given fields, unsets null fields and defaults enabled=true on insert', async () => {
    const before = { domainId: 'd1', scope: 'user', target: 42, enabled: false };
    const after = { ...before, dailyTokenLimit: 500 };
    coll.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const result = await model.upsert('d1', 'user', 42, { dailyTokenLimit: 500, rateLimitPerMinute: null }, 7);

    expect(result).toEqual({ before, after });
    const [filter, update, options] = coll.updateOne.mock.calls[0];
    expect(filter).toEqual({ domainId: 'd1', scope: 'user', target: 42 });
    expect(update.$set).toMatchObject({ dailyTokenLimit: 500, updatedBy: 7, updatedAt: expect.any(Date) });
    expect(update.$unset).toEqual({ rateLimitPerMinute: '' });
    expect(update.$setOnInsert).toEqual({ domainId: 'd1', scope: 'user', target: 42, enabled: true });
    expect(options).toEqual({ upsert: true });
  });

  it('does not put enabled into $setOnInsert when the patch sets it', async () => {
    await model.upsert('d1', 'group', 'A', { enabled: false }, 7);
    const update = coll.updateOne.mock.calls[0][1];
    expect(update.$set.enabled).toBe(false);
    expect(update.$setOnInsert).toEqual({ domainId: 'd1', scope: 'group', target: 'A' });
    expect(update.$unset).toBeUndefined();
  });

  it('returns the deleted document, or null without deleting when absent', async () => {
    coll.findOne.mockResolvedValueOnce({ target: 42 }).mockResolvedValueOnce(null);
    await expect(model.delete('d1', 'user', 42)).resolves.toEqual({ target: 42 });
    await expect(model.delete('d1', 'user', 43)).resolves.toBeNull();
    expect(coll.deleteOne).toHaveBeenCalledTimes(1);
  });
});

describe('AIAccessAuditModel', () => {
  it('stores before/after snapshots without Mongo ids and caps list size', async () => {
    const coll = createCollection();
    const model = new AIAccessAuditModel({ collection: jest.fn(() => coll) } as any);

    await model.record({
      domainId: 'd1', scope: 'user', target: 42, action: 'upsert',
      before: null,
      after: { _id: 'x' as any, domainId: 'd1', scope: 'user', target: 42, enabled: false, updatedBy: 7, updatedAt: new Date(0) },
      operatorUid: 7,
    });
    const doc = coll.insertOne.mock.calls[0][0];
    expect(doc).toMatchObject({ domainId: 'd1', action: 'upsert', before: null, operatorUid: 7, createdAt: expect.any(Date) });
    expect(doc.after).not.toHaveProperty('_id');
    expect(doc).not.toHaveProperty('batchId');

    await model.list('d1', { scope: 'user', target: 42, limit: 5000 });
    expect(coll.find).toHaveBeenCalledWith({ domainId: 'd1', scope: 'user', target: 42 });
    expect(coll._chain.limit).toHaveBeenCalledWith(200);
  });
});
