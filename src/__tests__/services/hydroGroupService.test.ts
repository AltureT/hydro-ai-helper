import { DomainModel, UserModel } from 'hydrooj';
import { setHydroMode } from '../__mocks__/hydrooj';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { AuditLogModel } from '../../models/auditLog';
import { GroupMetaModel } from '../../models/groupMeta';
import { AuditService } from '../../services/auditService';
import { GroupServiceError, HydroGroupService, snapshotGroupNames } from '../../services/hydroGroupService';

const PERM_EDIT_DOMAIN = 1n << 1n;
const NORMAL = 1; // mock PRIV_USER_PROFILE
const SYSTEM_ADMIN = 1 | 2; // + mock PRIV_EDIT_SYSTEM

function user(_id: number, uname: string, priv = NORMAL) {
  return { _id, uname, unameLower: uname.toLowerCase(), priv };
}

function setup(options: { mode?: 'v4' | 'v5' } = {}) {
  setHydroMode(options.mode || 'v4');
  const joinFlag = options.mode === 'v5';
  const row = (domainId: string, uid: number, role: string, member = true) => (
    joinFlag ? { domainId, uid, role, join: member } : { domainId, uid, role: member ? role : 'default' }
  );
  const db = createFakeDb({
    user: createFakeCollection([
      user(0, 'Guest'),
      user(1, 'Hydro', -1),
      user(1031, '2301张三'),
      user(1032, '2301李四'),
      user(1034, '2301赵六'),
      user(1007, '2301班主任'),
      user(1008, '2301管理员', SYSTEM_ADMIN),
      user(1099, '2301封禁', 0),
      user(1041, '2302王五'),
    ]),
    'domain.user': createFakeCollection([
      row('oi2023', 1031, 'student'),
      row('oi2023', 1032, 'student'),
      row('oi2023', 1034, 'student', false),
      row('oi2023', 1007, 'teacher'),
      row('oi2023', 1008, 'student'),
      row('oi2023', 1041, 'student'),
      row('oi2024', 1031, 'student'),
    ]),
    domain: createFakeCollection([
      { _id: 'oi2023', name: '信息学 2023' },
      { _id: 'oi2024', name: '信息学 2024' },
    ]),
    'user.group': createFakeCollection([
      { domainId: 'oi2023', name: '信息学竞赛队', uids: [1032] },
      { domainId: 'oi2023', name: '1031', uids: [1031] },
    ]),
  });
  DomainModel.get.mockResolvedValue({
    _id: 'oi2023',
    name: '信息学 2023',
    roles: { student: '4', teacher: String(PERM_EDIT_DOMAIN | 4n) },
    _join: { role: 'student' },
  });
  const ctx = { broadcast: jest.fn() };
  const auditService = new AuditService(new AuditLogModel(db as any));
  const groupMeta = new GroupMetaModel(db as any);
  const service = new HydroGroupService(db as any, groupMeta, auditService, ctx);
  return { db, ctx, service, auditService, groupMeta, groups: db.store['user.group'] };
}

async function expectServiceError(promise: Promise<unknown>, code: string, status = 400) {
  await expect(promise).rejects.toBeInstanceOf(GroupServiceError);
  await promise.catch((err: GroupServiceError) => {
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
}

function assertNoUidsSet(groups: ReturnType<typeof createFakeCollection>) {
  const updates = [
    ...groups.findOneAndUpdate.mock.calls.map((call) => call[1]),
    ...groups.updateOne.mock.calls.map((call) => call[1]),
  ];
  for (const update of updates) {
    expect(update.$set?.uids).toBeUndefined();
  }
}

describe('HydroGroupService.search', () => {
  it('prefix search in domain scope uses an anchored unameLower regex and member filter', async () => {
    const { db, service } = setup();
    const result = await service.search('oi2023', 'prefix', '2301', 'domain');

    const [filter, options] = db.store.user.find.mock.calls[0];
    expect(filter.unameLower).toEqual({ $regex: '^2301' });
    expect(filter.priv).toEqual({ $bitsAllSet: NORMAL });
    expect(filter._id.$gt).toBe(1);
    expect(filter._id.$in).toEqual(expect.arrayContaining([1031, 1032, 1007, 1008]));
    expect(filter._id.$in).not.toContain(1034);
    expect(options?.maxTimeMS).toBe(2000);

    expect(result.overflow).toBe(false);
    expect(result.users.map((u) => u.uid).sort()).toEqual([1007, 1008, 1031, 1032]);
    const byUid = new Map(result.users.map((u) => [u.uid, u]));
    expect(byUid.get(1007)).toEqual(expect.objectContaining({ role: 'teacher', isMember: true, isManager: true }));
    expect(byUid.get(1008)?.isManager).toBe(true);
    expect(byUid.get(1031)).toEqual(expect.objectContaining({ role: 'student', isManager: false, groups: [] }));
    expect(byUid.get(1032)?.groups).toEqual(['信息学竞赛队']);
  });

  it('all-domain scope includes non-members, excludes banned users, and lists member domains', async () => {
    const { db, service } = setup();
    const result = await service.search('oi2023', 'prefix', '2301', 'all');
    const byUid = new Map(result.users.map((u) => [u.uid, u]));
    expect(byUid.has(1099)).toBe(false);
    expect(byUid.get(1034)).toEqual(expect.objectContaining({ isMember: false, role: null, domains: [] }));
    expect(byUid.get(1031)?.domains).toEqual(expect.arrayContaining([
      { id: 'oi2023', name: '信息学 2023' },
      { id: 'oi2024', name: '信息学 2024' },
    ]));
    expect(db.store.user.find.mock.results[0].value.limit).toHaveBeenCalledWith(501);
  });

  it('escapes regex metacharacters in prefix mode', async () => {
    const { db, service } = setup();
    await service.search('oi2023', 'prefix', 'a.b(', 'all');
    expect(db.store.user.find.mock.calls[0][0].unameLower).toEqual({ $regex: '^a\\.b\\(' });
  });

  it('validates regex length and syntax', async () => {
    const { service } = setup();
    await expectServiceError(service.search('oi2023', 'regex', 'a'.repeat(65), 'all'), 'QUERY_TOO_LONG');
    await expectServiceError(service.search('oi2023', 'regex', '(', 'all'), 'INVALID_REGEX');
    const ok = await service.search('oi2023', 'regex', '^230[12]', 'all');
    expect(ok.users.length).toBeGreaterThan(0);
  });

  it('matches a pasted list globally and reports unmatched names', async () => {
    const { db, service } = setup();
    const result = await service.search('oi2023', 'list', '2301张三\n2301赵六\r\n不存在的人\n2301张三\n', 'domain');
    expect(db.store.user.find.mock.calls[0][0].unameLower).toEqual({ $in: ['2301张三', '2301赵六', '不存在的人'] });
    expect(result.users.map((u) => u.uid).sort()).toEqual([1031, 1034]);
    expect(result.unmatched).toEqual(['不存在的人']);
  });

  it('rejects lists over 500 names and empty queries', async () => {
    const { service } = setup();
    const names = Array.from({ length: 501 }, (_, i) => `u${i}`).join('\n');
    await expectServiceError(service.search('oi2023', 'list', names, 'all'), 'LIST_TOO_LONG');
    await expectServiceError(service.search('oi2023', 'prefix', '   ', 'all'), 'INVALID_QUERY');
    await expectServiceError(service.search('oi2023', 'fuzzy' as any, 'x', 'all'), 'INVALID_SEARCH_MODE');
  });

  it('reports overflow instead of returning more than 500 users', async () => {
    const { db, service } = setup();
    for (let i = 0; i < 501; i++) db.store.user.docs.push(user(5000 + i, `bulk${i}`));
    const result = await service.search('oi2023', 'prefix', 'bulk', 'all');
    expect(result).toEqual({ users: [], overflow: true });
  });

  it('maps a Mongo maxTimeMS error to SEARCH_TIMEOUT', async () => {
    const { db, service } = setup();
    db.store.user.find.mockReturnValueOnce({
      sort: () => ({ limit: () => ({ toArray: () => Promise.reject(Object.assign(new Error('timeout'), { code: 50 })) }) }),
    } as any);
    await expectServiceError(service.search('oi2023', 'regex', 'x', 'all'), 'SEARCH_TIMEOUT');
  });

  it('uses the join flag for membership on Hydro 5', async () => {
    const { service } = setup({ mode: 'v5' });
    const result = await service.search('oi2023', 'prefix', '2301', 'all');
    const byUid = new Map(result.users.map((u) => [u.uid, u]));
    expect(byUid.get(1034)?.isMember).toBe(false);
    expect(byUid.get(1031)?.isMember).toBe(true);
  });
});

describe('HydroGroupService.apply', () => {
  it('adds atomically, joins non-members, clears cache, updates the ledger and records audit', async () => {
    const { service, groups, ctx, groupMeta, auditService } = setup();
    UserModel.cache.set('id/1034/oi2023', {});

    const result = await service.apply({
      domainId: 'oi2023',
      groupName: ' 2023级1班 ',
      action: 'add',
      uids: [1031, 1032, 1034, 9999],
      joinDomain: { role: 'student' },
      actorUid: 2,
    });

    expect(result.added).toEqual([1031, 1032, 1034]);
    expect(result.joined).toEqual([1034]);
    expect(DomainModel.setUserRole).toHaveBeenCalledWith('oi2023', 1034, 'student');
    const group = groups.docs.find((doc) => doc.name === '2023级1班');
    expect(group?.uids).toEqual([1031, 1032, 1034]);
    expect(groups.findOneAndUpdate).toHaveBeenCalledWith(
      { domainId: 'oi2023', name: '2023级1班' },
      { $addToSet: { uids: { $each: [1031, 1032, 1034] } } },
      { upsert: true, returnDocument: 'before' },
    );
    assertNoUidsSet(groups);
    expect(UserModel.cache.has('id/1034/oi2023')).toBe(false);
    expect(ctx.broadcast).toHaveBeenCalledWith('user/delcache', JSON.stringify('oi2023'));
    expect((await groupMeta.get('oi2023', '2023级1班'))?.pluginAdded).toEqual([1031, 1032, 1034]);
    expect((await groupMeta.get('oi2023', '2023级1班'))?.kind).toBe('class');

    const audit = await auditService.findById(result.auditId as string);
    expect(audit).toEqual(expect.objectContaining({
      action: 'group.add', domainId: 'oi2023', undoable: true, actorUid: 2,
      target: { type: 'group', id: '2023级1班' },
    }));
    expect(audit?.detail).toEqual(expect.objectContaining({ added: [1031, 1032, 1034], joined: [1034], joinRole: 'student' }));
  });

  it('only reports members that were actually new', async () => {
    const { service, groupMeta } = setup();
    const result = await service.apply({
      domainId: 'oi2023', groupName: '信息学竞赛队', action: 'add', uids: [1031, 1032], actorUid: 2,
    });
    expect(result.added).toEqual([1031]);
    expect(result.unchanged).toEqual([1032]);
    expect((await groupMeta.get('oi2023', '信息学竞赛队'))?.pluginAdded).toEqual([1031]);
  });

  it('keeps concurrent additions from different operations', async () => {
    const { service, groups } = setup();
    await Promise.all([
      service.apply({ domainId: 'oi2023', groupName: 'G', action: 'add', uids: [1031], actorUid: 2 }),
      service.apply({ domainId: 'oi2023', groupName: 'G', action: 'add', uids: [1032], actorUid: 3 }),
    ]);
    expect(groups.docs.find((doc) => doc.name === 'G')?.uids.sort()).toEqual([1031, 1032]);
  });

  it('removes atomically and only reports members that were present', async () => {
    const { service, groups, groupMeta } = setup();
    await service.apply({ domainId: 'oi2023', groupName: 'G', action: 'add', uids: [1031, 1032], actorUid: 2 });
    const result = await service.apply({ domainId: 'oi2023', groupName: 'G', action: 'remove', uids: [1032, 1041], actorUid: 2 });
    expect(result.removed).toEqual([1032]);
    expect(groups.findOneAndUpdate).toHaveBeenLastCalledWith(
      { domainId: 'oi2023', name: 'G' },
      { $pull: { uids: { $in: [1032, 1041] } } },
      { returnDocument: 'before' },
    );
    expect(groups.docs.find((doc) => doc.name === 'G')?.uids).toEqual([1031]);
    expect((await groupMeta.get('oi2023', 'G'))?.pluginAdded).toEqual([1031]);
    assertNoUidsSet(groups);
  });

  it('validates group names, uid lists, actions and join roles', async () => {
    const { service } = setup();
    const base = { domainId: 'oi2023', action: 'add', uids: [1031], actorUid: 2 };
    await expectServiceError(service.apply({ ...base, groupName: '2301' }), 'INVALID_GROUP_NAME');
    await expectServiceError(service.apply({ ...base, groupName: '1班,2班' }), 'INVALID_GROUP_NAME');
    await expectServiceError(service.apply({ ...base, groupName: 'G', uids: [] }), 'INVALID_UIDS');
    await expectServiceError(service.apply({ ...base, groupName: 'G', uids: [1, 1031] }), 'INVALID_UIDS');
    await expectServiceError(
      service.apply({ ...base, groupName: 'G', uids: Array.from({ length: 501 }, (_, i) => 2000 + i) }),
      'TOO_MANY_USERS',
    );
    await expectServiceError(service.apply({ ...base, groupName: 'G', action: 'replace' }), 'INVALID_ACTION');
    await expectServiceError(service.apply({ ...base, groupName: 'G', joinDomain: { role: 'root' } }), 'INVALID_JOIN_ROLE');
    await expectServiceError(service.apply({ ...base, groupName: 'G', joinDomain: { role: 'default' } }), 'INVALID_JOIN_ROLE');
  });
});

describe('HydroGroupService.undo', () => {
  it('reverts only the members this operation added, and the domain joins it made', async () => {
    const { service, groups, groupMeta, auditService } = setup();
    const { auditId } = await service.apply({
      domainId: 'oi2023', groupName: 'G', action: 'add', uids: [1031, 1034], joinDomain: { role: 'student' }, actorUid: 2,
    });
    // 之后别人在原生页面加了 1041
    groups.docs.find((doc) => doc.name === 'G')!.uids.push(1041);
    DomainModel.setUserRole.mockClear();

    const result = await service.undo('oi2023', auditId, 5);

    expect(result.reverted).toEqual({ removed: [1031, 1034], left: [1034] });
    expect(groups.docs.find((doc) => doc.name === 'G')?.uids).toEqual([1041]);
    expect(DomainModel.setUserRole).toHaveBeenCalledWith('oi2023', 1034, 'default');
    expect((await groupMeta.get('oi2023', 'G'))?.pluginAdded).toEqual([]);
    expect((await auditService.findById(auditId as string))?.undoneBy).toBe(5);
    assertNoUidsSet(groups);

    await expectServiceError(service.undo('oi2023', auditId, 5), 'UNDO_NOT_ALLOWED', 409);
  });

  it('restores removed members and their ledger entries', async () => {
    const { service, groups, groupMeta } = setup();
    await service.apply({ domainId: 'oi2023', groupName: 'G', action: 'add', uids: [1031, 1032], actorUid: 2 });
    const { auditId } = await service.apply({ domainId: 'oi2023', groupName: 'G', action: 'remove', uids: [1031], actorUid: 2 });
    await service.undo('oi2023', auditId, 2);
    expect(groups.docs.find((doc) => doc.name === 'G')?.uids.sort()).toEqual([1031, 1032]);
    expect((await groupMeta.get('oi2023', 'G'))?.pluginAdded.sort()).toEqual([1031, 1032]);
  });

  it('rejects undo from another domain, unknown ids and malformed ids', async () => {
    const { service } = setup();
    const { auditId } = await service.apply({ domainId: 'oi2023', groupName: 'G', action: 'add', uids: [1031], actorUid: 2 });
    await expectServiceError(service.undo('oi2024', auditId, 2), 'AUDIT_DOMAIN_MISMATCH');
    await expectServiceError(service.undo('oi2023', '0123456789abcdef01234567', 2), 'AUDIT_NOT_FOUND', 404);
    await expectServiceError(service.undo('oi2023', 'nope', 2), 'INVALID_AUDIT_ID');
  });
});

describe('HydroGroupService drift and listing', () => {
  it('detects members overwritten by the native page and restores or dismisses them', async () => {
    const { service, groups } = setup();
    await service.apply({ domainId: 'oi2023', groupName: '2023级1班', action: 'add', uids: [1031, 1032, 1034], actorUid: 2 });
    // Hydro 原生页面用旧列表整体保存
    groups.docs.find((doc) => doc.name === '2023级1班')!.uids = [1031];

    let list = await service.list('oi2023');
    let item = list.groups.find((group) => group.name === '2023级1班');
    expect(item?.drift).toEqual([{ uid: 1032, uname: '2301李四' }, { uid: 1034, uname: '2301赵六' }]);
    expect(list.groups.some((group) => group.name === '1031')).toBe(false);
    expect(list.joinRoles).toEqual(['student', 'teacher']);
    expect(list.defaultJoinRole).toBe('student');
    expect(list.domains).toEqual([{ id: 'oi2023', name: '信息学 2023' }, { id: 'oi2024', name: '信息学 2024' }]);

    const restored = await service.resolveDrift({ domainId: 'oi2023', groupName: '2023级1班', action: 'restore', uids: [1032, 1041], actorUid: 2 });
    expect(restored.restored).toEqual([1032]);
    const dismissed = await service.resolveDrift({ domainId: 'oi2023', groupName: '2023级1班', action: 'dismiss', uids: [1034], actorUid: 2 });
    expect(dismissed.dismissed).toEqual([1034]);

    list = await service.list('oi2023');
    item = list.groups.find((group) => group.name === '2023级1班');
    expect(item?.drift).toEqual([]);
    expect(item?.memberCount).toBe(2);
    assertNoUidsSet(groups);

    // 撤销“忽略”后漂移重新出现
    await service.undo('oi2023', dismissed.auditId, 2);
    list = await service.list('oi2023');
    expect(list.groups.find((group) => group.name === '2023级1班')?.drift).toEqual([{ uid: 1034, uname: '2301赵六' }]);
  });

  it('flags groups deleted in Hydro and can recreate them by restoring members', async () => {
    const { service, groups } = setup();
    await service.apply({ domainId: 'oi2023', groupName: 'G', action: 'add', uids: [1031], actorUid: 2 });
    groups.docs.splice(groups.docs.findIndex((doc) => doc.name === 'G'), 1);

    const list = await service.list('oi2023');
    expect(list.groups.find((group) => group.name === 'G')).toEqual(expect.objectContaining({
      existsInHydro: false, memberCount: 0, drift: [{ uid: 1031, uname: '2301张三' }],
    }));

    await service.resolveDrift({ domainId: 'oi2023', groupName: 'G', action: 'restore', uids: [1031], actorUid: 2 });
    expect(groups.docs.find((doc) => doc.name === 'G')?.uids).toEqual([1031]);
  });

  it('hides archived groups unless requested', async () => {
    const { service } = setup();
    await service.updateMeta({ domainId: 'oi2023', groupName: '信息学竞赛队', archived: true, actorUid: 2 });
    expect((await service.list('oi2023')).groups.some((group) => group.name === '信息学竞赛队')).toBe(false);
    expect((await service.list('oi2023', { includeArchived: true })).groups.some((group) => group.name === '信息学竞赛队')).toBe(true);
  });
});

describe('HydroGroupService.updateMeta', () => {
  it('creates an empty Hydro group with extension info and validates fields', async () => {
    const { service, groups, auditService } = setup();
    const result = await service.updateMeta({
      domainId: 'oi2023', groupName: '2023级3班', create: true, kind: 'class', academicYear: '2023', teacherUids: [1007], actorUid: 2,
    });
    expect(result.created).toBe(true);
    expect(groups.docs.find((doc) => doc.name === '2023级3班')?.uids).toEqual([]);
    expect(result.meta).toEqual(expect.objectContaining({ kind: 'class', academicYear: '2023', teacherUids: [1007], archived: false }));

    const list = await service.list('oi2023');
    expect(list.groups.find((group) => group.name === '2023级3班')?.meta?.teachers).toEqual([{ uid: 1007, uname: '2301班主任' }]);
    const audits = await auditService.list({ action: 'group.meta' });
    expect(audits.logs[0].detail).toEqual(expect.objectContaining({ created: true }));

    await expectServiceError(service.updateMeta({ domainId: 'oi2023', groupName: '2023级3班', kind: 'club', actorUid: 2 }), 'INVALID_META');
    await expectServiceError(service.updateMeta({ domainId: 'oi2023', groupName: '2023级3班', teacherUids: [424242], actorUid: 2 }), 'INVALID_META');
    await expectServiceError(service.updateMeta({ domainId: 'oi2023', groupName: '不存在', kind: 'class', actorUid: 2 }), 'GROUP_NOT_FOUND', 404);
  });

  it('deletes extension info only for groups missing in Hydro', async () => {
    const { service, groups, groupMeta } = setup();
    await service.updateMeta({ domainId: 'oi2023', groupName: '信息学竞赛队', kind: 'other', actorUid: 2 });
    await expectServiceError(
      service.updateMeta({ domainId: 'oi2023', groupName: '信息学竞赛队', action: 'delete', actorUid: 2 }),
      'GROUP_STILL_EXISTS', 409,
    );
    groups.docs.splice(groups.docs.findIndex((doc) => doc.name === '信息学竞赛队'), 1);
    const result = await service.updateMeta({ domainId: 'oi2023', groupName: '信息学竞赛队', action: 'delete', actorUid: 2 });
    expect(result.deleted).toBe(true);
    expect(await groupMeta.get('oi2023', '信息学竞赛队')).toBeNull();
  });
});

describe('snapshotGroupNames', () => {
  it('returns the sorted group names and ignores implicit uid groups', async () => {
    const db = createFakeDb({
      'user.group': createFakeCollection([
        { domainId: 'oi2023', name: '2023级1班', uids: [1031] },
        { domainId: 'oi2023', name: '1031', uids: [1031] },
        { domainId: 'oi2023', name: '信息学竞赛队', uids: [1031, 1032] },
        { domainId: 'oi2024', name: '2024级1班', uids: [1031] },
      ]),
    });
    await expect(snapshotGroupNames(db as any, 'oi2023', 1031)).resolves.toEqual(['2023级1班', '信息学竞赛队']);
  });

  it('returns an empty list when the query fails', async () => {
    const db = { collection: () => { throw new Error('down'); } };
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(snapshotGroupNames(db as any, 'oi2023', 1031)).resolves.toEqual([]);
  });
});
