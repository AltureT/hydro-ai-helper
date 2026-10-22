import {
  assessGeneratorDslEligibility,
  materializeGeneratorPlan,
  parseGeneratorPlan,
  renderGeneratorArtifact,
  type GeneratorFieldPlan,
  type GeneratorPlanV1,
  type MaterializedGeneratorCase,
} from '../../services/testdata/generatorDsl';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';

const HASH = '1'.repeat(64);

function specWithFields(
  inputFields: ProblemSpecV1['inputFields'],
  extra: Partial<ProblemSpecV1> = {},
): ProblemSpecV1 {
  return {
    schemaVersion: 1,
    statementHash: HASH,
    problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields,
    constraints: [],
    invariants: [],
    outputPolicy: { kind: 'exact' },
    subtasks: [],
    uncertainties: [],
    ...extra,
  };
}

const scalarSpec = specWithFields([
  { id: 'x', name: 'x', type: 'integer', encoding: 'line:1 token:1' },
  { id: 's', name: 's', type: 'string', encoding: 'line:2 token:1' },
]);

const sequenceSpec = specWithFields([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  {
    id: 'a', name: 'a', type: 'array', encoding: 'line:2 tokens:1..n', dependsOn: ['n'],
  },
]);

const permutationSpec = specWithFields([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  {
    id: 'p', name: 'p', type: 'permutation', encoding: 'line:2 tokens:1..n', dependsOn: ['n'],
  },
]);

const matrixSpec = specWithFields([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  { id: 'm', name: 'm', type: 'integer', encoding: 'line:1 token:2' },
  {
    id: 'grid', name: 'grid', type: 'matrix',
    encoding: 'lines:2..n+1 tokens:1..m', dependsOn: ['n', 'm'],
  },
]);

const treeSpec = specWithFields([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  {
    id: 'tree', name: 'tree', type: 'tree', encoding: 'lines:2..n tokens:1,2', dependsOn: ['n'],
  },
]);

const graphSpec = specWithFields([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  { id: 'm', name: 'm', type: 'integer', encoding: 'line:1 token:2' },
  {
    id: 'graph', name: 'graph', type: 'graph',
    encoding: 'lines:2..m+1 tokens:1,2', dependsOn: ['n', 'm'],
  },
]);

const operationSpec = specWithFields([
  { id: 'q', name: 'q', type: 'integer', encoding: 'line:1 token:1' },
  { id: 'x', name: 'x', type: 'integer', encoding: 'operation-argument:x' },
  {
    id: 'ops', name: 'ops', type: 'operations',
    encoding: 'lines:2..q+1 operations', dependsOn: ['q'],
  },
], {
  operations: [
    { name: 'ADD', arguments: ['x'], preconditions: ['absent(x)'], effects: ['add(x)'] },
    { name: 'DEL', arguments: ['x'], preconditions: ['present(x)'], effects: ['delete(x)'] },
    { name: 'QUERY', arguments: ['x'], preconditions: [], effects: [] },
  ],
});

function planFor(
  fields: Record<string, GeneratorFieldPlan>,
  seed = 17,
): GeneratorPlanV1 {
  return { version: 1, seed, cases: [{ label: 'case-1', fields }] };
}

function onlyCase(
  spec: ProblemSpecV1,
  fields: Record<string, GeneratorFieldPlan>,
  seed = 17,
): MaterializedGeneratorCase {
  return materializeGeneratorPlan(planFor(fields, seed), spec)[0];
}

function edgeKey([left, right]: [number, number]): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function expectSimpleConnected(
  vertexCount: number,
  edges: Array<[number, number]>,
): void {
  expect(edges.every(([left, right]) => left !== right)).toBe(true);
  expect(new Set(edges.map(edgeKey)).size).toBe(edges.length);
  const adjacency = Array.from({ length: vertexCount + 1 }, () => [] as number[]);
  for (const [left, right] of edges) {
    expect(left).toBeGreaterThanOrEqual(1);
    expect(right).toBeGreaterThanOrEqual(1);
    expect(left).toBeLessThanOrEqual(vertexCount);
    expect(right).toBeLessThanOrEqual(vertexCount);
    adjacency[left].push(right);
    adjacency[right].push(left);
  }
  const seen = new Set<number>([1]);
  const queue = [1];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency[queue[index]]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  expect(seen.size).toBe(vertexCount);
}

describe('trusted generator DSL eligibility and strict parsing', () => {
  it.each([
    ['scalar', scalarSpec],
    ['array', sequenceSpec],
    ['permutation', permutationSpec],
    ['matrix', matrixSpec],
    ['tree', treeSpec],
    ['graph', graphSpec],
    ['operation sequence', operationSpec],
  ])('accepts a deterministic %s grammar', (_label, spec) => {
    expect(assessGeneratorDslEligibility(spec)).toEqual({ eligible: true });
  });

  it.each([
    ['counted cases', { ...scalarSpec, testCaseMode: { kind: 'counted', countField: 'x' } }],
    ['custom field', specWithFields([
      { id: 'raw', name: 'raw', type: 'custom', encoding: 'anything' },
    ])],
    ['ambiguous location', specWithFields([
      { id: 'a', name: 'a', type: 'integer', encoding: 'line:1 token:1' },
      { id: 'b', name: 'b', type: 'integer', encoding: 'line:1 token:1' },
    ])],
    ['unparseable matrix', specWithFields([
      { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
      { id: 'm', name: 'm', type: 'integer', encoding: 'line:1 token:2' },
      { id: 'grid', name: 'grid', type: 'matrix', encoding: 'n rows', dependsOn: ['n', 'm'] },
    ])],
  ])('rejects %s instead of guessing serialization', (_label, spec) => {
    expect(assessGeneratorDslEligibility(spec as ProblemSpecV1).eligible).toBe(false);
  });

  it.each([
    [
      'array',
      sequenceSpec,
      '-9223372036854775808 <= a[i] <= 9223372036854775807',
    ],
    [
      'matrix',
      matrixSpec,
      '-9223372036854775808 <= grid[i][j] <= 9223372036854775807',
    ],
  ])('rejects a non-safe %s element domain before trusted materialization', (
    _label,
    base,
    expression,
  ) => {
    const spec: ProblemSpecV1 = {
      ...base,
      constraints: [{
        id: 'C_INT64_ELEMENT', expression, machineCheckable: true,
        scope: 'global', evidence: { quote: expression },
      }],
    };

    expect(assessGeneratorDslEligibility(spec)).toEqual({
      eligible: false,
      reason: 'UNSAFE_ELEMENT_INTEGER_DOMAIN',
    });
  });

  it.each([
    [
      'array',
      sequenceSpec,
      '-9223372036854775808<=a[i]<=9223372036854775807',
    ],
    [
      'matrix',
      matrixSpec,
      '-9223372036854775808<=grid[i][j]<=9223372036854775807',
    ],
  ])('rejects a compact non-safe %s element domain', (_label, base, expression) => {
    const spec: ProblemSpecV1 = {
      ...base,
      constraints: [{
        id: 'C_COMPACT_INT64_ELEMENT', expression, machineCheckable: true,
        scope: 'global', evidence: { quote: expression },
      }],
    };

    expect(assessGeneratorDslEligibility(spec)).toEqual({
      eligible: false,
      reason: 'UNSAFE_ELEMENT_INTEGER_DOMAIN',
    });
  });

  it('keeps an exact signed 64-bit scalar domain eligible', () => {
    const expression = '-9223372036854775808 <= x <= 9223372036854775807';
    const spec: ProblemSpecV1 = {
      ...scalarSpec,
      constraints: [{
        id: 'C_INT64_SCALAR', expression, machineCheckable: true,
        scope: 'global', evidence: { quote: expression },
      }],
    };

    expect(assessGeneratorDslEligibility(spec)).toEqual({ eligible: true });
  });

  it.each([
    [
      'two operation argument fields',
      {
        inputFields: [
          ...operationSpec.inputFields,
          { id: 'y', name: 'y', type: 'integer' as const, encoding: 'operation-argument:y' },
        ],
      },
    ],
    [
      'an extra read operation',
      {
        operations: [
          ...(operationSpec.operations || []),
          { name: 'PEEK', arguments: ['x'], preconditions: [], effects: [] },
        ],
      },
    ],
    [
      'the wrong ADD argument',
      {
        operations: (operationSpec.operations || []).map(operation => (
          operation.name === 'ADD' ? { ...operation, arguments: ['other'] } : operation
        )),
      },
    ],
    [
      'ambiguous ADD preconditions',
      {
        operations: (operationSpec.operations || []).map(operation => (
          operation.name === 'ADD'
            ? { ...operation, preconditions: ['absent(x)', 'x >= 0'] }
            : operation
        )),
      },
    ],
    [
      'the wrong delete effect',
      {
        operations: (operationSpec.operations || []).map(operation => (
          operation.name === 'DEL' ? { ...operation, effects: ['remove(x)'] } : operation
        )),
      },
    ],
    [
      'a mutating query',
      {
        operations: (operationSpec.operations || []).map(operation => (
          operation.name === 'QUERY' ? { ...operation, effects: ['touch(x)'] } : operation
        )),
      },
    ],
  ])('rejects an operation protocol with %s', (_label, mutation) => {
    const spec: ProblemSpecV1 = { ...operationSpec, ...mutation };

    expect(assessGeneratorDslEligibility(spec)).toEqual({
      eligible: false,
      reason: 'UNSUPPORTED_OPERATION_PROTOCOL',
    });
  });

  it('requires operation key bounds to equal the single argument field plan', () => {
    const raw = JSON.stringify(planFor({
      q: { kind: 'integer', value: 'derived' },
      x: { kind: 'integer', min: 1, max: 20 },
      ops: {
        kind: 'operation-sequence', length: 4,
        pattern: 'add-delete-repeat', minKey: 1, maxKey: 19,
      },
    }));

    expect(() => parseGeneratorPlan(raw, operationSpec, 1)).toThrow(/GeneratorPlan/);
  });

  it('rejects query-between-updates when the closed protocol has no query', () => {
    const spec: ProblemSpecV1 = {
      ...operationSpec,
      operations: (operationSpec.operations || []).filter(operation => operation.name !== 'QUERY'),
    };
    const raw = JSON.stringify(planFor({
      q: { kind: 'integer', value: 'derived' },
      x: { kind: 'integer', min: 1, max: 20 },
      ops: {
        kind: 'operation-sequence', length: 3,
        pattern: 'query-between-updates', minKey: 1, maxKey: 20,
      },
    }));

    expect(() => parseGeneratorPlan(raw, spec, 1)).toThrow(/GeneratorPlan/);
  });

  it('parses a closed GeneratorPlan and rejects extra keys or type mismatches', () => {
    const raw = JSON.stringify(planFor({
      n: { kind: 'integer', value: 4 },
      a: { kind: 'array', length: 4, min: -2, max: 3, pattern: 'alternating' },
    }));
    expect(parseGeneratorPlan(raw, sequenceSpec, 1)).toEqual(JSON.parse(raw));

    const extra = JSON.stringify({ ...JSON.parse(raw), executableCode: 'print(1)' });
    expect(() => parseGeneratorPlan(extra, sequenceSpec, 1)).toThrow(/GeneratorPlan/);
    const wrongKind = JSON.stringify(planFor({
      n: { kind: 'integer', value: 4 },
      a: { kind: 'string', length: 4, alphabet: 'ab', pattern: 'alternating' },
    }));
    expect(() => parseGeneratorPlan(wrongKind, sequenceSpec, 1)).toThrow(/GeneratorPlan/);
  });

  it('preserves exact signed 64-bit scalar boundaries without JSON number rounding', () => {
    const raw = JSON.stringify({
      version: 1,
      seed: 9,
      cases: [{
        label: 'int64-min',
        fields: {
          x: { kind: 'integer', value: '-9223372036854775808' },
          s: { kind: 'string', length: 1, alphabet: 'a', pattern: 'same' },
        },
      }],
    });
    const parsed = parseGeneratorPlan(raw, scalarSpec, 1);
    const materialized = materializeGeneratorPlan(parsed, scalarSpec)[0];

    expect(materialized.values.x).toEqual({
      kind: 'integer', value: '-9223372036854775808',
    });
    expect(materialized.input).toBe('-9223372036854775808\na\n');
  });

  it('never preserves model-authored subtask membership in materialized cases', () => {
    const tieredSpec = specWithFields(sequenceSpec.inputFields, {
      subtasks: [{ id: 1, score: 100, constraintIds: [] }],
    });
    const materialized = materializeGeneratorPlan({
      ...planFor({
        n: { kind: 'integer', value: 1 },
        a: { kind: 'array', length: 1, min: 0, max: 0, pattern: 'all-equal' },
      }),
      cases: [{
        ...planFor({
          n: { kind: 'integer', value: 1 },
          a: { kind: 'array', length: 1, min: 0, max: 0, pattern: 'all-equal' },
        }).cases[0],
        subtaskId: 1,
      }],
    }, tieredSpec)[0];

    expect(materialized.subtaskId).toBeUndefined();
  });
});

describe('trusted generator DSL deterministic materialization', () => {
  it('materializes integer, string, array, and matrix values within declared bounds', () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const scalar = onlyCase(scalarSpec, {
        x: { kind: 'integer', min: -5, max: 5 },
        s: { kind: 'string', length: 7, alphabet: 'ab', pattern: 'alternating' },
      }, seed);
      expect(scalar.values.x).toMatchObject({ kind: 'integer' });
      expect((scalar.values.x as { value: number }).value).toBeGreaterThanOrEqual(-5);
      expect((scalar.values.x as { value: number }).value).toBeLessThanOrEqual(5);
      expect(scalar.input.split('\n')).toEqual([
        String((scalar.values.x as { value: number }).value),
        'abababa',
        '',
      ]);

      const array = onlyCase(sequenceSpec, {
        n: { kind: 'integer', value: 6 },
        a: { kind: 'array', length: 6, min: -3, max: 4, pattern: 'random' },
      }, seed);
      const values = (array.values.a as { values: number[] }).values;
      expect(values).toHaveLength(6);
      expect(values.every(value => value >= -3 && value <= 4)).toBe(true);

      const matrix = onlyCase(matrixSpec, {
        n: { kind: 'integer', value: 3 },
        m: { kind: 'integer', value: 4 },
        grid: {
          kind: 'matrix', rows: 3, columns: 4, min: 0, max: 9, pattern: 'alternating',
        },
      }, seed);
      const rows = (matrix.values.grid as { values: number[][] }).values;
      expect(rows).toHaveLength(3);
      expect(rows.every(row => row.length === 4)).toBe(true);
      expect(matrix.input.trim().split('\n')).toHaveLength(4);
    }
  });

  it.each(['identity', 'reversed', 'random'] as const)(
    'materializes a complete %s permutation for every replay seed',
    pattern => {
      for (let seed = 1; seed <= 64; seed += 1) {
        const result = onlyCase(permutationSpec, {
          n: { kind: 'integer', value: 12 },
          p: { kind: 'permutation', size: 12, pattern },
        }, seed);
        const values = (result.values.p as { values: number[] }).values;
        expect([...values].sort((left, right) => left - right))
          .toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      }
    },
  );

  it.each(['chain', 'star', 'balanced', 'broom', 'random'] as const)(
    'materializes legal connected acyclic %s trees over many seeds',
    shape => {
      for (let seed = 1; seed <= 64; seed += 1) {
        const result = onlyCase(treeSpec, {
          n: { kind: 'integer', value: 17 },
          tree: { kind: 'tree', size: 17, shape },
        }, seed);
        const tree = result.values.tree as {
          vertexCount: number; edges: Array<[number, number]>;
        };
        expect(tree.edges).toHaveLength(tree.vertexCount - 1);
        expectSimpleConnected(tree.vertexCount, tree.edges);
      }
    },
  );

  it.each(['sparse', 'near-tree', 'dense', 'bridge', 'cycle'] as const)(
    'materializes simple connected %s graphs over many seeds',
    shape => {
      for (let seed = 1; seed <= 32; seed += 1) {
        const graphPlan: GeneratorFieldPlan = { kind: 'graph', size: 9, shape };
        const expectedEdges = materializeGeneratorPlan(planFor({
          n: { kind: 'integer', value: 9 },
          m: { kind: 'integer', value: 'derived' },
          graph: graphPlan,
        }, seed), graphSpec)[0].values.graph as {
          vertexCount: number; edges: Array<[number, number]>;
        };
        expectSimpleConnected(expectedEdges.vertexCount, expectedEdges.edges);
      }
    },
  );

  it('materializes near-tree as a branched unicyclic graph distinct from a simple cycle', () => {
    const materializeShape = (shape: 'near-tree' | 'cycle') => (
      onlyCase(graphSpec, {
        n: { kind: 'integer', value: 9 },
        m: { kind: 'integer', value: 'derived' },
        graph: { kind: 'graph', size: 9, shape },
      }).values.graph as { vertexCount: number; edges: Array<[number, number]> }
    );
    const degrees = (graph: { vertexCount: number; edges: Array<[number, number]> }) => {
      const result = Array.from({ length: graph.vertexCount + 1 }, () => 0);
      for (const [left, right] of graph.edges) {
        result[left] += 1;
        result[right] += 1;
      }
      return result.slice(1);
    };
    const nearTree = materializeShape('near-tree');
    const cycle = materializeShape('cycle');

    expect(nearTree.edges).toHaveLength(nearTree.vertexCount);
    expect(degrees(nearTree)).toEqual(expect.arrayContaining([1, 3]));
    expect(cycle.edges).toHaveLength(cycle.vertexCount);
    expect(degrees(cycle).every(degree => degree === 2)).toBe(true);
  });

  it('requires at least four vertices for a branched near-tree', () => {
    expect(() => materializeGeneratorPlan(planFor({
      n: { kind: 'integer', value: 3 },
      m: { kind: 'integer', value: 'derived' },
      graph: { kind: 'graph', size: 3, shape: 'near-tree' },
    }), graphSpec)).toThrow(/GeneratorPlan/);
    expect(() => materializeGeneratorPlan(planFor({
      n: { kind: 'integer', value: 3 },
      m: { kind: 'integer', value: 'derived' },
      graph: { kind: 'graph', size: 3, shape: 'cycle' },
    }), graphSpec)).not.toThrow();
  });

  it.each([
    'add-delete-repeat',
    'nested-lifetime',
    'query-between-updates',
  ] as const)('materializes valid %s operation lifetimes', pattern => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const result = onlyCase(operationSpec, {
        q: { kind: 'integer', value: 'derived' },
        x: { kind: 'integer', min: 1, max: 20 },
        ops: { kind: 'operation-sequence', length: 12, pattern, minKey: 1, maxKey: 20 },
      }, seed);
      const operations = (result.values.ops as {
        operations: Array<{ type: string; arguments: number[] }>;
      }).operations;
      expect(operations).toHaveLength(12);
      const present = new Set<number>();
      for (const operation of operations) {
        expect(operation.arguments).toHaveLength(1);
        const key = operation.arguments[0];
        expect(key).toBeGreaterThanOrEqual(1);
        expect(key).toBeLessThanOrEqual(20);
        if (operation.type === 'ADD') {
          expect(present.has(key)).toBe(false);
          present.add(key);
        } else if (operation.type === 'DEL') {
          expect(present.has(key)).toBe(true);
          present.delete(key);
        }
      }
    }
  });

  it('reuses the same key after deletion for add-delete-repeat coverage', () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const result = onlyCase(operationSpec, {
        q: { kind: 'integer', value: 'derived' },
        x: { kind: 'integer', min: 1, max: 20 },
        ops: {
          kind: 'operation-sequence', length: 8,
          pattern: 'add-delete-repeat', minKey: 1, maxKey: 20,
        },
      }, seed);
      const operations = (result.values.ops as {
        operations: Array<{ type: string; arguments: number[] }>;
      }).operations;

      expect(new Set(operations.map(operation => operation.arguments[0])).size).toBe(1);
    }
  });

  it('rejects aggregate plan work that exceeds the cross-case materialization budget', () => {
    const cases = Array.from({ length: 11 }, (_, index) => ({
      label: `large-${index + 1}`,
      fields: {
        n: { kind: 'integer', value: 'derived' },
        a: {
          kind: 'array', length: 100_000, min: 0, max: 0, pattern: 'all-equal',
        },
      },
    }));
    const raw = JSON.stringify({ version: 1, seed: 1, cases });

    expect(() => parseGeneratorPlan(raw, sequenceSpec, cases.length)).toThrow(/GeneratorPlan/);
  });

  it.each([
    ['add-delete-repeat', 3],
    ['nested-lifetime', 3],
    ['query-between-updates', 2],
  ] as const)('rejects a %s plan shorter than its semantic minimum', (pattern, length) => {
    const raw = JSON.stringify(planFor({
      q: { kind: 'integer', value: 'derived' },
      x: { kind: 'integer', min: 1, max: 2 },
      ops: { kind: 'operation-sequence', length, pattern, minKey: 1, maxKey: 2 },
    }));

    expect(() => parseGeneratorPlan(raw, operationSpec, 1)).toThrow(/GeneratorPlan/);
  });

  it('rejects conflicting derived expectations for a shared square-matrix count', () => {
    const squareMatrixSpec = specWithFields([
      { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
      {
        id: 'grid', name: 'grid', type: 'matrix',
        encoding: 'lines:2..n+1 tokens:1..n', dependsOn: ['n'],
      },
    ]);

    expect(() => materializeGeneratorPlan(planFor({
      n: { kind: 'integer', value: 'derived' },
      grid: { kind: 'matrix', rows: 2, columns: 3, min: 0, max: 0, pattern: 'all-equal' },
    }), squareMatrixSpec)).toThrow(/GeneratorPlan/);
  });

  it('rejects a derived scalar that is not referenced by any structural count', () => {
    expect(() => materializeGeneratorPlan(planFor({
      x: { kind: 'integer', value: 'derived' },
      s: { kind: 'string', length: 1, alphabet: 'a', pattern: 'same' },
    }), scalarSpec)).toThrow(/GeneratorPlan/);
  });

  it('rejects nested lifetimes when the declared key range cannot supply two keys', () => {
    expect(() => onlyCase(operationSpec, {
      q: { kind: 'integer', value: 'derived' },
      x: { kind: 'integer', min: 1, max: 1 },
      ops: {
        kind: 'operation-sequence', length: 4,
        pattern: 'nested-lifetime', minKey: 1, maxKey: 1,
      },
    })).toThrow(/GeneratorPlan/);
  });

  it('replays the same seed exactly, changes random material across seeds, and emits a deterministic artifact', () => {
    const plan = planFor({
      n: { kind: 'integer', value: 10 },
      a: { kind: 'array', length: 10, min: -100, max: 100, pattern: 'random' },
    }, 987654321);
    const first = materializeGeneratorPlan(plan, sequenceSpec);
    const replay = materializeGeneratorPlan(JSON.parse(JSON.stringify(plan)), sequenceSpec);
    const changed = materializeGeneratorPlan({ ...plan, seed: plan.seed + 1 }, sequenceSpec);

    expect(replay).toEqual(first);
    expect(changed[0].input).not.toBe(first[0].input);
    const artifact = renderGeneratorArtifact(plan, first);
    expect(renderGeneratorArtifact(plan, replay)).toBe(artifact);
    expect(artifact).toContain('Server-generated trusted GeneratorPlan artifact');
    expect(artifact).toContain(JSON.stringify(first.map(item => ({
      label: item.label,
      input: item.input,
    }))));
    expect(artifact).not.toContain('eval(');
    expect(artifact).not.toContain('exec(');
  });
});
