"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNCERTAINTY_MAX_COUNT = void 0;
exports.parseProblemSpecV1 = parseProblemSpecV1;
exports.validateProblemSpecV1 = validateProblemSpecV1;
exports.locateStatementEvidence = locateStatementEvidence;
exports.validateProblemSpecEvidence = validateProblemSpecEvidence;
exports.summarizeProblemSpec = summarizeProblemSpec;
const failures_1 = require("./failures");
const PROBLEM_SPEC_JSON_MAX_LENGTH = 512 * 1024;
const ID_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 256;
const TEXT_MAX_LENGTH = 4096;
const DESCRIPTION_MAX_LENGTH = 2048;
const EVIDENCE_SECTION_MAX_LENGTH = 256;
const INPUT_FIELD_MAX_COUNT = 128;
const CONSTRAINT_MAX_COUNT = 512;
const INVARIANT_MAX_COUNT = 256;
const OPERATION_MAX_COUNT = 128;
const SUBTASK_MAX_COUNT = 100;
exports.UNCERTAINTY_MAX_COUNT = 100;
const STRING_ARRAY_MAX_COUNT = 128;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROBLEM_KINDS = new Set(['traditional', 'function']);
const INPUT_FIELD_TYPES = new Set([
    'integer', 'number', 'string', 'array', 'matrix', 'permutation', 'tree',
    'graph', 'operations', 'custom',
]);
const INVARIANT_KINDS = new Set([
    'unique', 'sorted', 'permutation', 'tree', 'connected', 'dag',
    'simple-graph', 'stateful-precondition', 'custom',
]);
const OUTPUT_POLICY_KINDS = new Set([
    'exact', 'token', 'float', 'unordered', 'multiple-valid', 'custom-checker',
]);
function parseFailure() {
    return new failures_1.TestdataPipelineError('ProblemSpec v1 JSON 不符合严格契约。', 'SPEC_PARSE_FAILED', 'pipeline', 'spec', 'rerun-spec');
}
function evidenceFailure() {
    return new failures_1.TestdataPipelineError('ProblemSpec evidence 无法在完整规范化题面中唯一定位。', 'SPEC_EVIDENCE_NOT_FOUND', 'pipeline', 'spec', 'rerun-spec');
}
function withParseFailure(action) {
    try {
        return action();
    }
    catch (error) {
        if (error instanceof failures_1.TestdataPipelineError)
            throw error;
        throw parseFailure();
    }
}
function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('object');
    return value;
}
function exactKeys(value, allowed, required = allowed) {
    const allowedSet = new Set(allowed);
    if (Object.keys(value).some(key => !allowedSet.has(key)))
        throw new TypeError('unknown field');
    if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
        throw new TypeError('missing field');
    }
}
function boundedString(value, maxLength, pattern) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new TypeError('string');
    }
    if (pattern && !pattern.test(value))
        throw new TypeError('string format');
    return value;
}
function boundedArray(value, maxCount) {
    if (!Array.isArray(value) || value.length > maxCount)
        throw new TypeError('array');
    return value;
}
function uniqueStrings(value, maxCount = STRING_ARRAY_MAX_COUNT) {
    const items = boundedArray(value, maxCount).map(item => boundedString(item, NAME_MAX_LENGTH));
    if (new Set(items).size !== items.length)
        throw new TypeError('duplicate array item');
    return items;
}
function positiveInteger(value, max) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
        throw new TypeError('positive integer');
    }
    return value;
}
function optionalOffset(value) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError('offset');
    }
}
function validateEvidenceShape(value, allowOffsets) {
    const evidence = asObject(value);
    const allowed = allowOffsets
        ? ['quote', 'section', 'startOffset', 'endOffset']
        : ['quote', 'section'];
    exactKeys(evidence, allowed, ['quote']);
    boundedString(evidence.quote, TEXT_MAX_LENGTH);
    if (evidence.section !== undefined)
        boundedString(evidence.section, EVIDENCE_SECTION_MAX_LENGTH);
    if (allowOffsets) {
        optionalOffset(evidence.startOffset);
        optionalOffset(evidence.endOffset);
    }
}
function validateShape(value) {
    const spec = asObject(value);
    exactKeys(spec, [
        'schemaVersion', 'statementHash', 'problemKind', 'testCaseMode', 'inputFields',
        'constraints', 'invariants', 'outputPolicy', 'operations', 'subtasks', 'uncertainties',
    ], [
        'schemaVersion', 'statementHash', 'problemKind', 'testCaseMode', 'inputFields',
        'constraints', 'invariants', 'outputPolicy', 'subtasks', 'uncertainties',
    ]);
    if (spec.schemaVersion !== 1)
        throw new TypeError('schemaVersion');
    boundedString(spec.statementHash, 64, HASH_PATTERN);
    if (typeof spec.problemKind !== 'string' || !PROBLEM_KINDS.has(spec.problemKind)) {
        throw new TypeError('problemKind');
    }
    const testCaseMode = asObject(spec.testCaseMode);
    if (testCaseMode.kind === 'single') {
        exactKeys(testCaseMode, ['kind']);
    }
    else if (testCaseMode.kind === 'counted') {
        exactKeys(testCaseMode, ['kind', 'countField']);
        boundedString(testCaseMode.countField, ID_MAX_LENGTH, ID_PATTERN);
    }
    else {
        throw new TypeError('testCaseMode');
    }
    for (const rawField of boundedArray(spec.inputFields, INPUT_FIELD_MAX_COUNT)) {
        const field = asObject(rawField);
        exactKeys(field, ['id', 'name', 'type', 'encoding', 'dependsOn'], ['id', 'name', 'type', 'encoding']);
        boundedString(field.id, ID_MAX_LENGTH, ID_PATTERN);
        boundedString(field.name, NAME_MAX_LENGTH);
        if (typeof field.type !== 'string' || !INPUT_FIELD_TYPES.has(field.type))
            throw new TypeError('field type');
        boundedString(field.encoding, TEXT_MAX_LENGTH);
        if (field.dependsOn !== undefined)
            uniqueStrings(field.dependsOn);
    }
    for (const rawConstraint of boundedArray(spec.constraints, CONSTRAINT_MAX_COUNT)) {
        const constraint = asObject(rawConstraint);
        exactKeys(constraint, ['id', 'expression', 'machineCheckable', 'scope', 'evidence']);
        boundedString(constraint.id, ID_MAX_LENGTH, ID_PATTERN);
        boundedString(constraint.expression, TEXT_MAX_LENGTH);
        if (typeof constraint.machineCheckable !== 'boolean')
            throw new TypeError('machineCheckable');
        if (constraint.scope !== 'global') {
            const scope = asObject(constraint.scope);
            exactKeys(scope, ['subtaskId']);
            positiveInteger(scope.subtaskId, SUBTASK_MAX_COUNT);
        }
        validateEvidenceShape(constraint.evidence, true);
    }
    for (const rawInvariant of boundedArray(spec.invariants, INVARIANT_MAX_COUNT)) {
        const invariant = asObject(rawInvariant);
        exactKeys(invariant, ['id', 'kind', 'expression', 'machineCheckable', 'evidence']);
        boundedString(invariant.id, ID_MAX_LENGTH, ID_PATTERN);
        if (typeof invariant.kind !== 'string' || !INVARIANT_KINDS.has(invariant.kind)) {
            throw new TypeError('invariant kind');
        }
        boundedString(invariant.expression, TEXT_MAX_LENGTH);
        if (typeof invariant.machineCheckable !== 'boolean')
            throw new TypeError('machineCheckable');
        validateEvidenceShape(invariant.evidence, false);
    }
    const outputPolicy = asObject(spec.outputPolicy);
    exactKeys(outputPolicy, ['kind', 'tolerance', 'caseSensitive'], ['kind']);
    if (typeof outputPolicy.kind !== 'string' || !OUTPUT_POLICY_KINDS.has(outputPolicy.kind)) {
        throw new TypeError('output policy');
    }
    if (outputPolicy.tolerance !== undefined
        && (typeof outputPolicy.tolerance !== 'number'
            || !Number.isFinite(outputPolicy.tolerance)
            || outputPolicy.tolerance <= 0
            || outputPolicy.tolerance > 1)) {
        throw new TypeError('tolerance');
    }
    if (outputPolicy.kind === 'float' && outputPolicy.tolerance === undefined) {
        throw new TypeError('float tolerance');
    }
    if (outputPolicy.caseSensitive !== undefined && typeof outputPolicy.caseSensitive !== 'boolean') {
        throw new TypeError('caseSensitive');
    }
    if (spec.operations !== undefined) {
        for (const rawOperation of boundedArray(spec.operations, OPERATION_MAX_COUNT)) {
            const operation = asObject(rawOperation);
            exactKeys(operation, ['name', 'arguments', 'preconditions', 'effects']);
            boundedString(operation.name, NAME_MAX_LENGTH);
            uniqueStrings(operation.arguments);
            uniqueStrings(operation.preconditions);
            uniqueStrings(operation.effects);
        }
    }
    for (const rawSubtask of boundedArray(spec.subtasks, SUBTASK_MAX_COUNT)) {
        const subtask = asObject(rawSubtask);
        exactKeys(subtask, ['id', 'score', 'constraintIds']);
        positiveInteger(subtask.id, SUBTASK_MAX_COUNT);
        positiveInteger(subtask.score, 100);
        uniqueStrings(subtask.constraintIds);
    }
    for (const rawUncertainty of boundedArray(spec.uncertainties, exports.UNCERTAINTY_MAX_COUNT)) {
        const uncertainty = asObject(rawUncertainty);
        exactKeys(uncertainty, ['code', 'description', 'evidence'], ['code', 'description']);
        boundedString(uncertainty.code, ID_MAX_LENGTH, ID_PATTERN);
        boundedString(uncertainty.description, DESCRIPTION_MAX_LENGTH);
        if (uncertainty.evidence !== undefined)
            boundedString(uncertainty.evidence, TEXT_MAX_LENGTH);
    }
}
function assertUnique(values) {
    if (new Set(values).size !== values.length)
        throw new TypeError('duplicate id');
}
function validateReferences(spec) {
    const fieldIds = spec.inputFields.map(field => field.id);
    const constraintIds = spec.constraints.map(constraint => constraint.id);
    const invariantIds = spec.invariants.map(invariant => invariant.id);
    assertUnique(fieldIds);
    assertUnique(constraintIds);
    assertUnique(invariantIds);
    assertUnique([...fieldIds, ...constraintIds, ...invariantIds]);
    assertUnique(spec.uncertainties.map(uncertainty => uncertainty.code));
    const fieldIdSet = new Set(fieldIds);
    for (const field of spec.inputFields) {
        if (field.dependsOn?.some(id => id === field.id || !fieldIdSet.has(id))) {
            throw new TypeError('dependsOn');
        }
    }
    if (spec.testCaseMode.kind === 'counted') {
        const countFieldId = spec.testCaseMode.countField;
        const countField = spec.inputFields.find(field => field.id === countFieldId);
        if (!countField || countField.type !== 'integer')
            throw new TypeError('countField');
    }
    const subtaskIds = spec.subtasks.map(subtask => subtask.id);
    if (new Set(subtaskIds).size !== subtaskIds.length)
        throw new TypeError('duplicate subtask');
    if (spec.subtasks.length > 0
        && spec.subtasks.reduce((total, subtask) => total + subtask.score, 0) !== 100) {
        throw new TypeError('subtask score total');
    }
    const subtaskIdSet = new Set(subtaskIds);
    const constraintIdSet = new Set(constraintIds);
    for (const subtask of spec.subtasks) {
        if (subtask.constraintIds.some(id => !constraintIdSet.has(id))) {
            throw new TypeError('constraint reference');
        }
    }
    for (const constraint of spec.constraints) {
        if (constraint.scope === 'global')
            continue;
        const subtaskId = constraint.scope.subtaskId;
        if (!subtaskIdSet.has(subtaskId))
            throw new TypeError('constraint scope');
        const subtask = spec.subtasks.find(item => item.id === subtaskId);
        if (!subtask?.constraintIds.includes(constraint.id))
            throw new TypeError('subtask scope reference');
    }
}
function parseProblemSpecV1(raw) {
    return withParseFailure(() => {
        if (typeof raw !== 'string' || raw.length === 0 || raw.length > PROBLEM_SPEC_JSON_MAX_LENGTH) {
            throw new TypeError('json length');
        }
        const parsed = JSON.parse(raw);
        validateShape(parsed);
        validateReferences(parsed);
        return parsed;
    });
}
function validateProblemSpecV1(value, options = {}) {
    return withParseFailure(() => {
        validateShape(value);
        validateReferences(value);
        if (options.hasCustomChecker !== undefined) {
            const declaresCustomChecker = value.outputPolicy.kind === 'custom-checker';
            if (declaresCustomChecker !== options.hasCustomChecker)
                throw new TypeError('custom checker mismatch');
        }
        if (options.expectedProblemKind !== undefined
            && value.problemKind !== options.expectedProblemKind) {
            throw new TypeError('problem kind mismatch');
        }
        return value;
    });
}
function allOccurrences(markdown, quote) {
    const offsets = [];
    let cursor = 0;
    while (cursor <= markdown.length - quote.length) {
        const offset = markdown.indexOf(quote, cursor);
        if (offset === -1)
            break;
        offsets.push(offset);
        cursor = offset + 1;
    }
    return offsets;
}
function locateStatementEvidence(snapshot, evidence) {
    if (!evidence.quote.trim())
        throw evidenceFailure();
    let offsets = allOccurrences(snapshot.normalizedMarkdown, evidence.quote);
    if (evidence.section !== undefined) {
        const sections = snapshot.sections.filter(section => section.heading === evidence.section);
        offsets = offsets.filter(offset => sections.some(section => (offset >= section.start && offset + evidence.quote.length <= section.end)));
    }
    if (offsets.length !== 1)
        throw evidenceFailure();
    return { startOffset: offsets[0], endOffset: offsets[0] + evidence.quote.length };
}
function validateProblemSpecEvidence(spec, snapshot) {
    if (spec.statementHash !== snapshot.statementHash)
        throw evidenceFailure();
    const constraints = spec.constraints.map(constraint => ({
        ...constraint,
        evidence: {
            quote: constraint.evidence.quote,
            ...(constraint.evidence.section !== undefined ? { section: constraint.evidence.section } : {}),
            ...locateStatementEvidence(snapshot, constraint.evidence),
        },
    }));
    for (const invariant of spec.invariants)
        locateStatementEvidence(snapshot, invariant.evidence);
    for (const uncertainty of spec.uncertainties) {
        if (uncertainty.evidence !== undefined) {
            locateStatementEvidence(snapshot, { quote: uncertainty.evidence });
        }
    }
    return { ...spec, constraints };
}
function summarizeProblemSpec(spec) {
    return {
        statementHash: spec.statementHash,
        constraintCount: spec.constraints.length,
        invariantCount: spec.invariants.length,
        unresolvedUncertainties: spec.uncertainties.length,
    };
}
//# sourceMappingURL=problemSpec.js.map