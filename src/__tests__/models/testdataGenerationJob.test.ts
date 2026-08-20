jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: unknown) => id),
}));

import {
  TestdataGenerationJobModel,
  TESTDATA_JOB_LEASE_MS,
  TESTDATA_JOB_RETENTION_MS,
  TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS,
  computeTestdataCheckpointHashes,
  filterTestdataCheckpointUpdate,
  selectTestdataResumeCheckpoint,
} from '../../models/testdataGenerationJob';

function createMockCollection() {
  return {
    createIndex: jest.fn().mockResolvedValue('ok'),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'job1' }),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
}

function createModel() {
  const collection = createMockCollection();
  const db = { collection: jest.fn().mockReturnValue(collection) };
  return { model: new TestdataGenerationJobModel(db as never), collection, db };
}

const createParams = {
  domainId: 'system',
  problemDocId: 1530,
  problemId: 'D3102',
  problemTitle: 'Test problem',
  createdBy: 2,
};

describe('TestdataGenerationJobModel', () => {
  it('checkpoint hash 对等价 options 稳定，任一输入变化都会失配', () => {
    const first = computeTestdataCheckpointHashes(
      {
        problemKind: 'traditional',
        caseCount: 10,
        languages: [],
        dataScale: 'auto',
      },
      '题面正文',
    );
    const reordered = computeTestdataCheckpointHashes(
      {
        dataScale: 'auto',
        languages: [],
        caseCount: 10,
        problemKind: 'traditional',
      },
      '题面正文',
    );
    expect(reordered).toEqual(first);
    expect(computeTestdataCheckpointHashes(
      {
        problemKind: 'traditional',
        caseCount: 11,
        languages: [],
        dataScale: 'auto',
      },
      '题面正文',
    ).optionsHash).not.toBe(first.optionsHash);
    expect(computeTestdataCheckpointHashes(
      {
        problemKind: 'traditional',
        caseCount: 10,
        languages: [],
        dataScale: 'auto',
      },
      '修改后的题面',
    ).statementHash).not.toBe(first.statementHash);
  });

  it('checkpoint hash 将 languages 视为集合，并覆盖配置与 checker 内容', () => {
    const first = computeTestdataCheckpointHashes(
      { problemKind: 'function', languages: ['python', 'cpp', 'python'] },
      '题面正文',
      {
        existingConfig: 'time: 1s\nsubtasks:\n  - score: 100\n',
        checkerArtifacts: {
          configured: true,
          read: true,
          checkerSource: '#include "testlib.h"\nint main() {}\n',
        },
      },
    );
    const equivalent = computeTestdataCheckpointHashes(
      { languages: ['cpp', 'python'], problemKind: 'function' },
      '题面正文',
      {
        existingConfig: 'subtasks:\n  - score: 100\ntime: 1s\n',
        checkerArtifacts: {
          configured: true,
          read: true,
          checkerSource: '#include "testlib.h"\r\nint main() {}\r\n',
        },
      },
    );

    expect(equivalent).toEqual(first);
    expect(computeTestdataCheckpointHashes(
      { problemKind: 'function', languages: ['cpp', 'python'] },
      '题面正文',
      {
        existingConfig: 'time: 2s\nsubtasks:\n  - score: 100\n',
        checkerArtifacts: {
          configured: true,
          read: true,
          checkerSource: '#include "testlib.h"\nint main() {}\n',
        },
      },
    ).optionsHash).not.toBe(first.optionsHash);
    expect(computeTestdataCheckpointHashes(
      { problemKind: 'function', languages: ['cpp', 'python'] },
      '题面正文',
      {
        existingConfig: 'time: 1s\nsubtasks:\n  - score: 100\n',
        checkerArtifacts: { configured: false, read: false },
      },
    ).optionsHash).not.toBe(first.optionsHash);
    expect(computeTestdataCheckpointHashes(
      { problemKind: 'function', languages: ['cpp', 'python'] },
      '题面正文',
      {
        existingConfig: 'time: 1s\nsubtasks:\n  - score: 100\n',
        checkerArtifacts: {
          configured: true,
          read: true,
          checkerSource: '#include "testlib.h"\nint main() { return 1; }\n',
        },
      },
    ).optionsHash).not.toBe(first.optionsHash);
  });

  it('checkpoint hash 覆盖 checker 配置、读取与失败状态', () => {
    const options = { problemKind: 'traditional', languages: [] };
    const unreadable = computeTestdataCheckpointHashes(options, '题面正文', {
      checkerArtifacts: {
        configured: true,
        read: false,
        failureKind: 'missing',
      },
    } as never);

    for (const checkerArtifacts of [
      { configured: false, read: false },
      { configured: true, read: false, failureKind: 'read' as const },
      {
        configured: true,
        read: true,
        checkerSource: 'int main() {}',
        checkerHeaders: { 'testlib.h': '// header' },
      },
    ]) {
      expect(computeTestdataCheckpointHashes(options, '题面正文', {
        checkerArtifacts,
      } as never).optionsHash).not.toBe(unreadable.optionsHash);
    }
  });

  it('仅接受同作用域 interrupted 任务且双 hash 一致的 checkpoint', () => {
    const checkpoint = {
      revision: 3,
      optionsHash: 'options',
      statementHash: 'statement',
      solution: { problemType: 'traditional' as const, oracleCode: 'print(1)' },
    };
    const job = {
      ...createParams,
      _id: 'old-job',
      status: 'interrupted' as const,
      checkpoint,
    };
    const expected = {
      domainId: createParams.domainId,
      problemDocId: createParams.problemDocId,
      problemId: createParams.problemId,
      createdBy: createParams.createdBy,
      optionsHash: 'options',
      statementHash: 'statement',
    };
    expect(selectTestdataResumeCheckpoint(job, expected)).toBe(checkpoint);
    for (const mismatch of [
      { status: 'failed' },
      { domainId: 'other' },
      { problemDocId: 999 },
      { problemId: 'OTHER' },
      { createdBy: 99 },
      { checkpoint: { ...checkpoint, optionsHash: 'other' } },
      { checkpoint: { ...checkpoint, statementHash: 'other' } },
      { checkpoint: { ...checkpoint, revision: undefined } },
      { checkpoint: { ...checkpoint, revision: 0 } },
    ]) {
      expect(selectTestdataResumeCheckpoint({ ...job, ...mismatch } as never, expected))
        .toBeUndefined();
    }
  });

  it('checkpoint envelope 字段超限时丢弃该字段及所有下游字段', () => {
    const smallSolution = {
      problemType: 'traditional' as const,
      oracleCode: 'print(input())',
    };
    const filtered = filterTestdataCheckpointUpdate({
      revision: 4,
      solution: smallSolution,
      artifacts: {
        generatorCode: 'x'.repeat((256 * 1024) + 1),
      },
      verifier: {
        bruteCode: 'print(input())',
        validatorCode: 'print(1)',
        stressGeneratorCode: 'print(1)',
      },
      killTargets: [],
    });
    expect(filtered).toEqual({
      revision: 4,
      solution: smallSolution,
    });
  });

  it('checkpoint 以完整 envelope 原子覆盖，并用 revision 拒绝陈旧写入', async () => {
    const { model, collection } = createModel();
    const solution = {
      problemType: 'traditional' as const,
      oracleCode: 'print(input())',
    };

    await model.updateCheckpoint(
      'job1',
      { optionsHash: 'options', statementHash: 'statement' },
      { revision: 2, solution, killTargets: [] },
    );

    expect(collection.updateOne).toHaveBeenCalledWith(
      {
        _id: 'job1',
        active: true,
        $or: [
          { 'checkpoint.revision': { $lt: 2 } },
          { 'checkpoint.revision': { $exists: false } },
        ],
      },
      { $set: expect.objectContaining({
        checkpoint: {
          optionsHash: 'options',
          statementHash: 'statement',
          revision: 2,
          solution,
          killTargets: [],
        },
      }) },
    );
  });

  it('三语言 solution checkpoint 经过 filter、持久化与读取后精确保真', async () => {
    const { model, collection } = createModel();
    const solutions = {
      py: 'def solve(value):\n    return value\n',
      java: 'class Solution { String solve(String value) { return value; } }\n',
      cc: 'string solve(string value) { return value; }\n',
    };
    const solution = {
      problemType: 'function' as const,
      oracleCode: 'print(input())',
      solutions,
      solutionCode: solutions.py,
    };
    const filtered = filterTestdataCheckpointUpdate({ revision: 5, solution });

    expect(filtered.solution?.solutions).toEqual(solutions);
    await model.updateCheckpoint(
      'job1',
      { optionsHash: 'options', statementHash: 'statement' },
      filtered,
    );
    const persisted = collection.updateOne.mock.calls.at(-1)?.[1].$set.checkpoint;
    expect(persisted.solution.solutions).toEqual(solutions);

    const restored = selectTestdataResumeCheckpoint({
      ...createParams,
      status: 'interrupted',
      checkpoint: persisted,
    }, {
      domainId: createParams.domainId,
      problemDocId: createParams.problemDocId,
      problemId: createParams.problemId,
      createdBy: createParams.createdBy,
      optionsHash: 'options',
      statementHash: 'statement',
    });
    expect(restored?.solution?.solutions).toEqual(solutions);
  });

  it('creates an active uniqueness index and a 24-hour TTL index', async () => {
    const { model, collection } = createModel();
    await model.ensureIndexes();

    expect(collection.createIndex).toHaveBeenCalledWith(
      { domainId: 1, problemDocId: 1, createdBy: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { active: true },
      }),
    );
    expect(collection.createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    );
  });

  it('creates a pending restorable job with lease and retention deadlines', async () => {
    const { model, collection } = createModel();
    const before = Date.now();
    const result = await model.createOrGetActive(createParams);

    expect(result.created).toBe(true);
    const inserted = collection.insertOne.mock.calls[0][0];
    expect(inserted).toEqual(expect.objectContaining({
      status: 'pending', active: true, restorable: true,
      cancelRequested: false,
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      applyFailureEventId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      progress: { stage: 'preparing', percent: 2, attempt: 1 },
    }));
    expect(inserted.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + TESTDATA_JOB_LEASE_MS);
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TESTDATA_JOB_RETENTION_MS);
  });

  it('returns an existing active job instead of creating a duplicate paid task', async () => {
    const { model, collection } = createModel();
    const existing = { _id: 'job-existing', ...createParams, status: 'running', active: true };
    collection.findOne.mockResolvedValueOnce(existing);

    const result = await model.createOrGetActive(createParams);

    expect(result).toEqual({ job: existing, created: false });
    expect(collection.insertOne).not.toHaveBeenCalled();
  });

  it('only saves a completed plan while the job is still active and not canceled', async () => {
    const { model, collection } = createModel();
    const plan = {
      runId: '11111111-1111-4111-8111-111111111111',
      promptVersion: 'testdata-generation-v1',
      originalFileHashes: {},
      problemType: 'traditional' as const,
      files: [],
      caseCount: 1,
    };

    await expect(model.complete('job1', plan)).resolves.toBe(true);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'job1', active: true, cancelRequested: false },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'completed', active: false, plan }),
      }),
    );
  });

  it('cancellation disables restoration and prevents the task remaining active', async () => {
    const { model, collection } = createModel();
    await model.cancel('job1');

    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'job1', status: { $in: ['pending', 'running'] } },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'canceled', active: false, restorable: false, cancelRequested: true,
        }),
      }),
    );
  });

  it('persists the typed cancellation contract while keeping canceled status', async () => {
    const { model, collection } = createModel();
    const cancellation = {
      message: 'ai_helper_err_ai_aborted',
      code: 'CLIENT_ABORTED',
      failureCode: 'CANCELLED' as const,
      stage: 'canceled',
      artifact: 'pipeline' as const,
      retryPolicy: 'no-retry' as const,
      retryable: false,
    };

    await (model.cancel as unknown as (
      id: string,
      error: typeof cancellation,
    ) => Promise<void>)('job1', cancellation);

    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'job1', status: { $in: ['pending', 'running'] } },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'canceled',
          active: false,
          error: cancellation,
        }),
      }),
    );
  });

  it('heartbeat extends both the worker lease and the active job retention window', async () => {
    const { model, collection } = createModel();
    const before = Date.now();

    await expect(model.renewLease('job1')).resolves.toBe(true);

    const update = collection.updateOne.mock.calls[0][1].$set;
    expect(update.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + TESTDATA_JOB_LEASE_MS);
    expect(update.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TESTDATA_JOB_RETENTION_MS);
  });

  it('records exactly one terminal teacher outcome and treats same retries as idempotent', async () => {
    const { model, collection } = createModel();
    const record = {
      eventId: '22222222-2222-4222-8222-222222222222',
      outcome: 'accepted_edited' as const,
      editedFileCount: 1,
      changedFileKinds: ['case-in'] as const,
    };

    await expect(model.recordTeacherOutcome('job1', record)).resolves.toEqual({
      state: 'recorded',
      record: expect.objectContaining(record),
    });
    expect(collection.updateOne).toHaveBeenCalledWith(
      {
        _id: 'job1',
        status: 'completed',
        teacherOutcome: { $exists: false },
        appliedAt: { $exists: false },
        $or: [
          { teacherOutcomeClaim: { $exists: false } },
          { 'teacherOutcomeClaim.leaseExpiresAt': { $lte: expect.any(Date) } },
          { 'teacherOutcomeClaim.leaseExpiresAt': { $exists: false } },
        ],
      },
      {
        $set: expect.objectContaining({
          teacherOutcome: expect.objectContaining(record),
          restorable: false,
        }),
        $unset: { teacherOutcomeClaim: '' },
      },
    );

    collection.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    collection.findOne.mockResolvedValueOnce({ teacherOutcome: { ...record, recordedAt: new Date() } });
    await expect(model.recordTeacherOutcome('job1', record)).resolves.toEqual({
      state: 'duplicate',
      record: expect.objectContaining(record),
    });

    collection.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    collection.findOne.mockResolvedValueOnce({ teacherOutcome: { ...record, recordedAt: new Date() } });
    await expect(model.recordTeacherOutcome('job1', {
      eventId: '33333333-3333-4333-8333-333333333333',
      outcome: 'discarded',
      reason: 'other',
    })).resolves.toEqual({
      state: 'conflict',
      record: expect.objectContaining(record),
    });

    collection.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    collection.findOne.mockResolvedValueOnce({ teacherOutcome: { ...record, recordedAt: new Date() } });
    await expect(model.recordTeacherOutcome('job1', {
      eventId: record.eventId,
      outcome: 'discarded',
      reason: 'other',
    })).resolves.toEqual({
      state: 'conflict',
      record: expect.objectContaining(record),
    });
  });

  it('atomically leases an apply claim, recovers expired claims, and protects a live writer', async () => {
    const { model, collection } = createModel();
    const before = Date.now();

    await expect(model.claimTeacherOutcome('job1', 'claim-1')).resolves.toBe(true);
    expect(collection.updateOne).toHaveBeenNthCalledWith(
      1,
      {
        _id: 'job1',
        status: 'completed',
        teacherOutcome: { $exists: false },
        appliedAt: { $exists: false },
        $or: [
          { teacherOutcomeClaim: { $exists: false } },
          { 'teacherOutcomeClaim.leaseExpiresAt': { $lte: expect.any(Date) } },
          { 'teacherOutcomeClaim.leaseExpiresAt': { $exists: false } },
        ],
      },
      { $set: {
        teacherOutcomeClaim: {
          claimId: 'claim-1',
          claimedAt: expect.any(Date),
          leaseExpiresAt: expect.any(Date),
        },
        updatedAt: expect.any(Date),
      } },
    );
    const claim = collection.updateOne.mock.calls[0][1].$set.teacherOutcomeClaim;
    expect(claim.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(
      before + TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS,
    );

    await model.releaseTeacherOutcomeClaim('job1', 'claim-1');
    expect(collection.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'job1', 'teacherOutcomeClaim.claimId': 'claim-1' },
      {
        $unset: { teacherOutcomeClaim: '' },
        $set: { updatedAt: expect.any(Date) },
      },
    );

    collection.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(model.claimTeacherOutcome('job1', 'claim-2')).resolves.toBe(false);
  });

  it('renews only the owned apply claim and persists one stable apply-failure timestamp', async () => {
    const { model, collection } = createModel();
    const before = Date.now();

    collection.updateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 0 });
    await expect(model.renewTeacherOutcomeClaim('job1', 'claim-1')).resolves.toBe(true);
    expect(collection.updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: 'job1', 'teacherOutcomeClaim.claimId': 'claim-1' },
      { $set: {
        'teacherOutcomeClaim.claimedAt': expect.any(Date),
        'teacherOutcomeClaim.leaseExpiresAt': expect.any(Date),
        updatedAt: expect.any(Date),
      } },
    );
    const renewal = collection.updateOne.mock.calls[0][1].$set;
    expect(renewal['teacherOutcomeClaim.leaseExpiresAt'].getTime()).toBeGreaterThanOrEqual(
      before + TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS,
    );

    const preferredEventId = '66666666-6666-4666-8666-666666666666';
    await expect(model.getOrCreateApplyFailureEvent('job1', preferredEventId)).resolves.toEqual({
      eventId: preferredEventId,
      occurredAt: expect.any(Date),
    });
    const firstEvent = collection.updateOne.mock.calls[1][1].$set;
    expect(collection.updateOne.mock.calls[1][0]).toEqual({
      _id: 'job1', applyFailureOccurredAt: { $exists: false },
    });
    expect(firstEvent).toEqual({
      applyFailureEventId: preferredEventId,
      applyFailureOccurredAt: expect.any(Date),
    });

    const storedAt = new Date('2026-08-19T01:02:03.000Z');
    collection.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    collection.findOne.mockResolvedValueOnce({
      applyFailureEventId: preferredEventId,
      applyFailureOccurredAt: storedAt,
    });
    await expect(model.getOrCreateApplyFailureEvent('job1', preferredEventId)).resolves.toEqual({
      eventId: preferredEventId,
      occurredAt: storedAt,
    });

    collection.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
    await expect(model.renewTeacherOutcomeClaim('job1', 'lost-claim')).resolves.toBe(false);
  });

  it('requires the matching apply claim to record and mark an applied result', async () => {
    const { model, collection } = createModel();
    const input = {
      eventId: '22222222-2222-4222-8222-222222222222',
      outcome: 'accepted_unchanged' as const,
    };

    await expect(model.recordTeacherOutcome('job1', input, 'claim-1')).resolves.toEqual({
      state: 'recorded',
      record: expect.objectContaining(input),
    });
    expect(collection.updateOne).toHaveBeenNthCalledWith(
      1,
      {
        _id: 'job1',
        status: 'completed',
        teacherOutcome: { $exists: false },
        appliedAt: { $exists: false },
        'teacherOutcomeClaim.claimId': 'claim-1',
      },
      { $set: expect.objectContaining({ teacherOutcome: expect.objectContaining(input) }) },
    );

    await expect(model.markApplied('job1', 'claim-1')).resolves.toBe(true);
    expect(collection.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'job1', 'teacherOutcomeClaim.claimId': 'claim-1' },
      {
        $set: {
          appliedAt: expect.any(Date),
          restorable: false,
          updatedAt: expect.any(Date),
        },
        $unset: { teacherOutcomeClaim: '' },
      },
    );
  });
});
