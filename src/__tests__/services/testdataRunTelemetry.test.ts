import { createHmac } from 'crypto';
import {
  TESTDATA_PROMPT_VERSION,
  TestdataRunTelemetryService,
  computeOriginalFileHashes,
  createTestdataRunId,
  parseTestdataQualityEvent,
  type TestdataQualityEvent,
} from '../../services/testdata/runTelemetry';
import { TestdataPipelineError } from '../../services/testdata/failures';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';

function baseEvent(overrides: Partial<TestdataQualityEvent> = {}): TestdataQualityEvent {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    runId: RUN_ID,
    sequence: 1,
    eventType: 'run_started',
    occurredAt: '2026-08-19T00:00:00.000Z',
    pluginVersion: '3.1.0',
    promptVersion: TESTDATA_PROMPT_VERSION,
    ...overrides,
  };
}

describe('test-data quality event schema', () => {
  it('accepts only the closed run lifecycle contract', () => {
    expect(parseTestdataQualityEvent(baseEvent({
      generationMode: 'sandbox',
      reliabilityMode: 'observe',
      riskTier: 'high',
      problemKind: 'function',
      hasSubtasks: true,
      hasCustomChecker: true,
      hasSamples: true,
      hasStatefulOperations: false,
      statementLengthBucket: '4k-16k',
      templateLanguagesRequested: ['py', 'java', 'cc'],
      checkerConfigured: true,
      modelRole: 'primary',
      modelIdentityHash: 'a'.repeat(64),
    }))).toEqual(expect.objectContaining({ runId: RUN_ID, riskTier: 'high' }));

    expect(parseTestdataQualityEvent(baseEvent({
      eventId: '33333333-3333-4333-8333-333333333333',
      sequence: 2,
      eventType: 'stage_completed',
      stage: 'solution_verification',
      durationMs: 123,
      attempt: 1,
      tokenCount: 456,
    }))).toEqual(expect.objectContaining({ eventType: 'stage_completed' }));

    expect(parseTestdataQualityEvent(baseEvent({
      eventId: '44444444-4444-4444-8444-444444444444',
      sequence: 3,
      eventType: 'stage_failed',
      stage: 'checker',
      failureCode: 'CHECKER_RUNTIME_FAILED',
      artifact: 'checker',
      retryPolicy: 'manual-review',
    }))).toEqual(expect.objectContaining({ failureCode: 'CHECKER_RUNTIME_FAILED' }));

    expect(parseTestdataQualityEvent(baseEvent({
      eventId: '55555555-5555-4555-8555-555555555555',
      sequence: 4,
      eventType: 'run_completed',
      generationMode: 'sandbox',
      pipelineCompleted: true,
      verified: false,
      wouldBlock: true,
      modelEscalated: true,
      stressGenerated: 60,
      stressValid: 58,
      stressDroppedInvalid: 2,
      stressUnique: 57,
      stressCompared: 58,
      stressAgreed: 58,
      templateLanguagesRequested: ['py', 'java', 'cc'],
      templateLanguagesVerified: ['py', 'cc'],
      templateFailureKinds: ['runtime'],
      checkerConfigured: true,
      checkerRead: true,
      checkerCompiled: true,
      checkerExecuted: false,
      checkerInfraFailures: 1,
      checkerFailureKind: 'infra',
    }))).toEqual(expect.objectContaining({ verified: false, wouldBlock: true }));

    expect(parseTestdataQualityEvent(baseEvent({
      eventId: '66666666-6666-4666-8666-666666666666',
      sequence: 5,
      eventType: 'teacher_outcome',
      teacherOutcome: 'accepted_edited',
      editedFileCount: 2,
      changedFileKinds: ['case-in', 'config'],
    }))).toEqual(expect.objectContaining({ teacherOutcome: 'accepted_edited' }));
  });

  it.each([
    ['problemId', 'D3102'],
    ['problemDocId', 1530],
    ['jobId', 'job-secret'],
    ['title', 'secret title'],
    ['statement', '# secret statement'],
    ['code', 'print(secret)'],
    ['input', 'secret input'],
    ['output', 'secret output'],
    ['apiBase', 'https://private.example/v1'],
    ['apiKey', 'sk-secret'],
    ['stderr', 'secret stderr'],
    ['stdout', 'secret stdout'],
    ['message', 'raw error'],
    ['metadata', { arbitrary: 'secret' }],
  ])('rejects forbidden or arbitrary field %s', (key, value) => {
    expect(() => parseTestdataQualityEvent({ ...baseEvent(), [key]: value }))
      .toThrow(/unknown field/i);
  });

  it.each([
    ['runId', 'not-a-uuid'],
    ['eventId', 'not-a-uuid'],
    ['sequence', -1],
    ['sequence', Number.NaN],
    ['durationMs', Number.POSITIVE_INFINITY],
    ['durationMs', 86_400_001],
    ['stressGenerated', -1],
    ['stressGenerated', 1_000_001],
    ['attempt', 11],
    ['riskTier', 'critical'],
    ['stage', 'arbitrary-private-stage'],
    ['failureCode', 'RAW_ERROR_MESSAGE'],
  ])('rejects invalid bounded field %s', (key, value) => {
    const event = baseEvent({
      eventType: key === 'stage' || key === 'failureCode' ? 'stage_failed' : 'run_completed',
      pipelineCompleted: true,
      verified: true,
      wouldBlock: false,
      stage: 'checker',
      failureCode: 'CHECKER_RUNTIME_FAILED',
      artifact: 'checker',
      retryPolicy: 'manual-review',
      [key]: value,
    } as Partial<TestdataQualityEvent>);
    expect(() => parseTestdataQualityEvent(event)).toThrow();
  });

  it('rejects oversized, duplicated, or unknown arrays', () => {
    expect(() => parseTestdataQualityEvent(baseEvent({
      templateLanguagesRequested: ['py', 'java', 'cc', 'py'] as never,
    }))).toThrow();
    expect(() => parseTestdataQualityEvent(baseEvent({
      templateLanguagesRequested: ['py', 'rust'] as never,
    }))).toThrow();
    expect(() => parseTestdataQualityEvent(baseEvent({
      eventType: 'teacher_outcome',
      teacherOutcome: 'accepted_edited',
      editedFileCount: 9,
      changedFileKinds: Array(10).fill('case-in') as never,
    }))).toThrow();
  });

  it('rejects parseable but non-canonical timestamps', () => {
    for (const occurredAt of [
      'August 19, 2026 00:00:00 UTC',
      '2026-08-19T00:00:00Z',
      '2026-08-19T08:00:00.000+08:00',
    ]) {
      expect(() => parseTestdataQualityEvent(baseEvent({ occurredAt }))).toThrow(/occurredAt/);
    }
  });

  it('enforces event-specific fields and teacher outcome reasons', () => {
    expect(() => parseTestdataQualityEvent(baseEvent({
      eventType: 'stage_failed',
      stage: 'checker',
    }))).toThrow();
    expect(() => parseTestdataQualityEvent(baseEvent({
      eventType: 'run_completed',
      pipelineCompleted: true,
      verified: undefined,
      wouldBlock: true,
    }))).toThrow();
    for (const invalid of [
      { pipelineCompleted: false, verified: true, wouldBlock: false },
      { pipelineCompleted: false, verified: false, wouldBlock: true },
    ]) {
      expect(() => parseTestdataQualityEvent(baseEvent({
        eventType: 'run_completed',
        ...invalid,
      }))).toThrow(/pipelineCompleted/);
    }
    expect(() => parseTestdataQualityEvent(baseEvent({
      eventType: 'teacher_outcome',
      teacherOutcome: 'accepted_unchanged',
      teacherOutcomeReason: 'wrong_answer',
    }))).toThrow();
    expect(parseTestdataQualityEvent(baseEvent({
      eventType: 'teacher_outcome',
      teacherOutcome: 'discarded',
      teacherOutcomeReason: 'weak_coverage',
    })).teacherOutcomeReason).toBe('weak_coverage');
  });
});

describe('TestdataRunTelemetryService', () => {
  const install = {
    instanceId: '77777777-7777-4777-8777-777777777777',
    lastVersion: '3.1.0',
    telemetryEnabled: true,
    testdataTelemetryHmacKey: 'b'.repeat(64),
  };

  it('uses independent random UUIDs and deterministic server-side file hashes', () => {
    const first = createTestdataRunId();
    const second = createTestdataRunId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(first).not.toBe('D3102');
    expect(computeOriginalFileHashes([
      { name: '1.in', content: '1\n' },
      { name: '1.out', content: '2\n' },
    ])).toEqual({
      '1.in': '4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865',
      '1.out': '53c234e5e8472b6ac51c1ae1cab3fe06fad053beb8ebfd8977b010655bfdd3c3',
    });
  });

  it('sends no request when telemetry is disabled or install lookup fails', async () => {
    const send = jest.fn();
    const disabled = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue({ ...install, telemetryEnabled: false }) },
      { send },
    );
    const broken = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockRejectedValue(new Error('db down')) },
      { send },
    );
    await disabled.emit(baseEvent());
    await broken.emit(baseEvent());
    expect(send).not.toHaveBeenCalled();
  });

  it('never rejects when a legacy caller lacks a valid run id', async () => {
    const send = jest.fn();
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue(install) },
      { send },
    );
    const session = service.createSession({ runId: undefined as never });
    await expect(session.start()).resolves.toBe(false);
    await expect(session.progress({ stage: 'blueprint', percent: 10, attempt: 1 })).resolves.toBe(false);
    await expect(session.complete({
      verification: { mode: 'sandbox', verified: true, wouldBlock: false },
    })).resolves.toBeUndefined();
    await expect(service.emitTeacherOutcome({
      runId: undefined as never,
      outcome: 'discarded',
    })).resolves.toBe(false);
    await expect(service.emitApplyFailure(undefined as never)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reuses a persisted apply-failure event id so retries remain idempotent', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    let now = Date.parse('2026-08-19T00:00:00.000Z');
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue(install) },
      { send, now: () => now },
    );
    const occurredAt = new Date(now);

    await service.emitApplyFailure(RUN_ID, EVENT_ID, occurredAt);
    now += 60_000;
    await service.emitApplyFailure(RUN_ID, EVENT_ID, occurredAt);

    expect(send).toHaveBeenCalledTimes(2);
    const events = send.mock.calls.map(call => call[0].events[0]);
    expect(events[0]).toEqual(events[1]);
    expect(events[0]).toEqual(expect.objectContaining({
      eventId: EVENT_ID,
      sequence: 999_999,
      occurredAt: '2026-08-19T00:00:00.000Z',
    }));
  });

  it('keeps reporting best-effort and never exposes the raw model identity', async () => {
    const send = jest.fn().mockRejectedValue(new Error('network down'));
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue(install) },
      { send },
    );
    await expect(service.emit(baseEvent(), {
      modelRole: 'fallback',
      modelIdentity: 'private-endpoint/private-model',
    })).resolves.toBe(false);
    await expect(service.emit(baseEvent({
      eventId: '88888888-8888-4888-8888-888888888888',
    }), {
      modelRole: 'fallback',
      modelIdentity: 'private-endpoint/private-model',
    })).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    const payload = send.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain('private-endpoint');
    expect(JSON.stringify(payload)).not.toContain('private-model');
    expect(payload.events[0]).toEqual(expect.objectContaining({
      modelRole: 'fallback',
      modelIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(send.mock.calls[1][0].events[0].modelIdentityHash)
      .toBe(payload.events[0].modelIdentityHash);
    expect(payload.events[0].modelIdentityHash).not.toBe(createHmac(
      'sha256', install.instanceId,
    ).update('fallback\0private-endpoint/private-model', 'utf8').digest('hex'));
  });

  it('omits model identity when the private HMAC secret is unavailable', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue({
        instanceId: install.instanceId,
        lastVersion: install.lastVersion,
        telemetryEnabled: true,
      }) },
      { send },
    );
    await expect(service.emit(baseEvent(), {
      modelRole: 'primary', modelIdentity: 'private-model',
    })).resolves.toBe(true);
    expect(send.mock.calls[0][0].events[0]).not.toHaveProperty('modelIdentityHash');
    expect(send.mock.calls[0][0].events[0]).not.toHaveProperty('modelRole');
  });

  it('creates monotonic run events and emits typed failure without raw errors', async () => {
    const payloads: Array<{ events: TestdataQualityEvent[] }> = [];
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue(install) },
      { send: jest.fn(async payload => { payloads.push(payload); }) },
    );
    const session = service.createSession({
      runId: RUN_ID,
      reliabilityMode: 'observe',
      riskTier: 'medium',
      hasSamples: true,
      templateLanguagesRequested: ['py'],
    });
    await session.start();
    await session.progress({ stage: 'blueprint', percent: 10, attempt: 1 }, 1000);
    await session.progress({ stage: 'solution_verification', percent: 30, attempt: 1 }, 1250);
    await session.fail(new Error('raw input/output secret'));

    const events = payloads.flatMap(payload => payload.events);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map(event => event.eventType)).toEqual([
      'run_started', 'stage_completed', 'run_completed',
    ]);
    expect(JSON.stringify(events)).not.toContain('raw input/output secret');
  });

  it('reports authoritative verified, template, checker, stress, and fallback completion', async () => {
    const payloads: Array<{ events: TestdataQualityEvent[] }> = [];
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue(install) },
      { send: jest.fn(async payload => { payloads.push(payload); }) },
    );
    const session = service.createSession({
      runId: RUN_ID,
      templateLanguagesRequested: ['py', 'java', 'cc'],
      checkerConfigured: true,
      checkerRead: true,
    });
    await session.start();
    await session.complete({
      problemType: 'function',
      usedModel: 'primary-private → fallback-private',
      verification: {
        mode: 'sandbox',
        verified: true,
        wouldBlock: false,
        modelEscalation: { fromModel: 'primary-private', toModel: 'fallback-private' },
        stressCheck: {
          generated: 20, droppedInvalid: 2, uniqueInputs: 17, compared: 18, agreed: 18,
        },
        templateLanguages: ['py', 'java', 'cc'],
        templateChecks: {
          py: { compiled: true, executed: true, total: 4, passed: 4 },
          java: { compiled: true, executed: true, total: 4, passed: 4 },
          cc: { compiled: false, executed: false, total: 4, passed: 0, failureKind: 'compile' },
        },
        checkerCheck: {
          configured: true, read: true, compiled: true, executed: true, infraFailures: 0,
        },
      },
    });

    const completed = payloads.flatMap(payload => payload.events).at(-1);
    expect(completed).toEqual(expect.objectContaining({
      eventType: 'run_completed',
      pipelineCompleted: true,
      verified: true,
      wouldBlock: false,
      modelEscalated: true,
      stressGenerated: 20,
      stressValid: 18,
      stressDroppedInvalid: 2,
      stressUnique: 17,
      stressCompared: 18,
      stressAgreed: 18,
      templateLanguagesVerified: ['py', 'java'],
      templateFailureKinds: ['compile'],
      checkerCompiled: true,
      checkerExecuted: true,
    }));
    expect(JSON.stringify(completed)).not.toContain('fallback-private');
    expect(completed?.modelIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.modelRole).toBe('fallback');
  });

  it('preserves verified=false and wouldBlock=true without deriving a new verdict', async () => {
    const payloads: Array<{ events: TestdataQualityEvent[] }> = [];
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue(install) },
      { send: jest.fn(async payload => { payloads.push(payload); }) },
    );
    const session = service.createSession({ runId: RUN_ID });
    await session.complete({
      verification: { mode: 'sandbox', verified: false, wouldBlock: true },
    });
    expect(payloads[0].events[0]).toEqual(expect.objectContaining({
      pipelineCompleted: true,
      verified: false,
      wouldBlock: true,
    }));
  });

  it('emits a typed pipeline-budget failure but does not classify cancellation as ordinary failure', async () => {
    const events: TestdataQualityEvent[] = [];
    const service = new TestdataRunTelemetryService(
      { getInstall: jest.fn().mockResolvedValue(install) },
      { send: jest.fn(async payload => { events.push(...payload.events); }) },
    );
    const budget = service.createSession({ runId: RUN_ID });
    await budget.fail(new TestdataPipelineError(
      'private budget details',
      'PIPELINE_BUDGET_EXHAUSTED',
      'sandbox_budget',
      'pipeline',
      'no-retry',
    ));
    expect(events.map(event => event.eventType)).toEqual(['stage_failed', 'run_completed']);
    expect(events[0]).toEqual(expect.objectContaining({
      failureCode: 'PIPELINE_BUDGET_EXHAUSTED',
      stage: 'sandbox_budget',
      artifact: 'pipeline',
      retryPolicy: 'no-retry',
    }));
    expect(JSON.stringify(events)).not.toContain('private budget details');

    events.length = 0;
    const canceled = service.createSession({
      runId: '99999999-9999-4999-8999-999999999999',
    });
    const cancellation = new TestdataPipelineError(
      'private cancellation details', 'CANCELLED', 'canceled', 'pipeline', 'no-retry',
    );
    cancellation.name = 'AbortError';
    await canceled.fail(cancellation);
    expect(events.map(event => event.eventType)).toEqual(['run_completed']);
    expect(events[0]).toEqual(expect.objectContaining({ pipelineCompleted: false, verified: false }));
  });
});
