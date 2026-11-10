import { PRIV } from 'hydrooj';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { AuditLogModel } from '../../models/auditLog';
import { QuotaGroupModel } from '../../models/quotaGroup';
import { QuotaOverrideModel } from '../../models/quotaOverride';
import { AuditService } from '../../services/auditService';
import { QuotaAdminService } from '../../services/quotaAdminService';
import { QuotaGroupResolver } from '../../services/quotaGroupResolver';
import { CreditEventModel } from '../../models/creditEvent';
import { CreditService } from '../../services/creditService';
import {
  CreditResetHandler,
  QuotaAdminHandlerPriv,
  QuotaGroupDetailHandler,
  QuotaGroupsHandler,
  QuotaOverridesHandler,
} from '../../handlers/quotaAdminHandler';

function setup() {
  const db = createFakeDb({
    user: createFakeCollection([
      { _id: 2, uname: 'admin', priv: 3 },
      { _id: 1031, uname: '2301张三', priv: 1 },
    ]),
    domain: createFakeCollection([{ _id: 'oi2023', name: '信息学 2023' }]),
    'user.group': createFakeCollection([{ domainId: 'oi2023', name: '信息学竞赛队', uids: [1031] }]),
  });
  const groups = new QuotaGroupModel(db as any);
  const overrides = new QuotaOverrideModel(db as any);
  const resolver = new QuotaGroupResolver(db as any, groups, overrides, { broadcast: jest.fn() });
  const audit = new AuditService(new AuditLogModel(db as any));
  const service = new QuotaAdminService(db as any, groups, overrides, resolver, audit);
  const credit = new CreditService(db as any, new CreditEventModel(db as any), { getConfig: jest.fn().mockResolvedValue(null) }, audit);
  return { db, service, credit };
}

function makeHandler<T extends { request: any; response: any; ctx: any; user?: any }>(
  HandlerClass: new () => T,
  env: ReturnType<typeof setup>,
  options: { body?: any; query?: any; csrf?: boolean; admin?: boolean } = {},
): T {
  const handler = new HandlerClass();
  handler.request = {
    headers: options.csrf === false ? {} : { 'x-requested-with': 'XMLHttpRequest' },
    body: options.body || {},
    query: options.query || {},
  };
  handler.response = {};
  handler.user = {
    _id: 2,
    hasPriv: (priv: number) => (options.admin === false ? false : priv === PRIV.PRIV_EDIT_SYSTEM),
  };
  (handler as any).translate = (key: string) => key;
  const services: Record<string, unknown> = { quotaAdminService: env.service, creditService: env.credit };
  handler.ctx = { get: (name: string) => services[name] };
  return handler;
}

describe('credit reset handler (FR-032)', () => {
  it('is system-admin only and requires the CSRF header', async () => {
    const env = setup();
    const denied = makeHandler(CreditResetHandler, env, { admin: false, body: { uids: [1031], reason: '误判' } });
    await denied.post();
    expect(denied.response.status).toBe(403);
    const noCsrf = makeHandler(CreditResetHandler, env, { csrf: false, body: { uids: [1031], reason: '误判' } });
    await noCsrf.post();
    expect(noCsrf.response.status).toBe(403);
    expect(env.db.store.ai_credit_events?.docs || []).toHaveLength(0);
  });

  it('requires a reason, then resets and audits', async () => {
    const env = setup();
    const missing = makeHandler(CreditResetHandler, env, { body: { uids: [1031], reason: '' } });
    await missing.post();
    expect(missing.response.status).toBe(400);
    expect(missing.response.body).toEqual({ error: 'ai_helper_credit_reason_required', code: 'REASON_REQUIRED' });

    const ok = makeHandler(CreditResetHandler, env, { body: { uids: [1031], reason: '误判较多，已沟通' } });
    await ok.post();
    expect(ok.response.body).toEqual({ success: true, reset: [1031], missing: [] });
    expect(env.db.store.ai_audit_logs.docs).toEqual([expect.objectContaining({ action: 'credit.reset', actorUid: 2 })]);
  });
});

describe('quota admin handlers', () => {
  it('registers routes with system-admin privilege', () => {
    expect(QuotaAdminHandlerPriv).toBe(PRIV.PRIV_EDIT_SYSTEM);
  });

  it('rejects non-system-admins on every endpoint (scenario 8)', async () => {
    const env = setup();
    const cases: Array<[any, 'get' | 'post']> = [
      [QuotaGroupsHandler, 'get'], [QuotaGroupsHandler, 'post'], [QuotaGroupDetailHandler, 'get'],
      [QuotaOverridesHandler, 'get'], [QuotaOverridesHandler, 'post'],
    ];
    for (const [HandlerClass, method] of cases) {
      const handler = makeHandler(HandlerClass, env, { admin: false, body: { action: 'create', name: 'x', mode: 'grant', dailyLimit: 5 } });
      await handler[method]();
      expect(handler.response.status).toBe(403);
      expect(handler.response.body.code).toBe('SYSTEM_ADMIN_REQUIRED');
    }
    expect(env.db.store.ai_quota_groups?.docs || []).toHaveLength(0);
  });

  it('rejects POST requests without the CSRF header', async () => {
    const env = setup();
    const handler = makeHandler(QuotaGroupsHandler, env, { csrf: false, body: { action: 'create', name: 'x', mode: 'grant', dailyLimit: 5 } });
    await handler.post();
    expect(handler.response.status).toBe(403);
  });

  it('creates, links, lists and updates a group through the action dispatcher', async () => {
    const env = setup();
    const create = makeHandler(QuotaGroupsHandler, env, { body: { action: 'create', name: '竞赛队', mode: 'grant', dailyLimit: 60 } });
    await create.post();
    expect(create.response.body).toEqual({ success: true, group: expect.objectContaining({ name: '竞赛队', enabled: true }) });
    const id = create.response.body.group.id;

    const link = makeHandler(QuotaGroupsHandler, env, { body: { action: 'link', id, link: { domainId: 'oi2023', name: '信息学竞赛队' } } });
    await link.post();
    expect(link.response.body).toEqual({ success: true, linked: true });

    const members = makeHandler(QuotaGroupsHandler, env, { body: { action: 'members', id, op: 'add', uids: [1031] } });
    await members.post();
    expect(members.response.body).toEqual({ success: true, changed: [1031], unchanged: [], missing: [] });

    const toggle = makeHandler(QuotaGroupsHandler, env, { body: { action: 'update', id, enabled: false } });
    await toggle.post();
    expect(toggle.response.body.group.enabled).toBe(false);

    const list = makeHandler(QuotaGroupsHandler, env);
    await list.get();
    expect(list.response.body).toEqual({
      groups: [expect.objectContaining({ name: '竞赛队', directCount: 1, linkedOnlyCount: 0, totalCount: 1, enabled: false })],
      domains: [{ id: 'oi2023', name: '信息学 2023' }],
    });

    const detail = makeHandler(QuotaGroupDetailHandler, env, { query: { id } });
    await detail.get();
    expect(detail.response.body.direct).toEqual([{ uid: 1031, uname: '2301张三' }]);
  });

  it('maps validation errors to 4xx with an error code', async () => {
    const env = setup();
    const grantZero = makeHandler(QuotaGroupsHandler, env, { body: { action: 'create', name: 'A', mode: 'grant', dailyLimit: 0 } });
    await grantZero.post();
    expect(grantZero.response.status).toBe(400);
    expect(grantZero.response.body).toEqual({ error: 'ai_helper_quota_group_limit_grant_invalid', code: 'INVALID_QUOTA_LIMIT' });

    const unknown = makeHandler(QuotaGroupsHandler, env, { body: { action: 'explode' } });
    await unknown.post();
    expect(unknown.response.body.code).toBe('INVALID_ACTION');

    const missing = makeHandler(QuotaGroupDetailHandler, env, { query: { id: '64b7f0c2a1b2c3d4e5f60718' } });
    await missing.get();
    expect(missing.response.status).toBe(404);

    const link = makeHandler(QuotaGroupsHandler, env, { body: { action: 'link', id: 'x', link: { domainId: 'oi2023', name: 'g' } } });
    await link.post();
    expect(link.response.body.code).toBe('QUOTA_GROUP_NOT_FOUND');
  });

  it('requires a reason for overrides and lists them', async () => {
    const env = setup();
    const noReason = makeHandler(QuotaOverridesHandler, env, { body: { action: 'set', uids: [1031], mode: 'disabled' } });
    await noReason.post();
    expect(noReason.response.status).toBe(400);
    expect(noReason.response.body.code).toBe('REASON_REQUIRED');

    const set = makeHandler(QuotaOverridesHandler, env, { body: { action: 'set', uids: [1031], mode: 'limit', dailyLimit: 100, reason: '准备省赛' } });
    await set.post();
    expect(set.response.body).toEqual({ success: true, updated: [1031], missing: [] });

    const list = makeHandler(QuotaOverridesHandler, env);
    await list.get();
    expect(list.response.body).toEqual({ total: 1, items: [expect.objectContaining({ uid: 1031, dailyLimit: 100, reason: '准备省赛' })] });

    const clear = makeHandler(QuotaOverridesHandler, env, { body: { action: 'clear', uids: [1031] } });
    await clear.post();
    expect(clear.response.body).toEqual({ success: true, cleared: [1031] });
  });

  it('returns a generic 500 for unexpected errors', async () => {
    const env = setup();
    jest.spyOn(env.service, 'listGroups').mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = makeHandler(QuotaGroupsHandler, env);
    await handler.get();
    expect(handler.response.status).toBe(500);
    expect(handler.response.body).toEqual({ error: 'ai_helper_quota_groups_failed', code: 'QUOTA_GROUPS_FAILED' });
    error.mockRestore();
  });
});
