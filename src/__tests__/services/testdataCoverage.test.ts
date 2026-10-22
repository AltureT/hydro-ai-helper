import {
  computeCoverageFeatures,
  deriveCoverageTargets,
  enforceCoverageRequirements,
  evaluateSemanticCoverage,
} from '../../services/testdata/coverage';
import {
  materializeGeneratorPlan,
  type MaterializedGeneratorCase,
} from '../../services/testdata/generatorDsl';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';
import { parseNumericBoundExpression } from '../../services/testdata/numericBounds';

const HASH = '2'.repeat(64);

function baseSpec(
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

const arraySpec = baseSpec([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  {
    id: 'a', name: 'a', type: 'array', encoding: 'line:2 tokens:1..n', dependsOn: ['n'],
  },
], {
  constraints: [
    {
      id: 'C_SIZE', expression: '1 <= n <= 10', machineCheckable: true,
      scope: 'global', evidence: { quote: '1 <= n <= 10' },
    },
    {
      id: 'C_VALUE', expression: '-2147483648 <= a[i] <= 2147483647',
      machineCheckable: true, scope: 'global',
      evidence: { quote: '-2147483648 <= a[i] <= 2147483647' },
    },
  ],
});

const structuralSpec = baseSpec([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  {
    id: 'tree', name: 'tree', type: 'tree', encoding: 'lines:2..n tokens:1,2',
    dependsOn: ['n'],
  },
]);

const graphSpec = baseSpec([
  { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
  { id: 'm', name: 'm', type: 'integer', encoding: 'line:1 token:2' },
  {
    id: 'g', name: 'g', type: 'graph', encoding: 'lines:2..m+1 tokens:1,2',
    dependsOn: ['n', 'm'],
  },
]);

const operationSpec = baseSpec([
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

function generatedCase(
  values: MaterializedGeneratorCase['values'],
  label = 'misleading-label',
  subtaskId?: number,
): MaterializedGeneratorCase {
  return { label, input: 'server serialized\n', values, ...(subtaskId ? { subtaskId } : {}) };
}

function matrixByKey(
  result: ReturnType<typeof evaluateSemanticCoverage>,
): Map<string, { required: number; actual: number; status: string; critical: boolean }> {
  return new Map(result.matrix.map(row => [row.targetKey, row]));
}

describe('coverage targets derive from frozen ProblemSpec', () => {
  it.each([
    [
      '1<=n<=10^5',
      { kind: 'parsed', fieldId: 'n', bounds: { min: '1', max: '100000' } },
    ],
    [
      'n<=1e5',
      { kind: 'parsed', fieldId: 'n', bounds: { max: '100000' } },
    ],
    [
      '10^5>=n',
      { kind: 'parsed', fieldId: 'n', bounds: { max: '100000' } },
    ],
    [
      '10^5<=n',
      { kind: 'parsed', fieldId: 'n', bounds: { min: '100000' } },
    ],
  ])('parses compact closed numeric bound %s', (expression, expected) => {
    expect(parseNumericBoundExpression(expression)).toEqual(expected);
  });

  it.each([
    '1<=n<=10**5',
    '1<=n<=1e1000000',
    '1<=n<=',
    'n<=',
    '<=n<=10',
    `${'1'.repeat(257)}<=n`,
  ])('classifies malformed or oversized compact bound as invalid: %s', expression => {
    expect(parseNumericBoundExpression(expression)).toEqual({ kind: 'invalid-bound' });
  });

  it('derives size, value-domain, pattern, integer-boundary, and subtask targets without labels', () => {
    const spec: ProblemSpecV1 = {
      ...arraySpec,
      subtasks: [
        { id: 1, score: 40, constraintIds: ['C_SIZE'] },
        { id: 2, score: 60, constraintIds: ['C_SIZE', 'C_VALUE'] },
      ],
      constraints: arraySpec.constraints.map(constraint => (
        constraint.id === 'C_SIZE' ? { ...constraint, scope: { subtaskId: 1 } } : constraint
      )),
    };
    const targets = deriveCoverageTargets(spec);
    const keys = new Set(targets.map(target => target.targetKey));

    expect(keys).toEqual(new Set([
      'size-min', 'size-mid', 'size-max',
      'value-min', 'value-max', 'int32-min', 'int32-max',
      'ordered', 'reversed', 'all-equal', 'alternating',
      'subtask-membership',
    ]));
    expect(targets.find(target => target.targetKey === 'size-max')?.critical).toBe(true);
    expect(targets.find(target => target.targetKey === 'subtask-membership')?.required).toBe(2);
  });

  it('does not require invalid reverse/all-equal patterns when frozen invariants forbid them', () => {
    const spec: ProblemSpecV1 = {
      ...arraySpec,
      invariants: [
        {
          id: 'I_SORT', kind: 'sorted', expression: 'sorted(a)', machineCheckable: true,
          evidence: { quote: 'sorted(a)' },
        },
        {
          id: 'I_UNIQUE', kind: 'unique', expression: 'allDistinct(a)', machineCheckable: true,
          evidence: { quote: 'allDistinct(a)' },
        },
      ],
    };
    const keys = deriveCoverageTargets(spec).map(target => target.targetKey);

    expect(keys).toContain('ordered');
    expect(keys).not.toContain('reversed');
    expect(keys).not.toContain('all-equal');
  });

  it('keeps global and sibling subtask bounds isolated and filters actuals by authoritative membership', () => {
    const spec = baseSpec([
      { id: 'x', name: 'x', type: 'integer', encoding: 'line:1 token:1' },
    ], {
      constraints: [
        {
          id: 'C_GLOBAL', expression: '0 <= x <= 100', machineCheckable: true,
          scope: 'global', evidence: { quote: '0 <= x <= 100' },
        },
        {
          id: 'C_SUBTASK_1', expression: 'x <= 10', machineCheckable: true,
          scope: { subtaskId: 1 }, evidence: { quote: 'x <= 10' },
        },
        {
          id: 'C_SUBTASK_2', expression: 'x >= 90', machineCheckable: true,
          scope: { subtaskId: 2 }, evidence: { quote: 'x >= 90' },
        },
      ],
      subtasks: [
        { id: 1, score: 50, constraintIds: ['C_SUBTASK_1'] },
        { id: 2, score: 50, constraintIds: ['C_SUBTASK_2'] },
      ],
    });

    const bounds = deriveCoverageTargets(spec)
      .filter(target => target.fieldId === 'x' && target.expectedLiteral !== undefined)
      .map(target => ({
        subtaskId: target.subtaskId,
        targetKey: target.targetKey,
        expectedLiteral: target.expectedLiteral,
      }));
    expect(bounds).toEqual(expect.arrayContaining([
      { subtaskId: undefined, targetKey: 'value-min', expectedLiteral: '0' },
      { subtaskId: undefined, targetKey: 'value-max', expectedLiteral: '100' },
      { subtaskId: 1, targetKey: 'value-min', expectedLiteral: '0' },
      { subtaskId: 1, targetKey: 'value-max', expectedLiteral: '10' },
      { subtaskId: 2, targetKey: 'value-min', expectedLiteral: '90' },
      { subtaskId: 2, targetKey: 'value-max', expectedLiteral: '100' },
    ]));

    const result = evaluateSemanticCoverage({
      spec,
      coverageMode: 'trusted-dsl',
      cases: [
        generatedCase({ x: { kind: 'integer', value: 0 } }),
        generatedCase({ x: { kind: 'integer', value: 100 } }),
        generatedCase({ x: { kind: 'integer', value: 10 } }),
        generatedCase({ x: { kind: 'integer', value: 5 } }, 'subtask-1', 1),
        generatedCase({ x: { kind: 'integer', value: 90 } }, 'subtask-2', 2),
      ],
    });
    const scopedActual = (subtaskId: number, targetKey: string) => result.matrix.find(row => (
      row.subtaskId === subtaskId && row.fieldId === 'x' && row.targetKey === targetKey
    ))?.actual;

    expect(scopedActual(1, 'value-max')).toBe(0);
    expect(scopedActual(2, 'value-min')).toBe(1);
  });

  it('derives exact decimal targets from bounded power and scientific integer literals', () => {
    const spec = baseSpec([
      { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
      {
        id: 'a', name: 'a', type: 'array', encoding: 'line:2 tokens:1..n',
        dependsOn: ['n'],
      },
    ], {
      constraints: [
        {
          id: 'C_SIZE', expression: '1 <= n <= 10^5', machineCheckable: true,
          scope: 'global', evidence: { quote: '1 <= n <= 10^5' },
        },
        {
          id: 'C_VALUE', expression: '-10^5 <= a[i] <= 1e5', machineCheckable: true,
          scope: 'global', evidence: { quote: '-10^5 <= a[i] <= 1e5' },
        },
      ],
    });

    expect(deriveCoverageTargets(spec)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetKey: 'size-max', fieldId: 'n', expected: 100_000,
      }),
      expect.objectContaining({
        targetKey: 'value-min', fieldId: 'a', expectedLiteral: '-100000',
      }),
      expect.objectContaining({
        targetKey: 'value-max', fieldId: 'a', expectedLiteral: '100000',
      }),
    ]));
  });
});

describe('coverage features use structured values rather than model labels', () => {
  it('recognizes exact signed 64-bit boundaries from canonical structured integers', () => {
    const spec = baseSpec([
      { id: 'x', name: 'x', type: 'integer', encoding: 'line:1 token:1' },
    ], {
      constraints: [{
        id: 'C_INT64',
        expression: '-9223372036854775808 <= x <= 9223372036854775807',
        machineCheckable: true,
        scope: 'global',
        evidence: { quote: 'signed 64-bit integer' },
      }],
    });
    const cases = [
      generatedCase({
        x: { kind: 'integer', value: '-9223372036854775808' },
      } as unknown as MaterializedGeneratorCase['values']),
      generatedCase({
        x: { kind: 'integer', value: '9223372036854775807' },
      } as unknown as MaterializedGeneratorCase['values']),
    ];
    const matrix = matrixByKey(evaluateSemanticCoverage({
      spec, cases, coverageMode: 'trusted-dsl',
    }));

    expect(matrix.get('int64-min')?.status).toBe('pass');
    expect(matrix.get('int64-max')?.status).toBe('pass');
  });

  it('computes min/mid/max, domain boundaries, repeat ratio, and sequence patterns', () => {
    const cases = [
      generatedCase({
        n: { kind: 'integer', value: 1 },
        a: { kind: 'array', values: [-2147483648] },
      }, 'claims max, reversed, and dense'),
      generatedCase({
        n: { kind: 'integer', value: 5 },
        a: { kind: 'array', values: [1, 2, 3, 4, 5] },
      }),
      generatedCase({
        n: { kind: 'integer', value: 10 },
        a: { kind: 'array', values: [2147483647, 1, 2147483647, 1, 2147483647,
          1, 2147483647, 1, 2147483647, 1] },
      }),
      generatedCase({
        n: { kind: 'integer', value: 4 },
        a: { kind: 'array', values: [4, 3, 2, 1] },
      }),
      generatedCase({
        n: { kind: 'integer', value: 3 },
        a: { kind: 'array', values: [7, 7, 7] },
      }),
    ];

    const features = computeCoverageFeatures(cases);
    expect(features.sizes).toEqual(expect.arrayContaining([1, 3, 4, 5, 10]));
    expect(features.valueMin).toBe(-2147483648);
    expect(features.valueMax).toBe(2147483647);
    expect(features.maxRepeatRatio).toBeGreaterThanOrEqual(2 / 3);
    expect(features.orderedCount).toBeGreaterThan(0);
    expect(features.reversedCount).toBeGreaterThan(0);
    expect(features.allEqualCount).toBeGreaterThan(0);
    expect(features.alternatingCount).toBeGreaterThan(0);

    const matrix = matrixByKey(evaluateSemanticCoverage({
      spec: arraySpec,
      cases,
      coverageMode: 'trusted-dsl',
    }));
    for (const key of [
      'size-min', 'size-mid', 'size-max', 'value-min', 'value-max',
      'int32-min', 'int32-max', 'ordered', 'reversed', 'all-equal', 'alternating',
    ]) expect(matrix.get(key)?.status).toBe('pass');
  });

  it('derives tree depth/max degree and graph density/bridge/components/cycle from edges', () => {
    const tree = generatedCase({
      n: { kind: 'integer', value: 5 },
      tree: {
        kind: 'tree', vertexCount: 5,
        edges: [[1, 2], [2, 3], [3, 4], [4, 5]],
      },
    });
    const graph = generatedCase({
      n: { kind: 'integer', value: 6 },
      m: { kind: 'integer', value: 7 },
      g: {
        kind: 'graph', vertexCount: 6,
        edges: [[1, 2], [2, 3], [3, 1], [3, 4], [4, 5], [5, 6], [6, 4]],
      },
    });

    const treeFeatures = computeCoverageFeatures([tree]);
    expect(treeFeatures.treeDepthMax).toBe(4);
    expect(treeFeatures.treeDegreeMax).toBe(2);
    expect(treeFeatures.treeShapeCounts.chain).toBe(1);
    const graphFeatures = computeCoverageFeatures([graph]);
    expect(graphFeatures.graphComponentMax).toBe(1);
    expect(graphFeatures.graphCycleCount).toBe(1);
    expect(graphFeatures.graphBridgeCount).toBe(1);
    expect(graphFeatures.graphDensityMax).toBeCloseTo(7 / 15);

    expect(matrixByKey(evaluateSemanticCoverage({
      spec: structuralSpec, cases: [tree], coverageMode: 'trusted-dsl',
    })).get('tree-chain')?.status).toBe('pass');
    const graphMatrix = matrixByKey(evaluateSemanticCoverage({
      spec: graphSpec, cases: [graph], coverageMode: 'trusted-dsl',
    }));
    expect(graphMatrix.get('graph-bridge')?.status).toBe('pass');
    expect(graphMatrix.get('graph-cycle')?.status).toBe('fail');
  });

  it('classifies a simple cycle and a branched near-tree as distinct graph shapes', () => {
    const simpleCycle = generatedCase({
      n: { kind: 'integer', value: 4 },
      m: { kind: 'integer', value: 4 },
      g: {
        kind: 'graph', vertexCount: 4,
        edges: [[1, 2], [2, 3], [3, 4], [4, 1]],
      },
    });
    const nearTree = generatedCase({
      n: { kind: 'integer', value: 4 },
      m: { kind: 'integer', value: 4 },
      g: {
        kind: 'graph', vertexCount: 4,
        edges: [[1, 2], [2, 3], [3, 1], [3, 4]],
      },
    });

    const cycleFeatures = computeCoverageFeatures([simpleCycle]);
    expect(cycleFeatures.graphShapeCounts).toMatchObject({ cycle: 1, 'near-tree': 0 });
    const nearTreeFeatures = computeCoverageFeatures([nearTree]);
    expect(nearTreeFeatures.graphShapeCounts).toMatchObject({ cycle: 0, 'near-tree': 1 });
  });

  it('keeps a materialized 20k-node chain trusted and computes its full depth stack-safely', () => {
    const chain = materializeGeneratorPlan({
      version: 1,
      seed: 41,
      cases: [{
        label: 'deep-chain',
        fields: {
          n: { kind: 'integer', value: 'derived' },
          tree: { kind: 'tree', size: 20_000, shape: 'chain' },
        },
      }],
    }, structuralSpec)[0];

    const features = computeCoverageFeatures([chain]);
    expect(features.treeDepthMax).toBe(19_999);
    expect(features.treeShapeCounts.chain).toBe(1);
    const coverage = evaluateSemanticCoverage({
      spec: structuralSpec,
      cases: [chain],
      coverageMode: 'trusted-dsl',
    });
    expect(coverage.mode).toBe('trusted-dsl');
    expect(coverage.matrix.find(row => row.targetKey === 'tree-chain')).toMatchObject({
      actual: 1,
      status: 'pass',
    });
  });

  it('keeps a materialized 20k-node simple cycle trusted without recursion overflow', () => {
    const cycle = materializeGeneratorPlan({
      version: 1,
      seed: 43,
      cases: [{
        label: 'deep-cycle',
        fields: {
          n: { kind: 'integer', value: 'derived' },
          m: { kind: 'integer', value: 'derived' },
          g: { kind: 'graph', size: 20_000, shape: 'cycle' },
        },
      }],
    }, graphSpec)[0];

    const features = computeCoverageFeatures([cycle]);
    expect(features.graphComponentMax).toBe(1);
    expect(features.graphBridgeCount).toBe(0);
    expect(features.graphShapeCounts).toMatchObject({ cycle: 1, 'near-tree': 0 });
    const coverage = evaluateSemanticCoverage({
      spec: graphSpec,
      cases: [cycle],
      coverageMode: 'trusted-dsl',
    });
    expect(coverage.mode).toBe('trusted-dsl');
    expect(coverage.matrix.find(row => row.targetKey === 'graph-cycle')).toMatchObject({
      actual: 1,
      status: 'pass',
    });
  });

  it('computes operation types, transitions, query-before-update count, and lifetimes', () => {
    const operations = [
      { type: 'ADD', arguments: [1] },
      { type: 'QUERY', arguments: [1] },
      { type: 'ADD', arguments: [2] },
      { type: 'DEL', arguments: [2] },
      { type: 'DEL', arguments: [1] },
      { type: 'ADD', arguments: [3] },
      { type: 'DEL', arguments: [3] },
    ];
    const caseValue = generatedCase({
      q: { kind: 'integer', value: operations.length },
      x: { kind: 'integer', value: 1 },
      ops: { kind: 'operation-sequence', operations },
    });
    const features = computeCoverageFeatures([caseValue]);

    expect(features.operationTypeCounts).toMatchObject({ ADD: 3, DEL: 3, QUERY: 1 });
    expect(features.operationTransitionCounts).toMatchObject({
      'ADD->QUERY': 1,
      'QUERY->ADD': 1,
      'ADD->DEL': 2,
    });
    expect(features.queryBeforeUpdateCounts).toContain(1);
    expect(features.operationPatternCounts['nested-lifetime']).toBe(1);
    expect(features.operationPatternCounts['query-between-updates']).toBe(1);

    const matrix = matrixByKey(evaluateSemanticCoverage({
      spec: operationSpec, cases: [caseValue], coverageMode: 'trusted-dsl',
    }));
    expect(matrix.get('operation-nested-lifetime')?.status).toBe('pass');
    expect(matrix.get('operation-query-between-updates')?.status).toBe('pass');
  });

  it('does not call a single add/delete pair a repeated lifetime', () => {
    const caseValue = generatedCase({
      q: { kind: 'integer', value: 2 },
      x: { kind: 'integer', value: 1 },
      ops: {
        kind: 'operation-sequence',
        operations: [
          { type: 'ADD', arguments: [1] },
          { type: 'DEL', arguments: [1] },
        ],
      },
    });
    const features = computeCoverageFeatures([caseValue]);

    expect(features.operationPatternCounts['add-delete-repeat']).toBe(0);
  });

  it('does not credit an incomplete three-operation add/delete repeat', () => {
    const caseValue = generatedCase({
      q: { kind: 'integer', value: 3 },
      x: { kind: 'integer', value: 1 },
      ops: {
        kind: 'operation-sequence',
        operations: [
          { type: 'ADD', arguments: [1] },
          { type: 'DEL', arguments: [1] },
          { type: 'ADD', arguments: [1] },
        ],
      },
    });

    expect(computeCoverageFeatures([caseValue]).operationPatternCounts[
      'add-delete-repeat'
    ]).toBe(0);
  });

  it('credits operation argument bounds from serialized operations instead of the scalar plan value', () => {
    const spec: ProblemSpecV1 = {
      ...operationSpec,
      constraints: [{
        id: 'C_KEY', expression: '1 <= x <= 3', machineCheckable: true,
        scope: 'global', evidence: { quote: '1 <= x <= 3' },
      }],
    };
    const caseValue = generatedCase({
      q: { kind: 'integer', value: 2 },
      x: { kind: 'integer', value: 1 },
      ops: {
        kind: 'operation-sequence',
        operations: [
          { type: 'ADD', arguments: [3] },
          { type: 'DEL', arguments: [3] },
        ],
      },
    });
    const result = evaluateSemanticCoverage({
      spec, cases: [caseValue], coverageMode: 'trusted-dsl',
    });
    const row = (targetKey: string) => result.matrix.find(item => (
      item.targetKey === targetKey && item.fieldId === 'x'
    ));

    expect(row('value-min')).toMatchObject({ actual: 0, status: 'fail' });
    expect(row('value-max')).toMatchObject({ actual: 1, status: 'pass' });
  });

  it('detects query-between-updates without suffix array scans', () => {
    const operations = [
      { type: 'ADD', arguments: [1] },
      { type: 'QUERY', arguments: [1] },
      { type: 'DEL', arguments: [1] },
    ];
    Object.defineProperty(operations, 'slice', {
      value: () => { throw new Error('quadratic suffix scan'); },
    });
    const caseValue = generatedCase({
      q: { kind: 'integer', value: operations.length },
      x: { kind: 'integer', value: 1 },
      ops: { kind: 'operation-sequence', operations },
    });

    expect(computeCoverageFeatures([caseValue]).operationPatternCounts[
      'query-between-updates'
    ]).toBe(1);
  });

  it('rejects aggregate structured feature work above the cross-case budget', () => {
    const values = Array.from({ length: 100_000 }, () => 0);
    const cases = Array.from({ length: 11 }, (_, index) => generatedCase({
      n: { kind: 'integer', value: values.length },
      a: { kind: 'array', values },
    }, `large-${index + 1}`));

    expect(() => computeCoverageFeatures(cases)).toThrow(/work budget/);
  });
});

describe('coverage downgrade and enforcement policy', () => {
  it('ignores labels and reports an honest missing max target', () => {
    const result = evaluateSemanticCoverage({
      spec: arraySpec,
      coverageMode: 'trusted-dsl',
      cases: [generatedCase({
        n: { kind: 'integer', value: 1 },
        a: { kind: 'array', values: [0] },
      }, 'n=max; everything covered')],
    });
    expect(matrixByKey(result).get('size-max')).toMatchObject({ actual: 0, status: 'fail' });
  });

  it.each(['observe', 'enforce'] as const)(
    'degrades malformed structured features to ai-generator-unverified in %s',
    reliabilityMode => {
      const malformed = generatedCase({
        n: { kind: 'integer', value: 3 },
        tree: {
          kind: 'tree', vertexCount: 3,
          edges: [[1, 2], [1, 2]],
        },
      });
      const result = evaluateSemanticCoverage({
        spec: structuralSpec,
        cases: [malformed],
        coverageMode: 'trusted-dsl',
      });
      expect(result).toMatchObject({
        mode: 'ai-generator-unverified',
        matrix: [],
        featureExtractionFailed: true,
      });
      expect(() => enforceCoverageRequirements(result, 'high', reliabilityMode)).not.toThrow();
    },
  );

  it.each([
    '1 <= n <= 10**5',
    '1 <= n <= 1e1000000',
    '1<=n<=10**5',
    '1<=n<=1e1000000',
  ])('downgrades an unparseable simple machine numeric bound: %s', expression => {
    const spec: ProblemSpecV1 = {
      ...arraySpec,
      constraints: [{
        id: 'C_BAD_BOUND', expression, machineCheckable: true,
        scope: 'global', evidence: { quote: expression },
      }],
    };
    const result = evaluateSemanticCoverage({
      spec,
      coverageMode: 'trusted-dsl',
      cases: [generatedCase({
        n: { kind: 'integer', value: 1 },
        a: { kind: 'array', values: [0] },
      })],
    });

    expect(result).toMatchObject({
      mode: 'ai-generator-unverified',
      matrix: [],
      featureExtractionFailed: true,
    });
  });

  it('ignores a machine-checkable non-bound expression without downgrading coverage', () => {
    const spec: ProblemSpecV1 = {
      ...arraySpec,
      constraints: [{
        id: 'C_PARITY', expression: 'n%2==0', machineCheckable: true,
        scope: 'global', evidence: { quote: 'n % 2 == 0' },
      }],
    };
    const result = evaluateSemanticCoverage({
      spec,
      coverageMode: 'trusted-dsl',
      cases: [generatedCase({
        n: { kind: 'integer', value: 2 },
        a: { kind: 'array', values: [0, 0] },
      })],
    });

    expect(result.mode).toBe('trusted-dsl');
  });

  it('throws only for trusted critical gaps in high-risk enforce mode', () => {
    const result = evaluateSemanticCoverage({
      spec: arraySpec,
      cases: [generatedCase({
        n: { kind: 'integer', value: 1 },
        a: { kind: 'array', values: [0] },
      })],
      coverageMode: 'trusted-dsl',
    });

    expect(() => enforceCoverageRequirements(result, 'high', 'enforce')).toThrow(
      expect.objectContaining({
        code: 'COVERAGE_REQUIREMENT_MISSING',
        artifact: 'coverage',
        safeDetails: { missingCount: result.criticalMissing },
      }),
    );
    expect(() => enforceCoverageRequirements(result, 'medium', 'enforce')).not.toThrow();
    expect(() => enforceCoverageRequirements(result, 'high', 'observe')).not.toThrow();
  });
});
