import {
  GoJudgeSandboxRunner,
  getTestdataGenerationMode,
} from '../../services/goJudgeSandboxService';

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
      expect.objectContaining({ timeout: 90000 }),
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

describe('getTestdataGenerationMode', () => {
  it('支持 auto/sandbox/direct，非法值回退 auto', () => {
    expect(getTestdataGenerationMode('sandbox')).toBe('sandbox');
    expect(getTestdataGenerationMode('direct')).toBe('direct');
    expect(getTestdataGenerationMode('AUTO')).toBe('auto');
    expect(getTestdataGenerationMode('unexpected')).toBe('auto');
  });
});

