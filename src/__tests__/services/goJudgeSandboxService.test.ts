import {
  GoJudgeSandboxRunner,
  getTestdataGenerationMode,
  scheduleSandboxChunks,
  SANDBOX_CHUNK_SIZE,
  SANDBOX_RESPONSE_LIMIT_BYTES,
} from '../../services/goJudgeSandboxService';

/** 构造一条 go-judge 结果，便于用最小样板覆盖各类 status。 */
function goJudgeResult(over: Record<string, unknown> = {}) {
  return {
    status: 'Accepted', exitStatus: 0,
    files: { stdout: '', stderr: '' },
    ...over,
  };
}

describe('scheduleSandboxChunks', () => {
  it('并发分块乱序完成时仍按原始索引归位结果', async () => {
    const releases: Array<() => void> = [];
    const promise = scheduleSandboxChunks(['a', 'b', 'c'], 3, async (value, index) => {
      await new Promise<void>(resolve => {
        releases[index] = resolve;
      });
      return `${index}:${value}`;
    });
    await new Promise(resolve => setImmediate(resolve));

    releases[2]();
    releases[0]();
    releases[1]();

    await expect(promise).resolves.toEqual(['0:a', '1:b', '2:c']);
  });

  it('在途分块数不超过指定并发上限', async () => {
    let active = 0;
    let maxActive = 0;
    const promise = scheduleSandboxChunks([0, 1, 2, 3, 4, 5], 2, async value => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return value;
    });

    await expect(promise).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxActive).toBe(2);
  });

  it('中途分块失败时原样传播并停止领取后续分块', async () => {
    const failure = new Error('chunk failed');
    const started: number[] = [];
    let releaseFirst!: () => void;
    const promise = scheduleSandboxChunks([0, 1, 2], 2, async value => {
      started.push(value);
      if (value === 1) throw failure;
      await new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      return value;
    });
    const rejection = expect(promise).rejects.toBe(failure);

    await rejection;
    expect(started).toEqual([0, 1]);
    releaseFirst();
  });
});

describe('GoJudgeSandboxRunner', () => {
  it('通过 /version 探测 Hydro 沙箱', async () => {
    const http = {
      get: jest.fn().mockResolvedValue({ data: { version: 'v1.9.0' } }),
      post: jest.fn(),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050/', http);
    await expect(runner.isAvailable()).resolves.toBe(true);
    expect(http.get).toHaveBeenCalledWith('http://localhost:5050/version', expect.objectContaining({ timeout: 3000 }));
  });

  it('将 Python 代码和输入以内存文件发给 /run', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [{
          status: 'Accepted', exitStatus: 0,
          files: { stdout: '3\n', stderr: '' },
        }],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://127.0.0.1:5050', http);
    await expect(runner.runPython('a, b = map(int, input().split())\nprint(a + b)', '1 2\n'))
      .resolves.toEqual({ stdout: '3\n', stderr: '' });
    expect(http.post).toHaveBeenCalledWith(
      'http://127.0.0.1:5050/run',
      expect.objectContaining({
        cmd: [expect.objectContaining({
          args: ['/usr/bin/python3', 'main.py'],
          files: expect.arrayContaining([{ content: '1 2\n' }]),
          copyIn: { 'main.py': { content: expect.stringContaining('print(a + b)') } },
        })],
      }),
      // 分块批量：块请求 timeout = SANDBOX_CHUNK_SIZE(4) × clockLimit(10s) + 15s = 55s
      expect.objectContaining({
        timeout: 55000,
        maxContentLength: SANDBOX_RESPONSE_LIMIT_BYTES,
      }),
    );
    expect(SANDBOX_RESPONSE_LIMIT_BYTES).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('沙箱非零退出时返回可读错误', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [{
          status: 'Nonzero Exit Status', exitStatus: 1,
          files: { stdout: '', stderr: 'Traceback: boom' },
        }],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    await expect(runner.runPython('raise RuntimeError("boom")'))
      .rejects.toThrow(/Nonzero Exit Status.*Traceback: boom/);
  });
});

describe('GoJudgeSandboxRunner.runPythonBatchDetailed', () => {
  it('按 status 分类，不因单条失败抛错（Accepted/TLE/RE/OLE）', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [
          goJudgeResult({ status: 'Accepted', exitStatus: 0, files: { stdout: 'ok\n', stderr: '' } }),
          goJudgeResult({ status: 'Time Limit Exceeded', exitStatus: undefined, files: {} }),
          goJudgeResult({ status: 'Nonzero Exit Status', exitStatus: 1, files: { stdout: '', stderr: 'boom' } }),
          goJudgeResult({ status: 'Output Limit Exceeded', exitStatus: 0, error: 'output limit', files: { stdout: 'x' } }),
        ],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    const details = await runner.runPythonBatchDetailed('print(1)', ['a', 'b', 'c', 'd']);
    expect(details).toHaveLength(4);
    expect(details[0]).toMatchObject({ status: 'Accepted', accepted: true, timedOut: false, stdout: 'ok\n' });
    expect(details[1]).toMatchObject({ accepted: false, timedOut: true });
    expect(details[2]).toMatchObject({ accepted: false, timedOut: false, stderr: 'boom' });
    expect(details[3]).toMatchObject({ accepted: false, timedOut: false, error: 'output limit' });
  });

  it('大批量按 SANDBOX_CHUNK_SIZE 分块串行，顺序映射正确（9 输入 → 3 请求）', async () => {
    expect(SANDBOX_CHUNK_SIZE).toBe(4);
    const http = {
      get: jest.fn(),
      // 回显每条 cmd 的 stdin（files[0].content），据此校验全局顺序
      post: jest.fn().mockImplementation((_url, body: { cmd: Array<{ files: Array<{ content?: string }> }> }) => ({
        data: body.cmd.map(cmd => goJudgeResult({ files: { stdout: cmd.files[0].content || '', stderr: '' } })),
      })),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    const inputs = Array.from({ length: 9 }, (_, i) => String(i));
    const details = await runner.runPythonBatchDetailed('print(input())', inputs);

    expect(http.post).toHaveBeenCalledTimes(3);
    // 块大小 4/4/1
    expect(http.post.mock.calls[0][1].cmd).toHaveLength(4);
    expect(http.post.mock.calls[1][1].cmd).toHaveLength(4);
    expect(http.post.mock.calls[2][1].cmd).toHaveLength(1);
    // 每块请求超时都是 55s（4 × 10s + 15s）
    for (const call of http.post.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timeout: 55000 }));
    }
    expect(details.map(d => d.stdout)).toEqual(inputs);
  });

  it('严格版 runPythonBatch 基于宽容版，仍在非零退出时抛旧格式中文错误', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [
          goJudgeResult({ files: { stdout: 'ok\n', stderr: '' } }),
          goJudgeResult({ status: 'Nonzero Exit Status', exitStatus: 1, files: { stdout: '', stderr: 'boom' } }),
        ],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    await expect(runner.runPythonBatch('print(1)', ['a', 'b']))
      .rejects.toThrow(/第 2 个沙箱任务执行失败（Nonzero Exit Status）：boom/);
  });

  it('严格版报错保留 stderr 尾部（长 traceback 不丢关键行）并附带该任务输入', async () => {
    const longTrace = `Traceback (most recent call last):\n${'  File "/w/main.py", line 5\n'.repeat(60)}IndexError: string index out of range`;
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [
          goJudgeResult({ status: 'Nonzero Exit Status', exitStatus: 1, files: { stdout: '', stderr: longTrace } }),
          goJudgeResult({ files: { stdout: 'ok\n', stderr: '' } }),
        ],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    const err: Error = await runner.runPythonBatch('print(1)', ['A>B\nB<C\n', '1 2\n']).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    // 尾部关键行必须保留（旧实现取头部 1000 字符会把它截掉）
    expect(err.message).toContain('IndexError: string index out of range');
    // 出错任务的输入内容要一并给出，供 AI 修复回路判断 GENERATOR/ORACLE 谁错
    expect(err.message).toContain('该任务的输入内容');
    expect(err.message).toContain('A>B');
  });

  it('严格版全部 Accepted 时返回 stdout/stderr 列表', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [
          goJudgeResult({ files: { stdout: '1\n', stderr: '' } }),
          goJudgeResult({ files: { stdout: '2\n', stderr: 'warn' } }),
        ],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    await expect(runner.runPythonBatch('print(1)', ['a', 'b'])).resolves.toEqual([
      { stdout: '1\n', stderr: '' },
      { stdout: '2\n', stderr: 'warn' },
    ]);
  });

  it('空输入短路，不发请求', async () => {
    const http = { get: jest.fn(), post: jest.fn() };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    await expect(runner.runPythonBatchDetailed('print(1)', [])).resolves.toEqual([]);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('绝对截止时间已耗尽时不再发起新的沙箱分块请求', async () => {
    const http = { get: jest.fn(), post: jest.fn() };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    await expect(runner.runPythonBatchDetailed('print(1)', ['a'], {
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow(/沙箱执行总时长超出预算/);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('按整条管线剩余预算收紧单个分块请求 timeout', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({ data: [goJudgeResult()] }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    const deadlineAt = Date.now() + 2_000;
    await runner.runPythonBatchDetailed('print(1)', ['a'], { deadlineAt });
    const timeout = http.post.mock.calls[0][2].timeout as number;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(2_000);
    expect(timeout).toBeLessThan(55_000);
  });
});

describe('GoJudgeSandboxRunner C++ cached artifact infrastructure', () => {
  it('compileCpp 构造 C++17 编译请求并返回缓存二进制 fileId', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [{
          status: 'Accepted',
          exitStatus: 0,
          files: { stdout: '', stderr: '' },
          fileIds: { prog: 'cached-prog-1' },
        }],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    const source = '#include "helper.h"\nint main() { return VALUE; }\n';

    await expect(runner.compileCpp(source, {
      extraFiles: { 'helper.h': '#define VALUE 0\n' },
    })).resolves.toEqual({ ok: true, fileId: 'cached-prog-1' });

    expect(http.post).toHaveBeenCalledWith(
      'http://localhost:5050/run',
      {
        cmd: [expect.objectContaining({
          args: ['/usr/bin/g++', '-O2', '-std=c++17', '-o', 'prog', 'prog.cc'],
          env: ['PATH=/usr/bin:/bin'],
          files: [
            { content: '' },
            { name: 'stdout', max: 64 * 1024 },
            { name: 'stderr', max: 64 * 1024 },
          ],
          cpuLimit: 30_000_000_000,
          clockLimit: 60_000_000_000,
          memoryLimit: 1024 * 1024 * 1024,
          procLimit: 64,
          copyIn: {
            'prog.cc': { content: source },
            'helper.h': { content: '#define VALUE 0\n' },
          },
          copyOut: ['stdout', 'stderr'],
          copyOutCached: ['prog'],
        })],
      },
      expect.objectContaining({
        timeout: 75_000,
        maxContentLength: SANDBOX_RESPONSE_LIMIT_BYTES,
        proxy: false,
      }),
    );
  });

  it('compileCpp 将编译错误和基础设施错误降级为 ok:false', async () => {
    const compileHttp = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [{
          status: 'Nonzero Exit Status',
          exitStatus: 1,
          files: { stdout: '', stderr: 'prog.cc:1: error: expected declaration' },
        }],
      }),
    };
    const compileRunner = new GoJudgeSandboxRunner('http://localhost:5050', compileHttp);
    await expect(compileRunner.compileCpp('broken source')).resolves.toEqual({
      ok: false,
      kind: 'compile',
      error: expect.stringContaining('expected declaration'),
    });

    const unavailableHttp = {
      get: jest.fn(),
      post: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    };
    const unavailableRunner = new GoJudgeSandboxRunner('http://localhost:5050', unavailableHttp);
    await expect(unavailableRunner.compileCpp('int main() {}')).resolves.toEqual({
      ok: false,
      kind: 'infra',
      error: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('compileCpp 对超期或畸形响应中的缓存 fileId 全部尽力清理', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValue(3_000);
    const lateHttp = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [{
          status: 'Accepted',
          exitStatus: 0,
          files: { stdout: '', stderr: '' },
          fileIds: { prog: 'late-prog' },
        }],
      }),
      delete: jest.fn().mockResolvedValue({ data: undefined }),
    };
    const lateRunner = new GoJudgeSandboxRunner('http://localhost:5050', lateHttp);
    await expect(lateRunner.compileCpp('int main() {}', {
      deadlineAt: 2_000,
    })).resolves.toEqual({
      ok: false,
      kind: 'infra',
      error: expect.stringContaining('总时长'),
    });
    expect(lateHttp.delete).toHaveBeenCalledWith(
      'http://localhost:5050/file/late-prog',
      expect.anything(),
    );
    nowSpy.mockRestore();

    const malformedHttp = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [
          null,
          { ...goJudgeResult(), fileIds: { prog: 'unexpected-a' } },
          { ...goJudgeResult(), fileIds: { prog: 'unexpected-b' } },
        ],
      }),
      delete: jest.fn().mockResolvedValue({ data: undefined }),
    };
    const malformedRunner = new GoJudgeSandboxRunner('http://localhost:5050', malformedHttp);
    await expect(malformedRunner.compileCpp('int main() {}')).resolves.toEqual({
      ok: false,
      kind: 'infra',
      error: expect.stringContaining('期望 1 个'),
    });
    expect(malformedHttp.delete).toHaveBeenCalledTimes(2);
  });

  it('runCompiledBatchDetailed 使用缓存二进制并复用 Python 批量分块与限额语义', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockImplementation(
        (_url, body: { cmd: Array<{ files: Array<{ content?: string }> }> }) => ({
          data: body.cmd.map((cmd, index) => (
            index === 1
              ? goJudgeResult({ status: 'Time Limit Exceeded', exitStatus: 9, files: {} })
              : goJudgeResult({ files: { stdout: cmd.files[0].content || '', stderr: '' } })
          )),
        }),
      ),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    const inputs = ['a', 'b', 'c', 'd', 'e'];
    const details = await runner.runCompiledBatchDetailed('cached-prog-1', inputs, {
      cpuSeconds: 3,
    });

    expect(http.post).toHaveBeenCalledTimes(2);
    expect(http.post.mock.calls[0][1].cmd).toHaveLength(SANDBOX_CHUNK_SIZE);
    expect(http.post.mock.calls[1][1].cmd).toHaveLength(1);
    for (const call of http.post.mock.calls) {
      for (const command of call[1].cmd) {
        expect(command).toEqual(expect.objectContaining({
          args: ['prog'],
          env: ['PATH=/usr/bin:/bin'],
          cpuLimit: 3_000_000_000,
          clockLimit: 6_000_000_000,
          memoryLimit: 256 * 1024 * 1024,
          procLimit: 16,
          copyIn: { prog: { fileId: 'cached-prog-1' } },
          copyOut: ['stdout', 'stderr'],
        }));
      }
      expect(call[2]).toEqual(expect.objectContaining({ timeout: 39_000 }));
    }
    expect(details).toHaveLength(inputs.length);
    expect(details[0]).toMatchObject({ accepted: true, stdout: 'a' });
    expect(details[1]).toMatchObject({ accepted: false, timedOut: true });
    expect(details[4]).toMatchObject({ accepted: true, stdout: 'e' });
  });

  it('runCheckerBatchDetailed 以 testlib 参数顺序挂载输入、输出和答案', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn().mockResolvedValue({
        data: [goJudgeResult()],
      }),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);

    await expect(runner.runCheckerBatchDetailed('cached-checker-1', [{
      input: '1 2\n',
      output: '3\n',
      answer: '3.0\n',
    }])).resolves.toHaveLength(1);

    expect(http.post).toHaveBeenCalledWith(
      'http://localhost:5050/run',
      {
        cmd: [expect.objectContaining({
          args: ['prog', 'in.txt', 'out.txt', 'ans.txt'],
          copyIn: {
            prog: { fileId: 'cached-checker-1' },
            'in.txt': { content: '1 2\n' },
            'out.txt': { content: '3\n' },
            'ans.txt': { content: '3.0\n' },
          },
          copyOut: ['stdout', 'stderr'],
        })],
      },
      expect.objectContaining({ proxy: false }),
    );
  });

  it('deleteCachedFile 调用缓存删除端点且失败静默', async () => {
    const http = {
      get: jest.fn(),
      post: jest.fn(),
      delete: jest.fn()
        .mockResolvedValueOnce({ data: undefined })
        .mockRejectedValueOnce(new Error('already gone')),
    };
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);

    await expect(runner.deleteCachedFile('cached/prog')).resolves.toBeUndefined();
    await expect(runner.deleteCachedFile('missing')).resolves.toBeUndefined();
    expect(http.delete).toHaveBeenNthCalledWith(
      1,
      'http://localhost:5050/file/cached%2Fprog',
      expect.objectContaining({ timeout: 3000, proxy: false }),
    );
  });
});

describe('getTestdataGenerationMode', () => {
  it('支持 auto/sandbox/direct，非法值回退 auto', () => {
    expect(getTestdataGenerationMode('sandbox')).toBe('sandbox');
    expect(getTestdataGenerationMode('direct')).toBe('direct');
    expect(getTestdataGenerationMode('AUTO')).toBe('auto');
    expect(getTestdataGenerationMode('unexpected')).toBe('auto');
  });
});
