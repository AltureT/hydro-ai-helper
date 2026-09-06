"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCALAR_RANGE_PROBE_KINDS = void 0;
exports.scalarRangeDescriptor = scalarRangeDescriptor;
exports.scalarRangeValid = scalarRangeValid;
exports.constructScalarRangeMutation = constructScalarRangeMutation;
const textOperationProbes_1 = require("./textOperationProbes");
exports.SCALAR_RANGE_PROBE_KINDS = ['scalar-range-below-min', 'scalar-range-reversed', 'scalar-range-above-max'];
/** Exactly two explicitly located integer fields and two safe integer constants. */
function scalarRangeDescriptor(spec, expression) {
    const match = /^(-?\d+)\s*<=\s*([A-Za-z][A-Za-z0-9_.:-]{0,63})\s*<=\s*([A-Za-z][A-Za-z0-9_.:-]{0,63})\s*<=\s*(-?\d+)$/.exec(expression);
    if (!match || match[2] === match[3])
        return undefined;
    const min = Number(match[1]);
    const max = Number(match[4]);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max)
        return undefined;
    const fields = [match[2], match[3]].map(id => spec.inputFields.filter(field => field.id === id));
    if (fields.some(items => items.length !== 1 || items[0].type !== 'integer'
        || !/^line:[1-9]\d* token:[1-9]\d*$/.test(items[0].encoding)))
        return undefined;
    // This constructor cannot resize dependent structures while changing both endpoints.
    if (spec.inputFields.some(field => field.dependsOn?.some(id => id === match[2] || id === match[3])))
        return undefined;
    if (spec.inputFields.some(field => !/^line:[1-9]\d* token:[1-9]\d*$/.test(field.encoding)))
        return undefined;
    return { min, max, left: fields[0][0], right: fields[1][0] };
}
function scalarRangeValid(input, spec, expression) {
    const descriptor = scalarRangeDescriptor(spec, expression);
    if (!descriptor)
        return undefined;
    const values = [descriptor.left, descriptor.right].map(field => (0, textOperationProbes_1.scalarSnapshot)(input, spec, field)?.value);
    if (values.some(value => value === undefined || !/^-?(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))))
        return undefined;
    const [left, right] = values.map(Number);
    return descriptor.min <= left && left <= right && right <= descriptor.max;
}
function constructScalarRangeMutation(input, spec, expression, kind) {
    const descriptor = scalarRangeDescriptor(spec, expression);
    if (!descriptor || scalarRangeValid(input, spec, expression) !== true)
        return undefined;
    const left = (0, textOperationProbes_1.scalarSnapshot)(input, spec, descriptor.left);
    const right = (0, textOperationProbes_1.scalarSnapshot)(input, spec, descriptor.right);
    if (!left || !right)
        return undefined;
    if (kind === 'scalar-range-below-min' && Number.isSafeInteger(descriptor.min - 1)) {
        return (0, textOperationProbes_1.replaceScalar)(input, left.at, String(descriptor.min - 1));
    }
    if (kind === 'scalar-range-above-max' && Number.isSafeInteger(descriptor.max + 1)) {
        return (0, textOperationProbes_1.replaceScalar)(input, right.at, String(descriptor.max + 1));
    }
    if (kind === 'scalar-range-reversed' && descriptor.min < descriptor.max) {
        const first = (0, textOperationProbes_1.replaceScalar)(input, left.at, String(descriptor.min + 1));
        return first && (0, textOperationProbes_1.replaceScalar)(first.input, right.at, String(descriptor.min));
    }
    return undefined;
}
//# sourceMappingURL=scalarRangeProbes.js.map