export type TestdataFailureCode =
  | 'SPEC_STATEMENT_TOO_LONG'
  | 'SPEC_STATEMENT_TRUNCATED'
  | 'SPEC_PARSE_FAILED'
  | 'SPEC_EVIDENCE_NOT_FOUND'
  | 'SPEC_CONFLICT'
  | 'SPEC_CONSENSUS_REQUIRED'
  | 'SANDBOX_REQUIRED'
  | 'SANDBOX_UNAVAILABLE'
  | 'GENERATOR_INVALID_JSON'
  | 'GENERATOR_WRONG_CASE_COUNT'
  | 'GENERATOR_INVALID_INPUT'
  | 'GENERATOR_OUTPUT_TOO_LARGE'
  | 'STRESS_LOW_DIVERSITY'
  | 'STRESS_INSUFFICIENT_VALID_INPUTS'
  | 'VALIDATOR_FALSE_REJECT'
  | 'VALIDATOR_FALSE_ACCEPT'
  | 'VALIDATOR_CONSTRAINT_COVERAGE_MISSING'
  | 'ORACLE_COMPILE_FAILED'
  | 'ORACLE_RUNTIME_FAILED'
  | 'ORACLE_SAMPLE_MISMATCH'
  | 'ORACLE_BRUTE_DIVERGENCE'
  | 'BRUTE_RUNTIME_FAILED'
  | 'BRUTE_TIMEOUT'
  | 'TEMPLATE_COMPILE_FAILED'
  | 'TEMPLATE_RUNTIME_FAILED'
  | 'TEMPLATE_OUTPUT_MISMATCH'
  | 'CHECKER_REQUIRED_UNAVAILABLE'
  | 'CHECKER_COMPILE_FAILED'
  | 'CHECKER_RUNTIME_FAILED'
  | 'SUBTASK_CONSTRAINT_VIOLATION'
  | 'MUTATION_SCORE_TOO_LOW'
  | 'TRUSTED_SOLUTIONS_DIVERGED'
  | 'COVERAGE_REQUIREMENT_MISSING'
  | 'PIPELINE_BUDGET_EXHAUSTED'
  | 'CANCELLED'
  | 'UNKNOWN';

export const TESTDATA_FAILURE_CODES: readonly TestdataFailureCode[] = [
  'SPEC_STATEMENT_TOO_LONG',
  'SPEC_STATEMENT_TRUNCATED',
  'SPEC_PARSE_FAILED',
  'SPEC_EVIDENCE_NOT_FOUND',
  'SPEC_CONFLICT',
  'SPEC_CONSENSUS_REQUIRED',
  'SANDBOX_REQUIRED',
  'SANDBOX_UNAVAILABLE',
  'GENERATOR_INVALID_JSON',
  'GENERATOR_WRONG_CASE_COUNT',
  'GENERATOR_INVALID_INPUT',
  'GENERATOR_OUTPUT_TOO_LARGE',
  'STRESS_LOW_DIVERSITY',
  'STRESS_INSUFFICIENT_VALID_INPUTS',
  'VALIDATOR_FALSE_REJECT',
  'VALIDATOR_FALSE_ACCEPT',
  'VALIDATOR_CONSTRAINT_COVERAGE_MISSING',
  'ORACLE_COMPILE_FAILED',
  'ORACLE_RUNTIME_FAILED',
  'ORACLE_SAMPLE_MISMATCH',
  'ORACLE_BRUTE_DIVERGENCE',
  'BRUTE_RUNTIME_FAILED',
  'BRUTE_TIMEOUT',
  'TEMPLATE_COMPILE_FAILED',
  'TEMPLATE_RUNTIME_FAILED',
  'TEMPLATE_OUTPUT_MISMATCH',
  'CHECKER_REQUIRED_UNAVAILABLE',
  'CHECKER_COMPILE_FAILED',
  'CHECKER_RUNTIME_FAILED',
  'SUBTASK_CONSTRAINT_VIOLATION',
  'MUTATION_SCORE_TOO_LOW',
  'TRUSTED_SOLUTIONS_DIVERGED',
  'COVERAGE_REQUIREMENT_MISSING',
  'PIPELINE_BUDGET_EXHAUSTED',
  'CANCELLED',
  'UNKNOWN',
];

export type TestdataArtifact =
  | 'statement'
  | 'spec'
  | 'generator'
  | 'stress-generator'
  | 'validator'
  | 'oracle'
  | 'brute'
  | 'template-py'
  | 'template-java'
  | 'template-cc'
  | 'checker'
  | 'coverage'
  | 'mutation'
  | 'pipeline';

export type TestdataRetryPolicy =
  | 'repair-artifact'
  | 'rerun-spec'
  | 'adjudicate'
  | 'switch-model'
  | 'manual-review'
  | 'no-retry';

export type TestdataSafeDetail = string | number | boolean | string[];
export type TestdataSafeDetails = Record<string, TestdataSafeDetail>;

export interface TestdataPipelineErrorContext {
  code: TestdataFailureCode;
  stage: string;
  artifact: TestdataArtifact;
  retryPolicy?: TestdataRetryPolicy;
  safeDetails?: TestdataSafeDetails;
  message?: string;
}

const SAFE_DETAIL_STRING_MAX = 128;
const SAFE_DETAIL_ARRAY_MAX = 64;
const SAFE_ENUM_OR_HASH = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_DETAIL_KEYS = new Set([
  'actualBytes',
  'actualCount',
  'candidate',
  'caseIndex',
  'checkerUsed',
  'contentHash',
  'droppedCount',
  'elapsedMs',
  'expectedCount',
  'failureKind',
  'generatedCount',
  'indexes',
  'maxBytes',
  'minimumUnique',
  'sample',
  'status',
  'uniqueCount',
  'validCount',
]);

function copyValidatedSafeDetails(details: TestdataSafeDetails): TestdataSafeDetails {
  const safe: TestdataSafeDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) {
      throw new TypeError(`Unsafe test-data failure detail key: ${key}`);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError(`Unsafe test-data failure detail value: ${key}`);
      safe[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      safe[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      const validContentHash = key !== 'contentHash' || /^[a-f0-9]{16,128}$/i.test(value);
      if (value.length > SAFE_DETAIL_STRING_MAX || !SAFE_ENUM_OR_HASH.test(value) || !validContentHash) {
        throw new TypeError(`Unsafe test-data failure detail value: ${key}`);
      }
      safe[key] = value;
      continue;
    }
    if (Array.isArray(value)
      && value.length <= SAFE_DETAIL_ARRAY_MAX
      && value.every(item => typeof item === 'string'
        && item.length <= SAFE_DETAIL_STRING_MAX
        && SAFE_ENUM_OR_HASH.test(item))) {
      safe[key] = [...value];
      continue;
    }
    throw new TypeError(`Unsafe test-data failure detail value: ${key}`);
  }
  return safe;
}

export class TestdataPipelineError extends Error {
  readonly safeDetails: TestdataSafeDetails;

  constructor(
    message: string,
    readonly code: TestdataFailureCode,
    readonly stage: string,
    readonly artifact: TestdataArtifact,
    readonly retryPolicy: TestdataRetryPolicy,
    safeDetails: TestdataSafeDetails = {},
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TestdataPipelineError';
    this.safeDetails = copyValidatedSafeDetails(safeDetails);
  }
}

export function repairPolicyForFailure(
  error: Pick<TestdataPipelineError, 'code' | 'artifact'>,
): TestdataRetryPolicy {
  switch (error.code) {
    case 'SPEC_CONFLICT':
    case 'SPEC_CONSENSUS_REQUIRED':
    case 'ORACLE_BRUTE_DIVERGENCE':
    case 'TRUSTED_SOLUTIONS_DIVERGED':
      return 'adjudicate';
    case 'SPEC_STATEMENT_TOO_LONG':
    case 'SPEC_STATEMENT_TRUNCATED':
    case 'SPEC_PARSE_FAILED':
    case 'SPEC_EVIDENCE_NOT_FOUND':
      return 'rerun-spec';
    case 'SANDBOX_REQUIRED':
    case 'PIPELINE_BUDGET_EXHAUSTED':
    case 'CANCELLED':
      return 'no-retry';
    case 'SANDBOX_UNAVAILABLE':
    case 'CHECKER_REQUIRED_UNAVAILABLE':
    case 'CHECKER_COMPILE_FAILED':
    case 'CHECKER_RUNTIME_FAILED':
    case 'SUBTASK_CONSTRAINT_VIOLATION':
      return 'manual-review';
    case 'UNKNOWN':
      if (error.artifact === 'spec') return 'rerun-spec';
      return error.artifact === 'pipeline' ? 'switch-model' : 'repair-artifact';
    default:
      return 'repair-artifact';
  }
}

export function toPipelineError(
  error: unknown,
  context: TestdataPipelineErrorContext,
): TestdataPipelineError {
  if (error instanceof TestdataPipelineError) return error;
  const message = context.message
    || (error instanceof Error ? error.message : String(error));
  const policy = context.retryPolicy || repairPolicyForFailure(context);
  return new TestdataPipelineError(
    message,
    context.code,
    context.stage,
    context.artifact,
    policy,
    context.safeDetails,
    error,
  );
}

export function extractTestdataFailureMetadata(
  error: unknown,
): {
  failureCode: TestdataFailureCode;
  stage: string;
  artifact: TestdataArtifact;
  retryPolicy: TestdataRetryPolicy;
  safeDetails: TestdataSafeDetails;
} | undefined {
  if (!(error instanceof TestdataPipelineError)) return undefined;
  return {
    failureCode: error.code,
    stage: error.stage,
    artifact: error.artifact,
    retryPolicy: error.retryPolicy,
    safeDetails: { ...error.safeDetails },
  };
}

export function getUserMessageKeyForFailure(code: TestdataFailureCode): string {
  return `ai_helper_testdata_failure_${code.toLowerCase()}`;
}
