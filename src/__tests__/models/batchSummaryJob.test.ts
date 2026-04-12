jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: any) => id),
}));

import { BatchSummaryJobModel } from '../../models/batchSummaryJob';

function createMockCollection() {
  return {
    createIndex: jest.fn().mockResolvedValue('ok'),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'job1' }),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
}

function createMockDb(col: any) {
  return { collection: jest.fn().mockReturnValue(col) } as any;
}

describe('BatchSummaryJobModel', () => {
  let col: ReturnType<typeof createMockCollection>;
  let model: BatchSummaryJobModel;

  beforeEach(() => {
    col = createMockCollection();
    model = new BatchSummaryJobModel(createMockDb(col));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── constructor ─────────────────────────────────────

  describe('constructor', () => {
    it('should use ai_batch_summary_jobs collection', () => {
      const mockDb = createMockDb(col);
      new BatchSummaryJobModel(mockDb);
      expect(mockDb.collection).toHaveBeenCalledWith('ai_batch_summary_jobs');
    });
  });

  // ─── ensureIndexes ──────────────────────────────────

  describe('ensureIndexes', () => {
    it('should create unique partial index on domainId+contestId where status != archived', async () => {
      await model.ensureIndexes();

      expect(col.createIndex).toHaveBeenCalledWith(
        { domainId: 1, contestId: 1 },
        expect.objectContaining({
          unique: true,
          partialFilterExpression: { status: { $in: expect.arrayContaining(['pending', 'running', 'completed', 'failed', 'stopped']) } },
        }),
      );
    });

    it('should log success after creating indexes', async () => {
      await model.ensureIndexes();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[BatchSummaryJobModel]'),
      );
    });
  });

  // ─── create ─────────────────────────────────────────

  describe('create', () => {
    it('should insert document with defaults and return insertedId', async () => {
      const fakeId = 'job-abc';
      col.insertOne.mockResolvedValue({ insertedId: fakeId });

      const result = await model.create({
        domainId: 'system',
        contestId: 'cid1' as any,
        contestTitle: 'Test Contest',
        createdBy: 1,
        config: { concurrency: 3, locale: 'zh' },
      });

      expect(result).toBe(fakeId);
      const inserted = col.insertOne.mock.calls[0][0];
      expect(inserted.status).toBe('pending');
      expect(inserted.completedCount).toBe(0);
      expect(inserted.failedCount).toBe(0);
      expect(inserted.totalStudents).toBe(0);
      expect(inserted.completedAt).toBeNull();
      expect(inserted.createdAt).toBeInstanceOf(Date);
    });

    it('should allow overriding totalStudents', async () => {
      col.insertOne.mockResolvedValue({ insertedId: 'job2' });

      await model.create({
        domainId: 'system',
        contestId: 'cid2' as any,
        contestTitle: 'Another Contest',
        createdBy: 2,
        totalStudents: 50,
        config: { concurrency: 5, locale: 'en' },
      });

      const inserted = col.insertOne.mock.calls[0][0];
      expect(inserted.totalStudents).toBe(50);
    });
  });

  // ─── findById ───────────────────────────────────────

  describe('findById', () => {
    it('should return job when found', async () => {
      const job = { _id: 'job1', domainId: 'system', status: 'pending' };
      col.findOne.mockResolvedValue(job);

      const result = await model.findById('job1');
      expect(result).toEqual(job);
      expect(col.findOne).toHaveBeenCalledWith({ _id: 'job1' });
    });

    it('should return null when not found', async () => {
      col.findOne.mockResolvedValue(null);
      const result = await model.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── findActiveJob ──────────────────────────────────

  describe('findActiveJob', () => {
    it('should find job by domainId and contestId where status != archived', async () => {
      const job = { _id: 'job1', status: 'running' };
      col.findOne.mockResolvedValue(job);

      const result = await model.findActiveJob('system', 'cid1' as any);
      expect(result).toEqual(job);
      expect(col.findOne).toHaveBeenCalledWith({
        domainId: 'system',
        contestId: 'cid1',
        status: { $in: expect.arrayContaining(['pending', 'running', 'completed', 'failed', 'stopped']) },
      });
    });

    it('should return null when no active job exists', async () => {
      col.findOne.mockResolvedValue(null);
      const result = await model.findActiveJob('system', 'cid2' as any);
      expect(result).toBeNull();
    });
  });

  // ─── updateStatus ───────────────────────────────────

  describe('updateStatus', () => {
    it('should set status without completedAt for pending/running', async () => {
      await model.updateStatus('job1', 'running');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'job1' },
        { $set: { status: 'running' } },
      );
    });

    it('should set completedAt when status is completed', async () => {
      await model.updateStatus('job1', 'completed');
      const call = col.updateOne.mock.calls[0];
      expect(call[0]).toEqual({ _id: 'job1' });
      expect(call[1].$set.status).toBe('completed');
      expect(call[1].$set.completedAt).toBeInstanceOf(Date);
    });

    it('should set completedAt when status is failed', async () => {
      await model.updateStatus('job1', 'failed');
      const call = col.updateOne.mock.calls[0];
      expect(call[1].$set.status).toBe('failed');
      expect(call[1].$set.completedAt).toBeInstanceOf(Date);
    });

    it('should not set completedAt for pending status', async () => {
      await model.updateStatus('job1', 'pending');
      const call = col.updateOne.mock.calls[0];
      expect(call[1].$set.completedAt).toBeUndefined();
    });
  });

  // ─── incrementCompleted ─────────────────────────────

  describe('incrementCompleted', () => {
    it('should $inc completedCount by 1', async () => {
      await model.incrementCompleted('job1');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'job1' },
        { $inc: { completedCount: 1 } },
      );
    });
  });

  // ─── incrementFailed ────────────────────────────────

  describe('incrementFailed', () => {
    it('should $inc failedCount by 1', async () => {
      await model.incrementFailed('job1');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'job1' },
        { $inc: { failedCount: 1 } },
      );
    });
  });

  // ─── archive ────────────────────────────────────────

  describe('archive', () => {
    it('should set status to archived', async () => {
      await model.archive('job1');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'job1' },
        { $set: { status: 'archived' } },
      );
    });
  });
});
