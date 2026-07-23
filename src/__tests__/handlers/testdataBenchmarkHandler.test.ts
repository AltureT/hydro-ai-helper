import { PRIV, SystemModel } from 'hydrooj';
import { EventEmitter } from 'events';
import {
  TestdataBenchmarkHandler,
  TestdataBenchmarkHandlerPriv,
} from '../../handlers/testdataBenchmarkHandler';
import * as benchmark from '../../benchmarks/testdataBenchmark';
import * as openaiClient from '../../services/openaiClient';
import { GoJudgeSandboxRunner } from '../../services/goJudgeSandboxService';

interface HandlerLike {
  ctx: Record<string, unknown>;
  request: { body: Record<string, unknown>; headers: Record<string, string> };
  response: { status?: number; body?: any; type?: string };
  translate: jest.Mock;
  limitRate: jest.Mock;
}

function setupHandler(body: Record<string, unknown>): TestdataBenchmarkHandler & HandlerLike {
  const handler = new TestdataBenchmarkHandler() as TestdataBenchmarkHandler & HandlerLike;
  handler.ctx = {} as never;
  handler.request = {
    body,
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    },
  };
  handler.response = {};
  handler.translate = jest.fn((key: string) => key);
  handler.limitRate = jest.fn().mockResolvedValue(undefined);
  return handler;
}

const PASS_RESULT: benchmark.TestdataBenchmarkResult = {
  id: 'xor-subarrays-less-than-k',
  title: '子数组异或小于 K',
  tags: ['binary-trie'],
  passed: true,
  durationMs: 1234,
  usedModel: 'endpoint-a/model-deep',
  tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  qualityGateFailures: [],
  probes: [{
    name: '边界',
    passed: true,
    status: 'Accepted',
    expected: '0\n',
    actual: '0\n',
  }],
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  (SystemModel.get as jest.Mock).mockReturnValue('http://go-judge:5050/');
});

describe('TestdataBenchmarkHandler', () => {
  it('只允许系统管理员路由调用', () => {
    expect(TestdataBenchmarkHandlerPriv).toBe(PRIV.PRIV_EDIT_SYSTEM);
  });

  it('未明确确认付费时拒绝运行', async () => {
    const createClient = jest.spyOn(openaiClient, 'createMultiModelClientFromConfig');
    const handler = setupHandler({ caseIds: ['xor-subarrays-less-than-k'] });

    await handler.post();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('BENCHMARK_CONFIRM_REQUIRED');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('拒绝未知的基准题目 ID', async () => {
    const handler = setupHandler({ confirmCost: true, caseIds: ['unknown-case'] });

    await handler.post();

    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_BENCHMARK_CASES');
    expect(handler.limitRate).not.toHaveBeenCalled();
  });

  it('复用已保存的测试数据场景模型链与 Hydro 沙箱', async () => {
    const aiClient = { chat: jest.fn() } as never;
    const createClient = jest.spyOn(openaiClient, 'createMultiModelClientFromConfig')
      .mockResolvedValue(aiClient);
    const available = jest.spyOn(GoJudgeSandboxRunner.prototype, 'isAvailable')
      .mockResolvedValue(true);
    const run = jest.spyOn(benchmark, 'runTestdataBenchmark')
      .mockResolvedValue([PASS_RESULT]);
    const handler = setupHandler({
      confirmCost: true,
      caseIds: ['xor-subarrays-less-than-k'],
    });

    await handler.post();

    expect(createClient).toHaveBeenCalledWith(handler.ctx, undefined, 'testdataGeneration');
    expect(SystemModel.get).toHaveBeenCalledWith('hydrojudge.sandbox_host');
    expect(available).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(run).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'xor-subarrays-less-than-k' })],
      aiClient,
      expect.any(GoJudgeSandboxRunner),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(handler.response.type).toBe('application/json');
    expect(handler.response.body.report).toMatchObject({
      schemaVersion: 1,
      models: ['endpoint-a/model-deep'],
      summary: { total: 1, passed: 1, failed: 0, totalTokens: 150 },
    });
    expect(handler.response.body.aggregate.cases[0]).toMatchObject({
      id: 'xor-subarrays-less-than-k',
      passed: true,
      totalTokens: 150,
    });
  });

  it('沙箱不可用时失败关闭，不发出付费生成请求', async () => {
    jest.spyOn(openaiClient, 'createMultiModelClientFromConfig').mockResolvedValue({} as never);
    jest.spyOn(GoJudgeSandboxRunner.prototype, 'isAvailable').mockResolvedValue(false);
    const run = jest.spyOn(benchmark, 'runTestdataBenchmark');
    const handler = setupHandler({ confirmCost: true, caseIds: ['range-flip-longest-ones'] });

    await handler.post();

    expect(handler.response.status).toBe(503);
    expect(handler.response.body.code).toBe('SANDBOX_UNAVAILABLE');
    expect(handler.limitRate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('限制每个管理员的真实基准运行频率', async () => {
    jest.spyOn(openaiClient, 'createMultiModelClientFromConfig').mockResolvedValue({} as never);
    jest.spyOn(GoJudgeSandboxRunner.prototype, 'isAvailable').mockResolvedValue(true);
    const run = jest.spyOn(benchmark, 'runTestdataBenchmark');
    const rateError = Object.assign(new Error('limited'), { status: 429 });
    const handler = setupHandler({ confirmCost: true, caseIds: ['range-flip-longest-ones'] });
    handler.limitRate.mockRejectedValue(rateError);

    await handler.post();

    expect(handler.limitRate).toHaveBeenCalledWith('ai_testdata_benchmark', 3600, 2);
    expect(handler.response.status).toBe(429);
    expect(handler.response.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(run).not.toHaveBeenCalled();
  });

  it('通过 SSE 发送题目、阶段、单题结果与最终报告', async () => {
    jest.spyOn(openaiClient, 'createMultiModelClientFromConfig').mockResolvedValue({} as never);
    jest.spyOn(GoJudgeSandboxRunner.prototype, 'isAvailable').mockResolvedValue(true);
    jest.spyOn(benchmark, 'runTestdataBenchmark').mockImplementation(async (cases, _client, _runner, options) => {
      options.onCaseStart?.(cases[0], 0, 1);
      options.onProgress?.(cases[0], { stage: 'stress_testing', percent: 80, attempt: 1 });
      options.onCaseComplete?.(PASS_RESULT, 0, 1);
      return [PASS_RESULT];
    });
    const handler = setupHandler({ confirmCost: true, caseIds: ['xor-subarrays-less-than-k'] });
    handler.request.headers.accept = 'text/event-stream';
    const rawRes = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    });
    const socket = { destroyed: false, setNoDelay: jest.fn(), setTimeout: jest.fn() };
    const context = { req: { aborted: false, socket }, res: rawRes, respond: true, compress: true };
    (handler as unknown as { context: typeof context }).context = context;

    await handler.post();

    expect(context.respond).toBe(false);
    expect(context.compress).toBe(false);
    expect(rawRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    }));
    const stream = rawRes.write.mock.calls.map(call => String(call[0])).join('');
    expect(stream).toContain('event: case_start');
    expect(stream).toContain('event: progress');
    expect(stream).toContain('"stage":"stress_testing"');
    expect(stream).toContain('event: case_result');
    expect(stream).toContain('event: result');
    expect(rawRes.end).toHaveBeenCalled();
  });

  it('保留 CSRF 防护', async () => {
    const handler = setupHandler({ confirmCost: true });
    handler.request.headers['x-requested-with'] = 'invalid';

    await handler.post();

    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CSRF_REJECTED');
    expect(handler.limitRate).not.toHaveBeenCalled();
  });
});
