"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataRunTelemetrySession = exports.TestdataRunTelemetryService = exports.TESTDATA_TEACHER_OUTCOME_SEQUENCE = exports.TESTDATA_QUALITY_SCHEMA_VERSION = exports.TESTDATA_PROMPT_VERSION = void 0;
exports.parseTestdataQualityEvent = parseTestdataQualityEvent;
exports.createTestdataRunId = createTestdataRunId;
exports.createTestdataEventId = createTestdataEventId;
exports.computeOriginalFileHashes = computeOriginalFileHashes;
exports.getStatementLengthBucket = getStatementLengthBucket;
const crypto_1 = require("crypto");
const telemetryService_1 = require("../telemetryService");
const failures_1 = require("./failures");
exports.TESTDATA_PROMPT_VERSION = 'testdata-generation-v1';
exports.TESTDATA_QUALITY_SCHEMA_VERSION = 1;
exports.TESTDATA_TEACHER_OUTCOME_SEQUENCE = 1000000;
const EVENT_TYPES = new Set([
    'run_started', 'stage_completed', 'stage_failed', 'run_completed', 'teacher_outcome',
]);
const TEACHER_OUTCOMES = new Set([
    'accepted_unchanged', 'accepted_edited', 'discarded', 'regenerated',
]);
const TEACHER_REASONS = new Set([
    'wrong_answer', 'invalid_input', 'weak_coverage', 'template_problem', 'checker_problem', 'other',
]);
const CHANGED_FILE_KINDS = new Set([
    'case-in', 'case-out', 'template', 'compile', 'config', 'std', 'generator', 'brute', 'validator',
]);
const TEMPLATE_LANGUAGES = new Set(['py', 'java', 'cc']);
const TEMPLATE_FAILURE_KINDS = new Set(['compile', 'runtime', 'budget', 'mismatch', 'checker-infra']);
const CHECKER_FAILURE_KINDS = new Set(['unavailable', 'compile', 'infra', 'budget', 'reject']);
const GENERATION_MODES = new Set(['direct', 'sandbox']);
const RELIABILITY_MODES = new Set(['legacy', 'observe', 'enforce']);
const RISK_TIERS = new Set(['low', 'medium', 'high', 'blocked']);
const PROBLEM_KINDS = new Set(['traditional', 'function']);
const STATEMENT_BUCKETS = new Set(['0-4k', '4k-16k', '16k-20k', 'over-20k']);
const ARTIFACTS = new Set([
    'statement', 'spec', 'generator', 'stress-generator', 'validator', 'oracle', 'brute',
    'template-py', 'template-java', 'template-cc', 'checker', 'coverage', 'mutation', 'pipeline',
]);
const RETRY_POLICIES = new Set([
    'repair-artifact', 'rerun-spec', 'adjudicate', 'switch-model', 'manual-review', 'no-retry',
]);
const PROGRESS_STAGES = [
    'preparing', 'sandbox_check', 'blueprint', 'blueprint_repair', 'solution_verification',
    'artifacts', 'templates', 'independent_verifier', 'verifier_repair', 'generating_inputs',
    'validating_inputs', 'running_oracle', 'checking_templates', 'stress_testing',
    'discrimination_testing', 'pipeline_repair', 'model_fallback', 'model_escalation',
    'assembling', 'complete', 'apply', 'semantic_fallback',
];
const QUALITY_STAGES = new Set([...PROGRESS_STAGES, ...failures_1.TESTDATA_FAILURE_STAGES]);
const FAILURE_CODES = new Set(failures_1.TESTDATA_FAILURE_CODES);
const MODEL_ROLES = new Set(['primary', 'fallback']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const EVENT_FIELDS = new Set([
    'schemaVersion', 'eventId', 'runId', 'sequence', 'eventType', 'occurredAt',
    'pluginVersion', 'promptVersion', 'generationMode', 'reliabilityMode', 'riskTier',
    'problemKind', 'hasSubtasks', 'hasCustomChecker', 'hasSamples', 'hasStatefulOperations',
    'statementLengthBucket', 'stage', 'failureCode', 'artifact', 'retryPolicy', 'attempt',
    'durationMs', 'tokenCount', 'pipelineCompleted', 'verified', 'wouldBlock', 'modelEscalated',
    'stressGenerated', 'stressValid', 'stressDroppedInvalid', 'stressUnique', 'stressCompared',
    'stressAgreed', 'templateLanguagesRequested', 'templateLanguagesVerified',
    'templateFailureKinds', 'checkerConfigured', 'checkerRead', 'checkerCompiled',
    'checkerExecuted', 'checkerInfraFailures', 'checkerFailureKind', 'modelRole',
    'modelIdentityHash', 'teacherOutcome', 'teacherOutcomeReason', 'editedFileCount',
    'changedFileKinds',
]);
const BOOLEAN_FIELDS = [
    'hasSubtasks', 'hasCustomChecker', 'hasSamples', 'hasStatefulOperations', 'pipelineCompleted',
    'verified', 'wouldBlock', 'modelEscalated', 'checkerConfigured', 'checkerRead',
    'checkerCompiled', 'checkerExecuted',
];
const NUMBER_LIMITS = {
    sequence: { min: 1, max: exports.TESTDATA_TEACHER_OUTCOME_SEQUENCE },
    attempt: { min: 1, max: 10 },
    durationMs: { min: 0, max: 86400000 },
    tokenCount: { min: 0, max: 100000000 },
    stressGenerated: { min: 0, max: 1000000 },
    stressValid: { min: 0, max: 1000000 },
    stressDroppedInvalid: { min: 0, max: 1000000 },
    stressUnique: { min: 0, max: 1000000 },
    stressCompared: { min: 0, max: 1000000 },
    stressAgreed: { min: 0, max: 1000000 },
    checkerInfraFailures: { min: 0, max: 1000000 },
    editedFileCount: { min: 0, max: 80 },
};
function assertEnum(value, values, field) {
    if (value !== undefined && (typeof value !== 'string' || !values.has(value))) {
        throw new TypeError(`Invalid test-data telemetry field: ${field}`);
    }
}
function assertArray(value, values, field, maxLength) {
    if (value === undefined)
        return;
    if (!Array.isArray(value) || value.length > maxLength
        || new Set(value).size !== value.length
        || value.some(item => typeof item !== 'string' || !values.has(item))) {
        throw new TypeError(`Invalid test-data telemetry field: ${field}`);
    }
}
/** Strict parser shared by production construction and privacy regression tests. */
function parseTestdataQualityEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Invalid test-data telemetry event');
    }
    const candidate = value;
    for (const key of Object.keys(candidate)) {
        if (!EVENT_FIELDS.has(key)) {
            throw new TypeError(`Unknown field in test-data telemetry event: ${key}`);
        }
    }
    if (candidate.schemaVersion !== exports.TESTDATA_QUALITY_SCHEMA_VERSION)
        throw new TypeError('Invalid schemaVersion');
    if (typeof candidate.eventId !== 'string' || !UUID_V4.test(candidate.eventId))
        throw new TypeError('Invalid eventId');
    if (typeof candidate.runId !== 'string' || !UUID_V4.test(candidate.runId))
        throw new TypeError('Invalid runId');
    if (typeof candidate.eventType !== 'string' || !EVENT_TYPES.has(candidate.eventType)) {
        throw new TypeError('Invalid eventType');
    }
    if (typeof candidate.occurredAt !== 'string')
        throw new TypeError('Invalid occurredAt');
    const occurredAt = new Date(candidate.occurredAt);
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== candidate.occurredAt) {
        throw new TypeError('Invalid occurredAt');
    }
    if (typeof candidate.pluginVersion !== 'string' || !VERSION.test(candidate.pluginVersion)) {
        throw new TypeError('Invalid pluginVersion');
    }
    if (candidate.promptVersion !== exports.TESTDATA_PROMPT_VERSION)
        throw new TypeError('Invalid promptVersion');
    for (const [field, limits] of Object.entries(NUMBER_LIMITS)) {
        const number = candidate[field];
        if (number === undefined)
            continue;
        if (typeof number !== 'number' || !Number.isSafeInteger(number)
            || number < limits.min || number > limits.max) {
            throw new TypeError(`Invalid test-data telemetry field: ${field}`);
        }
    }
    for (const field of BOOLEAN_FIELDS) {
        if (candidate[field] !== undefined && typeof candidate[field] !== 'boolean') {
            throw new TypeError(`Invalid test-data telemetry field: ${String(field)}`);
        }
    }
    assertEnum(candidate.generationMode, GENERATION_MODES, 'generationMode');
    assertEnum(candidate.reliabilityMode, RELIABILITY_MODES, 'reliabilityMode');
    assertEnum(candidate.riskTier, RISK_TIERS, 'riskTier');
    assertEnum(candidate.problemKind, PROBLEM_KINDS, 'problemKind');
    assertEnum(candidate.statementLengthBucket, STATEMENT_BUCKETS, 'statementLengthBucket');
    assertEnum(candidate.stage, QUALITY_STAGES, 'stage');
    assertEnum(candidate.failureCode, FAILURE_CODES, 'failureCode');
    assertEnum(candidate.artifact, ARTIFACTS, 'artifact');
    assertEnum(candidate.retryPolicy, RETRY_POLICIES, 'retryPolicy');
    assertEnum(candidate.checkerFailureKind, CHECKER_FAILURE_KINDS, 'checkerFailureKind');
    assertEnum(candidate.modelRole, MODEL_ROLES, 'modelRole');
    assertEnum(candidate.teacherOutcome, TEACHER_OUTCOMES, 'teacherOutcome');
    assertEnum(candidate.teacherOutcomeReason, TEACHER_REASONS, 'teacherOutcomeReason');
    if (candidate.modelIdentityHash !== undefined
        && (typeof candidate.modelIdentityHash !== 'string' || !HASH.test(candidate.modelIdentityHash))) {
        throw new TypeError('Invalid modelIdentityHash');
    }
    assertArray(candidate.templateLanguagesRequested, TEMPLATE_LANGUAGES, 'templateLanguagesRequested', 3);
    assertArray(candidate.templateLanguagesVerified, TEMPLATE_LANGUAGES, 'templateLanguagesVerified', 3);
    assertArray(candidate.templateFailureKinds, TEMPLATE_FAILURE_KINDS, 'templateFailureKinds', 3);
    assertArray(candidate.changedFileKinds, CHANGED_FILE_KINDS, 'changedFileKinds', 9);
    if (candidate.eventType === 'stage_completed' && candidate.stage === undefined) {
        throw new TypeError('stage_completed requires stage');
    }
    if (candidate.eventType === 'stage_failed'
        && [candidate.stage, candidate.failureCode, candidate.artifact, candidate.retryPolicy]
            .some(item => item === undefined)) {
        throw new TypeError('stage_failed requires typed failure fields');
    }
    if (candidate.eventType === 'run_completed'
        && [candidate.pipelineCompleted, candidate.verified, candidate.wouldBlock]
            .some(item => typeof item !== 'boolean')) {
        throw new TypeError('run_completed requires authoritative verification fields');
    }
    if (candidate.eventType === 'run_completed' && candidate.pipelineCompleted === false
        && (candidate.verified === true || candidate.wouldBlock === true)) {
        throw new TypeError('verified/wouldBlock require pipelineCompleted');
    }
    if (candidate.eventType === 'teacher_outcome' && candidate.teacherOutcome === undefined) {
        throw new TypeError('teacher_outcome requires teacherOutcome');
    }
    if (candidate.teacherOutcomeReason !== undefined && candidate.teacherOutcome !== 'discarded') {
        throw new TypeError('Only discarded outcomes accept a reason');
    }
    if ((candidate.editedFileCount !== undefined || candidate.changedFileKinds !== undefined)
        && candidate.teacherOutcome !== 'accepted_edited') {
        throw new TypeError('Edit counts require accepted_edited');
    }
    return { ...candidate };
}
function createTestdataRunId() {
    return (0, crypto_1.randomUUID)();
}
function createTestdataEventId() {
    return (0, crypto_1.randomUUID)();
}
function computeOriginalFileHashes(files) {
    return Object.fromEntries(files.map(file => [
        file.name,
        (0, crypto_1.createHash)('sha256').update(file.content, 'utf8').digest('hex'),
    ]));
}
function getStatementLengthBucket(length) {
    if (length <= 4000)
        return '0-4k';
    if (length <= 16000)
        return '4k-16k';
    if (length <= 20000)
        return '16k-20k';
    return 'over-20k';
}
function qualityStage(stage) {
    if (stage.startsWith('semantic_fallback:'))
        return 'semantic_fallback';
    return QUALITY_STAGES.has(stage) ? stage : 'unknown';
}
function isCancellation(error) {
    const candidate = error;
    return !!candidate && (candidate.name === 'AbortError' || candidate.name === 'CanceledError'
        || candidate.code === 'ERR_CANCELED' || candidate.category === 'aborted');
}
function verifiedTemplateLanguages(plan) {
    const requested = plan.verification?.templateLanguages;
    if (!requested)
        return undefined;
    return requested.filter(language => {
        const check = plan.verification?.templateChecks?.[language];
        return !!check?.compiled && !!check.executed
            && Number.isSafeInteger(check.total) && check.total > 0
            && check.passed === check.total;
    });
}
function templateFailureKinds(plan) {
    const allowed = TEMPLATE_FAILURE_KINDS;
    const values = Object.values(plan.verification?.templateChecks || {})
        .map(check => check?.failureKind)
        .filter((kind) => (typeof kind === 'string' && allowed.has(kind)));
    return [...new Set(values)];
}
function checkerFailureKind(value) {
    return value && CHECKER_FAILURE_KINDS.has(value)
        ? value
        : undefined;
}
class TestdataRunTelemetryService {
    constructor(installProvider, options = {}) {
        this.installProvider = installProvider;
        this.options = options;
        this.now = options.now || Date.now;
        this.eventId = options.eventId || crypto_1.randomUUID;
        this.pluginVersion = options.pluginVersion || '0.0.0';
    }
    createSession(context) {
        return new TestdataRunTelemetrySession(this, context, this.now, this.eventId, this.pluginVersion);
    }
    async emit(rawEvent, model) {
        try {
            const install = await this.installProvider.getInstall();
            if (!install?.telemetryEnabled)
                return false;
            const modelHmacKey = process.env.AI_HELPER_TESTDATA_TELEMETRY_HMAC_KEY
                || install.testdataTelemetryHmacKey;
            const event = parseTestdataQualityEvent({
                ...rawEvent,
                pluginVersion: install.lastVersion,
                ...(model ? { modelRole: model.modelRole } : {}),
                ...(model?.modelIdentity && modelHmacKey ? {
                    modelIdentityHash: (0, crypto_1.createHmac)('sha256', modelHmacKey).update(`${model.modelRole}\0${model.modelIdentity}`, 'utf8').digest('hex'),
                } : {}),
            });
            const payload = { instanceId: install.instanceId, events: [event] };
            if (this.options.send) {
                await this.options.send(payload);
            }
            else {
                const bases = (0, telemetryService_1.getTelemetryBases)(install.preferredTelemetryEndpoint);
                let lastError;
                for (const base of bases) {
                    try {
                        await (0, telemetryService_1.sendToEndpoint)((0, telemetryService_1.buildTelemetryUrl)(base, '/api/testdata-events'), payload, (0, telemetryService_1.getTelemetryToken)());
                        return true;
                    }
                    catch (error) {
                        lastError = error;
                    }
                }
                if (lastError)
                    throw lastError;
            }
            return true;
        }
        catch {
            // Quality telemetry is best-effort and must never change generation/apply behavior.
            return false;
        }
    }
    async emitTeacherOutcome(input) {
        try {
            return await this.emit(parseTestdataQualityEvent({
                schemaVersion: exports.TESTDATA_QUALITY_SCHEMA_VERSION,
                eventId: input.eventId || this.eventId(),
                runId: input.runId,
                sequence: exports.TESTDATA_TEACHER_OUTCOME_SEQUENCE,
                eventType: 'teacher_outcome',
                occurredAt: (input.occurredAt || new Date(this.now())).toISOString(),
                pluginVersion: this.pluginVersion,
                promptVersion: exports.TESTDATA_PROMPT_VERSION,
                teacherOutcome: input.outcome,
                ...(input.reason ? { teacherOutcomeReason: input.reason } : {}),
                ...(input.editedFileCount !== undefined ? { editedFileCount: input.editedFileCount } : {}),
                ...(input.changedFileKinds ? { changedFileKinds: input.changedFileKinds } : {}),
            }));
        }
        catch {
            return false;
        }
    }
    async emitApplyFailure(runId, eventId = this.eventId(), occurredAt = new Date(this.now())) {
        try {
            return await this.emit(parseTestdataQualityEvent({
                schemaVersion: exports.TESTDATA_QUALITY_SCHEMA_VERSION,
                eventId,
                runId,
                sequence: exports.TESTDATA_TEACHER_OUTCOME_SEQUENCE - 1,
                eventType: 'stage_failed',
                occurredAt: occurredAt.toISOString(),
                pluginVersion: this.pluginVersion,
                promptVersion: exports.TESTDATA_PROMPT_VERSION,
                stage: 'apply',
                failureCode: 'UNKNOWN',
                artifact: 'pipeline',
                retryPolicy: 'manual-review',
                attempt: 1,
            }));
        }
        catch {
            return false;
        }
    }
}
exports.TestdataRunTelemetryService = TestdataRunTelemetryService;
class TestdataRunTelemetrySession {
    constructor(service, context, now, eventId, pluginVersion) {
        this.service = service;
        this.context = context;
        this.now = now;
        this.eventId = eventId;
        this.pluginVersion = pluginVersion;
        this.sequence = 0;
        this.terminal = false;
    }
    event(eventType, fields = {}) {
        return parseTestdataQualityEvent({
            schemaVersion: exports.TESTDATA_QUALITY_SCHEMA_VERSION,
            eventId: this.eventId(),
            runId: this.context.runId,
            sequence: ++this.sequence,
            eventType,
            occurredAt: new Date(this.now()).toISOString(),
            pluginVersion: this.pluginVersion,
            promptVersion: exports.TESTDATA_PROMPT_VERSION,
            ...this.context,
            ...fields,
        });
    }
    async start() {
        try {
            return await this.service.emit(this.event('run_started'));
        }
        catch {
            return false;
        }
    }
    async progress(progress, at = this.now()) {
        try {
            const nextStage = qualityStage(progress.stage);
            if (!this.currentStage) {
                this.currentStage = { stage: nextStage, startedAt: at, attempt: progress.attempt };
                return false;
            }
            if (this.currentStage.stage === nextStage && this.currentStage.attempt === progress.attempt) {
                return false;
            }
            const previous = this.currentStage;
            this.currentStage = { stage: nextStage, startedAt: at, attempt: progress.attempt };
            if (previous.stage === 'complete')
                return false;
            return await this.service.emit(this.event('stage_completed', {
                stage: previous.stage,
                attempt: previous.attempt,
                durationMs: Math.max(0, Math.min(86400000, Math.round(at - previous.startedAt))),
            }));
        }
        catch {
            return false;
        }
    }
    async fail(error, model) {
        if (this.terminal)
            return;
        this.terminal = true;
        try {
            const failure = (0, failures_1.extractTestdataFailureMetadata)(error);
            const canceled = isCancellation(error) || failure?.failureCode === 'CANCELLED';
            const terminalModel = canceled ? undefined : {
                modelRole: (this.currentStage?.attempt || 1) > 1 ? 'fallback' : model?.modelRole || 'primary',
                ...(model?.modelIdentity ? { modelIdentity: model.modelIdentity } : {}),
            };
            if (!canceled) {
                await this.service.emit(this.event('stage_failed', {
                    stage: failure
                        ? qualityStage(failure.stage)
                        : this.currentStage?.stage || 'unknown',
                    failureCode: failure?.failureCode || 'UNKNOWN',
                    artifact: failure?.artifact || 'pipeline',
                    retryPolicy: failure?.retryPolicy || 'switch-model',
                    attempt: this.currentStage?.attempt || 1,
                }));
            }
            await this.service.emit(this.event('run_completed', {
                pipelineCompleted: false,
                verified: false,
                wouldBlock: false,
                modelEscalated: (this.currentStage?.attempt || 1) > 1,
            }), terminalModel);
        }
        catch {
            // Event construction is also best-effort for legacy/invalid local state.
        }
    }
    async complete(plan) {
        if (this.terminal)
            return;
        this.terminal = true;
        try {
            const verification = plan.verification;
            const stress = verification?.stressCheck;
            const checker = verification?.checkerCheck;
            const requested = verification?.templateLanguages || this.context.templateLanguagesRequested;
            const failureKinds = templateFailureKinds(plan);
            const modelEscalated = !!verification?.modelEscalation;
            const modelRole = modelEscalated || plan.modelTelemetry?.role === 'fallback'
                ? 'fallback'
                : 'primary';
            const identity = plan.modelTelemetry?.identity;
            await this.service.emit(this.event('run_completed', {
                generationMode: verification?.mode,
                reliabilityMode: plan.reliabilityMode || this.context.reliabilityMode,
                riskTier: plan.risk?.tier || this.context.riskTier,
                problemKind: plan.problemType,
                tokenCount: plan.tokenUsage?.totalTokens,
                pipelineCompleted: true,
                verified: verification?.verified === true,
                wouldBlock: verification?.wouldBlock === true,
                modelEscalated,
                stressGenerated: stress?.generated,
                stressValid: stress?.generated === undefined
                    ? undefined
                    : Math.max(0, stress.generated - (stress.droppedInvalid || 0)),
                stressDroppedInvalid: stress?.droppedInvalid,
                stressUnique: stress?.uniqueInputs,
                stressCompared: stress?.compared,
                stressAgreed: stress?.agreed,
                templateLanguagesRequested: requested,
                templateLanguagesVerified: verifiedTemplateLanguages(plan),
                ...(failureKinds?.length ? { templateFailureKinds: failureKinds } : {}),
                checkerConfigured: checker?.configured ?? this.context.checkerConfigured,
                checkerRead: checker?.read ?? this.context.checkerRead,
                checkerCompiled: checker?.compiled,
                checkerExecuted: checker?.executed,
                checkerInfraFailures: checker?.infraFailures,
                checkerFailureKind: checkerFailureKind(checker?.failureKind),
            }), {
                modelRole,
                ...(identity ? { modelIdentity: identity } : {}),
            });
        }
        catch {
            // Event construction is also best-effort for legacy/invalid local state.
        }
    }
}
exports.TestdataRunTelemetrySession = TestdataRunTelemetrySession;
//# sourceMappingURL=runTelemetry.js.map