import {
  TestdataPipelineError,
  extractTestdataFailureMetadata,
  getUserMessageKeyForFailure,
  repairPolicyForFailure,
  toPipelineError,
  type TestdataFailureCode,
} from '../../services/testdata/failures';
import {
  TestdataGenerationError,
  parseGeneratorOutput,
} from '../../services/testdataGenService';

describe('typed test-data pipeline failures', () => {
  it.each<{
    label: string;
    code: TestdataFailureCode;
    stage: string;
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
    expect(make({ apiUrl: 'https://example.invalid' })).toThrow(TypeError);
    expect(make({ apiKey: 'secret' })).toThrow(TypeError);
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
});
