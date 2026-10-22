import type { ProblemSpecV1 } from './problemSpec';
import { replaceScalar, scalarSnapshot } from './textOperationProbes';

export const SCALAR_RANGE_PROBE_KINDS = ['scalar-range-below-min', 'scalar-range-reversed', 'scalar-range-above-max'] as const;

/** Exactly two explicitly located integer fields and two safe integer constants. */
export function scalarRangeDescriptor(spec: ProblemSpecV1, expression: string) {
  const match = /^(-?\d+)\s*<=\s*([A-Za-z][A-Za-z0-9_.:-]{0,63})\s*<=\s*([A-Za-z][A-Za-z0-9_.:-]{0,63})\s*<=\s*(-?\d+)$/.exec(expression);
  if (!match || match[2] === match[3]) return undefined;
  const min = Number(match[1]); const max = Number(match[4]);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) return undefined;
  const fields = [match[2], match[3]].map(id => spec.inputFields.filter(field => field.id === id));
  if (fields.some(items => items.length !== 1 || items[0].type !== 'integer'
    || !/^line:[1-9]\d* token:[1-9]\d*$/.test(items[0].encoding))) return undefined;
  // This constructor cannot resize dependent structures while changing both endpoints.
  if (spec.inputFields.some(field => field.dependsOn?.some(id => id === match[2] || id === match[3]))) return undefined;
  if (spec.inputFields.some(field => !/^line:[1-9]\d* token:[1-9]\d*$/.test(field.encoding))) return undefined;
  return { min, max, left: fields[0][0], right: fields[1][0] };
}

export function scalarRangeValid(input: string, spec: ProblemSpecV1, expression: string): boolean | undefined {
  const descriptor = scalarRangeDescriptor(spec, expression);
  if (!descriptor) return undefined;
  const values = [descriptor.left, descriptor.right].map(field => scalarSnapshot(input, spec, field)?.value);
  if (values.some(value => value === undefined || !/^-?(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))) return undefined;
  const [left, right] = values.map(Number);
  return descriptor.min <= left && left <= right && right <= descriptor.max;
}

export function constructScalarRangeMutation(input: string, spec: ProblemSpecV1, expression: string, kind: string) {
  const descriptor = scalarRangeDescriptor(spec, expression);
  if (!descriptor || scalarRangeValid(input, spec, expression) !== true) return undefined;
  const left = scalarSnapshot(input, spec, descriptor.left);
  const right = scalarSnapshot(input, spec, descriptor.right);
  if (!left || !right) return undefined;
  if (kind === 'scalar-range-below-min' && Number.isSafeInteger(descriptor.min - 1)) {
    return replaceScalar(input, left.at, String(descriptor.min - 1));
  }
  if (kind === 'scalar-range-above-max' && Number.isSafeInteger(descriptor.max + 1)) {
    return replaceScalar(input, right.at, String(descriptor.max + 1));
  }
  if (kind === 'scalar-range-reversed' && descriptor.min < descriptor.max) {
    const first = replaceScalar(input, left.at, String(descriptor.min + 1));
    return first && replaceScalar(first.input, right.at, String(descriptor.min));
  }
  return undefined;
}
