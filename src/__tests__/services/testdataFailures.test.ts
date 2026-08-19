import {
  TESTDATA_FAILURE_STAGES,
  TestdataPipelineError,
  extractTestdataFailureMetadata,
  getUserMessageKeyForFailure,
  repairPolicyForFailure,
  toPipelineError,
  type TestdataFailureCode,
  type TestdataFailureStage,
} from '../../services/testdata/failures';
import {
  TestdataGenerationError,
  parseGeneratorOutput,
} from '../../services/testdataGenService';

describe('typed test-data pipeline failures', () => {
  it('publishes one canonical stage allowlist without underscore aliases', () => {
    expect(TESTDATA_FAILURE_STAGES).toEqual(expect.arrayContaining([
      'function-samples',
      'stress-generator',
    ]));
    expect(TESTDATA_FAILURE_STAGES).not.toContain('function_samples');
    expect(TESTDATA_FAILURE_STAGES).not.toContain('stress_generator');
  });

  it.each([
    ['function_samples', 'function-samples'],
    ['stress_generator', 'stress-generator'],
  ])('normalizes legacy stage input %s to canonical %s', (legacyStage, canonicalStage) => {
    expect(new TestdataPipelineError(
      'legacy caller',
      'GENERATOR_INVALID_INPUT',
      legacyStage,
      'stress-generator',
      'repair-artifact',
    ).stage).toBe(canonicalStage);
  });

  it.each<{
    label: string;
    code: TestdataFailureCode;
    stage: TestdataFailureStage;
    artifact: ConstructorParameters<typeof TestdataPipelineError>[3];
  }>([
    { label: 'solution blueprint parse', code: 'SPEC_PARSE_FAILED', stage: 'solution_blueprint', artifact: 'spec' },
    { label: 'generator JSON', code: 'GENERATOR_INVALID_JSON', stage: 'generator', artifact: 'generator' },
    { label: 'validator false rejection', code: 'VALIDATOR_FALSE_REJECT', stage: 'validator', artifact: 'validator' },
    { label: 'oracle sample mismatch', code: 'ORACLE_SAMPLE_MISMATCH', stage: 'solution_verification', artifact: 'oracle' },
    { label: 'oracle/brute divergence', code: 'ORACLE_BRUTE_DIVERGENCE', stage: 'stress_testing', artifact: 'brute' },
    { label: 'template runtime', code: 'TEMPLATE_RUNTIME_FAILED', stage: 'template', artifact: 'template-py' },
    { label: 'checker infrastructure', code: 'CHECKER_RUNTIME_FAILED', stage: 'checker', artifact: 'checker' },
    { label: 'sandbox budget', code: 'PIPELINE_BUDGET_EXHAUSTED', stage: 'sandbox_budget', artifact: 'pipeline' },
    { label: 'user cancellation', code: 'CANCELLED', stage: 'canceled', artifact: 'pipeline' },
  ])('maps $label to stable code $code', ({ code, stage, artifact }) => {
    const source = Object.assign(new Error('wording may change freely'), { name: 'UpstreamFailure' });
    const error = toPipelineError(source, { code, stage, artifact });

    expect(error).toBeInstanceOf(TestdataPipelineError);
    expect(error).toMatchObject({ code, stage, artifact });
    expect(error.cause).toBe(source);
  });

  it('derives repair policy from code and artifact rather than message text', () => {
    const left = new TestdataPipelineError(
      '生成器输出不是 JSON',
      'GENERATOR_INVALID_JSON',
      'generator',
      'generator',
      'repair-artifact',
    );
    const right = new TestdataPipelineError(
      'completely unrelated wording mentioning ORACLE and BRUTE',
      'GENERATOR_INVALID_JSON',
      'generator',
      'generator',
      'repair-artifact',
    );

    expect(repairPolicyForFailure(left)).toBe('repair-artifact');
    expect(repairPolicyForFailure(right)).toBe('repair-artifact');
  });

  it('adjudicates ORACLE/BRUTE divergence instead of repairing either artifact', () => {
    const error = toPipelineError(new Error('outputs disagree'), {
      code: 'ORACLE_BRUTE_DIVERGENCE',
      stage: 'stress_testing',
      artifact: 'brute',
    });

    expect(error.retryPolicy).toBe('adjudicate');
    expect(repairPolicyForFailure(error)).toBe('adjudicate');
  });

  it('keeps validator false rejection distinct from generator invalid input', () => {
    const validator = toPipelineError(new Error('valid case rejected'), {
      code: 'VALIDATOR_FALSE_REJECT',
      stage: 'validator',
      artifact: 'validator',
    });
    const generator = toPipelineError(new Error('generated stdin is malformed'), {
      code: 'GENERATOR_INVALID_INPUT',
      stage: 'generator',
      artifact: 'generator',
    });

    expect(validator.code).toBe('VALIDATOR_FALSE_REJECT');
    expect(validator.artifact).toBe('validator');
    expect(generator.code).toBe('GENERATOR_INVALID_INPUT');
    expect(generator.artifact).toBe('generator');
  });

  it('rejects nested, overlong, and content-bearing safeDetails', () => {
    const make = (safeDetails: Record<string, unknown>) => () => new TestdataPipelineError(
      'failed',
      'UNKNOWN',
      'pipeline',
      'pipeline',
      'switch-model',
      safeDetails as never,
    );

    expect(make({ counts: { passed: 1 } })).toThrow(TypeError);
    expect(make({ status: 'x'.repeat(129) })).toThrow(TypeError);
    expect(make({ rawInput: '1 2 3' })).toThrow(TypeError);
    expect(make({ problemId: 'P1000' })).toThrow(TypeError);
    expect(make({ id: 'P1000' })).toThrow(TypeError);
    expect(make({ pid: 'P1000' })).toThrow(TypeError);
    expect(make({ uid: '42' })).toThrow(TypeError);
    expect(make({ traceId: 'trace-123' })).toThrow(TypeError);
    expect(make({ recordIds: ['1', '2'] })).toThrow(TypeError);
    expect(make({ apiUrl: 'https://example.invalid' })).toThrow(TypeError);
    expect(make({ apiKey: 'secret' })).toThrow(TypeError);
  });

  it('accepts only the enum/count/duration/index/bool/hash details used by production', () => {
    const error = new TestdataPipelineError(
      'failed',
      'GENERATOR_OUTPUT_TOO_LARGE',
      'generator',
      'generator',
      'repair-artifact',
      {
        failureKind: 'compile',
        actualCount: 3,
        expectedCount: 4,
        elapsedMs: 1500,
        caseIndex: 2,
        checkerUsed: false,
        contentHash: '0123456789abcdef0123456789abcdef',
      },
    );

    expect(error.safeDetails).toEqual({
      failureKind: 'compile',
      actualCount: 3,
      expectedCount: 4,
      elapsedMs: 1500,
      caseIndex: 2,
      checkerUsed: false,
      contentHash: '0123456789abcdef0123456789abcdef',
    });
  });

  it('extracts only stable typed metadata and validated safe details', () => {
    const error = new TestdataPipelineError(
      'technical detail stays local',
      'GENERATOR_WRONG_CASE_COUNT',
      'generator',
      'generator',
      'repair-artifact',
      { expectedCount: 10, actualCount: 9, status: 'wrong-count', indexes: ['9'] },
    );

    expect(extractTestdataFailureMetadata(error)).toEqual({
      failureCode: 'GENERATOR_WRONG_CASE_COUNT',
      stage: 'generator',
      artifact: 'generator',
      retryPolicy: 'repair-artifact',
      safeDetails: { expectedCount: 10, actualCount: 9, status: 'wrong-count', indexes: ['9'] },
    });
    expect(extractTestdataFailureMetadata(new Error('raw input: secret'))).toBeUndefined();
  });

  it('maps stable failure codes to localized user-message keys', () => {
    expect(getUserMessageKeyForFailure('PIPELINE_BUDGET_EXHAUSTED'))
      .toBe('ai_helper_testdata_failure_pipeline_budget_exhausted');
    expect(getUserMessageKeyForFailure('CANCELLED'))
      .toBe('ai_helper_testdata_failure_cancelled');
    expect(getUserMessageKeyForFailure('UNKNOWN'))
      .toBe('ai_helper_testdata_failure_unknown');
  });

  it('exposes generator parser failures as typed production errors', () => {
    expect(() => parseGeneratorOutput('{not-json', 2)).toThrow(expect.objectContaining({
      code: 'GENERATOR_INVALID_JSON',
      stage: 'generator',
      artifact: 'generator',
      retryPolicy: 'repair-artifact',
    }));
    expect(() => parseGeneratorOutput('{"cases":[]}', 2)).toThrow(expect.objectContaining({
      code: 'GENERATOR_WRONG_CASE_COUNT',
      artifact: 'generator',
      safeDetails: { actualCount: 0, expectedCount: 2 },
    }));
  });

  it('adapts legacy TestdataGenerationError to the typed failure contract', () => {
    const legacy = new TestdataGenerationError('still failed', 'oracle', [], true);

    expect(legacy).toBeInstanceOf(TestdataPipelineError);
    expect(legacy).toMatchObject({
      code: 'ORACLE_RUNTIME_FAILED',
      stage: 'oracle',
      artifact: 'oracle',
      retryPolicy: 'repair-artifact',
    });
  });

  it.each([
    {
      stage: 'artifacts_parse',
      code: 'GENERATOR_INVALID_JSON',
      artifact: 'generator',
      retryPolicy: 'repair-artifact',
    },
    {
      stage: 'independent_verifier_parse',
      code: 'COVERAGE_REQUIREMENT_MISSING',
      artifact: 'coverage',
      retryPolicy: 'switch-model',
    },
    {
      stage: 'template_missing',
      code: 'TEMPLATE_COMPILE_FAILED',
      artifact: 'template-py',
      retryPolicy: 'repair-artifact',
    },
    {
      stage: 'function-samples',
      code: 'GENERATOR_INVALID_INPUT',
      artifact: 'stress-generator',
      retryPolicy: 'repair-artifact',
    },
    {
      stage: 'config_parse',
      code: 'SPEC_PARSE_FAILED',
      artifact: 'spec',
      retryPolicy: 'no-retry',
    },
  ])('maps real legacy stage $stage without UNKNOWN/pipeline fallback', expected => {
    expect(new TestdataGenerationError('failed', expected.stage)).toMatchObject(expected);
  });
});
