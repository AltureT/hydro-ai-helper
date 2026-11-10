import {
  defaultSelection,
  domainApiUrl,
  filterGroups,
  formatUidNames,
  membersOnlySelection,
  parseNameList,
  selectedNonMembers,
  summarizeAuditDetail,
  validateGroupNameClient,
  type GroupListItem,
  type SearchUser,
} from '../../../frontend/admin/userManagementLogic';
import { validateGroupName } from '../../utils/groupName';

const users: SearchUser[] = [
  { uid: 1031, uname: '2301张三', role: 'student', isMember: true, isManager: false, groups: [] },
  { uid: 1034, uname: '2301赵六', role: null, isMember: false, isManager: false, groups: [] },
  { uid: 1007, uname: '2301班主任', role: 'teacher', isMember: true, isManager: true, groups: [] },
];

describe('user management frontend logic', () => {
  it('leaves managers unselected by default', () => {
    expect([...defaultSelection(users)]).toEqual([1031, 1034]);
    expect([...membersOnlySelection(users)]).toEqual([1031]);
    expect(selectedNonMembers(users, new Set([1031, 1034])).map((u) => u.uid)).toEqual([1034]);
  });

  it('mirrors the server group-name rules', () => {
    for (const name of ['2023级1班', ' 2301 ', '1班,2班', '', 'a'.repeat(65), '1班\t2班', '1班，2班']) {
      const server = validateGroupName(name);
      expect(validateGroupNameClient(name)).toBe('error' in server ? server.error : null);
    }
  });

  it('parses pasted name lists', () => {
    expect(parseNameList('王老师\n李老师，王老师、 赵老师;')).toEqual(['王老师', '李老师', '赵老师']);
  });

  it('summarizes audit details and formats names', () => {
    const summary = summarizeAuditDetail({ detail: { added: [1031, 1034], joined: [1034], joinRole: 'student', removed: 'x' } });
    expect(summary).toEqual({ added: [1031, 1034], removed: [], joined: [1034], dismissed: [], joinRole: 'student' });
    expect(formatUidNames([1031, 1034, 9], { 1031: '2301张三' }, 2)).toEqual({ text: '2301张三（1031）、1034', more: 1 });
  });

  it('filters groups by name or teacher', () => {
    const groups: GroupListItem[] = [
      { name: '2023级1班', existsInHydro: true, memberCount: 45, drift: [], meta: { kind: 'class', teacherUids: [7], teachers: [{ uid: 7, uname: '王老师' }], archived: false } },
      { name: '信息学竞赛队', existsInHydro: true, memberCount: 18, drift: [], meta: null },
    ];
    expect(filterGroups(groups, '1班').map((g) => g.name)).toEqual(['2023级1班']);
    expect(filterGroups(groups, '王').map((g) => g.name)).toEqual(['2023级1班']);
    expect(filterGroups(groups, ' ')).toHaveLength(2);
  });

  it('builds domain-scoped API URLs', () => {
    expect(domainApiUrl('oi2023', '/ai-helper/groups')).toBe('/d/oi2023/ai-helper/groups');
    expect(domainApiUrl('a b', '/x')).toBe('/d/a%20b/x');
  });
});
