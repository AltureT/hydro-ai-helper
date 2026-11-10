import { ObjectId } from 'mongodb';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { AuditLogModel } from '../../models/auditLog';
import { CreditEventModel } from '../../models/creditEvent';
import { AuditService } from '../../services/auditService';
import { CreditService } from '../../services/creditService';
import { DAY_MS } from '../../services/creditMath';

const NOW = new Date('2026-11-10T06:00:00Z');

function setup(options: { credit?: Record<string, unknown>; logs?: any[] } = {}) {
  const db = createFakeDb({
    user: createFakeCollection([
      { _id: 1031, uname: '2301张三', priv: 1 },
      { _id: 1032, uname: '2301李四', priv: 1 },
      { _id: 1200, uname: 'banned', priv: 0 },
      { _id: 2, uname: 'admin', priv: 3 },
    ]),
    ai_credit_events: createFakeCollection(),
    ai_audit_logs: createFakeCollection(),
  });
  let now = NOW;
  const configModel = { getConfig: jest.fn().mockResolvedValue({ quotaConfig: { dailyMessageLimit: 20, credit: options.credit } }) };
  const logs = options.logs || [];
  const safetyLogs = {
    findForUser: jest.fn(async (ids: any[], userId: number) => logs.filter((log) => log.userId === userId && ids.some((id) => String(id) === String(log._id)))),
  };
  const events = new CreditEventModel(db as any);
  const service = new CreditService(db as any, events, configModel, new AuditService(new AuditLogModel(db as any)), safetyLogs, () => now);
  return {
    db,
    service,
    safetyLogs,
    audit: () => db.store.ai_audit_logs?.docs || [],
    events: () => db.store.ai_credit_events?.docs || [],
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    now: () => now,
  };
}

const minutes = (n: number) => n * 60 * 1000;

describe('CreditService', () => {
  it('doubles realtime deductions within the hour and records k (FR-029)', async () => {
    const env = setup();
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await env.service.recordRealtimeDeduction({ uid: 1031, category: 'off_topic', safetyLogId: new ObjectId(), domainId: 'oi2023' }));
      env.advance(minutes(10));
    }
    expect(results).toEqual([{ deduction: 0.05, sequence: 1 }, { deduction: 0.1, sequence: 2 }, { deduction: 0.2, sequence: 3 }]);
    expect(env.events().map((event: any) => [event.source, event.category, event.domainId])).toEqual([
      ['realtime', 'off_topic', 'oi2023'], ['realtime', 'off_topic', 'oi2023'], ['realtime', 'off_topic', 'oi2023'],
    ]);
    expect(await env.service.getMultiplier(1031)).toBeCloseTo(0.65, 2);
  });

  it('starts counting again after the escalation window, and caps a single deduction', async () => {
    const env = setup();
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'prompt_injection' });
    expect(await env.service.recordRealtimeDeduction({ uid: 1031, category: 'prompt_injection' })).toEqual({ deduction: 0.4, sequence: 2 });
    env.advance(minutes(61));
    expect(await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking' })).toEqual({ deduction: 0.1, sequence: 1 });
  });

  it('does not count revoked deductions toward k, and skips categories weighted 0', async () => {
    const env = setup({ credit: { weights: { off_topic: 0 } } });
    const logId = new ObjectId();
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking', safetyLogId: logId });
    await env.service.revokeBySafetyLog(logId, 2);
    expect(await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking' })).toEqual({ deduction: 0.1, sequence: 1 });
    expect(await env.service.recordRealtimeDeduction({ uid: 1031, category: 'off_topic' })).toBeNull();
  });

  it('revokes the deduction linked to a false-positive safety record and audits it (FR-031, FR-059)', async () => {
    const env = setup();
    const logId = new ObjectId();
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking', safetyLogId: logId, domainId: 'oi2023' });
    expect(await env.service.getMultiplier(1031)).toBe(0.9);

    expect(await env.service.revokeBySafetyLog(logId, 2, 'oi2023')).toBe(1);
    expect(await env.service.getMultiplier(1031)).toBe(1);
    expect(env.events()[0]).toEqual(expect.objectContaining({ revokedBy: 2, revokeReason: 'false_positive' }));
    expect(env.audit()).toEqual([expect.objectContaining({
      action: 'credit.revoke',
      category: 'credit',
      actorUid: 2,
      domainId: 'oi2023',
      target: expect.objectContaining({ type: 'user', id: '1031', label: '2301张三' }),
      detail: expect.objectContaining({ uids: [1031], category: 'answer_seeking', deduction: 0.1 }),
    })]);

    // 再次复核同一条不会重复审计
    expect(await env.service.revokeBySafetyLog(logId, 2)).toBe(0);
    expect(env.audit()).toHaveLength(1);
    expect(await env.service.revokeBySafetyLog(new ObjectId(), 2)).toBe(0);
  });

  it('resets credit to 1.0 with a reason, skipping unknown users, and audits the previous values (FR-032)', async () => {
    const env = setup();
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'prompt_injection' });

    await expect(env.service.reset([1031], '  ', 2)).rejects.toMatchObject({ code: 'REASON_REQUIRED', status: 400 });
    await expect(env.service.reset([1031], 'x'.repeat(201), 2)).rejects.toMatchObject({ code: 'REASON_TOO_LONG' });
    await expect(env.service.reset([1], '误判较多', 2)).rejects.toMatchObject({ code: 'INVALID_UIDS' });

    const result = await env.service.reset([1031, 1032, 1200, 9999], '家长沟通后恢复', 2);
    expect(result).toEqual({ reset: [1031, 1032], missing: [1200, 9999] });
    expect(await env.service.getMultiplier(1031)).toBe(1);
    expect(env.audit()).toEqual([expect.objectContaining({
      action: 'credit.reset',
      target: expect.objectContaining({ id: 'batch:2', label: '2301张三, 2301李四' }),
      detail: expect.objectContaining({ uids: [1031, 1032], reason: '家长沟通后恢复', before: [{ uid: 1031, m: 0.75 }] }),
    })]);
  });

  it('summarizes a page of users in one query and lists users whose credit is still reduced', async () => {
    const env = setup();
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking' });
    await env.service.recordRealtimeDeduction({ uid: 1032, category: 'off_topic' });
    env.advance(2 * DAY_MS);

    const summaries = await env.service.getSummaries([1031, 1032, 1200]);
    expect(summaries.get(1031)).toEqual(expect.objectContaining({ reduced: false, m: 1 }));
    expect(summaries.get(1032)).toEqual(expect.objectContaining({ reduced: false, m: 1 }));
    expect(summaries.get(1200)).toEqual(expect.objectContaining({ reduced: false, m: 1, recoveryAt: null }));

    await env.service.recordRealtimeDeduction({ uid: 1032, category: 'prompt_injection' });
    expect(await env.service.reducedUids(undefined)).toEqual([1032]);
    expect(await env.service.reducedUids([1031])).toEqual([]);
  });

  it('shows students why their quota dropped, when it recovers, and whether they can appeal (FR-034)', async () => {
    const pending = new ObjectId();
    const appealed = new ObjectId();
    const confirmed = new ObjectId();
    const env = setup({
      logs: [
        { _id: pending, userId: 1031, reviewStatus: 'pending' },
        { _id: appealed, userId: 1031, reviewStatus: 'pending', studentAppealedAt: new Date() },
        { _id: confirmed, userId: 1031, reviewStatus: 'confirmed' },
      ],
    });
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'off_topic', safetyLogId: pending, domainId: 'oi2023' });
    env.advance(minutes(5));
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking', safetyLogId: appealed, domainId: 'oi2024' });
    env.advance(minutes(5));
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'prompt_injection', safetyLogId: confirmed });

    const status = await env.service.studentStatus(1031);
    expect(status.reduced).toBe(true);
    // 0.05 + 0.1 × 2 + min(0.4, 0.25 × 4) = 0.65
    expect(status.m).toBeCloseTo(0.35, 2);
    expect(Date.parse(status.recoveryAt as string)).toBeGreaterThan(env.now().getTime() + 11 * DAY_MS);
    expect(status.recentViolations.map((item) => [item.category, item.domainId, item.appealable, item.appealed])).toEqual([
      ['prompt_injection', undefined, false, false],
      ['answer_seeking', 'oi2024', false, true],
      ['off_topic', 'oi2023', true, false],
    ]);
    expect(env.safetyLogs.findForUser).toHaveBeenCalledWith(expect.any(Array), 1031);
    // 不含规则细节
    expect(JSON.stringify(status)).not.toMatch(/deduction|sequence|matched/);
  });

  it('lists nothing to students once their credit is back to normal or after a reset', async () => {
    const env = setup();
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking', safetyLogId: new ObjectId() });
    await env.service.reset([1031], '误判', 2);
    expect((await env.service.studentStatus(1031)).recentViolations).toEqual([]);
    env.advance(minutes(1));
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'off_topic' });
    const status = await env.service.studentStatus(1031);
    expect(status.recentViolations.map((item) => item.category)).toEqual(['off_topic']);
  });

  it('returns the recent credit records, newest first, including revoked ones and resets', async () => {
    const env = setup();
    const logId = new ObjectId();
    await env.service.recordRealtimeDeduction({ uid: 1031, category: 'answer_seeking', safetyLogId: logId, domainId: 'oi2023' });
    await env.service.revokeBySafetyLog(logId, 2);
    env.advance(minutes(1));
    await env.service.reset([1031], '手动恢复', 2);

    const detail = await env.service.detail(1031);
    expect(detail.events.map((event) => [event.type, event.source, event.revokedBy, event.reason])).toEqual([
      ['reset', 'manual', undefined, '手动恢复'],
      ['deduction', 'realtime', 2, undefined],
    ]);
    expect(detail.events[1]).toEqual(expect.objectContaining({ safetyLogId: String(logId), domainId: 'oi2023', deduction: 0.1, sequence: 1 }));
  });
});
