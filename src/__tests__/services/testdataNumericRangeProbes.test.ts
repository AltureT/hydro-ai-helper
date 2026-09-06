import { buildConstraintProbes } from '../../services/testdata/constraintProbes';
import { rangeStringFixture } from '../fixtures/rangeStringSpec';

function fixture() {
  const spec = rangeStringFixture();
  spec.inputFields[2] = { id: 'a', name: 'a', type: 'array', encoding: 'line:2 tokens:1..n', dependsOn: ['n'] };
  for (const id of ['l', 'r', 'x']) spec.inputFields.push({ id, name: id, type: 'integer', encoding: `operation-argument:${id}` });
  spec.operations = [
    { name: '1', arguments: ['l', 'r', 'x'], preconditions: ['1 <= l <= r <= n'], effects: ['add x to the interval'] },
    { name: '2', arguments: ['l', 'r'], preconditions: ['1 <= l <= r <= n'], effects: ['output interval sum'] },
  ];
  spec.constraints = spec.constraints.filter(c => !['LEN', 'BINARY'].includes(c.id));
  for (const [id, expression] of [['A', '-10 <= a[i] <= 10'], ['X', '-10 <= x <= 10']]) {
    spec.constraints.push({ id, expression, scope: 'global', machineCheckable: true, evidence: { quote: expression } });
  }
  return spec;
}
const legal = '3 2\n1 -2 3\n1 1 3 10\n2 2 3\n';
function build(spec = fixture(), input = legal) {
  return buildConstraintProbes({ spec, statementHash: spec.statementHash, specHash: '2'.repeat(64),
    seeds: [{ source: 'formal', index: 0, input }] });
}

it('proves numeric mixed-arity ranges and argument bounds with an initial array', () => {
  const result = build();
  expect(result.probes.filter(p => p.targetId === 'RANGE')).toHaveLength(6);
  expect(result.probes.some(p => p.targetId === 'X')).toBe(true);
  expect(result.probes.some(p => p.targetId === 'Q')).toBe(true);
  for (const probe of result.probes) {
    const [header, values, ...rows] = probe.input.trimEnd().split('\n');
    const [n, q] = header.split(/\s+/).map(Number);
    const a = values ? values.split(/\s+/).map(Number) : [];
    expect(a).toHaveLength(n);
    expect(rows).toHaveLength(q);
    const invalid = [];
    if (n < 1 || n > 8) invalid.push('N');
    if (q < 1 || q > 8) invalid.push('Q');
    if (a.some(x => x < -10 || x > 10)) invalid.push('A');
    if (rows.some(row => { const [, l, r] = row.split(/\s+/).map(Number); return !(1 <= l && l <= r && r <= n); })) invalid.push('RANGE');
    if (rows.some(row => { const [op, , , x] = row.split(/\s+/).map(Number); return op === 1 && (x < -10 || x > 10); })) invalid.push('X');
    for (const row of rows) expect(row.split(/\s+/)).toHaveLength(row.startsWith('1 ') ? 4 : 3);
    expect(invalid).toEqual([probe.targetId]);
  }
  expect(result.gaps).toEqual([{ targetId: 'N', targetKind: 'constraint', reasonCode: 'MUTATION_NOT_ISOLATED' }]);
});

it('retains gaps for ambiguous prefixes, unknown rows and opaque preconditions', () => {
  for (const alter of [
    (spec: ReturnType<typeof fixture>) => { spec.inputFields[2].dependsOn = []; },
    (spec: ReturnType<typeof fixture>) => { spec.inputFields[2].encoding = 'line:3 tokens:1..n'; },
    (spec: ReturnType<typeof fixture>) => { spec.operations![0].preconditions.push('a[l] > 0'); },
    (spec: ReturnType<typeof fixture>) => { spec.operations![0].arguments.push('undeclared'); },
  ]) {
    const spec = fixture(); alter(spec);
    expect(build(spec).probes.filter(p => ['RANGE', 'X'].includes(p.targetId))).toEqual([]);
  }
  expect(build(fixture(), legal.replace('1 1 3 10', '3 1 3 10')).probes).toEqual([]);
});

it('does not use the stateless range path for object-presence operations', () => {
  const spec = fixture();
  spec.operations = [
    { name: 'ADD', arguments: ['l', 'r', 'x'], preconditions: ['absent(x)'], effects: ['add(x)'] },
    { name: 'DEL', arguments: ['l', 'r', 'x'], preconditions: ['present(x)'], effects: ['delete(x)'] },
  ];
  const result = build(spec, '3 2\n1 -2 3\nADD 1 3 10\nDEL 2 3 10\n');
  expect(result.probes.filter(p => ['Q', 'X', 'RANGE'].includes(p.targetId))).toEqual([]);
});

it('retains opaque payload invariants while allowing an unchanged closed opcode domain', () => {
  const spec = fixture();
  const expression = 'for every operation, opcode in [1, 2]';
  spec.constraints.push({ id: 'OP', expression, scope: 'global', machineCheckable: true, evidence: { quote: expression } });
  expect(build(spec).probes.some(p => p.targetId === 'X')).toBe(true);
  expect(build(spec).gaps).toContainEqual(expect.objectContaining({ targetId: 'OP', reasonCode: 'UNSUPPORTED_TARGET' }));
  spec.invariants = [{ id: 'EVEN', kind: 'custom', expression: 'x must be even', machineCheckable: true, evidence: { quote: 'x must be even' } }];
  expect(build(spec).probes).toEqual([]);
});

it('proves a payload bound repeated as an explicit operation precondition', () => {
  const spec = fixture();
  spec.operations![0].preconditions.push('-10 <= x <= 10');
  const result = build(spec);
  expect(result.probes.filter(p => p.targetId === 'RANGE')).toHaveLength(6);
  expect(result.probes.filter(p => p.targetId === 'X')).toHaveLength(1);
  expect(result.gaps).toEqual([{ targetId: 'N', targetKind: 'constraint', reasonCode: 'MUTATION_NOT_ISOLATED' }]);
  // A distinct stronger precondition must not be ignored when probing the global bound.
  spec.operations![0].preconditions[1] = '-5 <= x <= 5';
  expect(build(spec, legal.replace('1 1 3 10', '1 1 3 5')).probes.filter(p => p.targetId === 'X')).toEqual([]);
});
