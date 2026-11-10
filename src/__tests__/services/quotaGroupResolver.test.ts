import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { QuotaGroupModel } from '../../models/quotaGroup';
import { QuotaOverrideModel } from '../../models/quotaOverride';
import { QUOTA_CACHE_EVENT, QuotaGroupResolver } from '../../services/quotaGroupResolver';

function setup() {
  const groupsColl = createFakeCollection();
  const hydroGroups = createFakeCollection([
    { domainId: 'oi2023', name: '信息学竞赛队', uids: [1031, 1032, 1040] },
    { domainId: 'oi2024', name: '助教', uids: [1102] },
  ]);
  const db = createFakeDb({ ai_quota_groups: groupsColl, 'user.group': hydroGroups, ai_quota_overrides: createFakeCollection() });
  const groups = new QuotaGroupModel(db as any);
  const overrides = new QuotaOverrideModel(db as any);
  let now = new Date('2026-11-10T08:00:00Z');
  const ctx = { broadcast: jest.fn() };
  const resolver = new QuotaGroupResolver(db as any, groups, overrides, ctx, () => now);
  return {
    db, groups, overrides, resolver, ctx, groupsColl, hydroGroups,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

describe('QuotaGroupResolver', () => {
  it('unions direct members and current members of linked Hydro groups', async () => {
    const { groups, resolver } = setup();
    const team = await groups.create({ name: '竞赛队', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await groups.addMembers(team._id, [1031]);
    await groups.link(team._id, { domainId: 'oi2023', name: '信息学竞赛队' });
    const paused = await groups.create({ name: '考试周暂停', mode: 'cap', dailyLimit: 0, enabled: false, createdBy: 2 });
    await groups.addMembers(paused._id, [1031]);

    const memberships = await resolver.getGroupMemberships(1031);
    expect(memberships).toEqual([
      expect.objectContaining({
        name: '竞赛队',
        mode: 'grant',
        enabled: true,
        via: [{ kind: 'direct' }, { kind: 'linked', domainId: 'oi2023', name: '信息学竞赛队' }],
      }),
      // 停用的组仍会列出（管理端说明用），由调用方决定是否参与计算
      expect.objectContaining({ name: '考试周暂停', enabled: false }),
    ]);
    await expect(resolver.getGroupMemberships(1040)).resolves.toEqual([
      expect.objectContaining({ name: '竞赛队', via: [{ kind: 'linked', domainId: 'oi2023', name: '信息学竞赛队' }] }),
    ]);
    await expect(resolver.getGroupMemberships(9999)).resolves.toEqual([]);
    expect([...(await resolver.membersOf(String(team._id)))!].sort()).toEqual([1031, 1032, 1040]);
    await expect(resolver.membersOf('64b7f0c2a1b2c3d4e5f60718')).resolves.toBeNull();
  });

  it('marks links whose Hydro group was deleted and lists zero-cap members of enabled groups only', async () => {
    const { groups, resolver } = setup();
    const stop = await groups.create({ name: '观察名单', mode: 'cap', dailyLimit: 0, enabled: true, createdBy: 2 });
    await groups.addMembers(stop._id, [1061]);
    await groups.link(stop._id, { domainId: 'oi2023', name: '已删除的组' });
    const paused = await groups.create({ name: '暂停', mode: 'cap', dailyLimit: 0, enabled: false, createdBy: 2 });
    await groups.addMembers(paused._id, [1062]);

    const snapshot = (await resolver.snapshot()).find((group) => group.name === '观察名单')!;
    expect(snapshot.linked).toEqual([expect.objectContaining({ name: '已删除的组', exists: false })]);
    expect([...(await resolver.zeroCapMembers())]).toEqual([1061]);
  });

  it('caches for 60 seconds and coalesces concurrent loads', async () => {
    const { groups, resolver, groupsColl, hydroGroups, advance } = setup();
    const team = await groups.create({ name: '竞赛队', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await groups.link(team._id, { domainId: 'oi2023', name: '信息学竞赛队' });
    groupsColl.find.mockClear();

    await Promise.all([resolver.snapshot(), resolver.snapshot(), resolver.getGroupMemberships(1031)]);
    expect(groupsColl.find).toHaveBeenCalledTimes(1);
    expect(hydroGroups.find).toHaveBeenCalledTimes(1);

    // Hydro 原生页面改组：缓存期内看不到，60 秒后生效
    hydroGroups.docs[0].uids.push(1050);
    advance(59 * 1000);
    await expect(resolver.getGroupMemberships(1050)).resolves.toEqual([]);
    advance(2 * 1000);
    await expect(resolver.getGroupMemberships(1050)).resolves.toHaveLength(1);
    expect(groupsColl.find).toHaveBeenCalledTimes(2);
  });

  it('invalidates locally and broadcasts to other processes; listens for their broadcasts', async () => {
    const { groups, resolver, groupsColl, ctx } = setup();
    await resolver.snapshot();
    resolver.invalidate();
    expect(ctx.broadcast).toHaveBeenCalledWith(QUOTA_CACHE_EVENT);

    const team = await groups.create({ name: '竞赛队', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await groups.addMembers(team._id, [1031]);
    await expect(resolver.getGroupMemberships(1031)).resolves.toHaveLength(1);

    const listeners: Record<string, () => void> = {};
    resolver.listen({ on: (event: string, listener: () => void) => { listeners[event] = listener; } });
    await groups.removeMembers(team._id, [1031]);
    await expect(resolver.getGroupMemberships(1031)).resolves.toHaveLength(1); // 仍是缓存
    listeners[QUOTA_CACHE_EVENT]();
    await expect(resolver.getGroupMemberships(1031)).resolves.toEqual([]);
    expect(groupsColl.find).toHaveBeenCalled();
  });

  it('does not cache a load that raced with an invalidation', async () => {
    const { groups, resolver } = setup();
    const pending = resolver.snapshot();
    resolver.invalidateLocal();
    const team = await groups.create({ name: '竞赛队', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await groups.addMembers(team._id, [1031]);
    await pending;
    await expect(resolver.getGroupMemberships(1031)).resolves.toHaveLength(1);
  });

  it('survives a failing broadcast', () => {
    const { resolver, ctx } = setup();
    ctx.broadcast.mockImplementation(() => { throw new Error('bus down'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => resolver.invalidate()).not.toThrow();
    warn.mockRestore();
  });

  it('reads overrides per request without caching', async () => {
    const { overrides, resolver } = setup();
    await overrides.set(1031, { mode: 'disabled', reason: 'r', setBy: 2, setAt: new Date() });
    await expect(resolver.getOverride(1031)).resolves.toEqual(expect.objectContaining({ mode: 'disabled' }));
    await overrides.clear(1031);
    await expect(resolver.getOverride(1031)).resolves.toBeNull();
    await expect(resolver.getOverrides([1031, 1032])).resolves.toEqual(new Map());
  });
});
