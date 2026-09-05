"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TESTDATA_PIPELINE_PROMPT_VERSION = exports.TESTDATA_CHECKPOINT_SCHEMA_VERSION = void 0;
exports.canonicalProblemSpec = canonicalProblemSpec;
exports.computeProblemSpecHash = computeProblemSpecHash;
exports.hashTestdataRoleIdentity = hashTestdataRoleIdentity;
exports.assertProblemSpecUnchanged = assertProblemSpecUnchanged;
exports.createTestdataPipelineContext = createTestdataPipelineContext;
const crypto_1 = require("crypto");
const problemSpec_1 = require("./problemSpec");
const failures_1 = require("./failures");
exports.TESTDATA_CHECKPOINT_SCHEMA_VERSION = 2;
exports.TESTDATA_PIPELINE_PROMPT_VERSION = 'testdata-generation-v7';
function cloneJsonValue(value) {
    if (Array.isArray(value))
        return value.map(item => cloneJsonValue(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .map(([key, item]) => [key, cloneJsonValue(item)]));
    }
    return value;
}
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(item => canonicalize(item));
    if (value && typeof value === 'object') {
        const record = value;
        return Object.fromEntries(Object.keys(record)
            .filter(key => record[key] !== undefined)
            .sort()
            .map(key => [key, canonicalize(record[key])]));
    }
    return value;
}
function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value))
        return value;
    for (const item of Object.values(value))
        deepFreeze(item);
    return Object.freeze(value);
}
function canonicalProblemSpec(spec) {
    return JSON.stringify(canonicalize(spec));
}
function computeProblemSpecHash(spec) {
    return (0, crypto_1.createHash)('sha256').update(canonicalProblemSpec(spec), 'utf8').digest('hex');
}
function hashTestdataRoleIdentity(identity) {
    return (0, crypto_1.createHash)('sha256').update(identity, 'utf8').digest('hex');
}
function canonicalPart(value) {
    return JSON.stringify(canonicalize(value));
}
function referenceContract(spec) {
    return {
        fields: spec.inputFields.map(field => ({ id: field.id, dependsOn: field.dependsOn || [] })),
        constraints: spec.constraints.map(constraint => ({ id: constraint.id, scope: constraint.scope })),
        invariants: spec.invariants.map(invariant => invariant.id),
        subtasks: spec.subtasks.map(subtask => ({
            id: subtask.id,
            constraintIds: subtask.constraintIds,
        })),
    };
}
function assertProblemSpecUnchanged(context, candidate = context.spec) {
    const grounded = (0, problemSpec_1.validateProblemSpecEvidence)((0, problemSpec_1.validateProblemSpecV1)(candidate), context.statement);
    const candidateHash = computeProblemSpecHash(grounded);
    const changed = [
        context.spec.problemKind !== grounded.problemKind ? 'problemKind' : undefined,
        canonicalPart(context.spec.testCaseMode) !== canonicalPart(grounded.testCaseMode)
            ? 'testCaseMode'
            : undefined,
        canonicalPart(context.spec.inputFields.map(field => ({
            id: field.id,
            type: field.type,
            encoding: field.encoding,
            dependsOn: field.dependsOn || [],
        }))) !== canonicalPart(grounded.inputFields.map(field => ({
            id: field.id,
            type: field.type,
            encoding: field.encoding,
            dependsOn: field.dependsOn || [],
        }))) ? 'stdinEncoding' : undefined,
        canonicalPart(context.spec.outputPolicy) !== canonicalPart(grounded.outputPolicy)
            ? 'outputPolicy'
            : undefined,
        canonicalPart(context.spec.subtasks) !== canonicalPart(grounded.subtasks)
            ? 'subtasks'
            : undefined,
        canonicalPart(referenceContract(context.spec)) !== canonicalPart(referenceContract(grounded))
            ? 'references'
            : undefined,
        candidateHash !== context.specHash ? 'specHash' : undefined,
    ].filter(Boolean);
    if (changed.length > 0) {
        throw new failures_1.TestdataPipelineError('局部生成或修复试图改变 frozen ProblemSpec；必须回到 Spec 共识阶段。', 'SPEC_PARSE_FAILED', 'spec_consensus', 'spec', 'rerun-spec');
    }
    return candidateHash;
}
function createTestdataPipelineContext(input) {
    const schemaValidated = (0, problemSpec_1.validateProblemSpecV1)(input.spec, input.specValidation);
    const grounded = (0, problemSpec_1.validateProblemSpecEvidence)(schemaValidated, input.statement);
    const statement = deepFreeze(cloneJsonValue(input.statement));
    const spec = deepFreeze(cloneJsonValue(grounded));
    const risk = deepFreeze(cloneJsonValue(input.risk));
    const roleIdentities = deepFreeze(cloneJsonValue(input.roleIdentities));
    return Object.freeze({
        runId: input.runId,
        promptVersion: input.promptVersion,
        statement,
        spec,
        specHash: computeProblemSpecHash(spec),
        risk,
        roleIdentities,
    });
}
//# sourceMappingURL=pipelineContext.js.map