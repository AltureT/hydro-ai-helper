import {
  defaultSelection,
  isSelectable,
  remainingWork,
  sanitizeSelection,
  unresolvedConflicts,
  userTransferCounts,
  type TransferPreview,
  type UserPreviewItem,
} from '../../../frontend/admin/transferLogic';

const user = (uid: number, extra: Partial<UserPreviewItem> = {}): UserPreviewItem => ({
  uid, uname: `2301学生${uid}`, inSource: true, inTarget: false, isOwner: false, isManager: false, sourceGroups: [], ...extra,
});

const users = [
  user(2031, { sourceGroups: ['2023级3班'] }),
  user(2032, { inTarget: true, sourceGroups: ['2023级3班', '信息学竞赛队'] }),
  user(2033, { isManager: true }),
  user(2034, { isOwner: true, isManager: true, sourceGroups: ['信息学竞赛队'] }),
  user(2035, { inSource: false }),
];

describe('transferLogic', () => {
  it('leaves managers and the owner unselected by default; the owner cannot be picked when moving', () => {
    expect([...defaultSelection(users, 'copy')]).toEqual([2031, 2032, 2035]);
    expect(isSelectable(users[3], 'copy')).toBe(true);
    expect(isSelectable(users[3], 'move')).toBe(false);
    const picked = new Set([2031, 2033, 2034]);
    expect([...sanitizeSelection(picked, users, 'move')]).toEqual([2031, 2033]);
    expect([...sanitizeSelection(picked, users, 'copy')]).toEqual([2031, 2033, 2034]);
  });

  it('counts joins, existing members, leavers and the source groups they leave', () => {
    const selected = new Set([2031, 2032, 2034, 2035]);
    expect(userTransferCounts(users, selected, 'copy')).toEqual({
      selected: 4, join: 3, alreadyInTarget: 1, leave: 0, sourceGroups: [],
    });
    // 所有者不退出源域；不在源域的人不计入退出人数
    expect(userTransferCounts(users, selected, 'move')).toEqual({
      selected: 4, join: 3, alreadyInTarget: 1, leave: 2, sourceGroups: ['2023级3班', '信息学竞赛队'],
    });
  });

  it('lists unresolved name conflicts', () => {
    expect(unresolvedConflicts(null)).toEqual([]);
    const preview = { problems: [{ code: 'CONFLICT_UNRESOLVED', group: '2023级1班' }, { code: 'RENAME_TAKEN', group: '2023级2班' }] } as TransferPreview;
    expect(unresolvedConflicts(preview)).toEqual(['2023级1班']);
  });

  it('sums the people and steps left after a partial run', () => {
    expect(remainingWork([
      { type: 'join', status: 'done', done: 28, total: 28 },
      { type: 'group', name: '2024级3班', status: 'done', done: 30, total: 30, created: true, added: 30 },
      { type: 'pull', status: 'done', done: 29, total: 29 },
      { type: 'leave', status: 'partial', done: 18, total: 29 },
    ])).toEqual({ people: 11, steps: 1 });
    expect(remainingWork([{ type: 'delete_group', name: '2023级1班', status: 'failed', done: 0, total: 1 }])).toEqual({ people: 0, steps: 1 });
  });
});
