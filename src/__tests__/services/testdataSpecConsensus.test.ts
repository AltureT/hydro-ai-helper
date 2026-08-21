jest.mock('../../lib/crypto', () => ({
  decrypt: jest.fn((value: string) => value),
}));

import { AIServiceError } from '../../services/openaiClient';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';
import {
  diffProblemSpecs,
  runProblemSpecConsensus,
  type SpecConsensusClient,
} from '../../services/testdata/specConsensus';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';

const STATEMENT = [
  '# Sum',
  'The first line contains n.',
  '1 <= n <= 100.',
  'Values are distinct.',
  'Print the exact sum.',
].join('\n');

function validSpec(statement = STATEMENT, overrides: Partial<ProblemSpecV1> = {}): ProblemSpecV1 {
  const snapshot = createStatementSnapshot(statement);
  return {
    schemaVersion: 1,
    statementHash: snapshot.statementHash,
    problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields: [{ id: 'n', name: 'n', type: 'integer', encoding: 'one integer' }],
    constraints: [{
      id: 'c_n', expression: '1 <= n <= 100', machineCheckable: true, scope: 'global',
      evidence: { quote: '1 <= n <= 100.' },
    }],
    invariants: [{
      id: 'i_distinct', kind: 'unique', expression: 'values are distinct', machineCheckable: true,
      evidence: { quote: 'Values are distinct.' },
    }],
    outputPolicy: { kind: 'exact', caseSensitive: true },
    operations: [{ name: 'READ', arguments: ['n'], preconditions: [], effects: ['store n'] }],
    subtasks: [],
    uncertainties: [],
    ...overrides,
  };
}

function client(
  role: SpecConsensusClient['role'],
  endpointId: string,
  modelName: string,
  ...responses: Array<string | Error>
): SpecConsensusClient & { chat: jest.Mock } {
  const chat = jest.fn();
  for (const response of responses) {
    if (response instanceof Error) chat.mockRejectedValueOnce(response);
    else chat.mockResolvedValueOnce({
      content: response,
      usedModel: { endpointId, endpointName: `${endpointId}-name`, modelName },
    });
  }
  return {
    role,
    identity: { endpointId, endpointName: `${endpointId}-name`, modelName },
    client: { chat } as never,
    chat,
  };
}

describe('deterministic ProblemSpec diff', () => {
  it('normalizes full-width text, comparison symbols, and exact integer notation', () => {
    const statement = `${STATEMENT}\n1 <= n <= 100000.`;
    const primary = validSpec(statement, {
      constraints: [{
        id: 'c_primary', expression: '１　<=　ｎ　<=　１０^５', machineCheckable: true,
        scope: 'global', evidence: { quote: '1 <= n <= 100000.' },
      }],
    });
    const critic = validSpec(statement, {
      constraints: [{
        id: 'c_critic', expression: '1 ≤ n ≤ 100000', machineCheckable: true,
        scope: 'global', evidence: { quote: '1 <= n <= 100000.' },
      }],
    });

    expect(diffProblemSpecs(primary, critic)).toEqual([]);
  });

  it('ignores model-generated field/constraint/invariant/subtask IDs when semantics match', () => {
    const primary = validSpec(STATEMENT, {
      testCaseMode: { kind: 'counted', countField: 't_a' },
      inputFields: [
        { id: 't_a', name: 'T', type: 'integer', encoding: 'first line' },
        { id: 'n_a', name: 'n', type: 'integer', encoding: 'one per case', dependsOn: ['t_a'] },
      ],
      constraints: [{
        id: 'constraint_a', expression: '1 <= n <= 100', machineCheckable: true,
        scope: { subtaskId: 1 }, evidence: { quote: '1 <= n <= 100.' },
      }],
      invariants: [{
        id: 'invariant_a', kind: 'unique', expression: 'values are distinct', machineCheckable: true,
        evidence: { quote: 'Values are distinct.' },
      }],
      subtasks: [{ id: 1, score: 100, constraintIds: ['constraint_a'] }],
    });
    const critic = validSpec(STATEMENT, {
      testCaseMode: { kind: 'counted', countField: 'cases_b' },
      inputFields: [
        { id: 'cases_b', name: 'T', type: 'integer', encoding: 'first line' },
        { id: 'value_b', name: 'n', type: 'integer', encoding: 'one per case', dependsOn: ['cases_b'] },
      ],
      constraints: [{
        id: 'different_constraint_id', expression: '1 <= n <= 100', machineCheckable: true,
        scope: { subtaskId: 9 }, evidence: { quote: '1 <= n <= 100.' },
      }],
      invariants: [{
        id: 'different_invariant_id', kind: 'unique', expression: 'values are distinct', machineCheckable: true,
        evidence: { quote: 'Values are distinct.' },
      }],
      subtasks: [{ id: 9, score: 100, constraintIds: ['different_constraint_id'] }],
    });

    expect(diffProblemSpecs(primary, critic)).toEqual([]);
  });

  it('reports real conflicts across every required semantic category', () => {
    const primary = validSpec();
    const critic = validSpec(STATEMENT, {
      problemKind: 'function',
      testCaseMode: { kind: 'counted', countField: 'n' },
      inputFields: [{ id: 'n', name: 'n', type: 'integer', encoding: 'JSON number' }],
      constraints: [{ ...validSpec().constraints[0], expression: '1 <= n <= 99' }],
      invariants: [{ ...validSpec().invariants[0], expression: 'values may repeat' }],
      outputPolicy: { kind: 'token' },
      operations: [{ name: 'READ', arguments: ['n'], preconditions: [], effects: ['discard n'] }],
      subtasks: [{ id: 1, score: 90, constraintIds: ['c_n'] }],
      uncertainties: [{ code: 'u1', description: 'output may contain spaces' }],
    });

    expect(diffProblemSpecs(primary, critic).map(conflict => conflict.path)).toEqual([
      'problemKind', 'testCaseMode', 'inputFields',
      'constraints[0]', 'invariants[0]', 'invariants[1]',
      'outputPolicy', 'operations', 'subtasks',
    ]);
  });

  it('pairs changed numeric bounds as one overlapping constraint conflict', () => {
    const statement = `${STATEMENT}\n1 <= n <= 1000.`;
    const primary = validSpec(statement, {
      constraints: [{
        ...validSpec(statement).constraints[0], expression: '1<=n<=100',
      }],
    });
    const critic = validSpec(statement, {
      constraints: [{
        id: 'c_n_critic', expression: '1 <= n <= 1000', machineCheckable: true,
        scope: 'global', evidence: { quote: '1 <= n <= 1000.' },
      }],
    });

    expect(diffProblemSpecs(primary, critic)).toEqual([{
      path: 'constraints[0]',
      kind: 'value-mismatch',
      primaryValue: expect.objectContaining({ expression: '1<=n<=100' }),
      criticValue: expect.objectContaining({ expression: '1 <= n <= 1000' }),
    }]);
  });

  it('treats field renames as equivalent when ordered structure and references match', () => {
    const primary = validSpec(STATEMENT, {
      testCaseMode: { kind: 'counted', countField: 'count_a' },
      inputFields: [
        { id: 'count_a', name: 'T', type: 'integer', encoding: 'first line' },
        { id: 'value_a', name: 'value', type: 'integer', encoding: 'one per case', dependsOn: ['count_a'] },
      ],
    });
    const critic = validSpec(STATEMENT, {
      testCaseMode: { kind: 'counted', countField: 'renamed_count' },
      inputFields: [
        { id: 'renamed_count', name: 'case count', type: 'integer', encoding: 'first line' },
        { id: 'renamed_value', name: 'item', type: 'integer', encoding: 'one per case', dependsOn: ['renamed_count'] },
      ],
    });

    expect(diffProblemSpecs(primary, critic)).toEqual([]);
  });

  it('distinguishes references to different occurrences of duplicate field names', () => {
    const primary = validSpec(STATEMENT, {
      inputFields: [
        { id: 'left_a', name: 'x', type: 'integer', encoding: 'first value' },
        { id: 'right_a', name: 'x', type: 'integer', encoding: 'second value' },
        { id: 'payload_a', name: 'payload', type: 'integer', encoding: 'payload', dependsOn: ['left_a'] },
      ],
    });
    const critic = validSpec(STATEMENT, {
      inputFields: [
        { id: 'left_b', name: 'x', type: 'integer', encoding: 'first value' },
        { id: 'right_b', name: 'x', type: 'integer', encoding: 'second value' },
        { id: 'payload_b', name: 'payload', type: 'integer', encoding: 'payload', dependsOn: ['right_b'] },
      ],
    });

    expect(diffProblemSpecs(primary, critic).map(conflict => conflict.path)).toEqual(['inputFields']);
  });

  it('distinguishes subtask references to duplicate constraint expressions with different structure', () => {
    const primary = validSpec(STATEMENT, {
      constraints: [
        { id: 'a_checked', expression: '1 <= n <= 100', machineCheckable: true, scope: 'global', evidence: { quote: '1 <= n <= 100.' } },
        { id: 'a_manual', expression: '1 <= n <= 100', machineCheckable: false, scope: 'global', evidence: { quote: '1 <= n <= 100.' } },
      ],
      subtasks: [{ id: 1, score: 100, constraintIds: ['a_checked'] }],
    });
    const critic = validSpec(STATEMENT, {
      constraints: [
        { id: 'b_checked', expression: '1 <= n <= 100', machineCheckable: true, scope: 'global', evidence: { quote: '1 <= n <= 100.' } },
        { id: 'b_manual', expression: '1 <= n <= 100', machineCheckable: false, scope: 'global', evidence: { quote: '1 <= n <= 100.' } },
      ],
      subtasks: [{ id: 9, score: 100, constraintIds: ['b_manual'] }],
    });

    expect(diffProblemSpecs(primary, critic).map(conflict => conflict.path)).toEqual(['subtasks']);
  });

  it('ignores constraint and subtask ordering when semantic references are unchanged', () => {
    const primary = validSpec(STATEMENT, {
      constraints: [
        {
          id: 'limit_a', expression: '1 <= n <= 100', machineCheckable: true,
          scope: { subtaskId: 1 }, evidence: { quote: '1 <= n <= 100.' },
        },
        {
          id: 'distinct_a', expression: 'Values are distinct', machineCheckable: false,
          scope: { subtaskId: 2 }, evidence: { quote: 'Values are distinct.' },
        },
      ],
      subtasks: [
        { id: 1, score: 40, constraintIds: ['limit_a'] },
        { id: 2, score: 60, constraintIds: ['distinct_a'] },
      ],
    });
    const critic = validSpec(STATEMENT, {
      constraints: [
        {
          id: 'distinct_b', expression: 'Values are distinct', machineCheckable: false,
          scope: { subtaskId: 20 }, evidence: { quote: 'Values are distinct.' },
        },
        {
          id: 'limit_b', expression: '1 <= n <= 100', machineCheckable: true,
          scope: { subtaskId: 10 }, evidence: { quote: '1 <= n <= 100.' },
        },
      ],
      subtasks: [
        { id: 20, score: 60, constraintIds: ['distinct_b'] },
        { id: 10, score: 40, constraintIds: ['limit_b'] },
      ],
    });

    expect(diffProblemSpecs(primary, critic)).toEqual([]);
  });

  it('reports only the unpaired invariant item instead of the whole bucket', () => {
    const primary = validSpec();
    const critic = validSpec(STATEMENT, { invariants: [] });

    expect(diffProblemSpecs(primary, critic)).toEqual([
      expect.objectContaining({ path: 'invariants[0]' }),
    ]);
  });
});

describe('dual ProblemSpec consensus and adjudication', () => {
  it('reaches consensus without adjudication for equivalent numeric constraint notation', async () => {
    const statement = `${STATEMENT}\n1 <= n <= 100000.`;
    const primarySpec = validSpec(statement, {
      constraints: [{
        id: 'c_primary', expression: '1 <= n <= 10^5', machineCheckable: true,
        scope: 'global', evidence: { quote: '1 <= n <= 100000.' },
      }],
    });
    const criticSpec = validSpec(statement, {
      constraints: [{
        id: 'c_critic', expression: '1 ≤ n ≤ 100000', machineCheckable: true,
        scope: 'global', evidence: { quote: '1 <= n <= 100000.' },
      }],
    });
    const adjudicator = client('adjudicator', 'ep-c', 'judge', '{}');

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(statement),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator,
    });

    expect(result).toMatchObject({
      status: 'consensus', conflictCount: 0, unresolvedConflictCount: 0,
    });
    expect(adjudicator.chat).not.toHaveBeenCalled();
  });

  it('unions Primary and Critic uncertainties without treating them as conflicts', async () => {
    const primarySpec = validSpec(STATEMENT, {
      uncertainties: [{ code: 'u_primary', description: 'primary uncertainty' }],
    });
    const criticSpec = validSpec(STATEMENT, {
      uncertainties: [{ code: 'u_critic', description: 'critic uncertainty' }],
    });
    const adjudicator = client('adjudicator', 'ep-c', 'judge', '{}');

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator,
    });

    expect(result).toMatchObject({ status: 'consensus', conflictCount: 0 });
    expect(result.resolvedSpec?.uncertainties).toEqual([
      primarySpec.uncertainties[0], criticSpec.uncertainties[0],
    ]);
    expect(adjudicator.chat).not.toHaveBeenCalled();
  });

  it('keeps the Primary uncertainty when Critic reuses its code with a different description', async () => {
    const primarySpec = validSpec(STATEMENT, {
      uncertainties: [{ code: 'u1', description: 'Primary interpretation' }],
    });
    const criticSpec = validSpec(STATEMENT, {
      uncertainties: [{ code: 'u1', description: 'Critic interpretation' }],
    });

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
    });

    expect(result).toMatchObject({ status: 'consensus', conflictCount: 0 });
    expect(result.resolvedSpec?.uncertainties).toEqual(primarySpec.uncertainties);
  });

  it('caps combined Primary and Critic uncertainties at the ProblemSpec limit', async () => {
    const uncertainties = (prefix: string, count: number) => Array.from(
      { length: count },
      (_, index) => ({ code: `${prefix}_${index}`, description: `${prefix} uncertainty ${index}` }),
    );
    const primarySpec = validSpec(STATEMENT, { uncertainties: uncertainties('primary', 60) });
    const criticSpec = validSpec(STATEMENT, { uncertainties: uncertainties('critic', 60) });

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
    });

    expect(result).toMatchObject({ status: 'consensus', conflictCount: 0 });
    expect(result.resolvedSpec?.uncertainties).toHaveLength(100);
    expect(result.resolvedSpec?.uncertainties.slice(0, 60)).toEqual(primarySpec.uncertainties);
  });

  it('adjudicates exactly one genuinely missing constraint item', async () => {
    const statement = `${STATEMENT}\nn is even.`;
    const shared = validSpec(statement).constraints[0];
    const missing = {
      id: 'c_even', expression: 'n is even', machineCheckable: true as const,
      scope: 'global' as const, evidence: { quote: 'n is even.' },
    };
    const primarySpec = validSpec(statement, { constraints: [shared, missing] });
    const criticSpec = validSpec(statement, { constraints: [shared] });
    const conflicts = diffProblemSpecs(primarySpec, criticSpec);
    expect(conflicts).toEqual([
      expect.objectContaining({
        path: 'constraints[0]',
        primaryValue: expect.objectContaining({ expression: 'n is even' }),
        criticValue: null,
      }),
    ]);
    const adjudicator = client('adjudicator', 'ep-c', 'judge', JSON.stringify({
      resolvedSpec: primarySpec,
      resolutions: [{
        path: 'constraints[0]', selected: 'A', evidenceQuote: 'n is even.', reason: 'explicit limit',
      }],
    }));

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(statement),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator,
    });

    expect(result).toMatchObject({
      status: 'adjudicated', conflictCount: 1, unresolvedConflictCount: 0,
      resolvedSpec: { outputPolicy: primarySpec.outputPolicy, invariants: primarySpec.invariants },
    });
    expect(adjudicator.chat).toHaveBeenCalledTimes(1);
    expect(adjudicator.chat.mock.calls[0][0][0].content).toContain('"path":"constraints[0]"');
  });

  it('rejects an adjudication that retains both sides of an overlapping bound conflict', async () => {
    const statement = `${STATEMENT}\n1 <= n <= 1000.`;
    const primaryConstraint = {
      id: 'c_primary', expression: '1<=n<=100', machineCheckable: true as const,
      scope: 'global' as const, evidence: { quote: '1 <= n <= 100.' },
    };
    const criticConstraint = {
      id: 'c_critic', expression: '1 <= n <= 1000', machineCheckable: true as const,
      scope: 'global' as const, evidence: { quote: '1 <= n <= 1000.' },
    };
    const primarySpec = validSpec(statement, { constraints: [primaryConstraint] });
    const criticSpec = validSpec(statement, { constraints: [criticConstraint] });
    const resolvedSpec = validSpec(statement, {
      constraints: [primaryConstraint, criticConstraint],
    });
    const adjudicator = client('adjudicator', 'ep-c', 'judge', JSON.stringify({
      resolvedSpec,
      resolutions: [{
        path: 'constraints[0]', selected: 'A', evidenceQuote: '1 <= n <= 100.',
        reason: 'retain the primary bound',
      }],
    }));

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(statement),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator,
    });

    expect(result.conflicts).toEqual([expect.objectContaining({
      path: 'constraints[0]',
      primaryValue: expect.objectContaining({ expression: '1<=n<=100' }),
      criticValue: expect.objectContaining({ expression: '1 <= n <= 1000' }),
    })]);
    expect(result).toMatchObject({
      status: 'unresolved', failureCode: 'SPEC_CONSENSUS_REQUIRED', unresolvedConflictCount: 1,
    });
  });

  it('gives Primary and Critic only the same StatementSnapshot and skips adjudicator without conflicts', async () => {
    const specJson = JSON.stringify(validSpec());
    const primary = client('specPrimary', 'ep-a', 'primary', specJson);
    const critic = client('specCritic', 'ep-b', 'critic', specJson);
    const adjudicator = client('adjudicator', 'ep-c', 'judge', '{}');

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary,
      critic,
      adjudicator,
    });

    expect(result).toMatchObject({ status: 'consensus', conflictCount: 0, unresolvedConflictCount: 0 });
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(critic.chat).toHaveBeenCalledTimes(1);
    expect(adjudicator.chat).not.toHaveBeenCalled();
    expect(primary.chat.mock.calls[0][0]).toEqual(critic.chat.mock.calls[0][0]);
    expect(JSON.stringify(critic.chat.mock.calls[0])).not.toContain('primary');
  });

  it('calls adjudicator exactly once for conflicts and accepts explicit A and B resolutions', async () => {
    const primarySpec = validSpec();
    const criticSpec = validSpec(STATEMENT, {
      testCaseMode: { kind: 'counted', countField: 'n' },
      outputPolicy: { kind: 'token' },
      uncertainties: [{ code: 'u_output', description: 'output formatting ambiguous' }],
    });
    const conflicts = diffProblemSpecs(primarySpec, criticSpec);
    expect(conflicts.map(item => item.path)).toEqual(['testCaseMode', 'outputPolicy']);
    const resolvedSpec = validSpec(STATEMENT, {
      outputPolicy: { kind: 'token' },
      uncertainties: [{ code: 'u_resolved', description: 'resolved interpretation' }],
    });
    const adjudication = JSON.stringify({
      resolvedSpec,
      resolutions: [
        { path: 'testCaseMode', selected: 'A', evidenceQuote: 'The first line contains n.', reason: 'single input' },
        { path: 'outputPolicy', selected: 'B', evidenceQuote: 'Print the exact sum.', reason: 'tokenized output' },
      ],
    });
    const adjudicator = client('adjudicator', 'ep-c', 'judge', adjudication);

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator,
    });

    expect(result).toMatchObject({
      status: 'adjudicated', conflictCount: 2, unresolvedConflictCount: 0,
      resolutions: expect.arrayContaining([
        expect.objectContaining({ selected: 'A' }),
        expect.objectContaining({ selected: 'B' }),
      ]),
      resolvedSpec: { uncertainties: criticSpec.uncertainties },
    });
    expect(adjudicator.chat).toHaveBeenCalledTimes(1);
    expect(adjudicator.chat.mock.calls[0][0][0].content).toContain(STATEMENT);
  });

  it('rejects adjudication evidence that is absent from the complete statement', async () => {
    const criticSpec = validSpec(STATEMENT, { outputPolicy: { kind: 'token' } });
    const adjudication = JSON.stringify({
      resolvedSpec: validSpec(),
      resolutions: [{
        path: 'outputPolicy', selected: 'A', evidenceQuote: 'PRIVATE MISSING QUOTE', reason: 'private reason',
      }],
    });

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(validSpec())),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator: client('adjudicator', 'ep-c', 'judge', adjudication),
    });

    expect(result).toMatchObject({
      status: 'unresolved', failureCode: 'SPEC_EVIDENCE_NOT_FOUND', unresolvedConflictCount: 1,
    });
    expect(JSON.stringify(result.safeSummary || {})).not.toContain('PRIVATE MISSING QUOTE');
    expect(JSON.stringify(result.safeSummary || {})).not.toContain('private reason');
  });

  it.each([
    ['blank evidence', STATEMENT, ' '],
    ['non-unique evidence', `${STATEMENT}\nRepeated evidence.\nRepeated evidence.`, 'Repeated evidence.'],
  ])('rejects %s using the same unique statement grounding rule', async (_label, statement, evidenceQuote) => {
    const base = validSpec(statement, { constraints: [], invariants: [] });
    const critic = validSpec(statement, {
      constraints: [], invariants: [], outputPolicy: { kind: 'token' },
    });
    const adjudication = JSON.stringify({
      resolvedSpec: base,
      resolutions: [{ path: 'outputPolicy', selected: 'A', evidenceQuote, reason: 'grounding' }],
    });

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(statement),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(base)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(critic)),
      adjudicator: client('adjudicator', 'ep-c', 'judge', adjudication),
    });

    expect(result).toMatchObject({
      status: 'unresolved', failureCode: 'SPEC_EVIDENCE_NOT_FOUND', unresolvedConflictCount: 1,
    });
  });

  it('rejects selected new when the resolved value is actually A or B', async () => {
    const criticSpec = validSpec(STATEMENT, { outputPolicy: { kind: 'token' } });
    const adjudication = JSON.stringify({
      resolvedSpec: validSpec(),
      resolutions: [{
        path: 'outputPolicy', selected: 'new', evidenceQuote: 'Print the exact sum.', reason: 'not new',
      }],
    });

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(validSpec())),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator: client('adjudicator', 'ep-c', 'judge', adjudication),
    });

    expect(result).toMatchObject({
      status: 'unresolved', failureCode: 'SPEC_CONSENSUS_REQUIRED', unresolvedConflictCount: 1,
    });
  });

  it('rejects an adjudicator that changes a path Primary and Critic already agreed on', async () => {
    const primarySpec = validSpec();
    const criticSpec = validSpec(STATEMENT, { outputPolicy: { kind: 'token' } });
    const adjudication = JSON.stringify({
      resolvedSpec: validSpec(STATEMENT, {
        constraints: [],
        outputPolicy: { kind: 'token' },
      }),
      resolutions: [{
        path: 'outputPolicy', selected: 'B', evidenceQuote: 'Print the exact sum.', reason: 'token output',
      }],
    });

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(primarySpec)),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator: client('adjudicator', 'ep-c', 'judge', adjudication),
    });

    expect(result).toMatchObject({
      status: 'unresolved', failureCode: 'SPEC_CONSENSUS_REQUIRED', unresolvedConflictCount: 1,
    });
  });

  it('rejects resolutions that do not cover every deterministic conflict', async () => {
    const criticSpec = validSpec(STATEMENT, {
      testCaseMode: { kind: 'counted', countField: 'n' }, outputPolicy: { kind: 'token' },
    });
    const adjudication = JSON.stringify({
      resolvedSpec: validSpec(),
      resolutions: [{
        path: 'outputPolicy', selected: 'A', evidenceQuote: 'Print the exact sum.', reason: 'exact',
      }],
    });

    const result = await runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(validSpec())),
      critic: client('specCritic', 'ep-b', 'critic', JSON.stringify(criticSpec)),
      adjudicator: client('adjudicator', 'ep-c', 'judge', adjudication),
    });

    expect(result).toMatchObject({
      status: 'unresolved', failureCode: 'SPEC_CONSENSUS_REQUIRED', unresolvedConflictCount: 2,
    });
  });

  it('propagates cancellation unchanged instead of converting it to SPEC_PARSE_FAILED', async () => {
    const canceled = new AIServiceError('cancel', 'aborted');
    const promise = runProblemSpecConsensus({
      snapshot: createStatementSnapshot(STATEMENT),
      requestedProblemKind: 'traditional',
      hasCustomChecker: false,
      primary: client('specPrimary', 'ep-a', 'primary', JSON.stringify(validSpec())),
      critic: client('specCritic', 'ep-b', 'critic', canceled),
    });

    await expect(promise).rejects.toBe(canceled);
  });
});
