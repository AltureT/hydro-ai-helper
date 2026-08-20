import type { TestdataModelRole } from '../../models/aiConfig';
import {
  assertProblemSpecUnchanged,
  createTestdataPipelineContext,
  hashTestdataRoleIdentity,
} from '../../services/testdata/pipelineContext';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';
import type { TestdataRiskAssessment } from '../../services/testdata/risk';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';
import {
  buildGenerationArtifactsUserPrompt,
  buildIndependentVerifierUserPrompt,
  buildKillTargetPromptSamples,
  buildKillTargetsUserPrompt,
  buildSandboxRepairPrompt,
  buildSolutionBlueprintUserPrompt,
  type BuildUserPromptParams,
  type SandboxSolutionBlueprint,
  TestdataGenService,
} from '../../services/testdataGenService';

const statement = createStatementSnapshot([
  '# Sum',
  'Read one integer and print it.',
  '## Constraints',
  '1 <= n <= 100',
].join('\n'));

function validSpec(): ProblemSpecV1 {
  return {
    schemaVersion: 1,
    statementHash: statement.statementHash,
    problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields: [{ id: 'n', name: 'n', type: 'integer', encoding: 'one integer' }],
    constraints: [{
      id: 'c_n',
      expression: '1 <= n <= 100',
      machineCheckable: true,
      scope: 'global',
      evidence: { quote: '1 <= n <= 100', section: 'Constraints' },
    }],
    invariants: [],
    outputPolicy: { kind: 'exact', caseSensitive: true },
    subtasks: [],
    uncertainties: [],
  };
}

function lowRisk(): TestdataRiskAssessment {
  return {
    tier: 'low',
    score: 0,
    reasons: [],
    requiresSandbox: true,
    requiresSpecConsensus: false,
    requiresIndependentModels: false,
    allowsDirectFallback: false,
  };
}

function createContext(spec = validSpec()) {
  return createTestdataPipelineContext({
    runId: 'run-task7',
    promptVersion: 'testdata-generation-v2',
    statement,
    spec,
    risk: lowRisk(),
    roleIdentities: {
      oracle: 'private-endpoint-id\0oracle-model',
    } satisfies Partial<Record<TestdataModelRole, string>>,
  });
}

describe('frozen test-data pipeline context', () => {
  it('keeps specHash stable when semantically identical object keys arrive in a different order', () => {
    const reordered = JSON.parse(JSON.stringify(validSpec(), [
      'uncertainties', 'subtasks', 'outputPolicy', 'caseSensitive', 'kind',
      'invariants', 'constraints', 'evidence', 'section', 'quote', 'scope',
      'machineCheckable', 'expression', 'id', 'inputFields', 'encoding', 'type',
      'name', 'testCaseMode', 'problemKind', 'statementHash', 'schemaVersion',
    ])) as ProblemSpecV1;

    expect(createContext(reordered).specHash).toBe(createContext().specHash);
  });

  it('revalidates evidence and freezes independent copies of statement, spec, and risk', () => {
    const sourceSpec = validSpec();
    const sourceRisk = lowRisk();
    const context = createTestdataPipelineContext({
      runId: 'run-task7',
      promptVersion: 'testdata-generation-v2',
      statement,
      spec: sourceSpec,
      risk: sourceRisk,
      roleIdentities: {},
    });

    sourceSpec.inputFields[0].encoding = 'mutated outside context';
    sourceRisk.reasons.push({ code: 'MUTATED', weight: 9, messageKey: 'mutated' });
    expect(context.spec.inputFields[0].encoding).toBe('one integer');
    expect(context.risk.reasons).toEqual([]);
    expect(context.spec.constraints[0].evidence).toMatchObject({
      startOffset: 52,
      endOffset: 65,
    });
    expect(Object.isFrozen(context.statement)).toBe(true);
    expect(Object.isFrozen(context.spec.inputFields[0])).toBe(true);
    expect(Object.isFrozen(context.risk.reasons)).toBe(true);
  });

  it('fails closed before context creation when evidence is not grounded in the statement', () => {
    const invalid = validSpec();
    invalid.constraints[0].evidence.quote = 'not present';

    expect(() => createContext(invalid)).toThrow(expect.objectContaining({
      code: 'SPEC_EVIDENCE_NOT_FOUND',
    }));
  });

  it('hashes role dependencies without retaining endpoint or model identifiers', () => {
    const identity = 'private-endpoint-id\0private-model-name';
    const digest = hashTestdataRoleIdentity(identity);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain('private-endpoint-id');
    expect(digest).not.toContain('private-model-name');
  });

  it.each([
    ['testCaseMode', (candidate: ProblemSpecV1) => { candidate.testCaseMode = { kind: 'counted', countField: 'n' }; }],
    ['stdin encoding', (candidate: ProblemSpecV1) => { candidate.inputFields[0].encoding = 'first line contains T'; }],
    ['output policy', (candidate: ProblemSpecV1) => { candidate.outputPolicy = { kind: 'token' }; }],
    ['subtasks', (candidate: ProblemSpecV1) => {
      candidate.subtasks = [{ id: 1, score: 100, constraintIds: ['c_n'] }];
    }],
    ['constraint references', (candidate: ProblemSpecV1) => {
      candidate.constraints[0].id = 'c_other';
    }],
  ] as const)('rejects repair-time drift in %s', (_label, mutate) => {
    const context = createContext();
    const candidate = JSON.parse(JSON.stringify(context.spec)) as ProblemSpecV1;
    mutate(candidate);

    expect(() => assertProblemSpecUnchanged(context, candidate)).toThrow(expect.objectContaining({
      code: 'SPEC_PARSE_FAILED',
      retryPolicy: 'rerun-spec',
    }));
  });

  it('keeps specHash unchanged across a full-repair invariant check', () => {
    const context = createContext();
    const candidate = JSON.parse(JSON.stringify(context.spec)) as ProblemSpecV1;

    expect(assertProblemSpecUnchanged(context, candidate)).toBe(context.specHash);
  });

  it('anchors Oracle repair to the same frozen stdin encoding', () => {
    const context = createContext();
    const prompt = buildSandboxRepairPrompt(
      new Error('oracle failed'),
      { problemKind: 'traditional', caseCount: 1, languages: [] },
      'oracle',
      undefined,
      context,
    );

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('one integer');
    expect(prompt).toContain(context.specHash);
    expect(prompt).toContain('不得修改');
  });

  it('emits v2 checkpoint metadata with hashes only, never statement, Spec, or endpointId', async () => {
    const context = createContext();
    const onCheckpoint = jest.fn();
    const service = new TestdataGenService({ chat: jest.fn() } as never, {
      reliabilityMode: 'observe',
    });
    (service as any).activePipelineContext = context;
    (service as any).activeRoleIdentities = {
      oracle: {
        endpointId: 'private-runtime-endpoint',
        endpointName: 'Private runtime endpoint',
        modelName: 'private-runtime-model',
      },
    };

    await (service as any).emitCheckpoint({ onCheckpoint }, {
      solution: { problemType: 'traditional', oracleCode: 'print(input())' },
    });

    const update = onCheckpoint.mock.calls[0][0];
    expect(update).toMatchObject({
      checkpointSchemaVersion: 2,
      promptVersion: 'testdata-generation-v2',
      statementHash: statement.statementHash,
      specHash: context.specHash,
      roleDependencies: { oracle: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const serialized = JSON.stringify({
      checkpointSchemaVersion: update.checkpointSchemaVersion,
      promptVersion: update.promptVersion,
      statementHash: update.statementHash,
      specHash: update.specHash,
      roleDependencies: update.roleDependencies,
    });
    expect(serialized).not.toContain(statement.normalizedMarkdown);
    expect(serialized).not.toContain('one integer');
    expect(serialized).not.toContain('private-runtime-endpoint');
    expect(serialized).not.toContain('private-runtime-model');
    expect(serialized).not.toContain('endpointId');
  });
});

describe('role prompt isolation around the frozen spec', () => {
  const params: BuildUserPromptParams = {
    problemTitle: 'Private title',
    statementMarkdown: `${statement.normalizedMarkdown}\nPRIVATE_STATEMENT_ONLY`,
    options: {
      problemKind: 'traditional',
      caseCount: 4,
      dataScale: 'auto',
      languages: [],
    },
  };
  const solution: SandboxSolutionBlueprint = {
    problemType: 'traditional',
    analysis: 'TEACHER_ONLY_ANALYSIS',
    oracleCode: 'CORRECT_ORACLE_SOURCE',
  };

  it('gives Oracle the frozen spec and evidence without role identities or adjudication reasoning', () => {
    const prompt = buildSolutionBlueprintUserPrompt(params, createContext());

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('1 <= n <= 100');
    expect(prompt).not.toContain('private-endpoint-id');
    expect(prompt).not.toContain('Critic reasoning secret');
  });

  it('gives Artifacts only the frozen spec, stdin encoding, and student interface', () => {
    const prompt = buildGenerationArtifactsUserPrompt(params, solution, undefined, createContext());

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('one integer');
    expect(prompt).not.toContain('TEACHER_ONLY_ANALYSIS');
    expect(prompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(prompt).not.toContain('PRIVATE_STATEMENT_ONLY');
  });

  it('does not expose Oracle source or analysis to the independent Verifier', () => {
    const verifierInput: Pick<SandboxSolutionBlueprint, 'problemType' | 'functionName' | 'analysis'>
      & { oracleCode: string } = { ...solution, oracleCode: 'CORRECT_ORACLE_SOURCE' };
    const prompt = buildIndependentVerifierUserPrompt(
      params,
      verifierInput,
      createContext(),
    );

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(prompt).not.toContain('TEACHER_ONLY_ANALYSIS');
    expect(prompt).not.toContain('PRIVATE_STATEMENT_ONLY');
  });

  it('gives Kill Target only the frozen spec and public samples', () => {
    const prompt = buildKillTargetsUserPrompt({
      statement: `${statement.normalizedMarkdown}\nPRIVATE_STATEMENT_ONLY`,
      analysis: 'TEACHER_ONLY_ANALYSIS',
      samples: [{ input: 'PUBLIC_SAMPLE_IN\n', output: 'PUBLIC_SAMPLE_OUT\n' }],
      context: createContext(),
      correctSolutionCode: 'CORRECT_ORACLE_SOURCE',
    });

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('PUBLIC_SAMPLE_IN');
    expect(prompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(prompt).not.toContain('TEACHER_ONLY_ANALYSIS');
    expect(prompt).not.toContain('PRIVATE_STATEMENT_ONLY');
  });

  it('does not reuse Oracle-produced function sample conversions as Kill Target input', () => {
    const publicSample = { id: '1', input: 'PUBLIC_DISPLAY_INPUT\n', output: 'PUBLIC_OUTPUT\n' };
    const samples = buildKillTargetPromptSamples({
      problemType: 'function',
      functionSampleInputs: [{ id: '1', input: 'ORACLE_PRIVATE_STDIN\n' }],
    }, [publicSample], createContext());

    expect(samples).toEqual([{ input: publicSample.input, output: publicSample.output }]);
    expect(JSON.stringify(samples)).not.toContain('ORACLE_PRIVATE_STDIN');
  });
});
