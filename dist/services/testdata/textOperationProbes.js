"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RANGE_PROBE_KINDS = void 0;
exports.operationLayout = operationLayout;
exports.scalarSnapshot = scalarSnapshot;
exports.stringAlphabet = stringAlphabet;
exports.stringCharacterSnapshot = stringCharacterSnapshot;
exports.stringCountField = stringCountField;
exports.stringLengthIsValid = stringLengthIsValid;
exports.replaceScalar = replaceScalar;
exports.rangeDescriptor = rangeDescriptor;
exports.rangeSnapshot = rangeSnapshot;
exports.rangeIsValid = rangeIsValid;
exports.constructRangeMutation = constructRangeMutation;
exports.preserveTextOperationCounts = preserveTextOperationCounts;
const fileBudget_1 = require("./fileBudget");
exports.RANGE_PROBE_KINDS = [
    'operation-range-below-min', 'operation-range-reversed', 'operation-range-above-max',
];
function location(encoding) {
    const match = /^line:([1-9]\d*) token:([1-9]\d*)$/.exec(encoding);
    if (!match || !match.slice(1).every(value => Number.isSafeInteger(Number(value))))
        return undefined;
    return { line: Number(match[1]), token: Number(match[2]) };
}
/** A fixed prefix followed by exactly q operation lines; no evaluated expressions. */
function operationLayout(field) {
    if (field.type !== 'operations')
        return undefined;
    const match = /^lines:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+([1-9]\d*) operations$/.exec(field.encoding);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) !== Number(match[3]) + 1
        || !field.dependsOn?.includes(match[2]))
        return undefined;
    return { start: Number(match[1]), countId: match[2] };
}
function unambiguous(spec, field, at) {
    return !spec.inputFields.some(other => {
        if (other.id === field.id)
            return false;
        const point = location(other.encoding);
        if (point)
            return point.line === at.line && point.token === at.token;
        const sequence = /^line:(\d+) tokens:(\d+)\.\./.exec(other.encoding);
        if (sequence)
            return Number(sequence[1]) === at.line && Number(sequence[2]) <= at.token;
        const lines = /^lines:(\d+)\.\./.exec(other.encoding);
        return !!lines && at.line >= Number(lines[1]);
    });
}
function scalarSnapshot(input, spec, field) {
    const at = location(field.encoding);
    if (!at || !unambiguous(spec, field, at))
        return undefined;
    const line = input.split('\n')[at.line - 1];
    if (line === undefined)
        return undefined;
    const tokens = line.match(/\S+/g) || [];
    const value = tokens[at.token - 1];
    // An empty string is representable only on its own, explicitly located line.
    if (value === undefined && !(field.type === 'string' && at.token === 1 && tokens.length === 0
        && !spec.inputFields.some(other => other.id !== field.id && location(other.encoding)?.line === at.line)))
        return undefined;
    return { value: value ?? '', at };
}
function stringAlphabet(expression, fieldId) {
    if (expression === `characters(${fieldId}) in [01]`)
        return /^[01]*$/;
    if (expression.startsWith(`characters(${fieldId}[1..`) && expression.endsWith(']) in [01]'))
        return /^[01]*$/;
    if (expression === `characters(${fieldId}) in [a-z]`)
        return /^[a-z]+$/;
    return undefined;
}
function stringCharacterSnapshot(input, spec, field, expression) {
    const alphabet = stringAlphabet(expression, field.id);
    const snapshot = scalarSnapshot(input, spec, field);
    if (!alphabet || !snapshot)
        return undefined;
    let checkedLength = snapshot.value.length;
    const prefix = `characters(${field.id}[1..`;
    if (expression.startsWith(prefix)) {
        const countId = expression.slice(prefix.length, -']) in [01]'.length);
        const count = spec.inputFields.find(item => item.id === countId && item.type === 'integer');
        const raw = count && field.dependsOn?.includes(countId) && scalarSnapshot(input, spec, count)?.value;
        if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
            return undefined;
        checkedLength = Number(raw);
    }
    return { ...snapshot, checkedLength, valid: checkedLength <= snapshot.value.length
            && alphabet.test(snapshot.value.slice(0, checkedLength)) };
}
function stringCountField(spec, field, expression) {
    if (field.type !== 'string')
        return undefined;
    return spec.inputFields.find(count => count.type === 'integer' && field.dependsOn?.includes(count.id)
        && expression === `length(${field.id}) = ${count.id}`);
}
function stringLengthIsValid(input, spec, field, expression) {
    const count = stringCountField(spec, field, expression);
    const raw = count && scalarSnapshot(input, spec, count)?.value;
    const value = scalarSnapshot(input, spec, field)?.value;
    // Only ASCII token strings have an unambiguous length unit in this closed grammar.
    if (raw === undefined || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))
        || value === undefined || !/^[\x21-\x7e]*$/.test(value))
        return undefined;
    return value.length === Number(raw);
}
function replaceScalar(input, at, replacement) {
    const lines = input.split('\n');
    const line = lines[at.line - 1];
    if (line === undefined)
        return undefined;
    const token = [...line.matchAll(/\S+/g)][at.token - 1];
    if (!token && !(at.token === 1 && !line.trim()))
        return undefined;
    const start = token?.index ?? line.length;
    lines[at.line - 1] = line.slice(0, start) + replacement + line.slice(start + (token?.[0].length ?? 0));
    return { input: lines.join('\n'), position: at };
}
function rangeDescriptor(spec, expression, fieldId) {
    const fields = spec.inputFields.filter(field => field.type === 'operations');
    const field = fields.find(item => item.id === fieldId);
    if (!field || fields.length !== 1)
        return undefined;
    const match = /^for every operation, (0|1) <= ([A-Za-z][A-Za-z0-9_.:-]{0,63}) <= ([A-Za-z][A-Za-z0-9_.:-]{0,63}) <= ([A-Za-z][A-Za-z0-9_.:-]{0,63})$/.exec(expression);
    if (!match || match[2] === match[3])
        return undefined;
    const upperField = spec.inputFields.find(item => item.id === match[4] && item.type === 'integer');
    if (!upperField || !location(upperField.encoding))
        return undefined;
    if ([match[2], match[3]].some(id => {
        const argument = spec.inputFields.find(item => item.id === id);
        return argument && (argument.type !== 'integer' || argument.encoding !== `operation-argument:${id}`);
    }))
        return undefined;
    const definitions = spec.operations || [];
    if (!definitions.length || new Set(definitions.map(item => item.name)).size !== definitions.length
        || definitions.some(item => !/^(?:[A-Za-z][A-Za-z0-9_]*|0|[1-9]\d*)$/.test(item.name)
            || item.arguments.length < 2 || item.arguments[0] !== match[2] || item.arguments[1] !== match[3]
            || item.preconditions.some(predicate => ![0, 1].some(lower => (predicate === `${lower} <= ${match[2]} <= ${match[3]} <= ${match[4]}`)))
            || new Set(item.arguments).size !== item.arguments.length
            || item.arguments.slice(2).some(id => !spec.inputFields.some(argument => argument.id === id
                && argument.type === 'integer' && argument.encoding === `operation-argument:${id}`))))
        return undefined;
    return { field, lower: Number(match[1]), left: match[2], right: match[3], upperField };
}
function rangeSnapshot(input, spec, descriptor) {
    const layout = operationLayout(descriptor.field);
    if (!layout)
        return undefined;
    const countField = spec.inputFields.find(item => item.id === layout.countId && item.type === 'integer');
    const countValue = countField && scalarSnapshot(input, spec, countField);
    const upperValue = scalarSnapshot(input, spec, descriptor.upperField);
    if (!countValue || countValue.at.line >= layout.start || !upperValue || upperValue.at.line >= layout.start
        || !/^(0|[1-9]\d*)$/.test(countValue.value) || !/^(0|[1-9]\d*)$/.test(upperValue.value))
        return undefined;
    // Another field cannot own any part of the operation rows.
    if (spec.inputFields.some(field => {
        if (field.id === descriptor.field.id)
            return false;
        if (field.encoding === `operation-argument:${field.id}`) {
            return field.type !== 'integer' || !(spec.operations || []).some(op => op.arguments.includes(field.id));
        }
        if (field.type === 'array') {
            const sequence = /^line:([1-9]\d*) tokens:1\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})$/.exec(field.encoding);
            if (!sequence || !Number.isSafeInteger(Number(sequence[1])) || Number(sequence[1]) >= layout.start
                || !field.dependsOn?.includes(sequence[2]))
                return true;
            const lengthField = spec.inputFields.find(item => item.id === sequence[2] && item.type === 'integer');
            const length = lengthField && scalarSnapshot(input, spec, lengthField);
            if (!length || length.at.line >= Number(sequence[1]) || !/^(0|[1-9]\d*)$/.test(length.value)
                || !Number.isSafeInteger(Number(length.value)))
                return true;
            const values = input.split('\n')[Number(sequence[1]) - 1]?.match(/\S+/g) || [];
            return values.length !== Number(length.value) || values.some(value => !/^-?(0|[1-9]\d*)$/.test(value)
                || !Number.isSafeInteger(Number(value)))
                || spec.inputFields.some(other => other.id !== field.id
                    && (location(other.encoding)?.line === Number(sequence[1])
                        || new RegExp(`^line:${sequence[1]} tokens:`).test(other.encoding)));
        }
        const at = location(field.encoding);
        return !at || at.line >= layout.start;
    }))
        return undefined;
    const count = Number(countValue.value);
    const upper = Number(upperValue.value);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(upper))
        return undefined;
    const lines = input.endsWith('\n') ? input.slice(0, -1).split('\n') : input.split('\n');
    if (lines.length !== layout.start - 1 + count)
        return undefined;
    const definitions = new Map((spec.operations || []).map(item => [item.name, item]));
    const operations = [];
    for (let index = layout.start - 1; index < lines.length; index++) {
        const tokens = lines[index].match(/\S+/g) || [];
        const definition = definitions.get(tokens[0]);
        if (!definition || tokens.length !== definition.arguments.length + 1 || !tokens.slice(1).every(raw => /^-?(0|[1-9]\d*)$/.test(raw)
            && Number.isSafeInteger(Number(raw))))
            return undefined;
        operations.push({ name: tokens[0], left: Number(tokens[1]), right: Number(tokens[2]), arguments: tokens.slice(1).map(Number), line: index + 1 });
    }
    return { upper, count, start: layout.start, countId: layout.countId, operations };
}
function rangeIsValid(input, spec, descriptor) {
    const snapshot = rangeSnapshot(input, spec, descriptor);
    return snapshot && snapshot.operations.every(op => descriptor.lower <= op.left && op.left <= op.right && op.right <= snapshot.upper);
}
function constructRangeMutation(input, spec, descriptor, kind, operationName) {
    const snapshot = rangeSnapshot(input, spec, descriptor);
    if (!snapshot || rangeIsValid(input, spec, descriptor) !== true)
        return 'MUTATION_NOT_ISOLATED';
    if ((spec.operations || []).some(operation => operation.preconditions.length > 1))
        return 'UNSUPPORTED_TARGET';
    const op = snapshot.operations.find(item => item.name === operationName);
    if (!op)
        return 'NO_MATCHING_LEGAL_SEED';
    let left = op.left;
    let right = op.right;
    if (kind === 'operation-range-below-min')
        left = descriptor.lower - 1;
    else if (kind === 'operation-range-above-max')
        right = snapshot.upper + 1;
    else if (kind === 'operation-range-reversed') {
        if (snapshot.upper <= descriptor.lower)
            return 'MUTATION_NOT_ISOLATED';
        left = descriptor.lower + 1;
        right = descriptor.lower;
    }
    else
        return 'INVALID_RECIPE';
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right))
        return 'UNSUPPORTED_TARGET';
    // Each range probe violates precisely one of its three inequalities.
    const first = replaceScalar(input, { line: op.line, token: 2 }, String(left));
    return first && replaceScalar(first.input, { line: op.line, token: 3 }, String(right)) || 'MUTATION_NOT_ISOLATED';
}
/** Preserve fixed string/operation cardinalities before the global isolation check. */
function preserveTextOperationCounts(original, input, spec, expressions, countId, count) {
    for (const field of spec.inputFields) {
        if (field.type === 'string' && expressions.includes(`length(${field.id}) = ${countId}`)) {
            const expression = `length(${field.id}) = ${countId}`;
            const snapshot = scalarSnapshot(original, spec, field);
            if (!snapshot || stringLengthIsValid(original, spec, field, expression) !== true || count < 0)
                return { gap: 'MUTATION_NOT_ISOLATED' };
            if (count > fileBudget_1.TESTDATA_INPUT_MAX_BYTES)
                return { gap: 'PROBE_TOO_LARGE' };
            const value = snapshot.value;
            if (Buffer.byteLength(input, 'utf8') + count - value.length > fileBudget_1.TESTDATA_INPUT_MAX_BYTES)
                return { gap: 'PROBE_TOO_LARGE' };
            if (!value.length && count)
                return { gap: 'MUTATION_NOT_ISOLATED' };
            const replacement = count <= value.length ? value.slice(0, count) : value + value.slice(-1).repeat(count - value.length);
            const changed = replaceScalar(input, snapshot.at, replacement);
            if (!changed)
                return { gap: 'MUTATION_NOT_ISOLATED' };
            input = changed.input;
        }
        if (field.type !== 'operations')
            continue;
        const encodedCount = /^lines:[1-9]\d*\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+/.exec(field.encoding)?.[1];
        if (encodedCount ? encodedCount !== countId : !field.dependsOn?.includes(countId))
            continue;
        const predicates = [...expressions, ...(spec.operations || []).flatMap(operation => (operation.preconditions.map(predicate => `for every operation, ${predicate}`)))];
        const descriptor = predicates.map(expression => rangeDescriptor(spec, expression, field.id)).find(Boolean);
        if (!descriptor || operationLayout(field)?.countId !== countId
            || (spec.operations || []).some(operation => operation.preconditions.length > 1))
            return { gap: 'MUTATION_NOT_ISOLATED' };
        const snapshot = rangeSnapshot(original, spec, descriptor);
        if (!snapshot || count < 0)
            return { gap: 'MUTATION_NOT_ISOLATED' };
        const lines = input.endsWith('\n') ? input.slice(0, -1).split('\n') : input.split('\n');
        const prefix = lines.slice(0, snapshot.start - 1).join('\n') + '\n';
        const rows = lines.slice(snapshot.start - 1);
        if (!rows.length && count)
            return { gap: 'MUTATION_NOT_ISOLATED' };
        const extra = Math.max(0, count - rows.length);
        if (extra * (Buffer.byteLength(rows[0] || '', 'utf8') + 1) + Buffer.byteLength(input, 'utf8') > fileBudget_1.TESTDATA_INPUT_MAX_BYTES)
            return { gap: 'PROBE_TOO_LARGE' };
        input = prefix + rows.slice(0, count).map(row => row + '\n').join('') + (rows[0] + '\n').repeat(extra);
    }
    return Buffer.byteLength(input, 'utf8') > fileBudget_1.TESTDATA_INPUT_MAX_BYTES ? { gap: 'PROBE_TOO_LARGE' } : input;
}
//# sourceMappingURL=textOperationProbes.js.map