import {
  UNGROUPED_KEY,
  groupChoices,
  groupNamesText,
  isUngroupedKey,
  parseGroupOptions,
  readGroupFromSearch,
} from '../../../frontend/teacher/groupFilterLogic';
import { UNGROUPED_KEY as SERVER_UNGROUPED_KEY } from '../../utils/groupFilter';

describe('groupFilterLogic', () => {
  it('uses the same ungrouped key as the server', () => {
    expect(UNGROUPED_KEY).toBe(SERVER_UNGROUPED_KEY);
  });

  it('reads group from the URL, falling back to the old classId', () => {
    expect(readGroupFromSearch('?group=2023%E7%BA%A71%E7%8F%AD&classId=x')).toBe('2023级1班');
    expect(readGroupFromSearch('?classId=%E7%AB%9E%E8%B5%9B%E7%BB%84')).toBe('竞赛组');
    expect(readGroupFromSearch('')).toBe('');
  });

  it('parses filter options with the classIds fallback', () => {
    expect(parseGroupOptions({ groups: ['A', '', 3, 'B'], hasUngrouped: true })).toEqual({ groups: ['A', 'B'], hasUngrouped: true });
    expect(parseGroupOptions({ classIds: ['old'] })).toEqual({ groups: ['old'], hasUngrouped: false });
    expect(parseGroupOptions(null)).toEqual({ groups: [], hasUngrouped: false });
  });

  it('builds choices, keeping a URL group that is not in the list and adding ungrouped when present', () => {
    const options = { groups: ['A', 'B'], hasUngrouped: true };
    expect(groupChoices(options, '')).toEqual([
      { value: 'A', ungrouped: false },
      { value: 'B', ungrouped: false },
      { value: UNGROUPED_KEY, ungrouped: true },
    ]);
    expect(groupChoices({ groups: ['A'], hasUngrouped: false }, 'Gone').map((c) => c.value)).toEqual(['Gone', 'A']);
    expect(groupChoices({ groups: [], hasUngrouped: false }, UNGROUPED_KEY)).toEqual([{ value: UNGROUPED_KEY, ungrouped: true }]);
  });

  it('formats group names and recognises ungrouped rows', () => {
    expect(groupNamesText(['A', 'B'])).toBe('A、B');
    expect(groupNamesText([])).toBeNull();
    expect(groupNamesText(undefined)).toBeNull();
    expect(isUngroupedKey(UNGROUPED_KEY)).toBe(true);
    expect(isUngroupedKey(null)).toBe(true);
    expect(isUngroupedKey('A')).toBe(false);
  });
});
