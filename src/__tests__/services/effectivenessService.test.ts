import { EffectivenessService } from '../../services/effectivenessService';

const TEST_CONV_ID = '507f1f77bcf86cd799439011';

const baseConversation = {
  _id: TEST_CONV_ID,
  domainId: 'default',
  userId: 1001,
  problemId: 'P1000',
  startTime: new Date('2026-01-01T10:00:00Z'),
  endTime: new Date('2026-01-01T10:30:00Z'),
  messageCount: 4,
  isEffective: false,
  tags: [],
};

function createMockCtx(
  messages: any[] = [],
  convOverrides: Record<string, any> = {},
  dbOverrides: Record<string, any> = {},
) {
  const mockMessageModel = {
    findByConversationId: jest.fn().mockResolvedValue(messages),
  };
  const mockConversationModel = {
    findById: jest.fn().mockResolvedValue({ ...baseConversation, ...convOverrides }),
    findByFilters: jest.fn().mockResolvedValue({ conversations: [], total: 0 }),
    findPendingBackfill: jest.fn().mockResolvedValue([]),
    updateEffectiveness: jest.fn().mockResolvedValue(undefined),
    updateMetrics: jest.fn().mockResolvedValue(undefined),
  };
  const mockJailbreakLogModel = {
    create: jest.fn().mockResolvedValue(undefined),
  };

  const mockDocumentCollection = {
    findOne: jest.fn().mockResolvedValue({ nSubmit: 100, nAccept: 40 }),
  };
  const mockRecordCollection = {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
  return {
    ctx: {
      get: jest.fn((name: string) => {
        if (name === 'messageModel') return mockMessageModel;
        if (name === 'conversationModel') return mockConversationModel;
        if (name === 'jailbreakLogModel') return mockJailbreakLogModel;
        return null;
      }),
      db: {
        collection: jest.fn((name: string) => {
          if (name === 'document') return mockDocumentCollection;
          if (name === 'record') return mockRecordCollection;
          return dbOverrides[name] || {};
        }),
      },
      logger: {
        error: jest.fn(),
        info: jest.fn(),
      },
    },
    mockMessageModel,
    mockConversationModel,
    mockJailbreakLogModel,
    mockDocumentCollection,
    mockRecordCollection,
  };
}

function makeStudentMsg(content: string) {
  return { role: 'student', content };
}
function makeAiMsg(content: string) {
  return { role: 'ai', content };
}

describe('EffectivenessService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('analyzeConversation — Phase A (immediate)', () => {
    it('should return false when conversation not found', async () => {
      const { ctx, mockConversationModel } = createMockCtx([]);
      mockConversationModel.findById.mockResolvedValue(null);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation(TEST_CONV_ID);
      expect(result).toBe(false);
    });

    it('should compute Group 1 signals correctly', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下动态规划的思路'),
        makeStudentMsg('明白了，那优化的方向是什么呢？可以降低时间复杂度吗'),
        makeAiMsg('这道题可以用动态规划来解决'),
        makeAiMsg('可以通过空间优化将复杂度降低'),
      ];
      const { ctx, mockConversationModel } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      await service.analyzeConversation(TEST_CONV_ID);

      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          v: 1,
          studentMessageCount: 2,
          studentTotalLength: messages[0].content.length + messages[1].content.length,
          submissionsAfter: null,
          firstAcceptedIndex: null,
          backfilledAt: null,
        }),
        expect.any(Boolean),
      );
    });

    it('should use $set idempotent write (updateMetrics, not $inc)', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解动态规划'),
        makeStudentMsg('明白了，那优化的方向是什么呢'),
        makeAiMsg('可以用动态规划'),
        makeAiMsg('复杂度是 O(n)'),
      ];
      const { ctx, mockConversationModel } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      // Call twice to simulate concurrent fire-and-forget
      await service.analyzeConversation(TEST_CONV_ID);
      await service.analyzeConversation(TEST_CONV_ID);

      // Both calls should use updateMetrics (idempotent $set), not incrementing
      expect(mockConversationModel.updateMetrics).toHaveBeenCalledTimes(2);
      const firstCall = mockConversationModel.updateMetrics.mock.calls[0][1];
      const secondCall = mockConversationModel.updateMetrics.mock.calls[1][1];
      expect(firstCall.studentMessageCount).toBe(secondCall.studentMessageCount);
    });

    it('should return false before backfill even when messages are sufficient', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下动态规划的思路'),
        makeStudentMsg('明白了，那优化的方向是什么呢？可以降低时间复杂度吗'),
        makeAiMsg('这道题可以用动态规划来解决'),
        makeAiMsg('可以通过空间优化将复杂度降低'),
      ];
      const { ctx } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      // Phase A always returns false (conservative, waiting for backfill)
      const result = await service.analyzeConversation(TEST_CONV_ID);
      expect(result).toBe(false);
    });

    it('should return false when only 1 student message', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下'),
        makeAiMsg('可以用动态规划'),
        makeAiMsg('复杂度是 O(n)'),
      ];
      const { ctx } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation(TEST_CONV_ID);
      expect(result).toBe(false);
    });

    it('should return false when student messages are too short', async () => {
      const messages = [
        makeStudentMsg('不懂'),
        makeStudentMsg('还是不懂'),
        makeAiMsg('这道题需要理解递归的概念'),
        makeAiMsg('递归是指函数调用自身'),
      ];
      const { ctx } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation(TEST_CONV_ID);
      expect(result).toBe(false);
    });

    it('should snapshot problemDifficulty from document collection', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下动态规划'),
        makeStudentMsg('明白了，那优化的方向是什么呢？可以降低复杂度吗'),
        makeAiMsg('可以用动态规划'),
        makeAiMsg('复杂度是 O(n)'),
      ];
      const { ctx, mockConversationModel, mockDocumentCollection } = createMockCtx(messages);
      mockDocumentCollection.findOne.mockResolvedValue({ nSubmit: 200, nAccept: 80 });
      const service = new EffectivenessService(ctx as any);

      await service.analyzeConversation(TEST_CONV_ID);

      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          problemDifficulty: 0.4,  // 80/200
        }),
        expect.any(Boolean),
      );
    });

    it('should set problemDifficulty to null when pid is not numeric', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下动态规划'),
        makeStudentMsg('明白了那优化的方向是什么呢'),
        makeAiMsg('可以用动态规划'),
        makeAiMsg('复杂度是 O(n)'),
      ];
      const { ctx, mockConversationModel } = createMockCtx(messages, { problemId: 'abc-invalid' });
      const service = new EffectivenessService(ctx as any);

      await service.analyzeConversation(TEST_CONV_ID);

      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          problemDifficulty: null,
        }),
        expect.any(Boolean),
      );
    });

    it('should set backfilledAt to null (pending backfill)', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下动态规划'),
        makeStudentMsg('明白了那优化的方向是什么呢？可以降低复杂度吗'),
        makeAiMsg('可以用动态规划'),
        makeAiMsg('复杂度是 O(n)'),
      ];
      const { ctx, mockConversationModel } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      await service.analyzeConversation(TEST_CONV_ID);

      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ backfilledAt: null }),
        expect.any(Boolean),
      );
    });

    it('should handle errors gracefully and return false', async () => {
      const { ctx } = createMockCtx([]);
      (ctx.get as jest.Mock).mockImplementation((name: string) => {
        if (name === 'messageModel') {
          return { findByConversationId: jest.fn().mockRejectedValue(new Error('DB error')) };
        }
        if (name === 'conversationModel') {
          return { findById: jest.fn().mockRejectedValue(new Error('DB error')) };
        }
        return null;
      });
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation(TEST_CONV_ID);
      expect(result).toBe(false);
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });

  describe('backfillBehavioralSignals — Phase B (delayed)', () => {
    it('should query record collection with correct domainId and numeric pid', async () => {
      const existingMetrics = {
        v: 1 as const,
        studentMessageCount: 2,
        studentTotalLength: 100,
        submissionsAfter: null,
        firstAcceptedIndex: null,
        problemDifficulty: 0.4,
        backfilledAt: null,
      };
      const { ctx, mockConversationModel, mockRecordCollection } = createMockCtx(
        [], { metrics: existingMetrics },
      );
      const service = new EffectivenessService(ctx as any);

      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      expect(ctx.db.collection).toHaveBeenCalledWith('record');
      const findCall = mockRecordCollection.find.mock.calls[0][0];
      expect(findCall.domainId).toBe('default');
      expect(findCall.uid).toBe(1001);
      expect(findCall.pid).toBe(1000); // numeric, stripped 'P' prefix
    });

    it('should compute submissionsAfter and firstAcceptedIndex', async () => {
      const existingMetrics = {
        v: 1 as const,
        studentMessageCount: 2,
        studentTotalLength: 100,
        submissionsAfter: null,
        firstAcceptedIndex: null,
        problemDifficulty: 0.4,
        backfilledAt: null,
      };
      const { ctx, mockConversationModel, mockRecordCollection } = createMockCtx(
        [], { metrics: existingMetrics },
      );
      // Mock 3 submissions: WA, WA, AC
      mockRecordCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { status: 3 }, // WA
            { status: 3 }, // WA
            { status: 1 }, // AC
          ]),
        }),
      });
      const service = new EffectivenessService(ctx as any);

      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          submissionsAfter: 3,
          firstAcceptedIndex: 2,
          backfilledAt: expect.any(Date),
        }),
        expect.any(Boolean),
      );
    });

    it('should set submissionsAfter=0 when no submissions', async () => {
      const existingMetrics = {
        v: 1 as const,
        studentMessageCount: 2,
        studentTotalLength: 100,
        submissionsAfter: null,
        firstAcceptedIndex: null,
        problemDifficulty: 0.4,
        backfilledAt: null,
      };
      const { ctx, mockConversationModel } = createMockCtx([], { metrics: existingMetrics });
      const service = new EffectivenessService(ctx as any);

      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          submissionsAfter: 0,
          firstAcceptedIndex: null,
        }),
        expect.any(Boolean),
      );
    });

    it('should set submissionsAfter=null for domainId=system', async () => {
      const existingMetrics = {
        v: 1 as const,
        studentMessageCount: 2,
        studentTotalLength: 100,
        submissionsAfter: null,
        firstAcceptedIndex: null,
        problemDifficulty: null,
        backfilledAt: null,
      };
      const { ctx, mockConversationModel } = createMockCtx(
        [], { domainId: 'system', metrics: existingMetrics },
      );
      const service = new EffectivenessService(ctx as any);

      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          submissionsAfter: null,
          firstAcceptedIndex: null,
          backfilledAt: expect.any(Date),
        }),
        expect.any(Boolean),
      );
    });

    it('should skip when conversation has no metrics', async () => {
      const { ctx, mockConversationModel } = createMockCtx([], { metrics: undefined });
      const service = new EffectivenessService(ctx as any);

      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      expect(mockConversationModel.updateMetrics).not.toHaveBeenCalled();
    });
  });

  describe('isEffective derivation (post-backfill)', () => {
    function makeMetrics(overrides: Partial<typeof baseMetrics> = {}) {
      return { ...baseMetrics, ...overrides };
    }
    const baseMetrics = {
      v: 1 as const,
      studentMessageCount: 2,
      studentTotalLength: 100,
      submissionsAfter: null as number | null,
      firstAcceptedIndex: null as number | null,
      problemDifficulty: 0.4,
      backfilledAt: null as Date | null,
    };

    it('should derive true when AC after backfill', async () => {
      const { ctx, mockConversationModel, mockRecordCollection } = createMockCtx(
        [], { metrics: makeMetrics() },
      );
      mockRecordCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([{ status: 1 }]),
        }),
      });
      const service = new EffectivenessService(ctx as any);
      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      const [, , isEffective] = mockConversationModel.updateMetrics.mock.calls[0];
      expect(isEffective).toBe(true);
    });

    it('should derive false when 0 submissions (asked but never tried)', async () => {
      const { ctx, mockConversationModel } = createMockCtx(
        [], { metrics: makeMetrics() },
      );
      const service = new EffectivenessService(ctx as any);
      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      const [, , isEffective] = mockConversationModel.updateMetrics.mock.calls[0];
      expect(isEffective).toBe(false);
    });

    it('should derive true when all submissions failed but student engaged (msg>=3)', async () => {
      const { ctx, mockConversationModel, mockRecordCollection } = createMockCtx(
        [], { metrics: makeMetrics({ studentMessageCount: 3 }) },
      );
      mockRecordCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([{ status: 3 }, { status: 3 }]),
        }),
      });
      const service = new EffectivenessService(ctx as any);
      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      const [, , isEffective] = mockConversationModel.updateMetrics.mock.calls[0];
      expect(isEffective).toBe(true);
    });

    it('should derive false when all submissions failed and low engagement (msg<3)', async () => {
      const { ctx, mockConversationModel, mockRecordCollection } = createMockCtx(
        [], { metrics: makeMetrics({ studentMessageCount: 2 }) },
      );
      mockRecordCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([{ status: 3 }]),
        }),
      });
      const service = new EffectivenessService(ctx as any);
      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      const [, , isEffective] = mockConversationModel.updateMetrics.mock.calls[0];
      expect(isEffective).toBe(false);
    });

    it('should derive true for no-problem consultation with deep engagement (msg>=4)', async () => {
      const { ctx, mockConversationModel } = createMockCtx(
        [], {
          domainId: 'system',
          metrics: makeMetrics({ studentMessageCount: 4, studentTotalLength: 200 }),
        },
      );
      const service = new EffectivenessService(ctx as any);
      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      const [, , isEffective] = mockConversationModel.updateMetrics.mock.calls[0];
      expect(isEffective).toBe(true);
    });

    it('should derive false for no-problem consultation with shallow engagement (msg<4)', async () => {
      const { ctx, mockConversationModel } = createMockCtx(
        [], {
          domainId: 'system',
          metrics: makeMetrics({ studentMessageCount: 2, studentTotalLength: 100 }),
        },
      );
      const service = new EffectivenessService(ctx as any);
      await service.backfillBehavioralSignals(TEST_CONV_ID as any);

      const [, , isEffective] = mockConversationModel.updateMetrics.mock.calls[0];
      expect(isEffective).toBe(false);
    });
  });

  describe('compensateBackfill', () => {
    it('should call findPendingBackfill and process pending docs', async () => {
      const pendingMetrics = {
        v: 1 as const,
        studentMessageCount: 3,
        studentTotalLength: 150,
        submissionsAfter: null,
        firstAcceptedIndex: null,
        problemDifficulty: 0.4,
        backfilledAt: null,
      };
      const pendingDoc = { ...baseConversation, metrics: pendingMetrics };
      // findById must return the same doc with metrics for backfillBehavioralSignals
      const { ctx, mockConversationModel } = createMockCtx([], { metrics: pendingMetrics });
      mockConversationModel.findPendingBackfill.mockResolvedValue([pendingDoc]);
      const service = new EffectivenessService(ctx as any);

      const count = await service.compensateBackfill();

      expect(mockConversationModel.findPendingBackfill).toHaveBeenCalledWith(
        expect.any(Date), 100,
      );
      expect(count).toBe(1);
      expect(mockConversationModel.updateMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ backfilledAt: expect.any(Date) }),
        expect.any(Boolean),
      );
    });

    it('should return 0 when no pending docs', async () => {
      const { ctx, mockConversationModel } = createMockCtx();
      mockConversationModel.findPendingBackfill.mockResolvedValue([]);
      const service = new EffectivenessService(ctx as any);

      const count = await service.compensateBackfill();
      expect(count).toBe(0);
      expect(mockConversationModel.updateMetrics).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const { ctx, mockConversationModel } = createMockCtx();
      mockConversationModel.findPendingBackfill.mockRejectedValue(new Error('DB error'));
      const service = new EffectivenessService(ctx as any);

      const count = await service.compensateBackfill();
      expect(count).toBe(0);
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });

  describe('logJailbreakAttempt', () => {
    it('should create a jailbreak log entry', async () => {
      const { ctx, mockJailbreakLogModel } = createMockCtx();
      const service = new EffectivenessService(ctx as any);

      await service.logJailbreakAttempt({
        userId: 1001,
        problemId: 'P1000',
        matchedPattern: 'ignore.*prompt',
        matchedText: 'ignore all previous prompts',
      });

      expect(mockJailbreakLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1001,
          problemId: 'P1000',
          matchedPattern: 'ignore.*prompt',
          matchedText: 'ignore all previous prompts',
        })
      );
    });

    it('should not throw on log failure', async () => {
      const { ctx } = createMockCtx();
      (ctx.get as jest.Mock).mockImplementation((name: string) => {
        if (name === 'jailbreakLogModel') {
          return { create: jest.fn().mockRejectedValue(new Error('DB write fail')) };
        }
        return null;
      });
      const service = new EffectivenessService(ctx as any);

      await expect(
        service.logJailbreakAttempt({
          matchedPattern: 'test',
          matchedText: 'test',
        })
      ).resolves.toBeUndefined();
    });
  });
});
