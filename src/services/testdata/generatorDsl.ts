import type { ProblemSpecV1 } from './problemSpec';
import {
  parseNumericBoundExpression,
  safeNumberFromIntegerLiteral,
} from './numericBounds';

const MAX_PLAN_LENGTH = 512 * 1024;
const MAX_CASES = 30;
const MAX_LABEL_LENGTH = 256;
const MAX_SEQUENCE_LENGTH = 100_000;
const MAX_DENSE_GRAPH_VERTICES = 500;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_TOTAL_GENERATOR_WORK = 1_000_000;
const UINT32_MAX = 0xffff_ffff;
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

export type SequencePattern =
  | 'random'
  | 'sorted'
  | 'reversed'
  | 'all-equal'
  | 'alternating';

export type GeneratorFieldPlan =
  | { kind: 'integer'; value: number | string }
  | { kind: 'integer'; min: number; max: number }
  | {
    kind: 'string';
    length: number;
    alphabet: string;
    pattern: 'random' | 'same' | 'alternating';
  }
  | {
    kind: 'array';
    length: number;
    min: number;
    max: number;
    pattern: SequencePattern;
  }
  | {
    kind: 'matrix';
    rows: number;
    columns: number;
    min: number;
    max: number;
    pattern: SequencePattern;
  }
  | { kind: 'permutation'; size: number; pattern: 'identity' | 'reversed' | 'random' }
  | {
    kind: 'tree';
    size: number;
    shape: 'chain' | 'star' | 'balanced' | 'broom' | 'random';
  }
  | {
    kind: 'graph';
    size: number;
    shape: 'sparse' | 'near-tree' | 'dense' | 'bridge' | 'cycle';
  }
  | {
    kind: 'operation-sequence';
    length: number;
    pattern: 'add-delete-repeat' | 'nested-lifetime' | 'query-between-updates';
    minKey: number;
    maxKey: number;
  };

export interface GeneratorPlanCase {
  label: string;
  subtaskId?: number;
  fields: Record<string, GeneratorFieldPlan>;
}

export interface GeneratorPlanV1 {
  version: 1;
  seed: number;
  cases: GeneratorPlanCase[];
}

export type MaterializedGeneratorValue =
  | { kind: 'integer'; value: number | string }
  | { kind: 'string'; value: string }
  | { kind: 'array'; values: number[] }
  | { kind: 'matrix'; values: number[][] }
  | { kind: 'permutation'; values: number[] }
  | { kind: 'tree'; vertexCount: number; edges: Array<[number, number]> }
  | { kind: 'graph'; vertexCount: number; edges: Array<[number, number]> }
  | {
    kind: 'operation-sequence';
    operations: Array<{ type: string; arguments: number[] }>;
  };

export interface MaterializedGeneratorCase {
  label: string;
  input: string;
  subtaskId?: number;
  values: Record<string, MaterializedGeneratorValue>;
}

export type GeneratorDslIneligibilityReason =
  | 'COUNTED_TEST_CASES'
  | 'UNSUPPORTED_FIELD_TYPE'
  | 'UNPARSEABLE_ENCODING'
  | 'AMBIGUOUS_ENCODING'
  | 'DEPENDENCY_NOT_RESOLVED'
  | 'OPERATIONS_NOT_DECLARED'
  | 'UNSUPPORTED_OPERATION_PROTOCOL'
  | 'UNSAFE_ELEMENT_INTEGER_DOMAIN';

export type GeneratorDslEligibility =
  | { eligible: true }
  | { eligible: false; reason: GeneratorDslIneligibilityReason };

interface ScalarLayout {
  kind: 'scalar';
  line: number;
  token: number;
}

interface SequenceLayout {
  kind: 'sequence';
  line: number;
  startToken: number;
  countFieldId: string;
}

interface MatrixLayout {
  kind: 'matrix';
  startLine: number;
  rowCountFieldId: string;
  columnCountFieldId: string;
}

interface TreeLayout {
  kind: 'tree';
  startLine: number;
  vertexCountFieldId: string;
}

interface GraphLayout {
  kind: 'graph';
  startLine: number;
  edgeCountFieldId: string;
  vertexCountFieldId: string;
}

interface OperationsLayout {
  kind: 'operations';
  startLine: number;
  countFieldId: string;
}

interface OperationArgumentLayout {
  kind: 'operation-argument';
}

type FieldLayout =
  | ScalarLayout
  | SequenceLayout
  | MatrixLayout
  | TreeLayout
  | GraphLayout
  | OperationsLayout
  | OperationArgumentLayout;

function parsePositiveInteger(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseFieldLayout(
  field: ProblemSpecV1['inputFields'][number],
  _spec: ProblemSpecV1,
): FieldLayout | undefined {
  const scalar = /^line:([1-9]\d*) token:([1-9]\d*)$/.exec(field.encoding);
  if (scalar && (field.type === 'integer' || field.type === 'string')) {
    const line = parsePositiveInteger(scalar[1]);
    const token = parsePositiveInteger(scalar[2]);
    return line && token ? { kind: 'scalar', line, token } : undefined;
  }
  if (field.type === 'integer'
    && field.encoding === `operation-argument:${field.id}`) {
    return { kind: 'operation-argument' };
  }

  const sequence = /^line:([1-9]\d*) tokens:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})$/
    .exec(field.encoding);
  if (sequence && (field.type === 'array' || field.type === 'permutation')) {
    const line = parsePositiveInteger(sequence[1]);
    const startToken = parsePositiveInteger(sequence[2]);
    return line && startToken ? {
      kind: 'sequence', line, startToken, countFieldId: sequence[3],
    } : undefined;
  }

  const matrix = /^lines:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+([1-9]\d*) tokens:1\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})$/
    .exec(field.encoding);
  if (matrix && field.type === 'matrix') {
    const startLine = parsePositiveInteger(matrix[1]);
    const offset = parsePositiveInteger(matrix[3]);
    if (!startLine || offset !== startLine - 1) return undefined;
    return {
      kind: 'matrix',
      startLine,
      rowCountFieldId: matrix[2],
      columnCountFieldId: matrix[4],
    };
  }

  const tree = /^lines:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63}) tokens:1,2$/
    .exec(field.encoding);
  if (tree && field.type === 'tree') {
    const startLine = parsePositiveInteger(tree[1]);
    return startLine ? { kind: 'tree', startLine, vertexCountFieldId: tree[2] } : undefined;
  }

  const graph = /^lines:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+([1-9]\d*) tokens:1,2$/
    .exec(field.encoding);
  if (graph && field.type === 'graph') {
    const startLine = parsePositiveInteger(graph[1]);
    const offset = parsePositiveInteger(graph[3]);
    if (!startLine || offset !== startLine - 1) return undefined;
    const edgeCountFieldId = graph[2];
    const vertexCountFieldId = field.dependsOn?.find(id => id !== edgeCountFieldId);
    return vertexCountFieldId ? {
      kind: 'graph', startLine, edgeCountFieldId, vertexCountFieldId,
    } : undefined;
  }

  const operations = /^lines:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+([1-9]\d*) operations$/
    .exec(field.encoding);
  if (operations && field.type === 'operations') {
    const startLine = parsePositiveInteger(operations[1]);
    const offset = parsePositiveInteger(operations[3]);
    if (!startLine || offset !== startLine - 1) return undefined;
    return { kind: 'operations', startLine, countFieldId: operations[2] };
  }
  return undefined;
}

function isIntegerField(spec: ProblemSpecV1, id: string): boolean {
  return spec.inputFields.some(field => field.id === id && field.type === 'integer');
}

function dependenciesAreValid(
  field: ProblemSpecV1['inputFields'][number],
  layout: FieldLayout,
  spec: ProblemSpecV1,
): boolean {
  const dependencies = new Set(field.dependsOn || []);
  if (layout.kind === 'sequence') {
    return dependencies.has(layout.countFieldId) && isIntegerField(spec, layout.countFieldId);
  }
  if (layout.kind === 'matrix') {
    return dependencies.has(layout.rowCountFieldId)
      && dependencies.has(layout.columnCountFieldId)
      && isIntegerField(spec, layout.rowCountFieldId)
      && isIntegerField(spec, layout.columnCountFieldId);
  }
  if (layout.kind === 'tree') {
    return dependencies.has(layout.vertexCountFieldId)
      && isIntegerField(spec, layout.vertexCountFieldId);
  }
  if (layout.kind === 'graph') {
    return dependencies.has(layout.vertexCountFieldId)
      && dependencies.has(layout.edgeCountFieldId)
      && isIntegerField(spec, layout.vertexCountFieldId)
      && isIntegerField(spec, layout.edgeCountFieldId);
  }
  if (layout.kind === 'operations') {
    return dependencies.has(layout.countFieldId) && isIntegerField(spec, layout.countFieldId);
  }
  return true;
}

function resolveLayouts(spec: ProblemSpecV1): Map<string, FieldLayout> | undefined {
  const result = new Map<string, FieldLayout>();
  for (const field of spec.inputFields) {
    const layout = parseFieldLayout(field, spec);
    if (!layout || !dependenciesAreValid(field, layout, spec)) return undefined;
    result.set(field.id, layout);
  }
  return result;
}

interface OperationProtocol {
  argumentFieldId: string;
  add: string;
  remove: string;
  query?: string;
}

function exactOperationContract(
  operation: NonNullable<ProblemSpecV1['operations']>[number],
  argumentFieldId: string,
  preconditions: string[],
  effects: string[],
): boolean {
  return operation.arguments.length === 1
    && operation.arguments[0] === argumentFieldId
    && operation.preconditions.length === preconditions.length
    && operation.preconditions.every((item, index) => item === preconditions[index])
    && operation.effects.length === effects.length
    && operation.effects.every((item, index) => item === effects[index]);
}

function resolveOperationProtocol(spec: ProblemSpecV1): OperationProtocol | undefined {
  const argumentFields = spec.inputFields.filter(field => (
    field.type === 'integer' && field.encoding === `operation-argument:${field.id}`
  ));
  if (argumentFields.length !== 1) return undefined;
  const argumentFieldId = argumentFields[0].id;
  const operations = spec.operations || [];
  if (operations.length < 2 || operations.length > 3) return undefined;
  const additions = operations.filter(operation => operation.name.toUpperCase() === 'ADD');
  const removals = operations.filter(operation => (
    operation.name.toUpperCase() === 'DEL' || operation.name.toUpperCase() === 'DELETE'
  ));
  const queries = operations.filter(operation => (
    operation.name.toUpperCase() !== 'ADD'
    && operation.name.toUpperCase() !== 'DEL'
    && operation.name.toUpperCase() !== 'DELETE'
  ));
  if (additions.length !== 1 || removals.length !== 1 || queries.length > 1) return undefined;
  if (!exactOperationContract(
    additions[0],
    argumentFieldId,
    [`absent(${argumentFieldId})`],
    [`add(${argumentFieldId})`],
  ) || !exactOperationContract(
    removals[0],
    argumentFieldId,
    [`present(${argumentFieldId})`],
    [`delete(${argumentFieldId})`],
  ) || (queries[0] && !exactOperationContract(
    queries[0],
    argumentFieldId,
    [],
    [],
  ))) return undefined;
  return {
    argumentFieldId,
    add: additions[0].name,
    remove: removals[0].name,
    ...(queries[0] ? { query: queries[0].name } : {}),
  };
}

function hasUnsafeElementIntegerDomain(spec: ProblemSpecV1): boolean {
  const elementFieldIds = new Set(spec.inputFields
    .filter(field => field.type === 'array' || field.type === 'matrix')
    .map(field => field.id));
  if (elementFieldIds.size === 0) return false;
  return spec.constraints.some(constraint => {
    if (!constraint.machineCheckable) return false;
    const parsed = parseNumericBoundExpression(constraint.expression);
    if (parsed.kind !== 'parsed' || !elementFieldIds.has(parsed.fieldId)) return false;
    return [parsed.bounds.min, parsed.bounds.max].some(bound => (
      bound !== undefined && safeNumberFromIntegerLiteral(bound) === undefined
    ));
  });
}

export function assessGeneratorDslEligibility(spec: ProblemSpecV1): GeneratorDslEligibility {
  if (spec.testCaseMode.kind !== 'single') {
    return { eligible: false, reason: 'COUNTED_TEST_CASES' };
  }
  if (spec.inputFields.some(field => field.type === 'number' || field.type === 'custom')) {
    return { eligible: false, reason: 'UNSUPPORTED_FIELD_TYPE' };
  }
  if (hasUnsafeElementIntegerDomain(spec)) {
    return { eligible: false, reason: 'UNSAFE_ELEMENT_INTEGER_DOMAIN' };
  }
  if (new Set(spec.inputFields.map(field => field.id)).size !== spec.inputFields.length) {
    return { eligible: false, reason: 'AMBIGUOUS_ENCODING' };
  }
  const layouts = resolveLayouts(spec);
  if (!layouts) return { eligible: false, reason: 'UNPARSEABLE_ENCODING' };

  const positions = new Set<string>();
  const dynamicStarts: number[] = [];
  for (const layout of layouts.values()) {
    if (layout.kind === 'scalar') {
      const key = `${layout.line}:${layout.token}`;
      if (positions.has(key)) return { eligible: false, reason: 'AMBIGUOUS_ENCODING' };
      positions.add(key);
    } else if (layout.kind === 'sequence') {
      for (let token = layout.startToken; token < layout.startToken + 2; token += 1) {
        if (positions.has(`${layout.line}:${token}`)) {
          return { eligible: false, reason: 'AMBIGUOUS_ENCODING' };
        }
      }
      dynamicStarts.push(layout.line);
    } else if (layout.kind !== 'operation-argument') {
      dynamicStarts.push(layout.startLine);
    }
  }
  if (dynamicStarts.length > 1) {
    return { eligible: false, reason: 'AMBIGUOUS_ENCODING' };
  }
  const dynamicStart = dynamicStarts[0];
  if (dynamicStart !== undefined && [...layouts.values()].some(layout => (
    layout.kind === 'scalar' && layout.line >= dynamicStart
  ))) return { eligible: false, reason: 'AMBIGUOUS_ENCODING' };
  if (spec.inputFields.some(field => field.type === 'operations')
    && (!spec.operations || spec.operations.length === 0)) {
    return { eligible: false, reason: 'OPERATIONS_NOT_DECLARED' };
  }
  if (spec.inputFields.some(field => field.type === 'operations')
    && !resolveOperationProtocol(spec)) {
    return { eligible: false, reason: 'UNSUPPORTED_OPERATION_PROTOCOL' };
  }
  return { eligible: true };
}

function generatorPlanFailure(): Error {
  return new Error('GeneratorPlan 不符合受信 DSL 严格契约');
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw generatorPlanFailure();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw generatorPlanFailure();
  }
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw generatorPlanFailure();
  return value as number;
}

function signedIntegerValue(value: unknown): number | string {
  if (Number.isSafeInteger(value)) return value as number;
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d*)$/.test(value)) {
    throw generatorPlanFailure();
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw generatorPlanFailure();
  }
  if (parsed < INT64_MIN || parsed > INT64_MAX) throw generatorPlanFailure();
  return value;
}

function positiveSize(value: unknown, max = MAX_SEQUENCE_LENGTH): number {
  const parsed = safeInteger(value);
  if (parsed < 1 || parsed > max) throw generatorPlanFailure();
  return parsed;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw generatorPlanFailure();
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw generatorPlanFailure();
  return value as T;
}

function validateFieldPlan(
  value: unknown,
  field: ProblemSpecV1['inputFields'][number],
): GeneratorFieldPlan {
  const plan = asObject(value);
  const expectedKind = field.type === 'operations' ? 'operation-sequence' : field.type;
  if (plan.kind !== expectedKind) throw generatorPlanFailure();
  if (plan.kind === 'integer') {
    if (Object.prototype.hasOwnProperty.call(plan, 'value')) {
      exactKeys(plan, ['kind', 'value']);
      const parsedValue = plan.value === 'derived' ? 'derived' : signedIntegerValue(plan.value);
      return { kind: 'integer', value: parsedValue };
    }
    exactKeys(plan, ['kind', 'min', 'max']);
    const min = safeInteger(plan.min);
    const max = safeInteger(plan.max);
    if (min > max) throw generatorPlanFailure();
    return { kind: 'integer', min, max };
  }
  if (plan.kind === 'string') {
    exactKeys(plan, ['kind', 'length', 'alphabet', 'pattern']);
    const alphabet = boundedString(plan.alphabet, 128);
    if (/\s/u.test(alphabet) || new Set([...alphabet]).size !== [...alphabet].length) {
      throw generatorPlanFailure();
    }
    return {
      kind: 'string',
      length: positiveSize(plan.length),
      alphabet,
      pattern: oneOf(plan.pattern, ['random', 'same', 'alternating'] as const),
    };
  }
  if (plan.kind === 'array') {
    exactKeys(plan, ['kind', 'length', 'min', 'max', 'pattern']);
    const min = safeInteger(plan.min);
    const max = safeInteger(plan.max);
    if (min > max) throw generatorPlanFailure();
    return {
      kind: 'array', length: positiveSize(plan.length), min, max,
      pattern: oneOf(
        plan.pattern,
        ['random', 'sorted', 'reversed', 'all-equal', 'alternating'] as const,
      ),
    };
  }
  if (plan.kind === 'matrix') {
    exactKeys(plan, ['kind', 'rows', 'columns', 'min', 'max', 'pattern']);
    const rows = positiveSize(plan.rows, 10_000);
    const columns = positiveSize(plan.columns, 10_000);
    if (rows * columns > MAX_SEQUENCE_LENGTH) throw generatorPlanFailure();
    const min = safeInteger(plan.min);
    const max = safeInteger(plan.max);
    if (min > max) throw generatorPlanFailure();
    return {
      kind: 'matrix', rows, columns, min, max,
      pattern: oneOf(
        plan.pattern,
        ['random', 'sorted', 'reversed', 'all-equal', 'alternating'] as const,
      ),
    };
  }
  if (plan.kind === 'permutation') {
    exactKeys(plan, ['kind', 'size', 'pattern']);
    return {
      kind: 'permutation',
      size: positiveSize(plan.size),
      pattern: oneOf(plan.pattern, ['identity', 'reversed', 'random'] as const),
    };
  }
  if (plan.kind === 'tree') {
    exactKeys(plan, ['kind', 'size', 'shape']);
    return {
      kind: 'tree',
      size: positiveSize(plan.size),
      shape: oneOf(plan.shape, ['chain', 'star', 'balanced', 'broom', 'random'] as const),
    };
  }
  if (plan.kind === 'graph') {
    exactKeys(plan, ['kind', 'size', 'shape']);
    const shape = oneOf(
      plan.shape,
      ['sparse', 'near-tree', 'dense', 'bridge', 'cycle'] as const,
    );
    const size = positiveSize(plan.size);
    if (size < 3 || (shape === 'dense' && size > MAX_DENSE_GRAPH_VERTICES)) {
      throw generatorPlanFailure();
    }
    if (shape === 'near-tree' && size < 4) throw generatorPlanFailure();
    if (shape === 'bridge' && size < 6) throw generatorPlanFailure();
    return { kind: 'graph', size, shape };
  }
  if (plan.kind === 'operation-sequence') {
    exactKeys(plan, ['kind', 'length', 'pattern', 'minKey', 'maxKey']);
    const minKey = safeInteger(plan.minKey);
    const maxKey = safeInteger(plan.maxKey);
    if (minKey > maxKey) throw generatorPlanFailure();
    const pattern = oneOf(
      plan.pattern,
      ['add-delete-repeat', 'nested-lifetime', 'query-between-updates'] as const,
    );
    const minimumLength = pattern === 'query-between-updates' ? 3 : 4;
    const length = positiveSize(plan.length);
    if (length < minimumLength) throw generatorPlanFailure();
    if (pattern === 'nested-lifetime' && minKey === maxKey) throw generatorPlanFailure();
    return {
      kind: 'operation-sequence',
      length,
      pattern,
      minKey,
      maxKey,
    };
  }
  throw generatorPlanFailure();
}

function generatorFieldWork(plan: GeneratorFieldPlan): number {
  if (plan.kind === 'integer') return 1;
  if (plan.kind === 'string' || plan.kind === 'array') return plan.length;
  if (plan.kind === 'matrix') return plan.rows * plan.columns;
  if (plan.kind === 'permutation') return plan.size;
  if (plan.kind === 'tree') return plan.size * 2;
  if (plan.kind === 'graph') {
    const edgeWork = plan.shape === 'dense'
      ? plan.size * (plan.size - 1) / 2
      : plan.size + 1;
    return plan.size + edgeWork;
  }
  return plan.length;
}

function validateGeneratorPlan(value: unknown, spec: ProblemSpecV1, expectedCount?: number): GeneratorPlanV1 {
  if (!assessGeneratorDslEligibility(spec).eligible) throw generatorPlanFailure();
  const plan = asObject(value);
  exactKeys(plan, ['version', 'seed', 'cases']);
  if (plan.version !== 1) throw generatorPlanFailure();
  const seed = safeInteger(plan.seed);
  if (seed < 0 || seed > UINT32_MAX) throw generatorPlanFailure();
  if (!Array.isArray(plan.cases)
    || plan.cases.length < 1
    || plan.cases.length > MAX_CASES
    || (expectedCount !== undefined && plan.cases.length !== expectedCount)) {
    throw generatorPlanFailure();
  }
  const fieldIds = spec.inputFields.map(field => field.id);
  const cases = plan.cases.map(rawCase => {
    const caseValue = asObject(rawCase);
    exactKeys(caseValue, ['label', 'subtaskId', 'fields'], ['label', 'fields']);
    const label = boundedString(caseValue.label, MAX_LABEL_LENGTH);
    let subtaskId: number | undefined;
    if (caseValue.subtaskId !== undefined) {
      subtaskId = positiveSize(caseValue.subtaskId, 100);
      if (!spec.subtasks.some(subtask => subtask.id === subtaskId)) {
        throw generatorPlanFailure();
      }
    }
    const rawFields = asObject(caseValue.fields);
    if (Object.keys(rawFields).length !== fieldIds.length
      || fieldIds.some(id => !Object.prototype.hasOwnProperty.call(rawFields, id))
      || Object.keys(rawFields).some(id => !fieldIds.includes(id))) {
      throw generatorPlanFailure();
    }
    const fields = Object.fromEntries(spec.inputFields.map(field => [
      field.id,
      validateFieldPlan(rawFields[field.id], field),
    ]));
    const operationFields = spec.inputFields.filter(field => field.type === 'operations');
    if (operationFields.length > 0) {
      const protocol = resolveOperationProtocol(spec);
      const argumentPlan = protocol ? fields[protocol.argumentFieldId] : undefined;
      if (!protocol || !argumentPlan || argumentPlan.kind !== 'integer'
        || 'value' in argumentPlan) throw generatorPlanFailure();
      for (const operationField of operationFields) {
        const operationPlan = fields[operationField.id];
        if (!operationPlan || operationPlan.kind !== 'operation-sequence'
          || operationPlan.minKey !== argumentPlan.min
          || operationPlan.maxKey !== argumentPlan.max
          || (operationPlan.pattern === 'query-between-updates' && !protocol.query)) {
          throw generatorPlanFailure();
        }
      }
    }
    return { label, ...(subtaskId === undefined ? {} : { subtaskId }), fields };
  });
  let totalWork = 0;
  for (const caseValue of cases) {
    for (const fieldPlan of Object.values(caseValue.fields)) {
      totalWork += generatorFieldWork(fieldPlan);
      if (totalWork > MAX_TOTAL_GENERATOR_WORK) throw generatorPlanFailure();
    }
  }
  return { version: 1, seed, cases };
}

export function parseGeneratorPlan(
  raw: string,
  spec: ProblemSpecV1,
  expectedCount?: number,
): GeneratorPlanV1 {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PLAN_LENGTH) {
    throw generatorPlanFailure();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw generatorPlanFailure();
  }
  const plan = validateGeneratorPlan(parsed, spec, expectedCount);
  materializeValidatedPlan(plan, spec);
  return plan;
}

class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  nextUint32(): number {
    let next = this.state;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    this.state = next >>> 0;
    return this.state;
  }

  integer(min: number, max: number): number {
    if (min === max) return min;
    const span = max - min + 1;
    const fraction = this.nextUint32() / (UINT32_MAX + 1);
    return min + Math.floor(fraction * span);
  }
}

function sequenceValues(
  length: number,
  min: number,
  max: number,
  pattern: SequencePattern,
  random: DeterministicRandom,
): number[] {
  let values: number[];
  if (pattern === 'all-equal') {
    values = Array.from({ length }, () => min);
  } else if (pattern === 'alternating') {
    values = Array.from({ length }, (_, index) => index % 2 === 0 ? min : max);
  } else {
    values = Array.from({ length }, () => random.integer(min, max));
  }
  if (pattern === 'sorted') values.sort((left, right) => left - right);
  if (pattern === 'reversed') values.sort((left, right) => right - left);
  return values;
}

function shuffle<T>(values: T[], random: DeterministicRandom): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(0, index);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function treeEdges(
  size: number,
  shape: Extract<GeneratorFieldPlan, { kind: 'tree' }>['shape'],
  random: DeterministicRandom,
): Array<[number, number]> {
  if (size === 1) return [];
  if (shape === 'chain') {
    return Array.from({ length: size - 1 }, (_, index) => [index + 1, index + 2]);
  }
  if (shape === 'star') {
    return Array.from({ length: size - 1 }, (_, index) => [1, index + 2]);
  }
  if (shape === 'balanced') {
    return Array.from({ length: size - 1 }, (_, index) => [Math.floor((index + 2) / 2), index + 2]);
  }
  if (shape === 'broom') {
    const handleEnd = Math.max(2, Math.ceil(size / 2));
    return [
      ...Array.from({ length: handleEnd - 1 }, (_, index): [number, number] => (
        [index + 1, index + 2]
      )),
      ...Array.from({ length: size - handleEnd }, (_, index): [number, number] => (
        [handleEnd, handleEnd + index + 1]
      )),
    ];
  }
  const edges = Array.from({ length: size - 1 }, (_, index): [number, number] => {
    const child = index + 2;
    return [random.integer(1, child - 1), child];
  });
  return shuffle(edges, random);
}

function graphEdges(
  size: number,
  shape: Extract<GeneratorFieldPlan, { kind: 'graph' }>['shape'],
): Array<[number, number]> {
  const chain = Array.from({ length: size - 1 }, (_, index): [number, number] => (
    [index + 1, index + 2]
  ));
  if (shape === 'sparse') return chain;
  if (shape === 'near-tree') {
    const cycle = [
      ...Array.from({ length: size - 2 }, (_, index): [number, number] => (
        [index + 1, index + 2]
      )),
      [size - 1, 1] as [number, number],
    ];
    return [...cycle, [size - 1, size]];
  }
  if (shape === 'cycle') return [...chain, [size, 1]];
  if (shape === 'dense') {
    const edges: Array<[number, number]> = [];
    for (let left = 1; left <= size; left += 1) {
      for (let right = left + 1; right <= size; right += 1) edges.push([left, right]);
    }
    return edges;
  }
  const split = Math.floor(size / 2);
  const cycle = (start: number, end: number): Array<[number, number]> => [
    ...Array.from({ length: end - start }, (_, index): [number, number] => (
      [start + index, start + index + 1]
    )),
    [end, start],
  ];
  return [...cycle(1, split), ...cycle(split + 1, size), [split, split + 1]];
}

function operationValues(
  plan: Extract<GeneratorFieldPlan, { kind: 'operation-sequence' }>,
  spec: ProblemSpecV1,
  random: DeterministicRandom,
): Array<{ type: string; arguments: number[] }> {
  const names = resolveOperationProtocol(spec);
  if (!names || (plan.pattern === 'query-between-updates' && !names.query)) {
    throw generatorPlanFailure();
  }
  const result: Array<{ type: string; arguments: number[] }> = [];
  const nextKey = () => random.integer(plan.minKey, plan.maxKey);
  if (plan.pattern === 'add-delete-repeat') {
    const key = nextKey();
    while (result.length < plan.length) {
      result.push({ type: names.add, arguments: [key] });
      if (result.length < plan.length) result.push({ type: names.remove, arguments: [key] });
    }
    return result;
  }
  if (plan.pattern === 'query-between-updates') {
    while (result.length < plan.length) {
      const key = nextKey();
      result.push({ type: names.add, arguments: [key] });
      if (result.length < plan.length) {
        result.push({ type: names.query as string, arguments: [key] });
      }
      if (result.length < plan.length) result.push({ type: names.remove, arguments: [key] });
    }
    return result;
  }
  while (result.length < plan.length) {
    const first = nextKey();
    let second = nextKey();
    if (plan.minKey < plan.maxKey) {
      while (second === first) second = nextKey();
    }
    result.push({ type: names.add, arguments: [first] });
    if (result.length < plan.length) result.push({ type: names.add, arguments: [second] });
    if (result.length < plan.length) result.push({ type: names.remove, arguments: [second] });
    if (result.length < plan.length) result.push({ type: names.remove, arguments: [first] });
  }
  return result;
}

function materializeField(
  plan: GeneratorFieldPlan,
  spec: ProblemSpecV1,
  random: DeterministicRandom,
): MaterializedGeneratorValue {
  if (plan.kind === 'integer') {
    const value = 'value' in plan
      ? plan.value === 'derived' ? 0 : plan.value
      : random.integer(plan.min, plan.max);
    return { kind: 'integer', value };
  }
  if (plan.kind === 'string') {
    const alphabet = [...plan.alphabet];
    let value = '';
    for (let index = 0; index < plan.length; index += 1) {
      const alphabetIndex = plan.pattern === 'same' ? 0
        : plan.pattern === 'alternating' ? index % Math.min(2, alphabet.length)
          : random.integer(0, alphabet.length - 1);
      value += alphabet[alphabetIndex];
    }
    return { kind: 'string', value };
  }
  if (plan.kind === 'array') {
    return {
      kind: 'array',
      values: sequenceValues(plan.length, plan.min, plan.max, plan.pattern, random),
    };
  }
  if (plan.kind === 'matrix') {
    const flat = sequenceValues(
      plan.rows * plan.columns,
      plan.min,
      plan.max,
      plan.pattern,
      random,
    );
    return {
      kind: 'matrix',
      values: Array.from({ length: plan.rows }, (_, row) => (
        flat.slice(row * plan.columns, (row + 1) * plan.columns)
      )),
    };
  }
  if (plan.kind === 'permutation') {
    let values = Array.from({ length: plan.size }, (_, index) => index + 1);
    if (plan.pattern === 'reversed') values.reverse();
    if (plan.pattern === 'random') values = shuffle(values, random);
    return { kind: 'permutation', values };
  }
  if (plan.kind === 'tree') {
    return {
      kind: 'tree', vertexCount: plan.size, edges: treeEdges(plan.size, plan.shape, random),
    };
  }
  if (plan.kind === 'graph') {
    return { kind: 'graph', vertexCount: plan.size, edges: graphEdges(plan.size, plan.shape) };
  }
  return { kind: 'operation-sequence', operations: operationValues(plan, spec, random) };
}

function resolveDerivedCounts(
  spec: ProblemSpecV1,
  fields: Record<string, GeneratorFieldPlan>,
  values: Record<string, MaterializedGeneratorValue>,
  layouts: Map<string, FieldLayout>,
): void {
  const expectedByField = new Map<string, number[]>();
  const recordExpected = (fieldId: string, expected: number) => {
    const existing = expectedByField.get(fieldId) || [];
    existing.push(expected);
    expectedByField.set(fieldId, existing);
  };
  for (const field of spec.inputFields) {
    const layout = layouts.get(field.id) as FieldLayout;
    const value = values[field.id];
    if (layout.kind === 'sequence') {
      if (value.kind !== 'array' && value.kind !== 'permutation') throw generatorPlanFailure();
      recordExpected(layout.countFieldId, value.values.length);
    } else if (layout.kind === 'matrix') {
      if (value.kind !== 'matrix') throw generatorPlanFailure();
      recordExpected(layout.rowCountFieldId, value.values.length);
      recordExpected(layout.columnCountFieldId, value.values[0]?.length || 0);
    } else if (layout.kind === 'tree') {
      if (value.kind !== 'tree') throw generatorPlanFailure();
      recordExpected(layout.vertexCountFieldId, value.vertexCount);
    } else if (layout.kind === 'graph') {
      if (value.kind !== 'graph') throw generatorPlanFailure();
      recordExpected(layout.vertexCountFieldId, value.vertexCount);
      recordExpected(layout.edgeCountFieldId, value.edges.length);
    } else if (layout.kind === 'operations') {
      if (value.kind !== 'operation-sequence') throw generatorPlanFailure();
      recordExpected(layout.countFieldId, value.operations.length);
    }
  }
  for (const field of spec.inputFields) {
    const fieldPlan = fields[field.id];
    const current = values[field.id];
    if (!fieldPlan || fieldPlan.kind !== 'integer'
      || !('value' in fieldPlan) || fieldPlan.value !== 'derived') continue;
    const expectedValues = expectedByField.get(field.id);
    if (!expectedValues || expectedValues.length === 0 || current?.kind !== 'integer') {
      throw generatorPlanFailure();
    }
    if (expectedValues.some(expected => expected !== expectedValues[0])) {
      throw generatorPlanFailure();
    }
    current.value = expectedValues[0];
  }
  for (const [fieldId, expectedValues] of expectedByField) {
    const current = values[fieldId];
    if (expectedValues.some(expected => expected !== expectedValues[0])
      || current?.kind !== 'integer'
      || current.value !== expectedValues[0]) {
      throw generatorPlanFailure();
    }
  }
}

function serializeValues(
  spec: ProblemSpecV1,
  values: Record<string, MaterializedGeneratorValue>,
  layouts: Map<string, FieldLayout>,
): string {
  const lines = new Map<number, string[]>();
  const putTokens = (lineNumber: number, startToken: number, tokens: string[]) => {
    const line = lines.get(lineNumber) || [];
    for (let index = 0; index < tokens.length; index += 1) {
      const position = startToken - 1 + index;
      if (line[position] !== undefined) throw generatorPlanFailure();
      line[position] = tokens[index];
    }
    lines.set(lineNumber, line);
  };

  for (const field of spec.inputFields) {
    const layout = layouts.get(field.id) as FieldLayout;
    const value = values[field.id];
    if (layout.kind === 'scalar') {
      if (value.kind !== 'integer' && value.kind !== 'string') throw generatorPlanFailure();
      putTokens(
        layout.line,
        layout.token,
        [String(value.kind === 'integer' ? value.value : value.value)],
      );
    } else if (layout.kind === 'sequence') {
      if (value.kind !== 'array' && value.kind !== 'permutation') throw generatorPlanFailure();
      putTokens(layout.line, layout.startToken, value.values.map(String));
    } else if (layout.kind === 'matrix') {
      if (value.kind !== 'matrix') throw generatorPlanFailure();
      value.values.forEach((row, index) => {
        putTokens(layout.startLine + index, 1, row.map(String));
      });
    } else if (layout.kind === 'tree' || layout.kind === 'graph') {
      if (value.kind !== layout.kind) throw generatorPlanFailure();
      value.edges.forEach((edge, index) => {
        putTokens(layout.startLine + index, 1, edge.map(String));
      });
    } else if (layout.kind === 'operations') {
      if (value.kind !== 'operation-sequence') throw generatorPlanFailure();
      value.operations.forEach((operation, index) => {
        putTokens(
          layout.startLine + index,
          1,
          [operation.type, ...operation.arguments.map(String)],
        );
      });
    }
  }

  const maxLine = Math.max(0, ...lines.keys());
  const serialized = Array.from({ length: maxLine }, (_, index) => {
    const tokens = lines.get(index + 1);
    if (!tokens || tokens.length === 0 || tokens.some(token => token === undefined)) {
      throw generatorPlanFailure();
    }
    return tokens.join(' ');
  }).join('\n') + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) throw generatorPlanFailure();
  return serialized;
}

function materializeValidatedPlan(
  plan: GeneratorPlanV1,
  spec: ProblemSpecV1,
): MaterializedGeneratorCase[] {
  const layouts = resolveLayouts(spec);
  if (!layouts) throw generatorPlanFailure();
  return plan.cases.map((casePlan, caseIndex) => {
    const random = new DeterministicRandom((plan.seed + Math.imul(caseIndex + 1, 0x9e3779b1)) >>> 0);
    const values = Object.fromEntries(spec.inputFields.map(field => [
      field.id,
      materializeField(casePlan.fields[field.id], spec, random),
    ]));
    resolveDerivedCounts(spec, casePlan.fields, values, layouts);
    const input = serializeValues(spec, values, layouts);
    return {
      label: casePlan.label,
      input,
      values,
    };
  });
}

export function materializeGeneratorPlan(
  plan: GeneratorPlanV1,
  spec: ProblemSpecV1,
): MaterializedGeneratorCase[] {
  return materializeValidatedPlan(validateGeneratorPlan(plan, spec), spec);
}

export function renderGeneratorArtifact(
  plan: GeneratorPlanV1,
  cases: readonly MaterializedGeneratorCase[],
): string {
  const publicCases = cases.map(item => ({ label: item.label, input: item.input }));
  const casesJson = JSON.stringify(publicCases);
  return [
    '# Server-generated trusted GeneratorPlan artifact. Do not edit generated cases by hand.',
    `# GeneratorPlan v${plan.version}; seed=${plan.seed}`,
    'import json',
    '',
    `CASES = ${casesJson}`,
    "print(json.dumps({'cases': CASES}, ensure_ascii=False, separators=(',', ':')))",
    '',
  ].join('\n');
}
