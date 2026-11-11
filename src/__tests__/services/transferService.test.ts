import { DomainModel, UserModel } from 'hydrooj';
import { setHydroMode } from '../__mocks__/hydrooj';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { installRealisticDomainModel } from '../helpers/fakeHydroDomain';
import { AuditLogModel } from '../../models/auditLog';
import { GroupMetaModel } from '../../models/groupMeta';
import { QuotaGroupModel } from '../../models/quotaGroup';
import { TransferJobModel } from '../../models/transferJob';
import { AuditService } from '../../services/auditService';
import { normalizeTransferRequest, summarizeTransfer, TransferService } from '../../services/transferService';

type Mode = 'v4' | 'v5';

const OWNER = 1001;
const TEACHER = 1002;
// 44 名学生 + 源域所有者 = 45 人；其中 2040–2044 已是目标域成员 → 40 人需要入域
const STUDENTS = Array.from({ length: 44 }, (_, i) => 2001 + i);
const CLASS = [...STUDENTS, OWNER];

function memberRow(mode: Mode, domainId: string, uid: number, role: string) {
  return mode === 'v5' ? { domainId, uid, role, join: true } : { domainId, uid, role };
}

function setup(mode: Mode = 'v5') {
  setHydroMode(mode);
  const domainDocs: Record<string, any> = {
    oi2023: { _id: 'oi2023', name: '信息学 2023', owner: OWNER, roles: { student: '4', teacher: '2' } },
    oi2024: { _id: 'oi2024', name: '信息学 2024', owner: 1, roles: { student: '4' }, _join: { role: 'student' } },
  };
  const db = createFakeDb({
    user: createFakeCollection([
      { _id: 2, uname: 'admin', priv: 3 },
      { _id: OWNER, uname: '2303组长', priv: 1 },
      { _id: TEACHER, uname: '王老师', priv: 1 },
      ...STUDENTS.map((uid) => ({ _id: uid, uname: `2301学生${uid - 2000}`, priv: 1 })),
    ]),
    domain: createFakeCollection([{ _id: 'oi2023', name: '信息学 2023' }, { _id: 'oi2024', name: '信息学 2024' }]),
    'domain.user': createFakeCollection([
      memberRow(mode, 'oi2023', OWNER, 'root'),
      memberRow(mode, 'oi2023', TEACHER, 'teacher'),
      ...STUDENTS.map((uid) => memberRow(mode, 'oi2023', uid, 'student')),
      ...STUDENTS.filter((uid) => uid >= 2040).map((uid) => memberRow(mode, 'oi2024', uid, 'student')),
    ]),
    'user.group': createFakeCollection([
      { domainId: 'oi2023', name: '2023级1班', uids: [...CLASS] },
      { domainId: 'oi2023', name: '信息学竞赛队', uids: [2001, 2002, TEACHER] },
      { domainId: 'oi2023', name: '17', uids: [2001] },
      { domainId: 'oi2024', name: '2024级1班', uids: [2041] },
    ]),
    document: createFakeCollection([
      { domainId: 'oi2023', docType: 30, assign: ['2023级1班'] },
      { domainId: 'oi2023', docType: 30, assign: ['2023级1班', '2023级2班'] },
      { domainId: 'oi2023', docType: 30, rule: 'homework', assign: ['2023级1班'] },
      { domainId: 'oi2023', docType: 30, assign: ['信息学竞赛队'] },
      { domainId: 'oi2024', docType: 30, assign: ['2023级1班'] },
    ]),
    ai_group_meta: createFakeCollection([
      { _id: 'oi2023:2023级1班', domainId: 'oi2023', name: '2023级1班', kind: 'class', academicYear: '2023', teacherUids: [TEACHER], archived: false, pluginAdded: [2001], createdAt: new Date(), updatedAt: new Date() },
    ]),
    ai_quota_groups: createFakeCollection(),
    ai_transfer_jobs: createFakeCollection(),
    ai_audit_logs: createFakeCollection(),
  });

  const domainUser = db.store['domain.user'];
  DomainModel.get.mockImplementation(async (id: string) => domainDocs[id]);
  installRealisticDomainModel(domainUser, { joinFlag: mode === 'v5' });

  let now = new Date('2026-11-10T08:00:00Z');
  const groupMeta = new GroupMetaModel(db as any);
  const quotaGroups = new QuotaGroupModel(db as any);
  const jobs = new TransferJobModel(db as any);
  const audit = new AuditService(new AuditLogModel(db as any));
  const resolver = { invalidate: jest.fn() };
  const ctx = { broadcast: jest.fn() };
  const service = new TransferService(db as any, groupMeta, quotaGroups, jobs, audit, resolver, ctx, () => now);
  return {
    db, service, groupMeta, quotaGroups, jobs, audit, resolver, domainDocs,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

/** 两个域的小组、成员关系、扩展信息与额度组关联（只比较语义，不比较 _id） */
function state(env: ReturnType<typeof setup>, mode: Mode) {
  const { store } = env.db;
  const isMember = (row: any) => (mode === 'v5' ? row.join === true : !!row.role && !['default', 'guest'].includes(row.role));
  return {
    groups: store['user.group'].docs.map((d: any) => `${d.domainId}/${d.name}:${[...d.uids].sort((a, b) => a - b).join(',')}`).sort(),
    members: store['domain.user'].docs.filter(isMember).map((r: any) => `${r.domainId}/${r.uid}:${r.role}`).sort(),
    metas: store.ai_group_meta.docs.map((m: any) => `${m._id}:${m.kind}:${m.academicYear || ''}:${(m.teacherUids || []).join(',')}:${[...(m.pluginAdded || [])].sort().join(',')}:${!!m.archived}`).sort(),
    links: store.ai_quota_groups.docs.map((g: any) => `${g.name}:${g.linkedGroups.map((l: any) => `${l.domainId}/${l.name}`).sort().join('|')}`),
    contests: store.document.docs.length,
  };
}

const groupMove = { kind: 'groups', mode: 'move', sourceDomainId: 'oi2023', targetDomainId: 'oi2024', groupNames: ['2023级1班'] };

describe('TransferService preview', () => {
  it('previews copying a class: new group, members, who must join, assignments (scenario 1)', async () => {
    const env = setup();
    const preview = await env.service.preview({ ...groupMove, mode: 'copy' });
    expect(preview).toEqual(expect.objectContaining({
      kind: 'groups',
      mode: 'copy',
      source: { id: 'oi2023', name: '信息学 2023' },
      target: { id: 'oi2024', name: '信息学 2024' },
      defaultJoinRole: 'student',
      problems: [],
      leaveCandidates: [],
      owner: { uid: OWNER, uname: '2303组长' },
    }));
    expect(preview.groups).toEqual([expect.objectContaining({
      name: '2023级1班', targetName: '2023级1班', resolution: 'new', memberCount: 45, willAdd: 45, alreadyIn: 0, assignments: 3, quotaLinks: [],
    })]);
    expect(preview.joinUids).toHaveLength(40);
    expect(preview.joinUids).toContain(OWNER);
    expect(preview.previewToken).toMatch(/^\d+\.[0-9a-f]{32}$/);
    expect(preview.expiresAt).toBe('2026-11-10T08:10:00.000Z');
  });

  it('lists quota-group links and leave candidates (owner excluded) when moving (scenarios 2, 4)', async () => {
    const env = setup();
    const team = await env.quotaGroups.create({ name: '竞赛队', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await env.quotaGroups.link(team._id, { domainId: 'oi2023', name: '2023级1班' });
    const preview = await env.service.preview(groupMove);
    expect(preview.groups?.[0].quotaLinks).toEqual([{ id: String(team._id), name: '竞赛队' }]);
    expect(preview.leaveCandidates).toHaveLength(44);
    expect(preview.leaveCandidates).not.toContain(OWNER);
  });

  it('requires a merge or rename choice when the target has a same-name group (scenario 3)', async () => {
    const env = setup();
    env.db.store['user.group'].docs.push({ domainId: 'oi2024', name: '2023级1班', uids: [2001, 2002, 2003] });
    const unresolved = await env.service.preview(groupMove);
    expect(unresolved.problems).toEqual([{ code: 'CONFLICT_UNRESOLVED', group: '2023级1班' }]);
    expect(unresolved.groups?.[0]).toEqual(expect.objectContaining({ conflict: true, resolution: null }));

    const merged = await env.service.preview({ ...groupMove, conflicts: { '2023级1班': 'merge' } });
    expect(merged.problems).toEqual([]);
    expect(merged.groups?.[0]).toEqual(expect.objectContaining({ resolution: 'merge', targetMemberCount: 3, willAdd: 42, alreadyIn: 3 }));

    const taken = await env.service.preview({ ...groupMove, conflicts: { '2023级1班': { renameTo: '2024级1班' } } });
    expect(taken.problems).toEqual([{ code: 'RENAME_TAKEN', group: '2023级1班' }]);

    const renamed = await env.service.preview({ ...groupMove, conflicts: { '2023级1班': { renameTo: '2023级1班（转入）' } } });
    expect(renamed.problems).toEqual([]);
    expect(renamed.groups?.[0]).toEqual(expect.objectContaining({ resolution: 'rename', targetName: '2023级1班（转入）', willAdd: 45 }));
  });

  it('flags a missing source group', async () => {
    const env = setup();
    const preview = await env.service.preview({ ...groupMove, groupNames: ['不存在'] });
    expect(preview.problems).toEqual([{ code: 'SOURCE_GROUP_MISSING', group: '不存在' }]);
  });

  it('marks the owner and managers among selected users (scenario 6)', async () => {
    const env = setup();
    const preview = await env.service.preview({
      kind: 'users', mode: 'move', sourceDomainId: 'oi2023', targetDomainId: 'oi2024', uids: [2001, 2041, OWNER, TEACHER], targetGroup: '2024级3班',
    });
    expect(preview.users).toEqual([
      // 所有者的角色是 root，同时也是管理者
      expect.objectContaining({ uid: OWNER, isOwner: true, isManager: true, inSource: true, inTarget: false }),
      expect.objectContaining({ uid: TEACHER, isOwner: false, isManager: true, sourceGroups: ['信息学竞赛队'] }),
      expect.objectContaining({ uid: 2001, isManager: false, sourceGroups: ['2023级1班', '信息学竞赛队'] }),
      expect.objectContaining({ uid: 2041, inTarget: true }),
    ]);
    // 默认不选管理者（含所有者）
    expect(preview.joinUids).toEqual([2001]);
    expect(preview.targetGroup).toEqual({ name: '2024级3班', exists: false, memberCount: 0 });
  });

  it('normalizes and validates requests', () => {
    expect(() => normalizeTransferRequest({ ...groupMove, targetDomainId: 'oi2023' })).toThrow('SAME_DOMAIN');
    expect(() => normalizeTransferRequest({ ...groupMove, kind: 'all' })).toThrow('INVALID_TRANSFER_KIND');
    expect(() => normalizeTransferRequest({ ...groupMove, groupNames: ['2301'] })).toThrow('INVALID_GROUP_NAME');
    expect(() => normalizeTransferRequest({ ...groupMove, groupNames: Array.from({ length: 21 }, (_, i) => `组${i}`) })).toThrow('TOO_MANY_GROUPS');
    expect(() => normalizeTransferRequest({ kind: 'users', mode: 'copy', sourceDomainId: 'a', targetDomainId: 'b', uids: [1] })).toThrow('INVALID_UIDS');
    expect(normalizeTransferRequest({ kind: 'users', mode: 'copy', sourceDomainId: 'a', targetDomainId: 'b', uids: [5, '3', 5] }).uids).toEqual([3, 5]);
    // 学生不能从站点中心移出（移出后在站点中心变成游客）
    expect(() => normalizeTransferRequest({ kind: 'users', mode: 'move', sourceDomainId: 'system', targetDomainId: 'b', uids: [5] })).toThrow('SYSTEM_DOMAIN_SOURCE');
    expect(normalizeTransferRequest({ kind: 'users', mode: 'move', sourceDomainId: 'b', targetDomainId: 'system', uids: [5] }).mode).toBe('move');
  });
});

describe('TransferService execute and undo', () => {
  it('rejects a missing, expired, stale or blocked preview', async () => {
    const env = setup();
    await expect(env.service.execute({ ...groupMove }, 2)).rejects.toThrow('PREVIEW_REQUIRED');

    const preview = await env.service.preview(groupMove);
    env.advance(11 * 60 * 1000);
    await expect(env.service.execute({ ...groupMove, previewToken: preview.previewToken }, 2)).rejects.toThrow('PREVIEW_EXPIRED');

    const fresh = await env.service.preview(groupMove);
    env.db.store['user.group'].docs[0].uids.push(2999);
    await expect(env.service.execute({ ...groupMove, previewToken: fresh.previewToken }, 2)).rejects.toThrow('PREVIEW_STALE');

    env.db.store['user.group'].docs.push({ domainId: 'oi2024', name: '2023级1班', uids: [] });
    const conflicted = await env.service.preview(groupMove);
    await expect(env.service.execute({ ...groupMove, previewToken: conflicted.previewToken }, 2)).rejects.toThrow('TRANSFER_BLOCKED');
    expect(env.db.store.ai_transfer_jobs.docs).toHaveLength(0);
  });

  it.each(['v4', 'v5'] as Mode[])('moves a 45-person class target-first and undo restores both domains (SC-010, Hydro %s)', async (mode) => {
    const env = setup(mode);
    const team = await env.quotaGroups.create({ name: '竞赛队', mode: 'grant', dailyLimit: 60, enabled: true, createdBy: 2 });
    await env.quotaGroups.link(team._id, { domainId: 'oi2023', name: '2023级1班' });
    const before = state(env, mode);

    const preview = await env.service.preview(groupMove);
    const result = await env.service.execute({ ...groupMove, previewToken: preview.previewToken, removeMembersFromSource: true }, 2);
    expect(result.status).toBe('done');
    expect(result.summary).toEqual([
      { type: 'join', status: 'done', done: 40, total: 40 },
      { type: 'group', name: '2023级1班', status: 'done', done: 45, total: 45, created: true, added: 45 },
      { type: 'relink', name: '竞赛队', status: 'done', done: 1, total: 1 },
      { type: 'delete_group', name: '2023级1班', status: 'done', done: 1, total: 1 },
      { type: 'leave', status: 'done', done: 44, total: 44 },
    ]);

    const after = state(env, mode);
    expect(after.groups).toContain(`oi2024/2023级1班:${[...CLASS].sort((a, b) => a - b).join(',')}`);
    expect(after.groups.some((g) => g.startsWith('oi2023/2023级1班:'))).toBe(false);
    expect(after.members).toContain(`oi2024/2001:student`);
    expect(after.members).toContain(`oi2023/${OWNER}:root`);
    expect(after.members.filter((m) => m.startsWith('oi2023/'))).toEqual([`oi2023/${OWNER}:root`, `oi2023/${TEACHER}:teacher`]);
    // 扩展信息随组复制，负责老师不复制；源域扩展信息删除
    expect(after.metas).toEqual([expect.stringMatching(/^oi2024:2023级1班:class:2023::/)]);
    expect(after.links).toEqual(['竞赛队:oi2024/2023级1班']);
    expect(after.contests).toBe(before.contests);
    // 先写目标域、后改源域
    const log = env.db.store.ai_audit_logs.docs[0];
    expect(log.steps.map((step: any) => step.name)).toEqual(['join#0', 'group#0', 'relink#0#0', 'delete#0', 'leave#0']);
    expect(log).toEqual(expect.objectContaining({ action: 'transfer.groups', category: 'transfer', domainId: 'oi2023', undoable: true }));
    expect(env.resolver.invalidate).toHaveBeenCalled();
    if (mode === 'v5') {
      expect(UserModel._deleteUserCache).toHaveBeenCalledWith('oi2024');
      expect(UserModel._deleteUserCache).toHaveBeenCalledWith('oi2023');
    }

    await expect(env.service.undo(result.auditId, 2)).resolves.toEqual({ undone: 5, status: 'undone' });
    expect(state(env, mode)).toEqual(before);
    await expect(env.service.undo(result.auditId, 2)).rejects.toThrow('ALREADY_UNDONE');
    expect(env.db.store.ai_transfer_jobs.docs[0].status).toBe('undone');
  });

  it('merges into an existing group and undo only removes the members it added (scenario 7)', async () => {
    const env = setup();
    env.db.store['user.group'].docs.push({ domainId: 'oi2024', name: '2023级1班', uids: [2001, 9001] });
    const before = state(env, 'v5');
    const request = { ...groupMove, mode: 'copy', conflicts: { '2023级1班': 'merge' } };
    const preview = await env.service.preview(request);
    const result = await env.service.execute({ ...request, previewToken: preview.previewToken }, 2);
    expect(result.summary.find((item) => item.type === 'group')).toEqual(expect.objectContaining({ created: false, added: 44 }));
    // 之后有人往组里加了人：撤销不影响
    env.db.store['user.group'].docs.find((d: any) => d.domainId === 'oi2024' && d.name === '2023级1班').uids.push(9002);
    await env.service.undo(result.auditId, 2);
    const after = state(env, 'v5');
    expect(after.groups).toContain('oi2024/2023级1班:2001,9001,9002');
    expect(after.groups.filter((g) => g.startsWith('oi2023/'))).toEqual(before.groups.filter((g) => g.startsWith('oi2023/')));
  });

  it('moves selected users into a new target group, keeping the owner in the source (scenarios 5, 6)', async () => {
    const env = setup('v4');
    const before = state(env, 'v4');
    const request = { kind: 'users', mode: 'move', sourceDomainId: 'oi2023', targetDomainId: 'oi2024', uids: [2001, 2002, OWNER, TEACHER], targetGroup: '2024级3班' };
    const preview = await env.service.preview(request);
    const result = await env.service.execute({ ...request, previewToken: preview.previewToken, selectedUids: [2001, 2002, OWNER] }, 2);
    expect(result.status).toBe('done');
    const after = state(env, 'v4');
    expect(after.groups).toContain(`oi2024/2024级3班:${OWNER},2001,2002`);
    expect(after.groups).toContain(`oi2023/2023级1班:${CLASS.filter((uid) => uid !== 2001 && uid !== 2002).sort((a, b) => a - b).join(',')}`);
    expect(after.groups).toContain(`oi2023/信息学竞赛队:${TEACHER}`);
    expect(after.groups).toContain('oi2023/17:2001'); // Hydro 内部的数字组不动
    expect(after.members).toContain(`oi2023/${OWNER}:root`);
    expect(after.members).not.toContain('oi2023/2001:student');
    expect(after.members).toEqual(expect.arrayContaining(['oi2024/2001:student', `oi2024/${OWNER}:student`]));
    expect(after.members).toContain(`oi2023/${TEACHER}:teacher`);

    await env.service.undo(result.auditId, 2);
    expect(state(env, 'v4')).toEqual(before);
  });

  it('copies two classes into a domain where none of them has a record yet (Hydro 5)', async () => {
    const env = setup('v5');
    const copy = async (uids: number[], targetGroup: string) => {
      const request = { kind: 'users', mode: 'copy', sourceDomainId: 'oi2023', targetDomainId: 'oi2024', uids, targetGroup };
      const preview = await env.service.preview(request);
      return env.service.execute({ ...request, previewToken: preview.previewToken }, 2);
    };
    expect((await copy([2001, 2002, 2003], '2025级04班')).status).toBe('done');
    expect((await copy([2004, 2005], '2025级07班')).status).toBe('done');

    const rows = env.db.store['domain.user'].docs;
    const joined = rows.filter((row: any) => row.domainId === 'oi2024' && row.join === true).map((row: any) => row.uid);
    expect(joined).toEqual(expect.arrayContaining([2001, 2002, 2003, 2004, 2005]));
    expect(rows.filter((row: any) => row.uid === undefined)).toEqual([]);
    const groups = env.db.store['user.group'].docs.filter((doc: any) => doc.domainId === 'oi2024');
    expect(groups.find((doc: any) => doc.name === '2025级07班')?.uids).toEqual([2004, 2005]);
  });

  it('validates the user selection and join role', async () => {
    const env = setup();
    const request = { kind: 'users', mode: 'copy', sourceDomainId: 'oi2023', targetDomainId: 'oi2024', uids: [2001, 2002] };
    const preview = await env.service.preview(request);
    await expect(env.service.execute({ ...request, previewToken: preview.previewToken, selectedUids: [2001, 3000] }, 2)).rejects.toThrow('INVALID_UIDS');
    await expect(env.service.execute({ ...request, previewToken: preview.previewToken, selectedUids: [] }, 2)).rejects.toThrow('INVALID_UIDS');
    await expect(env.service.execute({ ...request, previewToken: preview.previewToken, joinRole: 'root' }, 2)).rejects.toThrow('INVALID_JOIN_ROLE');

    delete env.domainDocs.oi2024._join;
    const noDefault = await env.service.preview(request);
    await expect(env.service.execute({ ...request, previewToken: noDefault.previewToken }, 2)).rejects.toThrow('JOIN_ROLE_REQUIRED');
  });

  it('reports a partial run, resumes from the failed step and can still undo correctly (scenario 8)', async () => {
    const env = setup();
    const before = state(env, 'v5');
    const original = env.groupMeta.delete.bind(env.groupMeta);
    // 删除源组后、删除扩展信息时失败：源组已删，但步骤未完成
    const spy = jest.spyOn(env.groupMeta, 'delete').mockRejectedValueOnce(new Error('db timeout'));
    const preview = await env.service.preview(groupMove);
    const partial = await env.service.execute({ ...groupMove, previewToken: preview.previewToken, removeMembersFromSource: true }, 2);
    expect(partial).toEqual(expect.objectContaining({ status: 'partial', failedAt: 'delete#0', error: 'db timeout' }));
    expect(partial.summary.map((item) => [item.type, item.status])).toEqual([
      ['join', 'done'], ['group', 'done'], ['delete_group', 'failed'], ['leave', 'pending'],
    ]);
    expect(env.db.store.ai_audit_logs.docs[0].detail.status).toBe('partial');
    spy.mockImplementation(original);

    const resumed = await env.service.resume(partial.auditId, 2);
    expect(resumed.status).toBe('done');
    expect(resumed.summary.every((item) => item.status === 'done')).toBe(true);
    await expect(env.service.resume(partial.auditId, 2)).rejects.toThrow('TRANSFER_NOT_RESUMABLE');

    // 继续执行时沿用了第一次的快照，撤销仍能恢复被删除的源组
    await env.service.undo(partial.auditId, 2);
    expect(state(env, 'v5')).toEqual(before);
  });

  it('undo of a partial run also rolls back the half-written failed step', async () => {
    const env = setup();
    const before = state(env, 'v5');
    // 目标组已写入成员，但写台账时失败
    jest.spyOn(env.groupMeta, 'addPluginAdded').mockRejectedValueOnce(new Error('boom'));
    const preview = await env.service.preview(groupMove);
    const partial = await env.service.execute({ ...groupMove, previewToken: preview.previewToken }, 2);
    expect(partial.failedAt).toBe('group#0');
    expect(state(env, 'v5').groups.some((g) => g.startsWith('oi2024/2023级1班:'))).toBe(true);
    await expect(env.service.undo(partial.auditId, 2)).resolves.toEqual({ undone: 2, status: 'undone' });
    expect(state(env, 'v5')).toEqual(before);
    expect(env.db.store.ai_transfer_jobs.docs[0].status).toBe('undone');
  });

  it('refuses to undo a running transfer and unknown ids', async () => {
    const env = setup();
    await expect(env.service.undo('nope', 2)).rejects.toThrow('TRANSFER_NOT_FOUND');
    await expect(env.service.undo('64b7f0c2a1b2c3d4e5f60718', 2)).rejects.toThrow('TRANSFER_NOT_FOUND');
  });
});

describe('summarizeTransfer', () => {
  it('merges batches and reports partial progress', () => {
    const plan: any[] = [
      { key: 'join#0', type: 'join', domainId: 'b', uids: Array(200).fill(1), role: 's' },
      { key: 'join#1', type: 'join', domainId: 'b', uids: Array(50).fill(1), role: 's' },
      { key: 'leave#0', type: 'leave', domainId: 'a', uids: Array(200).fill(1) },
      { key: 'leave#1', type: 'leave', domainId: 'a', uids: Array(29).fill(1) },
    ];
    const results: any[] = [{ key: 'join#0' }, { key: 'join#1' }, { key: 'leave#0' }];
    expect(summarizeTransfer({ plan, results, failedAt: 'leave#1' })).toEqual([
      { type: 'join', status: 'done', done: 250, total: 250 },
      { type: 'leave', status: 'partial', done: 200, total: 229 },
    ]);
  });
});
