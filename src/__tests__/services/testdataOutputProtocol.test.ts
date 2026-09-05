jest.mock('axios');
jest.mock('../../lib/crypto', () => ({ decrypt: jest.fn((value: string) => value) }));

import axios from 'axios';
import { OpenAIClient, MultiModelClient, type ChatCallOptions } from '../../services/openaiClient';
import {
  buildSolutionBlueprintSystemPrompt,
  buildSandboxBlueprintSystemPrompt,
  buildIndependentVerifierSystemPrompt,
  buildSandboxRepairSystemPrompt,
  buildKillTargetsSystemPrompt,
  parseKillTargetsResponse,
  parseSolutionBlueprint,
  parseIndependentVerifierBlueprint,
  type GenerateOptions,
  type SandboxRepairScope,
} from '../../services/testdataGenService';
import { runProblemSpecConsensus } from '../../services/testdata/specConsensus';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const config = {
  endpointId: 'fixture-endpoint', endpointName: 'Fixture',
  apiBaseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key',
  modelName: 'fixture-model', timeoutSeconds: 30,
};
const rawOptions: ChatCallOptions = { contentMode: 'raw' };
const options: GenerateOptions = { problemKind: 'traditional', caseCount: 1, languages: [] };
const snapshot = createStatementSnapshot('Read an integer n. 1 <= n <= 10. Print n.');
const spec = {
  schemaVersion: 1, statementHash: snapshot.statementHash, problemKind: 'traditional',
  testCaseMode: { kind: 'single' },
  inputFields: [{ id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' }],
  constraints: [{ id: 'C1', expression: '1 <= n <= 10', machineCheckable: true,
    scope: 'global', evidence: { quote: '1 <= n <= 10.' } }],
  invariants: [], outputPolicy: { kind: 'exact' }, operations: [], subtasks: [], uncertainties: [],
};

function reply(content: string | null, reasoningField = 'reasoning_content') {
  mockedAxios.post.mockResolvedValueOnce({ data: {
    choices: [{ message: { content, [reasoningField]: 'Synthetic private reasoning fixture' } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  } });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('testdata raw response transport regressions', () => {
  // Reproduces the 2026-09-05 XOR Spec failure with synthetic content only.
  it.each(['reasoning_content', 'reasoning'])('keeps machine JSON exact with %s', async field => {
    const content = JSON.stringify(spec);
    reply(content, field);
    const result = await new OpenAIClient(config).chat([], 'Return JSON.', rawOptions);
    expect(result.content).toBe(content);
    expect(JSON.parse(result.content)).toEqual(spec);
    expect(JSON.stringify(result)).not.toContain('Synthetic private reasoning');
    const [, payload] = mockedAxios.post.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(payload).not.toHaveProperty('contentMode');
  });

  it('preserves the ordinary chat display indicator without exposing reasoning', async () => {
    reply('A hint.');
    const result = await new OpenAIClient(config).chat([], 'Tutor.');
    expect(result.content).toBe('<think>(thinking...)</think>A hint.');
    expect(JSON.stringify(result)).not.toContain('Synthetic private reasoning');
  });

  it.each(['', null])('rejects missing final content even when reasoning exists: %p', async content => {
    reply(content);
    await expect(new OpenAIClient(config).chat([], 'Return JSON.', rawOptions))
      .rejects.toMatchObject({ category: 'server' });
  });

  it('forwards raw mode through the real multi-model client', async () => {
    reply('@@@BRUTE@@@\nprint(input())');
    const result = await new MultiModelClient([config]).chat([], 'Repair BRUTE.', rawOptions);
    expect(result.content).toBe('@@@BRUTE@@@\nprint(input())');
    expect(result.usedModel.modelName).toBe(config.modelName);
  });

  it('returns no optional kill targets in one raw request with an explicit nonempty response', async () => {
    mockedAxios.post.mockImplementation(async (_url: string, payload: any) => ({ data: {
      choices: [{ message: {
        content: payload.messages[0].content.includes('NO_KILL_TARGETS') ? 'NO_KILL_TARGETS' : '',
        reasoning_content: 'Synthetic no-target decision',
      } }],
    } }));
    const result = await new MultiModelClient([config]).chat([], buildKillTargetsSystemPrompt(), rawOptions);
    expect(result.content).toBe('NO_KILL_TARGETS');
    expect(parseKillTargetsResponse(result.content)).toEqual([]);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('extracts grounded Spec through the real transport without caller display options', async () => {
    reply(JSON.stringify(spec));
    const result = await runProblemSpecConsensus({
      snapshot, requestedProblemKind: 'traditional', hasCustomChecker: false,
      primary: { role: 'specPrimary', client: new MultiModelClient([config]) },
    });
    expect(result.status).toBe('consensus');
    expect(result.resolvedSpec?.statementHash).toBe(snapshot.statementHash);
    expect(result.resolvedSpec?.constraints[0].id).toBe('C1');
  });

  it('keeps both extraction responses and adjudication JSON raw across distinct models', async () => {
    reply(JSON.stringify(spec));
    reply(JSON.stringify({ ...spec, outputPolicy: { kind: 'token' } }));
    reply(JSON.stringify({ resolvedSpec: spec, resolutions: [{
      path: 'outputPolicy', selected: 'A', evidenceQuote: 'Print n.', reason: 'Use the stated output.',
    }] }));
    const client = (name: string) => new MultiModelClient([{
      ...config, endpointId: name, modelName: name,
    }]);
    const result = await runProblemSpecConsensus({
      snapshot, requestedProblemKind: 'traditional', hasCustomChecker: false,
      primary: { role: 'specPrimary', client: client('primary') },
      critic: { role: 'specCritic', client: client('critic') },
      adjudicator: { role: 'adjudicator', client: client('adjudicator') },
      callOptions: { contentMode: 'display', maxTokens: null },
    });
    expect(result.status).toBe('adjudicated');
    expect(result.unresolvedConflictCount).toBe(0);
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    for (const response of result.results) expect(response.content.startsWith('{')).toBe(true);
  });

  it.each([
    () => '```json\n' + JSON.stringify(spec) + '\n```',
    () => '<think>Model-supplied wrapper</think>' + JSON.stringify(spec),
    () => JSON.stringify({ ...spec, metadata: 'unsupported' }),
    () => JSON.stringify({ ...spec, constraints: [{ ...spec.constraints[0],
      evidence: { quote: 'A constraint absent from the statement.' } }] }),
  ])('still rejects invalid model content rather than normalizing it', async content => {
    reply(content());
    const result = await runProblemSpecConsensus({
      snapshot, requestedProblemKind: 'traditional', hasCustomChecker: false,
      primary: { role: 'specPrimary', client: new MultiModelClient([config]) },
    });
    expect(result.status).toBe('unresolved');
    expect(result.resolvedSpec).toBeUndefined();
  });
});

describe('single-artifact repair system contracts', () => {
  it.each([
    ['generator', 'GENERATOR'], ['stress-generator', 'STRESS_GENERATOR'],
    ['function-samples', 'SAMPLE_INPUTS'], ['validator', 'VALIDATOR'], ['brute', 'BRUTE'],
    ['oracle', 'ORACLE'], ['template-py', 'TEMPLATE:py'], ['template-java', 'TEMPLATE:java'],
    ['template-cc', 'TEMPLATE:cc'],
  ] as Array<[SandboxRepairScope, string]>)('requests only %s while freezing the other artifacts', (scope, header) => {
    for (const frozen of [false, true]) {
      const prompt = buildSandboxRepairSystemPrompt(scope, frozen);
      expect(prompt.match(/^@@@[^\n]+@@@$/gm)).toEqual([`@@@${header}@@@`]);
      expect(prompt).toContain('历史完整回答仅作为定位错误的上下文');
      if (frozen) expect(prompt).toContain('FROZEN_PROBLEM_SPEC 是唯一机器题意契约');
    }
  });

  it('retains frozen validator argument validation and the existing manifest during repair', () => {
    const prompt = buildSandboxRepairSystemPrompt('validator', true);
    expect(prompt).toContain('--subtask <known-positive-integer>');
    expect(prompt).toContain('未知、缺少、非整数、重复或多余参数均须拒绝');
    expect(prompt).toContain('既有 Manifest 与 probe recipes 保持不变');
  });
});

describe('canonical blueprint sections with legacy read compatibility', () => {
  it.each(['@@@ORACLE_LANG@@@', '=== ORACLE_LANG ==='])
  ('preserves C++ selection with blank lines after a language marker: %s', marker => {
    const result = parseSolutionBlueprint([
      marker, '', '  ', 'cpp', '@@@META@@@', 'problemType: traditional',
      '@@@ORACLE@@@', 'int main() { return 0; }',
    ].join('\r\n'), options);
    expect(result.oracleLanguage).toBe('cpp');
  });

  it.each(['canonical', 'legacy'])('preserves C++ language and subtasks from %s metadata', style => {
    const marker = (name: string) => style === 'canonical' ? `@@@${name}@@@` : `=== ${name} ===`;
    const result = parseSolutionBlueprint([
      marker('ORACLE_LANG'), 'cpp', marker('SUBTASKS'), '1 | 100 | 1 <= n <= 10',
      '@@@META@@@', 'problemType: traditional', 'isFillIn: false',
      '@@@ANALYSIS@@@', 'Read and print n.', '@@@ORACLE@@@', 'int main() { return 0; }',
    ].join('\n'), options);
    expect(result.oracleLanguage).toBe('cpp');
    expect(result.subtasks).toEqual([{ id: 1, score: 100, constraints: '1 <= n <= 10' }]);
  });

  it.each(['@@@COMPLEXITY_GAP@@@', '=== COMPLEXITY_GAP ==='])('preserves complexity declaration: %s', marker => {
    const result = parseIndependentVerifierBlueprint([
      marker, 'none', '@@@BRUTE@@@', 'print(input())',
      '@@@STRESS_GENERATOR@@@', 'print("{}")', '@@@VALIDATOR@@@', 'raise SystemExit(0)',
    ].join('\n'));
    expect(result.complexityGap).toBe('none');
  });

  it.each([false, true])('uses one delimiter family in all blueprint prompts, frozen=%s', frozen => {
    for (const prompt of [buildSolutionBlueprintSystemPrompt(true, frozen),
      buildSandboxBlueprintSystemPrompt(true, frozen), buildIndependentVerifierSystemPrompt(60, frozen)]) {
      expect(prompt).not.toMatch(/^=== .* ===$/m);
      expect(prompt).not.toMatch(/===\s*@@@/);
    }
    expect(buildSolutionBlueprintSystemPrompt(true, frozen)).toContain('@@@ORACLE_LANG@@@');
    expect(buildSolutionBlueprintSystemPrompt(true, frozen)).toContain('@@@SUBTASKS@@@');
    expect(buildIndependentVerifierSystemPrompt(60, frozen)).toContain('@@@COMPLEXITY_GAP@@@');
  });

  it.each(['=== @@@META@@@ ===', '=== @@@META@@@', '=== META ==='])
  ('continues rejecting the malformed META header observed in live output: %s', marker => {
    expect(() => parseSolutionBlueprint([
      marker, 'problemType: traditional', '@@@ANALYSIS@@@', 'Read n.',
      '@@@ORACLE@@@', 'print(input())',
    ].join('\n'), options)).toThrow(/problemType/);
  });
});
