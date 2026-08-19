/**
 * Characterization coverage for guarantees that the reliability refactor must
 * preserve. These tests deliberately exercise public service boundaries rather
 * than prompt/source implementation details.
 */

import yaml from 'js-yaml';
import {
  TestdataGenService,
  buildIndependentVerifierUserPrompt,
  materializeSandboxBlueprint,
  mergeConfigSubtasks,
  parseSandboxBlueprint,
  reduceCheckerExecution,
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

  it('executes a function solution together with template.py before accepting it', async () => {
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({
        stdout: JSON.stringify({ cases: [{ label: 'sum', input: '2 3' }] }), stderr: '',
      }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: '5\n', stderr: '' },
      ]),
    };

    const result = await materializeSandboxBlueprint(
      functionBlueprint(), { problemKind: 'function', caseCount: 1, languages: ['py'] }, '', runner,
    );

    expect(result.verification?.templateCheck).toEqual({
      lang: 'py', total: 1, passed: 1, skippedTimeout: [],
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
      existingConfig: 'time_limit: 1000', checkerSource: 'int main() {}', checkerHeaders: { 'testlib.h': 'x' },
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
      ...computeTestdataCheckpointHashes(options, 'statement', { checkerSource: 'int main(){return 1;}' }),
    })).toBeUndefined();
  });

  it('classifies custom-checker infrastructure failures separately from wrong answers', () => {
    expect(reduceCheckerExecution({ status: 'Nonzero Exit Status', accepted: false, timedOut: false, exitStatus: 1 }))
      .toBe('reject');
    expect(reduceCheckerExecution({ status: 'Time Limit Exceeded', accepted: false, timedOut: true }))
      .toBe('infra-error');
    expect(reduceCheckerExecution(undefined, true)).toBe('infra-error');
  });

  it('merges generated subtasks without silently replacing existing config fields', () => {
    const existing = yaml.load('time_limit: 1000\nchecker_type: default\nsubtasks:\n  - score: 30\n    cases: [1]\n') as Record<string, any>;
    const merged = mergeConfigSubtasks(existing.subtasks, [2]);

    expect(existing.time_limit).toBe(1000);
    expect(existing.checker_type).toBe('default');
    expect(merged?.subtasks).toEqual([{ score: 30, cases: [1, { input: '2.in', output: '2.out' }] }]);
  });
});
