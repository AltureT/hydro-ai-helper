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
      'problemKind', 'testCaseMode', 'inputFields', 'constraints', 'invariants',
      'outputPolicy', 'operations', 'subtasks', 'uncertainties',
    ]);
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
});

describe('dual ProblemSpec consensus and adjudication', () => {
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

  it('calls adjudicator exactly once for conflicts and accepts explicit A, B, and new resolutions', async () => {
    const primarySpec = validSpec();
    const criticSpec = validSpec(STATEMENT, {
      testCaseMode: { kind: 'counted', countField: 'n' },
      outputPolicy: { kind: 'token' },
      uncertainties: [{ code: 'u_output', description: 'output formatting ambiguous' }],
    });
    const conflicts = diffProblemSpecs(primarySpec, criticSpec);
    expect(conflicts.map(item => item.path)).toEqual(['testCaseMode', 'outputPolicy', 'uncertainties']);
    const resolvedSpec = validSpec(STATEMENT, {
      outputPolicy: { kind: 'token' },
      uncertainties: [{ code: 'u_resolved', description: 'resolved interpretation' }],
    });
    const adjudication = JSON.stringify({
      resolvedSpec,
      resolutions: [
        { path: 'testCaseMode', selected: 'A', evidenceQuote: 'The first line contains n.', reason: 'single input' },
        { path: 'outputPolicy', selected: 'B', evidenceQuote: 'Print the exact sum.', reason: 'tokenized output' },
        { path: 'uncertainties', selected: 'new', evidenceQuote: 'Print the exact sum.', reason: 'remove unsupported ambiguity' },
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
      status: 'adjudicated', conflictCount: 3, unresolvedConflictCount: 0,
      resolutions: expect.arrayContaining([
        expect.objectContaining({ selected: 'A' }),
        expect.objectContaining({ selected: 'B' }),
        expect.objectContaining({ selected: 'new' }),
      ]),
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
