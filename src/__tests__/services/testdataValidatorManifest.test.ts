import {
  parseAndValidateValidatorManifest,
  parseAndValidateValidatorProbeRecipes,
  requiredValidatorTargetIds,
} from '../../services/testdata/validatorManifest';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';

function frozenSpec(): ProblemSpecV1 {
  return {
    schemaVersion: 1,
    statementHash: 'a'.repeat(64),
    problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields: Array.from({ length: 65 }, (_, index) => ({
      id: index === 0 ? 'a' : `a-${index}`,
      name: `a-${index}`,
      type: 'integer' as const,
      encoding: 'one integer',
    })),
    constraints: [
      {
        id: 'C1', expression: 'a >= 1', machineCheckable: true, scope: 'global',
        evidence: { quote: 'a >= 1' },
      },
      {
        id: 'C2', expression: 'a <= 10', machineCheckable: true, scope: { subtaskId: 1 },
        evidence: { quote: 'a <= 10' },
      },
      {
        id: 'C3', expression: 'a is meaningful', machineCheckable: false, scope: 'global',
        evidence: { quote: 'a is meaningful' },
      },
    ],
    invariants: [
      {
        id: 'I1', kind: 'custom', expression: 'a is valid', machineCheckable: true,
        evidence: { quote: 'a is valid' },
      },
      {
        id: 'I2', kind: 'custom', expression: 'a is pedagogical', machineCheckable: false,
        evidence: { quote: 'a is pedagogical' },
      },
    ],
    outputPolicy: { kind: 'exact' },
    subtasks: [{ id: 1, score: 100, constraintIds: ['C2'] }],
    uncertainties: [],
  };
}

describe('validator manifest', () => {
  const spec = frozenSpec();

  it.each([
    ['missing invariant', '{"constraintIds":["C1","C2"],"invariantIds":[]}'],
    ['unknown id', '{"constraintIds":["C1","C2","CX"],"invariantIds":["I1"]}'],
    ['duplicate id', '{"constraintIds":["C1","C1","C2"],"invariantIds":["I1"]}'],
    ['wrong type', '{"constraintIds":"C1","invariantIds":["I1"]}'],
    ['extra field', '{"constraintIds":["C1","C2"],"invariantIds":["I1"],"scope":1}'],
    ['fenced json', '```json\n{"constraintIds":["C1","C2"],"invariantIds":["I1"]}\n```'],
    ['json prefix', 'manifest={"constraintIds":["C1","C2"],"invariantIds":["I1"]}'],
  ])('%s manifest fails closed', (_name, raw) => {
    try {
      parseAndValidateValidatorManifest(raw, spec);
      throw new Error('expected strict manifest parsing to fail');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({
        code: 'VALIDATOR_CONSTRAINT_COVERAGE_MISSING',
        artifact: 'coverage',
      }));
      expect(JSON.stringify((error as { safeDetails?: unknown }).safeDetails || {}))
        .not.toContain(raw);
    }
  });

  it('returns sorted required and declared machine-checkable targets', () => {
    expect(parseAndValidateValidatorManifest(
      '{"constraintIds":["C2","C1"],"invariantIds":["I1"]}',
      spec,
    )).toEqual({
      manifest: { constraintIds: ['C1', 'C2'], invariantIds: ['I1'] },
      requiredConstraintIds: ['C1', 'C2'],
      requiredInvariantIds: ['I1'],
      missingConstraintIds: [],
      missingInvariantIds: [],
    });
  });

  it('uses only machine-checkable targets and rejects manual targets as proof', () => {
    expect(requiredValidatorTargetIds(spec)).toEqual({
      constraintIds: ['C1', 'C2'], invariantIds: ['I1'],
    });
    expect(() => parseAndValidateValidatorManifest(
      '{"constraintIds":["C1","C2","C3"],"invariantIds":["I1"]}',
      spec,
    )).toThrow(expect.objectContaining({ code: 'VALIDATOR_CONSTRAINT_COVERAGE_MISSING' }));
    expect(() => parseAndValidateValidatorManifest(
      '{"constraintIds":["C1","C2"],"invariantIds":["I1","I2"]}',
      spec,
    )).toThrow(expect.objectContaining({ code: 'VALIDATOR_CONSTRAINT_COVERAGE_MISSING' }));
  });

  it('accepts empty arrays when no targets are machine-checkable', () => {
    const specWithNoMachineCheckableTargets: ProblemSpecV1 = {
      ...spec,
      constraints: spec.constraints.map(constraint => ({ ...constraint, machineCheckable: false })),
      invariants: spec.invariants.map(invariant => ({ ...invariant, machineCheckable: false })),
    };

    expect(parseAndValidateValidatorManifest(
      '{"constraintIds":[],"invariantIds":[]}',
      specWithNoMachineCheckableTargets,
    ).manifest).toEqual({ constraintIds: [], invariantIds: [] });
  });
});

describe('validator probe recipe', () => {
  const spec = frozenSpec();

  function distinctLegalRecipes(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      targetId: 'I1',
      constructionKind: 'duplicate-element',
      fieldId: index === 0 ? 'a' : `a-${index}`,
    }));
  }

  function expectRecipeFailure(raw: string): void {
    expect(() => parseAndValidateValidatorProbeRecipes(raw, spec))
      .toThrow(expect.objectContaining({
        code: 'VALIDATOR_CONSTRAINT_COVERAGE_MISSING',
        artifact: 'coverage',
      }));
  }

  it('returns a bounded recipe for a known machine-checkable target', () => {
    expect(parseAndValidateValidatorProbeRecipes(
      '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","fieldId":"a"}]}',
      spec,
    )).toEqual([{
      targetId: 'I1',
      constructionKind: 'duplicate-element',
      fieldId: 'a',
    }]);
  });

  it('rejects more than 64 recipes', () => {
    expectRecipeFailure(JSON.stringify({ recipes: distinctLegalRecipes(65) }));
  });

  it('accepts exactly 64 otherwise-valid recipes', () => {
    const recipes = parseAndValidateValidatorProbeRecipes(
      JSON.stringify({ recipes: distinctLegalRecipes(64) }),
      spec,
    );

    expect(recipes).toHaveLength(64);
    expect(recipes[0]).toEqual({
      targetId: 'I1', constructionKind: 'duplicate-element', fieldId: 'a',
    });
    expect(recipes[63]).toEqual({
      targetId: 'I1', constructionKind: 'duplicate-element', fieldId: 'a-63',
    });
  });

  it('rejects duplicate canonical recipes', () => {
    expectRecipeFailure('{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","fieldId":"a"},{"targetId":"I1","constructionKind":"duplicate-element","fieldId":"a"}]}');
  });

  it.each([
    ['unknown target', '{"recipes":[{"targetId":"IX","constructionKind":"duplicate-element"}]}'],
    ['non-machine-checkable target', '{"recipes":[{"targetId":"I2","constructionKind":"duplicate-element"}]}'],
    ['unknown construction kind', '{"recipes":[{"targetId":"I1","constructionKind":"arbitrary-code"}]}'],
    ['extra key', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","scope":1}]}'],
    ['raw input', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","input":"1"}]}'],
    ['subtask id', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","subtaskId":1}]}'],
    ['seed index', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","seedIndex":1}]}'],
    ['replacement value', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","value":"1"}]}'],
    ['code', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","code":"return 1"}]}'],
    ['unknown field id', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","fieldId":"missing"}]}'],
    ['unknown operation name', '{"recipes":[{"targetId":"I1","constructionKind":"duplicate-element","operationName":"MISSING"}]}'],
  ])('%s fails closed', (_name, raw) => {
    expectRecipeFailure(raw);
  });
});
