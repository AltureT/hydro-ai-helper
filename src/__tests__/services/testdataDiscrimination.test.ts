import {
  evaluateDiscrimination,
  runDiscriminationPhase,
} from '../../services/testdataGenService';

const accepted = (stdout: string) => ({
  accepted: true,
  timedOut: false,
  stdout,
});

describe('evaluateDiscrimination', () => {
  it('输出与 ORACLE 不一致时记录 WA 命中及首个测试点', () => {
    const result = evaluateDiscrimination({
      targetRuns: [{
        kind: 'wrong-algorithm',
        description: '错误贪心',
        perCase: [accepted('1\n'), accepted('wrong\n')],
      }],
      oracleOutputs: ['1\n', '2\n'],
      customChecker: false,
    });

    expect(result).toEqual({
      targets: [{
        kind: 'wrong-algorithm',
        description: '错误贪心',
        killed: true,
        killedBy: 'wa',
        killedByCase: 2,
      }],
      allKilled: true,
    });
  });

  it('任一测试点超时时记录 TLE 命中', () => {
    const result = evaluateDiscrimination({
      targetRuns: [{
        kind: 'boundary',
        description: '退化边界错误',
        perCase: [
          accepted('1\n'),
          { accepted: false, timedOut: true, stdout: '' },
        ],
      }],
      oracleOutputs: ['1\n', '2\n'],
      customChecker: false,
    });

    expect(result.targets[0]).toMatchObject({
      killed: true,
      killedBy: 'tle',
      killedByCase: 2,
    });
    expect(result.allKilled).toBe(true);
  });

  it('全部输出一致且未超时时保持未卡住', () => {
    const result = evaluateDiscrimination({
      targetRuns: [{
        kind: 'overflow-sim',
        description: '模拟整数溢出',
        perCase: [accepted('1\n'), accepted('2\n')],
      }],
      oracleOutputs: ['1\n', '2\n'],
      customChecker: false,
    });

    expect(result.targets[0]).toEqual({
      kind: 'overflow-sim',
      description: '模拟整数溢出',
      killed: false,
    });
    expect(result.allKilled).toBe(false);
  });

  it('自定义 checker 跳过错误解 WA 判定且不计入 allKilled', () => {
    const result = evaluateDiscrimination({
      targetRuns: [{
        kind: 'wrong-algorithm',
        description: '输出另一种合法表示',
        perCase: [accepted('different\n')],
      }],
      oracleOutputs: ['expected\n'],
      customChecker: true,
    });

    expect(result).toEqual({
      targets: [{
        kind: 'wrong-algorithm',
        description: '输出另一种合法表示',
        killed: false,
        skippedReason: 'custom-checker',
      }],
      allKilled: false,
    });
  });

  it('运行崩溃视为 WA 命中并在描述中标记运行失败', () => {
    const result = evaluateDiscrimination({
      targetRuns: [{
        kind: 'boundary',
        description: '空结构处理错误',
        perCase: [{ accepted: false, timedOut: false, stdout: '' }],
      }],
      oracleOutputs: ['0\n'],
      customChecker: false,
    });

    expect(result.targets[0]).toEqual({
      kind: 'boundary',
      description: '空结构处理错误(运行失败)',
      killed: true,
      killedBy: 'wa',
      killedByCase: 1,
    });
    expect(result.allKilled).toBe(true);
  });

  it('brute-complexity 只以超时作为复杂度命中', () => {
    const result = evaluateDiscrimination({
      targetRuns: [{
        kind: 'brute-complexity',
        description: '独立暴力解复杂度检查',
        perCase: [accepted('different\n')],
      }],
      oracleOutputs: ['expected\n'],
      customChecker: false,
    });

    expect(result.targets[0]).toEqual({
      kind: 'brute-complexity',
      description: '独立暴力解复杂度检查',
      killed: false,
    });
    expect(result.allKilled).toBe(false);
  });

  it('空靶子不视为全部卡住', () => {
    expect(evaluateDiscrimination({
      targetRuns: [],
      oracleOutputs: [],
      customChecker: false,
    })).toEqual({
      targets: [],
      allKilled: false,
    });
  });
});

describe('runDiscriminationPhase', () => {
  it('错误解跑全部正式点，BRUTE 优先跑 large 点并保留原测试点编号', async () => {
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([
          accepted('wrong\n'),
          accepted('2\n'),
          accepted('3\n'),
        ])
        .mockResolvedValueOnce([
          accepted('2\n'),
          { accepted: false, timedOut: true, stdout: '' },
        ]),
    };

    const result = await runDiscriminationPhase({
      killTargets: [{
        kind: 'wrong-algorithm',
        description: '错误贪心',
        code: 'print("wrong")',
      }],
      bruteCode: 'print(input())',
      cases: [
        { input: '1\n', output: '1\n', dataScale: 'small' },
        { input: '2\n', output: '2\n', dataScale: 'large' },
        { input: '3\n', output: '3\n', dataScale: 'large' },
      ],
      runner,
      customChecker: false,
    });

    expect(runner.runPythonBatchDetailed.mock.calls[0][1]).toEqual(['1\n', '2\n', '3\n']);
    expect(runner.runPythonBatchDetailed.mock.calls[1][1]).toEqual(['2\n', '3\n']);
    expect(runner.runPythonBatchDetailed.mock.calls[1][2]).toEqual(expect.objectContaining({
      deadlineAt: expect.any(Number),
    }));
    expect(result.targets).toEqual([
      expect.objectContaining({ kind: 'wrong-algorithm', killedBy: 'wa', killedByCase: 1 }),
      expect.objectContaining({ kind: 'brute-complexity', killedBy: 'tle', killedByCase: 3 }),
    ]);
    expect(result.allKilled).toBe(true);
  });

  it('沙箱异常把当前及未运行靶子标为预算跳过而不抛错', async () => {
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockRejectedValue(new Error('sandbox unavailable')),
    };

    const result = await runDiscriminationPhase({
      killTargets: [
        { kind: 'boundary', description: '边界错误', code: 'print(0)' },
        { kind: 'wrong-algorithm', description: '算法错误', code: 'print(0)' },
      ],
      bruteCode: 'print(input())',
      cases: [{ input: '1\n', output: '1\n', dataScale: 'large' }],
      runner,
      customChecker: false,
    });

    expect(result.targets).toHaveLength(3);
    expect(result.targets.every(target =>
      target.skippedReason === 'budget-exhausted' && !target.killed)).toBe(true);
    expect(result.allKilled).toBe(false);
  });

  it('无错误解靶子时记录 no-targets 并继续执行 BRUTE 复杂度检查', async () => {
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        { accepted: false, timedOut: true, stdout: '' },
      ]),
    };

    const result = await runDiscriminationPhase({
      killTargets: [],
      bruteCode: 'print(input())',
      cases: [{ input: '1\n', output: '1\n', dataScale: 'large' }],
      runner,
      customChecker: false,
    });

    expect(result.targets[0]).toMatchObject({
      killed: false,
      skippedReason: 'no-targets',
    });
    expect(result.targets[1]).toMatchObject({
      kind: 'brute-complexity',
      killed: true,
      killedBy: 'tle',
    });
    expect(result.allKilled).toBe(false);
  });
});
