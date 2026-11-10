import {
  mergeSnapshot,
  quotaBlock,
  refreshDelayMs,
  remainingPercent,
  resetLabel,
  shouldShowQuotaBar,
} from '../../../frontend/student/quotaView';

const base = { limit: 20, used: 8, remaining: 12, resetAt: '2026-11-10T16:00:00.000Z' };

describe('student quota view', () => {
  it('distinguishes admin-disabled from exhausted', () => {
    expect(quotaBlock(null)).toBeNull();
    expect(quotaBlock(base)).toBeNull();
    expect(quotaBlock({ ...base, used: 20, remaining: 0 })).toBe('exhausted');
    expect(quotaBlock({ ...base, limit: 0, remaining: 0, disabled: true })).toBe('disabled');
    expect(quotaBlock({ ...base, limit: null, remaining: null })).toBeNull();
  });

  it('hides the bar only when unlimited and not disabled', () => {
    expect(shouldShowQuotaBar(base)).toBe(true);
    expect(shouldShowQuotaBar({ ...base, limit: null, remaining: null })).toBe(false);
    expect(shouldShowQuotaBar({ ...base, limit: 0, remaining: 0, disabled: true })).toBe(true);
    expect(shouldShowQuotaBar(null)).toBe(false);
  });

  it('computes the remaining percentage', () => {
    expect(remainingPercent(base)).toBe(60);
    expect(remainingPercent({ ...base, remaining: 0 })).toBe(0);
    expect(remainingPercent({ ...base, limit: null, remaining: null })).toBe(0);
  });

  it('labels the reset time relative to the local day', () => {
    const now = new Date(2026, 10, 10, 20, 0);
    expect(resetLabel(new Date(2026, 10, 11, 0, 0).toISOString(), now)).toEqual({ kind: 'tomorrow', time: '00:00', date: '11-11' });
    expect(resetLabel(new Date(2026, 10, 10, 23, 30).toISOString(), now)).toEqual({ kind: 'today', time: '23:30', date: '11-10' });
    expect(resetLabel(new Date(2026, 10, 12, 0, 0).toISOString(), now)?.kind).toBe('date');
    expect(resetLabel('not a date', now)).toBeNull();
  });

  it('merges a chat snapshot and clears the disabled flag', () => {
    expect(mergeSnapshot({ ...base, timezone: 'Asia/Shanghai', disabled: true }, { ...base, used: 9, remaining: 11 }))
      .toEqual({ ...base, used: 9, remaining: 11, timezone: 'Asia/Shanghai', disabled: false });
    expect(mergeSnapshot(null, base)).toEqual({ ...base, disabled: false });
  });

  it('schedules a refresh just after the reset', () => {
    const now = new Date('2026-11-10T15:00:00.000Z');
    expect(refreshDelayMs(base.resetAt, now)).toBe(60 * 60 * 1000 + 2000);
    expect(refreshDelayMs('2026-11-10T14:00:00.000Z', now)).toBeNull();
    expect(refreshDelayMs('2026-11-20T00:00:00.000Z', now)).toBeNull();
  });
});
