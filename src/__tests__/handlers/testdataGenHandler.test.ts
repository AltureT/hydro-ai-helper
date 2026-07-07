/**
 * TestdataGenHandler 测试
 * 覆盖：题面多语言解析、权限校验、apply 文件校验与写入顺序
 */

import { db, ProblemModel } from 'hydrooj';
import {
  TestdataGenContextHandler,
  TestdataGenGenerateHandler,
  TestdataGenSkeletonHandler,
  TestdataGenApplyHandler,
  TestdataGenHandlerPriv,
  extractStatementMarkdown,
} from '../../handlers/testdataGenHandler';
import * as openaiClient from '../../services/openaiClient';
import { TestdataGenService } from '../../services/testdataGenService';

// ─── 工具 ─────────────────────────────────────────────────────────────────────

const PROBLEM_DOC = {
  docId: 1530,
  pid: 'D3102',
  title: '机动车违章识别系统',
  content: '# 题面\n内容',
  owner: 2,
  data: [{ _id: '1.in', size: 4 }, { _id: 'config.yaml', size: 100 }],
};

function mockFindOne(result: unknown) {
  const findOne = jest.fn().mockResolvedValue(result);
  (db.collection as jest.Mock).mockReturnValue({ findOne });
  return findOne;
}

interface HandlerLike {
  ctx: { get: jest.Mock };
  request: { params: Record<string, string>; body: Record<string, unknown>; headers: Record<string, string> };
  response: { status?: number; body?: any; type?: string };
  user: { _id: number; own: jest.Mock; hasPerm: jest.Mock };
  translate: jest.Mock;
  limitRate: jest.Mock;
}

function setupHandler<T extends { new (...args: never[]): object }>(Ctor: T, options?: {
  own?: boolean;
  hasPerm?: boolean;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}): InstanceType<T> & HandlerLike {
  const handler = new (Ctor as unknown as { new (): object })() as InstanceType<T> & HandlerLike;
  handler.ctx = { get: jest.fn().mockReturnValue(undefined) } as never;
  handler.request = {
    params: options?.params ?? { problemId: 'D3102' },
    body: options?.body ?? {},
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  };
  handler.response = {};
  handler.user = {
    _id: 2,
    own: jest.fn().mockReturnValue(options?.own ?? false),
    hasPerm: jest.fn().mockReturnValue(options?.hasPerm ?? false),
  };
  handler.translate = jest.fn((key: string) => key);
  handler.limitRate = jest.fn().mockResolvedValue(undefined);
  return handler;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── extractStatementMarkdown ────────────────────────────────────────────────

describe('extractStatementMarkdown', () => {
  it('原样返回普通 Markdown', () => {
    expect(extractStatementMarkdown('# 题目\n内容')).toBe('# 题目\n内容');
  });

  it('解析多语言 JSON 题面并优先取中文', () => {
    const content = JSON.stringify({ en: 'English statement', zh: '中文题面' });
    expect(extractStatementMarkdown(content)).toBe('中文题面');
  });

  it('无中文时取第一个非空语言', () => {
    const content = JSON.stringify({ en: 'English statement' });
    expect(extractStatementMarkdown(content)).toBe('English statement');
  });

  it('空内容返回空字符串', () => {
    expect(extractStatementMarkdown(undefined)).toBe('');
    expect(extractStatementMarkdown('')).toBe('');
  });

  it('非 JSON 的花括号开头内容按原文处理', () => {
    expect(extractStatementMarkdown('{not json')).toBe('{not json');
  });
});

// ─── 导出 ─────────────────────────────────────────────────────────────────────

describe('exports', () => {
  it('导出三个 Handler 与路由权限', () => {
    expect(typeof TestdataGenContextHandler).toBe('function');
    expect(typeof TestdataGenGenerateHandler).toBe('function');
    expect(typeof TestdataGenApplyHandler).toBe('function');
    expect(TestdataGenHandlerPriv).toBeDefined();
  });
});

// ─── ContextHandler ───────────────────────────────────────────────────────────

describe('TestdataGenContextHandler', () => {
  it('题目不存在返回 404', async () => {
    mockFindOne(null);
    const handler = setupHandler(TestdataGenContextHandler, { own: true });
    await handler.get();
    expect(handler.response.status).toBe(404);
    expect(handler.response.body.code).toBe('PROBLEM_NOT_FOUND');
  });

  it('无编辑权限返回 403', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenContextHandler, { own: false, hasPerm: false });
    await handler.get();
    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('PERMISSION_DENIED');
  });

  it('题目所有者（own + PERM_EDIT_PROBLEM_SELF）可访问', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenContextHandler, { own: true, hasPerm: false });
    await handler.get();
    expect(handler.response.status).toBeUndefined();
    expect(handler.response.body.problem.pid).toBe('D3102');
    expect(handler.response.body.problem.hasStatement).toBe(true);
    expect(handler.response.body.existingFiles).toEqual(['1.in', 'config.yaml']);
  });

  it('拥有 PERM_EDIT_PROBLEM 的教师可访问', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenContextHandler, { own: false, hasPerm: true });
    await handler.get();
    expect(handler.response.body.problem.docId).toBe(1530);
  });

  it('多语言 JSON 题面转为预览文本', async () => {
    mockFindOne({ ...PROBLEM_DOC, content: JSON.stringify({ zh: '中文题面内容' }) });
    const handler = setupHandler(TestdataGenContextHandler, { own: true });
    await handler.get();
    expect(handler.response.body.problem.statementPreview).toBe('中文题面内容');
  });

  it('题面含填空标记时返回 fillInDetected=true', async () => {
    mockFindOne({ ...PROBLEM_DOC, content: '完善代码：\n```python\nk = ________1________\n```' });
    const handler = setupHandler(TestdataGenContextHandler, { own: true });
    await handler.get();
    expect(handler.response.body.problem.fillInDetected).toBe(true);
  });

  it('普通题面 fillInDetected=false', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenContextHandler, { own: true });
    await handler.get();
    expect(handler.response.body.problem.fillInDetected).toBe(false);
  });
});

// ─── GenerateHandler ──────────────────────────────────────────────────────────

describe('TestdataGenGenerateHandler', () => {
  it('缺少 CSRF 头返回 403', async () => {
    const handler = setupHandler(TestdataGenGenerateHandler, { own: true, body: { problemId: 'D3102' } });
    handler.request.headers = {};
    await handler.post();
    expect(handler.response.status).toBe(403);
    expect(handler.response.body.code).toBe('CSRF_REJECTED');
  });

  it('无权限返回 403（学生无法拿到标程）', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenGenerateHandler, { own: false, hasPerm: false, body: { problemId: 'D3102' } });
    await handler.post();
    expect(handler.response.status).toBe(403);
  });

  it('非法测试点数量返回 400', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenGenerateHandler, {
      own: true,
      body: { problemId: 'D3102', caseCount: 999 },
    });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_OPTIONS');
  });

  it('非法数据规模返回 400', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenGenerateHandler, {
      own: true,
      body: { problemId: 'D3102', caseCount: 5, dataScale: 'huge' },
    });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_OPTIONS');
  });

  it('body 读完后 req.destroyed=true 属正常态，不得误判为断开：仍调用生成、不返回 499', async () => {
    // body-parser 读完 POST body 后，请求可读流按正常生命周期置 destroyed=true 并触发
    // 'close'，但连接仍活着（res 未写完）。这不是客户端断开，必须继续生成。
    mockFindOne(PROBLEM_DOC);
    const clientSpy = jest.spyOn(openaiClient, 'createMultiModelClientFromConfig')
      .mockResolvedValue({} as never);
    const planStub = { problemType: 'traditional', files: [{ name: '1.in', content: '1', kind: 'case-in' }], caseCount: 1 };
    const genSpy = jest.spyOn(TestdataGenService.prototype, 'generate')
      .mockResolvedValue(planStub as never);
    const handler = setupHandler(TestdataGenGenerateHandler, {
      own: true, body: { problemId: 'D3102', caseCount: 5 },
    });
    (handler as unknown as { context: unknown }).context = {
      req: { destroyed: true, aborted: false, socket: { destroyed: false }, on: jest.fn(), removeListener: jest.fn() },
      res: { writableEnded: false, on: jest.fn(), removeListener: jest.fn() },
    };
    try {
      await handler.post();
      expect(genSpy).toHaveBeenCalled();
      expect(handler.response.status).not.toBe(499);
      expect(handler.response.body.plan).toEqual(planStub);
    } finally {
      genSpy.mockRestore();
      clientSpy.mockRestore();
    }
  });

  it('请求级 AbortSignal 传入服务；响应连接提前关闭触发取消 → 499 且不上报错误', async () => {
    mockFindOne(PROBLEM_DOC);
    const clientSpy = jest.spyOn(openaiClient, 'createMultiModelClientFromConfig')
      .mockResolvedValue({} as never);
    let capturedSignal: AbortSignal | undefined;
    const genSpy = jest.spyOn(TestdataGenService.prototype, 'generate').mockImplementation(
      (params: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        capturedSignal = params.signal;
        params.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('canceled'), { name: 'AbortError' })));
      }) as never,
    );
    const capture = jest.fn();
    const handler = setupHandler(TestdataGenGenerateHandler, {
      own: true, body: { problemId: 'D3102', caseCount: 5 },
    });
    handler.ctx.get = jest.fn((name: string) => (name === 'errorReporter' ? { capture } : undefined));
    // 断开检测挂在响应上：res 'close' 且响应尚未写完（writableEnded=false）才算真实断开
    const listeners: Record<string, () => void> = {};
    const removeListener = jest.fn();
    (handler as unknown as { context: unknown }).context = {
      req: { on: jest.fn(), removeListener: jest.fn() },
      res: { writableEnded: false, on: (ev: string, cb: () => void) => { listeners[ev] = cb; }, removeListener },
    };
    try {
      const done = handler.post();
      await new Promise(resolve => setImmediate(resolve));
      expect(capturedSignal).toBeDefined();
      listeners.close?.();   // 响应连接提前关闭 = 真实客户端断开
      await done;
      expect(handler.response.status).toBe(499);
      expect(capture).not.toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith('close', listeners.close);
    } finally {
      genSpy.mockRestore();
      clientSpy.mockRestore();
    }
  });

  it('挂监听前客户端已真实断开（req.aborted）：直接 499，不再调用生成服务', async () => {
    mockFindOne(PROBLEM_DOC);
    const clientSpy = jest.spyOn(openaiClient, 'createMultiModelClientFromConfig')
      .mockResolvedValue({} as never);
    const genSpy = jest.spyOn(TestdataGenService.prototype, 'generate').mockResolvedValue({} as never);
    const handler = setupHandler(TestdataGenGenerateHandler, {
      own: true, body: { problemId: 'D3102', caseCount: 5 },
    });
    (handler as unknown as { context: unknown }).context = {
      req: { aborted: true, on: jest.fn(), removeListener: jest.fn() },
      res: { writableEnded: false, on: jest.fn(), removeListener: jest.fn() },
    };
    try {
      await handler.post();
      expect(handler.response.status).toBe(499);
      expect(genSpy).not.toHaveBeenCalled();
    } finally {
      genSpy.mockRestore();
      clientSpy.mockRestore();
    }
  });

  it('题面为空返回 400', async () => {
    mockFindOne({ ...PROBLEM_DOC, content: '   ' });
    const handler = setupHandler(TestdataGenGenerateHandler, {
      own: true,
      body: { problemId: 'D3102', caseCount: 5 },
    });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('EMPTY_STATEMENT');
  });
});

// ─── SkeletonHandler（AI 故障降级） ──────────────────────────────────────────

describe('TestdataGenSkeletonHandler', () => {
  it('无权限返回 403', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenSkeletonHandler, {
      own: false, hasPerm: false,
      body: { problemId: 'D3102', caseCount: 3 },
    });
    await handler.post();
    expect(handler.response.status).toBe(403);
  });

  it('不调用 AI 直接返回骨架计划（题面为空也可用）', async () => {
    mockFindOne({ ...PROBLEM_DOC, content: '' });
    const handler = setupHandler(TestdataGenSkeletonHandler, {
      own: true,
      body: { problemId: 'D3102', problemKind: 'function', caseCount: 2, languages: ['py'] },
    });
    await handler.post();
    expect(handler.response.status).toBeUndefined();
    const plan = handler.response.body.plan;
    expect(plan.problemType).toBe('function');
    const names = plan.files.map((f: { name: string }) => f.name);
    expect(names).toEqual(expect.arrayContaining(['1.in', '1.out', '2.in', '2.out', 'template.py', 'compile.sh', 'config.yaml']));
    // 骨架不经过限流（无 AI 开销）
    expect(handler.limitRate).not.toHaveBeenCalled();
  });

  it('auto 模式根据题面函数标记返回含 Java 的函数题骨架', async () => {
    mockFindOne({
      ...PROBLEM_DOC,
      content: '### 代码写到函数内部\n```python\ndef findPoisonedDuration(timeSeries, duration):\n    return\n```',
    });
    const handler = setupHandler(TestdataGenSkeletonHandler, {
      own: true,
      body: { problemId: 'D3102', problemKind: 'auto', caseCount: 1, languages: ['py', 'java', 'cc'] },
    });
    await handler.post();
    const plan = handler.response.body.plan;
    expect(plan.problemType).toBe('function');
    expect(plan.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining([
      'template.py', 'template.java', 'template.cc', 'compile.sh', 'config.yaml',
    ]));
  });

  it('非法选项返回 400', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenSkeletonHandler, {
      own: true,
      body: { problemId: 'D3102', caseCount: 0 },
    });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_OPTIONS');
  });
});

// ─── ApplyHandler ─────────────────────────────────────────────────────────────

describe('TestdataGenApplyHandler', () => {
  it('无权限返回 403', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenApplyHandler, {
      own: false, hasPerm: false,
      body: { problemId: 'D3102', files: [{ name: '1.in', content: '1\n' }] },
    });
    await handler.post();
    expect(handler.response.status).toBe(403);
    expect(ProblemModel.addTestdata).not.toHaveBeenCalled();
  });

  it('空文件列表返回 400', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenApplyHandler, {
      own: true, body: { problemId: 'D3102', files: [] },
    });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('NO_FILES');
  });

  it('非法文件名返回 400 且不写入任何文件', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenApplyHandler, {
      own: true,
      body: { problemId: 'D3102', files: [{ name: '../evil.sh', content: 'x' }] },
    });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('INVALID_FILENAME');
    expect(ProblemModel.addTestdata).not.toHaveBeenCalled();
  });

  it('超大文件返回 400', async () => {
    mockFindOne(PROBLEM_DOC);
    const handler = setupHandler(TestdataGenApplyHandler, {
      own: true,
      body: { problemId: 'D3102', files: [{ name: '1.in', content: 'x'.repeat(257 * 1024) }] },
    });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('FILE_TOO_LARGE');
  });

  it('写入成功：config.yaml 最后写入，内容规范化，docId/操作者正确', async () => {
    mockFindOne(PROBLEM_DOC);
    (ProblemModel.addTestdata as jest.Mock).mockResolvedValue(undefined);
    const handler = setupHandler(TestdataGenApplyHandler, {
      own: true,
      body: {
        problemId: 'D3102',
        files: [
          { name: 'config.yaml', content: 'type: default' },
          { name: '1.in', content: '1 2' },
          { name: '1.out', content: '3\n' },
        ],
      },
    });
    await handler.post();

    expect(handler.response.body.written).toEqual(['1.in', '1.out', 'config.yaml']);
    expect(handler.response.body.failed).toEqual([]);

    const calls = (ProblemModel.addTestdata as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    // config.yaml 必须最后写入
    expect(calls[2][2]).toBe('config.yaml');
    // (domainId, docId, name, buffer, operator)
    expect(calls[0][0]).toBe('system');
    expect(calls[0][1]).toBe(1530);
    expect(Buffer.isBuffer(calls[0][3])).toBe(true);
    expect(calls[0][3].toString()).toBe('1 2\n'); // 规范化补齐换行
    expect(calls[0][4]).toBe(2);
  });

  it('部分文件写入失败时如实返回 failed 列表', async () => {
    mockFindOne(PROBLEM_DOC);
    (ProblemModel.addTestdata as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('storage down'));
    const handler = setupHandler(TestdataGenApplyHandler, {
      own: true,
      body: {
        problemId: 'D3102',
        files: [
          { name: '1.in', content: '1\n' },
          { name: '1.out', content: '2\n' },
        ],
      },
    });
    await handler.post();
    expect(handler.response.body.written).toEqual(['1.in']);
    expect(handler.response.body.failed).toEqual([{ name: '1.out', error: 'storage down' }]);
  });

  it('重复文件名去重保留首个', async () => {
    mockFindOne(PROBLEM_DOC);
    (ProblemModel.addTestdata as jest.Mock).mockResolvedValue(undefined);
    const handler = setupHandler(TestdataGenApplyHandler, {
      own: true,
      body: {
        problemId: 'D3102',
        files: [
          { name: '1.in', content: 'first\n' },
          { name: '1.in', content: 'second\n' },
        ],
      },
    });
    await handler.post();
    const calls = (ProblemModel.addTestdata as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][3].toString()).toBe('first\n');
  });
});
