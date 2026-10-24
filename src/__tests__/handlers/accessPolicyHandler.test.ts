jest.mock('../../lib/rateLimitHelper', () => ({
  applyRateLimit: jest.fn().mockResolvedValue(false),
}));

import { ObjectId } from 'mongodb';
import { db } from 'hydrooj';
import {
  AccessPolicyAuditHandler,
  AccessPolicyBatchHandler,
  AccessPolicyDeleteHandler,
  AccessPolicyGroupsHandler,
  AccessPolicyHandler,
  AccessPolicyUpsertHandler,
  AccessPolicyUsersHandler,
  canManageAccess,
} from '../../handlers/accessPolicyHandler';
import { DomainAdminPerm } from '../../constants/permissions';

type Role = 'student' | 'domainAdmin' | 'root';

function makeUser(role: Role) {
  return {
    _id: 7,
    hasPriv: jest.fn((priv: number) => role === 'root' && priv === 2),
    hasPerm: jest.fn((perm: bigint) => role === 'domainAdmin' && perm === DomainAdminPerm),
  };
}

interface Fixtures {
  groups?: Array<{ name: string; uids: number[] }>;
  users?: Array<{ _id: number; uname: string; unameLower?: string }>;
  domainUsers?: Array<{ uid: number }>;
}

function cursor(docs: any[]) {
  const c: any = {
    sort: jest.fn(() => c),
    skip: jest.fn(() => c),
    limit: jest.fn(() => c),
    toArray: jest.fn().mockResolvedValue(docs),
  };
  return c;
}

function mockHydroCollections(fixtures: Fixtures) {
  (db.collection as jest.Mock).mockImplementation((name: string) => {
    if (name === 'user.group') {
      const groups = (fixtures.groups || []).map((g) => ({ ...g, domainId: 'd1' }));
      return {
        find: jest.fn((q: any) => cursor(groups.filter((g) => q.uids === undefined || g.uids.includes(q.uids)))),
        findOne: jest.fn(async (q: any) => groups.find((g) => g.name === q.name) || null),
      };
    }
    if (name === 'user') {
      const users = fixtures.users || [];
      return {
        find: jest.fn((q: any) => cursor(q._id ? users.filter((u) => q._id.$in.includes(u._id)) : users)),
        findOne: jest.fn(async (q: any) => users.find((u) => u._id === q._id) || null),
      };
    }
    if (name === 'domain.user') {
      const members = fixtures.domainUsers || [];
      return {
        find: jest.fn(() => cursor(members)),
        countDocuments: jest.fn().mockResolvedValue(members.length),
      };
    }
    throw new Error(`Unexpected collection ${name}`);
  });
}

function createHandler<T>(HandlerClass: new () => T, role: Role, request: Record<string, unknown> = {}) {
  const handler: any = new HandlerClass();
  const policyModel = {
    list: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(async (domainId, scope, target, patch, updatedBy) => ({
      before: null,
      after: { _id: new ObjectId(), domainId, scope, target, enabled: true, ...patch, updatedBy, updatedAt: new Date() },
    })),
    delete: jest.fn().mockResolvedValue({ _id: new ObjectId(), domainId: 'd1', scope: 'user', target: 42, enabled: false }),
  };
  const auditModel = { record: jest.fn().mockResolvedValue(undefined), list: jest.fn().mockResolvedValue([]) };
  const tokenUsageModel = { getUsersDailyUsage: jest.fn().mockResolvedValue(new Map()) };
  const aiConfigModel = {
    getConfig: jest.fn().mockResolvedValue({ rateLimitPerMinute: 6, budgetConfig: { dailyTokenLimitPerUser: 1000 } }),
  };
  handler.user = makeUser(role);
  handler.args = { domainId: 'd1' };
  handler.request = { headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json' }, body: {}, query: {}, ...request };
  handler.response = {};
  handler.translate = jest.fn((key: string) => key);
  handler.ctx = {
    get: jest.fn((name: string) => ({
      aiAccessPolicyModel: policyModel,
      aiAccessAuditModel: auditModel,
      tokenUsageModel,
      aiConfigModel,
    } as Record<string, unknown>)[name]),
  };
  return { handler, policyModel, auditModel, tokenUsageModel };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHydroCollections({});
});

describe('canManageAccess', () => {
  it('allows system admins and domain admins, rejects students and anonymous handlers', () => {
    expect(canManageAccess({ user: makeUser('root') } as any)).toBe(true);
    expect(canManageAccess({ user: makeUser('domainAdmin') } as any)).toBe(true);
    expect(canManageAccess({ user: makeUser('student') } as any)).toBe(false);
    expect(canManageAccess({} as any)).toBe(false);
  });
});

describe('access policy handler permissions', () => {
  const getHandlers = [AccessPolicyHandler, AccessPolicyGroupsHandler, AccessPolicyUsersHandler, AccessPolicyAuditHandler];
  const postHandlers = [AccessPolicyUpsertHandler, AccessPolicyDeleteHandler, AccessPolicyBatchHandler];

  it.each(getHandlers.map((h) => [h.name, h]))('%s GET rejects users without DomainAdminPerm', async (_name, HandlerClass: any) => {
    const { handler } = createHandler(HandlerClass, 'student');
    await handler.get();
    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('PERMISSION_DENIED');
  });

  it.each(postHandlers.map((h) => [h.name, h]))('%s POST rejects users without DomainAdminPerm and writes nothing', async (_name, HandlerClass: any) => {
    const { handler, policyModel, auditModel } = createHandler(HandlerClass, 'student', {
      body: { scope: 'user', target: 42, group: 'A', mode: 'clear', enabled: false },
    });
    await handler.post();
    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('PERMISSION_DENIED');
    expect(policyModel.upsert).not.toHaveBeenCalled();
    expect(policyModel.delete).not.toHaveBeenCalled();
    expect(auditModel.record).not.toHaveBeenCalled();
  });

  it.each(postHandlers.map((h) => [h.name, h]))('%s POST rejects requests without the CSRF header', async (_name, HandlerClass: any) => {
    const { handler, policyModel } = createHandler(HandlerClass, 'domainAdmin', { headers: {} });
    await handler.post();
    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CSRF_REJECTED');
    expect(policyModel.upsert).not.toHaveBeenCalled();
  });

  it('renders the page template for domain admins', async () => {
    const { handler } = createHandler(AccessPolicyHandler, 'domainAdmin', { headers: { accept: 'text/html' } });
    await handler.get();
    expect(handler.response.template).toBe('ai-helper/access_policy.html');
  });

  it('returns domain defaults as JSON for root', async () => {
    const { handler } = createHandler(AccessPolicyHandler, 'root');
    await handler.get();
    expect(handler.response.body).toMatchObject({
      domainId: 'd1',
      defaults: { dailyTokenLimitPerUser: 1000, rateLimitPerMinute: 6 },
    });
  });
});

describe('AccessPolicyUpsertHandler', () => {
  it('upserts a user policy scoped to the current domain and records an audit entry', async () => {
    mockHydroCollections({ users: [{ _id: 42, uname: 'alice' }] });
    const { handler, policyModel, auditModel } = createHandler(AccessPolicyUpsertHandler, 'domainAdmin', {
      body: { scope: 'user', target: '42', enabled: false, dailyTokenLimit: null, reason: 'exam' },
    });

    await handler.post();

    expect(handler.response.status).toBe(200);
    expect(policyModel.upsert).toHaveBeenCalledWith('d1', 'user', 42,
      { enabled: false, dailyTokenLimit: null, reason: 'exam' }, 7);
    expect(auditModel.record).toHaveBeenCalledWith(expect.objectContaining({
      domainId: 'd1', scope: 'user', target: 42, action: 'upsert', operatorUid: 7,
    }));
    expect(handler.response.body.policy).toMatchObject({ scope: 'user', target: 42, enabled: false });
  });

  it('rejects unknown targets with 404', async () => {
    const { handler, policyModel } = createHandler(AccessPolicyUpsertHandler, 'domainAdmin', {
      body: { scope: 'group', target: 'ghost', enabled: false },
    });
    await handler.post();
    expect(handler.response.status).toBe(404);
    expect(policyModel.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [{ scope: 'class', target: 'A' }, 'scope'],
    [{ scope: 'user', target: 'abc' }, 'target'],
    [{ scope: 'user', target: 1 }, 'target'],
    [{ scope: 'group', target: '  ' }, 'target'],
    [{ scope: 'user', target: 42, dailyTokenLimit: -5 }, 'dailyTokenLimit'],
  ])('rejects invalid body %j', async (body, field) => {
    const { handler, policyModel } = createHandler(AccessPolicyUpsertHandler, 'domainAdmin', { body });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.field).toBe(field);
    expect(policyModel.upsert).not.toHaveBeenCalled();
  });
});

describe('AccessPolicyDeleteHandler', () => {
  it('deletes the policy and records the removal', async () => {
    const { handler, policyModel, auditModel } = createHandler(AccessPolicyDeleteHandler, 'domainAdmin', {
      body: { scope: 'user', target: 42 },
    });
    await handler.post();
    expect(policyModel.delete).toHaveBeenCalledWith('d1', 'user', 42);
    expect(auditModel.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', after: null }));
    expect(handler.response.body).toEqual({ deleted: true });
  });
});

describe('AccessPolicyBatchHandler', () => {
  it('applies the same user-level policy to every group member with a shared batch id', async () => {
    mockHydroCollections({ groups: [{ name: 'class-1', uids: [42, 43, 43, 0] }] });
    const { handler, policyModel, auditModel } = createHandler(AccessPolicyBatchHandler, 'domainAdmin', {
      body: { group: 'class-1', mode: 'apply', extraTokensToday: 5000 },
    });

    await handler.post();

    expect(handler.response.body.affected).toBe(2);
    expect(policyModel.upsert).toHaveBeenCalledTimes(2);
    expect(policyModel.upsert).toHaveBeenCalledWith('d1', 'user', 42,
      { extraTokens: { date: new Date().toISOString().slice(0, 10), amount: 5000 } }, 7);
    const batchIds = auditModel.record.mock.calls.map(([entry]) => entry.batchId);
    expect(new Set(batchIds).size).toBe(1);
    expect(batchIds[0]).toBe(handler.response.body.batchId);
  });

  it('clears member policies and counts only the ones that existed', async () => {
    mockHydroCollections({ groups: [{ name: 'class-1', uids: [42, 43] }] });
    const { handler, policyModel } = createHandler(AccessPolicyBatchHandler, 'domainAdmin', {
      body: { group: 'class-1', mode: 'clear' },
    });
    policyModel.delete.mockResolvedValueOnce({ scope: 'user', target: 42 }).mockResolvedValueOnce(null);

    await handler.post();

    expect(policyModel.delete).toHaveBeenCalledTimes(2);
    expect(handler.response.body.affected).toBe(1);
  });

  it('returns 404 for a group that does not exist in the domain', async () => {
    const { handler, policyModel } = createHandler(AccessPolicyBatchHandler, 'domainAdmin', {
      body: { group: 'ghost', mode: 'apply', enabled: false },
    });
    await handler.post();
    expect(handler.response.status).toBe(404);
    expect(policyModel.upsert).not.toHaveBeenCalled();
  });
});

describe('AccessPolicyUsersHandler', () => {
  it('lists group members with today\'s usage and their resolved access', async () => {
    mockHydroCollections({
      groups: [{ name: 'class-1', uids: [42, 43] }],
      users: [{ _id: 42, uname: 'alice' }, { _id: 43, uname: 'bob' }],
    });
    const { handler, policyModel, tokenUsageModel } = createHandler(AccessPolicyUsersHandler, 'domainAdmin', {
      query: { group: 'class-1' },
    });
    policyModel.list.mockImplementation(async (_domainId: string, scope: string) => (scope === 'group'
      ? [{ scope: 'group', target: 'class-1', enabled: true, dailyTokenLimit: 3000 }]
      : [{ scope: 'user', target: 43, enabled: false }]));
    tokenUsageModel.getUsersDailyUsage.mockResolvedValue(new Map([[42, { totalTokens: 1200, requestCount: 4 }]]));

    await handler.get();

    const { users, total } = handler.response.body;
    expect(total).toBe(2);
    expect(tokenUsageModel.getUsersDailyUsage).toHaveBeenCalledWith('d1', [42, 43], expect.any(String));
    expect(users[0]).toMatchObject({
      uid: 42,
      uname: 'alice',
      groups: ['class-1'],
      usage: { totalTokens: 1200, requestCount: 4 },
      effective: { enabled: true, dailyTokenLimit: 3000, dailyTokenLimitSource: 'group', rateLimitPerMinute: 6 },
    });
    expect(users[1]).toMatchObject({
      uid: 43,
      effective: { enabled: false, enabledSource: 'user', dailyTokenLimit: 3000 },
    });
  });
});

describe('AccessPolicyGroupsHandler', () => {
  it('lists Hydro groups with their policies and surfaces orphaned group policies', async () => {
    mockHydroCollections({ groups: [{ name: 'class-1', uids: [42, 43] }] });
    const { handler, policyModel } = createHandler(AccessPolicyGroupsHandler, 'domainAdmin');
    policyModel.list.mockResolvedValue([
      { scope: 'group', target: 'class-1', enabled: false },
      { scope: 'group', target: 'deleted-group', enabled: true },
    ]);

    await handler.get();

    expect(handler.response.body.groups).toEqual([
      expect.objectContaining({ name: 'class-1', memberCount: 2, policy: expect.objectContaining({ enabled: false }) }),
    ]);
    expect(handler.response.body.orphanPolicies).toEqual([expect.objectContaining({ target: 'deleted-group' })]);
  });
});
