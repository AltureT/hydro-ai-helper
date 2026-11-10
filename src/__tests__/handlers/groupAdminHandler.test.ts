jest.mock('../../lib/rateLimitHelper', () => ({
  applyRateLimit: jest.fn().mockResolvedValue(false),
}));

import { DomainModel, PRIV } from 'hydrooj';
import { setHydroMode } from '../__mocks__/hydrooj';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { AuditLogModel } from '../../models/auditLog';
import { GroupMetaModel } from '../../models/groupMeta';
import { AuditService } from '../../services/auditService';
import { HydroGroupService } from '../../services/hydroGroupService';
import {
  GroupAdminHandlerPriv,
  GroupApplyHandler,
  GroupListHandler,
  GroupMetaHandler,
  GroupSearchHandler,
  GroupUndoHandler,
} from '../../handlers/groupAdminHandler';
import { AuditListHandler, AuditListHandlerPriv, parseAuditFilters } from '../../handlers/auditHandler';
import { applyRateLimit } from '../../lib/rateLimitHelper';

function setupService() {
  setHydroMode('v4');
  const db = createFakeDb({
    user: createFakeCollection([
      { _id: 2, uname: 'admin', unameLower: 'admin', priv: 3 },
      { _id: 1031, uname: '2301张三', unameLower: '2301张三', priv: 1 },
      { _id: 1032, uname: '2301李四', unameLower: '2301李四', priv: 1 },
      { _id: 1034, uname: '2301赵六', unameLower: '2301赵六', priv: 1 },
    ]),
    'domain.user': createFakeCollection([
      { domainId: 'oi2023', uid: 1031, role: 'student' },
      { domainId: 'oi2023', uid: 1032, role: 'student' },
    ]),
    domain: createFakeCollection([{ _id: 'oi2023', name: '信息学 2023' }]),
    'user.group': createFakeCollection([]),
  });
  DomainModel.get.mockResolvedValue({ _id: 'oi2023', name: '信息学 2023', roles: { student: '4' }, _join: { role: 'student' } });
  const auditService = new AuditService(new AuditLogModel(db as any));
  const service = new HydroGroupService(db as any, new GroupMetaModel(db as any), auditService, { broadcast: jest.fn() });
  return { db, service, auditService };
}

function makeHandler<T extends { request: any; response: any; ctx: any; user?: any; args?: any; translate?: any }>(
  HandlerClass: new () => T,
  env: ReturnType<typeof setupService>,
  options: { body?: any; query?: any; csrf?: boolean; admin?: boolean } = {},
): T {
  const handler = new HandlerClass();
  handler.request = {
    headers: options.csrf === false ? {} : { 'x-requested-with': 'XMLHttpRequest' },
    body: options.body || {},
    query: options.query || {},
  };
  handler.response = {};
  handler.args = { domainId: 'oi2023' };
  handler.user = {
    _id: 2,
    hasPriv: (priv: number) => (options.admin === false ? false : priv === PRIV.PRIV_EDIT_SYSTEM),
  };
  (handler as any).translate = (key: string) => key;
  (handler as any).limitRate = jest.fn();
  handler.ctx = {
    db: env.db,
    get: (name: string) => ({ hydroGroupService: env.service, auditService: env.auditService } as any)[name],
  };
  return handler;
}

describe('group admin handlers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers every route with system-admin privilege', () => {
    expect(GroupAdminHandlerPriv).toBe(PRIV.PRIV_EDIT_SYSTEM);
    expect(AuditListHandlerPriv).toBe(PRIV.PRIV_EDIT_SYSTEM);
  });

  it('rejects POST requests without the CSRF header', async () => {
    const env = setupService();
    const handler = makeHandler(GroupApplyHandler, env, {
      csrf: false, body: { groupName: 'G', action: 'add', uids: [1031] },
    });
    await handler.post();
    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CSRF_REJECTED');
    expect(env.db.store['user.group'].docs).toEqual([]);
  });

  it('rejects users without system privilege even if the route check is bypassed', async () => {
    const env = setupService();
    const list = makeHandler(GroupListHandler, env, { admin: false });
    await list.get();
    expect(list.response.status).toBe(403);
    expect(list.response.body.code).toBe('SYSTEM_ADMIN_REQUIRED');

    const apply = makeHandler(GroupApplyHandler, env, { admin: false, body: { groupName: 'G', action: 'add', uids: [1031] } });
    await apply.post();
    expect(apply.response.status).toBe(403);
    expect(env.db.store['user.group'].docs).toEqual([]);

    const audit = makeHandler(AuditListHandler, env, { admin: false });
    await audit.get();
    expect(audit.response.status).toBe(403);
  });

  it.each([
    ['2301', 'ai_helper_group_name_err_numeric'],
    ['1班,2班', 'ai_helper_group_name_err_comma'],
    ['', 'ai_helper_group_name_err_empty'],
  ])('rejects group name %j', async (groupName, errorKey) => {
    const env = setupService();
    const handler = makeHandler(GroupApplyHandler, env, { body: { groupName, action: 'add', uids: [1031] } });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body).toEqual({ error: errorKey, code: 'INVALID_GROUP_NAME' });
  });

  it('rejects more than 500 users', async () => {
    const env = setupService();
    const uids = Array.from({ length: 501 }, (_, i) => 3000 + i);
    const handler = makeHandler(GroupApplyHandler, env, { body: { groupName: 'G', action: 'add', uids } });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('TOO_MANY_USERS');
  });

  it('validates the join role and joins non-members with an allowed one', async () => {
    const env = setupService();
    const bad = makeHandler(GroupApplyHandler, env, {
      body: { groupName: 'G', action: 'add', uids: [1034], joinDomain: { role: 'guest' } },
    });
    await bad.post();
    expect(bad.response.status).toBe(400);
    expect(bad.response.body.code).toBe('INVALID_JOIN_ROLE');

    const good = makeHandler(GroupApplyHandler, env, {
      body: { groupName: 'G', action: 'add', uids: [1031, 1034], joinDomain: { role: 'student' } },
    });
    await good.post();
    expect(good.response.status).toBeUndefined();
    expect(good.response.body).toEqual(expect.objectContaining({ added: [1031, 1034], joined: [1034] }));
    expect(DomainModel.setUserRole).toHaveBeenCalledWith('oi2023', 1034, 'student');
  });

  it('undo reverts only the changes made by that operation', async () => {
    const env = setupService();
    const add = makeHandler(GroupApplyHandler, env, { body: { groupName: 'G', action: 'add', uids: [1031] } });
    await add.post();
    env.db.store['user.group'].docs[0].uids.push(1032);

    const undo = makeHandler(GroupUndoHandler, env, { body: { auditId: add.response.body.auditId } });
    await undo.post();
    expect(undo.response.body).toEqual({ success: true, reverted: { removed: [1031], left: [] } });
    expect(env.db.store['user.group'].docs[0].uids).toEqual([1032]);

    const again = makeHandler(GroupUndoHandler, env, { body: { auditId: add.response.body.auditId } });
    await again.post();
    expect(again.response.status).toBe(409);
    expect(again.response.body.code).toBe('UNDO_NOT_ALLOWED');
  });

  it('search applies rate limiting and returns preview rows', async () => {
    const env = setupService();
    const handler = makeHandler(GroupSearchHandler, env, { body: { mode: 'prefix', query: '2301', scope: 'all' } });
    await handler.post();
    expect(applyRateLimit).toHaveBeenCalledWith(handler, expect.objectContaining({ op: 'ai_group_search' }));
    expect(handler.response.body.users.map((u: any) => u.uid)).toEqual([1031, 1032, 1034]);
  });

  it('meta handler creates a group and list handler returns it', async () => {
    const env = setupService();
    const meta = makeHandler(GroupMetaHandler, env, { body: { groupName: '2023级1班', create: true, kind: 'class' } });
    await meta.post();
    expect(meta.response.body).toEqual(expect.objectContaining({ success: true, created: true }));

    const list = makeHandler(GroupListHandler, env);
    await list.get();
    expect(list.response.body.groups).toEqual([expect.objectContaining({ name: '2023级1班', existsInHydro: true })]);
  });

  it('returns 500 with a stable code on unexpected errors', async () => {
    const env = setupService();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    env.service.list = jest.fn().mockRejectedValue(new Error('db down'));
    const list = makeHandler(GroupListHandler, env);
    await list.get();
    expect(list.response.status).toBe(500);
    expect(list.response.body.code).toBe('GROUP_LIST_FAILED');
  });
});

describe('audit list handler', () => {
  it('parses filters and rejects invalid ones', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(parseAuditFilters({ category: 'group', actor: 'system', domainId: 'oi2023', days: '7' }, now)).toEqual({
      category: 'group', actorType: 'system', domainId: 'oi2023', from: new Date('2026-11-03T12:00:00Z'),
    });
    expect(parseAuditFilters({ actor: '2', from: '2026-11-01', to: '2026-11-10' }, now)).toEqual({
      actorUid: 2, from: new Date('2026-11-01T00:00:00.000Z'), to: new Date('2026-11-10T23:59:59.999Z'),
    });
    expect(parseAuditFilters({ targetType: 'group', targetId: '2023级1班', domainId: 'oi2023' }, now)).toEqual({
      targetType: 'group', targetId: '2023级1班', domainId: 'oi2023',
    });
    expect(parseAuditFilters({ targetId: 'orphan' }, now)).toBeNull();
    expect(parseAuditFilters({ targetType: 'planet' }, now)).toBeNull();
    expect(parseAuditFilters({ category: 'nope' }, now)).toBeNull();
    expect(parseAuditFilters({ days: '999' }, now)).toBeNull();
    expect(parseAuditFilters({ from: '2026-11-10', to: '2026-11-01' }, now)).toBeNull();
    expect(parseAuditFilters({ actor: 'admin' }, now)).toBeNull();
  });

  it('lists logs with actor, domain and member names', async () => {
    const env = setupService();
    const add = makeHandler(GroupApplyHandler, env, { body: { groupName: 'G', action: 'add', uids: [1031] } });
    await add.post();

    const handler = makeHandler(AuditListHandler, env, { query: { category: 'group' } });
    await handler.get();
    expect(handler.response.body.total).toBe(1);
    expect(handler.response.body.logs[0]).toEqual(expect.objectContaining({
      action: 'group.add',
      actorName: 'admin',
      domainName: '信息学 2023',
      undoable: true,
      uidNames: { 1031: '2301张三' },
    }));

    const bad = makeHandler(AuditListHandler, env, { query: { days: 'abc' } });
    await bad.get();
    expect(bad.response.status).toBe(400);
    expect(bad.response.body.code).toBe('INVALID_AUDIT_FILTER');
  });
});
