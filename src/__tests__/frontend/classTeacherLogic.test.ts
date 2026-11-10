import {
  CLASS_API,
  accessErrorOf,
  classTeacherPath,
  pickInitialGroup,
  totalPages,
  turnsOf,
  violationBreakdown,
} from '../../../frontend/teacher/classTeacherLogic';

const groups = [
  { name: '2023级1班', memberCount: 45, archived: false },
  { name: '信息学竞赛队', memberCount: 18, archived: false },
];

describe('classTeacherLogic', () => {
  it('maps server error codes to access reasons', () => {
    expect(accessErrorOf('TEACHER_ACCESS_DISABLED')).toBe('disabled');
    expect(accessErrorOf('NOT_GROUP_TEACHER')).toBe('not_teacher');
    expect(accessErrorOf('GROUP_NOT_ALLOWED')).toBe('group');
    expect(accessErrorOf(undefined)).toBe('other');
  });

  it('selects the group from the URL only when it is accessible', () => {
    expect(pickInitialGroup(groups, '?group=%E4%BF%A1%E6%81%AF%E5%AD%A6%E7%AB%9E%E8%B5%9B%E9%98%9F')).toBe('信息学竞赛队');
    expect(pickInitialGroup(groups, '?group=2023%E7%BA%A72%E7%8F%AD')).toBe('2023级1班');
    expect(pickInitialGroup([], '')).toBe('');
  });

  it('counts turns from metrics, or half the messages for old conversations', () => {
    expect(turnsOf({ metrics: { studentMessageCount: 4 }, messageCount: 20 })).toBe(4);
    expect(turnsOf({ messageCount: 5 })).toBe(3);
    expect(turnsOf({ metrics: {}, messageCount: 0 })).toBe(0);
  });

  it('sorts the violation breakdown by count and drops zeros', () => {
    expect(violationBreakdown({ answer_seeking: 1, off_topic: 3, prompt_injection: 0 })).toEqual([
      { category: 'off_topic', count: 3 },
      { category: 'answer_seeking', count: 1 },
    ]);
  });

  it('computes pages and paths', () => {
    expect(totalPages(0, 20)).toBe(1);
    expect(totalPages(41, 20)).toBe(3);
    expect(classTeacherPath('oi2023')).toBe('/d/oi2023/ai-helper/class');
    expect(classTeacherPath('system')).toBe('/ai-helper/class');
    expect(CLASS_API.detail('abc')).toBe('/ai-helper/class/conversations/abc');
  });
});
