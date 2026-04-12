import {
  buildMainPrompt,
  buildDeepDivePrompt,
  TeachingSuggestionService,
  MainPromptInput,
} from '../../services/teachingSuggestionService';
import { TeachingFinding } from '../../models/teachingSummary';

// ─── Fixtures ────────────────────────────────────────────

function makeFinding(overrides: Partial<TeachingFinding> = {}): TeachingFinding {
  return {
    id: 'f1',
    dimension: 'commonError',
    severity: 'high',
    title: '数组越界错误',
    evidence: {
      affectedStudents: [1, 2, 3],
      affectedProblems: [101],
      metrics: { errorRate: 0.35 },
      samples: {
        code: ['int arr[5]; arr[5] = 1;'],
        conversations: ['学生：这道题怎么做？AI：请先思考边界条件。'],
      },
    },
    needsDeepDive: true,
    ...overrides,
  };
}

function makeInput(overrides: Partial<MainPromptInput> = {}): MainPromptInput {
  return {
    contestTitle: '第一次周赛',
    contestContent: '考察数组和循环基础知识',
    teachingFocus: '数组边界条件处理',
    stats: {
      totalStudents: 30,
      participatedStudents: 28,
      aiUserCount: 15,
      problemCount: 4,
    },
    findings: [makeFinding()],
    ...overrides,
  };
}

// ─── buildMainPrompt ─────────────────────────────────────

describe('buildMainPrompt', () => {
  it('should include teaching context in user prompt', () => {
    const input = makeInput();
    const { user, system } = buildMainPrompt(input);

    expect(user).toContain('第一次周赛');
    expect(user).toContain('考察数组和循环基础知识');
    expect(user).toContain('数组边界条件处理');
    expect(user).toContain('30');
    expect(system.length).toBeGreaterThan(0);
  });

  it('should include stats and findings JSON in user prompt', () => {
    const input = makeInput();
    const { user } = buildMainPrompt(input);

    expect(user).toContain('总学生数：30');
    expect(user).toContain('参与学生数：28');
    expect(user).toContain('使用AI辅助的学生数：15');
    expect(user).toContain('题目数量：4');
    // findings serialized as JSON (without samples)
    expect(user).toContain('数组越界错误');
  });

  it('should strip samples from findings in user prompt', () => {
    const input = makeInput();
    const { user } = buildMainPrompt(input);

    // samples should NOT appear
    expect(user).not.toContain('int arr[5]');
    expect(user).not.toContain('这道题怎么做');
    // but other finding data should appear
    expect(user).toContain('数组越界错误');
  });

  it('should mark "教学目标未提供" when both contestContent and teachingFocus are empty', () => {
    const input = makeInput({
      contestContent: '',
      teachingFocus: '',
    });
    const { user } = buildMainPrompt(input);

    expect(user).toContain('教学目标未提供');
  });

  it('should mark "教学目标未提供" when contestContent and teachingFocus are undefined/whitespace', () => {
    const input = makeInput({
      contestContent: '   ',
      teachingFocus: undefined,
    });
    const { user } = buildMainPrompt(input);

    expect(user).toContain('教学目标未提供');
  });

  it('system prompt should contain P0/P1/P2 and "严禁捏造"', () => {
    const { system } = buildMainPrompt(makeInput());

    expect(system).toContain('P0');
    expect(system).toContain('P1');
    expect(system).toContain('P2');
    expect(system).toContain('严禁捏造');
  });

  it('should not mark "教学目标未提供" when only teachingFocus is provided', () => {
    const input = makeInput({
      contestContent: '',
      teachingFocus: '理解递归',
    });
    const { user } = buildMainPrompt(input);

    expect(user).not.toContain('教学目标未提供');
    expect(user).toContain('理解递归');
  });

  it('should include few-shot quality examples in system prompt', () => {
    const input = makeInput();
    const { system } = buildMainPrompt(input);
    expect(system).toContain('坏例子');
    expect(system).toContain('好例子');
    expect(system).toContain('明天上课就能直接用');
  });

  it('should include edge case handling in system prompt', () => {
    const input = makeInput();
    const { system } = buildMainPrompt(input);
    expect(system).toContain('培优建议');
    expect(system).toContain('AI 使用数据为 0');
  });

  it('should include P0/P1/P2 framework with classroom action format', () => {
    const input = makeInput();
    const { system } = buildMainPrompt(input);
    expect(system).toContain('开场提问');
    expect(system).toContain('演示/板书');
    expect(system).toContain('当堂检验');
    expect(system).toContain('persistent_learner');
    expect(system).toContain('burst_then_quit');
  });

  it('should format user prompt with problem contexts', () => {
    const input = makeInput({
      problemContexts: [
        { pid: 101, title: '数组求和', content: '给定一个数组...' },
      ],
    });
    const { user } = buildMainPrompt(input);
    expect(user).toContain('## 题目内容');
    expect(user).toContain('101. 数组求和');
    expect(user).toContain('给定一个数组');
  });

  it('should omit problem section when no contexts provided', () => {
    const input = makeInput({ problemContexts: undefined });
    const { user } = buildMainPrompt(input);
    expect(user).not.toContain('## 题目内容');
  });
});

// ─── buildDeepDivePrompt ─────────────────────────────────

describe('buildDeepDivePrompt', () => {
  it('should include finding details in user prompt', () => {
    const finding = makeFinding();
    const { user } = buildDeepDivePrompt(finding, '给定一个数组，找出最大值。');

    expect(user).toContain('数组越界错误');
    expect(user).toContain('给定一个数组，找出最大值。');
    expect(user).toContain('commonError');
    expect(user).toContain('high');
  });

  it('should include code samples in user prompt', () => {
    const finding = makeFinding();
    const { user } = buildDeepDivePrompt(finding, '题目描述');

    expect(user).toContain('int arr[5]');
  });

  it('should include conversation samples in user prompt', () => {
    const finding = makeFinding();
    const { user } = buildDeepDivePrompt(finding, '题目描述');

    expect(user).toContain('这道题怎么做');
  });

  it('should include metrics in user prompt', () => {
    const finding = makeFinding();
    const { user } = buildDeepDivePrompt(finding, '题目描述');

    expect(user).toContain('errorRate');
    expect(user).toContain('0.35');
  });

  it('should handle finding with no samples gracefully', () => {
    const finding = makeFinding({
      evidence: {
        affectedStudents: [1],
        affectedProblems: [101],
        metrics: { errorRate: 0.1 },
        samples: undefined,
      },
    });
    const { user } = buildDeepDivePrompt(finding, '题目描述');

    expect(user).toContain('数组越界错误');
    expect(user).not.toContain('代码样本');
    expect(user).not.toContain('AI对话样本');
  });

  it('system prompt should contain "布卢姆"', () => {
    const finding = makeFinding();
    const { system } = buildDeepDivePrompt(finding, '题目描述');

    expect(system).toContain('布卢姆');
  });

  it('system prompt should contain scaffolding and edge case instructions', () => {
    const finding = makeFinding();
    const { system } = buildDeepDivePrompt(finding, '题目描述');

    expect(system).toContain('Scaffolding');
    expect(system).toContain('过度依赖');
  });
});

// ─── TeachingSuggestionService ───────────────────────────

describe('TeachingSuggestionService', () => {
  function makeAiClient(content: string = '分析结果') {
    return {
      chat: jest.fn().mockResolvedValue({
        content,
        usage: { promptTokens: 100, completionTokens: 50 },
      }),
    };
  }

  it('generateOverallSuggestion should call aiClient.chat with correct messages', async () => {
    const aiClient = makeAiClient('### 班级学情诊断结论\n总体良好。');
    const service = new TeachingSuggestionService(aiClient);
    const input = makeInput();

    const result = await service.generateOverallSuggestion(input);

    expect(aiClient.chat).toHaveBeenCalledTimes(1);
    const [messages, systemPrompt] = aiClient.chat.mock.calls[0];
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('第一次周赛');
    expect(systemPrompt).toContain('P0');
    expect(result.text).toBe('### 班级学情诊断结论\n总体良好。');
    expect(result.tokenUsage.promptTokens).toBe(100);
    expect(result.tokenUsage.completionTokens).toBe(50);
  });

  it('generateDeepDive should call aiClient.chat with finding details', async () => {
    const aiClient = makeAiClient('### 认知障碍诊断\n应用层障碍。');
    const service = new TeachingSuggestionService(aiClient);
    const finding = makeFinding();

    const result = await service.generateDeepDive(finding, '题目内容示例');

    expect(aiClient.chat).toHaveBeenCalledTimes(1);
    const [messages, systemPrompt] = aiClient.chat.mock.calls[0];
    expect(messages[0].content).toContain('题目内容示例');
    expect(systemPrompt).toContain('布卢姆');
    expect(result.text).toBe('### 认知障碍诊断\n应用层障碍。');
    expect(result.tokenUsage.promptTokens).toBe(100);
    expect(result.tokenUsage.completionTokens).toBe(50);
  });

  it('should handle usage with snake_case keys', async () => {
    const aiClient = {
      chat: jest.fn().mockResolvedValue({
        content: '结果',
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      }),
    };
    const service = new TeachingSuggestionService(aiClient);

    const result = await service.generateOverallSuggestion(makeInput());

    expect(result.tokenUsage.promptTokens).toBe(200);
    expect(result.tokenUsage.completionTokens).toBe(80);
  });
});
