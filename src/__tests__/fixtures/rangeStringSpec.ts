import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';
const constraint = (id: string, expression: string): ProblemSpecV1['constraints'][number] => ({
  id, expression, machineCheckable: true, scope: 'global', evidence: { quote: expression },
});
export function rangeStringFixture(): ProblemSpecV1 {
  return {
    schemaVersion: 1, statementHash: '1'.repeat(64), problemKind: 'traditional', testCaseMode: { kind: 'single' },
    inputFields: [
      { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
      { id: 'q', name: 'q', type: 'integer', encoding: 'line:1 token:2' },
      { id: 's', name: 's', type: 'string', encoding: 'line:2 token:1', dependsOn: ['n'] },
      { id: 'ops', name: 'ops', type: 'operations', encoding: 'lines:3..q+2 operations', dependsOn: ['q'] },
    ],
    constraints: [constraint('N', '1 <= n <= 8'), constraint('Q', '1 <= q <= 8'),
      constraint('LEN', 'length(s) = n'), constraint('BINARY', "s[i] == '0' or s[i] == '1' for 1 <= i <= n"),
      constraint('RANGE', 'for every operation, 1 <= l <= r <= n')],
    operations: ['FLIP', 'QUERY'].map(name => ({ name, arguments: ['l', 'r'], preconditions: ['1 <= l <= r <= n'], effects: [] })),
    invariants: [], subtasks: [], uncertainties: [], outputPolicy: { kind: 'exact' },
  };
}
