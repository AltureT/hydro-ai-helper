import { EffectivenessService } from '../../services/effectivenessService';

function createMockCtx(messages: any[] = [], overrides: Record<string, any> = {}) {
  const mockMessageModel = {
    findByConversationId: jest.fn().mockResolvedValue(messages),
  };
  const mockConversationModel = {
    updateEffectiveness: jest.fn().mockResolvedValue(undefined),
  };
  const mockJailbreakLogModel = {
    create: jest.fn().mockResolvedValue(undefined),
  };

  return {
    ctx: {
      get: jest.fn((name: string) => {
        if (name === 'messageModel') return mockMessageModel;
        if (name === 'conversationModel') return mockConversationModel;
        if (name === 'jailbreakLogModel') return mockJailbreakLogModel;
        return null;
      }),
      logger: {
        error: jest.fn(),
      },
      ...overrides,
    },
    mockMessageModel,
    mockConversationModel,
    mockJailbreakLogModel,
  };
}

function makeStudentMsg(content: string) {
  return { role: 'student', content };
}
function makeAiMsg(content: string) {
  return { role: 'ai', content };
}

describe('EffectivenessService', () => {
  describe('analyzeConversation', () => {
    it('should return false when no messages exist', async () => {
      const { ctx, mockConversationModel } = createMockCtx([]);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation('507f1f77bcf86cd799439011');

      expect(result).toBe(false);
      expect(mockConversationModel.updateEffectiveness).toHaveBeenCalledWith(
        expect.anything(),
        false
      );
    });

    it('should return false when not enough student messages', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下'),
        makeAiMsg('这道题可以用动态规划来解决'),
        makeAiMsg('时间复杂度为 O(n)'),
      ];
      const { ctx } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation('507f1f77bcf86cd799439011');
      expect(result).toBe(false);
    });

    it('should return false when not enough AI messages', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么理解？'),
        makeStudentMsg('那优化的思路是什么呢？'),
        makeAiMsg('可以用贪心算法'),
      ];
      const { ctx } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation('507f1f77bcf86cd799439011');
      expect(result).toBe(false);
    });

    it('should return false when student messages are too short', async () => {
      const messages = [
        makeStudentMsg('不懂'),
        makeStudentMsg('还是不理解'),
        makeAiMsg('这道题需要理解递归的概念'),
        makeAiMsg('递归是指函数调用自身'),
      ];
      const { ctx } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation('507f1f77bcf86cd799439011');
      expect(result).toBe(false);
    });

    it('should return false when no learning keywords matched', async () => {
      const messages = [
        makeStudentMsg('这道题的输入输出格式是什么样子的呢？我看不懂题目的描述'),
        makeStudentMsg('好的，那数据范围大概是多少呢？我需要知道有多大的数字'),
        makeAiMsg('这道题的输入是一个整数 n'),
        makeAiMsg('数据范围是 1 到 1000'),
      ];
      const { ctx } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation('507f1f77bcf86cd799439011');
      expect(result).toBe(false);
    });

    it('should return true when all conditions are met', async () => {
      const messages = [
        makeStudentMsg('这道题的算法复杂度怎么分析？我想理解一下动态规划的思路'),
        makeStudentMsg('明白了，那优化的方向是什么呢？可以降低时间复杂度吗'),
        makeAiMsg('这道题可以用动态规划来解决，核心是状态转移方程'),
        makeAiMsg('可以通过空间优化将复杂度从 O(n^2) 降低到 O(n)'),
      ];
      const { ctx, mockConversationModel } = createMockCtx(messages);
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation('507f1f77bcf86cd799439011');

      expect(result).toBe(true);
      expect(mockConversationModel.updateEffectiveness).toHaveBeenCalledWith(
        expect.anything(),
        true
      );
    });

    it('should handle errors gracefully and return false', async () => {
      const { ctx } = createMockCtx([]);
      // Override messageModel to throw
      (ctx.get as jest.Mock).mockImplementation((name: string) => {
        if (name === 'messageModel') {
          return { findByConversationId: jest.fn().mockRejectedValue(new Error('DB error')) };
        }
        if (name === 'conversationModel') {
          return { updateEffectiveness: jest.fn() };
        }
        return null;
      });
      const service = new EffectivenessService(ctx as any);

      const result = await service.analyzeConversation('507f1f77bcf86cd799439011');

      expect(result).toBe(false);
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
