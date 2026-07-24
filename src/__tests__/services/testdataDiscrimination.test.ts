import {
  buildDiscriminationNotes,
  evaluateDiscrimination,
  parseIndependentVerifierBlueprint,
  remapDiscriminationCaseNumbers,
  runDiscriminationPhase,
  smokeTestKillTargets,
} from '../../services/testdataGenService';

const accepted = (stdout: string) => ({
  accepted: true,
  timedOut: false,
  stdout,
});

const independentVerifierResponse = (complexityGapSection = '') => [
  complexityGapSection,
  '@@@BRUTE@@@',
  'print(input())',
  '@@@STRESS_GENERATOR@@@',
  'print(\'{"cases":[]}\')',
  '@@@VALIDATOR@@@',
  'raise SystemExit(0)',
].filter(Boolean).join('\n');

describe('parseIndependentVerifierBlueprint', () => {
  it.each([
    ['exists', 'exists'],
    ['none', 'none'],
  ] as const)('解析 COMPLEXITY_GAP=%s', (rawValue, expected) => {
    expect(parseIndependentVerifierBlueprint(independentVerifierResponse(
      `=== COMPLEXITY_GAP ===\n${rawValue}`,
    )).complexityGap).toBe(expected);
  });

  it('分节缺失时保持向后兼容', () => {
    expect(parseIndependentVerifierBlueprint(
      independentVerifierResponse(),
    ).complexityGap).toBeUndefined();
  });

  it('分节内容非法时保持向后兼容', () => {
    expect(parseIndependentVerifierBlueprint(independentVerifierResponse(
      '=== COMPLEXITY_GAP ===\nmaybe',
    )).complexityGap).toBeUndefined();
  });
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

describe('buildDiscriminationNotes', () => {
  it('全部命中时汇总错误解数量，并标记补刀新增的测试点', () => {
    expect(buildDiscriminationNotes({
      targets: [
        {
          kind: 'wrong-algorithm',
          description: '错误贪心',
          killed: true,
          killedBy: 'wa',
          killedByCase: 4,
        },
        {
          kind: 'boundary',
          description: '遗漏退化边界',
          killed: true,
          killedBy: 'wa',
          killedByCase: 2,
        },
        {
          kind: 'brute-complexity',
          description: '独立暴力解复杂度检查',
          killed: true,
          killedBy: 'tle',
          killedByCase: 3,
        },
      ],
      allKilled: true,
    }, 3)).toEqual([
      '区分度验证:2 个错误解靶子与暴力复杂度检查均被现有数据卡住。',
      '已为「错误贪心」错误解定向补充 hack 测试点 #4。',
    ]);
  });

  it('BRUTE 与错误解仍幸存时分别追加人工复核警告', () => {
    expect(buildDiscriminationNotes({
      targets: [
        {
          kind: 'overflow-sim',
          description: '整数溢出模拟',
          killed: false,
        },
        {
          kind: 'brute-complexity',
          description: '独立暴力解复杂度检查',
          killed: false,
        },
      ],
      allKilled: false,
    }, 3)).toEqual([
      '警告:独立暴力解在全部测试点均于 5 秒内通过,数据规模可能不足以区分复杂度,建议人工加大规模档位。',
      '警告:一个「整数溢出模拟」类错误解通过了全部数据与定向补刀,建议教师针对该错误模式人工补充测试点。',
    ]);
  });

  it('跳过的靶子不生成误导性结论', () => {
    expect(buildDiscriminationNotes({
      targets: [{
        kind: 'wrong-algorithm',
        description: '自定义 checker 靶子',
        killed: false,
        skippedReason: 'custom-checker',
      }],
      allKilled: false,
    }, 3)).toEqual([]);
  });

  it('不存在复杂度差异时追加跳过说明且不生成规模不足警告', () => {
    expect(buildDiscriminationNotes({
      targets: [{
        kind: 'brute-complexity',
        description: '独立暴力解复杂度检查',
        killed: false,
        skippedReason: 'no-complexity-gap',
      }],
      allKilled: false,
    }, 3)).toEqual([
      '该题不存在明显更慢的朴素解法，已跳过暴力复杂度检查。',
    ]);
  });

  it('按实际分配的文件编号映射 killedByCase 与补刀说明', () => {
    const discrimination = {
      targets: [{
        kind: 'wrong-algorithm' as const,
        description: '错误贪心',
        killed: true,
        killedBy: 'wa' as const,
        killedByCase: 2,
      }],
      allKilled: true,
    };

    expect(remapDiscriminationCaseNumbers(discrimination, [3, 5])).toEqual({
      targets: [{
        kind: 'wrong-algorithm',
        description: '错误贪心',
        killed: true,
        killedBy: 'wa',
        killedByCase: 5,
      }],
      allKilled: true,
    });
    expect(buildDiscriminationNotes(discrimination, 1, [3, 5])).toContain(
      '已为「错误贪心」错误解定向补充 hack 测试点 #5。',
    );
    expect(discrimination.targets[0].killedByCase).toBe(2);
  });
});

describe('smokeTestKillTargets', () => {
  it('丢弃样例上崩溃、超时或答案错误的靶子，并在全部丢弃时记录 no-targets', async () => {
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation((code: string) => {
        if (code === 'crash') return Promise.resolve([{ accepted: false, timedOut: false, stdout: '' }]);
        if (code === 'timeout') return Promise.resolve([{ accepted: false, timedOut: true, stdout: '' }]);
        return Promise.resolve([accepted('wrong\n')]);
      }),
    };
    const filtered = await smokeTestKillTargets({
      killTargets: [
        { kind: 'boundary', description: '崩溃', code: 'crash' },
        { kind: 'wrong-algorithm', description: '超时', code: 'timeout' },
        { kind: 'overflow-sim', description: '样例错误', code: 'wrong' },
      ],
      samples: [{ input: '1\n', output: '1\n' }],
      runner,
      customChecker: false,
      deadlineAt: Date.now() + 10_000,
    });
    const result = await runDiscriminationPhase({
      killTargets: filtered,
      cases: [{ input: '2\n', output: '2\n' }],
      runner,
      customChecker: false,
    });

    expect(filtered).toEqual([]);
    expect(result.targets).toEqual([expect.objectContaining({
      killed: false,
      skippedReason: 'no-targets',
    })]);
  });

  it('自定义 checker 的样例烟测只要求靶子成功执行', async () => {
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([accepted('另一种合法输出\n')]),
    };
    const target = { kind: 'wrong-algorithm' as const, description: '多解输出', code: 'print(1)' };

    await expect(smokeTestKillTargets({
      killTargets: [target],
      samples: [{ input: '1\n', output: '标准文本\n' }],
      runner,
      customChecker: true,
      deadlineAt: Date.now() + 10_000,
    })).resolves.toEqual([target]);
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

  it('complexityGap=none 时跳过 BRUTE，错误解仍运行且 allKilled 排除跳过项', async () => {
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        accepted('wrong\n'),
      ]),
    };

    const result = await runDiscriminationPhase({
      killTargets: [{
        kind: 'wrong-algorithm',
        description: '错误贪心',
        code: 'print("wrong")',
      }],
      bruteCode: 'print(input())',
      complexityGap: 'none',
      cases: [{ input: '1\n', output: '1\n', dataScale: 'large' }],
      runner,
      customChecker: false,
    });

    expect(runner.runPythonBatchDetailed).toHaveBeenCalledTimes(1);
    expect(result.targets).toEqual([
      expect.objectContaining({
        kind: 'wrong-algorithm',
        killed: true,
        killedBy: 'wa',
      }),
      {
        kind: 'brute-complexity',
        description: '独立暴力解复杂度检查',
        killed: false,
        skippedReason: 'no-complexity-gap',
      },
    ]);
    expect(result.allKilled).toBe(true);
  });
});
