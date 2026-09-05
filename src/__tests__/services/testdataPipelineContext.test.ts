import type { TestdataModelRole } from '../../models/aiConfig';
import {
  assertProblemSpecUnchanged,
  createTestdataPipelineContext,
  hashTestdataRoleIdentity,
  TESTDATA_CHECKPOINT_SCHEMA_VERSION,
  TESTDATA_PIPELINE_PROMPT_VERSION,
} from '../../services/testdata/pipelineContext';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';
import type { TestdataRiskAssessment } from '../../services/testdata/risk';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';
import {
  buildGenerationArtifactsUserPrompt,
  buildHackCasesUserPrompt,
  buildIndependentVerifierUserPrompt,
  buildKillTargetPromptSamples,
  buildKillTargetsUserPrompt,
  buildSandboxRepairPrompt,
  buildSolutionBlueprintUserPrompt,
  buildTestdataUserPrompt,
  checkpointVerifierFromBlueprint,
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
    promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
    statement,
    spec,
    risk: lowRisk(),
    roleIdentities: {
      oracle: 'private-endpoint-id\0oracle-model',
    } satisfies Partial<Record<TestdataModelRole, string>>,
  });
}

describe('frozen test-data pipeline context', () => {
  it('uses prompt v4 while preserving checkpoint schema v2', () => {
    expect(TESTDATA_PIPELINE_PROMPT_VERSION).toBe('testdata-generation-v6');
    expect(TESTDATA_CHECKPOINT_SCHEMA_VERSION).toBe(2);
  });

  it('checkpoints cloned Manifest metadata without materialized probe payloads', () => {
    const manifest = { constraintIds: ['C1'], invariantIds: ['I1'] };
    const recipes = [{
      targetId: 'C1', constructionKind: 'integer-below-min' as const, fieldId: 'n',
      operationName: 'append',
      rawProbeInput: 'SECRET_RECIPE_RAW_PROBE',
      seed: ['SECRET_RECIPE_SEED'],
      materialized: { effectiveInput: 'SECRET_RECIPE_EFFECTIVE_INPUT' },
      invocationPayload: { argv: ['--subtask', 'SECRET_RECIPE_SUBTASK'] },
    }];
    const blueprint = {
      problemType: 'traditional' as const,
      generatorCode: 'print(1)',
      oracleCode: 'print(input())',
      bruteCode: 'print(input())',
      validatorCode: 'import sys\nsys.exit(0)',
      stressGeneratorCode: 'print(1)',
      validatorManifestStatus: 'valid' as const,
      validatorManifest: manifest,
      validatorProbeRecipes: recipes,
      materializedProbeInputs: ['SECRET_RAW_PROBE'],
      legalSeedArray: ['SECRET_SEED'],
      effectiveInput: 'SECRET_EFFECTIVE_INPUT',
      subtaskInvocationPayload: ['--subtask', '1'],
    };
    const checkpoint = checkpointVerifierFromBlueprint(blueprint);

    manifest.constraintIds.push('MUTATED');
    recipes[0].fieldId = 'mutated';
    expect(checkpoint).toEqual(expect.objectContaining({
      validatorManifestStatus: 'valid',
      validatorManifest: { constraintIds: ['C1'], invariantIds: ['I1'] },
      validatorProbeRecipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
        operationName: 'append',
      }],
    }));
    const serialized = JSON.stringify(checkpoint);
    for (const forbidden of [
      'SECRET_RAW_PROBE', 'SECRET_SEED', 'SECRET_EFFECTIVE_INPUT',
      'SECRET_RECIPE_RAW_PROBE', 'SECRET_RECIPE_SEED', 'SECRET_RECIPE_EFFECTIVE_INPUT',
      'SECRET_RECIPE_SUBTASK', 'rawProbeInput', 'seed', 'materialized', 'invocationPayload',
      'subtaskInvocationPayload', 'materializedProbeInputs', 'legalSeedArray',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('drops malformed checkpoint recipes without serializing allowed-slot runtime payloads', () => {
    const validRecipe = {
      targetId: 'C1',
      constructionKind: 'integer-below-min' as const,
      fieldId: 'n',
      operationName: 'append',
    };
    const boundaryRecipe = {
      targetId: 'T'.repeat(64),
      constructionKind: 'subtask-upper-bound' as const,
      fieldId: 'F'.repeat(64),
      operationName: 'O'.repeat(256),
    };
    const malformedValues: Array<[string, unknown]> = [
      ['nested', { outer: { sensitive: 'SECRET_ALLOWED_SLOT_NESTED' } }],
      ['object', { sensitive: 'SECRET_ALLOWED_SLOT_OBJECT' }],
      ['array', ['SECRET_ALLOWED_SLOT_ARRAY']],
      ['number', 8675309],
      ['null', null],
      ['empty', ''],
      ['overlong', `SECRET_ALLOWED_SLOT_OVERLONG_${'x'.repeat(300)}`],
    ];
    const malformedRecipes = (
      ['targetId', 'constructionKind', 'fieldId', 'operationName'] as const
    ).flatMap(slot => malformedValues.map(([, value]) => ({
      ...validRecipe,
      [slot]: value,
    })));
    const checkpoint = checkpointVerifierFromBlueprint({
      problemType: 'traditional',
      generatorCode: 'print(1)',
      oracleCode: 'print(input())',
      bruteCode: 'print(input())',
      validatorCode: 'import sys\nsys.exit(0)',
      stressGeneratorCode: 'print(1)',
      validatorProbeRecipes: [
        validRecipe,
        boundaryRecipe,
        ...malformedRecipes,
        { ...validRecipe, constructionKind: 'SECRET_UNKNOWN_CONSTRUCTION_KIND' },
      ] as any,
    });

    expect(checkpoint.validatorProbeRecipes).toEqual([validRecipe, boundaryRecipe]);
    const serialized = JSON.stringify(checkpoint);
    for (const forbidden of [
      'SECRET_ALLOWED_SLOT_NESTED',
      'SECRET_ALLOWED_SLOT_OBJECT',
      'SECRET_ALLOWED_SLOT_ARRAY',
      '8675309',
      'SECRET_ALLOWED_SLOT_OVERLONG',
      'SECRET_UNKNOWN_CONSTRUCTION_KIND',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

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
      promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
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

  it('emits current checkpoint metadata with hashes only, never statement, Spec, or endpointId', async () => {
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
      promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
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

  it('lets a fresh role identity override the restored hash for the same role', async () => {
    const context = createContext();
    const onCheckpoint = jest.fn();
    const service = new TestdataGenService({ chat: jest.fn() } as never, {
      reliabilityMode: 'observe',
    });
    (service as any).activePipelineContext = context;
    (service as any).restoredRoleDependencies = {
      oracle: hashTestdataRoleIdentity('restored-endpoint\0restored-model'),
    };
    (service as any).activeRoleIdentities = {
      oracle: {
        endpointId: 'fresh-endpoint',
        endpointName: 'Fresh endpoint display name',
        modelName: 'fresh-model',
      },
    };

    await (service as any).emitCheckpoint({ onCheckpoint }, {
      solution: { problemType: 'traditional', oracleCode: 'print(input())' },
    });

    const update = onCheckpoint.mock.calls[0][0];
    expect(update.roleDependencies.oracle).toBe(
      hashTestdataRoleIdentity('fresh-endpoint\0fresh-model'),
    );
    expect(JSON.stringify(update)).not.toContain('fresh-endpoint');
    expect(JSON.stringify(update)).not.toContain('fresh-model');
  });

  it('atomically clears restored provenance when the checkpoint is cleared', async () => {
    const context = createContext();
    const onCheckpoint = jest.fn();
    const service = new TestdataGenService({ chat: jest.fn() } as never, {
      reliabilityMode: 'observe',
    });
    (service as any).activePipelineContext = context;
    (service as any).restoredRoleDependencies = {
      artifacts: hashTestdataRoleIdentity('old-artifacts\0old-model'),
    };

    await (service as any).emitCheckpoint({ onCheckpoint }, null);
    await (service as any).emitCheckpoint({ onCheckpoint }, {
      artifacts: { generatorCode: 'print(1)' },
    });

    expect(onCheckpoint.mock.calls[0][0]).toBeNull();
    expect(onCheckpoint.mock.calls[1][0].roleDependencies).not.toHaveProperty('artifacts');
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

  function semanticContext(outputRule: string) {
    const semanticStatement = createStatementSnapshot([
      '# Same structure',
      'Read one integer n.',
      outputRule,
    ].join('\n'));
    const spec: ProblemSpecV1 = {
      schemaVersion: 1,
      statementHash: semanticStatement.statementHash,
      problemKind: 'traditional',
      testCaseMode: { kind: 'single' },
      inputFields: [{ id: 'n', name: 'n', type: 'integer', encoding: 'one integer' }],
      constraints: [],
      invariants: [],
      outputPolicy: { kind: 'exact', caseSensitive: true },
      subtasks: [],
      uncertainties: [],
    };
    return createTestdataPipelineContext({
      runId: 'semantic-role-isolation',
      promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
      statement: semanticStatement,
      spec,
      risk: lowRisk(),
      roleIdentities: {},
    });
  }

  it('gives Oracle the frozen spec and evidence without role identities or adjudication reasoning', () => {
    const prompt = buildSolutionBlueprintUserPrompt(params, createContext());

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('1 <= n <= 100');
    expect(prompt).not.toContain('private-endpoint-id');
    expect(prompt).not.toContain('Critic reasoning secret');
  });

  it('distinguishes isomorphic frozen specs with different public output semantics for direct and Verifier', () => {
    const outputN = semanticContext('PUBLIC_SEMANTIC_OUTPUT_N: print n.');
    const outputSquared = semanticContext('PUBLIC_SEMANTIC_OUTPUT_N_SQUARED: print n squared.');
    const { statementHash: _hashA, ...specA } = outputN.spec;
    const { statementHash: _hashB, ...specB } = outputSquared.spec;

    expect(specA).toEqual(specB);
    for (const build of [
      (context: ReturnType<typeof semanticContext>) => buildTestdataUserPrompt(params, undefined, context),
      (context: ReturnType<typeof semanticContext>) => buildIndependentVerifierUserPrompt(
        params,
        solution,
        context,
      ),
    ]) {
      const promptA = build(outputN);
      const promptB = build(outputSquared);
      expect(promptA).toContain('PUBLIC_SEMANTIC_OUTPUT_N: print n.');
      expect(promptA).not.toContain('PUBLIC_SEMANTIC_OUTPUT_N_SQUARED');
      expect(promptB).toContain('PUBLIC_SEMANTIC_OUTPUT_N_SQUARED: print n squared.');
      expect(promptB).not.toContain('PUBLIC_SEMANTIC_OUTPUT_N: print n.');
    }
  });

  it('gives Artifacts only the frozen spec, stdin encoding, and student interface', () => {
    const prompt = buildGenerationArtifactsUserPrompt(params, solution, undefined, createContext());

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('one integer');
    expect(prompt).not.toContain('TEACHER_ONLY_ANALYSIS');
    expect(prompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(prompt).not.toContain('PRIVATE_STATEMENT_ONLY');
  });

  it('gives Artifacts exact read-only Python, Java, and C++ callable interfaces', () => {
    const functionStatement = createStatementSnapshot('Call transform with values and label.');
    const functionContext = createTestdataPipelineContext({
      runId: 'function-interface-contract',
      promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
      statement: functionStatement,
      spec: {
        schemaVersion: 1,
        statementHash: functionStatement.statementHash,
        problemKind: 'function',
        testCaseMode: { kind: 'single' },
        inputFields: [
          { id: 'values', name: 'values', type: 'array', encoding: 'one JSON array' },
          { id: 'label', name: 'label', type: 'string', encoding: 'one string' },
        ],
        constraints: [],
        invariants: [],
        outputPolicy: { kind: 'exact' },
        subtasks: [],
        uncertainties: [],
      },
      risk: lowRisk(),
      roleIdentities: {},
    });
    const interfaces = {
      py: 'def transform(values: list[int], label: str) -> tuple[list[int], str]:\n    return values, label',
      java: 'class Solution { public int[] transform(int[] values, String label) { return values; } }',
      cc: 'class Solution { public: vector<string> transform(vector<int> values, string label); };',
    };
    const prompt = buildGenerationArtifactsUserPrompt({
      ...params,
      options: { ...params.options, problemKind: 'function', languages: ['py', 'java', 'cc'] },
    }, {
      problemType: 'function',
      functionName: 'transform',
      analysis: 'TEACHER_ONLY_ANALYSIS',
      oracleCode: 'CORRECT_ORACLE_SOURCE',
      solutions: interfaces,
      solutionCode: interfaces.py,
    }, undefined, functionContext);

    for (const [language, source] of Object.entries(interfaces)) {
      expect(prompt).toContain(`SOLUTION:${language}`);
      expect(prompt).toContain(source);
    }
    expect(prompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(prompt).not.toContain('TEACHER_ONLY_ANALYSIS');
  });

  it('does not expose Oracle source or analysis to the independent Verifier', () => {
    const publicContext = semanticContext('PUBLIC_VERIFIER_SEMANTICS: print n squared.');
    const verifierInput: Pick<SandboxSolutionBlueprint, 'problemType' | 'functionName' | 'analysis'>
      & { oracleCode: string } = { ...solution, oracleCode: 'CORRECT_ORACLE_SOURCE' };
    const prompt = buildIndependentVerifierUserPrompt(
      params,
      verifierInput,
      publicContext,
    );

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('PUBLIC_VERIFIER_SEMANTICS: print n squared.');
    expect(prompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(prompt).not.toContain('TEACHER_ONLY_ANALYSIS');
    expect(prompt).not.toContain('PRIVATE_STATEMENT_ONLY');
  });

  it('gives Kill Target and Hack public semantics without the correct solution', () => {
    const publicContext = semanticContext('PUBLIC_DISCRIMINATION_SEMANTICS: print n squared.');
    const prompt = buildKillTargetsUserPrompt({
      statement: `${statement.normalizedMarkdown}\nPRIVATE_STATEMENT_ONLY`,
      analysis: 'TEACHER_ONLY_ANALYSIS',
      samples: [{ input: 'PUBLIC_SAMPLE_IN\n', output: 'PUBLIC_SAMPLE_OUT\n' }],
      context: publicContext,
      correctSolutionCode: 'CORRECT_ORACLE_SOURCE',
    });
    const hackPrompt = buildHackCasesUserPrompt({
      analysis: 'TEACHER_ONLY_ANALYSIS',
      target: {
        kind: 'wrong-algorithm',
        description: 'PUBLIC_WRONG_PATTERN',
        code: 'print("PUBLIC_WRONG_SOLUTION")',
      },
      context: publicContext,
    });

    expect(prompt).toContain('FROZEN_PROBLEM_SPEC');
    expect(prompt).toContain('PUBLIC_DISCRIMINATION_SEMANTICS: print n squared.');
    expect(prompt).toContain('PUBLIC_SAMPLE_IN');
    expect(prompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(prompt).not.toContain('TEACHER_ONLY_ANALYSIS');
    expect(prompt).not.toContain('PRIVATE_STATEMENT_ONLY');
    expect(hackPrompt).toContain('PUBLIC_DISCRIMINATION_SEMANTICS: print n squared.');
    expect(hackPrompt).toContain('PUBLIC_WRONG_SOLUTION');
    expect(hackPrompt).not.toContain('CORRECT_ORACLE_SOURCE');
    expect(hackPrompt).not.toContain('TEACHER_ONLY_ANALYSIS');
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
