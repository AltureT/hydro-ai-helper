jest.mock('../../lib/crypto', () => ({ decrypt: jest.fn((value: string) => value) }));

import { inflateSync } from 'zlib';
import {
  buildGenerationArtifactsSystemPrompt,
  buildGenerationArtifactsUserPrompt,
  buildSandboxRepairPrompt,
  mergeSandboxBlueprintRepair,
  parseGenerationArtifacts,
  TestdataGenService,
  TESTDATA_GEN_LIMITS,
} from '../../services/testdataGenService';
import {
  materializeGeneratorPlan,
  renderGeneratorArtifact,
  type GeneratorPlanV1,
} from '../../services/testdata/generatorDsl';
import { buildProblemSpecPrompt } from '../../services/testdata/problemSpecPrompts';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';

const spec: ProblemSpecV1 = {
  schemaVersion: 1, statementHash: '1'.repeat(64), problemKind: 'traditional',
  testCaseMode: { kind: 'single' },
  inputFields: [{ id: 's', name: 's', type: 'string', encoding: 'line:1 token:1' }],
  constraints: [], invariants: [], outputPolicy: { kind: 'exact' }, subtasks: [], uncertainties: [],
};
const options = { problemKind: 'traditional' as const, caseCount: 8, languages: [] };
const solution = { problemType: 'traditional' as const, oracleCode: 'print(input())', analysis: 'Read stdin.' };
const conflict = '@@@GENERATOR_BUDGET_CONFLICT@@@\n'
  + JSON.stringify({ scope: 'input', minimumBytes: 1_200_000 });

function repeatedPlan(count: number, length: number, alphabet: string): GeneratorPlanV1 {
  return { version: 1, seed: 1, cases: Array.from({ length: count }, (_, i) => ({
    label: `case-${i + 1}`, fields: { s: { kind: 'string', length, alphabet, pattern: 'same' } },
  })) };
}

describe('generator budget regressions', () => {
  it('rejects combined DSL stdout above the sandbox limit even when each input fits', () => {
    const plan = repeatedPlan(20, 22_000, '界');
    expect(22_001 * 3).toBeLessThan(TESTDATA_GEN_LIMITS.MAX_FILE_SIZE);
    expect(() => materializeGeneratorPlan(plan, spec)).toThrow(expect.objectContaining({
      code: 'GENERATOR_OUTPUT_TOO_LARGE', artifact: 'generator',
    }));
  });

  it('keeps a large replay artifact within the existing file limit without dropping data', () => {
    const plan = repeatedPlan(6, 60_000, '0');
    const cases = materializeGeneratorPlan(plan, spec);
    const artifact = renderGeneratorArtifact(plan, cases);
    expect(Buffer.byteLength(artifact)).toBeLessThan(TESTDATA_GEN_LIMITS.MAX_FILE_SIZE);
    const encoded = /base64\.b64decode\('([A-Za-z0-9+/=]+)'\)/.exec(artifact)?.[1];
    expect(encoded).toBeDefined();
    const decoded = JSON.parse(inflateSync(Buffer.from(encoded!, 'base64')).toString('utf8'));
    expect(decoded).toEqual({ cases: cases.map(({ label, input }) => ({ label, input })) });
    expect(renderGeneratorArtifact(plan, cases)).toBe(artifact);
  });

  it.each([undefined, { spec, expectedCaseCount: 8 }])('preserves explicit model budget conflicts for review: %p', generatorDsl => {
    expect(() => parseGenerationArtifacts(conflict, 'traditional', [], { generatorDsl }))
      .toThrow(expect.objectContaining({ code: 'GENERATOR_OUTPUT_TOO_LARGE', retryPolicy: 'manual-review' }));
  });

  it.each([
    { scope: 'input', minimumBytes: 100 },
    { scope: 'input', minimumBytes: '1200000' },
    { scope: 'input', minimumBytes: 1_200_000, code: 'anything' },
    { scope: 'unknown', minimumBytes: 1_200_000 },
    { scope: ['input'], minimumBytes: 1_200_000 },
  ])('does not mistake malformed or in-budget claims for a confirmed conflict: %p', value => {
    try {
      parseGenerationArtifacts('@@@GENERATOR_BUDGET_CONFLICT@@@\n' + JSON.stringify(value), 'traditional', []);
      throw new Error('Unexpected acceptance');
    } catch (error) {
      expect(error).not.toHaveProperty('retryPolicy', 'manual-review');
    }
  });

  it('does not accept mixed artifacts alongside a budget conflict', () => {
    expect(() => parseGenerationArtifacts(conflict + '\n@@@GENERATOR@@@\nprint(1)', 'traditional', []))
      .toThrow();
  });

  it.each([
    conflict,
    conflict.replace('GENERATOR_BUDGET_CONFLICT', 'generator_budget_conflict'),
    '\u00a0' + conflict,
    conflict.replace('@@@\n', '@@@\u00a0\n'),
    conflict.replace('GENERATOR_BUDGET_CONFLICT', 'GENERATOR_BUDGET_CONFLICT:extra'),
  ])
  ('does not discard a conflict placed after generator code in a targeted repair', suffix => {
    expect(() => mergeSandboxBlueprintRepair(
      { ...solution, generatorCode: 'print(1)' },
      '@@@GENERATOR@@@\nprint(2)\n' + suffix,
      'generator',
    )).toThrow();
  });

  it('does not spend another model call repairing an explicit budget conflict', async () => {
    const client = { chat: jest.fn().mockResolvedValue({ content: conflict,
      usedModel: { endpointId: 'fixture', endpointName: 'fixture', modelName: 'fixture' },
    }) };
    const service = Object.create(TestdataGenService.prototype) as any;
    service.clientForRole = () => client;
    await expect(service.generateGenerationArtifacts(
      { options, statementMarkdown: 'Read stdin.', problemTitle: 'Fixture', existingFiles: [] },
      solution, [], {}, [],
    )).rejects.toMatchObject({ code: 'GENERATOR_OUTPUT_TOO_LARGE', retryPolicy: 'manual-review' });
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it('rejects a compressed replay that still exceeds the existing per-file limit', () => {
    const plan = repeatedPlan(10, 70_000, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    for (const item of plan.cases) (item.fields.s as any).pattern = 'random';
    const cases = materializeGeneratorPlan(plan, spec);
    expect(() => renderGeneratorArtifact(plan, cases)).toThrow(expect.objectContaining({
      code: 'GENERATOR_OUTPUT_TOO_LARGE', artifact: 'generator',
    }));
  });

  it('supplies the same executable byte checks to initial generation and targeted repair', () => {
    const initial = buildGenerationArtifactsUserPrompt({
      options, statementMarkdown: 'Read stdin.', problemTitle: 'Fixture', existingFiles: [],
    }, solution);
    const repair = buildSandboxRepairPrompt(new Error('Output Limit Exceeded'), options, 'generator');
    for (const prompt of [initial, repair]) {
      expect(prompt).toContain("len(input_text.encode('utf-8'))");
      expect(prompt).toContain("len(payload.encode('utf-8'))");
      expect(prompt).toContain('GENERATOR_BUDGET_CONFLICT');
      expect(prompt).toContain('不得截断');
    }
  });

  it('documents the exact accepted Spec encoding and full DSL field properties', () => {
    const prompt = buildProblemSpecPrompt({
      snapshot: createStatementSnapshot('Read n, followed by n integers.'),
      requestedProblemKind: 'traditional', hasCustomChecker: false,
    }).systemPrompt;
    expect(prompt).toContain('line:1 token:1');
    expect(prompt).toContain('line:2 tokens:1..n');
    expect(prompt).toContain('dependsOn');
    const dsl = buildGenerationArtifactsSystemPrompt(true, true);
    expect(dsl).toContain('"kind":"array","length":');
    expect(dsl).toContain('"value":"derived"');
    expect(dsl).toContain('GENERATOR_BUDGET_CONFLICT');
  });
});
