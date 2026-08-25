import type {
  PythonRunDetail,
  TestdataSandboxRunner,
} from '../../services/goJudgeSandboxService';
import { SandboxBudgetExceededError } from '../../services/goJudgeSandboxService';
import type { MutationCandidate } from '../../services/testdata/mutation';
import {
  MUTATION_BUDGET_MS,
  evaluateMutationCandidates,
  type MutationCheckerJudge,
} from '../../services/testdata/mutationRunner';

function detail(overrides: Partial<PythonRunDetail> = {}): PythonRunDetail {
  return {
    status: 'Accepted',
    accepted: true,
    timedOut: false,
    exitStatus: 0,
    stdout: '1\n',
    stderr: '',
    ...overrides,
  };
}

function pythonCandidate(
  overrides: Partial<MutationCandidate> = {},
): MutationCandidate {
  return {
    origin: 'generated',
    language: 'python',
    operatorId: 'comparison-boundary',
    source: 'print(1)',
    ...overrides,
  };
}

function cppCandidate(
  overrides: Partial<MutationCandidate> = {},
): MutationCandidate {
  return {
    origin: 'generated',
    language: 'cpp',
    operatorId: 'comparison-boundary',
    source: 'int main() { return 0; }',
    ...overrides,
  };
}

function makeRunner(): TestdataSandboxRunner & {
  runPythonBatchDetailed: jest.Mock;
  compileCpp: jest.Mock;
  runCompiledBatchDetailed: jest.Mock;
  deleteCachedFile: jest.Mock;
} {
  return {
    isAvailable: jest.fn().mockResolvedValue(true),
    runPython: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runPythonBatch: jest.fn().mockResolvedValue([]),
    runPythonBatchDetailed: jest.fn().mockResolvedValue([detail()]),
    compileCpp: jest.fn().mockResolvedValue({ ok: true, fileId: 'compiled-1' }),
    runCompiledBatchDetailed: jest.fn().mockResolvedValue([detail()]),
    deleteCachedFile: jest.fn().mockResolvedValue(undefined),
  };
}

function baseInput(
  runner: TestdataSandboxRunner,
  candidates: MutationCandidate[] = [pythonCandidate()],
) {
  return {
    mode: 'observe' as const,
    candidates,
    cases: [{ input: '1\n', answer: '1\n' }],
    runner,
    customChecker: false,
    correctnessDeadlineAt: Date.now() + 300_000,
  };
}

describe('testdata mutation sandbox runner', () => {
  it('exports the independent 120 second mutation budget', () => {
    expect(MUTATION_BUDGET_MS).toBe(120_000);
  });

  it.each([
    ['Runtime Error', false, false],
    ['Memory Limit Exceeded', false, false],
    ['Output Limit Exceeded', false, false],
    ['Time Limit Exceeded', false, true],
  ])('counts explicit candidate status %s as killed', async (status, accepted, timedOut) => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed.mockResolvedValue([
      detail({ status: status as string, accepted: accepted as boolean, timedOut: timedOut as boolean, exitStatus: 1 }),
    ]);

    const summary = await evaluateMutationCandidates(baseInput(runner));

    expect(summary).toEqual({
      mode: 'observe',
      status: 'completed',
      generated: 1,
      historical: 0,
      viable: 1,
      killed: 1,
      survived: 0,
      score: 1,
      operators: [{ id: 'comparison-boundary', viable: 1, killed: 1 }],
    });
  });

  it('counts accepted execution with a different normalized output as killed', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed.mockResolvedValue([detail({ stdout: '2\n' })]);

    const summary = await evaluateMutationCandidates(baseInput(runner));

    expect(summary).toMatchObject({ viable: 1, killed: 1, survived: 0, score: 1 });
  });

  it('counts accepted execution with equivalent line endings and trailing spaces as survived', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed.mockResolvedValue([detail({ stdout: '1  \r\n\r\n' })]);

    const summary = await evaluateMutationCandidates(baseInput(runner));

    expect(summary).toMatchObject({ viable: 1, killed: 0, survived: 1, score: 0 });
  });

  it.each([
    detail({ status: 'System Error', accepted: false, exitStatus: undefined, error: 'worker lost' }),
    undefined,
  ])('does not credit malformed or infrastructure detail as killed', async returnedDetail => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed.mockResolvedValue([returnedDetail]);

    const summary = await evaluateMutationCandidates(baseInput(runner));

    expect(summary).toEqual({
      mode: 'observe',
      status: 'partial',
      generated: 1,
      historical: 0,
      viable: 0,
      killed: 0,
      survived: 0,
      operators: [],
      skippedReason: 'sandbox-infra',
    });
  });

  it('does not credit a thrown transport failure as killed', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed.mockRejectedValue(new Error('transport failed'));

    const summary = await evaluateMutationCandidates(baseInput(runner));

    expect(summary).toMatchObject({
      status: 'partial', viable: 0, killed: 0, skippedReason: 'sandbox-infra',
    });
    expect(JSON.stringify(summary)).not.toContain('transport failed');
  });

  it('uses a ready checker as the only authority for custom-checker output', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed.mockResolvedValue([detail({ stdout: 'different text\n' })]);
    const judgeWithChecker: MutationCheckerJudge = jest.fn().mockResolvedValue(['accept']);

    const summary = await evaluateMutationCandidates({
      ...baseInput(runner),
      customChecker: true,
      judgeWithChecker,
    });

    expect(summary).toMatchObject({ viable: 1, killed: 0, survived: 1, score: 0 });
  });

  it.each([
    [undefined, 'missing checker'],
    [jest.fn().mockResolvedValue(['infra-error']), 'checker infra'],
  ])('never falls back to text comparison for %s', async (judgeWithChecker, _label) => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed.mockResolvedValue([detail({ stdout: '1\n' })]);

    const summary = await evaluateMutationCandidates({
      ...baseInput(runner),
      customChecker: true,
      judgeWithChecker: judgeWithChecker as MutationCheckerJudge | undefined,
    });

    expect(summary).toMatchObject({
      status: 'partial', viable: 0, killed: 0, skippedReason: 'checker-infra',
    });
  });

  it('classifies an explicit checker sandbox budget error separately from checker infra', async () => {
    const runner = makeRunner();
    const judgeWithChecker: MutationCheckerJudge = jest.fn()
      .mockRejectedValue(new SandboxBudgetExceededError());

    const summary = await evaluateMutationCandidates({
      ...baseInput(runner),
      customChecker: true,
      judgeWithChecker,
    });

    expect(summary).toMatchObject({
      status: 'partial', viable: 0, killed: 0, skippedReason: 'budget-exhausted',
    });
  });

  it('excludes a deterministic C++ compile failure from the denominator', async () => {
    const runner = makeRunner();
    runner.compileCpp.mockResolvedValue({ ok: false, kind: 'compile', error: 'bad source' });

    const summary = await evaluateMutationCandidates(baseInput(runner, [cppCandidate()]));

    expect(summary).toEqual({
      mode: 'observe',
      status: 'skipped',
      generated: 1,
      historical: 0,
      viable: 0,
      killed: 0,
      survived: 0,
      operators: [],
      skippedReason: 'no-viable-candidates',
    });
    expect(JSON.stringify(summary)).not.toContain('bad source');
  });

  it('marks a C++ compile infrastructure failure partial', async () => {
    const runner = makeRunner();
    runner.compileCpp.mockResolvedValue({ ok: false, kind: 'infra', error: 'compiler unavailable' });

    const summary = await evaluateMutationCandidates(baseInput(runner, [cppCandidate()]));

    expect(summary).toMatchObject({
      status: 'partial', viable: 0, killed: 0, skippedReason: 'sandbox-infra',
    });
  });

  it('always deletes a compiled C++ file after a surviving execution', async () => {
    const runner = makeRunner();

    const summary = await evaluateMutationCandidates(baseInput(runner, [cppCandidate()]));

    expect(summary).toMatchObject({ viable: 1, survived: 1 });
    expect(runner.deleteCachedFile).toHaveBeenCalledTimes(1);
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('compiled-1');
  });

  it('always deletes a compiled C++ file after a runtime transport failure', async () => {
    const runner = makeRunner();
    runner.runCompiledBatchDetailed.mockRejectedValue(new Error('transport failed'));

    await evaluateMutationCandidates(baseInput(runner, [cppCandidate()]));

    expect(runner.deleteCachedFile).toHaveBeenCalledTimes(1);
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('compiled-1');
  });

  it('always deletes a compiled C++ file after sandbox budget exhaustion', async () => {
    const runner = makeRunner();
    runner.runCompiledBatchDetailed.mockRejectedValue(new SandboxBudgetExceededError());

    const summary = await evaluateMutationCandidates(baseInput(runner, [cppCandidate()]));

    expect(summary).toMatchObject({
      status: 'partial', viable: 0, killed: 0, skippedReason: 'budget-exhausted',
    });
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('compiled-1');
  });

  it('preserves cancellation and deletes a compiled C++ file', async () => {
    const runner = makeRunner();
    const controller = new AbortController();
    runner.runCompiledBatchDetailed.mockImplementation(async () => {
      controller.abort(Object.assign(new Error('canceled'), { name: 'AbortError' }));
      throw controller.signal.reason;
    });

    await expect(evaluateMutationCandidates({
      ...baseInput(runner, [cppCandidate()]),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('compiled-1');
  });

  it('does not start candidates after the remaining correctness budget is exhausted', async () => {
    const runner = makeRunner();

    const summary = await evaluateMutationCandidates({
      ...baseInput(runner),
      correctnessDeadlineAt: Date.now() - 1,
    });

    expect(summary).toEqual({
      mode: 'observe',
      status: 'skipped',
      generated: 1,
      historical: 0,
      viable: 0,
      killed: 0,
      survived: 0,
      operators: [],
      skippedReason: 'budget-exhausted',
    });
    expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
  });

  it('aggregates viable and killed counts without returning candidate source', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed
      .mockResolvedValueOnce([detail({ stdout: 'wrong\n' })])
      .mockResolvedValueOnce([detail({ stdout: '1\n' })])
      .mockResolvedValueOnce([detail({ status: 'Runtime Error', accepted: false, exitStatus: 1 })]);
    const candidates = [
      pythonCandidate(),
      pythonCandidate({ operatorId: 'logical-connector', source: 'print(2)' }),
      pythonCandidate({ origin: 'historical', operatorId: 'historical-submission', source: 'print(3)' }),
    ];

    const summary = await evaluateMutationCandidates(baseInput(runner, candidates));

    expect(summary).toEqual({
      mode: 'observe',
      status: 'completed',
      generated: 2,
      historical: 1,
      viable: 3,
      killed: 2,
      survived: 1,
      score: 2 / 3,
      operators: [
        { id: 'comparison-boundary', viable: 1, killed: 1 },
        { id: 'logical-connector', viable: 1, killed: 0 },
        { id: 'historical-submission', viable: 1, killed: 1 },
      ],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('print(1)');
    expect(serialized).not.toContain('print(2)');
    expect(serialized).not.toContain('print(3)');
  });

  it('skips an empty candidate set without calling the sandbox', async () => {
    const runner = makeRunner();

    const summary = await evaluateMutationCandidates(baseInput(runner, []));

    expect(summary).toMatchObject({
      status: 'skipped', generated: 0, historical: 0, skippedReason: 'no-candidates',
    });
    expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
  });
});
