import { ReviewRunModel, REVIEW_RUN_LEASE_MS, REVIEW_RUN_RENEW_MS } from '../../models/reviewRun';
import { AIReviewScheduler, isDue, runAtMinutes, type SchedulerTimers } from '../../services/aiReviewScheduler';
import { createFakeDb } from '../helpers/fakeMongo';

// 02:00 Asia/Shanghai = 18:00 UTC the previous day
const beforeRun = new Date('2026-11-09T17:59:00.000Z');
const afterRun = new Date('2026-11-09T18:05:00.000Z');

function config(enabled = true, runAt = '02:00') {
  return { getConfig: jest.fn().mockResolvedValue({ quotaConfig: { timezone: 'Asia/Shanghai' }, aiReviewConfig: { enabled, runAt } }) };
}

function fakeTimers() {
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers: SchedulerTimers = {
    setInterval: (fn, ms) => { const entry = { fn, ms, cleared: false }; intervals.push(entry); return entry; },
    clearInterval: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  };
  return { timers, intervals };
}

/** startDaily 与真实服务一致：插入 daily:<配置时区日期> */
function stubService(runs: ReviewRunModel, clock: () => Date) {
  return {
    startDaily: jest.fn(async (owner: string) => {
      const id = 'daily:2026-11-10';
      return (await runs.tryCreate({ id, trigger: 'schedule', owner, now: clock(), date: '2026-11-10' })) ? id : null;
    }),
    execute: jest.fn(async (_id: string, _owner: string, _active?: () => boolean): Promise<'completed'> => 'completed'),
  };
}

describe('isDue / runAtMinutes', () => {
  it('compares the configured run time in the configured time zone', () => {
    expect(runAtMinutes('02:00')).toBe(120);
    expect(runAtMinutes('bad')).toBe(120);
    expect(isDue('02:00', 'Asia/Shanghai', beforeRun)).toBe(false);
    expect(isDue('02:00', 'Asia/Shanghai', afterRun)).toBe(true);
    expect(isDue('02:00', 'UTC', afterRun)).toBe(true);
    expect(isDue('19:00', 'UTC', afterRun)).toBe(false);
  });
});

describe('AIReviewScheduler (plan R9)', () => {
  it('does nothing before the run time or when disabled', async () => {
    const runs = new ReviewRunModel(createFakeDb() as any);
    let now = beforeRun;
    const service = stubService(runs, () => now);
    const { timers } = fakeTimers();
    await new AIReviewScheduler(service, runs, config(true), 'A', { clock: () => now, timers }).tick();
    now = afterRun;
    await new AIReviewScheduler(service, runs, config(false), 'A', { clock: () => now, timers }).tick();
    expect(service.startDaily).not.toHaveBeenCalled();
  });

  it('starts the daily run once across processes (duplicate key = lock)', async () => {
    const runs = new ReviewRunModel(createFakeDb() as any);
    const clock = () => afterRun;
    const serviceA = stubService(runs, clock);
    const serviceB = stubService(runs, clock);
    const a = new AIReviewScheduler(serviceA, runs, config(), 'A', { clock, timers: fakeTimers().timers });
    const b = new AIReviewScheduler(serviceB, runs, config(), 'B', { clock, timers: fakeTimers().timers });
    await Promise.all([a.tick(), b.tick()]);
    const executed = [...serviceA.execute.mock.calls, ...serviceB.execute.mock.calls];
    expect(executed).toHaveLength(1);
    expect(executed[0][0]).toBe('daily:2026-11-10');
  });

  it('renews the lease every 30 seconds and stops when it is lost', async () => {
    const runs = new ReviewRunModel(createFakeDb() as any);
    const clock = () => afterRun;
    const { timers, intervals } = fakeTimers();
    let activeDuringRun: (() => boolean) | undefined;
    const service = stubService(runs, clock);
    service.execute.mockImplementation(async (_id: string, _owner: string, active?: () => boolean) => {
      activeDuringRun = active;
      expect(intervals[0].ms).toBe(REVIEW_RUN_RENEW_MS);
      jest.spyOn(runs, 'renewLease').mockResolvedValueOnce(false);
      intervals[0].fn();
      await new Promise((resolve) => setImmediate(resolve));
      return 'completed' as const;
    });
    await new AIReviewScheduler(service, runs, config(), 'A', { clock, timers }).tick();
    expect(activeDuringRun?.()).toBe(false);
    expect(intervals[0].cleared).toBe(true);
  });

  it('takes over a run whose lease expired and resumes it', async () => {
    const runs = new ReviewRunModel(createFakeDb() as any);
    await runs.tryCreate({ id: 'manual:abc', trigger: 'manual', owner: 'crashed', now: afterRun });
    const later = new Date(afterRun.getTime() + REVIEW_RUN_LEASE_MS + 1000);
    const service = stubService(runs, () => later);
    // the daily run for today already exists, so only the takeover runs
    await runs.tryCreate({ id: 'daily:2026-11-10', trigger: 'schedule', owner: 'other', now: later, date: '2026-11-10' });
    await new AIReviewScheduler(service, runs, config(), 'B', { clock: () => later, timers: fakeTimers().timers }).tick();
    expect(service.execute).toHaveBeenCalledWith('manual:abc', 'B', expect.any(Function));
    expect((await runs.get('manual:abc'))?.leaseOwner).toBe('B');
  });

  it('waits while another run holds a valid lease', async () => {
    const runs = new ReviewRunModel(createFakeDb() as any);
    await runs.tryCreate({ id: 'manual:abc', trigger: 'manual', owner: 'other', now: afterRun });
    const service = stubService(runs, () => afterRun);
    await new AIReviewScheduler(service, runs, config(), 'A', { clock: () => afterRun, timers: fakeTimers().timers }).tick();
    expect(service.startDaily).not.toHaveBeenCalled();
  });

  it('does not start a new check while a manual run is executing in this process', async () => {
    const runs = new ReviewRunModel(createFakeDb() as any);
    const service = stubService(runs, () => afterRun);
    let release: () => void = () => undefined;
    service.execute.mockImplementationOnce(() => new Promise<'completed'>((resolve) => { release = () => resolve('completed'); }));
    const scheduler = new AIReviewScheduler(service, runs, config(), 'A', { clock: () => afterRun, timers: fakeTimers().timers });
    scheduler.runInBackground('manual:xyz');
    await scheduler.tick();
    expect(service.startDaily).not.toHaveBeenCalled();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.tick();
    expect(service.startDaily).toHaveBeenCalledTimes(1);
  });
});
