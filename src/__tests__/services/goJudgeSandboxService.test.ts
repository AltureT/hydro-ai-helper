import {
  GoJudgeSandboxRunner,
  getTestdataGenerationMode,
  SANDBOX_CHUNK_SIZE,
} from '../../services/goJudgeSandboxService';

/** 构造一条 go-judge 结果，便于用最小样板覆盖各类 status。 */
function goJudgeResult(over: Record<string, unknown> = {}) {
  return {
    status: 'Accepted', exitStatus: 0,
    files: { stdout: '', stderr: '' },
    ...over,
  };
}

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
      expect.objectContaining({ timeout: 55000 }),
    );
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
});

describe('getTestdataGenerationMode', () => {
  it('支持 auto/sandbox/direct，非法值回退 auto', () => {
    expect(getTestdataGenerationMode('sandbox')).toBe('sandbox');
    expect(getTestdataGenerationMode('direct')).toBe('direct');
    expect(getTestdataGenerationMode('AUTO')).toBe('auto');
    expect(getTestdataGenerationMode('unexpected')).toBe('auto');
  });
});

