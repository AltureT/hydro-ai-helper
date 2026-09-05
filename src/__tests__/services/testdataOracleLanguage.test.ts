jest.mock('../../lib/crypto', () => ({ decrypt: jest.fn((value: string) => value) }));

import {
  parseSolutionBlueprint, parseSandboxBlueprint, parseOracleLanguage,
  mergeSandboxBlueprintRepair, verifySolutionBlueprintSamples, buildSandboxRepairPrompt,
  materializeSandboxBlueprint, TESTDATA_GEN_LIMITS,
} from '../../services/testdataGenService';

const cpp = '#include <iostream>\nusing namespace std;\nint main() { int n; cin >> n; cout << n; }';
const options = { problemKind: 'traditional' as const, caseCount: 1, languages: [] };
const python = 'print(input())';
const blueprint = { problemType: 'traditional' as const, oracleLanguage: 'python' as const,
  oracleCode: python, generatorCode: 'print(1)' };
const sample = '```input1\n1\n```\n\n```output1\n1\n```';

describe('oracle language consistency', () => {
  it.each([parseSolutionBlueprint, parseSandboxBlueprint])('recognizes an undeclared C++ program before execution', parse => {
    const raw = `@@@META@@@\nproblemType: traditional\n@@@ORACLE@@@\n${cpp}`;
    const input = parse === parseSandboxBlueprint ? `${raw}\n@@@GENERATOR@@@\nprint(1)` : raw;
    expect(parse(input, options).oracleLanguage).toBe('cpp');
  });

  it('updates the language when a targeted repair returns C++ without metadata', () => {
    const repaired = mergeSandboxBlueprintRepair(blueprint, `@@@ORACLE@@@\n${cpp}`, 'oracle');
    expect(repaired).toMatchObject({ oracleLanguage: 'cpp', oracleCode: `${cpp}\n`, generatorCode: blueprint.generatorCode });
    expect(blueprint.oracleLanguage).toBe('python');
  });

  it('honors an explicit language change and retains a C++ language on a code-only repair', () => {
    const before = { ...blueprint, oracleLanguage: 'cpp' as const, oracleCode: cpp };
    expect(mergeSandboxBlueprintRepair(before, `@@@ORACLE_LANG@@@\npython\n@@@ORACLE@@@\n${python}`, 'oracle'))
      .toMatchObject({ oracleLanguage: 'python', oracleCode: `${python}\n` });
    expect(mergeSandboxBlueprintRepair(before, '@@@ORACLE@@@\nint main(){return 0;}', 'oracle').oracleLanguage).toBe('cpp');
  });

  it.each(['cpp', 'C++17'])('accepts declared C++ names: %s', value => {
    expect(parseOracleLanguage(`@@@ORACLE_LANG@@@\n${value}`, 'traditional')).toBe('cpp');
  });

  it.each(['rust', '', 'cpp\n@@@ORACLE_LANG@@@\npython'])('rejects invalid or conflicting declarations: %s', value => {
    expect(() => parseOracleLanguage(`@@@ORACLE_LANG@@@\n${value}`, 'traditional')).toThrow(/ORACLE_LANG/);
  });

  it('ignores declarations in removed reasoning and rejects a declaration/source contradiction', () => {
    expect(parseOracleLanguage('<think>\n@@@ORACLE_LANG@@@\ncpp\n</think>\n@@@ORACLE_LANG@@@\npython', 'traditional')).toBe('python');
    expect(() => mergeSandboxBlueprintRepair(blueprint, `@@@ORACLE_LANG@@@\npython\n@@@ORACLE@@@\n${cpp}`, 'oracle'))
      .toThrow(/ORACLE_LANG/);
  });

  it('does not mistake C++ in Python comments or strings for executable C++', () => {
    for (const source of [
      '#include <iostream>\nprint(1)',
      '"""\n#include <iostream>\nusing namespace std;\n"""\nprint(1)',
      'class Solution: memo = {}\nprint(input())',
      'class Solution: # C++ uses { here\n    pass\nprint(input())',
    ]) {
      expect(mergeSandboxBlueprintRepair(blueprint, `@@@ORACLE@@@\n${source}`, 'oracle').oracleLanguage).toBe('python');
      expect(mergeSandboxBlueprintRepair(blueprint, `@@@ORACLE_LANG@@@\npython\n@@@ORACLE@@@\n${source}`, 'oracle').oracleLanguage).toBe('python');
    }
  });

  it('rejects C++ for function problems instead of relabeling it Python', () => {
    expect(() => mergeSandboxBlueprintRepair({ ...blueprint, problemType: 'function' }, `@@@ORACLE@@@\n${cpp}`, 'oracle'))
      .toThrow(/Python/);
  });

  it('blocks stale Python metadata before a C++ program can reach the Python runner', async () => {
    const runner = { runPythonBatchDetailed: jest.fn() };
    await expect(verifySolutionBlueprintSamples({ ...blueprint, oracleCode: cpp }, options, sample, runner as never))
      .rejects.toMatchObject({ artifact: 'oracle', safeDetails: { failureKind: 'language' } });
    expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
  });

  it('retains C++ language in runtime failures and the resulting repair request', async () => {
    const runner = {
      compileCpp: jest.fn().mockResolvedValue({ ok: true, fileId: 'compiled' }),
      runCompiledBatchDetailed: jest.fn().mockResolvedValue([{ accepted: false, status: 'Nonzero Exit Status', stderr: 'fixture' }]),
      runPythonBatchDetailed: jest.fn(), deleteCachedFile: jest.fn(),
    };
    let failure: unknown;
    try {
      await verifySolutionBlueprintSamples({ ...blueprint, oracleLanguage: 'cpp', oracleCode: cpp }, options, sample, runner as never, undefined, false, true);
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'ORACLE_RUNTIME_FAILED', safeDetails: { oracleLanguage: 'cpp' } });
    expect(buildSandboxRepairPrompt(failure, options, 'oracle')).toContain('当前 ORACLE 语言为 C++17');
    expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('compiled');
  });

  it('repairs the input construction when measured output exceeds its file budget', async () => {
    const runner = {
      runPython: jest.fn().mockResolvedValue({ stdout: '{"cases":[{"input":"1"}]}', stderr: '' }),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([{ accepted: true, stdout: 'x'.repeat(325000), status: 'Accepted' }]),
    };
    await expect(materializeSandboxBlueprint(blueprint, options, '', runner as never)).rejects.toMatchObject({
      code: 'GENERATOR_OUTPUT_TOO_LARGE', artifact: 'generator', stage: 'generator', retryPolicy: 'repair-artifact',
      safeDetails: { failureKind: 'output-budget', caseIndex: 1, actualBytes: 325001, maxBytes: TESTDATA_GEN_LIMITS.MAX_FILE_SIZE },
    });
  });
});
