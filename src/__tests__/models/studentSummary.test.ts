import { StudentSummaryModel } from '../../models/studentSummary';
import { ObjectId } from '../../utils/mongo';

function createMockCollection() {
  const chainMock: any = {
    sort: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    createIndex: jest.fn().mockResolvedValue('ok'),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 3 }),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue(chainMock),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 5 }),
    _chain: chainMock,
  };
}

describe('StudentSummaryModel', () => {
  let coll: ReturnType<typeof createMockCollection>;
  let model: StudentSummaryModel;

  beforeEach(() => {
    coll = createMockCollection();
    const mockDb = {
      collection: jest.fn().mockReturnValue(coll),
    } as any;
    model = new StudentSummaryModel(mockDb);
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── constructor ────────────────────────────────────

  describe('constructor', () => {
    it('should request the ai_student_summaries collection', () => {
      const mockDb = { collection: jest.fn().mockReturnValue(coll) } as any;
      new StudentSummaryModel(mockDb);
      expect(mockDb.collection).toHaveBeenCalledWith('ai_student_summaries');
    });
  });

  // ─── ensureIndexes ──────────────────────────────────

  describe('ensureIndexes', () => {
    it('should create unique index on { jobId, userId }', async () => {
      await model.ensureIndexes();
      const calls = coll.createIndex.mock.calls;
      const uniqueCall = calls.find(
        ([fields, options]: any) =>
          fields.jobId === 1 && fields.userId === 1 && options?.unique === true
      );
      expect(uniqueCall).toBeDefined();
    });

    it('should create compound index on { domainId, contestId, userId }', async () => {
      await model.ensureIndexes();
      const calls = coll.createIndex.mock.calls;
      const compoundCall = calls.find(
        ([fields]: any) =>
          fields.domainId === 1 && fields.contestId === 1 && fields.userId === 1
      );
      expect(compoundCall).toBeDefined();
    });

    it('should log success', async () => {
      await model.ensureIndexes();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[StudentSummaryModel]')
      );
    });
  });

  // ─── createBatch ────────────────────────────────────

  describe('createBatch', () => {
    it('should insertMany with one doc per userId', async () => {
      const jobId = new ObjectId();
      const contestId = new ObjectId();
      await model.createBatch(jobId, 'system', contestId, [1, 2, 3]);

      expect(coll.insertMany).toHaveBeenCalledTimes(1);
      const docs = coll.insertMany.mock.calls[0][0];
      expect(docs).toHaveLength(3);
      expect(docs[0].userId).toBe(1);
      expect(docs[1].userId).toBe(2);
      expect(docs[2].userId).toBe(3);
    });

    it('should set default field values for each doc', async () => {
      const jobId = new ObjectId();
      const contestId = new ObjectId();
      await model.createBatch(jobId, 'system', contestId, [42]);

      const docs = coll.insertMany.mock.calls[0][0];
      const doc = docs[0];
      expect(doc.jobId).toEqual(jobId);
      expect(doc.domainId).toBe('system');
      expect(doc.contestId).toEqual(contestId);
      expect(doc.status).toBe('pending');
      expect(doc.publishStatus).toBe('draft');
      expect(doc.summary).toBeNull();
      expect(doc.originalSummary).toBeNull();
      expect(doc.problemSnapshots).toEqual([]);
      expect(doc.tokenUsage).toEqual({ prompt: 0, completion: 0 });
      expect(doc.error).toBeNull();
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── findByJobAndUser ───────────────────────────────

  describe('findByJobAndUser', () => {
    it('should call findOne with jobId and userId', async () => {
      const jobId = new ObjectId();
      await model.findByJobAndUser(jobId, 5);
      expect(coll.findOne).toHaveBeenCalledWith({ jobId, userId: 5 });
    });

    it('should return null when not found', async () => {
      coll.findOne.mockResolvedValue(null);
      const result = await model.findByJobAndUser(new ObjectId(), 99);
      expect(result).toBeNull();
    });
  });

  // ─── findAllByJob ───────────────────────────────────

  describe('findAllByJob', () => {
    it('should query by jobId and sort by userId ascending', async () => {
      const jobId = new ObjectId();
      await model.findAllByJob(jobId);
      expect(coll.find).toHaveBeenCalledWith({ jobId });
      expect(coll._chain.sort).toHaveBeenCalledWith({ userId: 1 });
      expect(coll._chain.toArray).toHaveBeenCalled();
    });
  });

  // ─── findPublishedForStudent ─────────────────────────

  describe('findPublishedForStudent', () => {
    it('should query with publishStatus=published and status=completed', async () => {
      await model.findPublishedForStudent('domain1', new ObjectId(), 7);
      const query = coll.findOne.mock.calls[0][0];
      expect(query.publishStatus).toBe('published');
      expect(query.status).toBe('completed');
    });

    it('should include domainId, contestId and userId in query', async () => {
      const contestId = new ObjectId();
      await model.findPublishedForStudent('domain1', contestId, 7);
      const query = coll.findOne.mock.calls[0][0];
      expect(query.domainId).toBe('domain1');
      expect(query.contestId).toEqual(contestId);
      expect(query.userId).toBe(7);
    });
  });

  // ─── markGenerating ─────────────────────────────────

  describe('markGenerating', () => {
    it('should set status=generating', async () => {
      const id = new ObjectId();
      await model.markGenerating(id);
      const [filter, update] = coll.updateOne.mock.calls[0];
      expect(filter._id).toEqual(id);
      expect(update.$set.status).toBe('generating');
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── completeSummary ────────────────────────────────

  describe('completeSummary', () => {
    it('should set status=completed, summary, originalSummary and tokenUsage', async () => {
      const id = new ObjectId();
      const snapshots = [{ pid: 'p1', title: 'Problem 1', submissionCount: 2, sampledSubmissions: [], allStatuses: [] }];
      const tokenUsage = { prompt: 100, completion: 50 };

      await model.completeSummary(id, 'Great job!', snapshots, tokenUsage);

      const [filter, update] = coll.updateOne.mock.calls[0];
      expect(filter._id).toEqual(id);
      expect(update.$set.status).toBe('completed');
      expect(update.$set.summary).toBe('Great job!');
      expect(update.$set.originalSummary).toBe('Great job!');
      expect(update.$set.problemSnapshots).toEqual(snapshots);
      expect(update.$set.tokenUsage).toEqual(tokenUsage);
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── markFailed ─────────────────────────────────────

  describe('markFailed', () => {
    it('should set status=failed and error message', async () => {
      const id = new ObjectId();
      await model.markFailed(id, 'AI timeout');
      const [filter, update] = coll.updateOne.mock.calls[0];
      expect(filter._id).toEqual(id);
      expect(update.$set.status).toBe('failed');
      expect(update.$set.error).toBe('AI timeout');
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── resetToPending ──────────────────────────────────

  describe('resetToPending', () => {
    it('should set status=pending and clear error', async () => {
      const id = new ObjectId();
      await model.resetToPending(id);
      const [filter, update] = coll.updateOne.mock.calls[0];
      expect(filter._id).toEqual(id);
      expect(update.$set.status).toBe('pending');
      expect(update.$set.error).toBeNull();
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── editSummary ─────────────────────────────────────

  describe('editSummary', () => {
    it('should update only summary, not originalSummary', async () => {
      const id = new ObjectId();
      await model.editSummary(id, 'Edited text');
      const [filter, update] = coll.updateOne.mock.calls[0];
      expect(filter._id).toEqual(id);
      expect(update.$set.summary).toBe('Edited text');
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
      // Must NOT touch originalSummary
      expect(update.$set.originalSummary).toBeUndefined();
    });
  });

  // ─── publishAll ──────────────────────────────────────

  describe('publishAll', () => {
    it('should updateMany where status=completed and publishStatus=draft', async () => {
      const jobId = new ObjectId();
      coll.updateMany.mockResolvedValue({ modifiedCount: 3 });

      const count = await model.publishAll(jobId);
      const [filter, update] = coll.updateMany.mock.calls[0];
      expect(filter.jobId).toEqual(jobId);
      expect(filter.status).toBe('completed');
      expect(filter.publishStatus).toBe('draft');
      expect(update.$set.publishStatus).toBe('published');
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
      expect(count).toBe(3);
    });

    it('should return modifiedCount', async () => {
      coll.updateMany.mockResolvedValue({ modifiedCount: 7 });
      const count = await model.publishAll(new ObjectId());
      expect(count).toBe(7);
    });
  });

  // ─── publishOne ──────────────────────────────────────

  describe('publishOne', () => {
    it('should set publishStatus=published for given id', async () => {
      const id = new ObjectId();
      await model.publishOne(id);
      const [filter, update] = coll.updateOne.mock.calls[0];
      expect(filter._id).toEqual(id);
      expect(update.$set.publishStatus).toBe('published');
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── deleteSummary ───────────────────────────────────

  describe('deleteSummary', () => {
    it('should reset summary, status and publishStatus', async () => {
      const id = new ObjectId();
      await model.deleteSummary(id);
      const [filter, update] = coll.updateOne.mock.calls[0];
      expect(filter._id).toEqual(id);
      expect(update.$set.summary).toBeNull();
      expect(update.$set.status).toBe('pending');
      expect(update.$set.publishStatus).toBe('draft');
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ─── hasEditedSummaries ──────────────────────────────

  describe('hasEditedSummaries', () => {
    it('should return true when findOne finds a diverged doc', async () => {
      const jobId = new ObjectId();
      coll.findOne.mockResolvedValue({ _id: new ObjectId(), summary: 'Edited', originalSummary: 'Original' });

      const result = await model.hasEditedSummaries(jobId);
      expect(result).toBe(true);
    });

    it('should return false when findOne returns null', async () => {
      const jobId = new ObjectId();
      coll.findOne.mockResolvedValue(null);

      const result = await model.hasEditedSummaries(jobId);
      expect(result).toBe(false);
    });

    it('should query with jobId and $expr comparing summary to originalSummary', async () => {
      const jobId = new ObjectId();
      coll.findOne.mockResolvedValue(null);

      await model.hasEditedSummaries(jobId);
      const query = coll.findOne.mock.calls[0][0];
      expect(query.jobId).toEqual(jobId);
      expect(query.$expr).toBeDefined();
      expect(query.$expr.$ne).toEqual(['$summary', '$originalSummary']);
    });
  });
});
