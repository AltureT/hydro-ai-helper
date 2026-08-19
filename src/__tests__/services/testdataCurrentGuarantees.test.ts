/**
 * Characterization coverage for guarantees that the reliability refactor must
 * preserve. These tests deliberately exercise public service boundaries rather
 * than prompt/source implementation details.
 */

import yaml from 'js-yaml';
import {
  TestdataGenService,
  buildConfigYaml,
  buildIndependentVerifierUserPrompt,
  finalizePlanVerification,
  materializeSandboxBlueprint,
  parseSandboxBlueprint,
  reduceCheckerExecution,
  evaluateDiscrimination,
  type GenerationPlan,
  type GenerateOptions,
} from '../../services/testdataGenService';
import {
  computeTestdataCheckpointHashes,
  selectTestdataResumeCheckpoint,
} from '../../models/testdataGenerationJob';

const traditional: GenerateOptions = {
  problemKind: 'traditional', caseCount: 1, languages: [],
};

function functionBlueprint() {
  return parseSandboxBlueprint([
    '@@@META@@@', 'problemType: function', 'functionName: add',
    '@@@GENERATOR@@@', 'print(gen())',
    '@@@ORACLE@@@', 'a,b=map(int,input().split())', 'print(a+b)',
    '@@@SOLUTION@@@', 'def add(a, b):', '    return a + b',
    '@@@TEMPLATE:py@@@', 'a,b=map(int,input().split())', 'print(add(a,b))',
  ].join('\n'), { problemKind: 'function', caseCount: 1, languages: ['py'] });
}

function fullyGreenFunctionPlan(): GenerationPlan {
  return {
    problemType: 'function',
    files: [
      { name: '1.in', content: '1\n', kind: 'case-in', origin: 'executed' },
      { name: '1.out', content: '1\n', kind: 'case-out', origin: 'executed' },
      { name: 'template.py', content: '# template', kind: 'template', origin: 'executed' },
      { name: 'template.java', content: '// template', kind: 'template', origin: 'executed' },
      { name: 'template.cc', content: '// template', kind: 'template', origin: 'executed' },
      { name: 'std.py', content: '# std', kind: 'std', origin: 'executed' },
      { name: 'generator.py', content: '# generator', kind: 'generator', origin: 'executed' },
      { name: 'brute.py', content: '# brute', kind: 'brute', origin: 'executed' },
      { name: 'validator.py', content: '# validator', kind: 'validator', origin: 'executed' },
      { name: 'compile.sh', content: '# compile', kind: 'compile', origin: 'deterministic' },
      { name: 'config.yaml', content: 'type: default\n', kind: 'config', origin: 'deterministic' },
    ],
    caseCount: 1,
    verification: {
      mode: 'sandbox',
      oracleKind: 'ai-solution',
      verified: false,
      wouldBlock: true,
      sampleCheck: { total: 2, passed: 2 },
      stressCheck: {
        generated: 5, uniqueInputs: 5, duplicateInputs: 0, compared: 5, agreed: 5,
      },
      templateChecks: {
        py: { compiled: true, executed: true, total: 5, passed: 5 },
        java: { compiled: true, executed: true, total: 5, passed: 5 },
        cc: { compiled: true, executed: true, total: 5, passed: 5 },
      },
      discrimination: {
        targets: [
          { kind: 'wrong-algorithm', description: 'off by one', killed: true, killedBy: 'wa', killedByCase: 1 },
          { kind: 'brute-complexity', description: 'not applicable', killed: false, skippedReason: 'no-complexity-gap' },
        ],
        allKilled: true,
      },
    },
    risk: {
      tier: 'low', score: 0, reasons: [], requiresSandbox: false,
      requiresSpecConsensus: false, requiresIndependentModels: false,
      allowsDirectFallback: true, wouldBlock: false,
    },
  };
}

describe('test-data generation current guarantees', () => {
  it('rejects an historical AC candidate when its required sandbox verification is unavailable', async () => {
    const service = new TestdataGenService({} as never, {
      mode: 'auto',
      sandboxRunner: { isAvailable: jest.fn().mockResolvedValue(false) } as never,
    });

    await expect(service.generate({
      problemTitle: 'candidate', statementMarkdown: 'statement',
      options: { ...traditional, providedStd: 'print(input())', providedStdSource: 'accepted-record' },
    })).rejects.toThrow(/沙箱不可用.*拒绝降级生成/s);
  });

  it('rejects a teacher C++ standard solution outside an executable C++ sandbox', async () => {
    const service = new TestdataGenService({} as never, { mode: 'direct' });

    await expect(service.generate({
      problemTitle: 'cpp', statementMarkdown: 'statement',
      options: {
        ...traditional,
        providedStd: '#include <iostream>\nint main() { return 0; }',
        providedStdSource: 'manual',
      },
    })).rejects.toThrow(/C\+\+ 编译能力/);
  });

  it('does not fall back to web-process generation when sandbox mode has no runner', async () => {
    const service = new TestdataGenService({} as never, { mode: 'sandbox' });

    await expect(service.generate({
      problemTitle: 'sandbox', statementMarkdown: 'statement', options: traditional,
    })).rejects.toThrow(/未配置 Hydro 沙箱执行器/);
  });

  it('runs generated inputs and ORACLE only through the sandbox adapter', async () => {
    // Mutation caught: replacing sandbox execution with a local direct-output path.
    const blueprint = parseSandboxBlueprint([
      '@@@META@@@', 'problemType: traditional',
      '@@@GENERATOR@@@', 'GENERATOR_SENTINEL',
      '@@@ORACLE@@@', 'ORACLE_SENTINEL',
    ].join('\n'), traditional);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn((code: string) => Promise.resolve({
        stdout: code.includes('GENERATOR_SENTINEL')
          ? JSON.stringify({ cases: [{ label: 'c', input: '7' }] }) : '', stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn((code: string) => Promise.resolve([
        code.includes('ORACLE_SENTINEL')
          ? { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: '7\n', stderr: '' }
          : { status: 'Nonzero Exit Status', accepted: false, timedOut: false, exitStatus: 1, stdout: '', stderr: 'wrong adapter code' },
      ])),
    };
    const result = await materializeSandboxBlueprint(blueprint, traditional, '', runner);
    expect(result.cases).toEqual([expect.objectContaining({ label: 'c', input: '7\n', output: '7\n' })]);
    expect(runner.runPython.mock.calls[0][0]).toContain('GENERATOR_SENTINEL');
    expect(runner.runPythonBatchDetailed.mock.calls[0][0]).toContain('ORACLE_SENTINEL');
  });

  it('executes a function solution together with template.py before accepting it', async () => {
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({
        stdout: JSON.stringify({ cases: [{ label: 'sum', input: '2 3' }] }), stderr: '',
      }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn((code: string) => Promise.resolve([
        (code.includes('a,b=map(int,input().split())') || (code.includes('def add(a, b):') && code.includes('print(add(a,b))')))
          ? { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: '5\n', stderr: '' }
          : { status: 'Nonzero Exit Status', accepted: false, timedOut: false, exitStatus: 1, stdout: '', stderr: 'missing composed program' },
      ])),
    };

    const result = await materializeSandboxBlueprint(
      functionBlueprint(), { problemKind: 'function', caseCount: 1, languages: ['py'] }, '', runner,
    );

    expect(result.verification?.templateChecks?.py).toEqual({
      compiled: true, executed: true, total: 1, passed: 1,
    });
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledWith(
      expect.stringContaining('def add(a, b):'), ['2 3\n'], expect.anything(),
    );
  });

  it('keeps an independent verifier request free of ORACLE source', () => {
    const prompt = buildIndependentVerifierUserPrompt({
      problemTitle: 'sum', statementMarkdown: 'Compute a sum.',
      options: traditional,
    }, {
      problemType: 'traditional', analysis: 'read two numbers', oracleCode: 'SECRET_ORACLE_CODE',
    } as never);

    expect(prompt).toContain('Compute a sum.');
    expect(prompt).not.toContain('SECRET_ORACLE_CODE');
  });

  it('does not reuse a checkpoint after its options, config, or checker identity changes', () => {
    const options = { ...traditional, languages: ['py'] };
    const baseline = computeTestdataCheckpointHashes(options, 'statement', {
      existingConfig: 'time_limit: 1000',
      checkerArtifacts: {
        configured: true, read: true, checkerSource: 'int main() {}', checkerHeaders: { 'testlib.h': 'x' },
      },
    });
    const job = {
      domainId: 'system', problemDocId: 1, problemId: 'P1', createdBy: 7, status: 'interrupted' as const,
      checkpoint: { revision: 1, ...baseline, solution: { problemType: 'traditional' as const, oracleCode: 'print(1)' } },
    };
    const expected = { domainId: 'system', problemDocId: 1, problemId: 'P1', createdBy: 7, ...baseline };

    expect(selectTestdataResumeCheckpoint(job, expected)).toBe(job.checkpoint);
    expect(selectTestdataResumeCheckpoint(job, {
      ...expected,
      ...computeTestdataCheckpointHashes({ ...options, caseCount: 2 }, 'statement'),
    })).toBeUndefined();
    expect(selectTestdataResumeCheckpoint(job, {
      ...expected,
      ...computeTestdataCheckpointHashes(options, 'statement', { existingConfig: 'time_limit: 2000' }),
    })).toBeUndefined();
    expect(selectTestdataResumeCheckpoint(job, {
      ...expected,
      ...computeTestdataCheckpointHashes(options, 'statement', {
        checkerArtifacts: {
          configured: true, read: true, checkerSource: 'int main(){return 1;}', checkerHeaders: {},
        },
      }),
    })).toBeUndefined();
  });

  it('classifies custom-checker infrastructure failures separately from wrong answers', () => {
    // Mutation caught: treating testlib _fail or malformed sandbox output as contestant WA.
    for (const exitStatus of [1, 2, 4, 7, 8]) {
      expect(reduceCheckerExecution({
        status: 'Nonzero Exit Status', accepted: false, timedOut: false, exitStatus,
      })).toBe('reject');
    }
    expect(reduceCheckerExecution({
      status: 'Nonzero Exit Status', accepted: false, timedOut: false, exitStatus: 3,
    })).toBe('infra-error');
    expect(reduceCheckerExecution({
      status: 'Nonzero Exit Status', accepted: false, timedOut: false, exitStatus: 9,
    })).toBe('infra-error');
    expect(reduceCheckerExecution({
      status: 'Nonzero Exit Status', accepted: false, timedOut: false,
    })).toBe('infra-error');
    expect(reduceCheckerExecution({
      status: 'System Error', accepted: false, timedOut: false, exitStatus: 1,
    })).toBe('infra-error');
    expect(reduceCheckerExecution({ status: 'Time Limit Exceeded', accepted: false, timedOut: true }))
      .toBe('infra-error');
    expect(reduceCheckerExecution(undefined, true)).toBe('infra-error');
  });

  it('treats checker rejection of a deliberate wrong target as successful semantic evidence', () => {
    const result = evaluateDiscrimination({
      targetRuns: [{
        kind: 'wrong-algorithm',
        description: 'deliberately wrong',
        perCase: [{
          accepted: true,
          timedOut: false,
          stdout: 'alternative',
          status: 'Accepted',
          exitStatus: 0,
          checkerVerdict: 'reject',
        }],
      }],
      oracleOutputs: ['official'],
      customChecker: true,
      checkerAvailable: true,
    });

    expect(result).toEqual({
      targets: [{
        kind: 'wrong-algorithm',
        description: 'deliberately wrong',
        killed: true,
        killedBy: 'wa',
        killedByCase: 1,
      }],
      allKilled: true,
    });
  });

  it('preserves the complete existing top-level config in the final generated YAML', () => {
    // Mutation caught: testing only the input object or a subtask helper misses fields dropped
    // while buildConfigYaml reconstructs the final document from a fragile allowlist.
    const existingConfig = yaml.dump({
      type: 'default',
      time_limit: 1000,
      memory_limit: 512,
      checker_type: 'testlib',
      checker: 'checker.cc',
      detail: true,
      langs: ['py.py3'],
      user_extra_files: ['helper.txt'],
      subtasks: [{ score: 30, cases: [1] }],
    });
    const finalConfig = yaml.load(buildConfigYaml({
      problemType: 'traditional',
      caseCount: 1,
      languages: [],
      caseNumbers: [1, 2],
      newCaseNumbers: [2],
      existingConfig,
    })) as Record<string, any>;

    expect(finalConfig).toEqual(expect.objectContaining({
      time_limit: 1000,
      memory_limit: 512,
      checker_type: 'testlib',
      checker: 'checker.cc',
      detail: true,
      langs: ['py.py3'],
      user_extra_files: ['helper.txt'],
    }));
    expect(finalConfig.subtasks).toEqual([{
      score: 30,
      cases: [1, { input: '2.in', output: '2.out' }],
    }]);
  });

  it('hard gate marks complete sample, stress, discrimination, and selected template evidence verified', () => {
    const plan = fullyGreenFunctionPlan();

    finalizePlanVerification(plan, ['py', 'java', 'cc'], false, 'observe');

    expect(plan.verification).toMatchObject({ verified: true, wouldBlock: false });
  });

  it('hard gate accepts legacy brute evidence only when no stress evidence is present', () => {
    const plan = fullyGreenFunctionPlan();
    delete plan.verification?.stressCheck;
    if (plan.verification) {
      plan.verification.bruteCheck = {
        compared: 3, agreed: 3, skippedTimeout: [], disagreed: [],
      };
    }

    finalizePlanVerification(plan, ['py', 'java', 'cc'], false, 'enforce');

    expect(plan.verification).toMatchObject({ verified: true, wouldBlock: false });
  });

  it.each([
    ['absent', undefined],
    ['not compiled', { compiled: false, executed: false, total: 5, passed: 0 }],
    ['not executed', { compiled: true, executed: false, total: 5, passed: 0 }],
    ['zero total', { compiled: true, executed: true, total: 0, passed: 0 }],
    ['partial pass', { compiled: true, executed: true, total: 5, passed: 4 }],
  ] as const)('hard gate rejects %s selected-language template evidence', (_label, javaCheck) => {
    const plan = fullyGreenFunctionPlan();
    if (javaCheck) plan.verification!.templateChecks!.java = javaCheck;
    else delete plan.verification!.templateChecks!.java;

    finalizePlanVerification(plan, ['py', 'java', 'cc'], false, 'observe');

    expect(plan.verification).toMatchObject({ verified: false, wouldBlock: true });
  });

  it.each([
    ['not read', { read: false }],
    ['not compiled', { compiled: false }],
    ['not executed', { executed: false }],
    ['zero total', { total: 0, passed: 0 }],
    ['partial pass', { total: 4, passed: 3 }],
    ['infrastructure failure', { infraFailures: 1, failureKind: 'infra' as const }],
  ])('hard gate rejects a custom checker that is %s and observe wouldBlock stays true', (_label, patch) => {
    const plan = fullyGreenFunctionPlan();
    plan.verification!.checkerCheck = {
      configured: true, read: true, compiled: true, executed: true,
      total: 4, passed: 4, infraFailures: 0,
      ...patch,
    };

    finalizePlanVerification(plan, ['py', 'java', 'cc'], true, 'observe');

    expect(plan.verification).toMatchObject({ verified: false, wouldBlock: true });
  });

  it.each([
    ['case input', '1.in'],
    ['case output', '1.out'],
    ['selected template', 'template.java'],
    ['standard solution', 'std.py'],
    ['generator', 'generator.py'],
    ['brute', 'brute.py'],
    ['validator', 'validator.py'],
  ])('hard gate rejects an ai-only critical %s', (_label, filename) => {
    const plan = fullyGreenFunctionPlan();
    plan.files.find(file => file.name === filename)!.origin = 'ai-only';

    finalizePlanVerification(plan, ['py', 'java', 'cc'], false, 'observe');

    expect(plan.verification).toMatchObject({ verified: false, wouldBlock: true });
  });

  it('hard gate rejects direct and legacy evidence without changing risk.wouldBlock', () => {
    const direct = fullyGreenFunctionPlan();
    direct.verification!.mode = 'direct';
    direct.risk!.wouldBlock = false;
    const legacy = fullyGreenFunctionPlan();

    finalizePlanVerification(direct, ['py', 'java', 'cc'], false, 'observe');
    finalizePlanVerification(legacy, ['py', 'java', 'cc'], false, 'legacy');

    expect(direct.verification).toMatchObject({ verified: false, wouldBlock: true });
    expect(legacy.verification).toMatchObject({ verified: false, wouldBlock: false });
    expect(direct.risk?.wouldBlock).toBe(false);
  });

  it('records canonical selected-language evidence for direct and incomplete function plans', () => {
    const direct = fullyGreenFunctionPlan();
    direct.verification!.mode = 'direct';
    delete direct.verification!.templateChecks;
    const incomplete = fullyGreenFunctionPlan();
    incomplete.verification!.templateChecks = {
      py: { compiled: true, executed: true, total: 5, passed: 5 },
    };

    finalizePlanVerification(direct, ['cc', 'py', 'java', 'py'], false, 'observe');
    finalizePlanVerification(incomplete, ['java', 'cc', 'py', 'java'], false, 'observe');

    expect(direct.verification).toMatchObject({
      templateLanguages: ['py', 'java', 'cc'], verified: false, wouldBlock: true,
    });
    expect(incomplete.verification).toMatchObject({
      templateLanguages: ['py', 'java', 'cc'], verified: false, wouldBlock: true,
    });
  });

  it.each([
    ['failed sample', (plan: GenerationPlan) => { plan.verification!.sampleCheck = { total: 2, passed: 1 }; }],
    ['failed stress', (plan: GenerationPlan) => { plan.verification!.stressCheck!.agreed = 4; }],
    ['no applicable discrimination target', (plan: GenerationPlan) => {
      plan.verification!.discrimination = {
        targets: [{
          kind: 'brute-complexity', description: 'not applicable', killed: false,
          skippedReason: 'no-complexity-gap',
        }],
        allKilled: true,
      };
    }],
  ])('hard gate rejects %s while absent optional sample/discrimination evidence remains allowed', (_label, mutate) => {
    const plan = fullyGreenFunctionPlan();
    mutate(plan);

    finalizePlanVerification(plan, ['py', 'java', 'cc'], false, 'observe');

    expect(plan.verification).toMatchObject({ verified: false, wouldBlock: true });
  });

  it('traditional hard gate has no selected template requirement and allows absent sample/discrimination', () => {
    const plan = fullyGreenFunctionPlan();
    plan.problemType = 'traditional';
    delete plan.verification!.templateChecks;
    delete plan.verification!.sampleCheck;
    delete plan.verification!.discrimination;
    plan.files = plan.files.filter(file => file.kind !== 'template');

    finalizePlanVerification(plan, [], false, 'observe');

    expect(plan.verification).toMatchObject({ verified: true, wouldBlock: false });
  });
});
