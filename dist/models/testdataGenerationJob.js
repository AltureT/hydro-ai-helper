"use strict";
/**
 * Persistent test-data generation jobs. Results can contain a full reference
 * solution, so handlers must also enforce creator and problem-edit access.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataGenerationJobModel = exports.TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS = exports.TESTDATA_JOB_LEASE_MS = exports.TESTDATA_JOB_RETENTION_MS = exports.TESTDATA_CHECKPOINT_FIELD_MAX_BYTES = exports.TESTDATA_CHECKPOINT_SCHEMA_VERSION = void 0;
exports.computeTestdataCheckpointHashes = computeTestdataCheckpointHashes;
exports.filterTestdataCheckpointUpdate = filterTestdataCheckpointUpdate;
exports.selectTestdataResumeCheckpoint = selectTestdataResumeCheckpoint;
const node_crypto_1 = require("node:crypto");
const js_yaml_1 = __importDefault(require("js-yaml"));
const ensureObjectId_1 = require("../utils/ensureObjectId");
const pipelineContext_1 = require("../services/testdata/pipelineContext");
var pipelineContext_2 = require("../services/testdata/pipelineContext");
Object.defineProperty(exports, "TESTDATA_CHECKPOINT_SCHEMA_VERSION", { enumerable: true, get: function () { return pipelineContext_2.TESTDATA_CHECKPOINT_SCHEMA_VERSION; } });
const validatorManifest_1 = require("../services/testdata/validatorManifest");
const runTelemetry_1 = require("../services/testdata/runTelemetry");
exports.TESTDATA_CHECKPOINT_FIELD_MAX_BYTES = 256 * 1024;
const CHECKPOINT_DECLARATION_ID_MAX_LENGTH = 64;
const CHECKPOINT_DECLARATION_OPERATION_MAX_LENGTH = 256;
function boundedCheckpointString(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
function checkpointStringArray(value) {
    if (!Array.isArray(value) || value.length > 64)
        return undefined;
    const result = value.filter(item => boundedCheckpointString(item, CHECKPOINT_DECLARATION_ID_MAX_LENGTH));
    return result.length === value.length ? result : undefined;
}
function checkpointProbeRecipe(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const recipe = value;
    if (!boundedCheckpointString(recipe.targetId, CHECKPOINT_DECLARATION_ID_MAX_LENGTH)
        || typeof recipe.constructionKind !== 'string'
        || !validatorManifest_1.VALIDATOR_PROBE_CONSTRUCTION_KINDS.includes(recipe.constructionKind)
        || (recipe.fieldId !== undefined
            && !boundedCheckpointString(recipe.fieldId, CHECKPOINT_DECLARATION_ID_MAX_LENGTH))
        || (recipe.operationName !== undefined
            && !boundedCheckpointString(recipe.operationName, CHECKPOINT_DECLARATION_OPERATION_MAX_LENGTH)))
        return undefined;
    return {
        targetId: recipe.targetId,
        constructionKind: recipe.constructionKind,
        ...(recipe.fieldId === undefined ? {} : { fieldId: recipe.fieldId }),
        ...(recipe.operationName === undefined
            ? {}
            : { operationName: recipe.operationName }),
    };
}
/** Persist only declarations needed to deterministically rebuild verifier probes. */
function checkpointVerifierDeclaration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const verifier = value;
    if (typeof verifier.bruteCode !== 'string'
        || typeof verifier.validatorCode !== 'string'
        || typeof verifier.stressGeneratorCode !== 'string')
        return undefined;
    let functionSampleInputs;
    if (verifier.functionSampleInputs !== undefined) {
        if (!Array.isArray(verifier.functionSampleInputs)
            || verifier.functionSampleInputs.length > 64)
            return undefined;
        functionSampleInputs = verifier.functionSampleInputs.flatMap(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                return [];
            const sample = value;
            if (!boundedCheckpointString(sample.id, CHECKPOINT_DECLARATION_ID_MAX_LENGTH)
                || typeof sample.input !== 'string')
                return [];
            return [{ id: sample.id, input: sample.input }];
        });
        if (functionSampleInputs.length !== verifier.functionSampleInputs.length)
            return undefined;
    }
    let validatorManifest;
    if (verifier.validatorManifest !== undefined) {
        if (!verifier.validatorManifest || typeof verifier.validatorManifest !== 'object'
            || Array.isArray(verifier.validatorManifest))
            return undefined;
        const manifest = verifier.validatorManifest;
        const constraintIds = checkpointStringArray(manifest.constraintIds);
        const invariantIds = checkpointStringArray(manifest.invariantIds);
        if (!constraintIds || !invariantIds)
            return undefined;
        validatorManifest = { constraintIds, invariantIds };
    }
    let validatorProbeRecipes;
    if (verifier.validatorProbeRecipes !== undefined) {
        if (!Array.isArray(verifier.validatorProbeRecipes)
            || verifier.validatorProbeRecipes.length > 64)
            return undefined;
        validatorProbeRecipes = verifier.validatorProbeRecipes.flatMap(recipe => {
            const projected = checkpointProbeRecipe(recipe);
            return projected ? [projected] : [];
        });
        if (validatorProbeRecipes.length !== verifier.validatorProbeRecipes.length)
            return undefined;
    }
    return {
        bruteCode: verifier.bruteCode,
        validatorCode: verifier.validatorCode,
        stressGeneratorCode: verifier.stressGeneratorCode,
        ...(verifier.complexityGap === 'exists' || verifier.complexityGap === 'none'
            ? { complexityGap: verifier.complexityGap }
            : {}),
        ...(functionSampleInputs === undefined ? {} : { functionSampleInputs }),
        ...(verifier.validatorManifestStatus === 'valid'
            || verifier.validatorManifestStatus === 'invalid'
            ? { validatorManifestStatus: verifier.validatorManifestStatus }
            : {}),
        ...(validatorManifest === undefined ? {} : { validatorManifest }),
        ...(validatorProbeRecipes === undefined ? {} : { validatorProbeRecipes }),
    };
}
function normalizeForStableJson(value) {
    if (Array.isArray(value))
        return value.map(item => normalizeForStableJson(item));
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForStableJson(item)]));
}
function sha256(value) {
    return (0, node_crypto_1.createHash)('sha256').update(value, 'utf8').digest('hex');
}
function normalizeCheckpointOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return normalizeForStableJson(options);
    }
    const normalized = { ...options };
    if (Array.isArray(normalized.languages)) {
        normalized.languages = [...new Set(normalized.languages.map(language => String(language)))]
            .sort((left, right) => left.localeCompare(right));
    }
    return normalizeForStableJson(normalized);
}
function normalizeExistingConfig(existingConfig) {
    if (existingConfig === undefined || existingConfig.trim() === '')
        return null;
    try {
        return normalizeForStableJson(js_yaml_1.default.load(existingConfig));
    }
    catch {
        // 正常入口会先执行 config 硬校验；纯函数仍为异常输入提供确定性 hash。
        return existingConfig.replace(/\r\n?/g, '\n').trim();
    }
}
function normalizeTextForHash(value) {
    return value.replace(/\r\n?/g, '\n');
}
/** 断点只在完整生成选项与题面均完全一致时可复用。 */
function computeTestdataCheckpointHashes(options, statementMarkdown, context = {}) {
    const checkerArtifacts = context.checkerArtifacts;
    const checkerPresent = checkerArtifacts?.checkerSource !== undefined;
    const checkerHeaders = Object.fromEntries(Object.entries(checkerArtifacts?.checkerHeaders || {})
        .map(([name, content]) => [name, sha256(normalizeTextForHash(content))]));
    return {
        optionsHash: sha256(JSON.stringify(normalizeForStableJson({
            options: normalizeCheckpointOptions(options),
            existingConfig: normalizeExistingConfig(context.existingConfig),
            checker: {
                configured: checkerArtifacts?.configured ?? false,
                read: checkerArtifacts?.read ?? false,
                failureKind: checkerArtifacts?.failureKind ?? null,
                present: checkerPresent,
                contentHash: checkerPresent
                    ? sha256(normalizeTextForHash(checkerArtifacts?.checkerSource))
                    : null,
                headers: checkerHeaders,
            },
        }))),
        statementHash: sha256(normalizeTextForHash(statementMarkdown)),
    };
}
/** MongoDB 单文档安全边界：任一制品过大时同时丢弃它与所有下游制品，禁止混代复用。 */
function filterTestdataCheckpointUpdate(update) {
    const filtered = {
        revision: update.revision,
        ...(update.checkpointSchemaVersion === pipelineContext_1.TESTDATA_CHECKPOINT_SCHEMA_VERSION ? {
            checkpointSchemaVersion: pipelineContext_1.TESTDATA_CHECKPOINT_SCHEMA_VERSION,
            promptVersion: update.promptVersion,
            statementHash: update.statementHash,
            specHash: update.specHash,
            roleDependencies: update.roleDependencies,
        } : {}),
    };
    const keys = [
        'solution',
        'artifacts',
        'verifier',
        'killTargets',
    ];
    for (const key of keys) {
        const value = key === 'verifier'
            ? checkpointVerifierDeclaration(update.verifier)
            : update[key];
        if (value === undefined)
            continue;
        try {
            if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= exports.TESTDATA_CHECKPOINT_FIELD_MAX_BYTES) {
                filtered[key] = value;
            }
            else {
                break;
            }
        }
        catch {
            // 不可序列化与超大制品一样会切断依赖链，避免保留来自旧轮次的下游字段。
            break;
        }
    }
    return filtered;
}
/** 严格校验断点作用域；任一不符都由调用方静默转为全新生成。 */
function selectTestdataResumeCheckpoint(job, expected) {
    if (!job?.checkpoint || job.status !== 'interrupted')
        return undefined;
    const checkpoint = job.checkpoint;
    const isV2 = checkpoint.checkpointSchemaVersion === pipelineContext_1.TESTDATA_CHECKPOINT_SCHEMA_VERSION;
    if (!isV2 && !expected.allowV1)
        return undefined;
    if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1
        || job.domainId !== expected.domainId
        || job.problemDocId !== expected.problemDocId
        || job.problemId !== expected.problemId
        || job.createdBy !== expected.createdBy
        || checkpoint.optionsHash !== expected.optionsHash
        || checkpoint.statementHash !== expected.statementHash) {
        return undefined;
    }
    if (!isV2)
        return checkpoint;
    if ((expected.checkpointSchemaVersion !== undefined
        && expected.checkpointSchemaVersion !== checkpoint.checkpointSchemaVersion)
        || (expected.promptVersion !== undefined && expected.promptVersion !== checkpoint.promptVersion)
        || (expected.specHash !== undefined && expected.specHash !== checkpoint.specHash)
        || typeof checkpoint.promptVersion !== 'string'
        || !/^[a-f0-9]{64}$/.test(checkpoint.specHash || '')
        || Object.values(checkpoint.roleDependencies || {})
            .some(value => !/^[a-f0-9]{64}$/.test(value || ''))) {
        return undefined;
    }
    return checkpoint;
}
exports.TESTDATA_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
exports.TESTDATA_JOB_LEASE_MS = 90 * 1000;
exports.TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS = 10 * 60 * 1000;
function availableTeacherOutcomeClaim(now) {
    return {
        $or: [
            { teacherOutcomeClaim: { $exists: false } },
            { 'teacherOutcomeClaim.leaseExpiresAt': { $lte: now } },
            // Recover pre-lease claims left by an interrupted older process.
            { 'teacherOutcomeClaim.leaseExpiresAt': { $exists: false } },
        ],
    };
}
const interruptedError = {
    message: '生成服务在任务执行期间重启或失去连接，可从已保存的断点恢复。',
    code: 'WORKER_INTERRUPTED',
    retryable: true,
};
class TestdataGenerationJobModel {
    constructor(db) {
        this.collection = db.collection('ai_testdata_generation_jobs');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ domainId: 1, problemDocId: 1, createdBy: 1 }, {
            name: 'idx_testdata_job_one_active',
            unique: true,
            partialFilterExpression: { active: true },
        });
        await this.collection.createIndex({ expiresAt: 1 }, { name: 'idx_testdata_job_expiry', expireAfterSeconds: 0 });
        await this.collection.createIndex({ domainId: 1, problemDocId: 1, createdBy: 1, restorable: 1, createdAt: -1 }, { name: 'idx_testdata_job_restore' });
    }
    scope(params) {
        return {
            domainId: params.domainId,
            problemDocId: params.problemDocId,
            createdBy: params.createdBy,
        };
    }
    async createOrGetActive(params) {
        const scope = this.scope(params);
        const now = new Date();
        await this.collection.updateMany({ ...scope, active: true, leaseExpiresAt: { $lte: now } }, {
            $set: {
                status: 'interrupted', active: false, restorable: true,
                updatedAt: now, completedAt: now, error: interruptedError,
            },
        });
        const active = await this.collection.findOne({ ...scope, active: true });
        if (active)
            return { job: active, created: false };
        await this.collection.updateMany({ ...scope, active: false, restorable: true }, { $set: { restorable: false, updatedAt: now } });
        const doc = {
            ...params,
            runId: (0, runTelemetry_1.createTestdataRunId)(),
            applyFailureEventId: (0, runTelemetry_1.createTestdataEventId)(),
            status: 'pending',
            active: true,
            restorable: true,
            cancelRequested: false,
            progress: { stage: 'preparing', percent: 2, attempt: 1 },
            createdAt: now,
            startedAt: null,
            updatedAt: now,
            progressUpdatedAt: now,
            completedAt: null,
            leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS),
            expiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_RETENTION_MS),
        };
        try {
            const result = await this.collection.insertOne(doc);
            return { job: { ...doc, _id: result.insertedId }, created: true };
        }
        catch (err) {
            if (err?.code !== 11000)
                throw err;
            const concurrent = await this.collection.findOne({ ...scope, active: true });
            if (!concurrent)
                throw err;
            return { job: concurrent, created: false };
        }
    }
    async findById(id) {
        return this.collection.findOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id) });
    }
    async findRestorable(domainId, problemDocId, createdBy) {
        return this.collection.findOne({ domainId, problemDocId, createdBy, restorable: true }, { sort: { createdAt: -1 } });
    }
    async markRunning(id) {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), status: 'pending', active: true }, { $set: {
                status: 'running', startedAt: now, updatedAt: now,
                leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS),
            } });
    }
    async updateProgress(id, progress) {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true }, { $set: {
                progress, progressUpdatedAt: now, updatedAt: now,
                leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS),
            } });
    }
    async updateCheckpoint(id, hashes, update) {
        const filtered = filterTestdataCheckpointUpdate(update);
        const now = new Date();
        const checkpoint = { ...hashes, ...filtered };
        await this.collection.updateOne({
            _id: (0, ensureObjectId_1.ensureObjectId)(id),
            active: true,
            $or: [
                { 'checkpoint.revision': { $lt: update.revision } },
                { 'checkpoint.revision': { $exists: false } },
            ],
        }, { $set: { checkpoint, updatedAt: now } });
    }
    async renewLease(id) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true, cancelRequested: false }, { $set: {
                updatedAt: now,
                leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS),
                // 活跃任务采用滑动保留期，避免长推理在固定 24 小时 TTL 到点时被误删。
                expiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_RETENTION_MS),
            } });
        return result.modifiedCount > 0;
    }
    async complete(id, plan) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true, cancelRequested: false }, { $set: {
                status: 'completed', active: false, restorable: true,
                progress: {
                    stage: 'complete', percent: 100,
                    attempt: plan.verification?.modelEscalation ? 2 : 1,
                },
                progressUpdatedAt: now, plan, updatedAt: now, completedAt: now,
            } });
        return result.modifiedCount > 0;
    }
    async fail(id, error, status = 'failed') {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true }, { $set: {
                status, active: false, restorable: status === 'interrupted', error,
                updatedAt: now, completedAt: now,
            } });
    }
    async cancel(id, error) {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), status: { $in: ['pending', 'running'] } }, { $set: {
                status: 'canceled', active: false, restorable: false,
                cancelRequested: true, updatedAt: now, completedAt: now,
                ...(error ? { error } : {}),
            } });
    }
    async dismiss(id) {
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: false }, { $set: { restorable: false, updatedAt: new Date() } });
    }
    async claimTeacherOutcome(id, claimId) {
        const now = new Date();
        const result = await this.collection.updateOne({
            _id: (0, ensureObjectId_1.ensureObjectId)(id),
            status: 'completed',
            teacherOutcome: { $exists: false },
            appliedAt: { $exists: false },
            ...availableTeacherOutcomeClaim(now),
        }, { $set: {
                teacherOutcomeClaim: {
                    claimId,
                    claimedAt: now,
                    leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS),
                },
                updatedAt: now,
            } });
        return result.modifiedCount > 0;
    }
    async releaseTeacherOutcomeClaim(id, claimId) {
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), 'teacherOutcomeClaim.claimId': claimId }, { $unset: { teacherOutcomeClaim: '' }, $set: { updatedAt: new Date() } });
    }
    async renewTeacherOutcomeClaim(id, claimId) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), 'teacherOutcomeClaim.claimId': claimId }, { $set: {
                'teacherOutcomeClaim.claimedAt': now,
                'teacherOutcomeClaim.leaseExpiresAt': new Date(now.getTime() + exports.TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS),
                updatedAt: now,
            } });
        return result.matchedCount > 0;
    }
    async getOrCreateApplyFailureEvent(id, preferredEventId) {
        const eventId = preferredEventId || (0, runTelemetry_1.createTestdataEventId)();
        const occurredAt = new Date();
        const objectId = (0, ensureObjectId_1.ensureObjectId)(id);
        const result = await this.collection.updateOne({ _id: objectId, applyFailureOccurredAt: { $exists: false } }, { $set: { applyFailureEventId: eventId, applyFailureOccurredAt: occurredAt } });
        if (result.modifiedCount > 0)
            return { eventId, occurredAt };
        const existing = await this.collection.findOne({ _id: objectId }, { projection: { applyFailureEventId: 1, applyFailureOccurredAt: 1 } });
        return typeof existing?.applyFailureEventId === 'string'
            && existing.applyFailureOccurredAt instanceof Date
            ? { eventId: existing.applyFailureEventId, occurredAt: existing.applyFailureOccurredAt }
            : null;
    }
    async markApplied(id, claimId) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), 'teacherOutcomeClaim.claimId': claimId }, {
            $set: { appliedAt: now, restorable: false, updatedAt: now },
            $unset: { teacherOutcomeClaim: '' },
        });
        return result.modifiedCount > 0;
    }
    async recordTeacherOutcome(id, input, claimId) {
        const now = new Date();
        const record = {
            eventId: input.eventId,
            outcome: input.outcome,
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.editedFileCount !== undefined ? { editedFileCount: input.editedFileCount } : {}),
            ...(input.changedFileKinds ? { changedFileKinds: [...input.changedFileKinds] } : {}),
            recordedAt: now,
        };
        const objectId = (0, ensureObjectId_1.ensureObjectId)(id);
        const result = await this.collection.updateOne({
            _id: objectId,
            status: 'completed',
            teacherOutcome: { $exists: false },
            appliedAt: { $exists: false },
            ...(claimId
                ? { 'teacherOutcomeClaim.claimId': claimId }
                : availableTeacherOutcomeClaim(now)),
        }, {
            $set: { teacherOutcome: record, restorable: false, updatedAt: now },
            ...(!claimId ? { $unset: { teacherOutcomeClaim: '' } } : {}),
        });
        if (result.modifiedCount > 0)
            return { state: 'recorded', record };
        const existing = await this.collection.findOne({ _id: objectId }, { projection: { teacherOutcome: 1 } });
        const stored = existing?.teacherOutcome;
        if (!stored)
            return { state: 'conflict', record };
        const duplicate = stored.outcome === input.outcome
            && stored.reason === input.reason
            && stored.editedFileCount === input.editedFileCount
            && JSON.stringify(stored.changedFileKinds || []) === JSON.stringify(input.changedFileKinds || []);
        return { state: duplicate ? 'duplicate' : 'conflict', record: stored };
    }
    async markExpiredLeaseInterrupted(id) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true, leaseExpiresAt: { $lte: now } }, { $set: {
                status: 'interrupted', active: false, restorable: true,
                updatedAt: now, completedAt: now, error: interruptedError,
            } });
        return result.modifiedCount > 0;
    }
    async markAllExpiredLeasesInterrupted() {
        const now = new Date();
        const result = await this.collection.updateMany({ active: true, leaseExpiresAt: { $lte: now } }, { $set: {
                status: 'interrupted', active: false, restorable: true,
                updatedAt: now, completedAt: now, error: interruptedError,
            } });
        return result.modifiedCount;
    }
}
exports.TestdataGenerationJobModel = TestdataGenerationJobModel;
//# sourceMappingURL=testdataGenerationJob.js.map