import { ReviewRunModel, REVIEW_RUN_LEASE_MS } from '../../models/reviewRun';
import { ObjectId } from '../../utils/mongo';
import { createFakeDb } from '../helpers/fakeMongo';

const now = new Date('2026-11-09T18:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms);

function setup() {
  const db = createFakeDb();
  const model = new ReviewRunModel(db as any);
  return { db, model, coll: db.store.ai_review_runs || db.collection('ai_review_runs') };
}

describe('ReviewRunModel', () => {
  it('creates a daily run once; the duplicate key means another process owns it', async () => {
    const { model } = setup();
    expect(await model.tryCreate({ id: 'daily:2026-11-10', trigger: 'schedule', owner: 'A', now, date: '2026-11-10' })).toBe(true);
    expect(await model.tryCreate({ id: 'daily:2026-11-10', trigger: 'schedule', owner: 'B', now })).toBe(false);
    const run = await model.get('daily:2026-11-10');
    expect(run).toMatchObject({
      kind: 'run', trigger: 'schedule', status: 'running', candidates: null, processedIds: [],
      leaseOwner: 'A', leaseExpiresAt: later(REVIEW_RUN_LEASE_MS), flaggedCount: 0,
    });
  });

  it('lets another process take over only after the lease expires', async () => {
    const { model } = setup();
    await model.tryCreate({ id: 'daily:2026-11-10', trigger: 'schedule', owner: 'A', now });
    expect(await model.claimExpired('daily:2026-11-10', 'B', later(1000))).toBe(false);
    expect(await model.hasActiveRun(later(1000))).toBe(true);

    const expiredAt = later(REVIEW_RUN_LEASE_MS + 1);
    expect(await model.findExpiredRunning(expiredAt)).toHaveLength(1);
    expect(await model.hasActiveRun(expiredAt)).toBe(false);
    expect(await model.claimExpired('daily:2026-11-10', 'B', expiredAt)).toBe(true);
    // A lost the lease: renewals and writes fail
    expect(await model.renewLease('daily:2026-11-10', 'A', expiredAt)).toBe(false);
    expect(await model.renewLease('daily:2026-11-10', 'B', expiredAt)).toBe(true);
    expect(await model.markProcessed('daily:2026-11-10', 'A', 'c1', { flagged: 1 })).toBe(false);
  });

  it('counts each processed conversation once and finishes the run', async () => {
    const { model } = setup();
    await model.tryCreate({ id: 'manual:1', trigger: 'manual', owner: 'A', now, requestedBy: 2 });
    const candidates = [{ conversationId: new ObjectId(), domainId: 'oi2023', userId: 1031, reason: 'manual' as const }];
    expect(await model.setCandidates('manual:1', 'A', candidates)).toBe(true);
    const progress = { flagged: 1, penalized: 1, tokens: { prompt: 900, completion: 100, total: 1000 }, costUSD: 0.002 };
    expect(await model.markProcessed('manual:1', 'A', 'c1', progress)).toBe(true);
    expect(await model.markProcessed('manual:1', 'A', 'c1', progress)).toBe(false);
    expect(await model.markProcessed('manual:1', 'A', 'c2', { failed: 1 })).toBe(true);
    expect(await model.finish('manual:1', 'A', 'completed', later(5000))).toBe(true);

    const [listed] = await model.list();
    expect(listed).toMatchObject({
      _id: 'manual:1', status: 'completed', candidateCount: 1, processedCount: 2,
      flaggedCount: 1, penalizedCount: 1, failedCount: 1,
      tokens: { prompt: 900, completion: 100, total: 1000 }, estimatedCostUSD: 0.002, finishedAt: later(5000),
    });
    expect(listed).not.toHaveProperty('candidates');
    expect(await model.finish('manual:1', 'A', 'failed', later(6000))).toBe(false);
  });

  it('defaults to auto-penalty enabled; trips once; only an admin re-enables it', async () => {
    const { model } = setup();
    expect(await model.getState()).toEqual({ _id: 'state', kind: 'state', autoPenaltyEnabled: true });
    const stats = { window: 50, sample: 10, falsePositives: 2, rate: 0.2 };
    expect(await model.trip(stats, now)).toBe(true);
    expect(await model.trip(stats, later(1000))).toBe(false);
    expect(await model.getState()).toMatchObject({ autoPenaltyEnabled: false, trippedAt: now, trippedStats: stats });

    const resumed = await model.setAutoPenalty(true, 2, later(2000));
    expect(resumed).toMatchObject({ autoPenaltyEnabled: true, resumedAt: later(2000), resumedBy: 2 });
    const disabled = await model.setAutoPenalty(false, 2, later(3000));
    expect(disabled).toMatchObject({ autoPenaltyEnabled: false, disabledAt: later(3000), disabledBy: 2 });
    expect(disabled).not.toHaveProperty('trippedAt');
    // the state document is not listed as a run
    expect(await model.list()).toEqual([]);
  });
});
