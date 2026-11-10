import { GROUP_NAME_MAX_LENGTH, groupNameErrorKey, validateGroupName } from '../../utils/groupName';

describe('validateGroupName', () => {
  it('trims and accepts class-style names', () => {
    expect(validateGroupName('  2023级1班 ')).toEqual({ ok: true, name: '2023级1班' });
    expect(validateGroupName('信息学竞赛队')).toEqual({ ok: true, name: '信息学竞赛队' });
  });

  it('rejects empty and non-string input', () => {
    expect(validateGroupName('   ')).toEqual({ ok: false, error: 'empty' });
    expect(validateGroupName(undefined)).toEqual({ ok: false, error: 'empty' });
    expect(validateGroupName(123)).toEqual({ ok: false, error: 'empty' });
  });

  it('rejects pure-digit names that collide with implicit uid groups', () => {
    expect(validateGroupName('1031')).toEqual({ ok: false, error: 'numeric' });
    expect(validateGroupName(' 2301 ')).toEqual({ ok: false, error: 'numeric' });
    expect(validateGroupName('2301班')).toEqual({ ok: true, name: '2301班' });
  });

  it('rejects commas and control characters', () => {
    expect(validateGroupName('1班,2班')).toEqual({ ok: false, error: 'comma' });
    expect(validateGroupName('1班\n2班')).toEqual({ ok: false, error: 'control_char' });
    expect(validateGroupName('1班，2班')).toEqual({ ok: true, name: '1班，2班' });
  });

  it('counts length in characters, not UTF-16 units', () => {
    expect(validateGroupName('班'.repeat(GROUP_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateGroupName('班'.repeat(GROUP_NAME_MAX_LENGTH + 1))).toEqual({ ok: false, error: 'too_long' });
    expect(validateGroupName('😀'.repeat(GROUP_NAME_MAX_LENGTH)).ok).toBe(true);
  });

  it('maps errors to locale keys', () => {
    expect(groupNameErrorKey('numeric')).toBe('ai_helper_group_name_err_numeric');
  });
});
