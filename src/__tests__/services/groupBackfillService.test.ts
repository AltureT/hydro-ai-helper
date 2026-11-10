jest.mock('../../lib/rateLimitHelper', () => ({
  applyRateLimit: jest.fn().mockResolvedValue(false),
}));

import { ObjectId } from 'mongodb';
import { PRIV } from 'hydrooj';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { AuditLogModel } from '../../models/auditLog';
import { AuditService } from '../../services/auditService';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_TIME_BUDGET_MS,
  GroupBackfillService,
} from '../../services/groupBackfillService';
import { GroupBackfillHandler, GroupAdminHandlerPriv } from '../../handlers/groupAdminHandler';

const STUDENT_A = 1031;
const STUDENT_B = 1032;
const STUDENT_C = 1041;
const NOBODY = 1099;

function setup(conversations: Record<string, unknown>[]) {
  const db = createFakeDb({
    ai_conversations: createFakeCollection(conversations),
    'user.group': createFakeCollection([
      { _id: new ObjectId(), domainId: 'oi2023', name: '2023级2班', uids: [STUDENT_A, STUDENT_B] },
      { _id: new ObjectId(), domainId: 'oi2023', name: '竞赛组', uids: [STUDENT_A] },
      { _id: new ObjectId(), domainId: 'oi2023', name: '7', uids: [STUDENT_A, STUDENT_C] },
      { _id: new ObjectId(), domainId: 'oi2024', name: '别的域', uids: [STUDENT_C] },
    ]),
  });
  const auditLogModel = new AuditLogModel(db as any);
  const audit = new AuditService(auditLogModel);
  return { db, audit, service: new GroupBackfillService(db as any, audit) };
}

const legacy = (userId: number, extra: Record<string, unknown> = {}) => ({
  _id: new ObjectId(), domainId: 'oi2023', userId, startTime: new Date('2025-09-01'), ...extra,
});

describe('GroupBackfillService (FR-057)', () => {
  it('fills only conversations without a group record, from current membership, marked as backfill', async () => {
    const snapshot = legacy(STUDENT_A, { groupNames: ['2023级1班'], groupSource: 'snapshot' });
    const snapshotEmpty = legacy(STUDENT_B, { groupNames: [], groupSource: 'snapshot' });
    const otherDomain = { ...legacy(STUDENT_C), domainId: 'oi2024' };
    const { db, service } = setup([
      legacy(STUDENT_A), legacy(STUDENT_B), legacy(STUDENT_C), legacy(NOBODY), snapshot, snapshotEmpty, otherDomain,
    ]);

    expect(await service.countPending('oi2023')).toBe(4);
    const result = await service.run('oi2023', 2);
    expect(result).toEqual({ updated: 4, remaining: 0, partial: false });

    const docs = db.store.ai_conversations.docs;
    const byUser = (uid: number) => docs.filter((doc) => doc.domainId === 'oi2023' && doc.userId === uid && doc.groupSource === 'backfill');
    expect(byUser(STUDENT_A).map((doc) => doc.groupNames)).toEqual([['2023级2班', '竞赛组']]);
    expect(byUser(STUDENT_B).map((doc) => doc.groupNames)).toEqual([['2023级2班']]);
    // 纯数字名称的小组不计入；不在任何小组时写入空数组，下次不再处理
    expect(byUser(STUDENT_C).map((doc) => doc.groupNames)).toEqual([[]]);
    expect(byUser(NOBODY).map((doc) => doc.groupNames)).toEqual([[]]);

    // 已有快照（包括空快照）和其他域的会话保持不变
    expect(docs.find((doc) => doc._id.equals(snapshot._id))).toEqual(expect.objectContaining({ groupNames: ['2023级1班'], groupSource: 'snapshot' }));
    expect(docs.find((doc) => doc._id.equals(snapshotEmpty._id))).toEqual(expect.objectContaining({ groupNames: [], groupSource: 'snapshot' }));
    expect(docs.find((doc) => doc._id.equals(otherDomain._id))).not.toHaveProperty('groupNames');

    expect(await service.countPending('oi2023')).toBe(0);
    expect(await service.run('oi2023', 2)).toEqual({ updated: 0, remaining: 0, partial: false });
  });

  it('writes one audit entry per run that changed something', async () => {
    const { db, service } = setup([legacy(STUDENT_A), legacy(STUDENT_B)]);
    await service.run('oi2023', 2);
    await service.run('oi2023', 2);
    const logs = db.store.ai_audit_logs.docs;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(expect.objectContaining({
      actorUid: 2,
      action: 'group.backfill',
      category: 'group',
      domainId: 'oi2023',
      target: { type: 'domain', id: 'oi2023' },
      detail: { updated: 2, remaining: 0, groupCount: 2 },
      undoable: false,
    }));
  });

  it('works in batches and merges students with the same groups into one write', async () => {
    const many = Array.from({ length: BACKFILL_BATCH_SIZE + 20 }, (_, i) => legacy(i % 2 ? STUDENT_A : STUDENT_B));
    const { db, service } = setup(many);
    const result = await service.run('oi2023', 2);
    expect(result.updated).toBe(BACKFILL_BATCH_SIZE + 20);
    const coll = db.store.ai_conversations;
    // 两批，每批两种小组组合
    expect(coll.updateMany).toHaveBeenCalledTimes(4);
    for (const [filter] of coll.updateMany.mock.calls) {
      expect(filter).toEqual(expect.objectContaining({ groupNames: { $exists: false } }));
    }
  });

  it('stops at the time budget and reports what is left', async () => {
    const many = Array.from({ length: BACKFILL_BATCH_SIZE * 2 }, () => legacy(STUDENT_A));
    const { db, audit } = setup(many);
    let clock = 0;
    const service = new GroupBackfillService(db as any, audit, () => {
      const now = clock;
      clock += BACKFILL_TIME_BUDGET_MS / 2;
      return now;
    });
    const result = await service.run('oi2023', 2);
    expect(result).toEqual({ updated: BACKFILL_BATCH_SIZE, remaining: BACKFILL_BATCH_SIZE, partial: true });
  });

  it('never touches Hydro groups', async () => {
    const { db, service } = setup([legacy(STUDENT_A)]);
    await service.run('oi2023', 2);
    const groups = db.store['user.group'];
    for (const method of ['updateOne', 'updateMany', 'insertOne', 'deleteOne', 'findOneAndUpdate'] as const) {
      expect(groups[method]).not.toHaveBeenCalled();
    }
  });
});

describe('GroupBackfillHandler', () => {
  function makeHandler(env: ReturnType<typeof setup>, options: { admin?: boolean; csrf?: boolean } = {}) {
    const handler = new GroupBackfillHandler();
    handler.request = { headers: options.csrf === false ? {} : { 'x-requested-with': 'XMLHttpRequest' }, body: {}, query: {} };
    handler.response = {};
    handler.args = { domainId: 'oi2023' };
    handler.user = { _id: 2, hasPriv: (priv: number) => options.admin !== false && priv === PRIV.PRIV_EDIT_SYSTEM };
    (handler as any).translate = (key: string) => key;
    handler.ctx = { get: (name: string) => (name === 'groupBackfillService' ? env.service : undefined) } as any;
    return handler;
  }

  it('is system admin only, at the route and in the handler', async () => {
    expect(GroupAdminHandlerPriv).toBe(PRIV.PRIV_EDIT_SYSTEM);
    const env = setup([legacy(STUDENT_A)]);
    const get = makeHandler(env, { admin: false });
    await get.get();
    expect(get.response.status).toBe(403);
    const post = makeHandler(env, { admin: false });
    await post.post();
    expect(post.response.status).toBe(403);
    expect(await env.service.countPending('oi2023')).toBe(1);
  });

  it('requires the CSRF header to run', async () => {
    const env = setup([legacy(STUDENT_A)]);
    const handler = makeHandler(env, { csrf: false });
    await handler.post();
    expect(handler.response.body.code).toBe('CSRF_REJECTED');
    expect(await env.service.countPending('oi2023')).toBe(1);
  });

  it('returns the pending count and the run result', async () => {
    const env = setup([legacy(STUDENT_A), legacy(STUDENT_B)]);
    const get = makeHandler(env);
    await get.get();
    expect(get.response.body).toEqual({ pending: 2 });
    const post = makeHandler(env);
    await post.post();
    expect(post.response.body).toEqual({ success: true, updated: 2, remaining: 0, partial: false });
  });
});
