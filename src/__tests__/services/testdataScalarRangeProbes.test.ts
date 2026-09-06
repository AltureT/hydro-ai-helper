import { buildConstraintProbes } from '../../services/testdata/constraintProbes';
import { rangeStringFixture } from '../fixtures/rangeStringSpec';

function build(expression = '-10 <= L <= R <= 10', input = '-3 5\n', other?: string) {
  const spec = rangeStringFixture();
  spec.inputFields = ['L', 'R'].map((id, i) => ({ id, name: id, type: 'integer', encoding: `line:1 token:${i + 1}` }));
  spec.operations = [];
  spec.constraints = [{ id: 'LR', expression, scope: 'global', machineCheckable: true, evidence: { quote: expression } }];
  if (other) spec.constraints.push({ id: 'OTHER', expression: other, scope: 'global', machineCheckable: true, evidence: { quote: other } });
  return buildConstraintProbes({ spec, statementHash: spec.statementHash, specHash: '2'.repeat(64),
    seeds: [{ source: 'formal', index: 0, input }] });
}

it('tests every inequality of a combined scalar range without changing the others', () => {
  const result = build();
  expect(result.probes).toHaveLength(3);
  expect(result.gaps).toEqual([]);
  const violated = result.probes.map(probe => {
    const [l, r] = probe.input.trim().split(/\s+/).map(Number);
    return [l < -10, l > r, r > 10];
  });
  expect(violated).toEqual(expect.arrayContaining([[true, false, false], [false, true, false], [false, false, true]]));
});

it('does not claim isolation when another scalar rule is not understood', () => {
  expect(build(undefined, undefined, 'L + R = 2').probes).toEqual([]);
});

it('does not invent meaning for unknown or unsafe scalar chains', () => {
  for (const expression of ['-10 < L <= R <= 10', '-10 <= L <= L <= 10', '-9007199254740992 <= L <= R <= 10']) {
    expect(build(expression).probes).toEqual([]);
  }
  expect(build(undefined, '4 2\n').probes).toEqual([]);
});
