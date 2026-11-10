import { PRIV } from 'hydrooj';
import { ObjectId } from '../../utils/mongo';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { ReviewRunModel } from '../../models/reviewRun';
import { JailbreakLogModel } from '../../models/jailbreakLog';
import { CreditEventModel } from '../../models/creditEvent';
import { AuditLogModel } from '../../models/auditLog';
import { AuditService } from '../../services/auditService';
import { CreditService } from '../../services/creditService';
import { AIReviewService } from '../../services/aiReviewService';
import {
  MAX_MANUAL_REVIEW_USERS,
  ReviewAdminHandler,
  ReviewAdminHandlerPriv,
  ReviewAutoPenaltyHandler,
  ReviewRunHandler,
} from '../../handlers/reviewAdminHandler';

const conversationId = new ObjectId('6560f0000000000000000201');

function setup(configOverride: Record<string, unknown> = {}) {
  const db = createFakeDb({
    user: createFakeCollection([
      { _id: 2, uname: 'admin', unameLower: 'admin' },
      { _id: 1052, uname: '2302吴九', unameLower: '2302吴九' },
    ]),
    domain: createFakeCollection([{ _id: 'oi2023', name: '信息学 2023' }]),
    ai_conversations: createFakeCollection([
      { _id: conversationId, domainId: 'oi2023', userId: 1052, metadata: { problemTitle: 'A. 二维数组操作' } },
    ]),
  });
  const runs = new ReviewRunModel(db as any);
  const safetyLogs = new JailbreakLogModel(db as any, 180);
  const audit = new AuditService(new AuditLogModel(db as any));
  const configModel = {
    getConfig: jest.fn().mockResolvedValue({
      quotaConfig: { timezone: 'Asia/Shanghai' },
      aiReviewConfig: { enabled: true, runAt: '02:00' },
      scenarioModels: { aiReview: [{ endpointId: 'e1', modelName: 'review-model' }] },
      ...configOverride,
    }),
  };
  const creditEvents = new CreditEventModel(db as any);
  const service = new AIReviewService({
    db: db as any,
    runs,
    messages: { findByConversationId: jest.fn().mockResolvedValue([]) } as any,
    safetyLogs,
    creditEvents,
    credit: new CreditService(db as any, creditEvents, configModel, audit),
    configModel,
    audit,
    createClient: jest.fn(),
    estimateCost: () => 0,
  });
  const scheduler = { owner: 'worker-A', runInBackground: jest.fn() };
  const services: Record<string, unknown> = {
    reviewRunModel: runs, aiReviewService: service, aiReviewScheduler: scheduler,
    jailbreakLogModel: safetyLogs, aiConfigModel: configModel, auditService: audit,
  };
  return { db, runs, service, scheduler, services, safetyLogs };
}

function makeHandler<T extends { request: any; response: any; ctx: any; user?: any }>(
  HandlerClass: new () => T,
  env: ReturnType<typeof setup>,
  options: { body?: any; csrf?: boolean; admin?: boolean } = {},
): T {
  const handler = new HandlerClass();
  handler.request = {
    headers: options.csrf === false ? {} : { 'x-requested-with': 'XMLHttpRequest' },
    body: options.body || {},
    query: {},
  };
  handler.response = {};
  handler.user = { _id: 2, hasPriv: (priv: number) => (options.admin === false ? false : priv === PRIV.PRIV_EDIT_SYSTEM) };
  (handler as any).translate = (key: string) => key;
  handler.ctx = { get: (name: string) => env.services[name] };
  return handler;
}

describe('review admin handlers (US7)', () => {
  it('are system-admin only', async () => {
    expect(ReviewAdminHandlerPriv).toBe(PRIV.PRIV_EDIT_SYSTEM);
    const env = setup();
    const get = makeHandler(ReviewAdminHandler, env, { admin: false });
    await get.get();
    expect(get.response.status).toBe(403);
    const run = makeHandler(ReviewRunHandler, env, { admin: false });
    await run.post();
    expect(run.response.status).toBe(403);
    const noCsrf = makeHandler(ReviewAutoPenaltyHandler, env, { csrf: false, body: { enabled: false } });
    await noCsrf.post();
    expect(noCsrf.response.status).toBe(403);
    expect((await env.runs.getState()).autoPenaltyEnabled).toBe(true);
  });

  it('returns settings, breaker state, runs, the next run time and recent findings', async () => {
    const env = setup();
    await env.runs.tryCreate({ id: 'manual:1', trigger: 'manual', owner: 'worker-A', now: new Date(), requestedBy: 2, scopeLabel: '2302吴九' });
    await env.runs.markProcessed('manual:1', 'worker-A', String(conversationId), {
      flagged: 1, penalized: 1, tokens: { prompt: 900, completion: 100, total: 1000 }, costUSD: 0.0021,
    });
    await env.safetyLogs.create({
      domainId: 'oi2023', userId: 1052, conversationId, matchedPattern: 'ai_review', matchedText: '帮我写一份运动会的班级通讯稿',
      category: 'off_topic', confidence: 'high', detectionSource: 'ai_review', actionTaken: 'ai_review_penalty',
      reviewRunId: 'manual:1', evidence: [{ ref: 'm3', snippet: '帮我写一份运动会的班级通讯稿', verified: true }],
      evidenceVerified: true, autoPenalized: true, reviewReason: '与题目无关',
    });
    const handler = makeHandler(ReviewAdminHandler, env);
    await handler.get();
    const body = handler.response.body;
    expect(body.config).toMatchObject({ enabled: true, runAt: '02:00', sampleRate: 0.05, maxConversations: 200 });
    expect(body.modelConfigured).toBe(true);
    expect(body.state).toEqual({ autoPenaltyEnabled: true });
    expect(body.breaker).toMatchObject({ window: 50, sample: 0, minSample: 10, threshold: 0.2 });
    expect(typeof body.nextRunAt).toBe('string');
    expect(body.monthCost).toEqual({ totalTokens: 1000, totalCost: 0.0021, runCount: 1 });
    expect(body.runs[0]).toMatchObject({
      id: 'manual:1', trigger: 'manual', scopeLabel: '2302吴九', requestedByName: 'admin', status: 'running',
      candidateCount: null, processedCount: 1, flaggedCount: 1, penalizedCount: 1,
    });
    expect(body.findings[0]).toMatchObject({
      uname: '2302吴九', domainName: '信息学 2023', problemTitle: 'A. 二维数组操作', category: 'off_topic',
      confidence: 'high', autoPenalized: true, evidenceVerified: true, reason: '与题目无关', reviewStatus: 'pending',
      conversationId: String(conversationId),
      evidence: [{ ref: 'm3', snippet: '帮我写一份运动会的班级通讯稿', verified: true }],
    });
  });

  it('reports no next run when the daily review is disabled', async () => {
    const env = setup({ aiReviewConfig: { enabled: false } });
    const handler = makeHandler(ReviewAdminHandler, env);
    await handler.get();
    expect(handler.response.body.nextRunAt).toBeNull();
    expect(handler.response.body.modelConfigured).toBe(true);
  });

  it('starts a manual run for named students and audits it', async () => {
    const env = setup();
    const handler = makeHandler(ReviewRunHandler, env, { body: { unames: '2302吴九' } });
    await handler.post();
    expect(handler.response.body).toMatchObject({ success: true });
    const runId = handler.response.body.runId;
    expect(runId).toMatch(/^manual:[0-9a-f]{24}$/);
    expect(env.scheduler.runInBackground).toHaveBeenCalledWith(runId);
    expect(await env.runs.get(runId)).toMatchObject({ trigger: 'manual', requestedBy: 2, scope: { uids: [1052] }, scopeLabel: '2302吴九' });
    const audits = env.db.collection('ai_audit_logs').docs;
    expect(audits[0]).toMatchObject({ action: 'review.run', actorUid: 2, target: { type: 'review', id: runId } });
  });

  it('rejects unknown students, too many names and bad conversation ids', async () => {
    const env = setup();
    const missing = makeHandler(ReviewRunHandler, env, { body: { unames: ['2302吴九', 'ghost'] } });
    await missing.post();
    expect(missing.response.status).toBe(400);
    expect(missing.response.body).toMatchObject({ code: 'USERS_NOT_FOUND', missing: ['ghost'] });

    const many = makeHandler(ReviewRunHandler, env, {
      body: { unames: Array.from({ length: MAX_MANUAL_REVIEW_USERS + 1 }, (_, i) => `u${i}`) },
    });
    await many.post();
    expect(many.response.body).toMatchObject({ code: 'TOO_MANY_USERS' });

    const bad = makeHandler(ReviewRunHandler, env, { body: { conversationIds: ['nope'] } });
    await bad.post();
    expect(bad.response.body).toMatchObject({ code: 'INVALID_CONVERSATION' });
    expect(env.scheduler.runInBackground).not.toHaveBeenCalled();
  });

  it('returns 409 while another run is active', async () => {
    const env = setup();
    await makeHandler(ReviewRunHandler, env).post();
    const second = makeHandler(ReviewRunHandler, env);
    await second.post();
    expect(second.response.status).toBe(409);
    expect(second.response.body).toMatchObject({ code: 'REVIEW_RUNNING' });
  });

  it('disables and resumes auto-penalty with validation', async () => {
    const env = setup();
    const invalid = makeHandler(ReviewAutoPenaltyHandler, env, { body: { enabled: 'no' } });
    await invalid.post();
    expect(invalid.response.body).toMatchObject({ code: 'INVALID_ENABLED' });

    const disable = makeHandler(ReviewAutoPenaltyHandler, env, { body: { enabled: false } });
    await disable.post();
    expect(disable.response.body).toEqual({ success: true, autoPenaltyEnabled: false });
    const resume = makeHandler(ReviewAutoPenaltyHandler, env, { body: { enabled: true } });
    await resume.post();
    expect(resume.response.body).toEqual({ success: true, autoPenaltyEnabled: true });
    expect(env.db.collection('ai_audit_logs').docs.map((doc: any) => doc.action))
      .toEqual(['review.auto_penalty_disable', 'review.auto_penalty_resume']);
  });
});
