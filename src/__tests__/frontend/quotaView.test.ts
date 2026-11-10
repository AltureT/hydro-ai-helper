import {
  creditReduction,
  dismissNotice,
  markAppealed,
  noticeProblemUrl,
  violationTimeLabel,
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

describe('student credit view (FR-034)', () => {
  const now = new Date('2026-11-10T04:00:00Z');
  const credit = {
    m: 0.95,
    reduced: true,
    recoveryAt: '2026-11-11T02:14:00.000Z',
    recentViolations: [
      { category: 'off_topic' as const, at: '2026-11-10T02:14:00.000Z', source: 'ai_review' as const, safetyEventId: 'a', appealable: true, appealed: false },
      { category: 'answer_seeking' as const, at: '2026-11-08T02:14:00.000Z', source: 'realtime' as const, safetyEventId: 'b', appealable: false, appealed: true },
    ],
  };

  it('explains a reduced limit with the base, the new limit and the days to recover', () => {
    expect(creditReduction({ ...base, limit: 19, base: 20, credit }, now)).toEqual({ from: 20, to: 19, recoveryDays: 1 });
    expect(creditReduction({ ...base, limit: 19, base: 20, credit: { ...credit, recoveryAt: null } }, now)).toEqual({ from: 20, to: 19, recoveryDays: null });
  });

  it('says nothing when credit does not lower today\'s limit', () => {
    expect(creditReduction({ ...base, limit: 20, base: 20, credit }, now)).toBeNull();
    expect(creditReduction({ ...base, limit: null, base: null, credit }, now)).toBeNull();
    expect(creditReduction({ ...base, limit: 0, base: 0, disabled: true, credit }, now)).toBeNull();
    expect(creditReduction({ ...base, limit: 15, base: 20, credit: { ...credit, reduced: false } }, now)).toBeNull();
    expect(creditReduction({ ...base, limit: 15, base: 20 }, now)).toBeNull();
  });

  it('labels violation times relative to today', () => {
    const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
    const today = new Date(2026, 10, 10, 12, 0);
    expect(violationTimeLabel(local(2026, 11, 10, 2, 14), today)).toEqual({ kind: 'today', time: '02:14', date: '11-10' });
    expect(violationTimeLabel(local(2026, 11, 9, 23, 5), today)).toEqual(expect.objectContaining({ kind: 'yesterday', time: '23:05' }));
    expect(violationTimeLabel(local(2026, 11, 3, 8, 0), today)).toEqual(expect.objectContaining({ kind: 'date', date: '11-03' }));
    expect(violationTimeLabel('nope', today)).toBeNull();
  });

  it('marks an appealed violation locally', () => {
    const next = markAppealed({ ...base, credit }, 'a');
    expect(next?.credit?.recentViolations[0]).toEqual(expect.objectContaining({ appealable: false, appealed: true }));
    expect(markAppealed({ ...base }, 'a')).toEqual({ ...base });
  });
});

describe('student AI review notices (FR-046)', () => {
  const notices = [
    { id: 'n1', category: 'off_topic' as const, at: '2026-11-09T18:14:00.000Z', domainId: 'oi2023', problemId: 'P1000', safetyEventId: 's1', appealable: true, appealed: false },
    { id: 'n2', category: 'answer_seeking' as const, at: '2026-11-08T18:14:00.000Z', domainId: 'system', problemId: '1001', safetyEventId: 's2', appealable: true, appealed: false },
  ];

  it('marks an appealed notice and its credit violation together', () => {
    const credit = { m: 0.95, reduced: true, recoveryAt: null, recentViolations: [
      { category: 'off_topic' as const, at: notices[0].at, source: 'ai_review' as const, safetyEventId: 's1', appealable: true, appealed: false },
    ] };
    const next = markAppealed({ ...base, credit, notices }, 's1');
    expect(next?.notices?.[0]).toMatchObject({ appealable: false, appealed: true });
    expect(next?.notices?.[1]).toMatchObject({ appealable: true });
    expect(next?.credit?.recentViolations[0]).toMatchObject({ appealed: true });
  });

  it('removes a dismissed notice locally', () => {
    expect(dismissNotice({ ...base, notices }, 'n1')?.notices?.map((n) => n.id)).toEqual(['n2']);
    expect(dismissNotice({ ...base }, 'n1')).toEqual({ ...base });
    expect(dismissNotice(null, 'n1')).toBeNull();
  });

  it('links to the problem where it happened', () => {
    expect(noticeProblemUrl(notices[0])).toBe('/d/oi2023/p/P1000');
    expect(noticeProblemUrl(notices[1])).toBe('/p/1001');
    expect(noticeProblemUrl({ domainId: 'oi2023' })).toBeNull();
  });
});
