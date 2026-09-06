import { parseProblemSpecV1, type ProblemSpecV1 } from '../../services/testdata/problemSpec';
import { buildProblemSpecPrompt } from '../../services/testdata/problemSpecPrompts';
import { getSpecConsensusFailureTokenUsage, runProblemSpecConsensus, type SpecConsensusClient } from '../../services/testdata/specConsensus';
import { TestdataPipelineError } from '../../services/testdata/failures';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';

const snapshot = createStatementSnapshot('# Count\nRead n.\n1 <= n <= 100.\nPrint n.');
const spec: ProblemSpecV1 = {
  schemaVersion: 1, statementHash: snapshot.statementHash, problemKind: 'traditional',
  testCaseMode: { kind: 'single' },
  inputFields: [{ id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' }],
  constraints: [{ id: 'c_n', expression: '1 <= n <= 100', machineCheckable: true,
    scope: 'global', evidence: { quote: '1 <= n <= 100.' } }],
  invariants: [], outputPolicy: { kind: 'exact' }, subtasks: [], uncertainties: [],
};
const input = { snapshot, requestedProblemKind: 'traditional' as const, hasCustomChecker: false };
const result = (value: unknown, modelName = 'primary') => ({ content: JSON.stringify(value),
  usedModel: { endpointId: 'fixture', endpointName: 'Fixture', modelName },
  usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } });
const source = (chat: jest.Mock, role: SpecConsensusClient['role'] = 'specPrimary'): SpecConsensusClient => ({
  role, client: { chat } as never,
});

describe('bounded strict ProblemSpec extraction repair', () => {
  it('provides an actual schema-valid JSON example and explicit optional-field rules', () => {
    const prompt = buildProblemSpecPrompt(input).systemPrompt;
    const example = prompt.split('=== VALID JSON EXAMPLE ===\n')[1]?.split('\n=== END EXAMPLE ===')[0];
    expect(example).toBeDefined();
    expect(() => parseProblemSpecV1(example!)).not.toThrow();
    expect(prompt).toContain('非 float');
    expect(prompt).toContain('省略 tolerance');
    expect(prompt).toContain('operation-argument:l');
    expect(prompt).toContain('不是 q 个端点组成的 array');
  });

  it.each([
    [{ ...spec, outputPolicy: { kind: 'token', tolerance: 0 } }, 'spec-output-tolerance', 'outputPolicy.tolerance'],
    [{ ...spec, outputPolicy: { kind: 'integer' } }, 'spec-output-policy', 'outputPolicy.kind'],
    [{ ...spec, constraints: [{ ...spec.constraints[0], evidence: { quote: '1 <= n <= 100.', section: '' } }] },
      'spec-evidence-section', 'evidence.section'],
  ])('rejects malformed fields with fixed, non-content diagnostics', (value, failureKind, field) => {
    expect(() => parseProblemSpecV1(JSON.stringify(value))).toThrow(expect.objectContaining({
      code: 'SPEC_PARSE_FAILED', safeDetails: { failureKind, indexes: [field] },
    }));
  });

  it('re-extracts once before freezing, retains both usages, and validates the replacement normally', async () => {
    const original = { ...spec, outputPolicy: { kind: 'exact', tolerance: 0 } };
    const first = result(original);
    const second = result(spec, 'fallback');
    const chat = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const outcome = await runProblemSpecConsensus({ ...input, primary: source(chat) });
    expect(outcome.status).toBe('consensus');
    expect(outcome.results).toEqual([first, second]);
    expect(outcome.roleIdentities.specPrimary?.modelName).toBe('fallback');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0][0].content).toContain(snapshot.normalizedMarkdown);
    expect(chat.mock.calls[1][0][0].content).toContain('outputPolicy.tolerance');
    expect(original.outputPolicy.tolerance).toBe(0);
  });

  it('never sends the invalid response or the other extraction to a repair role', async () => {
    const bad = { ...spec, private_fixture: 'sk-fixture-do-not-replay' };
    const primary = jest.fn().mockResolvedValueOnce(result(bad)).mockResolvedValueOnce(result(spec));
    const critic = jest.fn().mockResolvedValueOnce(result(spec, 'critic'));
    const outcome = await runProblemSpecConsensus({ ...input, primary: source(primary), critic: source(critic, 'specCritic') });
    expect(outcome.status).toBe('consensus');
    expect(primary).toHaveBeenCalledTimes(2);
    expect(critic).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(primary.mock.calls)).not.toContain('sk-fixture-do-not-replay');
    expect(JSON.stringify(critic.mock.calls)).not.toContain('sk-fixture-do-not-replay');
    expect(outcome.results).toHaveLength(3);
  });

  it('stops after the second invalid response without accepting or deleting bad fields', async () => {
    const chat = jest.fn().mockResolvedValue(result({ ...spec, outputPolicy: { kind: 'integer' } }));
    const outcome = await runProblemSpecConsensus({ ...input, primary: source(chat) });
    expect(outcome).toMatchObject({ status: 'unresolved', failureCode: 'SPEC_PARSE_FAILED' });
    expect(outcome.resolvedSpec).toBeUndefined();
    expect(outcome.results).toHaveLength(2);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('retains both parallel roles usage when a repair exhausts the budget', async () => {
    const exhausted = new TestdataPipelineError('budget', 'PIPELINE_BUDGET_EXHAUSTED', 'pipeline', 'pipeline', 'no-retry');
    const primary = jest.fn().mockResolvedValueOnce(result({ ...spec, outputPolicy: { kind: 'integer' } }))
      .mockRejectedValueOnce(exhausted);
    const critic = jest.fn().mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return result(spec, 'critic');
    });
    await expect(runProblemSpecConsensus({ ...input, primary: source(primary), critic: source(critic, 'specCritic') }))
      .rejects.toBe(exhausted);
    expect(getSpecConsensusFailureTokenUsage(exhausted)).toEqual({ promptTokens: 20, completionTokens: 20, totalTokens: 40 });
    expect(JSON.stringify(exhausted)).not.toContain(snapshot.normalizedMarkdown);
    expect(exhausted).not.toHaveProperty('chatResults');
  });

  it('does not spend a format retry on unsupported evidence or endpoint failure', async () => {
    const invalidEvidence = { ...spec, constraints: [{ ...spec.constraints[0], evidence: { quote: 'not in this statement' } }] };
    const chat = jest.fn().mockResolvedValue(result(invalidEvidence));
    expect(await runProblemSpecConsensus({ ...input, primary: source(chat) })).toMatchObject({ failureCode: 'SPEC_EVIDENCE_NOT_FOUND' });
    expect(chat).toHaveBeenCalledTimes(1);
    const failed = jest.fn().mockRejectedValue(new Error('endpoint timeout'));
    await runProblemSpecConsensus({ ...input, primary: source(failed) });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('preserves shared model budget exhaustion during the bounded repair', async () => {
    const exhausted = new TestdataPipelineError('budget', 'PIPELINE_BUDGET_EXHAUSTED', 'pipeline', 'pipeline', 'no-retry', { callCount: 12 });
    const chat = jest.fn().mockResolvedValueOnce(result({ ...spec, outputPolicy: { kind: 'exact', tolerance: 0 } }))
      .mockRejectedValueOnce(exhausted);
    await expect(runProblemSpecConsensus({ ...input, primary: source(chat) })).rejects.toBe(exhausted);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(getSpecConsensusFailureTokenUsage(exhausted)?.totalTokens).toBe(20);
  });

  it('does not start a format repair after cancellation', async () => {
    const controller = new AbortController();
    const canceled = Object.assign(new Error('canceled'), { name: 'AbortError' });
    const chat = jest.fn().mockImplementationOnce(async () => {
      controller.abort(canceled);
      return result({ ...spec, outputPolicy: { kind: 'exact', tolerance: 0 } });
    });
    await expect(runProblemSpecConsensus({ ...input, primary: source(chat), callOptions: { signal: controller.signal } }))
      .rejects.toBe(canceled);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(getSpecConsensusFailureTokenUsage(canceled)?.totalTokens).toBe(20);
  });
});
