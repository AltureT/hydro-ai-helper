"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataPipelineError = exports.TESTDATA_FAILURE_CODES = void 0;
exports.repairPolicyForFailure = repairPolicyForFailure;
exports.toPipelineError = toPipelineError;
exports.extractTestdataFailureMetadata = extractTestdataFailureMetadata;
exports.getUserMessageKeyForFailure = getUserMessageKeyForFailure;
exports.TESTDATA_FAILURE_CODES = [
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
const SAFE_DETAIL_STRING_MAX = 128;
const SAFE_DETAIL_ARRAY_MAX = 64;
const SAFE_DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,63}$/;
const SAFE_ENUM_OR_HASH = /^[A-Za-z0-9_.:-]{1,128}$/;
const UNSAFE_DETAIL_KEY = /(statement|source|code|input|output|url|uri|api|key|token|secret|password|problemId|userId|recordId|jobId|domainId|endpointId)/i;
function copyValidatedSafeDetails(details) {
    const safe = {};
    for (const [key, value] of Object.entries(details)) {
        if (!SAFE_DETAIL_KEY.test(key)
            || (UNSAFE_DETAIL_KEY.test(key) && key.toLowerCase() !== 'contenthash')) {
            throw new TypeError(`Unsafe test-data failure detail key: ${key}`);
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value))
                throw new TypeError(`Unsafe test-data failure detail value: ${key}`);
            safe[key] = value;
            continue;
        }
        if (typeof value === 'boolean') {
            safe[key] = value;
            continue;
        }
        if (typeof value === 'string') {
            if (value.length > SAFE_DETAIL_STRING_MAX || !SAFE_ENUM_OR_HASH.test(value)) {
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
class TestdataPipelineError extends Error {
    constructor(message, code, stage, artifact, retryPolicy, safeDetails = {}, cause) {
        super(message);
        this.code = code;
        this.stage = stage;
        this.artifact = artifact;
        this.retryPolicy = retryPolicy;
        this.cause = cause;
        this.name = 'TestdataPipelineError';
        this.safeDetails = copyValidatedSafeDetails(safeDetails);
    }
}
exports.TestdataPipelineError = TestdataPipelineError;
function repairPolicyForFailure(error) {
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
            if (error.artifact === 'spec')
                return 'rerun-spec';
            return error.artifact === 'pipeline' ? 'switch-model' : 'repair-artifact';
        default:
            return 'repair-artifact';
    }
}
function toPipelineError(error, context) {
    if (error instanceof TestdataPipelineError)
        return error;
    const message = context.message
        || (error instanceof Error ? error.message : String(error));
    const policy = context.retryPolicy || repairPolicyForFailure(context);
    return new TestdataPipelineError(message, context.code, context.stage, context.artifact, policy, context.safeDetails, error);
}
function extractTestdataFailureMetadata(error) {
    if (!(error instanceof TestdataPipelineError))
        return undefined;
    return {
        failureCode: error.code,
        stage: error.stage,
        artifact: error.artifact,
        retryPolicy: error.retryPolicy,
        safeDetails: { ...error.safeDetails },
    };
}
function getUserMessageKeyForFailure(code) {
    return `ai_helper_testdata_failure_${code.toLowerCase()}`;
}
//# sourceMappingURL=failures.js.map