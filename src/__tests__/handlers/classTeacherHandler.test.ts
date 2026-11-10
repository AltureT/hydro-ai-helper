jest.mock('../../lib/rateLimitHelper', () => ({
  applyRateLimit: jest.fn().mockResolvedValue(false),
}));

import { ObjectId } from 'mongodb';
import { PRIV } from 'hydrooj';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { ConversationModel } from '../../models/conversation';
import { GroupMetaModel } from '../../models/groupMeta';
import { ClassTeacherService } from '../../services/classTeacherService';
import {
  ClassAnalyticsHandler,
  ClassConversationDetailHandler,
  ClassConversationListHandler,
  ClassTeacherHandler,
  ClassTeacherHandlerPriv,
} from '../../handlers/classTeacherHandler';

const NOW = new Date('2026-11-10T08:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const TEACHER = 501;
const OTHER_TEACHER = 502;
const STUDENT_A = 1031;
const STUDENT_B = 1032;
const STUDENT_C = 1041;

const ids = {
  own1: new ObjectId(),
  own2: new ObjectId(),
  ownAndContest: new ObjectId(),
  ownOld: new ObjectId(),
  otherClass: new ObjectId(),
  otherDomain: new ObjectId(),
  ungrouped: new ObjectId(),
};

function setup(options: { accessEnabled?: boolean } = {}) {
  const conv = (id: ObjectId, extra: Record<string, unknown>) => ({
    _id: id,
    domainId: 'oi2023',
    problemId: 'P1000',
    messageCount: 4,
    isEffective: true,
    tags: [],
    teacherNote: '仅管理员可见的备注',
    startTime: daysAgo(1),
    endTime: daysAgo(1),
    ...extra,
  });
  const db = createFakeDb({
    ai_conversations: createFakeCollection([
      conv(ids.own1, { userId: STUDENT_A, groupNames: ['2023级1班'], metrics: { studentMessageCount: 3 } }),
      conv(ids.own2, { userId: STUDENT_B, groupNames: ['2023级1班'], messageCount: 6 }),
      conv(ids.ownAndContest, { userId: STUDENT_A, groupNames: ['2023级1班', '竞赛组'], messageCount: 2 }),
      conv(ids.ownOld, { userId: STUDENT_B, groupNames: ['2023级1班'], startTime: daysAgo(10), endTime: daysAgo(10) }),
      conv(ids.otherClass, { userId: STUDENT_C, groupNames: ['2023级2班'] }),
      conv(ids.otherDomain, { userId: STUDENT_A, domainId: 'oi2024', groupNames: ['2023级1班'] }),
      conv(ids.ungrouped, { userId: STUDENT_C }),
    ]),
    ai_jailbreak_logs: createFakeCollection([
      { domainId: 'oi2023', conversationId: ids.own1, category: 'off_topic', reviewStatus: 'pending' },
      { domainId: 'oi2023', conversationId: ids.own1, category: 'off_topic', reviewStatus: 'confirmed' },
      { domainId: 'oi2023', conversationId: ids.own2, category: 'answer_seeking', reviewStatus: 'pending' },
      { domainId: 'oi2023', conversationId: ids.own2, category: 'prompt_injection', reviewStatus: 'false_positive' },
      { domainId: 'oi2023', conversationId: ids.otherClass, category: 'off_topic', reviewStatus: 'pending' },
    ]),
    'user.group': createFakeCollection([
      { _id: new ObjectId(), domainId: 'oi2023', name: '2023级1班', uids: [STUDENT_A, STUDENT_B, 1033] },
      { _id: new ObjectId(), domainId: 'oi2023', name: '2023级2班', uids: [STUDENT_C] },
      { _id: new ObjectId(), domainId: 'oi2023', name: '竞赛组', uids: [STUDENT_A] },
      { _id: new ObjectId(), domainId: 'oi2023', name: '1', uids: [STUDENT_A] },
      { _id: new ObjectId(), domainId: 'oi2024', name: '2023级1班', uids: [STUDENT_A] },
    ]),
    ai_group_meta: createFakeCollection([
      { _id: 'oi2023:2023级1班', domainId: 'oi2023', name: '2023级1班', kind: 'class', academicYear: '2023', teacherUids: [TEACHER], archived: false, pluginAdded: [] },
      { _id: 'oi2023:2023级2班', domainId: 'oi2023', name: '2023级2班', kind: 'class', teacherUids: [OTHER_TEACHER], archived: false, pluginAdded: [] },
      // 另一个域里的同名小组也由该老师负责，不能因此看到本域以外的数据
      { _id: 'oi2024:2023级1班', domainId: 'oi2024', name: '2023级1班', kind: 'class', teacherUids: [TEACHER], archived: false, pluginAdded: [] },
    ]),
  });
  const config = { getConfig: jest.fn().mockResolvedValue({ groupTeacherAccessEnabled: options.accessEnabled ?? true }) };
  const classTeacherService = new ClassTeacherService(db as any, new GroupMetaModel(db as any), config as any, () => NOW);
  const services: Record<string, unknown> = {
    classTeacherService,
    conversationModel: new ConversationModel(db as any),
    messageModel: {
      findFirstStudentMessagesForConversations: jest.fn().mockResolvedValue(new Map()),
      findByConversationId: jest.fn().mockResolvedValue([]),
    },
  };
  return { db, config, services };
}

function makeHandler<T extends { request: any; response: any; ctx: any; user?: any; args?: any }>(
  HandlerClass: new () => T,
  env: ReturnType<typeof setup>,
  options: { uid?: number; admin?: boolean; query?: Record<string, string>; html?: boolean } = {},
): T {
  const handler = new HandlerClass();
  handler.request = { headers: options.html ? { accept: 'text/html' } : { accept: 'application/json' }, query: options.query || {} };
  handler.response = {};
  handler.args = { domainId: 'oi2023' };
  handler.user = {
    _id: options.uid ?? TEACHER,
    hasPriv: (priv: number) => !!options.admin && priv === PRIV.PRIV_EDIT_SYSTEM,
  };
  (handler as any).translate = (key: string) => key;
  handler.ctx = { get: (name: string) => env.services[name] };
  return handler;
}

const WRITE_METHODS = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'deleteOne'] as const;

function expectNoWrites(env: ReturnType<typeof setup>) {
  for (const [name, coll] of Object.entries(env.db.store)) {
    for (const method of WRITE_METHODS) {
      expect({ collection: name, method, calls: (coll as any)[method].mock.calls.length })
        .toEqual({ collection: name, method, calls: 0 });
    }
  }
}

async function callAll(env: ReturnType<typeof setup>, options: { uid?: number; admin?: boolean } = {}) {
  const scope = makeHandler(ClassTeacherHandler, env, options);
  await scope.get();
  const analytics = makeHandler(ClassAnalyticsHandler, env, { ...options, query: { group: '2023级1班' } });
  await analytics.get();
  const list = makeHandler(ClassConversationListHandler, env, { ...options, query: { group: '2023级1班' } });
  await list.get();
  const detail = makeHandler(ClassConversationDetailHandler, env, options);
  await detail.get({ id: ids.own1.toHexString() });
  return [scope, analytics, list, detail];
}

describe('class teacher routes: access (FR-058)', () => {
  it('only requires login at the route level; checks happen in the handler', () => {
    expect(ClassTeacherHandlerPriv).toBe(PRIV.PRIV_USER_PROFILE);
  });

  it('rejects a group teacher on every route while teacher access is off', async () => {
    const env = setup({ accessEnabled: false });
    for (const handler of await callAll(env)) {
      expect(handler.response.status).toBe(403);
      expect(handler.response.body.code).toBe('TEACHER_ACCESS_DISABLED');
    }
  });

  it('rejects users who are not a teacher of any group in this domain', async () => {
    const env = setup();
    for (const handler of await callAll(env, { uid: 9999 })) {
      expect(handler.response.status).toBe(403);
      expect(handler.response.body.code).toBe('NOT_GROUP_TEACHER');
    }
  });

  it('lets system admins in even while teacher access is off, with every named group of the domain', async () => {
    const env = setup({ accessEnabled: false });
    const handler = makeHandler(ClassTeacherHandler, env, { uid: 2, admin: true });
    await handler.get();
    expect(handler.response.status).toBeUndefined();
    expect(handler.response.body.systemAdmin).toBe(true);
    expect(handler.response.body.groups.map((group: any) => group.name)).toEqual(['2023级1班', '2023级2班', '竞赛组']);
  });

  it('renders the page without data for browser requests', async () => {
    const env = setup({ accessEnabled: false });
    const handler = makeHandler(ClassTeacherHandler, env, { html: true });
    await handler.get();
    expect(handler.response.template).toBe('ai-helper/class_teacher.html');
    expect(env.config.getConfig).not.toHaveBeenCalled();
  });

  it('defines GET only, and never writes', async () => {
    for (const HandlerClass of [ClassTeacherHandler, ClassAnalyticsHandler, ClassConversationListHandler, ClassConversationDetailHandler]) {
      expect((HandlerClass.prototype as any).post).toBeUndefined();
    }
    const env = setup();
    await callAll(env);
    await callAll(env, { uid: 2, admin: true });
    expectNoWrites(env);
  });
});

describe('class teacher routes: filtering by group', () => {
  it('lists only the groups this teacher is in charge of, in this domain', async () => {
    const env = setup();
    const handler = makeHandler(ClassTeacherHandler, env);
    await handler.get();
    expect(handler.response.body.groups).toEqual([
      { name: '2023级1班', memberCount: 3, kind: 'class', academicYear: '2023', archived: false },
    ]);
  });

  it('refuses a group the teacher is not in charge of', async () => {
    const env = setup();
    for (const HandlerClass of [ClassAnalyticsHandler, ClassConversationListHandler]) {
      const handler = makeHandler(HandlerClass, env, { query: { group: '2023级2班' } });
      await handler.get();
      expect(handler.response.status).toBe(403);
      expect(handler.response.body.code).toBe('GROUP_NOT_ALLOWED');
    }
    const missing = makeHandler(ClassAnalyticsHandler, env, { query: {} });
    await missing.get();
    expect(missing.response.body.code).toBe('GROUP_NOT_ALLOWED');
  });

  it('lists only this group\'s conversations in this domain, newest first, with violation flags and no admin notes', async () => {
    const env = setup();
    const handler = makeHandler(ClassConversationListHandler, env, { query: { group: '2023级1班' } });
    await handler.get();
    const body = handler.response.body;
    expect(body.total).toBe(4);
    const listed = body.conversations.map((conv: any) => conv._id);
    expect(new Set(listed)).toEqual(new Set([ids.own1, ids.own2, ids.ownAndContest, ids.ownOld].map(String)));
    expect(listed[listed.length - 1]).toBe(String(ids.ownOld));
    const own1 = body.conversations.find((conv: any) => conv._id === String(ids.own1));
    expect(own1.flags).toEqual({ count: 2, categories: ['off_topic'] });
    expect(own1.groupNames).toEqual(['2023级1班']);
    expect(own1.teacherNote).toBeUndefined();
    const own2 = body.conversations.find((conv: any) => conv._id === String(ids.own2));
    expect(own2.flags).toEqual({ count: 1, categories: ['answer_seeking'] });
  });

  it('opens a conversation only when it was in one of the teacher\'s groups and in this domain', async () => {
    const env = setup();
    const own = makeHandler(ClassConversationDetailHandler, env);
    await own.get({ id: ids.ownAndContest.toHexString() });
    expect(own.response.status).toBeUndefined();
    expect(own.response.body.conversation._id).toBe(String(ids.ownAndContest));
    expect(own.response.body.conversation.teacherNote).toBeUndefined();

    for (const id of [ids.otherClass, ids.otherDomain, ids.ungrouped, new ObjectId()]) {
      const handler = makeHandler(ClassConversationDetailHandler, env);
      await handler.get({ id: id.toHexString() });
      expect(handler.response.status).toBe(404);
    }
    const invalid = makeHandler(ClassConversationDetailHandler, env);
    await invalid.get({ id: 'not-an-id' });
    expect(invalid.response.status).toBe(404);
  });

  it('reports 7-day stats for the group: conversations, active students, average turns, violations', async () => {
    const env = setup();
    const handler = makeHandler(ClassAnalyticsHandler, env, { query: { group: '2023级1班' } });
    await handler.get();
    expect(handler.response.body).toEqual(expect.objectContaining({
      group: '2023级1班',
      days: 7,
      since: daysAgo(7).toISOString(),
      conversations: 3,
      activeStudents: 2,
      memberCount: 3,
      // 3（metrics）、3（6 条消息）、1（2 条消息）
      avgTurns: 2.3,
      violations: { total: 3, byCategory: { off_topic: 2, answer_seeking: 1 } },
      truncated: false,
    }));
  });
});
