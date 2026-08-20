"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffProblemSpecs = diffProblemSpecs;
exports.runProblemSpecConsensus = runProblemSpecConsensus;
const util_1 = require("util");
const failures_1 = require("./failures");
const problemSpec_1 = require("./problemSpec");
const problemSpecPrompts_1 = require("./problemSpecPrompts");
const ADJUDICATION_MAX_LENGTH = 768 * 1024;
const RESOLUTION_REASON_MAX_LENGTH = 2048;
const RESOLUTION_EVIDENCE_MAX_LENGTH = 4096;
function text(value) {
    return value.trim().replace(/\s+/g, ' ');
}
function fieldKeys(spec) {
    return new Map(spec.inputFields.map(field => [field.id, text(field.name).toLowerCase()]));
}
function constraintKeys(spec) {
    return new Map(spec.constraints.map(constraint => [constraint.id, text(constraint.expression)]));
}
function subtaskScore(spec, id) {
    return spec.subtasks.find(subtask => subtask.id === id)?.score;
}
function normalizedSpec(spec) {
    const fields = fieldKeys(spec);
    const constraints = constraintKeys(spec);
    const sortObjects = (items) => [...items].sort((left, right) => (JSON.stringify(left).localeCompare(JSON.stringify(right))));
    return {
        problemKind: spec.problemKind,
        testCaseMode: spec.testCaseMode.kind === 'single'
            ? { kind: 'single' }
            : { kind: 'counted', countField: fields.get(spec.testCaseMode.countField) || 'missing' },
        inputFields: sortObjects(spec.inputFields.map(field => ({
            name: text(field.name).toLowerCase(),
            type: field.type,
            encoding: text(field.encoding),
            dependsOn: [...(field.dependsOn || [])]
                .map(id => fields.get(id) || 'missing')
                .sort(),
        }))),
        constraints: sortObjects(spec.constraints.map(constraint => ({
            expression: text(constraint.expression),
            machineCheckable: constraint.machineCheckable,
            scope: constraint.scope === 'global'
                ? 'global'
                : { subtaskScore: subtaskScore(spec, constraint.scope.subtaskId) },
        }))),
        invariants: sortObjects(spec.invariants.map(invariant => ({
            kind: invariant.kind,
            expression: text(invariant.expression),
            machineCheckable: invariant.machineCheckable,
        }))),
        outputPolicy: { ...spec.outputPolicy },
        operations: sortObjects((spec.operations || []).map(operation => ({
            name: text(operation.name),
            arguments: operation.arguments.map(text),
            preconditions: operation.preconditions.map(text).sort(),
            effects: operation.effects.map(text).sort(),
        }))),
        subtasks: sortObjects(spec.subtasks.map(subtask => ({
            score: subtask.score,
            constraints: subtask.constraintIds.map(id => constraints.get(id) || 'missing').sort(),
        }))),
        uncertainties: sortObjects(spec.uncertainties.map(uncertainty => ({
            description: text(uncertainty.description),
            ...(uncertainty.evidence !== undefined ? { evidence: text(uncertainty.evidence) } : {}),
        }))),
    };
}
const DIFF_PATHS = [
    'problemKind', 'testCaseMode', 'inputFields', 'constraints', 'invariants',
    'outputPolicy', 'operations', 'subtasks', 'uncertainties',
];
function diffProblemSpecs(primary, critic) {
    const left = normalizedSpec(primary);
    const right = normalizedSpec(critic);
    return DIFF_PATHS.flatMap(path => (0, util_1.isDeepStrictEqual)(left[path], right[path])
        ? []
        : [{ path, kind: 'value-mismatch', primaryValue: left[path], criticValue: right[path] }]);
}
function isCancellation(error) {
    const candidate = error;
    return !!candidate && (candidate.name === 'AbortError' || candidate.name === 'CanceledError'
        || candidate.code === 'ERR_CANCELED' || candidate.category === 'aborted');
}
function failureCode(error) {
    if (error instanceof failures_1.TestdataPipelineError && error.code === 'SPEC_EVIDENCE_NOT_FOUND') {
        return 'SPEC_EVIDENCE_NOT_FOUND';
    }
    if (error instanceof failures_1.TestdataPipelineError && error.code === 'SPEC_CONSENSUS_REQUIRED') {
        return 'SPEC_CONSENSUS_REQUIRED';
    }
    return 'SPEC_PARSE_FAILED';
}
function validateExtractedSpec(raw, input) {
    const parsed = (0, problemSpec_1.parseProblemSpecV1)(raw);
    const validated = (0, problemSpec_1.validateProblemSpecV1)(parsed, {
        hasCustomChecker: input.hasCustomChecker,
        ...(input.requestedProblemKind === 'auto'
            ? {}
            : { expectedProblemKind: input.requestedProblemKind }),
    });
    return (0, problemSpec_1.validateProblemSpecEvidence)(validated, input.snapshot);
}
function exactKeys(value, allowed) {
    if (Object.keys(value).some(key => !allowed.includes(key))
        || allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
        throw new TypeError('invalid adjudication keys');
    }
}
function parseAdjudication(raw, conflicts, input) {
    try {
        if (!raw || raw.length > ADJUDICATION_MAX_LENGTH)
            throw new TypeError('length');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new TypeError('object');
        const object = parsed;
        exactKeys(object, ['resolvedSpec', 'resolutions']);
        if (!Array.isArray(object.resolutions) || object.resolutions.length > 512)
            throw new TypeError('resolutions');
        const resolutions = object.resolutions.map(rawResolution => {
            if (!rawResolution || typeof rawResolution !== 'object' || Array.isArray(rawResolution)) {
                throw new TypeError('resolution');
            }
            const resolution = rawResolution;
            exactKeys(resolution, ['path', 'selected', 'evidenceQuote', 'reason']);
            if (typeof resolution.path !== 'string' || !resolution.path)
                throw new TypeError('path');
            if (!['A', 'B', 'new'].includes(String(resolution.selected)))
                throw new TypeError('selected');
            if (typeof resolution.evidenceQuote !== 'string' || !resolution.evidenceQuote
                || resolution.evidenceQuote.length > RESOLUTION_EVIDENCE_MAX_LENGTH)
                throw new TypeError('evidence');
            if (typeof resolution.reason !== 'string' || !resolution.reason
                || resolution.reason.length > RESOLUTION_REASON_MAX_LENGTH)
                throw new TypeError('reason');
            return resolution;
        });
        const expectedPaths = conflicts.map(conflict => conflict.path);
        const actualPaths = resolutions.map(resolution => resolution.path);
        if (new Set(actualPaths).size !== actualPaths.length
            || actualPaths.length !== expectedPaths.length
            || actualPaths.some(path => !expectedPaths.includes(path))) {
            throw new failures_1.TestdataPipelineError('裁决结果未覆盖全部题意冲突。', 'SPEC_CONSENSUS_REQUIRED', 'spec_consensus', 'spec', 'manual-review', { conflictCount: expectedPaths.length, resolutionCount: actualPaths.length });
        }
        for (const resolution of resolutions) {
            if (!input.snapshot.normalizedMarkdown.includes(resolution.evidenceQuote)) {
                throw new failures_1.TestdataPipelineError('裁决证据无法在完整题面中定位。', 'SPEC_EVIDENCE_NOT_FOUND', 'spec_consensus', 'spec', 'manual-review');
            }
        }
        const resolvedSpec = validateExtractedSpec(JSON.stringify(object.resolvedSpec), input);
        const normalizedResolved = normalizedSpec(resolvedSpec);
        for (const resolution of resolutions) {
            if (resolution.selected === 'new')
                continue;
            const conflict = conflicts.find(item => item.path === resolution.path);
            const expected = resolution.selected === 'A'
                ? conflict?.primaryValue
                : conflict?.criticValue;
            if (!conflict || !(0, util_1.isDeepStrictEqual)(normalizedResolved[resolution.path], expected)) {
                throw new failures_1.TestdataPipelineError('裁决选择与 resolvedSpec 不一致。', 'SPEC_CONSENSUS_REQUIRED', 'spec_consensus', 'spec', 'manual-review');
            }
        }
        return { resolvedSpec, resolutions };
    }
    catch (error) {
        if (error instanceof failures_1.TestdataPipelineError)
            throw error;
        throw new failures_1.TestdataPipelineError('裁决输出不符合严格契约。', 'SPEC_CONSENSUS_REQUIRED', 'spec_consensus', 'spec', 'manual-review');
    }
}
function buildAdjudicatorPrompts(snapshot, primary, critic, conflicts) {
    return {
        systemPrompt: '你是 OJ 题意裁决器。只输出严格 JSON：resolvedSpec 和 resolutions。不得生成 ORACLE、validator、生成器或代码。每个冲突必须恰好一条 resolution，selected 只能是 A、B、new，evidenceQuote 必须逐字来自题面。',
        userPrompt: [
            '=== COMPLETE STATEMENT ===',
            snapshot.normalizedMarkdown,
            '=== SPEC A ===',
            JSON.stringify(primary),
            '=== SPEC B ===',
            JSON.stringify(critic),
            '=== SERVER CONFLICTS ===',
            JSON.stringify(conflicts),
        ].join('\n'),
    };
}
function safeSummary(status, conflicts, unresolvedConflictCount, rolesUsed, spec) {
    if (!spec)
        return undefined;
    return {
        ...(0, problemSpec_1.summarizeProblemSpec)(spec),
        status,
        conflictCount: conflicts.length,
        unresolvedConflictCount,
        rolesUsed,
    };
}
async function runProblemSpecConsensus(input) {
    const prompt = (0, problemSpecPrompts_1.buildProblemSpecPrompt)(input);
    const extract = async (source) => {
        try {
            const result = await source.client.chat([{ role: 'user', content: prompt.userPrompt }], prompt.systemPrompt, input.callOptions);
            return { result, spec: validateExtractedSpec(result.content, input) };
        }
        catch (error) {
            if (isCancellation(error))
                throw error;
            return { error };
        }
    };
    const [primary, critic] = await Promise.all([extract(input.primary), extract(input.critic)]);
    const results = [primary.result, critic.result].filter(Boolean);
    const rolesUsed = ['specPrimary', 'specCritic'];
    if (!primary.spec || !critic.spec) {
        const error = primary.error || critic.error;
        return {
            status: 'unresolved',
            conflictCount: 0,
            unresolvedConflictCount: 1,
            conflicts: [],
            failureCode: failureCode(error),
            results,
            rolesUsed,
        };
    }
    const conflicts = diffProblemSpecs(primary.spec, critic.spec);
    if (conflicts.length === 0) {
        return {
            status: 'consensus',
            conflictCount: 0,
            unresolvedConflictCount: 0,
            conflicts,
            resolvedSpec: primary.spec,
            results,
            rolesUsed,
            safeSummary: safeSummary('consensus', conflicts, 0, rolesUsed, primary.spec),
        };
    }
    if (!input.adjudicator) {
        return {
            status: 'unresolved',
            conflictCount: conflicts.length,
            unresolvedConflictCount: conflicts.length,
            conflicts,
            failureCode: 'SPEC_CONSENSUS_REQUIRED',
            results,
            rolesUsed,
        };
    }
    const adjudicatorPrompt = buildAdjudicatorPrompts(input.snapshot, primary.spec, critic.spec, conflicts);
    rolesUsed.push('adjudicator');
    let adjudicatorResult;
    try {
        adjudicatorResult = await input.adjudicator.client.chat([{ role: 'user', content: adjudicatorPrompt.userPrompt }], adjudicatorPrompt.systemPrompt, input.callOptions);
        results.push(adjudicatorResult);
        const adjudication = parseAdjudication(adjudicatorResult.content, conflicts, input);
        return {
            status: 'adjudicated',
            conflictCount: conflicts.length,
            unresolvedConflictCount: 0,
            conflicts,
            resolvedSpec: adjudication.resolvedSpec,
            resolutions: adjudication.resolutions,
            results,
            rolesUsed,
            safeSummary: safeSummary('adjudicated', conflicts, 0, rolesUsed, adjudication.resolvedSpec),
        };
    }
    catch (error) {
        if (isCancellation(error))
            throw error;
        return {
            status: 'unresolved',
            conflictCount: conflicts.length,
            unresolvedConflictCount: conflicts.length,
            conflicts,
            failureCode: failureCode(error),
            results,
            rolesUsed,
        };
    }
}
//# sourceMappingURL=specConsensus.js.map