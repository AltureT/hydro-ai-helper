import {
  buildConstraintProbes,
  type LegalConstraintProbeSeed,
} from '../../services/testdata/constraintProbes';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';
import {
  VALIDATOR_PROBE_CONSTRUCTION_KINDS,
  type ValidatorProbeRecipe,
} from '../../services/testdata/validatorManifest';

type ScalarSequenceConstructionKind =
  | 'integer-below-min'
  | 'integer-above-max'
  | 'array-length-mismatch'
  | 'duplicate-element'
  | 'permutation-duplicate-or-missing'
  | 'illegal-string-character';

type StructuralConstructionKind =
  | 'graph-self-loop'
  | 'graph-duplicate-edge'
  | 'graph-disconnected'
  | 'tree-missing-edge'
  | 'tree-cycle'
  | 'dag-cycle';

type OperationConstructionKind =
  | 'add-existing-object'
  | 'delete-missing-object'
  | 'operation-argument-out-of-range';

function integerSpec(scope: 'global' | { subtaskId: number } = 'global'): ProblemSpecV1 {
  return {
    schemaVersion: 1,
    statementHash: '1'.repeat(64),
    problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields: [{
      id: 'n',
      name: 'n',
      type: 'integer',
      encoding: 'line:1 token:1',
    }],
    constraints: [{
      id: 'C1',
      expression: '0 <= n <= 10',
      machineCheckable: true,
      scope,
      evidence: { quote: '0 <= n <= 10' },
    }],
    invariants: [],
    outputPolicy: { kind: 'exact' },
    subtasks: scope === 'global'
      ? []
      : [{ id: scope.subtaskId, score: 100, constraintIds: ['C1'] }],
    uncertainties: [],
  };
}

describe('constraint probe determinism and hash binding', () => {
  const recipe: ValidatorProbeRecipe = {
    targetId: 'C1',
    constructionKind: 'integer-below-min',
    fieldId: 'n',
  };
  const formalSeed: LegalConstraintProbeSeed = {
    source: 'formal', index: 2, input: '5\r\n',
  };
  const sampleSeed: LegalConstraintProbeSeed = {
    source: 'sample', index: 'sample-b', input: '6\n',
  };
  const stressSeed: LegalConstraintProbeSeed = {
    source: 'stress', index: 1, input: '7\n',
  };

  it('is deterministic across caller seed order without mutating caller seeds', () => {
    const spec = integerSpec();
    const firstSeeds = [stressSeed, sampleSeed, formalSeed];
    const secondSeeds = [formalSeed, stressSeed, sampleSeed];
    const firstSnapshot = JSON.stringify(firstSeeds);
    const secondSnapshot = JSON.stringify(secondSeeds);

    const first = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: firstSeeds,
      recipes: [recipe],
    });
    const second = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: secondSeeds,
      recipes: [recipe],
    });

    expect(second).toEqual(first);
    expect(firstSeeds).toEqual(JSON.parse(firstSnapshot));
    expect(secondSeeds).toEqual(JSON.parse(secondSnapshot));
    expect(first.legalSeedHash)
      .toBe('8c77d442f0c0a5484713d19ac13148519933187aa0f22f68857cd8d963b4a722');
    expect(first.effectiveSeed)
      .toBe('7783db5d07dc20c76d4e941269b8fda11af71bb2f97728a4f0832c8a3ad2110b');
    expect(first.probes).toHaveLength(2);
    expect(first.probes[0].input).toBe('-1\n');
    expect(first.probes.every(probe => /^[a-f0-9]{32}$/.test(probe.id))).toBe(true);
    expect(first.probes[0].id).toBe('6b1d3eea5b5f56d66bdf31a4b3f66b85');
  });

  it('binds probe ids to statement, spec, normalized seed, construction, and subtask', () => {
    const baseInput = {
      spec: integerSpec(),
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [formalSeed],
      recipes: [recipe],
    };
    const baseId = buildConstraintProbes(baseInput).probes[0].id;
    const changedStatement = buildConstraintProbes({
      ...baseInput, statementHash: '3'.repeat(64),
    }).probes[0].id;
    const changedSpec = buildConstraintProbes({
      ...baseInput, specHash: '4'.repeat(64),
    }).probes[0].id;
    const changedInput = buildConstraintProbes({
      ...baseInput, seeds: [{ ...formalSeed, input: '6\n' }],
    }).probes[0].id;
    const changedConstruction = buildConstraintProbes(baseInput).probes
      .find(probe => probe.constructionKind === 'integer-above-max')!.id;
    const changedTargetSpec = integerSpec();
    changedTargetSpec.constraints = [{ ...changedTargetSpec.constraints[0], id: 'C2' }];
    const changedTarget = buildConstraintProbes({
      ...baseInput,
      spec: changedTargetSpec,
      recipes: [{ ...recipe, targetId: 'C2' }],
    }).probes.find(probe => probe.constructionKind === 'integer-below-min')!.id;
    const invariantSpec: ProblemSpecV1 = {
      ...integerSpec(),
      constraints: [],
      invariants: [{
        id: 'C1',
        kind: 'custom',
        expression: '0 <= n <= 10',
        machineCheckable: true,
        evidence: { quote: '0 <= n <= 10' },
      }],
    };
    const changedTargetKind = buildConstraintProbes({
      ...baseInput,
      spec: invariantSpec,
    }).probes[0].id;
    const scopedSeeds: LegalConstraintProbeSeed[] = [
      { source: 'formal', index: 1, subtaskId: 1, input: '5\n' },
      { source: 'formal', index: 2, subtaskId: 2, input: '5\n' },
    ];
    const firstSubtask = buildConstraintProbes({
      spec: integerSpec({ subtaskId: 1 }),
      statementHash: baseInput.statementHash,
      specHash: baseInput.specHash,
      seeds: scopedSeeds,
      recipes: [recipe],
    }).probes[0].id;
    const changedSubtask = buildConstraintProbes({
      spec: integerSpec({ subtaskId: 2 }),
      statementHash: baseInput.statementHash,
      specHash: baseInput.specHash,
      seeds: scopedSeeds,
      recipes: [recipe],
    }).probes[0].id;

    expect(changedStatement).not.toBe(baseId);
    expect(changedSpec).not.toBe(baseId);
    expect(changedInput).not.toBe(baseId);
    expect(changedConstruction).not.toBe(baseId);
    expect(changedTarget).not.toBe(baseId);
    expect(changedTargetKind).not.toBe(baseId);
    expect(changedSubtask).not.toBe(firstSubtask);
  });

  it('binds the probe id to the exact mutation position', () => {
    const firstPositionSpec = integerSpec();
    firstPositionSpec.inputFields.push({
      id: 'other', name: 'other', type: 'integer', encoding: 'line:1 token:2',
    });
    const secondPositionSpec: ProblemSpecV1 = {
      ...firstPositionSpec,
      inputFields: firstPositionSpec.inputFields.map(field => field.id === 'n'
        ? { ...field, encoding: 'line:1 token:2' }
        : { ...field, encoding: 'line:1 token:1' }),
    };
    const common = {
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal' as const, index: 1, input: '5 5\n' }],
      recipes: [recipe],
    };
    const first = buildConstraintProbes({ ...common, spec: firstPositionSpec });
    const second = buildConstraintProbes({ ...common, spec: secondPositionSpec });

    expect(first.probes[0].input).toBe('-1 5\n');
    expect(second.probes[0].input).toBe('5 -1\n');
    expect(second.probes[0].id).not.toBe(first.probes[0].id);
  });
});

function sequenceSpec(constructionKind: ScalarSequenceConstructionKind): {
  spec: ProblemSpecV1;
  recipe: ValidatorProbeRecipe;
} {
  if (constructionKind === 'integer-below-min'
    || constructionKind === 'integer-above-max') {
    return {
      spec: integerSpec(),
      recipe: { targetId: 'C1', constructionKind, fieldId: 'n' },
    };
  }

  const isString = constructionKind === 'illegal-string-character';
  const isPermutation = constructionKind === 'permutation-duplicate-or-missing';
  const fieldId = isString ? 's' : isPermutation ? 'p' : 'a';
  const targetExpression = constructionKind === 'array-length-mismatch'
    ? 'length(a) = n'
    : constructionKind === 'duplicate-element'
      ? 'allDistinct(a)'
      : isPermutation
        ? 'permutation(p, 1..n)'
        : 'characters(s) in [a-z]';
  return {
    spec: {
      schemaVersion: 1,
      statementHash: '1'.repeat(64),
      problemKind: 'traditional',
      testCaseMode: { kind: 'single' },
      inputFields: isString
        ? [{ id: 's', name: 's', type: 'string', encoding: 'line:1 token:1' }]
        : [
          { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
          {
            id: fieldId,
            name: fieldId,
            type: isPermutation ? 'permutation' : 'array',
            encoding: `line:2 tokens:1..n`,
            dependsOn: ['n'],
          },
        ],
      constraints: [{
        id: 'C1',
        expression: targetExpression,
        machineCheckable: true,
        scope: 'global',
        evidence: { quote: targetExpression },
      }],
      invariants: [],
      outputPolicy: { kind: 'exact' },
      subtasks: [],
      uncertainties: [],
    },
    recipe: { targetId: 'C1', constructionKind, fieldId },
  };
}

function buildSingleTargetFixture(
  constructionKind: ScalarSequenceConstructionKind,
  legal: string,
) {
  const { spec, recipe } = sequenceSpec(constructionKind);
  return buildConstraintProbes({
    spec,
    statementHash: '1'.repeat(64),
    specHash: '2'.repeat(64),
    seeds: [{ source: 'formal', index: 1, input: legal }],
    recipes: [recipe],
  });
}

function noncanonicalPairwiseDistinctSpec(): ProblemSpecV1 {
  return {
    schemaVersion: 1,
    statementHash: '1'.repeat(64),
    problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields: [
      { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
      {
        id: 'a', name: 'a', type: 'array',
        encoding: 'line:2 tokens:1..n', dependsOn: ['n'],
      },
    ],
    constraints: [{
      id: 'C_LENGTH', expression: 'length(a) = n', machineCheckable: true,
      scope: 'global', evidence: { quote: 'exactly n values' },
    }],
    invariants: [{
      id: 'I_PAIRWISE', kind: 'custom',
      expression: 'all values must be pairwise different',
      machineCheckable: true,
      evidence: { quote: 'all values must be pairwise different' },
    }],
    outputPolicy: { kind: 'exact' },
    subtasks: [],
    uncertainties: [],
  };
}

const pairwiseDistinctRecipe: ValidatorProbeRecipe = {
  targetId: 'I_PAIRWISE', constructionKind: 'duplicate-element', fieldId: 'a',
};

function buildNoncanonicalPairwiseProbe(
  spec = noncanonicalPairwiseDistinctSpec(),
  input = '4\n10 20 30 40\n',
) {
  return buildConstraintProbes({
    spec,
    statementHash: '1'.repeat(64),
    specHash: '2'.repeat(64),
    seeds: [{ source: 'formal', index: 1, input }],
    recipes: [pairwiseDistinctRecipe],
  });
}

describe('scalar sequence and string constructions', () => {
  it.each<[ScalarSequenceConstructionKind, string, string]>([
    ['integer-below-min', '5\n', '-1\n'],
    ['integer-above-max', '5\n', '11\n'],
    ['array-length-mismatch', '3\n1 2 3\n', '3\n1 2\n'],
    ['duplicate-element', '4\n1 2 3 4\n', '4\n1 1 3 4\n'],
    ['permutation-duplicate-or-missing', '4\n1 2 3 4\n', '4\n1 2 3 3\n'],
    ['illegal-string-character', 'abc\n', 'ab#\n'],
  ])('%s creates one bounded invalid probe', (constructionKind, legal, illegal) => {
    const result = buildSingleTargetFixture(constructionKind, legal);
    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({
      targetId: 'C1',
      constructionKind,
      input: illegal,
    })]));
    expect(result.gaps).toEqual([]);
  });

  it('constructs a bounded duplicate-element probe for a noncanonical custom invariant', () => {
    const result = buildNoncanonicalPairwiseProbe();

    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({
      id: '09c9a5588b60e18a08c5c8232bc89968',
      targetId: 'I_PAIRWISE',
      targetKind: 'invariant',
      constructionKind: 'duplicate-element',
      input: '4\n10 10 30 40\n',
    })]));
    expect(result.gaps).toEqual([]);
  });

  it('reconstructs the same custom probe and id without clock or random state', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(123_456);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.987654321);
    try {
      const first = buildNoncanonicalPairwiseProbe();
      nowSpy.mockReturnValue(999_999);
      randomSpy.mockReturnValue(0.123456789);
      const second = buildNoncanonicalPairwiseProbe();
      const firstCustom = first.probes.find(probe => probe.targetId === 'I_PAIRWISE');
      const secondCustom = second.probes.find(probe => probe.targetId === 'I_PAIRWISE');

      expect(secondCustom).toEqual(firstCustom);
      expect(secondCustom).toEqual(expect.objectContaining({
        id: '09c9a5588b60e18a08c5c8232bc89968',
        input: '4\n10 10 30 40\n',
      }));
      expect(nowSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it.each([
    ['missing field', (spec: ProblemSpecV1) => spec, 'missing', '4\n10 20 30 40\n',
      'INVALID_RECIPE'],
    ['incompatible field type', (spec: ProblemSpecV1) => spec, 'n', '4\n10 20 30 40\n',
      'INVALID_RECIPE'],
    ['ambiguous field encoding', (spec: ProblemSpecV1) => {
      spec.inputFields.push({
        id: 'shadow', name: 'shadow', type: 'array',
        encoding: 'line:2 tokens:1..n', dependsOn: ['n'],
      });
      return spec;
    }, 'a', '4\n10 20 30 40\n', 'UNPARSEABLE_ENCODING'],
    ['invalid legal seed', (spec: ProblemSpecV1) => spec, 'a', '4\n10 10 30 40\n',
      'MUTATION_NOT_ISOLATED'],
  ] as const)(
    'returns a bounded gap for a custom recipe with %s',
    (_name, changeSpec, fieldId, seed, reasonCode) => {
      const spec = changeSpec(noncanonicalPairwiseDistinctSpec());
      const result = buildConstraintProbes({
        spec,
        statementHash: '1'.repeat(64),
        specHash: '2'.repeat(64),
        seeds: [{ source: 'formal', index: 1, input: seed }],
        recipes: [{ ...pairwiseDistinctRecipe, fieldId }],
      });

      expect(result.probes).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: 'I_PAIRWISE' }),
      ]));
      expect(result.gaps).toEqual(expect.arrayContaining([{
        targetId: 'I_PAIRWISE', targetKind: 'invariant', reasonCode,
      }]));
    },
  );

  it('does not credit a custom mutation that also breaks another canonical semantic', () => {
    const spec = noncanonicalPairwiseDistinctSpec();
    spec.invariants.push({
      id: 'I_CANONICAL', kind: 'custom', expression: 'allDistinct(a)',
      machineCheckable: true, evidence: { quote: 'all values are distinct' },
    });

    const result = buildNoncanonicalPairwiseProbe(spec);

    expect(result.probes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: 'I_PAIRWISE' }),
    ]));
    expect(result.gaps).toEqual(expect.arrayContaining([{
      targetId: 'I_PAIRWISE', targetKind: 'invariant',
      reasonCode: 'MUTATION_NOT_ISOLATED',
    }]));
  });
});

function structuralSpec(constructionKind: StructuralConstructionKind): {
  spec: ProblemSpecV1;
  recipe: ValidatorProbeRecipe;
} {
  const isTree = constructionKind === 'tree-missing-edge'
    || constructionKind === 'tree-cycle';
  const invariantKind = constructionKind.startsWith('graph-')
    ? constructionKind === 'graph-disconnected' ? 'connected' : 'simple-graph'
    : isTree ? 'tree' : 'dag';
  const expression = `${invariantKind === 'simple-graph' ? 'simpleGraph' : invariantKind}`
    + '(edges, vertices=1..n)';
  return {
    spec: {
      schemaVersion: 1,
      statementHash: '1'.repeat(64),
      problemKind: 'traditional',
      testCaseMode: { kind: 'single' },
      inputFields: [
        { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
        ...(isTree ? [] : [{
          id: 'm', name: 'm', type: 'integer' as const, encoding: 'line:1 token:2',
        }]),
        {
          id: 'edges',
          name: 'edges',
          type: isTree ? 'tree' : 'graph',
          encoding: isTree
            ? 'lines:2..n tokens:1,2'
            : 'lines:2..m+1 tokens:1,2',
          dependsOn: isTree ? ['n'] : ['n', 'm'],
        },
      ],
      constraints: [],
      invariants: [{
        id: 'I1',
        kind: invariantKind,
        expression,
        machineCheckable: true,
        evidence: { quote: expression },
      }],
      outputPolicy: { kind: 'exact' },
      subtasks: [],
      uncertainties: [],
    },
    recipe: { targetId: 'I1', constructionKind, fieldId: 'edges' },
  };
}

function buildStructuralFixture(constructionKind: StructuralConstructionKind, legal: string) {
  const { spec, recipe } = structuralSpec(constructionKind);
  return buildConstraintProbes({
    spec,
    statementHash: '1'.repeat(64),
    specHash: '2'.repeat(64),
    seeds: [{ source: 'formal', index: 1, input: legal }],
    recipes: [recipe],
  });
}

describe('structural constructions', () => {
  it.each<[StructuralConstructionKind, string, string]>([
    ['graph-self-loop', '3 2\n1 2\n2 3\n', '3 2\n1 1\n2 3\n'],
    ['graph-duplicate-edge', '3 2\n1 2\n2 3\n', '3 2\n1 2\n1 2\n'],
    ['graph-disconnected', '4 3\n1 2\n2 3\n3 4\n', '4 2\n1 2\n2 3\n'],
    ['tree-missing-edge', '4\n1 2\n2 3\n3 4\n', '4\n1 2\n2 3\n'],
    ['tree-cycle', '4\n1 2\n2 3\n3 4\n', '4\n1 2\n2 3\n3 1\n'],
    ['dag-cycle', '3 2\n1 2\n2 3\n', '3 3\n1 2\n2 3\n3 1\n'],
  ])('%s mutates a canonical edge list', (constructionKind, legal, illegal) => {
    const result = buildStructuralFixture(constructionKind, legal);

    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({
      constructionKind,
      input: illegal,
    })]));
    expect(result.gaps).toEqual([]);
  });

  it('preserves a declared zero-based vertex domain', () => {
    const { spec, recipe } = structuralSpec('dag-cycle');
    spec.invariants[0].expression = 'dag(edges, vertices=0..n-1)';
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '3 2\n0 1\n1 2\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([expect.objectContaining({
      constructionKind: 'dag-cycle',
      input: '3 3\n0 1\n1 2\n2 0\n',
    })]);
    expect(result.gaps).toEqual([]);
  });
});

function operationSpec(constructionKind: OperationConstructionKind): {
  spec: ProblemSpecV1;
  recipe: ValidatorProbeRecipe;
} {
  const operationName = constructionKind === 'delete-missing-object' ? 'DEL' : 'ADD';
  const isRange = constructionKind === 'operation-argument-out-of-range';
  const expression = isRange
    ? '1 <= x <= 10'
    : `${operationName} requires ${operationName === 'ADD' ? 'absent' : 'present'}(x)`;
  return {
    spec: {
      schemaVersion: 1,
      statementHash: '1'.repeat(64),
      problemKind: 'traditional',
      testCaseMode: { kind: 'single' },
      inputFields: [
        { id: 'q', name: 'q', type: 'integer', encoding: 'line:1 token:1' },
        { id: 'x', name: 'x', type: 'integer', encoding: 'operation-argument:x' },
        {
          id: 'ops',
          name: 'operations',
          type: 'operations',
          encoding: 'lines:2..q+1 operations',
          dependsOn: ['q'],
        },
      ],
      constraints: [{
        id: isRange ? 'C1' : 'C_RANGE',
        expression: '1 <= x <= 10',
        machineCheckable: isRange,
        scope: 'global',
        evidence: { quote: '1 <= x <= 10' },
      }],
      invariants: isRange ? [] : [{
        id: 'I1',
        kind: 'stateful-precondition',
        expression,
        machineCheckable: true,
        evidence: { quote: expression },
      }],
      outputPolicy: { kind: 'exact' },
      operations: [
        {
          name: 'ADD', arguments: ['x'], preconditions: ['absent(x)'], effects: ['add(x)'],
        },
        {
          name: 'DEL', arguments: ['x'], preconditions: ['present(x)'], effects: ['delete(x)'],
        },
      ],
      subtasks: [],
      uncertainties: [],
    },
    recipe: {
      targetId: isRange ? 'C1' : 'I1',
      constructionKind,
      fieldId: 'x',
      operationName,
    },
  };
}

function buildOperationFixture(constructionKind: OperationConstructionKind, legal: string) {
  const { spec, recipe } = operationSpec(constructionKind);
  return buildConstraintProbes({
    spec,
    statementHash: '1'.repeat(64),
    specHash: '2'.repeat(64),
    seeds: [{ source: 'formal', index: 1, input: legal }],
    recipes: [recipe],
  });
}

function buildScopedUpperBoundFixture() {
  return buildConstraintProbes({
    spec: integerSpec({ subtaskId: 1 }),
    statementHash: '1'.repeat(64),
    specHash: '2'.repeat(64),
    seeds: [
      { source: 'formal', index: 1, subtaskId: 2, input: '2\n' },
      { source: 'sample', index: 'sample-a', subtaskId: 1, input: '3\n' },
      { source: 'formal', index: 9, subtaskId: 1, input: '5\n' },
    ],
    recipes: [{
      targetId: 'C1', constructionKind: 'subtask-upper-bound', fieldId: 'n',
    }],
  });
}

describe('stateful operation and scoped constructions', () => {
  it.each<[OperationConstructionKind, string, string]>([
    ['add-existing-object', '3\nADD 1\nADD 2\nDEL 1\n', '3\nADD 1\nADD 1\nDEL 1\n'],
    ['delete-missing-object', '2\nADD 1\nDEL 1\n', '2\nADD 1\nDEL 2\n'],
    ['operation-argument-out-of-range', '2\nADD 1\nDEL 1\n', '2\nADD 11\nDEL 1\n'],
  ])('%s mutates a declared operation sequence', (constructionKind, legal, illegal) => {
    const result = buildOperationFixture(constructionKind, legal);

    expect(result.probes[0]).toEqual(expect.objectContaining({
      constructionKind,
      input: illegal,
    }));
    expect(result.gaps).toEqual([]);
  });

  it('constructs the scoped upper-bound probe only from its assigned formal seed', () => {
    const result = buildScopedUpperBoundFixture();

    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({
      constructionKind: 'subtask-upper-bound',
      subtaskId: 1,
      input: '11\n',
    })]));
    expect(result.gaps).toEqual([]);
  });

  it('maps the stateful object through the declared operation argument position', () => {
    const { spec, recipe } = operationSpec('add-existing-object');
    spec.inputFields.splice(1, 0, {
      id: 'tag', name: 'tag', type: 'integer', encoding: 'operation-argument:tag',
    });
    spec.operations = spec.operations?.map(operation => ({
      ...operation,
      arguments: ['tag', 'x'],
    }));
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{
        source: 'formal', index: 1,
        input: '3\nADD 99 1\nADD 88 2\nDEL 77 1\n',
      }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([expect.objectContaining({
      constructionKind: 'add-existing-object',
      input: '3\nADD 99 1\nADD 88 1\nDEL 77 1\n',
    })]);
    expect(result.gaps).toEqual([]);
  });

  it('intersects every applicable argument range before choosing a missing object', () => {
    const { spec, recipe } = operationSpec('delete-missing-object');
    spec.constraints.push({
      id: 'C_NARROW',
      expression: '1 <= x <= 2',
      machineCheckable: false,
      scope: 'global',
      evidence: { quote: '1 <= x <= 2' },
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '2\nADD 2\nDEL 2\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([expect.objectContaining({
      constructionKind: 'delete-missing-object',
      input: '2\nADD 2\nDEL 1\n',
    })]);
    expect(result.gaps).toEqual([]);
  });

  it('returns a bounded gap when every in-range object is already present', () => {
    const { spec, recipe } = operationSpec('delete-missing-object');
    spec.constraints.push({
      id: 'C_NARROW',
      expression: '1 <= x <= 2',
      machineCheckable: false,
      scope: 'global',
      evidence: { quote: '1 <= x <= 2' },
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '3\nADD 1\nADD 2\nDEL 2\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'I1', targetKind: 'invariant', reasonCode: 'MUTATION_NOT_ISOLATED',
    }]);
  });

  it('returns a bounded gap for conflicting applicable argument ranges', () => {
    const { spec, recipe } = operationSpec('delete-missing-object');
    spec.constraints.push({
      id: 'C_CONFLICT',
      expression: '20 <= x <= 30',
      machineCheckable: false,
      scope: 'global',
      evidence: { quote: '20 <= x <= 30' },
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '2\nADD 2\nDEL 2\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'I1', targetKind: 'invariant', reasonCode: 'MUTATION_NOT_ISOLATED',
    }]);
  });

  it('returns a bounded gap for an ambiguous applicable argument range', () => {
    const { spec, recipe } = operationSpec('delete-missing-object');
    spec.constraints.push({
      id: 'C_AMBIGUOUS',
      expression: '1 <= x <= limit',
      machineCheckable: false,
      scope: 'global',
      evidence: { quote: '1 <= x <= limit' },
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '2\nADD 2\nDEL 2\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'I1', targetKind: 'invariant', reasonCode: 'MUTATION_NOT_ISOLATED',
    }]);
  });

  it('does not violate a non-target range for an argument-range probe', () => {
    const { spec, recipe } = operationSpec('operation-argument-out-of-range');
    spec.constraints.push({
      id: 'C2',
      expression: '1 <= x <= 10',
      machineCheckable: false,
      scope: 'global',
      evidence: { quote: '1 <= x <= 10' },
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '2\nADD 1\nDEL 1\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'C1', targetKind: 'constraint', reasonCode: 'MUTATION_NOT_ISOLATED',
    }]);
  });

  it('intersects only global and matching-subtask argument ranges', () => {
    const { spec, recipe } = operationSpec('operation-argument-out-of-range');
    spec.constraints[0].scope = { subtaskId: 1 };
    spec.constraints.push(
      {
        id: 'C_GLOBAL',
        expression: '0 <= x <= 20',
        machineCheckable: false,
        scope: 'global',
        evidence: { quote: '0 <= x <= 20' },
      },
      {
        id: 'C_OTHER',
        expression: 'x <= 10',
        machineCheckable: false,
        scope: { subtaskId: 2 },
        evidence: { quote: 'x <= 10' },
      },
    );
    spec.subtasks = [
      { id: 1, score: 50, constraintIds: ['C1'] },
      { id: 2, score: 50, constraintIds: ['C_OTHER'] },
    ];
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, subtaskId: 1, input: '2\nADD 1\nDEL 1\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({
      targetId: 'C1', subtaskId: 1, input: '2\nADD 11\nDEL 1\n',
    })]));
    expect(result.gaps).toEqual([]);
  });

  it('does not credit an argument-range target when the mutation also breaks state semantics', () => {
    const { spec, recipe } = operationSpec('operation-argument-out-of-range');
    spec.invariants.push({
      id: 'I_STATE',
      kind: 'stateful-precondition',
      expression: 'DEL requires present(x)',
      machineCheckable: true,
      evidence: { quote: 'DEL requires present(x)' },
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '2\nADD 1\nDEL 1\n' }],
      recipes: [recipe],
    });

    expect(result.probes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: 'C1', constructionKind: 'integer-above-max',
      }),
    ]));
    expect(result.gaps).toEqual(expect.arrayContaining([{
      targetId: 'C1', targetKind: 'constraint', reasonCode: 'MUTATION_NOT_ISOLATED',
    }]));
  });
});

describe('target-isolated proof construction', () => {
  const everyFamily: Array<[
    string,
    () => { spec: ProblemSpecV1; recipe: ValidatorProbeRecipe; legal: string },
  ]> = [
    ['integer-below-min', () => ({ ...sequenceSpec('integer-below-min'), legal: '5\n' })],
    ['integer-above-max', () => ({ ...sequenceSpec('integer-above-max'), legal: '5\n' })],
    ['array-length-mismatch', () => ({
      ...sequenceSpec('array-length-mismatch'), legal: '3\n1 2 3\n',
    })],
    ['duplicate-element', () => ({
      ...sequenceSpec('duplicate-element'), legal: '4\n1 2 3 4\n',
    })],
    ['permutation-duplicate-or-missing', () => ({
      ...sequenceSpec('permutation-duplicate-or-missing'), legal: '4\n1 2 3 4\n',
    })],
    ['illegal-string-character', () => ({
      ...sequenceSpec('illegal-string-character'), legal: 'abc\n',
    })],
    ['graph-self-loop', () => ({
      ...structuralSpec('graph-self-loop'), legal: '3 2\n1 2\n2 3\n',
    })],
    ['graph-duplicate-edge', () => ({
      ...structuralSpec('graph-duplicate-edge'), legal: '3 2\n1 2\n2 3\n',
    })],
    ['graph-disconnected', () => ({
      ...structuralSpec('graph-disconnected'), legal: '4 3\n1 2\n2 3\n3 4\n',
    })],
    ['tree-missing-edge', () => ({
      ...structuralSpec('tree-missing-edge'), legal: '4\n1 2\n2 3\n3 4\n',
    })],
    ['tree-cycle', () => ({
      ...structuralSpec('tree-cycle'), legal: '4\n1 2\n2 3\n3 4\n',
    })],
    ['dag-cycle', () => ({
      ...structuralSpec('dag-cycle'), legal: '3 2\n1 2\n2 3\n',
    })],
    ['add-existing-object', () => ({
      ...operationSpec('add-existing-object'), legal: '3\nADD 1\nADD 2\nDEL 1\n',
    })],
    ['delete-missing-object', () => ({
      ...operationSpec('delete-missing-object'), legal: '2\nADD 1\nDEL 1\n',
    })],
    ['operation-argument-out-of-range', () => ({
      ...operationSpec('operation-argument-out-of-range'), legal: '2\nADD 1\nDEL 1\n',
    })],
    ['subtask-upper-bound', () => ({
      spec: integerSpec({ subtaskId: 1 }),
      recipe: {
        targetId: 'C1', constructionKind: 'subtask-upper-bound', fieldId: 'n',
      },
      legal: '5\n',
    })],
  ];

  it.each(everyFamily)(
    '%s is derived from Frozen Spec when model recipes are omitted',
    (_kind, makeFixture) => {
      const { spec, recipe, legal } = makeFixture();
      const target = spec.constraints.find(item => item.id === recipe.targetId)
        || spec.invariants.find(item => item.id === recipe.targetId)!;
      const targetSubtaskId = 'scope' in target && target.scope !== 'global'
        ? target.scope.subtaskId : undefined;
      const result = buildConstraintProbes({
        spec,
        statementHash: '1'.repeat(64),
        specHash: '2'.repeat(64),
        seeds: [{
          source: 'formal', index: 1, input: legal,
          ...(targetSubtaskId === undefined ? {} : { subtaskId: targetSubtaskId }),
        }],
        ...(_kind.length % 2 === 0 ? { recipes: [] } : {}),
      });

      expect(result.probes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          targetId: recipe.targetId,
          constructionKind: recipe.constructionKind,
        }),
      ]));
    },
  );

  it.each(everyFamily)(
    '%s uses its closed construction semantic for a noncanonical accepted recipe',
    (_kind, makeFixture) => {
      const { spec, recipe, legal } = makeFixture();
      const target = spec.constraints.find(item => item.id === recipe.targetId)
        || spec.invariants.find(item => item.id === recipe.targetId)!;
      target.expression = 'a genuinely noncanonical custom policy';
      const targetSubtaskId = 'scope' in target && target.scope !== 'global'
        ? target.scope.subtaskId : undefined;

      const result = buildConstraintProbes({
        spec,
        statementHash: '1'.repeat(64),
        specHash: '2'.repeat(64),
        seeds: [{
          source: 'formal', index: 1, input: legal,
          ...(targetSubtaskId === undefined ? {} : { subtaskId: targetSubtaskId }),
        }],
        recipes: [recipe],
      });

      expect(result.probes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          targetId: recipe.targetId,
          constructionKind: recipe.constructionKind,
        }),
      ]));
      expect(result.gaps).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: recipe.targetId }),
      ]));
    },
  );

  it('uses an extreme server-owned value for a noncanonical integer recipe with a unique field', () => {
    const spec = integerSpec();
    spec.constraints[0].expression = 'n has a custom upper policy';
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
      recipes: [{ targetId: 'C1', constructionKind: 'integer-above-max' }],
    });

    expect(result.probes).toEqual([expect.objectContaining({
      targetId: 'C1', targetKind: 'constraint', constructionKind: 'integer-above-max',
      input: `${Number.MAX_SAFE_INTEGER}\n`,
    })]);
    expect(result.gaps).toEqual([]);
  });

  it('does not apply model recipes after a deterministic target was attempted', () => {
    const spec = integerSpec();
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });

    expect(result.probes.map(probe => probe.constructionKind)).toEqual([
      'integer-below-min', 'integer-above-max',
    ]);
  });

  it.each(everyFamily)(
    '%s refuses proof when an applicable recognizable target has the same predicate',
    (_kind, makeFixture) => {
      const { spec, recipe, legal } = makeFixture();
      const constraint = spec.constraints.find(item => item.id === recipe.targetId);
      if (constraint) {
        spec.constraints.push({ ...constraint, id: 'C_DUPLICATE_SEMANTIC' });
      } else {
        const invariant = spec.invariants.find(item => item.id === recipe.targetId)!;
        spec.invariants.push({ ...invariant, id: 'I_DUPLICATE_SEMANTIC' });
      }
      const target = spec.constraints.find(item => item.id === recipe.targetId)
        || spec.invariants.find(item => item.id === recipe.targetId)!;
      const targetSubtaskId = 'scope' in target && target.scope !== 'global'
        ? target.scope.subtaskId : undefined;
      const result = buildConstraintProbes({
        spec,
        statementHash: '1'.repeat(64),
        specHash: '2'.repeat(64),
        seeds: [{
          source: 'formal', index: 1, input: legal,
          ...(targetSubtaskId === undefined ? {} : { subtaskId: targetSubtaskId }),
        }],
        recipes: [recipe],
      });

      expect(result.probes).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: recipe.targetId }),
      ]));
      expect(result.gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          targetId: recipe.targetId, reasonCode: 'MUTATION_NOT_ISOLATED',
        }),
      ]));
    },
  );

  it('does not credit an overlapping scalar upper bound rejected by the other bound', () => {
    const spec = integerSpec();
    spec.constraints.push({
      id: 'C_OTHER',
      expression: 'n <= 5',
      machineCheckable: true,
      scope: 'global',
      evidence: { quote: 'n <= 5' },
    });

    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-above-max', fieldId: 'n',
      }],
    });

    expect(result.probes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: 'C1', constructionKind: 'integer-above-max',
      }),
    ]));
    expect(result.gaps).toEqual(expect.arrayContaining([{
      targetId: 'C1', targetKind: 'constraint', reasonCode: 'MUTATION_NOT_ISOLATED',
    }]));
  });

  it('applies global semantics to a scoped target but ignores other scoped semantics', () => {
    const spec = integerSpec({ subtaskId: 1 });
    spec.constraints.push(
      {
        id: 'C_GLOBAL', expression: 'n <= 5', machineCheckable: true,
        scope: 'global', evidence: { quote: 'n <= 5' },
      },
      {
        id: 'C_OTHER_SUBTASK', expression: 'n <= 4', machineCheckable: true,
        scope: { subtaskId: 2 }, evidence: { quote: 'n <= 4' },
      },
    );
    spec.subtasks = [
      { id: 1, score: 50, constraintIds: ['C1'] },
      { id: 2, score: 50, constraintIds: ['C_OTHER_SUBTASK'] },
    ];

    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, subtaskId: 1, input: '5\n' }],
      recipes: [{
        targetId: 'C1', constructionKind: 'subtask-upper-bound', fieldId: 'n',
      }],
    });

    expect(result.probes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: 'C1', constructionKind: 'subtask-upper-bound',
      }),
    ]));
    expect(result.gaps).toEqual(expect.arrayContaining([{
      targetId: 'C1', targetKind: 'constraint', subtaskId: 1,
      reasonCode: 'MUTATION_NOT_ISOLATED',
    }]));
  });
});

describe('construction coverage deduplication and gaps', () => {
  it('covers all declared construction kinds with canonical supported fixtures', () => {
    const scalarInputs: Array<[ScalarSequenceConstructionKind, string]> = [
      ['integer-below-min', '5\n'],
      ['integer-above-max', '5\n'],
      ['array-length-mismatch', '3\n1 2 3\n'],
      ['duplicate-element', '4\n1 2 3 4\n'],
      ['permutation-duplicate-or-missing', '4\n1 2 3 4\n'],
      ['illegal-string-character', 'abc\n'],
    ];
    const structuralInputs: Array<[StructuralConstructionKind, string]> = [
      ['graph-self-loop', '3 2\n1 2\n2 3\n'],
      ['graph-duplicate-edge', '3 2\n1 2\n2 3\n'],
      ['graph-disconnected', '4 3\n1 2\n2 3\n3 4\n'],
      ['tree-missing-edge', '4\n1 2\n2 3\n3 4\n'],
      ['tree-cycle', '4\n1 2\n2 3\n3 4\n'],
      ['dag-cycle', '3 2\n1 2\n2 3\n'],
    ];
    const operationInputs: Array<[OperationConstructionKind, string]> = [
      ['add-existing-object', '3\nADD 1\nADD 2\nDEL 1\n'],
      ['delete-missing-object', '2\nADD 1\nDEL 1\n'],
      ['operation-argument-out-of-range', '2\nADD 1\nDEL 1\n'],
    ];
    const results = [
      ...scalarInputs.map(([kind, legal]) => buildSingleTargetFixture(kind, legal)),
      ...structuralInputs.map(([kind, legal]) => buildStructuralFixture(kind, legal)),
      ...operationInputs.map(([kind, legal]) => buildOperationFixture(kind, legal)),
      buildScopedUpperBoundFixture(),
    ];

    expect(results.every((result, index) => result.probes.some(probe => (
      probe.constructionKind === VALIDATOR_PROBE_CONSTRUCTION_KINDS[index]
    )))).toBe(true);
    expect(results.every(result => result.gaps.length === 0)).toBe(true);
  });

  it('preserves stable server-derived order and ignores recipes for an attempted target', () => {
    const spec = integerSpec();
    const input = {
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal' as const, index: 1, input: '5\n' }],
      recipes: [
        { targetId: 'C1', constructionKind: 'integer-above-max' as const, fieldId: 'n' },
        { targetId: 'C1', constructionKind: 'integer-below-min' as const, fieldId: 'n' },
      ],
    };

    const first = buildConstraintProbes(input);
    const second = buildConstraintProbes(input);

    expect(first.probes.map(probe => probe.constructionKind)).toEqual([
      'integer-below-min', 'integer-above-max',
    ]);
    expect(second).toEqual(first);
  });

  it('does not duplicate server-derived probe ids for redundant model recipes', () => {
    const recipe: ValidatorProbeRecipe = {
      targetId: 'C1', constructionKind: 'integer-above-max', fieldId: 'n',
    };
    const result = buildConstraintProbes({
      spec: integerSpec(),
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
      recipes: [recipe, { ...recipe }],
    });

    expect(result.probes.map(probe => probe.constructionKind)).toEqual([
      'integer-below-min', 'integer-above-max',
    ]);
    expect(new Set(result.probes.map(probe => probe.id)).size).toBe(result.probes.length);
    expect(result.gaps).toEqual([]);
  });

  it('reports every uncovered machine-checkable target exactly once', () => {
    const spec = integerSpec();
    spec.constraints.push({
      ...spec.constraints[0], id: 'C2', expression: 'n follows a custom policy',
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });

    expect(result.probes).toHaveLength(2);
    expect(result.gaps).toEqual([{
      targetId: 'C2', targetKind: 'constraint', reasonCode: 'UNSUPPORTED_TARGET',
    }]);
  });

  it('deduplicates public gaps by target subtask and reason tuple', () => {
    const invalidRecipe: ValidatorProbeRecipe = {
      targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'missing',
    };
    const spec = integerSpec({ subtaskId: 1 });
    spec.constraints[0].expression = 'n follows a custom policy';
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, subtaskId: 1, input: '5\n' }],
      recipes: [invalidRecipe, { ...invalidRecipe }],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'C1',
      targetKind: 'constraint',
      subtaskId: 1,
      reasonCode: 'INVALID_RECIPE',
    }]);
  });

  it('returns stable bounded gaps when a structural or operation mutation is not isolated', () => {
    const structural = structuralSpec('graph-self-loop');
    structural.spec.inputFields.find(field => field.id === 'edges')!.encoding = 'free text';
    const structuralResult = buildConstraintProbes({
      spec: structural.spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '3 2\n1 2\n2 3\n' }],
      recipes: [structural.recipe],
    });
    const operationResult = buildOperationFixture('add-existing-object', '1\nADD 1\n');

    expect(structuralResult.probes).toEqual([]);
    expect(structuralResult.gaps).toEqual([{
      targetId: 'I1', targetKind: 'invariant', reasonCode: 'UNPARSEABLE_ENCODING',
    }]);
    expect(operationResult.probes).toEqual([]);
    expect(operationResult.gaps).toEqual([{
      targetId: 'I1', targetKind: 'invariant', reasonCode: 'MUTATION_NOT_ISOLATED',
    }]);
  });
});

function withMarkerField(spec: ProblemSpecV1): ProblemSpecV1 {
  return {
    ...spec,
    inputFields: [
      ...spec.inputFields,
      { id: 'marker', name: 'marker', type: 'string', encoding: 'line:2 token:1' },
    ],
  };
}

describe('constraint probe scope gaps bounds and privacy', () => {
  it('uses only the matching formal seed for a scoped target', () => {
    const spec = withMarkerField(integerSpec({ subtaskId: 1 }));
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [
        { source: 'stress', index: 1, subtaskId: 1, input: '5\nSTRESS\n' },
        { source: 'sample', index: 'sample-a', subtaskId: 1, input: '5\nSAMPLE\n' },
        { source: 'formal', index: 1, subtaskId: 2, input: '5\nWRONG\n' },
        { source: 'formal', index: 9, subtaskId: 1, input: '5\nMATCH\n' },
      ],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });

    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({
      targetId: 'C1', subtaskId: 1, input: '-1\nMATCH\n',
    })]));
    expect(result.gaps).toEqual([]);
  });

  it('uses the first deterministic seed for a global target', () => {
    const spec = withMarkerField(integerSpec());
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [
        { source: 'stress', index: 1, input: '5\nSTRESS\n' },
        { source: 'formal', index: 9, input: '5\nFORMAL-9\n' },
        { source: 'sample', index: 'sample-a', input: '5\nSAMPLE\n' },
        { source: 'formal', index: 1, input: '5\nFORMAL-1\n' },
      ],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });

    expect(result.probes[0].input).toBe('-1\nFORMAL-1\n');
    expect(result.gaps).toEqual([]);
  });

  it('normalizes line endings while preserving unrelated bytes', () => {
    const result = buildConstraintProbes({
      spec: withMarkerField(integerSpec()),
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5  KEEP\r\nnext\tline\r\n' }],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });

    expect(result.probes[0].input).toBe('-1  KEEP\nnext\tline\n');
  });

  it.each([
    ['free-text encoding', (spec: ProblemSpecV1) => {
      spec.inputFields[0].encoding = 'the first integer is n';
    }, 'UNPARSEABLE_ENCODING'],
    ['ambiguous field layout', (spec: ProblemSpecV1) => {
      spec.inputFields.push({
        id: 'shadow', name: 'shadow', type: 'integer', encoding: 'line:1 token:1',
      });
    }, 'UNPARSEABLE_ENCODING'],
  ] as const)('%s returns a bounded gap', (_name, changeSpec, reasonCode) => {
    const spec = integerSpec();
    changeSpec(spec);
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'C1', targetKind: 'constraint', reasonCode,
    }]);
  });

  it('keeps a noncanonical server-derived target unsupported without an accepted recipe', () => {
    const spec = integerSpec();
    spec.constraints[0].expression = 'n is small';

    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'C1', targetKind: 'constraint', reasonCode: 'UNSUPPORTED_TARGET',
    }]);
  });

  it('returns DEPENDENCY_NOT_RESOLVED when a sequence count is undeclared', () => {
    const { spec, recipe } = sequenceSpec('array-length-mismatch');
    delete spec.inputFields[1].dependsOn;
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '3\n1 2 3\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps[0]).toEqual(expect.objectContaining({
      targetId: 'C1', reasonCode: 'DEPENDENCY_NOT_RESOLVED',
    }));
  });

  it('returns a bounded gap when the sequence count location is ambiguous', () => {
    const { spec, recipe } = sequenceSpec('array-length-mismatch');
    spec.inputFields.push({
      id: 'shadowCount', name: 'shadowCount', type: 'integer', encoding: 'line:1 token:1',
    });
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '3\n1 2 3\n' }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'C1', targetKind: 'constraint', reasonCode: 'UNPARSEABLE_ENCODING',
    }]);
  });

  it('does not use sample or stress seeds for a scoped target', () => {
    const result = buildConstraintProbes({
      spec: integerSpec({ subtaskId: 1 }),
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [
        { source: 'sample', index: 'sample-a', subtaskId: 1, input: '5\n' },
        { source: 'stress', index: 1, subtaskId: 1, input: '5\n' },
      ],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'C1', targetKind: 'constraint', subtaskId: 1,
      reasonCode: 'NO_MATCHING_LEGAL_SEED',
    }]);
  });

  it('returns PROBE_TOO_LARGE instead of emitting an oversized mutation', () => {
    const { spec, recipe } = sequenceSpec('illegal-string-character');
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: `${'a'.repeat(256 * 1024)}\n` }],
      recipes: [recipe],
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps[0]).toEqual(expect.objectContaining({
      targetId: 'C1', reasonCode: 'PROBE_TOO_LARGE',
    }));
  });

  it('does not expose canonical seeds, unused raw inputs, code, or errors', () => {
    const result = buildConstraintProbes({
      spec: integerSpec(),
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [
        { source: 'formal', index: 1, input: '5\n' },
        { source: 'sample', index: 'private-sample', input: 'PRIVATE_SAMPLE\n' },
        { source: 'stress', index: 9, input: 'PRIVATE_STRESS\n' },
      ],
      recipes: [{
        targetId: 'C1', constructionKind: 'integer-below-min', fieldId: 'n',
      }],
    });
    const serialized = JSON.stringify(result);

    expect(result.probes[0].input).toBe('-1\n');
    expect(serialized).not.toContain('PRIVATE_SAMPLE');
    expect(serialized).not.toContain('PRIVATE_STRESS');
    expect(serialized).not.toContain('private-sample');
    expect(serialized).not.toContain('"source"');
    expect(serialized).not.toContain('"index"');
    expect(serialized).not.toContain('"code"');
    expect(serialized).not.toContain('"error"');
  });

  it('fails closed without leaking recipe contents above the 64-recipe boundary', () => {
    const spec = integerSpec();
    spec.constraints = Array.from({ length: 65 }, (_, index) => ({
      ...spec.constraints[0],
      id: `PRIVATE_RECIPE_${index + 1}`,
    }));
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: [{ source: 'formal', index: 1, input: '5\n' }],
      recipes: spec.constraints.map(constraint => ({
        targetId: constraint.id,
        constructionKind: 'integer-below-min',
        fieldId: 'n',
      })),
    });

    expect(result.probes).toEqual([]);
    expect(result.gaps).toEqual([{
      targetId: 'recipes', targetKind: 'constraint', reasonCode: 'INVALID_RECIPE',
    }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RECIPE');
  });

  it('accepts exactly 64 direct-builder recipes', () => {
    const spec = integerSpec();
    spec.constraints = Array.from({ length: 64 }, (_, index) => ({
      ...spec.constraints[0],
      id: `C${index + 1}`,
      expression: 'n >= 0',
      scope: { subtaskId: index + 1 } as const,
    }));
    spec.subtasks = spec.constraints.map((constraint, index) => ({
      id: index + 1,
      score: 1,
      constraintIds: [constraint.id],
    }));
    const result = buildConstraintProbes({
      spec,
      statementHash: '1'.repeat(64),
      specHash: '2'.repeat(64),
      seeds: spec.constraints.map((_constraint, index) => ({
        source: 'formal' as const,
        index: index + 1,
        subtaskId: index + 1,
        input: '5\n',
      })),
      recipes: spec.constraints.map(constraint => ({
        targetId: constraint.id,
        constructionKind: 'integer-below-min',
        fieldId: 'n',
      })),
    });

    expect(result.probes).toHaveLength(64);
    expect(result.gaps).toEqual([]);
  });
});
