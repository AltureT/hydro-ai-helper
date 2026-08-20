"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildConstraintProbes = buildConstraintProbes;
const crypto_1 = require("crypto");
const MAX_PROBE_INPUT_BYTES = 256 * 1024;
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
function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}
function sha256(value) {
    return (0, crypto_1.createHash)('sha256').update(value, 'utf8').digest('hex');
}
function normalizeInput(input) {
    const normalized = input.replace(/\r\n?/g, '\n');
    if (normalized.length === 0 || normalized.endsWith('\n'))
        return normalized;
    return `${normalized}\n`;
}
function compareStrings(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function compareIndices(source, left, right) {
    if (source !== 'sample') {
        const leftNumber = typeof left === 'number' ? left : Number(left);
        const rightNumber = typeof right === 'number' ? right : Number(right);
        if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
            return leftNumber - rightNumber;
        }
    }
    return compareStrings(String(left), String(right));
}
function orderedSeeds(seeds) {
    const sourceOrder = {
        formal: 0,
        sample: 1,
        stress: 2,
    };
    return seeds.map(seed => ({ ...seed }))
        .sort((left, right) => sourceOrder[left.source] - sourceOrder[right.source]
        || compareIndices(left.source, left.index, right.index)
        || (left.subtaskId ?? -1) - (right.subtaskId ?? -1)
        || compareStrings(normalizeInput(left.input), normalizeInput(right.input)));
}
function findTarget(spec, targetId) {
    const constraint = spec.constraints.find(item => item.id === targetId);
    if (constraint?.machineCheckable) {
        return {
            id: constraint.id,
            kind: 'constraint',
            expression: constraint.expression,
            ...(constraint.scope === 'global' ? {} : { subtaskId: constraint.scope.subtaskId }),
        };
    }
    const invariant = spec.invariants.find(item => item.id === targetId);
    if (invariant?.machineCheckable) {
        return { id: invariant.id, kind: 'invariant', expression: invariant.expression };
    }
    return undefined;
}
function selectSeed(seeds, target) {
    if (target.subtaskId !== undefined) {
        return seeds.find(seed => seed.source === 'formal' && seed.subtaskId === target.subtaskId);
    }
    return seeds[0];
}
function parseLocation(encoding) {
    const match = /^line:([1-9]\d*) token:([1-9]\d*)$/.exec(encoding);
    if (!match)
        return undefined;
    return { line: Number(match[1]), token: Number(match[2]) };
}
function scalarLocationIsUnambiguous(spec, fieldId, location) {
    return !spec.inputFields.some(field => {
        if (field.id === fieldId)
            return false;
        const otherLocation = parseLocation(field.encoding);
        if (otherLocation) {
            return otherLocation.line === location.line && otherLocation.token === location.token;
        }
        const otherRange = parseTokenRange(field.encoding);
        return otherRange?.line === location.line && location.token >= otherRange.startToken;
    });
}
function replaceToken(input, location, replacement) {
    const lines = input.split('\n');
    const line = lines[location.line - 1];
    if (line === undefined)
        return undefined;
    const tokens = [...line.matchAll(/\S+/g)];
    const token = tokens[location.token - 1];
    if (!token || token.index === undefined)
        return undefined;
    lines[location.line - 1] = `${line.slice(0, token.index)}${replacement}${line.slice(token.index + token[0].length)}`;
    return { input: lines.join('\n'), position: location };
}
function removeToken(input, location) {
    const lines = input.split('\n');
    const line = lines[location.line - 1];
    if (line === undefined)
        return undefined;
    const tokens = [...line.matchAll(/\S+/g)];
    const token = tokens[location.token - 1];
    if (!token || token.index === undefined)
        return undefined;
    const previous = tokens[location.token - 2];
    const start = previous && previous.index !== undefined
        ? previous.index + previous[0].length
        : token.index;
    const end = token.index + token[0].length;
    lines[location.line - 1] = `${line.slice(0, start)}${line.slice(end)}`;
    return { input: lines.join('\n'), position: location };
}
function parseTokenRange(encoding) {
    const match = /^line:([1-9]\d*) tokens:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})$/
        .exec(encoding);
    if (!match)
        return undefined;
    return {
        line: Number(match[1]),
        startToken: Number(match[2]),
        countFieldId: match[3],
    };
}
function tokenValuesAtLine(input, lineNumber) {
    const line = input.split('\n')[lineNumber - 1];
    return line === undefined ? undefined : [...line.matchAll(/\S+/g)].map(match => match[0]);
}
function integerBounds(expression, fieldId) {
    const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const range = new RegExp(`^(-?\\d+) <= ${escaped} <= (-?\\d+)$`).exec(expression);
    if (range)
        return { min: Number(range[1]), max: Number(range[2]) };
    const lower = new RegExp(`^${escaped} >= (-?\\d+)$`).exec(expression);
    if (lower)
        return { min: Number(lower[1]) };
    const upper = new RegExp(`^${escaped} <= (-?\\d+)$`).exec(expression);
    if (upper)
        return { max: Number(upper[1]) };
    return {};
}
function constructIntegerMutation(input, spec, target, fieldId, encoding, kind) {
    const location = parseLocation(encoding);
    if (!location)
        return 'UNPARSEABLE_ENCODING';
    if (!scalarLocationIsUnambiguous(spec, fieldId, location))
        return 'UNPARSEABLE_ENCODING';
    const bounds = integerBounds(target.expression, fieldId);
    const boundary = kind === 'integer-below-min' ? bounds.min : bounds.max;
    if (!Number.isSafeInteger(boundary))
        return 'UNSUPPORTED_TARGET';
    const replacement = kind === 'integer-below-min'
        ? boundary - 1
        : boundary + 1;
    if (!Number.isSafeInteger(replacement))
        return 'UNSUPPORTED_TARGET';
    return replaceToken(input, location, String(replacement)) || 'MUTATION_NOT_ISOLATED';
}
function resolveSequenceLayout(input, spec, fieldId) {
    const field = spec.inputFields.find(item => item.id === fieldId);
    if (!field)
        return 'INVALID_RECIPE';
    const range = parseTokenRange(field.encoding);
    if (!range)
        return 'UNPARSEABLE_ENCODING';
    if (!field.dependsOn?.includes(range.countFieldId))
        return 'DEPENDENCY_NOT_RESOLVED';
    const countField = spec.inputFields.find(item => item.id === range.countFieldId);
    if (!countField || countField.type !== 'integer')
        return 'DEPENDENCY_NOT_RESOLVED';
    const countLocation = parseLocation(countField.encoding);
    if (!countLocation)
        return 'DEPENDENCY_NOT_RESOLVED';
    const countTokens = tokenValuesAtLine(input, countLocation.line);
    const countRaw = countTokens?.[countLocation.token - 1];
    if (!countRaw || !/^(0|[1-9]\d*)$/.test(countRaw))
        return 'DEPENDENCY_NOT_RESOLVED';
    const count = Number(countRaw);
    if (!Number.isSafeInteger(count))
        return 'DEPENDENCY_NOT_RESOLVED';
    const lineTokens = tokenValuesAtLine(input, range.line);
    if (!lineTokens || range.startToken + count - 1 !== lineTokens.length) {
        return 'MUTATION_NOT_ISOLATED';
    }
    const values = lineTokens.slice(range.startToken - 1);
    if (values.length !== count || values.length === 0)
        return 'MUTATION_NOT_ISOLATED';
    const finalToken = range.startToken + values.length - 1;
    const overlaps = spec.inputFields.some(other => {
        if (other.id === fieldId)
            return false;
        const otherLocation = parseLocation(other.encoding);
        if (otherLocation) {
            return otherLocation.line === range.line
                && otherLocation.token >= range.startToken
                && otherLocation.token <= finalToken;
        }
        const otherRange = parseTokenRange(other.encoding);
        return otherRange?.line === range.line;
    });
    if (overlaps)
        return 'UNPARSEABLE_ENCODING';
    return {
        line: range.line,
        startToken: range.startToken,
        values,
        countFieldId: range.countFieldId,
    };
}
function constructSequenceMutation(input, spec, target, fieldId, kind) {
    const layout = resolveSequenceLayout(input, spec, fieldId);
    if (typeof layout === 'string')
        return layout;
    const escapedField = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedCount = layout.countFieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (kind === 'array-length-mismatch') {
        if (!new RegExp(`^length\\(${escapedField}\\) = ${escapedCount}$`)
            .test(target.expression))
            return 'UNSUPPORTED_TARGET';
        return removeToken(input, {
            line: layout.line,
            token: layout.startToken + layout.values.length - 1,
        }) || 'MUTATION_NOT_ISOLATED';
    }
    if (layout.values.length < 2)
        return 'MUTATION_NOT_ISOLATED';
    if (kind === 'duplicate-element') {
        if (!new RegExp(`^allDistinct\\(${escapedField}\\)$`).test(target.expression)) {
            return 'UNSUPPORTED_TARGET';
        }
        if (new Set(layout.values).size !== layout.values.length
            || layout.values[0] === layout.values[1])
            return 'MUTATION_NOT_ISOLATED';
        return replaceToken(input, {
            line: layout.line,
            token: layout.startToken + 1,
        }, layout.values[0]) || 'MUTATION_NOT_ISOLATED';
    }
    if (!new RegExp(`^permutation\\(${escapedField}, 1\\.\\.${escapedCount}\\)$`)
        .test(target.expression))
        return 'UNSUPPORTED_TARGET';
    const replacement = layout.values[layout.values.length - 2];
    if (replacement === layout.values[layout.values.length - 1])
        return 'MUTATION_NOT_ISOLATED';
    return replaceToken(input, {
        line: layout.line,
        token: layout.startToken + layout.values.length - 1,
    }, replacement) || 'MUTATION_NOT_ISOLATED';
}
function constructStringMutation(input, spec, target, fieldId, encoding) {
    const location = parseLocation(encoding);
    if (!location)
        return 'UNPARSEABLE_ENCODING';
    if (!scalarLocationIsUnambiguous(spec, fieldId, location))
        return 'UNPARSEABLE_ENCODING';
    const escapedField = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^characters\\(${escapedField}\\) in \\[a-z\\]$`)
        .test(target.expression))
        return 'UNSUPPORTED_TARGET';
    const lineTokens = tokenValuesAtLine(input, location.line);
    const value = lineTokens?.[location.token - 1];
    if (!value || !/^[a-z]+$/.test(value))
        return 'MUTATION_NOT_ISOLATED';
    return replaceToken(input, location, `${value.slice(0, -1)}#`)
        || 'MUTATION_NOT_ISOLATED';
}
function gap(target, reasonCode) {
    return {
        targetId: target.id,
        targetKind: target.kind,
        reasonCode,
        ...(target.subtaskId === undefined ? {} : { subtaskId: target.subtaskId }),
    };
}
function buildConstraintProbes(input) {
    const seeds = orderedSeeds(input.seeds);
    const legalSeedHash = sha256(canonicalJson(seeds.map(seed => ({
        source: seed.source,
        index: seed.index,
        subtaskId: seed.subtaskId,
        input: normalizeInput(seed.input),
    }))));
    const effectiveSeed = sha256(`constraint-probes-v1\0${input.statementHash}\0${input.specHash}\0${legalSeedHash}`);
    const probes = [];
    const gaps = [];
    for (const recipe of input.recipes || []) {
        const target = findTarget(input.spec, recipe.targetId);
        if (!target) {
            gaps.push({
                targetId: recipe.targetId,
                targetKind: 'constraint',
                reasonCode: 'INVALID_RECIPE',
            });
            continue;
        }
        const seed = selectSeed(seeds, target);
        if (!seed) {
            gaps.push(gap(target, 'NO_MATCHING_LEGAL_SEED'));
            continue;
        }
        const normalizedInput = normalizeInput(seed.input);
        if (normalizedInput.length === 0) {
            gaps.push(gap(target, 'MUTATION_NOT_ISOLATED'));
            continue;
        }
        const field = recipe.fieldId
            ? input.spec.inputFields.find(item => item.id === recipe.fieldId)
            : undefined;
        if (!field) {
            gaps.push(gap(target, 'INVALID_RECIPE'));
            continue;
        }
        let mutation;
        if (recipe.constructionKind === 'integer-below-min'
            || recipe.constructionKind === 'integer-above-max') {
            mutation = field.type === 'integer'
                ? constructIntegerMutation(normalizedInput, input.spec, target, field.id, field.encoding, recipe.constructionKind)
                : 'INVALID_RECIPE';
        }
        else if (recipe.constructionKind === 'array-length-mismatch'
            || recipe.constructionKind === 'duplicate-element'
            || recipe.constructionKind === 'permutation-duplicate-or-missing') {
            const expectedType = recipe.constructionKind === 'permutation-duplicate-or-missing'
                ? 'permutation'
                : 'array';
            mutation = field.type === expectedType
                ? constructSequenceMutation(normalizedInput, input.spec, target, field.id, recipe.constructionKind)
                : 'INVALID_RECIPE';
        }
        else if (recipe.constructionKind === 'illegal-string-character') {
            mutation = field.type === 'string'
                ? constructStringMutation(normalizedInput, input.spec, target, field.id, field.encoding)
                : 'INVALID_RECIPE';
        }
        else {
            mutation = 'UNSUPPORTED_TARGET';
        }
        if (typeof mutation === 'string') {
            gaps.push(gap(target, mutation));
            continue;
        }
        if (Buffer.byteLength(mutation.input, 'utf8') > MAX_PROBE_INPUT_BYTES) {
            gaps.push(gap(target, 'PROBE_TOO_LARGE'));
            continue;
        }
        const id = sha256(canonicalJson({
            statementHash: input.statementHash,
            specHash: input.specHash,
            targetKind: target.kind,
            targetId: target.id,
            subtaskId: target.subtaskId,
            constructionKind: recipe.constructionKind,
            effectiveSeed,
            mutationPosition: mutation.position,
        })).slice(0, 32);
        probes.push({
            id,
            targetId: target.id,
            targetKind: target.kind,
            input: mutation.input,
            ...(target.subtaskId === undefined ? {} : { subtaskId: target.subtaskId }),
            constructionKind: recipe.constructionKind,
        });
    }
    return { probes, gaps, legalSeedHash, effectiveSeed };
}
//# sourceMappingURL=constraintProbes.js.map