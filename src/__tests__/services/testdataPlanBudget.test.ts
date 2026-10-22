jest.mock('../../lib/crypto', () => ({ decrypt: jest.fn((value: string) => value) }));

import { assertGeneratedDataBudget, GENERATOR_BYTE_LIMITS } from '../../services/testdata/generatorBudget';
import { materializeGeneratorPlan, renderGeneratorArtifacts, type GeneratorPlanV1 } from '../../services/testdata/generatorDsl';
import { assemblePlan, materializeSandboxBlueprint, resolveMaterializationResume, type SandboxGenerationBlueprint } from '../../services/testdataGenService';
import { assertTestdataPlanBudget } from '../../services/testdata/fileBudget';
import { createTestdataPipelineContext, TESTDATA_PIPELINE_PROMPT_VERSION } from '../../services/testdata/pipelineContext';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';

describe('complete file budget before expensive verification', () => {
  it('counts normalized companion and code bytes without rewriting any input', () => {
    const input = '0'.repeat(3 * 1024 * 1024 - 1) + '\n';
    const cases = [{ input, output: '1\n' }, { input, output: '2\n' }];
    const auxiliary = [{ name: 'generator-data.b64', content: 'A'.repeat(2 * 1024 * 1024) }];
    expect(() => assertGeneratedDataBudget(cases, auxiliary)).toThrow(expect.objectContaining({
      code: 'GENERATOR_OUTPUT_TOO_LARGE', retryPolicy: 'repair-artifact',
      safeDetails: expect.objectContaining({ failureKind: 'plan-budget', actualBytes: 8388613, maxBytes: 8388608 }),
    }));
    expect(cases[0].input).toBe(input);
    expect(auxiliary[0].content).toHaveLength(2 * 1024 * 1024);
    expect(() => assertGeneratedDataBudget(cases, [{ name: 'generator.py', content: 'print(1)\r\n' }])).not.toThrow();
  });

  it('does not send oversized non-generator code back to the generator role', () => {
    const auxiliary = [{ name: 'validator.py', content: '#'.repeat(256 * 1024) }];
    expect(() => assertGeneratedDataBudget([{ input: '1', output: '1' }], auxiliary))
      .toThrow(expect.objectContaining({ code: 'GENERATOR_OUTPUT_TOO_LARGE', retryPolicy: 'manual-review' }));
  });

  it('rejects the real incompressible replay pattern before running any validation or oracle', async () => {
    const statement = createStatementSnapshot('Read n and n integers.\n1 <= n <= 200000.\n-1000000000 <= a[i] <= 1000000000.');
    const spec: ProblemSpecV1 = {
      schemaVersion: 1, statementHash: statement.statementHash, problemKind: 'traditional', testCaseMode: { kind: 'single' },
      inputFields: [
        { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
        { id: 'a', name: 'a', type: 'array', encoding: 'line:2 tokens:1..n', dependsOn: ['n'] },
      ],
      constraints: [], invariants: [], outputPolicy: { kind: 'exact' }, subtasks: [], uncertainties: [],
    };
    const plan: GeneratorPlanV1 = { version: 1, seed: 8317,
      cases: Array.from({ length: 4 }, (_, i) => ({ label: `random-${i}`, fields: {
        n: { kind: 'integer', value: 130000 },
        a: { kind: 'array', length: 130000, min: -1000000000, max: 1000000000, pattern: 'random' },
      } })) };
    const materialized = materializeGeneratorPlan(plan, spec);
    const replay = renderGeneratorArtifacts(plan, materialized);
    expect(replay.data).toBeDefined();
    const inputs = materialized.map(({ input }) => ({ input, output: '0\n' }));
    expect(() => assertGeneratedDataBudget(inputs)).not.toThrow();
    const blueprint: SandboxGenerationBlueprint = {
      problemType: 'traditional', generatorPlan: plan, generatorCode: replay.code,
      oracleCode: 'print(0)', validatorCode: 'pass', bruteCode: 'print(0)', stressGeneratorCode: 'unused',
    };
    const options = { problemKind: 'traditional' as const, caseCount: 4, languages: [] };
    const assembled = assemblePlan({ ...blueprint, stdSolution: { code: 'print(0)' },
      generatorReplayData: replay.data, cases: inputs }, options, { mode: 'sandbox' });
    expect(() => assertTestdataPlanBudget(assembled)).toThrow();
    expect(Buffer.byteLength(replay.data!)).toBeLessThan(GENERATOR_BYTE_LIMITS.input);
    const runner = { isAvailable: jest.fn(), runPython: jest.fn().mockRejectedValue(new Error('late sandbox call')),
      runPythonBatch: jest.fn(), runPythonBatchDetailed: jest.fn() };
    const pipelineContext = createTestdataPipelineContext({ runId: 'budget-fixture',
      promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION, statement, spec, roleIdentities: {},
      risk: { tier: 'low', score: 0, reasons: [], requiresSandbox: true, requiresSpecConsensus: false,
        requiresIndependentModels: false, allowsDirectFallback: false } });
    await expect(materializeSandboxBlueprint(blueprint, options, statement.normalizedMarkdown, runner,
      undefined, false, undefined, [], false, undefined,
      { ...resolveMaterializationResume(['GENERATOR']), cache: {}, coverageProof: { reliabilityMode: 'observe', pipelineContext } }))
      .rejects.toMatchObject({ code: 'GENERATOR_OUTPUT_TOO_LARGE', artifact: 'generator', retryPolicy: 'repair-artifact' });
    expect(runner.runPython).not.toHaveBeenCalled();
    expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
  });
});
