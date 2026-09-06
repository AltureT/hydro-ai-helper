import { TestdataPipelineError } from './failures';
import type {
  MaterializedGeneratorCase,
  MaterializedGeneratorValue,
} from './generatorDsl';
import type { ProblemSpecV1 } from './problemSpec';
import type { TestdataReliabilityMode, TestdataRiskTier } from './risk';
import {
  canonicalIntegerLiteral,
  intersectIntegerBounds,
  parseNumericBoundExpression,
  safeNumberFromIntegerLiteral,
  type NumericBounds,
} from './numericBounds';

export type CoverageMode = 'trusted-dsl' | 'ai-generator-unverified';

export type CoverageTargetKey =
  | 'size-min'
  | 'size-mid'
  | 'size-max'
  | 'value-min'
  | 'value-max'
  | 'int32-min'
  | 'int32-max'
  | 'int64-min'
  | 'int64-max'
  | 'ordered'
  | 'reversed'
  | 'all-equal'
  | 'alternating'
  | 'tree-chain'
  | 'tree-star'
  | 'tree-balanced'
  | 'tree-broom'
  | 'graph-sparse'
  | 'graph-near-tree'
  | 'graph-dense'
  | 'graph-bridge'
  | 'graph-cycle'
  | 'operation-add-delete-repeat'
  | 'operation-nested-lifetime'
  | 'operation-query-between-updates'
  | 'subtask-membership';

export interface CoverageTarget {
  targetKey: CoverageTargetKey;
  required: number;
  critical: boolean;
  fieldId?: string;
  subtaskId?: number;
  expected?: number;
  expectedLiteral?: string;
  subtaskIds?: number[];
}

export interface CoverageMatrixEntry {
  targetKey: CoverageTargetKey;
  required: number;
  actual: number;
  status: 'pass' | 'fail';
  critical: boolean;
  fieldId?: string;
  subtaskId?: number;
}

export interface CoverageVerification {
  mode: CoverageMode;
  matrix: CoverageMatrixEntry[];
  totalTargets: number;
  passedTargets: number;
  criticalMissing: number;
  featureExtractionFailed?: boolean;
}

export interface CoverageFeatures {
  sizes: number[];
  valueMin?: number;
  valueMax?: number;
  maxRepeatRatio: number;
  orderedCount: number;
  reversedCount: number;
  allEqualCount: number;
  alternatingCount: number;
  treeDepthMax: number;
  treeDegreeMax: number;
  treeShapeCounts: Record<'chain' | 'star' | 'balanced' | 'broom' | 'random', number>;
  graphDensityMax: number;
  graphBridgeCount: number;
  graphComponentMax: number;
  graphCycleCount: number;
  graphShapeCounts: Record<'sparse' | 'near-tree' | 'dense' | 'bridge' | 'cycle', number>;
  operationTypeCounts: Record<string, number>;
  operationTransitionCounts: Record<string, number>;
  queryBeforeUpdateCounts: number[];
  operationPatternCounts: Record<
  'add-delete-repeat' | 'nested-lifetime' | 'query-between-updates',
  number
  >;
  subtaskIds: number[];
  integerValuesByField: Record<string, number[]>;
  numericValuesByField: Record<string, number[]>;
  integerLiteralsByField: Record<string, string[]>;
  numericLiteralsByField: Record<string, string[]>;
}

const INT32_MIN = '-2147483648';
const INT32_MAX = '2147483647';
const INT64_MIN = '-9223372036854775808';
const INT64_MAX = '9223372036854775807';
const MAX_TOTAL_FEATURE_WORK = 1_000_000;

function boundsByField(
  spec: ProblemSpecV1,
  scope: 'global' | { subtaskId: number },
): Map<string, NumericBounds> {
  const result = new Map<string, NumericBounds>();
  for (const constraint of spec.constraints) {
    if (!constraint.machineCheckable) continue;
    const matchesScope = scope === 'global'
      ? constraint.scope === 'global'
      : typeof constraint.scope === 'object'
        && constraint.scope.subtaskId === scope.subtaskId;
    if (!matchesScope) continue;
    const parsed = parseNumericBoundExpression(constraint.expression);
    if (parsed.kind === 'invalid-bound') throw new Error('invalid numeric bound');
    if (parsed.kind === 'not-bound') continue;
    const merged = intersectIntegerBounds(result.get(parsed.fieldId) || {}, parsed.bounds);
    if (!merged) throw new Error('incompatible numeric bounds');
    result.set(parsed.fieldId, merged);
  }
  return result;
}

function sizeFieldIds(spec: ProblemSpecV1): Set<string> {
  const result = new Set<string>();
  for (const field of spec.inputFields) {
    if (!['string', 'array', 'matrix', 'permutation', 'tree', 'graph', 'operations']
      .includes(field.type)) continue;
    for (const dependency of field.dependsOn || []) result.add(dependency);
  }
  return result;
}

function addBoundaryTargets(
  targets: CoverageTarget[],
  fieldId: string,
  bounds: NumericBounds,
  size: boolean,
  subtaskId?: number,
): void {
  const scope = subtaskId === undefined ? {} : { subtaskId };
  const minNumber = safeNumberFromIntegerLiteral(bounds.min);
  const maxNumber = safeNumberFromIntegerLiteral(bounds.max);
  if (bounds.min !== undefined) {
    if (!size || minNumber !== undefined) {
      targets.push({
        targetKey: size ? 'size-min' : 'value-min',
        required: 1,
        critical: true,
        fieldId,
        ...scope,
        ...(size ? { expected: minNumber } : { expectedLiteral: bounds.min }),
      });
    }
  }
  if (size && minNumber !== undefined && maxNumber !== undefined && minNumber < maxNumber) {
    targets.push({
      targetKey: 'size-mid',
      required: 1,
      critical: false,
      fieldId,
      ...scope,
      expected: Math.floor(minNumber + ((maxNumber - minNumber) / 2)),
    });
  }
  if (bounds.max !== undefined) {
    if (!size || maxNumber !== undefined) {
      targets.push({
        targetKey: size ? 'size-max' : 'value-max',
        required: 1,
        critical: true,
        fieldId,
        ...scope,
        ...(size ? { expected: maxNumber } : { expectedLiteral: bounds.max }),
      });
    }
  }
  const numericBoundaries: Array<[string, CoverageTargetKey]> = [
    [INT32_MIN, 'int32-min'],
    [INT32_MAX, 'int32-max'],
    [INT64_MIN, 'int64-min'],
    [INT64_MAX, 'int64-max'],
  ];
  for (const [boundary, targetKey] of numericBoundaries) {
    if (bounds.min === boundary || bounds.max === boundary) {
      targets.push({
        targetKey,
        required: 1,
        critical: true,
        fieldId,
        ...scope,
        expectedLiteral: boundary,
      });
    }
  }
}

function hasInvariant(
  spec: ProblemSpecV1,
  fieldId: string,
  kind: ProblemSpecV1['invariants'][number]['kind'],
): boolean {
  const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return spec.invariants.some(invariant => invariant.kind === kind
    && new RegExp(`(^|[^A-Za-z0-9_.:-])${escaped}($|[^A-Za-z0-9_.:-])`)
      .test(invariant.expression));
}

export function deriveCoverageTargets(spec: ProblemSpecV1): CoverageTarget[] {
  const targets: CoverageTarget[] = [];
  const bounds = boundsByField(spec, 'global');
  const sizes = sizeFieldIds(spec);
  for (const [fieldId, fieldBounds] of bounds) {
    addBoundaryTargets(targets, fieldId, fieldBounds, sizes.has(fieldId));
  }
  for (const subtask of spec.subtasks) {
    const scopedBounds = boundsByField(spec, { subtaskId: subtask.id });
    for (const [fieldId, fieldBounds] of scopedBounds) {
      const effectiveBounds = intersectIntegerBounds(bounds.get(fieldId) || {}, fieldBounds);
      if (!effectiveBounds) throw new Error('incompatible scoped numeric bounds');
      addBoundaryTargets(
        targets,
        fieldId,
        effectiveBounds,
        sizes.has(fieldId),
        subtask.id,
      );
    }
  }

  for (const field of spec.inputFields) {
    if (field.type === 'array' || field.type === 'matrix') {
      targets.push({ targetKey: 'ordered', required: 1, critical: false, fieldId: field.id });
      if (!hasInvariant(spec, field.id, 'sorted')) {
        targets.push({ targetKey: 'reversed', required: 1, critical: false, fieldId: field.id });
      }
      if (!hasInvariant(spec, field.id, 'unique')) {
        targets.push({ targetKey: 'all-equal', required: 1, critical: false, fieldId: field.id });
      }
      targets.push({ targetKey: 'alternating', required: 1, critical: false, fieldId: field.id });
    } else if (field.type === 'permutation') {
      targets.push({ targetKey: 'ordered', required: 1, critical: false, fieldId: field.id });
      targets.push({ targetKey: 'reversed', required: 1, critical: false, fieldId: field.id });
    } else if (field.type === 'tree') {
      targets.push({ targetKey: 'tree-chain', required: 1, critical: true });
      targets.push({ targetKey: 'tree-star', required: 1, critical: true });
      targets.push({ targetKey: 'tree-balanced', required: 1, critical: false });
      targets.push({ targetKey: 'tree-broom', required: 1, critical: false });
    } else if (field.type === 'graph') {
      targets.push({ targetKey: 'graph-sparse', required: 1, critical: true });
      targets.push({ targetKey: 'graph-near-tree', required: 1, critical: false });
      targets.push({ targetKey: 'graph-dense', required: 1, critical: false });
      targets.push({ targetKey: 'graph-bridge', required: 1, critical: true });
      targets.push({ targetKey: 'graph-cycle', required: 1, critical: true });
    } else if (field.type === 'operations') {
      targets.push({ targetKey: 'operation-add-delete-repeat', required: 1, critical: true });
      targets.push({ targetKey: 'operation-nested-lifetime', required: 1, critical: true });
      if ((spec.operations || []).some(operation => !['ADD', 'DEL', 'DELETE']
        .includes(operation.name.toUpperCase()))) {
        targets.push({
          targetKey: 'operation-query-between-updates', required: 1, critical: true,
        });
      }
    }
  }
  if (spec.subtasks.length > 0) {
    targets.push({
      targetKey: 'subtask-membership',
      required: spec.subtasks.length,
      critical: true,
      subtaskIds: spec.subtasks.map(subtask => subtask.id),
    });
  }
  return targets;
}

function increment(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] || 0) + amount;
}

function appendNumericValues(
  target: Record<string, number[]>,
  fieldId: string,
  values: readonly number[],
): void {
  if (values.some(value => !Number.isSafeInteger(value))) throw new Error('invalid numeric value');
  const existing = target[fieldId] || [];
  for (const value of values) existing.push(value);
  target[fieldId] = existing;
}

function appendIntegerLiterals(
  target: Record<string, string[]>,
  fieldId: string,
  values: readonly (number | string)[],
): void {
  const literals = values.map(value => canonicalIntegerLiteral(String(value)));
  if (literals.some(value => value === undefined)) throw new Error('invalid integer literal');
  const existing = target[fieldId] || [];
  for (const literal of literals as string[]) existing.push(literal);
  target[fieldId] = existing;
}

function sequenceCharacteristics(values: readonly number[]): {
  repeatRatio: number;
  ordered: boolean;
  reversed: boolean;
  allEqual: boolean;
  alternating: boolean;
} {
  if (values.length === 0) throw new Error('empty sequence');
  const frequencies = new Map<number, number>();
  for (const value of values) frequencies.set(value, (frequencies.get(value) || 0) + 1);
  let maxFrequency = 0;
  for (const count of frequencies.values()) maxFrequency = Math.max(maxFrequency, count);
  const ordered = values.every((value, index) => index === 0 || values[index - 1] <= value);
  const reversed = values.every((value, index) => index === 0 || values[index - 1] >= value);
  const allEqual = frequencies.size === 1;
  const alternating = values.length >= 2
    && values[0] !== values[1]
    && values.every((value, index) => value === values[index % 2]);
  return {
    repeatRatio: maxFrequency / values.length,
    ordered,
    reversed,
    allEqual,
    alternating,
  };
}

function adjacencyFor(
  vertexCount: number,
  edges: readonly [number, number][],
): number[][] {
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 1) throw new Error('invalid vertices');
  const adjacency = Array.from({ length: vertexCount + 1 }, () => [] as number[]);
  const keys = new Set<string>();
  for (const edge of edges) {
    if (!Array.isArray(edge) || edge.length !== 2) throw new Error('invalid edge');
    const [left, right] = edge;
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)
      || left < 1 || right < 1 || left > vertexCount || right > vertexCount || left === right) {
      throw new Error('invalid edge');
    }
    const key = left < right ? `${left}:${right}` : `${right}:${left}`;
    if (keys.has(key)) throw new Error('duplicate edge');
    keys.add(key);
    adjacency[left].push(right);
    adjacency[right].push(left);
  }
  return adjacency;
}

function graphMetrics(
  vertexCount: number,
  edges: readonly [number, number][],
): {
  components: number;
  hasCycle: boolean;
  hasBridge: boolean;
  maxDegree: number;
  depthFromOne: number;
} {
  const adjacency = adjacencyFor(vertexCount, edges);
  let components = 0;
  const seen = new Set<number>();
  for (let start = 1; start <= vertexCount; start += 1) {
    if (seen.has(start)) continue;
    components += 1;
    const queue = [start];
    seen.add(start);
    for (let index = 0; index < queue.length; index += 1) {
      for (const next of adjacency[queue[index]]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }

  const parent = Array.from({ length: vertexCount + 1 }, (_, index) => index);
  const rank = Array.from({ length: vertexCount + 1 }, () => 0);
  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) root = parent[root];
    let vertex = start;
    while (parent[vertex] !== vertex) {
      const next = parent[vertex];
      parent[vertex] = root;
      vertex = next;
    }
    return root;
  };
  let hasCycle = false;
  for (const [left, right] of edges) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) hasCycle = true;
    else if (rank[leftRoot] < rank[rightRoot]) parent[leftRoot] = rightRoot;
    else if (rank[leftRoot] > rank[rightRoot]) parent[rightRoot] = leftRoot;
    else {
      parent[rightRoot] = leftRoot;
      rank[leftRoot] += 1;
    }
  }

  let clock = 0;
  let hasBridge = false;
  const discovery = Array.from({ length: vertexCount + 1 }, () => 0);
  const low = Array.from({ length: vertexCount + 1 }, () => 0);
  const dfsParent = Array.from({ length: vertexCount + 1 }, () => 0);
  const nextNeighbourIndex = Array.from({ length: vertexCount + 1 }, () => 0);
  for (let start = 1; start <= vertexCount; start += 1) {
    if (discovery[start] !== 0) continue;
    clock += 1;
    discovery[start] = clock;
    low[start] = clock;
    const stack = [start];
    while (stack.length > 0) {
      const vertex = stack[stack.length - 1];
      const neighbourIndex = nextNeighbourIndex[vertex];
      if (neighbourIndex < adjacency[vertex].length) {
        const next = adjacency[vertex][neighbourIndex];
        nextNeighbourIndex[vertex] += 1;
        if (next === dfsParent[vertex]) continue;
        if (discovery[next] === 0) {
          dfsParent[next] = vertex;
          clock += 1;
          discovery[next] = clock;
          low[next] = clock;
          stack.push(next);
        } else {
          low[vertex] = Math.min(low[vertex], discovery[next]);
        }
      } else {
        stack.pop();
        const from = dfsParent[vertex];
        if (from !== 0) {
          low[from] = Math.min(low[from], low[vertex]);
          if (low[vertex] > discovery[from]) hasBridge = true;
        }
      }
    }
  }

  const distance = Array.from({ length: vertexCount + 1 }, () => -1);
  distance[1] = 0;
  const queue = [1];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency[queue[index]]) {
      if (distance[next] < 0) {
        distance[next] = distance[queue[index]] + 1;
        queue.push(next);
      }
    }
  }
  let maxDegree = 0;
  for (const neighbours of adjacency) maxDegree = Math.max(maxDegree, neighbours.length);
  let depthFromOne = 0;
  for (const value of distance) depthFromOne = Math.max(depthFromOne, value);
  return {
    components,
    hasCycle,
    hasBridge,
    maxDegree,
    depthFromOne,
  };
}

function classifyTreeShape(
  vertexCount: number,
  edges: readonly [number, number][],
  metrics: ReturnType<typeof graphMetrics>,
): 'chain' | 'star' | 'balanced' | 'broom' | 'random' {
  if (metrics.maxDegree === vertexCount - 1) return 'star';
  if (metrics.maxDegree <= 2) return 'chain';
  const balancedKeys = new Set(Array.from({ length: vertexCount - 1 }, (_, index) => {
    const child = index + 2;
    const parent = Math.floor(child / 2);
    return `${parent}:${child}`;
  }));
  const actualKeys = new Set(edges.map(([left, right]) => (
    left < right ? `${left}:${right}` : `${right}:${left}`
  )));
  if (balancedKeys.size === actualKeys.size
    && [...balancedKeys].every(key => actualKeys.has(key))) return 'balanced';
  const adjacency = adjacencyFor(vertexCount, edges);
  const highDegreeCount = adjacency.filter(neighbours => neighbours.length > 2).length;
  const pathVertexCount = adjacency.filter(neighbours => neighbours.length === 2).length;
  if (highDegreeCount === 1 && pathVertexCount > 0) return 'broom';
  return 'random';
}

function operationFeatures(
  operations: Extract<MaterializedGeneratorValue, { kind: 'operation-sequence' }>['operations'],
): {
  types: Record<string, number>;
  transitions: Record<string, number>;
  queryBeforeUpdates: number[];
  patterns: Record<'add-delete-repeat' | 'nested-lifetime' | 'query-between-updates', boolean>;
} {
  const types: Record<string, number> = {};
  const transitions: Record<string, number> = {};
  const queryBeforeUpdates: number[] = [];
  const normalizedTypes = operations.map(operation => {
    if (!operation || typeof operation.type !== 'string'
      || !Array.isArray(operation.arguments)
      || operation.arguments.some(value => !Number.isSafeInteger(value))) {
      throw new Error('invalid operation');
    }
    return operation.type.toUpperCase();
  });
  const hasUpdateAfter = Array.from({ length: operations.length }, () => false);
  let laterUpdate = false;
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    hasUpdateAfter[index] = laterUpdate;
    if (['ADD', 'DEL', 'DELETE'].includes(normalizedTypes[index])) laterUpdate = true;
  }
  const activeAdds = new Map<number, number>();
  const removalByAddIndex = Array<number | undefined>(operations.length);
  let updateCount = 0;
  let addDeleteRepeat = false;
  const completedLifetimeKeys = new Set<number>();
  let queryBetweenUpdates = false;
  operations.forEach((operation, index) => {
    const type = normalizedTypes[index];
    increment(types, type);
    if (index > 0) increment(transitions, `${normalizedTypes[index - 1]}->${type}`);
    const key = operation.arguments[0];
    if (type === 'ADD') {
      updateCount += 1;
      if (completedLifetimeKeys.has(key)) addDeleteRepeat = true;
      if (activeAdds.has(key)) throw new Error('duplicate active key');
      activeAdds.set(key, index);
    } else if (type === 'DEL' || type === 'DELETE') {
      updateCount += 1;
      const addIndex = activeAdds.get(key);
      if (addIndex === undefined) throw new Error('delete without active key');
      removalByAddIndex[addIndex] = index;
      activeAdds.delete(key);
      completedLifetimeKeys.add(key);
    } else {
      queryBeforeUpdates.push(updateCount);
      if (updateCount > 0 && hasUpdateAfter[index]) queryBetweenUpdates = true;
    }
  });
  let maxRemoval = -1;
  let nestedLifetime = false;
  for (const removal of removalByAddIndex) {
    if (removal === undefined) continue;
    if (removal < maxRemoval) nestedLifetime = true;
    maxRemoval = Math.max(maxRemoval, removal);
  }
  return {
    types,
    transitions,
    queryBeforeUpdates,
    patterns: {
      'add-delete-repeat': operations.length >= 4 && addDeleteRepeat,
      'nested-lifetime': operations.length >= 4 && nestedLifetime,
      'query-between-updates': operations.length >= 3 && queryBetweenUpdates,
    },
  };
}

export function computeCoverageFeatures(
  cases: readonly MaterializedGeneratorCase[],
  spec?: ProblemSpecV1,
): CoverageFeatures {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('no structured cases');
  let totalWork = 0;
  for (const caseValue of cases) {
    if (!caseValue || typeof caseValue !== 'object'
      || !caseValue.values || typeof caseValue.values !== 'object') throw new Error('case values');
    for (const rawValue of Object.values(caseValue.values)) {
      if (!rawValue || typeof rawValue !== 'object') throw new Error('invalid structured value');
      const value = rawValue as MaterializedGeneratorValue;
      if (value.kind === 'integer') totalWork += 1;
      else if (value.kind === 'string') totalWork += value.value.length;
      else if (value.kind === 'array' || value.kind === 'permutation') {
        totalWork += value.values.length;
      } else if (value.kind === 'matrix') {
        totalWork += value.values.reduce((sum, row) => sum + row.length, 0);
      } else if (value.kind === 'tree' || value.kind === 'graph') {
        totalWork += value.vertexCount + value.edges.length;
      } else if (value.kind === 'operation-sequence') totalWork += value.operations.length;
      else throw new Error('unsupported structured value');
      if (totalWork > MAX_TOTAL_FEATURE_WORK) {
        throw new Error('structured feature work budget exceeded');
      }
    }
  }
  const features: CoverageFeatures = {
    sizes: [],
    maxRepeatRatio: 0,
    orderedCount: 0,
    reversedCount: 0,
    allEqualCount: 0,
    alternatingCount: 0,
    treeDepthMax: 0,
    treeDegreeMax: 0,
    treeShapeCounts: { chain: 0, star: 0, balanced: 0, broom: 0, random: 0 },
    graphDensityMax: 0,
    graphBridgeCount: 0,
    graphComponentMax: 0,
    graphCycleCount: 0,
    graphShapeCounts: { sparse: 0, 'near-tree': 0, dense: 0, bridge: 0, cycle: 0 },
    operationTypeCounts: {},
    operationTransitionCounts: {},
    queryBeforeUpdateCounts: [],
    operationPatternCounts: {
      'add-delete-repeat': 0,
      'nested-lifetime': 0,
      'query-between-updates': 0,
    },
    subtaskIds: [],
    integerValuesByField: {},
    numericValuesByField: {},
    integerLiteralsByField: {},
    numericLiteralsByField: {},
  };
  const allNumericValues: number[] = [];
  const subtaskIds = new Set<number>();
  const operationArgumentFields = spec?.inputFields.filter(field => (
    field.type === 'integer' && field.encoding === `operation-argument:${field.id}`
  )) || [];
  const operationArgumentFieldId = operationArgumentFields.length === 1
    ? operationArgumentFields[0].id
    : undefined;

  for (const caseValue of cases) {
    if (!caseValue || typeof caseValue !== 'object'
      || !caseValue.values || typeof caseValue.values !== 'object') throw new Error('case values');
    if (caseValue.subtaskId !== undefined) subtaskIds.add(caseValue.subtaskId);
    for (const [fieldId, rawValue] of Object.entries(caseValue.values)) {
      if (!rawValue || typeof rawValue !== 'object'
        || typeof (rawValue as { kind?: unknown }).kind !== 'string') {
        throw new Error('invalid structured value');
      }
      const value = rawValue as MaterializedGeneratorValue;
      if (value.kind === 'integer') {
        if (fieldId !== operationArgumentFieldId) {
          appendIntegerLiterals(features.integerLiteralsByField, fieldId, [value.value]);
          appendIntegerLiterals(features.numericLiteralsByField, fieldId, [value.value]);
        }
        if (typeof value.value === 'number') {
          if (!Number.isSafeInteger(value.value)) throw new Error('invalid integer');
          if (fieldId !== operationArgumentFieldId) {
            appendNumericValues(features.integerValuesByField, fieldId, [value.value]);
            appendNumericValues(features.numericValuesByField, fieldId, [value.value]);
            allNumericValues.push(value.value);
          }
          features.sizes.push(value.value);
        }
      } else if (value.kind === 'string') {
        if (typeof value.value !== 'string') throw new Error('invalid string');
        features.sizes.push([...value.value].length);
      } else if (value.kind === 'array' || value.kind === 'permutation') {
        appendNumericValues(features.numericValuesByField, fieldId, value.values);
        appendIntegerLiterals(features.numericLiteralsByField, fieldId, value.values);
        for (const number of value.values) allNumericValues.push(number);
        features.sizes.push(value.values.length);
        const sequence = sequenceCharacteristics(value.values);
        features.maxRepeatRatio = Math.max(features.maxRepeatRatio, sequence.repeatRatio);
        if (sequence.ordered) features.orderedCount += 1;
        if (sequence.reversed) features.reversedCount += 1;
        if (sequence.allEqual) features.allEqualCount += 1;
        if (sequence.alternating) features.alternatingCount += 1;
      } else if (value.kind === 'matrix') {
        if (!Array.isArray(value.values) || value.values.length === 0
          || value.values.some(row => !Array.isArray(row) || row.length === 0
            || row.length !== value.values[0].length)) throw new Error('invalid matrix');
        const flat = value.values.flat();
        appendNumericValues(features.numericValuesByField, fieldId, flat);
        appendIntegerLiterals(features.numericLiteralsByField, fieldId, flat);
        for (const number of flat) allNumericValues.push(number);
        features.sizes.push(value.values.length, value.values[0].length);
        const sequence = sequenceCharacteristics(flat);
        features.maxRepeatRatio = Math.max(features.maxRepeatRatio, sequence.repeatRatio);
        if (sequence.ordered) features.orderedCount += 1;
        if (sequence.reversed) features.reversedCount += 1;
        if (sequence.allEqual) features.allEqualCount += 1;
        if (sequence.alternating) features.alternatingCount += 1;
      } else if (value.kind === 'tree') {
        if (value.edges.length !== value.vertexCount - 1) throw new Error('invalid tree count');
        const metrics = graphMetrics(value.vertexCount, value.edges);
        if (metrics.components !== 1 || metrics.hasCycle) throw new Error('invalid tree');
        features.sizes.push(value.vertexCount);
        features.treeDepthMax = Math.max(features.treeDepthMax, metrics.depthFromOne);
        features.treeDegreeMax = Math.max(features.treeDegreeMax, metrics.maxDegree);
        increment(
          features.treeShapeCounts,
          classifyTreeShape(value.vertexCount, value.edges, metrics),
        );
      } else if (value.kind === 'graph') {
        const metrics = graphMetrics(value.vertexCount, value.edges);
        const possibleEdges = value.vertexCount * (value.vertexCount - 1) / 2;
        const density = possibleEdges === 0 ? 0 : value.edges.length / possibleEdges;
        features.sizes.push(value.vertexCount);
        features.graphDensityMax = Math.max(features.graphDensityMax, density);
        features.graphComponentMax = Math.max(features.graphComponentMax, metrics.components);
        if (metrics.hasBridge) {
          features.graphBridgeCount += 1;
          features.graphShapeCounts.bridge += 1;
        }
        if (metrics.hasCycle) {
          features.graphCycleCount += 1;
        }
        if (value.edges.length <= value.vertexCount - 1) features.graphShapeCounts.sparse += 1;
        const connectedUnicyclic = metrics.components === 1
          && metrics.hasCycle
          && value.edges.length === value.vertexCount;
        if (connectedUnicyclic && metrics.maxDegree === 2) {
          features.graphShapeCounts.cycle += 1;
        } else if (connectedUnicyclic && metrics.maxDegree >= 3) {
          features.graphShapeCounts['near-tree'] += 1;
        }
        if (density >= 0.75) features.graphShapeCounts.dense += 1;
      } else if (value.kind === 'operation-sequence') {
        if (operationArgumentFieldId !== undefined) {
          if (value.operations.some(operation => operation.arguments.length !== 1)) {
            throw new Error('invalid operation arity');
          }
          const serializedArguments = value.operations.map(operation => operation.arguments[0]);
          appendNumericValues(
            features.integerValuesByField,
            operationArgumentFieldId,
            serializedArguments,
          );
          appendNumericValues(
            features.numericValuesByField,
            operationArgumentFieldId,
            serializedArguments,
          );
          appendIntegerLiterals(
            features.integerLiteralsByField,
            operationArgumentFieldId,
            serializedArguments,
          );
          appendIntegerLiterals(
            features.numericLiteralsByField,
            operationArgumentFieldId,
            serializedArguments,
          );
          for (const number of serializedArguments) allNumericValues.push(number);
        }
        features.sizes.push(value.operations.length);
        const operation = operationFeatures(value.operations);
        for (const [type, count] of Object.entries(operation.types)) {
          increment(features.operationTypeCounts, type, count);
        }
        for (const [transition, count] of Object.entries(operation.transitions)) {
          increment(features.operationTransitionCounts, transition, count);
        }
        for (const count of operation.queryBeforeUpdates) features.queryBeforeUpdateCounts.push(count);
        for (const [pattern, present] of Object.entries(operation.patterns)) {
          if (present) increment(features.operationPatternCounts, pattern);
        }
      } else {
        throw new Error('unsupported structured value');
      }
    }
  }
  if (allNumericValues.length > 0) {
    features.valueMin = allNumericValues[0];
    features.valueMax = allNumericValues[0];
    for (const value of allNumericValues) {
      features.valueMin = Math.min(features.valueMin, value);
      features.valueMax = Math.max(features.valueMax, value);
    }
  }
  features.subtaskIds = [...subtaskIds].sort((left, right) => left - right);
  return features;
}

function targetActual(target: CoverageTarget, features: CoverageFeatures): number {
  if (target.targetKey === 'subtask-membership') {
    const required = new Set(target.subtaskIds || []);
    return features.subtaskIds.filter(id => required.has(id)).length;
  }
  if (target.expectedLiteral !== undefined && target.fieldId) {
    const values = features.numericLiteralsByField[target.fieldId];
    return values?.includes(target.expectedLiteral) ? 1 : 0;
  }
  if (target.expected !== undefined && target.fieldId) {
    const values = target.targetKey.startsWith('size-')
      ? features.integerValuesByField[target.fieldId]
      : features.numericValuesByField[target.fieldId];
    return values?.includes(target.expected) ? 1 : 0;
  }
  const counts: Partial<Record<CoverageTargetKey, number>> = {
    ordered: features.orderedCount,
    reversed: features.reversedCount,
    'all-equal': features.allEqualCount,
    alternating: features.alternatingCount,
    'tree-chain': features.treeShapeCounts.chain,
    'tree-star': features.treeShapeCounts.star,
    'tree-balanced': features.treeShapeCounts.balanced,
    'tree-broom': features.treeShapeCounts.broom,
    'graph-sparse': features.graphShapeCounts.sparse,
    'graph-near-tree': features.graphShapeCounts['near-tree'],
    'graph-dense': features.graphShapeCounts.dense,
    'graph-bridge': features.graphShapeCounts.bridge,
    'graph-cycle': features.graphShapeCounts.cycle,
    'operation-add-delete-repeat': features.operationPatternCounts['add-delete-repeat'],
    'operation-nested-lifetime': features.operationPatternCounts['nested-lifetime'],
    'operation-query-between-updates': features.operationPatternCounts['query-between-updates'],
  };
  return counts[target.targetKey] || 0;
}

export function evaluateSemanticCoverage(input: {
  spec: ProblemSpecV1;
  cases?: readonly MaterializedGeneratorCase[];
  coverageMode: CoverageMode;
}): CoverageVerification {
  if (input.coverageMode !== 'trusted-dsl' || !input.cases) {
    return {
      mode: 'ai-generator-unverified',
      matrix: [],
      totalTargets: 0,
      passedTargets: 0,
      criticalMissing: 0,
    };
  }
  try {
    const features = computeCoverageFeatures(input.cases, input.spec);
    const targets = deriveCoverageTargets(input.spec);
    const scopedFeatures = new Map<number, CoverageFeatures>();
    const featuresForTarget = (target: CoverageTarget): CoverageFeatures | undefined => {
      if (target.subtaskId === undefined) return features;
      if (scopedFeatures.has(target.subtaskId)) return scopedFeatures.get(target.subtaskId);
      const scopedCases = input.cases?.filter(item => item.subtaskId === target.subtaskId) || [];
      if (scopedCases.length === 0) return undefined;
      const computed = computeCoverageFeatures(scopedCases, input.spec);
      scopedFeatures.set(target.subtaskId, computed);
      return computed;
    };
    const matrix = targets.map((target): CoverageMatrixEntry => {
      const scoped = featuresForTarget(target);
      const actual = scoped ? targetActual(target, scoped) : 0;
      return {
        targetKey: target.targetKey,
        required: target.required,
        actual,
        status: actual >= target.required ? 'pass' : 'fail',
        critical: target.critical,
        ...(target.fieldId === undefined ? {} : { fieldId: target.fieldId }),
        ...(target.subtaskId === undefined ? {} : { subtaskId: target.subtaskId }),
      };
    });
    return {
      mode: 'trusted-dsl',
      matrix,
      totalTargets: matrix.reduce((total, row) => total + row.required, 0),
      passedTargets: matrix.reduce(
        (total, row) => total + Math.min(row.actual, row.required),
        0,
      ),
      criticalMissing: matrix.reduce((total, row) => (
        total + (row.critical ? Math.max(0, row.required - row.actual) : 0)
      ), 0),
    };
  } catch {
    return {
      mode: 'ai-generator-unverified',
      matrix: [],
      totalTargets: 0,
      passedTargets: 0,
      criticalMissing: 0,
      featureExtractionFailed: true,
    };
  }
}

export function enforceCoverageRequirements(
  coverage: CoverageVerification,
  riskTier: TestdataRiskTier,
  reliabilityMode: TestdataReliabilityMode,
): void {
  if (coverage.mode !== 'trusted-dsl'
    || coverage.criticalMissing === 0
    || riskTier !== 'high'
    || reliabilityMode !== 'enforce') return;
  throw new TestdataPipelineError(
    '高风险题目的受信生成器计划缺少关键语义覆盖目标。',
    'COVERAGE_REQUIREMENT_MISSING',
    'generator',
    'coverage',
    'repair-artifact',
    { missingCount: coverage.criticalMissing },
  );
}
