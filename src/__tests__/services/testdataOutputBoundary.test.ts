jest.mock('../../lib/crypto', () => ({ decrypt: jest.fn((value: string) => value) }));
import { assertAnswerBoundaryCoverage, answerBoundaryRequired } from '../../services/testdata/outputBoundary';
import { materializeSandboxBlueprint } from '../../services/testdataGenService';

const statement = '答案可能超过 32 位有符号整数。\n## 输出格式\n一行一个整数，表示答案。';
it('requires evidence for an explicit answer overflow warning only', () => {
  expect(answerBoundaryRequired(statement)).toBe(true);
  expect(answerBoundaryRequired('The answer may exceed a signed 32-bit integer.')).toBe(true);
  for (const text of ['输入数值可能超过 32 位整数。', '答案不会超过 32 位整数。', '使用 64 位整数。', '```\n答案可能超过32位整数\n```']) {
    expect(answerBoundaryRequired(text)).toBe(false);
  }
  expect(answerBoundaryRequired(statement, 'float')).toBe(false);
  expect(answerBoundaryRequired(statement, 'custom-checker')).toBe(false);
  expect(answerBoundaryRequired(statement, 'exact', 'small')).toBe(false);
});

it('compares exact signed integer answers and cannot mistake input scale for output coverage', () => {
  expect(() => assertAnswerBoundaryCoverage(statement, ['0\n', '1000000\n', '2147483647\n-2147483648\n']))
    .toThrow(expect.objectContaining({ code: 'COVERAGE_REQUIREMENT_MISSING', artifact: 'generator', retryPolicy: 'repair-artifact' }));
  for (const output of ['2147483648', '-2147483649', '10000000000000000000000000000000000000', '0\n10000000000\n']) {
    expect(() => assertAnswerBoundaryCoverage(statement, [output])).not.toThrow();
  }
  for (const output of ['', '2147483648.5', '2.5e9', 'answer=9999999999', '00000000000000001']) {
    expect(() => assertAnswerBoundaryCoverage(statement, [output])).toThrow();
  }
});

it('leaves labelled and multi-field output unproven without generator repair', () => {
  for (const output of ['1 3000000000\n', 'Case #1: 3000000000\n']) {
    expect(() => assertAnswerBoundaryCoverage(statement, [output]))
      .toThrow(expect.objectContaining({ artifact: 'coverage', retryPolicy: 'manual-review' }));
  }
  expect(() => assertAnswerBoundaryCoverage('答案可能超过 32 位。', ['3000000000']))
    .toThrow(expect.objectContaining({ retryPolicy: 'manual-review' }));
});

it('does not conceal an independent oracle divergence with generator repair', async () => {
  const runner = {
    isAvailable: jest.fn().mockResolvedValue(true),
    runPython: jest.fn().mockResolvedValue({ stdout: JSON.stringify({ cases: [{ label: 'boundary', input: '1\n' }] }), stderr: '' }),
    runPythonBatch: jest.fn(),
    runPythonBatchDetailed: jest.fn().mockImplementation((code: string) => Promise.resolve([{ status: 'Accepted', accepted: true,
      timedOut: false, exitStatus: 0, stdout: code === 'ORACLE' ? '-294967296\n' : '4000000000\n', stderr: '' }])),
  };
  await expect(materializeSandboxBlueprint({ problemType: 'traditional', generatorCode: 'GEN', oracleCode: 'ORACLE', bruteCode: 'BRUTE' },
    { problemKind: 'traditional', caseCount: 1, languages: [] }, statement, runner))
    .rejects.toMatchObject({ code: 'ORACLE_BRUTE_DIVERGENCE', retryPolicy: 'adjudicate' });
  expect(runner.runPythonBatchDetailed.mock.calls.some(call => call[0] === 'BRUTE')).toBe(true);
});

it('routes insufficient executed formal answers to generator repair', async () => {
  const runner = {
    isAvailable: jest.fn().mockResolvedValue(true),
    runPython: jest.fn().mockResolvedValue({ stdout: JSON.stringify({ cases: [{ label: 'max-n', input: '200000\n' }] }), stderr: '' }),
    runPythonBatch: jest.fn(),
    runPythonBatchDetailed: jest.fn().mockResolvedValue([{ status: 'Accepted', accepted: true,
      timedOut: false, exitStatus: 0, stdout: '1000000\n', stderr: '' }]),
  };
  await expect(materializeSandboxBlueprint({ problemType: 'traditional', generatorCode: 'GEN', oracleCode: 'ORACLE' },
    { problemKind: 'traditional', caseCount: 1, languages: [] }, statement, runner))
    .rejects.toMatchObject({ code: 'COVERAGE_REQUIREMENT_MISSING', artifact: 'generator' });
  expect(runner.runPythonBatchDetailed).toHaveBeenCalled();
});
