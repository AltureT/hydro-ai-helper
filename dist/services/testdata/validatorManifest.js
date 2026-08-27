"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VALIDATOR_PROBE_CONSTRUCTION_KINDS = void 0;
exports.requiredValidatorTargetIds = requiredValidatorTargetIds;
exports.parseAndValidateValidatorManifest = parseAndValidateValidatorManifest;
exports.parseAndValidateValidatorProbeRecipes = parseAndValidateValidatorProbeRecipes;
const failures_1 = require("./failures");
exports.VALIDATOR_PROBE_CONSTRUCTION_KINDS = [
    'integer-below-min',
    'integer-above-max',
    'array-length-mismatch',
    'duplicate-element',
    'permutation-duplicate-or-missing',
    'illegal-string-character',
    'graph-self-loop',
    'graph-duplicate-edge',
    'graph-disconnected',
    'tree-missing-edge',
    'tree-cycle',
    'dag-cycle',
    'add-existing-object',
    'delete-missing-object',
    'operation-argument-out-of-range',
    'subtask-upper-bound',
];
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
function uniqueKnownIds(value, knownIds) {
    if (!Array.isArray(value))
        throw new TypeError('array');
    const ids = [];
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== 'string' || item.length === 0 || seen.has(item) || !knownIds.has(item)) {
            throw new TypeError('known unique id');
        }
        seen.add(item);
        ids.push(item);
    }
    return ids.sort();
}
function coverageFailure(requiredConstraintIds, requiredInvariantIds, declaredConstraintIds, declaredInvariantIds) {
    return new failures_1.TestdataPipelineError('VALIDATOR Manifest 缺失、非法或未覆盖全部必需目标。', 'VALIDATOR_CONSTRAINT_COVERAGE_MISSING', 'independent_verifier_parse', 'coverage', 'repair-artifact', {
        expectedCount: requiredConstraintIds.length + requiredInvariantIds.length,
        actualCount: declaredConstraintIds.length + declaredInvariantIds.length,
    });
}
function requiredValidatorTargetIds(spec) {
    return {
        constraintIds: spec.constraints
            .filter(constraint => constraint.machineCheckable === true)
            .map(constraint => constraint.id)
            .sort(),
        invariantIds: spec.invariants
            .filter(invariant => invariant.machineCheckable === true)
            .map(invariant => invariant.id)
            .sort(),
    };
}
function parseAndValidateValidatorManifest(raw, spec) {
    const { constraintIds: requiredConstraintIds, invariantIds: requiredInvariantIds } = requiredValidatorTargetIds(spec);
    let parsed;
    let declaredConstraintIds = [];
    let declaredInvariantIds = [];
    try {
        parsed = JSON.parse(raw);
        const manifest = asObject(parsed);
        exactKeys(manifest, ['constraintIds', 'invariantIds']);
        declaredConstraintIds = Array.isArray(manifest.constraintIds) ? manifest.constraintIds : [];
        declaredInvariantIds = Array.isArray(manifest.invariantIds) ? manifest.invariantIds : [];
        const constraintIds = uniqueKnownIds(manifest.constraintIds, new Set(requiredConstraintIds));
        const invariantIds = uniqueKnownIds(manifest.invariantIds, new Set(requiredInvariantIds));
        const missingConstraintIds = requiredConstraintIds.filter(id => !constraintIds.includes(id));
        const missingInvariantIds = requiredInvariantIds.filter(id => !invariantIds.includes(id));
        if (missingConstraintIds.length || missingInvariantIds.length) {
            throw coverageFailure(requiredConstraintIds, requiredInvariantIds, declaredConstraintIds, declaredInvariantIds);
        }
        return {
            manifest: { constraintIds, invariantIds },
            requiredConstraintIds,
            requiredInvariantIds,
            missingConstraintIds,
            missingInvariantIds,
        };
    }
    catch (error) {
        if (error instanceof failures_1.TestdataPipelineError)
            throw error;
        const manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
        return (() => {
            throw coverageFailure(requiredConstraintIds, requiredInvariantIds, Array.isArray(manifest.constraintIds) ? manifest.constraintIds : [], Array.isArray(manifest.invariantIds) ? manifest.invariantIds : []);
        })();
    }
}
function parseAndValidateValidatorProbeRecipes(raw, spec) {
    const requiredTargets = requiredValidatorTargetIds(spec);
    const knownTargetIds = new Set([
        ...requiredTargets.constraintIds,
        ...requiredTargets.invariantIds,
    ]);
    const knownFieldIds = new Set(spec.inputFields.map(field => field.id));
    const knownOperationNames = new Set((spec.operations || []).map(operation => operation.name));
    let declaredRecipes = [];
    try {
        const root = asObject(JSON.parse(raw));
        exactKeys(root, ['recipes']);
        if (!Array.isArray(root.recipes))
            throw new TypeError('recipes');
        declaredRecipes = root.recipes;
        if (root.recipes.length > 64)
            throw new TypeError('recipes');
        const canonicalRecipes = new Set();
        const recipes = root.recipes.map(value => {
            const recipe = asObject(value);
            exactKeys(recipe, ['targetId', 'constructionKind', 'fieldId', 'operationName'], ['targetId', 'constructionKind']);
            if (typeof recipe.targetId !== 'string' || recipe.targetId.length === 0
                || !knownTargetIds.has(recipe.targetId)) {
                throw new TypeError('targetId');
            }
            if (typeof recipe.constructionKind !== 'string'
                || !exports.VALIDATOR_PROBE_CONSTRUCTION_KINDS.includes(recipe.constructionKind)) {
                throw new TypeError('constructionKind');
            }
            const fieldId = recipe.fieldId;
            let normalizedFieldId;
            if (fieldId !== undefined) {
                if (typeof fieldId !== 'string' || !knownFieldIds.has(fieldId)) {
                    throw new TypeError('fieldId');
                }
                normalizedFieldId = fieldId;
            }
            const operationName = recipe.operationName;
            let normalizedOperationName;
            if (operationName !== undefined) {
                if (typeof operationName !== 'string' || !knownOperationNames.has(operationName)) {
                    throw new TypeError('operationName');
                }
                normalizedOperationName = operationName;
            }
            const normalized = {
                targetId: recipe.targetId,
                constructionKind: recipe.constructionKind,
                ...(normalizedFieldId === undefined ? {} : { fieldId: normalizedFieldId }),
                ...(normalizedOperationName === undefined ? {} : { operationName: normalizedOperationName }),
            };
            const canonical = JSON.stringify({
                targetId: normalized.targetId,
                constructionKind: normalized.constructionKind,
                fieldId: normalized.fieldId,
                operationName: normalized.operationName,
            });
            if (canonicalRecipes.has(canonical))
                throw new TypeError('duplicate recipe');
            canonicalRecipes.add(canonical);
            return normalized;
        });
        return recipes.map(recipe => ({ ...recipe }));
    }
    catch (error) {
        if (error instanceof failures_1.TestdataPipelineError)
            throw error;
        throw coverageFailure(requiredTargets.constraintIds, requiredTargets.invariantIds, declaredRecipes, []);
    }
}
//# sourceMappingURL=validatorManifest.js.map