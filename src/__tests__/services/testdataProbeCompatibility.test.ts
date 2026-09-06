import { buildConstraintProbes } from '../../services/testdata/constraintProbes';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';

function fixture(): ProblemSpecV1 {
  return {
    schemaVersion: 1, statementHash: '1'.repeat(64), problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields: [
      { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
      { id: 'a', name: 'a', type: 'array', encoding: 'line:2 tokens:1..n', dependsOn: ['n'] },
    ],
    constraints: [], invariants: [], outputPolicy: { kind: 'exact' }, subtasks: [], uncertainties: [],
  };
}

function constraint(id: string, expression: string): ProblemSpecV1['constraints'][number] {
  return { id, expression, machineCheckable: true, scope: 'global', evidence: { quote: expression } };
}

function build(spec: ProblemSpecV1, inputs: string[]) {
  return buildConstraintProbes({
    spec, statementHash: spec.statementHash, specHash: '2'.repeat(64),
    seeds: inputs.map((input, index) => ({ source: 'formal' as const, index, input })),
  });
}

describe('bounded constraint compatibility and seed selection', () => {
  it('checks unique field names without changing the frozen spec or confusing ids', () => {
    const spec = fixture();
    spec.inputFields = [
      { id: 'field-a', name: 'a', type: 'integer', encoding: 'line:1 token:1' },
      { id: 'field-b', name: 'b', type: 'integer', encoding: 'line:1 token:2' },
    ];
    spec.constraints = [constraint('A', '-10 <= a <= 10'), constraint('B', 'b >= -10')];
    const snapshot = JSON.stringify(spec);
    const result = build(spec, ['2 3\n']);
    expect(result.probes.map(p => [p.targetId, p.input])).toEqual([
      ['A', '-11 3\n'], ['A', '11 3\n'], ['B', '2 -11\n'],
    ]);
    expect(result.gaps).toEqual([]);
    expect(JSON.stringify(spec)).toBe(snapshot);
  });

  it('does not resolve ambiguous names or evaluate arbitrary expressions', () => {
    const spec = fixture();
    spec.inputFields = [
      { id: 'left', name: 'a', type: 'integer', encoding: 'line:1 token:1' },
      { id: 'right', name: 'a', type: 'integer', encoding: 'line:1 token:2' },
    ];
    spec.constraints = [constraint('A', 'a <= 10'), constraint('B', 'left <= (5 + 5)')];
    expect(build(spec, ['2 3\n']).probes).toEqual([]);
  });

  it.each(['len(a) == n', 'length(a) = n'])('supports %s with both quantified array bounds', expression => {
    const spec = fixture();
    spec.constraints = [constraint('LOW', 'forall i: a[i] >= -10'), constraint('HIGH', 'a[i] <= 10')];
    spec.invariants = [{ id: 'LEN', kind: 'custom', expression, machineCheckable: true, evidence: { quote: expression } }];
    const result = build(spec, ['3\n2 3 4\n']);
    expect(result.probes.map(p => [p.targetId, p.input])).toEqual([
      ['LOW', '3\n-11 3 4\n'], ['HIGH', '3\n11 3 4\n'], ['LEN', '3\n2 3\n'],
    ]);
    expect(result.gaps).toEqual([]);
  });

  it('preserves array length while isolating scalar count boundaries', () => {
    const spec = fixture();
    spec.constraints = [constraint('N', '1 <= n <= 10'), constraint('LEN', 'len(a) == n')];
    expect(build(spec, ['3\n1 2 3\n']).probes.filter(p => p.targetId === 'N').map(p => p.input))
      .toEqual(['0\n\n', '11\n1 2 3 3 3 3 3 3 3 3 3\n']);
  });

  it('still refuses count mutations that would violate another distinctness requirement', () => {
    const spec = fixture();
    spec.constraints = [constraint('N', 'n <= 3'), constraint('LEN', 'len(a) == n'), constraint('UNIQUE', 'allDistinct(a)')];
    expect(build(spec, ['3\n1 2 3\n']).probes.some(p => p.targetId === 'N')).toBe(false);
  });

  it('constructs a real large count boundary within data limits and rejects unbounded allocation', () => {
    const spec = fixture();
    spec.constraints = [constraint('N', 'n <= 200000'), constraint('LEN', 'len(a) == n')];
    const probe = build(spec, ['2\n1 2\n']).probes.find(p => p.targetId === 'N')!;
    expect(probe.input.split('\n')[1].split(' ')).toHaveLength(200001);
    expect(Buffer.byteLength(probe.input)).toBeGreaterThan(256 * 1024);
    spec.constraints[0].expression = 'n <= 9007199254740990';
    expect(build(spec, ['2\n1 2\n']).probes.some(p => p.targetId === 'N')).toBe(false);
  });

  it('uses a later small legal seed when the first probe would exceed the existing budget', () => {
    const spec = fixture();
    spec.constraints = [constraint('LEN', 'length(a) = n')];
    const large = `2\n${'1'.repeat(4 * 1024 * 1024)} 2\n`;
    const result = build(spec, [large, '2\n1 2\n']);
    expect(result.probes).toHaveLength(1);
    expect(result.probes[0].input).toBe('2\n1\n');
    expect(result.gaps).toEqual([]);
  });

  it('tries later seeds when the first cannot express the targeted duplicate', () => {
    const spec = fixture();
    spec.constraints = [constraint('UNIQUE', 'allDistinct(a)')];
    const result = build(spec, ['1\n1\n', '2\n1 2\n']);
    expect(result.probes[0]?.input).toBe('2\n1 1\n');
    expect(result.gaps).toEqual([]);
  });

  it('does not hide a provably illegal accepted seed by borrowing a later legal one', () => {
    const spec = fixture();
    spec.constraints = [constraint('UNIQUE', 'allDistinct(a)')];
    const result = build(spec, ['2\n1 1\n', '2\n1 2\n']);
    expect(result.probes).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ targetId: 'UNIQUE', reasonCode: 'MUTATION_NOT_ISOLATED' }));
  });

  it('never borrows a seed from another subtask', () => {
    const spec = fixture();
    spec.constraints = [{ ...constraint('UNIQUE', 'allDistinct(a)'), scope: { subtaskId: 2 } }];
    spec.subtasks = [{ id: 2, score: 100, constraintIds: ['UNIQUE'] }];
    const result = buildConstraintProbes({ spec, statementHash: spec.statementHash, specHash: '2'.repeat(64), seeds: [
      { source: 'formal', index: 1, subtaskId: 1, input: '2\n1 2\n' },
      { source: 'formal', index: 2, subtaskId: 2, input: '1\n1\n' },
    ] });
    expect(result.probes).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ targetId: 'UNIQUE', subtaskId: 2 }));
  });

  it('bounds total emitted probe bytes and records a gap instead of exceeding the batch', () => {
    const spec = fixture();
    spec.inputFields = ['a', 'b', 'c'].map((id, index) => ({
      id, name: id, type: 'integer', encoding: `line:1 token:${index + 1}`,
    }));
    spec.constraints = ['a', 'b', 'c'].map(id => constraint(id.toUpperCase(), `${id} >= 1`));
    const result = build(spec, [`1 2 3\n${' '.repeat(3 * 1024 * 1024)}\n`]);
    expect(result.probes).toHaveLength(2);
    expect(result.probes.reduce((sum, probe) => sum + Buffer.byteLength(probe.input), 0))
      .toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.gaps).toContainEqual(expect.objectContaining({ targetId: 'C', reasonCode: 'PROBE_BATCH_TOO_LARGE' }));
  });
});
