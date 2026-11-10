import { UNGROUPED_KEY, anyGroupCondition, groupCondition, joinGroupNames, readGroupParam } from '../../utils/groupFilter';
import { matches } from '../helpers/fakeMongo';

describe('readGroupParam', () => {
  it('prefers group and falls back to the old classId parameter', () => {
    expect(readGroupParam({ group: '2023级1班', classId: 'old' })).toBe('2023级1班');
    expect(readGroupParam({ classId: ' 2023级2班 ' })).toBe('2023级2班');
    expect(readGroupParam({ group: UNGROUPED_KEY })).toBe(UNGROUPED_KEY);
  });

  it('ignores empty, non-string and oversized values', () => {
    expect(readGroupParam({})).toBeUndefined();
    expect(readGroupParam(undefined)).toBeUndefined();
    expect(readGroupParam({ group: '   ' })).toBeUndefined();
    expect(readGroupParam({ group: ['a', 'b'] })).toBeUndefined();
    expect(readGroupParam({ group: 'x'.repeat(101) })).toBeUndefined();
  });
});

describe('groupCondition', () => {
  const inTwo = { groupNames: ['2023级1班', '竞赛组'] };
  const inOne = { groupNames: ['2023级2班'] };
  const empty = { groupNames: [] };
  const missing = {};

  it('matches any conversation whose snapshot contains the group', () => {
    const cond = groupCondition('竞赛组');
    expect(matches(inTwo, cond)).toBe(true);
    expect(matches(inOne, cond)).toBe(false);
    expect(matches(missing, cond)).toBe(false);
  });

  it('treats a missing or empty snapshot as ungrouped', () => {
    const cond = groupCondition(UNGROUPED_KEY);
    expect(matches(missing, cond)).toBe(true);
    expect(matches(empty, cond)).toBe(true);
    expect(matches(inOne, cond)).toBe(false);
  });

  it('matches any of several groups', () => {
    const cond = anyGroupCondition(['2023级2班', '不存在']);
    expect(matches(inOne, cond)).toBe(true);
    expect(matches(inTwo, cond)).toBe(false);
    expect(matches(missing, cond)).toBe(false);
  });
});

describe('joinGroupNames', () => {
  it('joins names with | and returns empty for no snapshot', () => {
    expect(joinGroupNames(['A', 'B'])).toBe('A|B');
    expect(joinGroupNames([])).toBe('');
    expect(joinGroupNames(undefined)).toBe('');
  });
});
