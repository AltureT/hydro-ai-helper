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
function halfWidth(value) {
    return [...value].map(character => {
        const code = character.charCodeAt(0);
        if (code === 0x3000)
            return ' ';
        if (code >= 0xFF01 && code <= 0xFF5E)
            return String.fromCharCode(code - 0xFEE0);
        return character;
    }).join('');
}
function canonicalIntegerToken(token) {
    const power = /^(\d+)\^(\d+)$/.exec(token);
    if (power) {
        const exponent = Number(power[2]);
        if (!Number.isSafeInteger(exponent) || exponent > 1000
            || power[1].length * Math.max(1, exponent) > 4096)
            return token;
        return (BigInt(power[1]) ** BigInt(exponent)).toString();
    }
    const numeric = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    if (!numeric)
        return token;
    const whole = numeric[1];
    const fraction = numeric[2] || '';
    const exponent = numeric[3] === undefined ? 0 : Number(numeric[3]);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 4096)
        return token;
    const digits = `${whole}${fraction}`;
    const decimalPosition = whole.length + exponent;
    if (decimalPosition <= 0)
        return /^0+$/.test(digits) ? '0' : token;
    if (decimalPosition < digits.length && !/^0+$/.test(digits.slice(decimalPosition)))
        return token;
    const integer = decimalPosition >= digits.length
        ? `${digits}${'0'.repeat(decimalPosition - digits.length)}`
        : digits.slice(0, decimalPosition);
    return BigInt(integer || '0').toString();
}
function text(value) {
    return halfWidth(value)
        .replace(/≤/g, '<=')
        .replace(/≥/g, '>=')
        .replace(/≠/g, '!=')
        .replace(/(?<![\p{L}\p{N}_.])(?:\d+\^\d+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\p{L}\p{N}_.])/gu, canonicalIntegerToken)
        .trim()
        .replace(/\s+/g, ' ');
}
function signature(value) {
    return JSON.stringify(value);
}
function normalizedUncertainty(uncertainty) {
    return {
        description: text(uncertainty.description),
        ...(uncertainty.evidence !== undefined ? { evidence: text(uncertainty.evidence) } : {}),
    };
}
function mergeUncertainties(primary, critic) {
    const seenDescriptions = new Set();
    const seenCodes = new Set();
    return [...primary.uncertainties, ...critic.uncertainties].filter(uncertainty => {
        const key = signature(normalizedUncertainty(uncertainty));
        if (seenCodes.has(uncertainty.code) || seenDescriptions.has(key))
            return false;
        seenCodes.add(uncertainty.code);
        seenDescriptions.add(key);
        return true;
    }).slice(0, problemSpec_1.UNCERTAINTY_MAX_COUNT);
}
function mergeValidatedSpec(base, primary, critic, input) {
    const merged = { ...base, uncertainties: mergeUncertainties(primary, critic) };
    try {
        return (0, problemSpec_1.validateProblemSpecV1)(merged, {
            hasCustomChecker: input.hasCustomChecker,
            ...(input.requestedProblemKind === 'auto'
                ? {}
                : { expectedProblemKind: input.requestedProblemKind }),
        });
    }
    catch {
        return primary;
    }
}
function normalizedSpec(spec) {
    const sortObjects = (items) => [...items].sort((left, right) => (signature(left).localeCompare(signature(right))));
    // Input order is part of the input encoding, so field references deliberately use
    // their canonical position. Names and model-generated IDs remain non-semantic.
    const fields = new Map(spec.inputFields.map((field, index) => [
        field.id,
        `field:${index}:${signature({ type: field.type, encoding: text(field.encoding) })}`,
    ]));
    // Constraints and subtasks are sets. First derive ID-free constraint bases, then
    // ID-free subtask signatures, and finally scoped constraint signatures. Sorting the
    // final arrays preserves duplicate multiplicity without depending on source order.
    const constraintBases = new Map(spec.constraints.map(constraint => [
        constraint.id,
        signature({
            expression: text(constraint.expression),
            machineCheckable: constraint.machineCheckable,
        }),
    ]));
    const subtaskSignatures = new Map(spec.subtasks.map(subtask => [
        subtask.id,
        signature({
            score: subtask.score,
            constraints: subtask.constraintIds
                .map(id => constraintBases.get(id) || 'missing')
                .sort(),
        }),
    ]));
    const normalizedConstraints = spec.constraints.map(constraint => ({
        expression: text(constraint.expression),
        machineCheckable: constraint.machineCheckable,
        scope: constraint.scope === 'global'
            ? 'global'
            : subtaskSignatures.get(constraint.scope.subtaskId) || 'missing',
    }));
    const constraintSignatures = new Map(spec.constraints.map((constraint, index) => [
        constraint.id,
        signature(normalizedConstraints[index]),
    ]));
    return {
        problemKind: spec.problemKind,
        testCaseMode: spec.testCaseMode.kind === 'single'
            ? { kind: 'single' }
            : { kind: 'counted', countField: fields.get(spec.testCaseMode.countField) || 'missing' },
        inputFields: spec.inputFields.map(field => ({
            type: field.type,
            encoding: text(field.encoding),
            dependsOn: [...(field.dependsOn || [])]
                .map(id => fields.get(id) || 'missing')
                .sort(),
        })),
        constraints: sortObjects(normalizedConstraints),
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
            constraints: subtask.constraintIds
                .map(id => constraintSignatures.get(id) || 'missing')
                .sort(),
        }))),
        uncertainties: sortObjects(spec.uncertainties.map(normalizedUncertainty)),
    };
}
const WHOLE_DIFF_PATHS = [
    'problemKind', 'testCaseMode', 'inputFields', 'outputPolicy', 'operations', 'subtasks',
];
function overlappingItemSignature(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return signature(item);
    const object = item;
    if (typeof object.expression !== 'string')
        return signature(item);
    return signature({
        ...object,
        expression: object.expression.replace(/(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\p{L}\p{N}_.])/gu, '#').replace(/\s*(<=|>=|!=|==|<|>)\s*/g, '$1'),
    });
}
function wholeConflict(path, left, right) {
    return (0, util_1.isDeepStrictEqual)(left[path], right[path])
        ? []
        : [{
                path,
                kind: 'value-mismatch',
                primaryValue: left[path],
                criticValue: right[path],
            }];
}
function itemConflicts(path, primaryItems, criticItems) {
    const primaryBySignature = new Map();
    const criticBySignature = new Map();
    const add = (target, item) => {
        const key = signature(item);
        target.set(key, [...(target.get(key) || []), item]);
    };
    primaryItems.forEach(item => add(primaryBySignature, item));
    criticItems.forEach(item => add(criticBySignature, item));
    const unmatchedPrimary = [];
    const unmatchedCritic = [];
    const keys = [...new Set([...primaryBySignature.keys(), ...criticBySignature.keys()])].sort();
    for (const key of keys) {
        const primary = primaryBySignature.get(key) || [];
        const critic = criticBySignature.get(key) || [];
        const paired = Math.min(primary.length, critic.length);
        unmatchedPrimary.push(...primary.slice(paired));
        unmatchedCritic.push(...critic.slice(paired));
    }
    const primaryByOverlap = new Map();
    const criticByOverlap = new Map();
    const addOverlap = (target, item) => {
        const key = overlappingItemSignature(item);
        target.set(key, [...(target.get(key) || []), item]);
    };
    unmatchedPrimary.forEach(item => addOverlap(primaryByOverlap, item));
    unmatchedCritic.forEach(item => addOverlap(criticByOverlap, item));
    const unpaired = [];
    const overlapKeys = [
        ...new Set([...primaryByOverlap.keys(), ...criticByOverlap.keys()]),
    ].sort();
    for (const key of overlapKeys) {
        const primary = primaryByOverlap.get(key) || [];
        const critic = criticByOverlap.get(key) || [];
        const paired = Math.min(primary.length, critic.length);
        for (let index = 0; index < paired; index += 1) {
            unpaired.push({ primaryValue: primary[index], criticValue: critic[index] });
        }
        primary.slice(paired).forEach(item => unpaired.push({ primaryValue: item, criticValue: null }));
        critic.slice(paired).forEach(item => unpaired.push({ primaryValue: null, criticValue: item }));
    }
    return unpaired.map((item, index) => ({
        path: `${path}[${index}]`,
        kind: 'value-mismatch',
        ...item,
    }));
}
function diffProblemSpecs(primary, critic) {
    const left = normalizedSpec(primary);
    const right = normalizedSpec(critic);
    return [
        ...['problemKind', 'testCaseMode', 'inputFields']
            .flatMap(path => wholeConflict(path, left, right)),
        ...itemConflicts('constraints', left.constraints, right.constraints),
        ...itemConflicts('invariants', left.invariants, right.invariants),
        ...['outputPolicy', 'operations', 'subtasks']
            .flatMap(path => wholeConflict(path, left, right)),
    ];
}
function isCancellation(error) {
    const candidate = error;
    return !!candidate && (candidate.name === 'AbortError' || candidate.name === 'CanceledError'
        || candidate.code === 'ERR_CANCELED' || candidate.category === 'aborted');
}
function isModelCallBudgetExhausted(error) {
    return error instanceof failures_1.TestdataPipelineError && error.code === 'PIPELINE_BUDGET_EXHAUSTED';
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
function throwInvalidAdjudication(message) {
    throw new failures_1.TestdataPipelineError(message, 'SPEC_CONSENSUS_REQUIRED', 'spec_consensus', 'spec', 'manual-review');
}
function commonItems(primary, critic) {
    const criticCounts = new Map();
    critic.forEach(item => {
        const key = signature(item);
        criticCounts.set(key, (criticCounts.get(key) || 0) + 1);
    });
    return primary.filter(item => {
        const key = signature(item);
        const count = criticCounts.get(key) || 0;
        if (count === 0)
            return false;
        criticCounts.set(key, count - 1);
        return true;
    });
}
function verifyResolvedItems(path, primary, critic, resolved, conflicts, resolutions) {
    const itemPathPattern = new RegExp(`^${path}\\[\\d+\\]$`);
    const pathConflicts = conflicts.filter(conflict => itemPathPattern.test(conflict.path));
    const expected = commonItems(primary, critic);
    let newItemCount = 0;
    for (const resolution of resolutions.filter(item => itemPathPattern.test(item.path))) {
        const conflict = pathConflicts.find(item => item.path === resolution.path);
        if (!conflict)
            throwInvalidAdjudication('裁决引用了未知冲突条目。');
        if (resolution.selected === 'new') {
            newItemCount += 1;
            continue;
        }
        const selected = resolution.selected === 'A'
            ? conflict.primaryValue
            : conflict.criticValue;
        if (selected !== null)
            expected.push(selected);
    }
    const remaining = [...resolved];
    for (const item of expected) {
        const key = signature(item);
        const index = remaining.findIndex(candidate => signature(candidate) === key);
        if (index < 0)
            throwInvalidAdjudication('裁决结果修改或删除了已达成共识的条目。');
        remaining.splice(index, 1);
    }
    if (remaining.length !== newItemCount) {
        throwInvalidAdjudication('裁决结果包含未声明的新增条目。');
    }
    const knownConflictValues = new Set(pathConflicts.flatMap(conflict => ([conflict.primaryValue, conflict.criticValue]
        .filter(value => value !== null)
        .map(signature))));
    if (remaining.some(item => knownConflictValues.has(signature(item)))) {
        throwInvalidAdjudication('裁决把既有条目错误标记为 new。');
    }
}
function parseAdjudication(raw, conflicts, primary, critic, input) {
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
            (0, problemSpec_1.locateStatementEvidence)(input.snapshot, { quote: resolution.evidenceQuote });
        }
        const modelResolvedSpec = validateExtractedSpec(JSON.stringify(object.resolvedSpec), input);
        const resolvedSpec = mergeValidatedSpec(modelResolvedSpec, primary, critic, input);
        const normalizedResolved = normalizedSpec(resolvedSpec);
        const normalizedPrimary = normalizedSpec(primary);
        const normalizedCritic = normalizedSpec(critic);
        const conflictPaths = new Set(conflicts.map(conflict => conflict.path));
        for (const path of WHOLE_DIFF_PATHS) {
            if (conflictPaths.has(path))
                continue;
            if (!(0, util_1.isDeepStrictEqual)(normalizedPrimary[path], normalizedCritic[path])
                || !(0, util_1.isDeepStrictEqual)(normalizedResolved[path], normalizedPrimary[path])) {
                throw new failures_1.TestdataPipelineError('裁决结果修改了无冲突字段。', 'SPEC_CONSENSUS_REQUIRED', 'spec_consensus', 'spec', 'manual-review');
            }
        }
        verifyResolvedItems('constraints', normalizedPrimary.constraints, normalizedCritic.constraints, normalizedResolved.constraints, conflicts, resolutions);
        verifyResolvedItems('invariants', normalizedPrimary.invariants, normalizedCritic.invariants, normalizedResolved.invariants, conflicts, resolutions);
        for (const resolution of resolutions) {
            if (/^(?:constraints|invariants)\[\d+\]$/.test(resolution.path))
                continue;
            const conflict = conflicts.find(item => item.path === resolution.path);
            const actual = normalizedResolved[resolution.path];
            const matchesA = !!conflict && (0, util_1.isDeepStrictEqual)(actual, conflict.primaryValue);
            const matchesB = !!conflict && (0, util_1.isDeepStrictEqual)(actual, conflict.criticValue);
            const consistent = resolution.selected === 'A'
                ? matchesA
                : resolution.selected === 'B'
                    ? matchesB
                    : !matchesA && !matchesB;
            if (!conflict || !consistent) {
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
        systemPrompt: '你是 OJ 题意裁决器。只输出严格 JSON：resolvedSpec 和 resolutions。不得生成 ORACLE、validator、生成器或代码。只裁决 SERVER CONFLICTS 中列出的整字段或未配对条目；每个冲突必须恰好一条 resolution，selected 只能是 A、B、new，evidenceQuote 必须逐字来自题面。',
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
    const callOptions = { ...input.callOptions, contentMode: 'raw' };
    const extract = async (source) => {
        try {
            const result = await source.client.chat([{ role: 'user', content: prompt.userPrompt }], prompt.systemPrompt, callOptions);
            return { result, spec: validateExtractedSpec(result.content, input) };
        }
        catch (error) {
            if (isCancellation(error) || isModelCallBudgetExhausted(error))
                throw error;
            return { error };
        }
    };
    const [primary, critic] = await Promise.all([
        extract(input.primary),
        ...(input.critic ? [extract(input.critic)] : []),
    ]);
    const results = [primary.result, critic?.result].filter(Boolean);
    const rolesUsed = input.critic
        ? ['specPrimary', 'specCritic']
        : ['specPrimary'];
    const roleIdentities = {};
    if (primary.result)
        roleIdentities.specPrimary = { ...primary.result.usedModel };
    if (critic?.result)
        roleIdentities.specCritic = { ...critic.result.usedModel };
    if (!input.critic) {
        if (!primary.spec) {
            return {
                status: 'unresolved',
                conflictCount: 0,
                unresolvedConflictCount: 1,
                conflicts: [],
                failureCode: failureCode(primary.error),
                results,
                rolesUsed,
                roleIdentities,
            };
        }
        return {
            status: 'consensus',
            conflictCount: 0,
            unresolvedConflictCount: 0,
            conflicts: [],
            resolvedSpec: primary.spec,
            results,
            rolesUsed,
            roleIdentities,
            safeSummary: safeSummary('consensus', [], 0, rolesUsed, primary.spec),
        };
    }
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
            roleIdentities,
        };
    }
    const conflicts = diffProblemSpecs(primary.spec, critic.spec);
    const mergedSpec = mergeValidatedSpec(primary.spec, primary.spec, critic.spec, input);
    if (conflicts.length === 0) {
        return {
            status: 'consensus',
            conflictCount: 0,
            unresolvedConflictCount: 0,
            conflicts,
            resolvedSpec: mergedSpec,
            results,
            rolesUsed,
            roleIdentities,
            safeSummary: safeSummary('consensus', conflicts, 0, rolesUsed, mergedSpec),
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
            roleIdentities,
        };
    }
    const adjudicatorPrompt = buildAdjudicatorPrompts(input.snapshot, primary.spec, critic.spec, conflicts);
    rolesUsed.push('adjudicator');
    let adjudicatorResult;
    try {
        adjudicatorResult = await input.adjudicator.client.chat([{ role: 'user', content: adjudicatorPrompt.userPrompt }], adjudicatorPrompt.systemPrompt, callOptions);
        results.push(adjudicatorResult);
        roleIdentities.adjudicator = { ...adjudicatorResult.usedModel };
        const adjudication = parseAdjudication(adjudicatorResult.content, conflicts, primary.spec, critic.spec, input);
        return {
            status: 'adjudicated',
            conflictCount: conflicts.length,
            unresolvedConflictCount: 0,
            conflicts,
            resolvedSpec: adjudication.resolvedSpec,
            resolutions: adjudication.resolutions,
            results,
            rolesUsed,
            roleIdentities,
            safeSummary: safeSummary('adjudicated', conflicts, 0, rolesUsed, adjudication.resolvedSpec),
        };
    }
    catch (error) {
        if (isCancellation(error) || isModelCallBudgetExhausted(error))
            throw error;
        return {
            status: 'unresolved',
            conflictCount: conflicts.length,
            unresolvedConflictCount: conflicts.length,
            conflicts,
            failureCode: failureCode(error),
            results,
            rolesUsed,
            roleIdentities,
        };
    }
}
//# sourceMappingURL=specConsensus.js.map