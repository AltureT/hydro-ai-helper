import { TestdataSandboxRunner } from '../../services/goJudgeSandboxService';
import {
  TemplateVerificationError,
  TemplateOutputAdjudicator,
  verifySelectedTemplates,
} from '../../services/testdata/templateVerifier';
import { SandboxBudgetExceededError } from '../../services/goJudgeSandboxService';

const cases = ['sample', 'small', 'medium', 'large'].map(name => ({
  input: `${name} input\n`,
  answer: `${name} answer\n`,
}));

function acceptedOutputs() {
  return cases.map(testcase => ({
    status: 'Accepted',
    accepted: true,
    timedOut: false,
    exitStatus: 0,
    stdout: testcase.answer,
    stderr: '',
  }));
}

function makeRunner() {
  return {
    runPythonBatchDetailed: jest.fn().mockResolvedValue(acceptedOutputs()),
    compileCpp: jest.fn().mockResolvedValue({ ok: true, fileId: 'cpp-cache' }),
    runCompiledBatchDetailed: jest.fn().mockResolvedValue(acceptedOutputs()),
    compileJava: jest.fn().mockResolvedValue({ ok: true, fileId: 'java-cache' }),
    runJavaBatchDetailed: jest.fn().mockResolvedValue(acceptedOutputs()),
    deleteCachedFile: jest.fn().mockResolvedValue(undefined),
  } as unknown as TestdataSandboxRunner;
}

const ordinaryAdjudicator: TemplateOutputAdjudicator = {
  customChecker: false,
  adjudicate: async () => {
    throw new Error('ordinary problems must not invoke the custom checker');
  },
};

describe('verifySelectedTemplates', () => {
  it('executes every requested Python, C++, and Java case with the Hydro layouts', async () => {
    const runner = makeRunner();

    const checks = await verifySelectedTemplates({
      languages: ['py', 'java', 'cc'],
      solutions: { py: 'PY_SOLUTION', java: 'JAVA_SOLUTION', cc: 'CPP_SOLUTION' },
      templates: { py: 'PY_TEMPLATE', java: 'JAVA_TEMPLATE', cc: 'CPP_TEMPLATE' },
      cases,
      runner,
      adjudicator: ordinaryAdjudicator,
      allowCheckerInfraResult: false,
    });

    expect(checks).toEqual({
      py: { compiled: true, executed: true, total: 4, passed: 4 },
      java: { compiled: true, executed: true, total: 4, passed: 4 },
      cc: { compiled: true, executed: true, total: 4, passed: 4 },
    });
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledWith(
      'PY_SOLUTION\nPY_TEMPLATE',
      cases.map(testcase => testcase.input),
      expect.any(Object),
    );
    expect(runner.compileCpp).toHaveBeenCalledWith('CPP_TEMPLATE', expect.objectContaining({
      extraFiles: { 'foo.cc': 'CPP_SOLUTION' },
    }));
    expect(runner.runCompiledBatchDetailed).toHaveBeenCalledWith(
      'cpp-cache', cases.map(testcase => testcase.input), expect.any(Object),
    );
    expect(runner.compileJava).toHaveBeenCalledWith(
      'JAVA_TEMPLATE', 'JAVA_SOLUTION', expect.any(Object),
    );
    expect(runner.runJavaBatchDetailed).toHaveBeenCalledWith(
      'java-cache', cases.map(testcase => testcase.input), expect.any(Object),
    );
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('cpp-cache');
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('java-cache');
  });

  it('classifies missing C++ compile support as a compile failure instead of skipping it', async () => {
    const runner = makeRunner();
    delete runner.compileCpp;
    delete runner.runCompiledBatchDetailed;

    await expect(verifySelectedTemplates({
      languages: ['cc'], solutions: { cc: 'CPP_SOLUTION' }, templates: { cc: 'CPP_TEMPLATE' },
      cases, runner, adjudicator: ordinaryAdjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject<Partial<TemplateVerificationError>>({
      language: 'cc', kind: 'compile',
      check: { compiled: false, executed: false, total: 4, passed: 0, failureKind: 'compile' },
    });
  });

  it.each([
    ['cc', 'compileCpp'],
    ['java', 'compileJava'],
  ] as const)('classifies %s compiler rejection as compile', async (language, compileMethod) => {
    const runner = makeRunner();
    runner[compileMethod] = jest.fn().mockResolvedValue({ ok: false, kind: 'compile', error: 'bad source' });

    await expect(verifySelectedTemplates({
      languages: [language],
      solutions: { [language]: `${language}_SOLUTION` },
      templates: { [language]: `${language}_TEMPLATE` },
      cases, runner, adjudicator: ordinaryAdjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject({ language, kind: 'compile' });
  });

  it('classifies non-accepted execution and missing run results as runtime', async () => {
    const rejectedRunner = makeRunner();
    rejectedRunner.runPythonBatchDetailed = jest.fn().mockResolvedValue([
      { ...acceptedOutputs()[0], accepted: false, status: 'Runtime Error', exitStatus: 1 },
      ...acceptedOutputs().slice(1),
    ]);
    await expect(verifySelectedTemplates({
      languages: ['py'], solutions: { py: 'PY_SOLUTION' }, templates: { py: 'PY_TEMPLATE' },
      cases, runner: rejectedRunner, adjudicator: ordinaryAdjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject({ language: 'py', kind: 'runtime', caseIndex: 0 });

    const incompleteRunner = makeRunner();
    incompleteRunner.runPythonBatchDetailed = jest.fn().mockResolvedValue(acceptedOutputs().slice(0, 3));
    await expect(verifySelectedTemplates({
      languages: ['py'], solutions: { py: 'PY_SOLUTION' }, templates: { py: 'PY_TEMPLATE' },
      cases, runner: incompleteRunner, adjudicator: ordinaryAdjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject({ language: 'py', kind: 'runtime' });
  });

  it('classifies SandboxBudgetExceededError as budget', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed = jest.fn().mockRejectedValue(new SandboxBudgetExceededError());

    await expect(verifySelectedTemplates({
      languages: ['py'], solutions: { py: 'PY_SOLUTION' }, templates: { py: 'PY_TEMPLATE' },
      cases, runner, adjudicator: ordinaryAdjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject({ language: 'py', kind: 'budget' });
  });

  it('keeps cancellation identity through cached cleanup', async () => {
    const runner = makeRunner();
    const controller = new AbortController();
    const cancellation = new Error('caller cancellation');
    runner.runCompiledBatchDetailed = jest.fn().mockImplementation(async () => {
      controller.abort(cancellation);
      throw new Error('transport canceled');
    });

    await expect(verifySelectedTemplates({
      languages: ['cc'], solutions: { cc: 'CPP_SOLUTION' }, templates: { cc: 'CPP_TEMPLATE' },
      cases, runner, adjudicator: ordinaryAdjudicator, signal: controller.signal,
      allowCheckerInfraResult: false,
    })).rejects.toBe(cancellation);
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('cpp-cache');
  });

  it('classifies ordinary output differences as mismatch after all cases run', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed = jest.fn().mockResolvedValue([
      acceptedOutputs()[0],
      { ...acceptedOutputs()[1], stdout: 'wrong\n' },
      ...acceptedOutputs().slice(2),
    ]);

    await expect(verifySelectedTemplates({
      languages: ['py'], solutions: { py: 'PY_SOLUTION' }, templates: { py: 'PY_TEMPLATE' },
      cases, runner, adjudicator: ordinaryAdjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject({ language: 'py', kind: 'mismatch', caseIndex: 1 });
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledWith(
      expect.any(String), cases.map(testcase => testcase.input), expect.any(Object),
    );
  });

  it('uses custom checker rejection rather than text equality', async () => {
    const runner = makeRunner();
    runner.runPythonBatchDetailed = jest.fn().mockResolvedValue(acceptedOutputs().map(result => ({
      ...result, stdout: 'different output\n',
    })));
    const adjudicator: TemplateOutputAdjudicator = {
      customChecker: true,
      adjudicate: async received => {
        expect(received).toHaveLength(4);
        return ['accept', 'reject', 'accept', 'accept'];
      },
    };

    await expect(verifySelectedTemplates({
      languages: ['py'], solutions: { py: 'PY_SOLUTION' }, templates: { py: 'PY_TEMPLATE' },
      cases, runner, adjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject({ language: 'py', kind: 'mismatch', caseIndex: 1 });
  });

  it('returns checker-infra evidence when checker verdicts are missing and explicitly allowed', async () => {
    const runner = makeRunner();
    const adjudicator: TemplateOutputAdjudicator = {
      customChecker: true,
      adjudicate: async () => ['accept', undefined, 'accept', 'accept'] as unknown as Array<'accept' | 'reject' | 'infra-error'>,
    };

    await expect(verifySelectedTemplates({
      languages: ['py'], solutions: { py: 'PY_SOLUTION' }, templates: { py: 'PY_TEMPLATE' },
      cases, runner, adjudicator, allowCheckerInfraResult: true,
    })).resolves.toEqual({
      py: { compiled: true, executed: true, total: 4, passed: 0, failureKind: 'checker-infra' },
    });
  });

  it('classifies checker infra errors without turning them into mismatches', async () => {
    const runner = makeRunner();
    const adjudicator: TemplateOutputAdjudicator = {
      customChecker: true,
      adjudicate: async () => ['accept', 'infra-error', 'accept', 'accept'],
    };

    await expect(verifySelectedTemplates({
      languages: ['py'], solutions: { py: 'PY_SOLUTION' }, templates: { py: 'PY_TEMPLATE' },
      cases, runner, adjudicator, allowCheckerInfraResult: false,
    })).rejects.toMatchObject({ language: 'py', kind: 'checker-infra', caseIndex: 1 });
  });
});
