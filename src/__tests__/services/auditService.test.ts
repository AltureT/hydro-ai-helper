import { ObjectId } from 'mongodb';
import { AuditLogModel, AUDIT_RETENTION_DAYS, auditCategoryOf } from '../../models/auditLog';
import { AuditService, sanitizeAuditValue } from '../../services/auditService';

function createCollection() {
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    cursor,
    createIndex: jest.fn(),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(() => cursor),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

function setup() {
  const collection = createCollection();
  const db = { collection: jest.fn(() => collection) } as any;
  const model = new AuditLogModel(db);
  return { collection, model, service: new AuditService(model) };
}

describe('AuditLogModel', () => {
  it('creates a TTL index and the query indexes', async () => {
    const { collection, model } = setup();
    await model.ensureIndexes();
    expect(collection.createIndex).toHaveBeenCalledWith({ expireAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 }));
    expect(collection.createIndex).toHaveBeenCalledWith({ domainId: 1, at: -1 }, expect.any(Object));
    expect(collection.createIndex).toHaveBeenCalledWith({ 'target.type': 1, 'target.id': 1 }, expect.any(Object));
  });

  it('derives the category from the action', () => {
    expect(auditCategoryOf('group.add')).toBe('group');
    expect(auditCategoryOf('settings.teacher_access')).toBe('settings');
  });

  it('claims undo atomically and unwraps both driver result shapes', async () => {
    const { collection, model } = setup();
    const id = new ObjectId();
    const doc = { _id: id, action: 'group.add' };
    collection.findOneAndUpdate.mockResolvedValueOnce({ ok: 1, value: doc, lastErrorObject: {} });
    await expect(model.claimUndo(id, 2)).resolves.toBe(doc);
    collection.findOneAndUpdate.mockResolvedValueOnce(doc);
    await expect(model.claimUndo(id, 2)).resolves.toBe(doc);
    collection.findOneAndUpdate.mockResolvedValueOnce(null);
    await expect(model.claimUndo(id, 2)).resolves.toBeNull();
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: id, undoable: true, undoneAt: { $exists: false } },
      { $set: { undoneAt: expect.any(Date), undoneBy: 2 } },
      { returnDocument: 'before' },
    );
  });

  it('builds list filters, including system-only actors', async () => {
    const { collection, model } = setup();
    const from = new Date('2026-11-01T00:00:00Z');
    await model.list({ category: 'group', actorType: 'system', domainId: 'oi2023', from }, 2, 500);
    expect(collection.find).toHaveBeenCalledWith({
      category: 'group',
      actorUid: { $exists: false },
      domainId: 'oi2023',
      at: { $gte: from },
    });
    expect(collection.cursor.skip).toHaveBeenCalledWith(100);
    expect(collection.cursor.limit).toHaveBeenCalledWith(100);
  });
});

describe('AuditService', () => {
  it('records sanitized entries with a 180-day expiry', async () => {
    const { collection, service } = setup();
    const at = Date.now();
    await service.record({
      actorUid: 2,
      action: 'group.add',
      domainId: 'oi2023',
      target: { type: 'group', id: '2023级1班' },
      detail: { added: [1031, 1032], reason: 'contact student@example.com', token: 'sk-abcdefghijklmnop' },
      undoable: true,
    });
    const doc = collection.insertOne.mock.calls[0][0];
    expect(doc).toEqual(expect.objectContaining({
      actorUid: 2,
      action: 'group.add',
      category: 'group',
      domainId: 'oi2023',
      target: { type: 'group', id: '2023级1班' },
      undoable: true,
    }));
    expect(doc.detail.added).toEqual([1031, 1032]);
    expect(doc.detail.reason).toBe('contact [email]');
    expect(doc.detail.token).toBe('[secret]');
    const retentionMs = doc.expireAt.getTime() - doc.at.getTime();
    expect(retentionMs).toBe(AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(doc.at.getTime()).toBeGreaterThanOrEqual(at);
  });

  it('omits actorUid for system actions', async () => {
    const { collection, service } = setup();
    await service.record({ action: 'group.meta', target: { type: 'group', id: 'g' } });
    expect(collection.insertOne.mock.calls[0][0]).not.toHaveProperty('actorUid');
  });

  it('appends sanitized steps', async () => {
    const { collection, service } = setup();
    const id = new ObjectId();
    await service.appendStep(id, { name: 'join', status: 'done', detail: { note: 'x'.repeat(400) } });
    const [, update] = collection.updateOne.mock.calls[0];
    expect(update.$push.steps.detail.note).toHaveLength(256);
    expect(update.$push.steps.at).toBeInstanceOf(Date);
  });
});

describe('sanitizeAuditValue', () => {
  it('keeps numbers, dates and ObjectIds; truncates deep structures', () => {
    const id = new ObjectId();
    const date = new Date();
    expect(sanitizeAuditValue({ id, date, n: 1, b: true })).toEqual({ id, date, n: 1, b: true });
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(sanitizeAuditValue(deep)).toEqual({ a: { b: { c: { d: { e: '[truncated]' } } } } });
    expect(sanitizeAuditValue(10n)).toBe('10');
  });
});
