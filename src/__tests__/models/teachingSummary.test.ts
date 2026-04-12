jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: any) => id),
}));

import { TeachingSummaryModel } from '../../models/teachingSummary';
import type { TeachingFinding } from '../../models/teachingSummary';

function createMockCursor(items: any[] = []) {
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue(items),
  };
  return cursor;
}

function createMockCollection() {
  return {
    createIndex: jest.fn().mockResolvedValue('ok'),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'summary1' }),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue(createMockCursor()),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  };
}

function createMockDb(col: any) {
  return { collection: jest.fn().mockReturnValue(col) } as any;
}

const sampleFinding: TeachingFinding = {
  id: 'f1',
  dimension: 'commonError',
  severity: 'high',
  title: 'Off-by-one errors in loops',
  evidence: {
    affectedStudents: [1, 2, 3],
    affectedProblems: [101],
    metrics: { errorRate: 0.75 },
    samples: { code: ['for (i=0; i<=n; i++)'] },
  },
  needsDeepDive: true,
  aiSuggestion: 'Review boundary conditions',
};

describe('TeachingSummaryModel', () => {
  let col: ReturnType<typeof createMockCollection>;
  let model: TeachingSummaryModel;

  beforeEach(() => {
    col = createMockCollection();
    model = new TeachingSummaryModel(createMockDb(col));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── constructor ─────────────────────────────────────

  describe('constructor', () => {
    it('should use ai_teaching_summaries collection', () => {
      const mockDb = createMockDb(col);
      new TeachingSummaryModel(mockDb);
      expect(mockDb.collection).toHaveBeenCalledWith('ai_teaching_summaries');
    });
  });

  // ─── ensureIndexes ──────────────────────────────────

  describe('ensureIndexes', () => {
    it('should create index on domainId and createdAt', async () => {
      await model.ensureIndexes();

      expect(col.createIndex).toHaveBeenCalledWith(
        { domainId: 1, createdAt: -1 },
        expect.objectContaining({ name: 'idx_domainId_createdAt' }),
      );
    });

    it('should create index on domainId and contestId', async () => {
      await model.ensureIndexes();

      expect(col.createIndex).toHaveBeenCalledWith(
        { domainId: 1, contestId: 1 },
        expect.objectContaining({ name: 'idx_domainId_contestId' }),
      );
    });

    it('should log success after creating indexes', async () => {
      await model.ensureIndexes();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[TeachingSummaryModel]'),
      );
    });
  });

  // ─── create ─────────────────────────────────────────

  describe('create', () => {
    it('should insert document with status pending and return insertedId', async () => {
      const fakeId = 'summary-abc';
      col.insertOne.mockResolvedValue({ insertedId: fakeId });
      const now = new Date();

      const result = await model.create({
        domainId: 'system',
        contestId: 'cid1' as any,
        contestTitle: 'Test Contest',
        contestContent: 'Write a solution for...',
        createdBy: 1,
        dataSnapshotAt: now,
      });

      expect(result).toBe(fakeId);
      const inserted = col.insertOne.mock.calls[0][0];
      expect(inserted.status).toBe('pending');
      expect(inserted.findings).toEqual([]);
      expect(inserted.overallSuggestion).toBe('');
      expect(inserted.deepDiveResults).toEqual({});
      expect(inserted.tokenUsage).toEqual({ promptTokens: 0, completionTokens: 0 });
      expect(inserted.generationTimeMs).toBe(0);
      expect(inserted.stats.totalStudents).toBe(0);
      expect(inserted.createdAt).toBeInstanceOf(Date);
    });

    it('should store optional teachingFocus when provided', async () => {
      col.insertOne.mockResolvedValue({ insertedId: 'summary2' });

      await model.create({
        domainId: 'system',
        contestId: 'cid2' as any,
        contestTitle: 'Another Contest',
        contestContent: 'Content here',
        createdBy: 2,
        dataSnapshotAt: new Date(),
        teachingFocus: 'Dynamic programming concepts',
      });

      const inserted = col.insertOne.mock.calls[0][0];
      expect(inserted.teachingFocus).toBe('Dynamic programming concepts');
    });

    it('should not include teachingFocus when not provided', async () => {
      col.insertOne.mockResolvedValue({ insertedId: 'summary3' });

      await model.create({
        domainId: 'system',
        contestId: 'cid3' as any,
        contestTitle: 'Contest',
        contestContent: 'Content',
        createdBy: 1,
        dataSnapshotAt: new Date(),
      });

      const inserted = col.insertOne.mock.calls[0][0];
      expect(inserted.teachingFocus).toBeUndefined();
    });
  });

  // ─── findById ───────────────────────────────────────

  describe('findById', () => {
    it('should return summary when found', async () => {
      const summary = { _id: 'summary1', domainId: 'system', status: 'completed' };
      col.findOne.mockResolvedValue(summary);

      const result = await model.findById('summary1');
      expect(result).toEqual(summary);
      expect(col.findOne).toHaveBeenCalledWith({ _id: 'summary1' });
    });

    it('should return null when not found', async () => {
      col.findOne.mockResolvedValue(null);
      const result = await model.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── findByContest ──────────────────────────────────

  describe('findByContest', () => {
    it('should find latest summary for a contest sorted by createdAt desc', async () => {
      const summary = { _id: 'summary1', contestId: 'cid1', status: 'completed' };
      col.findOne.mockResolvedValue(summary);

      const result = await model.findByContest('system', 'cid1' as any);
      expect(result).toEqual(summary);
      expect(col.findOne).toHaveBeenCalledWith(
        { domainId: 'system', contestId: 'cid1' },
        { sort: { createdAt: -1 } },
      );
    });

    it('should return null when no summary exists for contest', async () => {
      col.findOne.mockResolvedValue(null);
      const result = await model.findByContest('system', 'cid999' as any);
      expect(result).toBeNull();
    });
  });

  // ─── findByDomain ───────────────────────────────────

  describe('findByDomain', () => {
    it('should return paginated summaries sorted by createdAt desc', async () => {
      const summaries = [
        { _id: 's2', createdAt: new Date('2024-02-01') },
        { _id: 's1', createdAt: new Date('2024-01-01') },
      ];
      const mockCursor = createMockCursor(summaries);
      col.find.mockReturnValue(mockCursor);

      const result = await model.findByDomain('system', 1, 10);

      expect(col.find).toHaveBeenCalledWith({ domainId: 'system' });
      expect(mockCursor.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(mockCursor.skip).toHaveBeenCalledWith(0);
      expect(mockCursor.limit).toHaveBeenCalledWith(10);
      expect(result).toEqual(summaries);
    });

    it('should calculate correct skip for page 2', async () => {
      const mockCursor = createMockCursor([]);
      col.find.mockReturnValue(mockCursor);

      await model.findByDomain('system', 2, 5);

      expect(mockCursor.skip).toHaveBeenCalledWith(5);
      expect(mockCursor.limit).toHaveBeenCalledWith(5);
    });

    it('should return empty array when no summaries exist', async () => {
      const mockCursor = createMockCursor([]);
      col.find.mockReturnValue(mockCursor);

      const result = await model.findByDomain('system', 1, 10);
      expect(result).toEqual([]);
    });
  });

  // ─── updateStatus ───────────────────────────────────

  describe('updateStatus', () => {
    it('should update status to generating', async () => {
      await model.updateStatus('summary1', 'generating');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'summary1' },
        { $set: { status: 'generating' } },
      );
    });

    it('should update status to failed', async () => {
      await model.updateStatus('summary1', 'failed');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'summary1' },
        { $set: { status: 'failed' } },
      );
    });
  });

  // ─── saveResults ────────────────────────────────────

  describe('saveResults', () => {
    it('should save results and set status to completed', async () => {
      const stats = {
        totalStudents: 30,
        participatedStudents: 25,
        aiUserCount: 15,
        problemCount: 5,
      };

      await model.saveResults('summary1', {
        stats,
        findings: [sampleFinding],
        overallSuggestion: 'Focus on boundary conditions',
        tokenUsage: { promptTokens: 1000, completionTokens: 500 },
        generationTimeMs: 3200,
      });

      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'summary1' },
        {
          $set: {
            status: 'completed',
            stats,
            findings: [sampleFinding],
            overallSuggestion: 'Focus on boundary conditions',
            deepDiveResults: {},
            tokenUsage: { promptTokens: 1000, completionTokens: 500 },
            generationTimeMs: 3200,
          },
        },
      );
    });

    it('should save deepDiveResults when provided', async () => {
      const deepDiveResults = { f1: 'Detailed analysis of finding 1' };

      await model.saveResults('summary1', {
        stats: { totalStudents: 10, participatedStudents: 8, aiUserCount: 5, problemCount: 3 },
        findings: [],
        overallSuggestion: 'Good progress',
        deepDiveResults,
        tokenUsage: { promptTokens: 200, completionTokens: 100 },
        generationTimeMs: 800,
      });

      const call = col.updateOne.mock.calls[0];
      expect(call[1].$set.deepDiveResults).toEqual(deepDiveResults);
    });

    it('should default deepDiveResults to empty object when not provided', async () => {
      await model.saveResults('summary1', {
        stats: { totalStudents: 5, participatedStudents: 5, aiUserCount: 3, problemCount: 2 },
        findings: [],
        overallSuggestion: '',
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
        generationTimeMs: 0,
      });

      const call = col.updateOne.mock.calls[0];
      expect(call[1].$set.deepDiveResults).toEqual({});
    });
  });

  // ─── saveFeedback ───────────────────────────────────

  describe('saveFeedback', () => {
    it('should save rating up feedback without comment', async () => {
      await model.saveFeedback('summary1', 'up');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'summary1' },
        { $set: { feedback: { rating: 'up' } } },
      );
    });

    it('should save rating down with comment', async () => {
      await model.saveFeedback('summary1', 'down', 'Not enough detail');
      expect(col.updateOne).toHaveBeenCalledWith(
        { _id: 'summary1' },
        { $set: { feedback: { rating: 'down', comment: 'Not enough detail' } } },
      );
    });

    it('should save rating up with optional comment', async () => {
      await model.saveFeedback('summary1', 'up', 'Very helpful');
      const call = col.updateOne.mock.calls[0];
      expect(call[1].$set.feedback.rating).toBe('up');
      expect(call[1].$set.feedback.comment).toBe('Very helpful');
    });
  });

  // ─── deleteById ─────────────────────────────────────

  describe('deleteById', () => {
    it('should delete summary by id', async () => {
      await model.deleteById('summary1');
      expect(col.deleteOne).toHaveBeenCalledWith({ _id: 'summary1' });
    });
  });
});
