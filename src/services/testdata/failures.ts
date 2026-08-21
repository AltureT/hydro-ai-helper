export type TestdataFailureCode =
  | 'SPEC_STATEMENT_TOO_LONG'
  | 'SPEC_STATEMENT_TRUNCATED'
  | 'SPEC_PARSE_FAILED'
  | 'SPEC_EVIDENCE_NOT_FOUND'
  | 'SPEC_CONFLICT'
  | 'SPEC_CONSENSUS_REQUIRED'
  | 'SANDBOX_REQUIRED'
  | 'DIRECT_FALLBACK_CONFIRMATION_REQUIRED'
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
  'DIRECT_FALLBACK_CONFIRMATION_REQUIRED',
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

export const TESTDATA_FAILURE_STAGES = [
  'accepted-std',
  'accepted_std_verification',
  'artifacts_parse',
  'brute',
  'canceled',
  'checker',
  'config_parse',
  'direct_parse',
  'direct_repair',
  'full',
  'function-samples',
  'generator',
  'independent_verifier_parse',
  'oracle',
  'pipeline',
  'pipeline_repair',
  'provided_cpp_oracle',
  'provided_cpp_oracle_infra',
  'sandbox_budget',
  'sandbox_check',
  'solution_blueprint',
  'solution_verification',
  'spec_consensus',
  'stress-generator',
  'stress_testing',
  'template',
  'template-py',
  'template_missing',
  'unknown',
  'validator',
] as const;

export type TestdataBaseFailureStage = typeof TESTDATA_FAILURE_STAGES[number];
export type TestdataFailureStage =
  | TestdataBaseFailureStage
  | `semantic_fallback:${TestdataBaseFailureStage}`;

const TESTDATA_FAILURE_STAGE_SET = new Set<string>(TESTDATA_FAILURE_STAGES);

/** Keep legacy callers source-compatible while storing only canonical stage values. */
export function normalizeTestdataFailureStage(stage: string): TestdataFailureStage {
  const canonical = stage === 'function_samples'
    ? 'function-samples'
    : stage === 'stress_generator'
      ? 'stress-generator'
      : stage;
  if (TESTDATA_FAILURE_STAGE_SET.has(canonical)) {
    return canonical as TestdataBaseFailureStage;
  }
  const semanticFallbackPrefix = 'semantic_fallback:';
  if (canonical.startsWith(semanticFallbackPrefix)) {
    const nested = normalizeTestdataFailureStage(canonical.slice(semanticFallbackPrefix.length));
    const base: TestdataBaseFailureStage = nested.startsWith(semanticFallbackPrefix)
      ? 'unknown'
      : nested as TestdataBaseFailureStage;
    return `semantic_fallback:${base}`;
  }
  return 'unknown';
}

export type TestdataSafeDetail = string | number | boolean | string[];
export type TestdataSafeDetails = Record<string, TestdataSafeDetail>;

export interface TestdataPipelineErrorContext {
  code: TestdataFailureCode;
  stage: TestdataFailureStage;
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
  'callCount',
  'checkerUsed',
  'contentHash',
  'droppedCount',
  'elapsedMs',
  'expectedCount',
  'failureKind',
  'generatedCount',
  'conflictCount',
  'identityConflictCount',
  'invalidAccepted',
  'invalidRejected',
  'limit',
  'indexes',
  'maxBytes',
  'missingCount',
  'minimumUnique',
  'oracleLanguage',
  'protocolProbe',
  'sample',
  'status',
  'subtaskId',
  'uniqueCount',
  'unresolvedConflictCount',
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
  readonly stage: TestdataFailureStage;

  constructor(
    message: string,
    readonly code: TestdataFailureCode,
    stage: string,
    readonly artifact: TestdataArtifact,
    readonly retryPolicy: TestdataRetryPolicy,
    safeDetails: TestdataSafeDetails = {},
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TestdataPipelineError';
    this.stage = normalizeTestdataFailureStage(stage);
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
    case 'DIRECT_FALLBACK_CONFIRMATION_REQUIRED':
    case 'PIPELINE_BUDGET_EXHAUSTED':
    case 'CANCELLED':
      return 'no-retry';
    case 'SANDBOX_UNAVAILABLE':
    case 'CHECKER_REQUIRED_UNAVAILABLE':
    case 'CHECKER_COMPILE_FAILED':
    case 'CHECKER_RUNTIME_FAILED':
      return 'manual-review';
    case 'SUBTASK_CONSTRAINT_VIOLATION':
      return error.artifact === 'validator' || error.artifact === 'generator'
        ? 'repair-artifact'
        : 'manual-review';
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
  stage: TestdataFailureStage;
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
