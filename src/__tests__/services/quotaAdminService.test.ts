import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { AuditLogModel } from '../../models/auditLog';
import { QuotaGroupModel } from '../../models/quotaGroup';
import { QuotaOverrideModel } from '../../models/quotaOverride';
import { AuditService } from '../../services/auditService';
import { GroupServiceError } from '../../services/hydroGroupService';
import { QuotaAdminService } from '../../services/quotaAdminService';
import { QuotaGroupResolver } from '../../services/quotaGroupResolver';

const NOW = new Date('2026-11-10T08:00:00Z');

function setupQuotaAdmin() {
  const db = createFakeDb({
    user: createFakeCollection([
      { _id: 0, uname: 'Guest', priv: 0 },
      { _id: 1, uname: 'Hydro', priv: 1 },
      { _id: 2, uname: 'admin', priv: 3 },
      { _id: 1031, uname: '2301张三', priv: 1 },
      { _id: 1032, uname: '2301李四', priv: 1 },
      { _id: 1066, uname: '2303王十一', priv: 1 },
    ]),
    domain: createFakeCollection([{ _id: 'oi2023', name: '信息学 2023' }, { _id: 'oi2024', name: '信息学 2024' }]),
    'user.group': createFakeCollection([{ domainId: 'oi2023', name: '信息学竞赛队', uids: [1031, 1040, 1041] }]),
    ai_quota_groups: createFakeCollection(),
    ai_quota_overrides: createFakeCollection(),
    ai_audit_logs: createFakeCollection(),
  });
  const groups = new QuotaGroupModel(db as any);
  const overrides = new QuotaOverrideModel(db as any);
  const resolver = new QuotaGroupResolver(db as any, groups, overrides, { broadcast: jest.fn() });
  jest.spyOn(resolver, 'invalidate');
  const audit = new AuditService(new AuditLogModel(db as any));
  const service = new QuotaAdminService(db as any, groups, overrides, resolver, audit, () => NOW);
  return { db, groups, overrides, resolver, audit, service, auditDocs: db.store.ai_audit_logs.docs };
}

async function expectError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toEqual(expect.objectContaining({ code }));
  await promise.catch((err) => expect(err).toBeInstanceOf(GroupServiceError));
}

describe('QuotaAdminService groups', () => {
  it('validates type and count: grant ≥ 1, cap ≥ 0, both ≤ 100000', async () => {
    const { service } = setupQuotaAdmin();
    await expectError(service.createGroup({ name: 'A', mode: 'grant', dailyLimit: 0 }, 2), 'INVALID_QUOTA_LIMIT');
    await expectError(service.createGroup({ name: 'A', mode: 'cap', dailyLimit: -1 }, 2), 'INVALID_QUOTA_LIMIT');
    await expectError(service.createGroup({ name: 'A', mode: 'cap', dailyLimit: 100001 }, 2), 'INVALID_QUOTA_LIMIT');
    await expectError(service.createGroup({ name: 'A', mode: 'cap', dailyLimit: 2.5 }, 2), 'INVALID_QUOTA_LIMIT');
    await expectError(service.createGroup({ name: 'A', mode: 'other', dailyLimit: 5 }, 2), 'INVALID_QUOTA_GROUP_MODE');
    await expectError(service.createGroup({ name: '  ', mode: 'cap', dailyLimit: 5 }, 2), 'INVALID_QUOTA_GROUP_NAME');
    await expectError(service.createGroup({ name: 'x'.repeat(33), mode: 'cap', dailyLimit: 5 }, 2), 'INVALID_QUOTA_GROUP_NAME');
    await expect(service.createGroup({ name: ' 考试周暂停 ', mode: 'cap', dailyLimit: 0, enabled: false }, 2))
      .resolves.toEqual(expect.objectContaining({ name: '考试周暂停', mode: 'cap', dailyLimit: 0, enabled: false }));
    await expectError(service.createGroup({ name: '考试周暂停', mode: 'grant', dailyLimit: 5 }, 2), 'QUOTA_GROUP_NAME_TAKEN');
  });

  it('audits create / update / delete and invalidates the resolver cache', async () => {
    const { service, resolver, auditDocs } = setupQuotaAdmin();
    const group = await service.createGroup({ name: '竞赛队', mode: 'grant', dailyLimit: 60 }, 2);
    expect(resolver.invalidate).toHaveBeenCalledTimes(1);

    const updated = await service.updateGroup(group.id, { dailyLimit: 80, enabled: false }, 2);
    expect(updated).toEqual(expect.objectContaining({ dailyLimit: 80, enabled: false }));
    // 改类型时按新类型校验原次数
    await expect(service.updateGroup(group.id, { mode: 'cap' }, 2)).resolves.toEqual(expect.objectContaining({ mode: 'cap', dailyLimit: 80 }));
    // 没有变化不记审计
    await service.updateGroup(group.id, { dailyLimit: 80 }, 2);

    await expect(service.deleteGroup(group.id, 2)).resolves.toEqual({ deleted: group.id });
    await expectError(service.deleteGroup(group.id, 2), 'QUOTA_GROUP_NOT_FOUND');
    await expectError(service.updateGroup('bad-id', { dailyLimit: 1 }, 2), 'QUOTA_GROUP_NOT_FOUND');

    expect(auditDocs.map((doc) => doc.action)).toEqual([
      'quota.group_create', 'quota.group_update', 'quota.group_update', 'quota.group_delete',
    ]);
    expect(auditDocs[1]).toEqual(expect.objectContaining({
      actorUid: 2,
      category: 'quota',
      target: { type: 'quota_group', id: group.id, label: '竞赛队' },
      detail: { before: { dailyLimit: 60, enabled: true }, after: { dailyLimit: 80, enabled: false } },
      undoable: false,
    }));
    expect(resolver.invalidate).toHaveBeenCalledTimes(4);
  });

  it('adds only real users (not guest or built-in accounts) and reports what changed', async () => {
    const { service, auditDocs } = setupQuotaAdmin();
    const group = await service.createGroup({ name: '竞赛队', mode: 'grant', dailyLimit: 60 }, 2);
    await expect(service.changeMembers(group.id, 'add', [1031, 1032, 9999], 2))
      .resolves.toEqual({ changed: [1031, 1032], unchanged: [], missing: [9999] });
    await expect(service.changeMembers(group.id, 'add', [1031], 2))
      .resolves.toEqual({ changed: [], unchanged: [1031], missing: [] });
    await expectError(service.changeMembers(group.id, 'add', [1], 2), 'INVALID_UIDS');
    await expect(service.changeMembers(group.id, 'remove', [1032], 2))
      .resolves.toEqual({ changed: [1032], unchanged: [], missing: [] });
    await expectError(service.changeMembers(group.id, 'move', [1031], 2), 'INVALID_ACTION');
    await expectError(service.changeMembers(group.id, 'add', Array.from({ length: 501 }, (_, i) => 2000 + i), 2), 'TOO_MANY_USERS');

    expect(auditDocs.filter((doc) => doc.action.startsWith('quota.group_member')).map((doc) => [doc.action, doc.detail]))
      .toEqual([['quota.group_member_add', { added: [1031, 1032] }], ['quota.group_member_remove', { removed: [1032] }]]);
  });

  it('links only existing Hydro groups and can unlink stale links', async () => {
    const { service, groups, auditDocs } = setupQuotaAdmin();
    const group = await service.createGroup({ name: '竞赛队', mode: 'grant', dailyLimit: 60 }, 2);
    await expectError(service.link(group.id, { domainId: 'oi2023', name: '不存在' }, 2), 'HYDRO_GROUP_NOT_FOUND');
    await expectError(service.link(group.id, { domainId: '', name: 'x' }, 2), 'INVALID_LINK');
    await expect(service.link(group.id, { domainId: 'oi2023', name: '信息学竞赛队' }, 2)).resolves.toEqual({ linked: true });
    await expect(service.link(group.id, { domainId: 'oi2023', name: '信息学竞赛队' }, 2)).resolves.toEqual({ linked: false });

    // 关联失效（Hydro 侧删除）后仍可取消
    await groups.link((await groups.list())[0]._id, { domainId: 'oi2024', name: '已删除' });
    const { groups: views } = await service.listGroups();
    expect(views[0]).toEqual(expect.objectContaining({
      directCount: 0,
      linkedOnlyCount: 3,
      totalCount: 3,
      linkedGroups: [
        { domainId: 'oi2023', domainName: '信息学 2023', name: '信息学竞赛队', exists: true, memberCount: 3 },
        { domainId: 'oi2024', domainName: '信息学 2024', name: '已删除', exists: false, memberCount: 0 },
      ],
    }));
    await expect(service.unlink(group.id, { domainId: 'oi2024', name: '已删除' }, 2)).resolves.toEqual({ unlinked: true });
    expect(auditDocs.map((doc) => doc.action)).toEqual(['quota.group_create', 'quota.group_link', 'quota.group_unlink']);
  });

  it('counts direct members once when they are also in a linked group', async () => {
    const { service } = setupQuotaAdmin();
    const group = await service.createGroup({ name: '竞赛队', mode: 'grant', dailyLimit: 60 }, 2);
    await service.changeMembers(group.id, 'add', [1031, 1066], 2);
    await service.link(group.id, { domainId: 'oi2023', name: '信息学竞赛队' }, 2);
    const detail = await service.groupDetail(group.id);
    expect(detail.group).toEqual(expect.objectContaining({ directCount: 2, linkedOnlyCount: 2, totalCount: 4 }));
    expect(detail.direct).toEqual([{ uid: 1031, uname: '2301张三' }, { uid: 1066, uname: '2303王十一' }]);
  });
});

describe('QuotaAdminService overrides', () => {
  it('requires a reason, a valid count and a future expiry within a year', async () => {
    const { service } = setupQuotaAdmin();
    await expectError(service.setOverrides([1031], { mode: 'limit', dailyLimit: 100 }, 2), 'REASON_REQUIRED');
    await expectError(service.setOverrides([1031], { mode: 'limit', dailyLimit: 100, reason: '   ' }, 2), 'REASON_REQUIRED');
    await expectError(service.setOverrides([1031], { mode: 'limit', dailyLimit: 0, reason: 'r' }, 2), 'INVALID_QUOTA_LIMIT');
    await expectError(service.setOverrides([1031], { mode: 'pause', reason: 'r' }, 2), 'INVALID_OVERRIDE_MODE');
    await expectError(service.setOverrides([1031], { mode: 'disabled', reason: 'r', expiresAt: '2026-11-09T00:00:00Z' }, 2), 'INVALID_EXPIRES_AT');
    await expectError(service.setOverrides([1031], { mode: 'disabled', reason: 'r', expiresAt: '2028-01-01T00:00:00Z' }, 2), 'INVALID_EXPIRES_AT');
    await expectError(service.setOverrides([1031], { mode: 'disabled', reason: 'r', expiresAt: 'soon' }, 2), 'INVALID_EXPIRES_AT');
    await expectError(service.setOverrides([1031], { mode: 'disabled', reason: 'x'.repeat(201) }, 2), 'REASON_TOO_LONG');
  });

  it('sets and clears overrides in batch with one audit record each', async () => {
    const { service, auditDocs, resolver } = setupQuotaAdmin();
    await expect(service.setOverrides([1066, 9999], {
      mode: 'limit', dailyLimit: 100, expiresAt: '2026-11-17T08:00:00Z', reason: '准备省赛',
    }, 2)).resolves.toEqual({ updated: [1066], missing: [9999] });
    await service.setOverrides([1066, 1032], { mode: 'disabled', reason: '家长要求暂停使用' }, 2);

    const listed = await service.listOverrides();
    expect(listed.total).toBe(2);
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ uid: 1066, uname: '2303王十一', mode: 'disabled', reason: '家长要求暂停使用', setByName: 'admin' }),
    ]));
    expect(listed.items.find((item) => item.uid === 1066)?.expiresAt).toBeUndefined();

    await expect(service.clearOverrides([1066, 1031], 2)).resolves.toEqual({ cleared: [1066] });
    expect(auditDocs.map((doc) => doc.action)).toEqual(['quota.override_set', 'quota.override_set', 'quota.override_clear']);
    expect(auditDocs[1]).toEqual(expect.objectContaining({
      target: { type: 'user', id: 'batch:2', label: '2303王十一, 2301李四' },
      detail: expect.objectContaining({
        uids: [1066, 1032],
        mode: 'disabled',
        before: [{ uid: 1066, previous: expect.objectContaining({ mode: 'limit', dailyLimit: 100, reason: '准备省赛' }) }],
      }),
    }));
    expect(auditDocs[2].target).toEqual({ type: 'user', id: '1066', label: '2303王十一' });
    // 个人覆盖不缓存，无需失效
    expect(resolver.invalidate).not.toHaveBeenCalled();
  });
});
