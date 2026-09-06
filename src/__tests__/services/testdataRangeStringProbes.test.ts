import { buildConstraintProbes } from '../../services/testdata/constraintProbes';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';
import { rangeStringFixture } from '../fixtures/rangeStringSpec';
import { specForConstraintProbes } from '../../services/testdata/probeExpressions';

const constraint = (id: string, expression: string): ProblemSpecV1['constraints'][number] => ({
  id, expression, machineCheckable: true, scope: 'global', evidence: { quote: expression },
});
const legal = '3 2\n010\nFLIP 1 3\nQUERY 2 3\n';
function build(spec = rangeStringFixture(), inputs = [legal]) {
  return buildConstraintProbes({ spec, statementHash: spec.statementHash, specHash: '2'.repeat(64),
    seeds: inputs.map((input, index) => ({ source: 'formal', input, index })) });
}
// Independent test oracle for the actual input format (does not call probe recognizers).
function violations(input: string): string[] {
  const [header, s, ...rows] = input.trimEnd().split('\n');
  const [n, q] = header.split(' ').map(Number);
  expect(rows).toHaveLength(q);
  const result = [];
  if (!(n >= 1 && n <= 8)) result.push('N');
  if (!(q >= 1 && q <= 8)) result.push('Q');
  if (s.length !== n) result.push('LEN');
  if (/[^01]/.test(s)) result.push('BINARY');
  if (rows.some(row => { const [name, l, r] = row.split(' '); expect(['FLIP', 'QUERY']).toContain(name); return !(1 <= +l && +l <= +r && +r <= n); })) result.push('RANGE');
  return result;
}

describe('range and binary string rejection proofs', () => {
  it('isolates the three missing targets and preserves count-dependent data', () => {
    const spec = rangeStringFixture();
    const before = JSON.stringify(spec);
    const result = build(spec);
    expect(result.probes).toHaveLength(11);
    for (const probe of result.probes) expect(violations(probe.input)).toEqual([probe.targetId]);
    expect(result.probes.filter(p => p.targetId === 'RANGE')).toHaveLength(6);
    expect(result.gaps).toEqual([{ targetId: 'N', targetKind: 'constraint', reasonCode: 'MUTATION_NOT_ISOLATED' }]);
    expect(JSON.stringify(spec)).toBe(before);
    expect(build(spec)).toEqual(result);
  });

  it('keeps an unisolatable scalar boundary incomplete despite a successful upper probe', () => {
    const result = build();
    expect(result.probes.filter(p => p.targetId === 'N')).toHaveLength(1);
    // The aggregate evidence layer must retain this construction gap.
    expect(result.gaps.some(gap => gap.targetId === 'N')).toBe(true);
  });

  it('reverses only the ordering inequality, and checks both operation types', () => {
    for (const probe of build().probes.filter(p => p.constructionKind === 'operation-range-reversed')) {
      const rows = probe.input.trim().split('\n').slice(2).map(row => row.split(' '));
      expect(rows.filter(([, l, r]) => +l > +r)).toHaveLength(1);
      expect(rows.every(([, l, r]) => +l >= 1 && +r <= 3)).toBe(true);
    }
  });

  it('uses a later legal seed for ordering when the first domain has one value', () => {
    const result = build(rangeStringFixture(), ['1 2\n0\nFLIP 1 1\nQUERY 1 1\n', legal]);
    expect(result.probes.filter(p => p.targetId === 'RANGE')).toHaveLength(6);
  });

  it('does not conceal invalid accepted endpoint, character, or length seeds', () => {
    for (const input of [legal.replace('FLIP 1 3', 'FLIP 0 3'), legal.replace('010', '012'), legal.replace('010', '01')]) {
      const result = build(rangeStringFixture(), [input, legal]);
      expect(result.probes).toEqual([]);
      expect(result.gaps.length).toBeGreaterThan(0);
    }
  });

  it.each(['lines:3..q+1 operations', 'lines:3..q+2 arbitrary', 'lines:9007199254740992..q+9007199254740991 operations'])('refuses ambiguous layout %s', encoding => {
    const spec = rangeStringFixture(); spec.inputFields[3].encoding = encoding;
    expect(build(spec).probes.filter(p => p.targetId === 'RANGE')).toEqual([]);
  });

  it('rejects missing dependencies, overlapping fields, unknown opcodes and truncated rows', () => {
    const spec = rangeStringFixture(); spec.inputFields[3].dependsOn = [];
    expect(build(spec).probes.filter(p => p.targetId === 'RANGE')).toEqual([]);
    const overlap = rangeStringFixture(); overlap.inputFields.push({ id: 'x', name: 'x', type: 'integer', encoding: 'line:3 token:2' });
    expect(build(overlap).probes.filter(p => p.targetId === 'RANGE')).toEqual([]);
    for (const input of [legal.replace('FLIP', 'UNKNOWN'), legal.replace('QUERY 2 3', 'QUERY 2')]) {
      expect(build(rangeStringFixture(), [input]).probes.filter(p => p.targetId === 'RANGE')).toEqual([]);
    }
  });

  it('does not silently reinterpret additional preconditions or reversed argument layouts', () => {
    const spec = rangeStringFixture(); spec.operations![0].preconditions.push('s[l] == 0');
    expect(build(spec).probes.filter(p => p.targetId === 'RANGE')).toEqual([]);
    expect(build(spec).gaps).toContainEqual(expect.objectContaining({ targetId: 'N' }));
    expect(build(spec).probes.filter(p => p.targetId === 'Q')).toEqual([]);
    const reversed = rangeStringFixture(); reversed.operations![0].arguments = ['r', 'l'];
    expect(build(reversed).probes.filter(p => p.targetId === 'RANGE')).toEqual([]);
    const collision = rangeStringFixture();
    collision.inputFields.push({ id: 'l', name: 'l', type: 'integer', encoding: 'line:1 token:3' });
    expect(build(collision, [legal.replace('3 2', '3 2 1')]).probes.filter(p => p.targetId === 'RANGE')).toEqual([]);
  });

  it('requires declared string count dependency and preserves unsupported natural language', () => {
    const spec = rangeStringFixture(); spec.inputFields[2].dependsOn = [];
    expect(build(spec).probes.filter(p => ['LEN', 'BINARY'].includes(p.targetId))).toEqual([]);
    for (const expression of ['s is a binary string', 'length(s) = n + 1', 'characters(s) in [0-9]', 'for every operation, 1 <= l <= r <= n + 1']) {
      const altered = rangeStringFixture(); altered.constraints = [constraint('UNKNOWN', expression)];
      expect(build(altered).probes).toEqual([]);
    }
  });

  it('normalizes only unique string/count aliases and retains frozen expressions', () => {
    const spec = rangeStringFixture(); spec.inputFields[2].name = 'bits';
    spec.constraints[2].expression = 'len(bits) == n'; spec.constraints[3].expression = 'characters(bits) in [01]';
    expect(specForConstraintProbes(spec).constraints.slice(2, 4).map(c => c.expression)).toEqual(['length(s) = n', 'characters(s) in [01]']);
    expect(build(spec).probes.filter(p => ['LEN', 'BINARY'].includes(p.targetId))).toHaveLength(2);
    spec.inputFields.push({ id: 'bits', name: 'other', type: 'string', encoding: 'line:4 token:1' });
    expect(specForConstraintProbes(spec).constraints[2].expression).toBe('len(bits) == n');
  });

  it('does not borrow operation types from another subtask', () => {
    const spec = rangeStringFixture(); spec.constraints[4].scope = { subtaskId: 1 };
    const result = buildConstraintProbes({ spec, statementHash: spec.statementHash, specHash: '2'.repeat(64), seeds: [
      { source: 'formal', index: 0, subtaskId: 1, input: '3 1\n010\nFLIP 1 3\n' },
      { source: 'formal', index: 1, subtaskId: 2, input: legal },
    ] });
    expect(result.probes.filter(p => p.targetId === 'RANGE')).toHaveLength(3);
    expect(result.gaps).toContainEqual(expect.objectContaining({ targetId: 'RANGE', subtaskId: 1 }));
  });

  it('builds large operation/string count boundaries and caps huge allocations before creating data', () => {
    const spec = rangeStringFixture(); spec.constraints[0].expression = 'n <= 200000'; spec.constraints[1].expression = 'q <= 200000';
    const result = build(spec);
    expect(result.probes.find(p => p.targetId === 'N')!.input.split('\n')[1]).toHaveLength(200001);
    expect(result.probes.find(p => p.targetId === 'Q')!.input.trim().split('\n')).toHaveLength(200003);
    expect(result.probes.reduce((sum, p) => sum + Buffer.byteLength(p.input), 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    spec.constraints[0].expression = 'n <= 9007199254740990'; spec.constraints[1].expression = 'q <= 9007199254740990';
    expect(build(spec).probes.filter(p => ['N', 'Q'].includes(p.targetId))).toEqual([]);
    expect(build(spec).gaps.filter(g => g.reasonCode === 'PROBE_TOO_LARGE')).toHaveLength(2);
  });

  it('does not assume a character length unit for non-ASCII strings', () => {
    const spec = rangeStringFixture(); spec.constraints = [constraint('LEN', 'length(s) = n')];
    expect(build(spec, [legal.replace('010', '你好吗')]).probes).toEqual([]);
  });

  it('mutates within the indexed character domain and preserves an unconstrained suffix', () => {
    const spec = rangeStringFixture(); spec.inputFields = spec.inputFields.slice(0, 3);
    delete spec.operations;
    spec.constraints = [constraint('BINARY', "s[i] == '0' or s[i] == '1' for 1 <= i <= n")];
    expect(build(spec, ['1 0\n00\n']).probes.map(p => p.input)).toEqual(['1 0\n#0\n']);
    expect(build(spec, ['1 0\n0X\n']).probes.map(p => p.input)).toEqual(['1 0\n#X\n']);
    expect(build(spec, ['0 0\n00\n']).probes).toEqual([]);
  });

  it('keeps an operation cardinality gap when safe reconstruction is unavailable', () => {
    const spec = rangeStringFixture(); spec.constraints = [constraint('Q', '1 <= q <= 8')];
    expect(build(spec).probes).toEqual([]);
    expect(build(spec).gaps).toContainEqual(expect.objectContaining({ targetId: 'Q', reasonCode: 'MUTATION_NOT_ISOLATED' }));
    spec.inputFields[3].dependsOn = [];
    expect(build(spec).probes).toEqual([]);
  });

  it('retains distinct operation proofs when separate seeds use the same line number', () => {
    const result = build(rangeStringFixture(), ['3 1\n010\nFLIP 1 3\n', '3 1\n010\nQUERY 1 3\n']);
    const probes = result.probes.filter(p => p.targetId === 'RANGE');
    expect(probes).toHaveLength(6);
    expect(new Set(probes.map(p => p.id)).size).toBe(6);
    expect(probes.filter(p => p.input.includes('FLIP'))).toHaveLength(3);
    expect(probes.filter(p => p.input.includes('QUERY'))).toHaveLength(3);
  });

  it('checks cumulative string expansion before allocating each dependent field', () => {
    const spec = rangeStringFixture();
    spec.inputFields = [spec.inputFields[0], ...['a', 'b', 'c'].map((id, index) => ({
      id, name: id, type: 'string' as const, encoding: `line:${index + 2} token:1`, dependsOn: ['n'],
    }))];
    spec.constraints = [constraint('N', 'n <= 2097151'), ...['a', 'b', 'c'].map(id => constraint(`L${id}`, `length(${id}) = n`))];
    delete spec.operations;
    const allocated: number[] = [];
    const repeat = String.prototype.repeat;
    const spy = jest.spyOn(String.prototype, 'repeat').mockImplementation(function (count: number) {
      if (count > 1000000) allocated.push(count);
      return repeat.call(this, count);
    });
    try {
      expect(build(spec, ['1\na\nb\nc\n']).gaps).toContainEqual(expect.objectContaining({ targetId: 'N', reasonCode: 'PROBE_TOO_LARGE' }));
      expect(allocated).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
});
