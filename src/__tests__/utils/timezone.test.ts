import {
  DEFAULT_TIMEZONE, dateKey, isValidTimezone, minutesOfDay, nextResetAt, previousDateKey, resolveTimezone, startOfDay,
} from '../../utils/timezone';

describe('timezone utils', () => {
  it('computes the local date across UTC midnight', () => {
    // 2026-03-01 17:30 UTC = 2026-03-02 01:30 in Shanghai
    const instant = new Date('2026-03-01T17:30:00Z');
    expect(dateKey('Asia/Shanghai', instant)).toBe('2026-03-02');
    expect(dateKey('UTC', instant)).toBe('2026-03-01');
  });

  it('returns the next local midnight in Shanghai', () => {
    const instant = new Date('2026-03-01T17:30:00Z');
    expect(nextResetAt('Asia/Shanghai', instant).toISOString()).toBe('2026-03-02T16:00:00.000Z');
  });

  it('handles the day before and the day of a DST change', () => {
    // New York switches to EDT at 02:00 on 2026-03-08
    const beforeSwitch = new Date('2026-03-07T17:00:00Z'); // 12:00 EST
    expect(nextResetAt('America/New_York', beforeSwitch).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    const afterSwitch = new Date('2026-03-08T16:00:00Z'); // 12:00 EDT
    expect(nextResetAt('America/New_York', afterSwitch).toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(dateKey('America/New_York', afterSwitch)).toBe('2026-03-08');
  });

  it('returns a reset time strictly after now even right before midnight', () => {
    const instant = new Date('2026-03-02T15:59:59Z'); // 23:59:59 Shanghai
    const reset = nextResetAt('Asia/Shanghai', instant);
    expect(reset.getTime()).toBeGreaterThan(instant.getTime());
    expect(reset.toISOString()).toBe('2026-03-02T16:00:00.000Z');
  });

  it('falls back to the default timezone for invalid names', () => {
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(resolveTimezone('Mars/Olympus')).toBe(DEFAULT_TIMEZONE);
    const instant = new Date('2026-03-01T17:30:00Z');
    expect(dateKey('Mars/Olympus', instant)).toBe(dateKey(DEFAULT_TIMEZONE, instant));
  });
});

describe('time-of-day helpers (AI review schedule)', () => {
  it('returns the local minutes since midnight', () => {
    const instant = new Date('2026-11-09T18:05:00Z'); // 02:05 Shanghai
    expect(minutesOfDay('Asia/Shanghai', instant)).toBe(125);
    expect(minutesOfDay('UTC', instant)).toBe(18 * 60 + 5);
  });

  it('returns the local start of day and the previous date key', () => {
    const instant = new Date('2026-11-09T18:05:00Z');
    expect(startOfDay('Asia/Shanghai', instant).toISOString()).toBe('2026-11-09T16:00:00.000Z');
    expect(previousDateKey('Asia/Shanghai', instant)).toBe('2026-11-09');
    const midnight = new Date('2026-11-09T16:00:00Z');
    expect(startOfDay('Asia/Shanghai', midnight).toISOString()).toBe('2026-11-09T16:00:00.000Z');
  });

  it('handles daylight-saving days', () => {
    const afterSwitch = new Date('2026-03-08T15:00:00Z'); // 11:00 New York, DST started at 02:00
    expect(startOfDay('America/New_York', afterSwitch).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(previousDateKey('America/New_York', afterSwitch)).toBe('2026-03-07');
  });
});
