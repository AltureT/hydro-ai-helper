import {
  EMPTY_OVERVIEW_FILTERS,
  expiresDateToIso,
  isoToDateInput,
  nonMembersOf,
  overviewQuery,
  suggestMoveSource,
  normalizePageSize,
  pageSelectionState,
  usageMeter,
  validateGroupForm,
  validateOverrideForm,
} from '../../../frontend/admin/quotaAdminLogic';

describe('quota admin frontend logic', () => {
  it('validates the quota group form like the server', () => {
    expect(validateGroupForm({ name: ' ', mode: 'grant', limitText: '60' })).toBe('name_required');
    expect(validateGroupForm({ name: 'x'.repeat(33), mode: 'grant', limitText: '60' })).toBe('name_too_long');
    expect(validateGroupForm({ name: '竞赛队', mode: 'grant', limitText: '0' })).toBe('limit_grant');
    expect(validateGroupForm({ name: '暂停', mode: 'cap', limitText: '0' })).toBeNull();
    expect(validateGroupForm({ name: '暂停', mode: 'cap', limitText: '-1' })).toBe('limit_cap');
    expect(validateGroupForm({ name: '暂停', mode: 'cap', limitText: '2.5' })).toBe('limit_cap');
    expect(validateGroupForm({ name: '竞赛队', mode: 'grant', limitText: '100001' })).toBe('limit_grant');
  });

  it('validates the override form: users, count, future expiry, reason', () => {
    const now = new Date(2026, 10, 10, 12, 0, 0);
    const base = { uids: [1031], mode: 'limit' as const, limitText: '100', reason: '准备省赛', expiresDate: '' };
    expect(validateOverrideForm(base, now)).toBeNull();
    expect(validateOverrideForm({ ...base, uids: [] }, now)).toBe('no_users');
    expect(validateOverrideForm({ ...base, limitText: '0' }, now)).toBe('limit');
    expect(validateOverrideForm({ ...base, mode: 'disabled', limitText: '' }, now)).toBeNull();
    expect(validateOverrideForm({ ...base, reason: '  ' }, now)).toBe('reason_required');
    expect(validateOverrideForm({ ...base, reason: 'x'.repeat(201) }, now)).toBe('reason_too_long');
    expect(validateOverrideForm({ ...base, expiresDate: '2026-11-09' }, now)).toBe('expires');
    // 今天到期：当天 23:59:59 之前仍有效
    expect(validateOverrideForm({ ...base, expiresDate: '2026-11-10' }, now)).toBeNull();
  });

  it('converts expiry dates to the end of that local day and back', () => {
    const iso = expiresDateToIso('2026-11-17')!;
    const date = new Date(iso);
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]).toEqual([2026, 10, 17, 23, 59]);
    expect(isoToDateInput(iso)).toBe('2026-11-17');
    expect(expiresDateToIso('2026-02-30')).toBeNull();
    expect(expiresDateToIso('soon')).toBeNull();
    expect(isoToDateInput(undefined)).toBe('');
  });

  it('colors usage: ≥ 80% warns, used up is full, off and unlimited have no bar', () => {
    expect(usageMeter({ limit: 56, used: 6, disabled: false })).toEqual({ percent: 11, tone: 'normal' });
    expect(usageMeter({ limit: 60, used: 50, disabled: false })).toEqual({ percent: 83, tone: 'warn' });
    expect(usageMeter({ limit: 13, used: 13, disabled: false })).toEqual({ percent: 100, tone: 'full' });
    expect(usageMeter({ limit: 0, used: 0, disabled: true })).toEqual({ percent: 0, tone: 'off' });
    expect(usageMeter({ limit: null, used: 7, disabled: false })).toEqual({ percent: 0, tone: 'unlimited' });
  });

  it('builds the overview query, dropping a group without a domain', () => {
    expect(overviewQuery(EMPTY_OVERVIEW_FILTERS, 1)).toBe('');
    expect(overviewQuery(EMPTY_OVERVIEW_FILTERS, 2, 100)).toBe('page=2&pageSize=100');
    expect(overviewQuery(EMPTY_OVERVIEW_FILTERS, 1, 50)).toBe('');
    expect(normalizePageSize('200')).toBe(200);
    expect(normalizePageSize('37')).toBe(50);
    expect(normalizePageSize(null)).toBe(50);
    expect(overviewQuery({ ...EMPTY_OVERVIEW_FILTERS, q: ' 2301 ', group: '2023级1班', status: 'exhausted' }, 2))
      .toBe('q=2301&mode=prefix&status=exhausted&page=2');
    expect(overviewQuery({ ...EMPTY_OVERVIEW_FILTERS, domainId: 'oi2023', group: '2023级1班', quotaGroupId: 'abc' }, 1))
      .toBe(`domainId=oi2023&group=${encodeURIComponent('2023级1班')}&quotaGroupId=abc`);
  });

  it('tracks page selection and finds non-members of a domain', () => {
    const rows = [
      { uid: 1, domains: [{ id: 'oi2023', name: 'A' }] },
      { uid: 2, domains: [] },
      { uid: 3, domains: [{ id: 'oi2024', name: 'B' }] },
    ];
    expect(pageSelectionState(rows, new Set())).toBe('none');
    expect(pageSelectionState(rows, new Set([1, 99]))).toBe('some');
    expect(pageSelectionState(rows, new Set([1, 2, 3]))).toBe('all');
    expect(pageSelectionState([], new Set([1]))).toBe('none');
    expect(nonMembersOf(rows, 'oi2023')).toEqual([2, 3]);
  });
});

describe('suggestMoveSource', () => {
  const row = (...ids: string[]) => ({ domains: ids.map((id) => ({ id, name: id })) });
  const domains = ['system', 'oi2023', 'oi2024', 'club'];

  it('uses the filtered domain when it is a valid source', () => {
    expect(suggestMoveSource([row('system', 'oi2024')], 'oi2023', domains)).toBe('oi2023');
  });

  it('otherwise picks the domain most of the selected students are in, never the site-wide domain', () => {
    expect(suggestMoveSource([row('system', 'oi2024'), row('system', 'oi2024'), row('system', 'club')], '', domains)).toBe('oi2024');
    expect(suggestMoveSource([row('system', 'oi2024')], 'system', domains)).toBe('oi2024');
  });

  it('returns an empty string when the students are only in the site-wide domain', () => {
    expect(suggestMoveSource([row('system'), row('system')], '', domains)).toBe('');
    expect(suggestMoveSource([row('gone')], 'gone', domains)).toBe('');
  });
});
