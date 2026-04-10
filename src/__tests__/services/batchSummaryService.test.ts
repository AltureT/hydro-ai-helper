import { BatchSummaryService, ProblemInfo, SSEEvent } from '../../services/batchSummaryService';

// Use plain string IDs as ObjectIdType stand-ins
type FakeId = any;

function makeId(n: number): FakeId {
  return `id_${n}` as any;
}

function makeJob(overrides: Partial<any> = {}): any {
  return {
    _id: makeId(1),
    domainId: 'test-domain',
    contestId: makeId(2),
    contestTitle: 'Test Contest',
    createdBy: 1,
    status: 'pending',
    totalStudents: 1,
    completedCount: 0,
    failedCount: 0,
    config: {
      concurrency: 10,
      locale: 'zh',
    },
    createdAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

function makePendingSummary(userId: number): any {
  return {
    _id: makeId(userId + 100),
    jobId: makeId(1),
    domainId: 'test-domain',
    contestId: makeId(2),
    userId,
    status: 'pending',
    publishStatus: 'draft',
    summary: null,
    originalSummary: null,
    problemSnapshots: [],
    tokenUsage: { prompt: 0, completion: 0 },
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeRecord(pid: string | number, uid: number, n: number): any {
  return {
    _id: makeId(n),
    pid: typeof pid === 'string' ? Number(pid) || pid : pid,
    uid,
    domainId: 'test-domain',
    code: `code_${n}`,
    status: 1, // AC
    score: 100,
    lang: 'cpp',
    time: 100,
    memory: 1024,
    judgeAt: new Date(1000000 + n * 60000),
  };
}

describe('BatchSummaryService', () => {
  let mockJobModel: any;
  let mockSummaryModel: any;
  let mockAiClient: any;
  let mockTokenUsageModel: any;
  let mockDb: any;
  let mockRecordCollection: any;
  let service: BatchSummaryService;

  const problems: ProblemInfo[] = [
    { pid: '1', title: 'Problem 1', content: 'Write a solution' },
  ];

  beforeEach(() => {
    mockRecordCollection = {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([makeRecord('1', 42, 1)]),
        }),
      }),
    };

    mockDb = {
      collection: jest.fn().mockReturnValue(mockRecordCollection),
    };

    mockJobModel = {
      findById: jest.fn().mockResolvedValue(makeJob({ status: 'running' })),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      incrementCompleted: jest.fn().mockResolvedValue(undefined),
      incrementFailed: jest.fn().mockResolvedValue(undefined),
    };

    mockSummaryModel = {
      findAllByJob: jest.fn().mockResolvedValue([makePendingSummary(42)]),
      findPendingByJob: jest.fn().mockResolvedValue([makePendingSummary(42)]),
      resetGeneratingToPending: jest.fn().mockResolvedValue(0),
      markGenerating: jest.fn().mockResolvedValue(undefined),
      completeSummary: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    mockAiClient = {
      chat: jest.fn().mockResolvedValue({
        content: 'Great work on this problem! You demonstrated...',
        usage: { prompt_tokens: 500, completion_tokens: 200 },
      }),
    };

    mockTokenUsageModel = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    service = new BatchSummaryService(
      mockDb,
      mockJobModel,
      mockSummaryModel,
      mockAiClient,
      mockTokenUsageModel,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── Test 1: Process a single student successfully ──────────────────────────

  describe('execute - success path', () => {
    it('should process a single student successfully', async () => {
      const job = makeJob();
      const events: SSEEvent[] = [];
      const onEvent = (e: SSEEvent) => events.push(e);

      await service.execute(job, problems, onEvent);

      // Job status: running → completed
      expect(mockJobModel.updateStatus).toHaveBeenCalledWith(job._id, 'running');
      expect(mockJobModel.updateStatus).toHaveBeenCalledWith(job._id, 'completed');

      // Fetched all pending summaries
      expect(mockSummaryModel.findAllByJob).toHaveBeenCalledWith(job._id);

      // markGenerating called for the student
      expect(mockSummaryModel.markGenerating).toHaveBeenCalledWith(makeId(142));

      // AI chat was called once
      expect(mockAiClient.chat).toHaveBeenCalledTimes(1);

      // completeSummary called with the summary content
      expect(mockSummaryModel.completeSummary).toHaveBeenCalledWith(
        makeId(142),
        'Great work on this problem! You demonstrated...',
        expect.any(Array),
        { prompt: 500, completion: 200 },
      );

      // incrementCompleted called
      expect(mockJobModel.incrementCompleted).toHaveBeenCalledWith(job._id);

      // student_done event emitted
      const studentDoneEvent = events.find((e) => e.type === 'student_done');
      expect(studentDoneEvent).toBeDefined();
      expect(studentDoneEvent).toMatchObject({
        type: 'student_done',
        userId: 42,
        status: 'completed',
      });

      // job_done event emitted
      const jobDoneEvent = events.find((e) => e.type === 'job_done');
      expect(jobDoneEvent).toBeDefined();
      expect(jobDoneEvent).toMatchObject({
        type: 'job_done',
        completed: 1,
        failed: 0,
      });

      // progress event emitted
      const progressEvent = events.find((e) => e.type === 'progress');
      expect(progressEvent).toBeDefined();
    });

    it('should fetch records from db.collection("record")', async () => {
      const job = makeJob();
      await service.execute(job, problems, () => {});

      expect(mockDb.collection).toHaveBeenCalledWith('record');
      expect(mockRecordCollection.find).toHaveBeenCalledWith(
        expect.objectContaining({
          domainId: 'test-domain',
          uid: 42,
          pid: { $in: [1] },
        }),
      );
    });

    it('should record token usage', async () => {
      const job = makeJob();
      await service.execute(job, problems, () => {});

      expect(mockTokenUsageModel.record).toHaveBeenCalledWith(
        expect.objectContaining({
          domainId: 'test-domain',
          promptTokens: 500,
          completionTokens: 200,
        }),
      );
    });
  });

  // ─── Test 2: Handle AI call failure ─────────────────────────────────────────

  describe('execute - failure path', () => {
    it('should handle AI call failure gracefully', async () => {
      mockAiClient.chat.mockRejectedValue(new Error('API rate limit'));

      const job = makeJob();
      const events: SSEEvent[] = [];
      await service.execute(job, problems, (e) => events.push(e));

      // markFailed called for the student
      expect(mockSummaryModel.markFailed).toHaveBeenCalledWith(
        makeId(142),
        expect.stringContaining('API rate limit'),
      );

      // incrementFailed called
      expect(mockJobModel.incrementFailed).toHaveBeenCalledWith(job._id);

      // student_failed event emitted
      const studentFailedEvent = events.find((e) => e.type === 'student_failed');
      expect(studentFailedEvent).toBeDefined();
      expect(studentFailedEvent).toMatchObject({
        type: 'student_failed',
        userId: 42,
        error: expect.stringContaining('API rate limit'),
      });

      // job should still complete (with failed count)
      const jobDoneEvent = events.find((e) => e.type === 'job_done');
      expect(jobDoneEvent).toBeDefined();
      expect(jobDoneEvent).toMatchObject({
        type: 'job_done',
        completed: 0,
        failed: 1,
      });

      // completeSummary should NOT have been called
      expect(mockSummaryModel.completeSummary).not.toHaveBeenCalled();
    });

    it('should set job status to "failed" when all students fail', async () => {
      mockAiClient.chat.mockRejectedValue(new Error('All failed'));

      const job = makeJob({ totalStudents: 1 });
      await service.execute(job, problems, () => {});

      expect(mockJobModel.updateStatus).toHaveBeenCalledWith(job._id, 'failed');
    });

    it('should set job status to "completed" when at least one student succeeds', async () => {
      // Two students: first succeeds, second fails
      mockSummaryModel.findAllByJob.mockResolvedValue([
        makePendingSummary(10),
        makePendingSummary(11),
      ]);

      // First call succeeds, second fails
      let callCount = 0;
      mockAiClient.chat.mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.reject(new Error('fail'));
        return Promise.resolve({
          content: 'Good job!',
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
      });

      const job = makeJob({ totalStudents: 2 });
      await service.execute(job, problems, () => {});

      expect(mockJobModel.updateStatus).toHaveBeenCalledWith(job._id, 'completed');
    });
  });

  // ─── Test 3: Respect concurrency limit ──────────────────────────────────────

  describe('execute - concurrency', () => {
    it('should not exceed config.concurrency parallel calls', async () => {
      const TOTAL = 8;
      const CONCURRENCY = 3;

      // Set up 8 pending summaries
      const summaries = Array.from({ length: TOTAL }, (_, i) => makePendingSummary(i + 1));
      mockSummaryModel.findAllByJob.mockResolvedValue(summaries);

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      // Simulate slow AI calls to detect concurrency
      mockAiClient.chat.mockImplementation(
        () =>
          new Promise<any>((resolve) => {
            currentConcurrent++;
            if (currentConcurrent > maxConcurrent) {
              maxConcurrent = currentConcurrent;
            }
            // Resolve asynchronously next tick
            setImmediate(() => {
              currentConcurrent--;
              resolve({
                content: 'summary',
                usage: { prompt_tokens: 10, completion_tokens: 10 },
              });
            });
          }),
      );

      const job = makeJob({ totalStudents: TOTAL, config: { concurrency: CONCURRENCY, locale: 'zh' } });
      await service.execute(job, problems, () => {});

      // Max concurrent should not exceed configured concurrency
      expect(maxConcurrent).toBeLessThanOrEqual(CONCURRENCY);
      // All 8 students should be processed
      expect(mockAiClient.chat).toHaveBeenCalledTimes(TOTAL);
    });

    it('should process all students even when concurrency < total', async () => {
      const TOTAL = 5;
      const summaries = Array.from({ length: TOTAL }, (_, i) => makePendingSummary(i + 1));
      mockSummaryModel.findAllByJob.mockResolvedValue(summaries);

      const job = makeJob({ totalStudents: TOTAL, config: { concurrency: 2, locale: 'zh' } });
      await service.execute(job, problems, () => {});

      expect(mockSummaryModel.completeSummary).toHaveBeenCalledTimes(TOTAL);
    });
  });

  // ─── Additional edge cases ──────────────────────────────────────────────────

  describe('execute - edge cases', () => {
    it('should handle no pending summaries gracefully', async () => {
      mockSummaryModel.findAllByJob.mockResolvedValue([]);

      const job = makeJob({ totalStudents: 0 });
      const events: SSEEvent[] = [];
      await service.execute(job, problems, (e) => events.push(e));

      expect(mockAiClient.chat).not.toHaveBeenCalled();
      const jobDoneEvent = events.find((e) => e.type === 'job_done');
      expect(jobDoneEvent).toBeDefined();
      expect(jobDoneEvent).toMatchObject({ type: 'job_done', completed: 0, failed: 0 });
    });

    it('should handle student with no submissions', async () => {
      // Return empty submissions for this student
      mockRecordCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      });

      const job = makeJob();
      const events: SSEEvent[] = [];
      await service.execute(job, problems, (e) => events.push(e));

      // AI should still be called even with no submissions
      expect(mockAiClient.chat).toHaveBeenCalledTimes(1);
      const studentDoneEvent = events.find((e) => e.type === 'student_done');
      expect(studentDoneEvent).toBeDefined();
    });

    it('should use default concurrency of 10 when not specified', async () => {
      const job = makeJob({ config: { locale: 'zh' } }); // no concurrency key
      // Should not throw
      await expect(service.execute(job, problems, () => {})).resolves.toBeUndefined();
    });
  });
});
