jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: unknown) => id),
}));

import {
  TestdataGenerationJobModel,
  TESTDATA_JOB_LEASE_MS,
  TESTDATA_JOB_RETENTION_MS,
} from '../../models/testdataGenerationJob';

function createMockCollection() {
  return {
    createIndex: jest.fn().mockResolvedValue('ok'),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'job1' }),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
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
  generationProfile: 'hard' as const,
};

describe('TestdataGenerationJobModel', () => {
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
});
