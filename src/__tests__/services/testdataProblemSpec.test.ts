import { TestdataPipelineError } from '../../services/testdata/failures';
import {
  type ProblemSpecV1,
  parseProblemSpecV1,
  summarizeProblemSpec,
  validateProblemSpecEvidence,
  validateProblemSpecV1,
} from '../../services/testdata/problemSpec';
import { buildProblemSpecPrompt } from '../../services/testdata/problemSpecPrompts';
import { createStatementSnapshot } from '../../services/testdata/statementSnapshot';

function traditionalStatement(extra = '') {
  return createStatementSnapshot([
    '# Sum',
    'Add the given integers.',
    '',
    '## Input',
    'The first line contains n.',
    '',
    '## Constraints',
    '| field | range |',
    '| --- | --- |',
    '| n | 1 <= n <= 100 |',
    extra,
  ].join('\n'));
}

function validTraditionalSpec(
  statementHash = traditionalStatement().statementHash,
): ProblemSpecV1 {
  return {
    schemaVersion: 1,
    statementHash,
    problemKind: 'traditional',
    testCaseMode: { kind: 'single' },
    inputFields: [{
      id: 'n', name: 'n', type: 'integer', encoding: 'one integer',
    }],
    constraints: [{
      id: 'c_n',
      expression: '1 <= n <= 100',
      machineCheckable: true,
      scope: 'global',
      evidence: { quote: '1 <= n <= 100', section: 'Constraints' },
    }],
    invariants: [],
    outputPolicy: { kind: 'exact', caseSensitive: true },
    subtasks: [],
    uncertainties: [],
  };
}

function parseAndValidate(
  spec: ProblemSpecV1,
  options: { hasCustomChecker?: boolean } = {},
): ProblemSpecV1 {
  const parsed = parseProblemSpecV1(JSON.stringify(spec));
  return validateProblemSpecV1(parsed, options);
}

describe('ProblemSpec v1 strict schema', () => {
  it('accepts a grounded traditional problem and summarizes only bounded counts', () => {
    const snapshot = traditionalStatement();
    const validated = validateProblemSpecEvidence(
      parseAndValidate(validTraditionalSpec(snapshot.statementHash)),
      snapshot,
    );

    expect(validated.constraints[0].evidence).toEqual({
      quote: '1 <= n <= 100',
      section: 'Constraints',
      startOffset: snapshot.normalizedMarkdown.indexOf('1 <= n <= 100'),
      endOffset: snapshot.normalizedMarkdown.indexOf('1 <= n <= 100') + '1 <= n <= 100'.length,
    });
    expect(summarizeProblemSpec(validated)).toEqual({
      statementHash: snapshot.statementHash,
      constraintCount: 1,
      invariantCount: 0,
      unresolvedUncertainties: 0,
    });
  });

  it('accepts a function problem without assuming standard fenced samples', () => {
    const snapshot = createStatementSnapshot([
      '# Function',
      'Implement `solve(nums)`.',
      'Input: nums = [1, 2, 3]',
      'Output: 6',
      'The array is non-empty.',
    ].join('\n'));
    const spec: ProblemSpecV1 = {
      ...validTraditionalSpec(snapshot.statementHash),
      problemKind: 'function',
      inputFields: [{ id: 'nums', name: 'nums', type: 'array', encoding: 'JSON-like list in statement' }],
      constraints: [],
      invariants: [{
        id: 'i_nonempty', kind: 'custom', expression: 'nums is non-empty', machineCheckable: true,
        evidence: { quote: 'The array is non-empty.' },
      }],
    };

    const validated = validateProblemSpecEvidence(parseAndValidate(spec), snapshot);
    const prompt = buildProblemSpecPrompt({ snapshot, requestedProblemKind: 'function', hasCustomChecker: false });

    expect(validated.problemKind).toBe('function');
    expect(snapshot.samples).toEqual([{ id: '1', input: 'nums = [1, 2, 3]\n', output: '6\n' }]);
    expect(prompt.userPrompt).toContain('Input: nums = [1, 2, 3]');
  });

  it('rejects a model problem kind that contradicts an explicit generation mode', () => {
    expect(() => validateProblemSpecV1(validTraditionalSpec(), {
      expectedProblemKind: 'function',
    })).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });

  it('accepts counted test cases whose countField references an integer field', () => {
    const spec = validTraditionalSpec();
    spec.inputFields = [
      { id: 't', name: 'T', type: 'integer', encoding: 'first line' },
      { id: 'n', name: 'n', type: 'integer', encoding: 'one per case', dependsOn: ['t'] },
    ];
    spec.testCaseMode = { kind: 'counted', countField: 't' };

    expect(parseAndValidate(spec).testCaseMode).toEqual({ kind: 'counted', countField: 't' });
  });

  it('requires custom-checker output policy to match the current problem config in both directions', () => {
    const custom = validTraditionalSpec();
    custom.outputPolicy = { kind: 'custom-checker' };

    expect(parseAndValidate(custom, { hasCustomChecker: true }).outputPolicy.kind)
      .toBe('custom-checker');
    expect(() => parseAndValidate(custom, { hasCustomChecker: false }))
      .toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
    expect(() => parseAndValidate(validTraditionalSpec(), { hasCustomChecker: true }))
      .toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });

  it.each([
    ['float', { kind: 'float', tolerance: 1e-6 }],
    ['multiple-valid', { kind: 'multiple-valid' }],
    ['unordered', { kind: 'unordered' }],
  ] as const)('accepts the closed %s output policy', (_label, outputPolicy) => {
    const spec = validTraditionalSpec();
    spec.outputPolicy = outputPolicy;
    expect(parseAndValidate(spec).outputPolicy).toEqual(outputPolicy);
  });

  it('accepts operations with stateful preconditions and effects', () => {
    const snapshot = createStatementSnapshot('## Operations\nDEL x is allowed only when x exists.');
    const spec = validTraditionalSpec(snapshot.statementHash);
    spec.inputFields = [{ id: 'ops', name: 'operations', type: 'operations', encoding: 'one operation per line' }];
    spec.constraints = [];
    spec.invariants = [{
      id: 'i_state',
      kind: 'stateful-precondition',
      expression: 'DEL requires x to exist',
      machineCheckable: true,
      evidence: { quote: 'DEL x is allowed only when x exists.', section: 'Operations' },
    }];
    spec.operations = [{
      name: 'DEL', arguments: ['x'], preconditions: ['x exists'], effects: ['remove x'],
    }];

    expect(validateProblemSpecEvidence(parseAndValidate(spec), snapshot).operations)
      .toEqual(spec.operations);
  });

  it('accepts global and subtask constraints with valid scopes and references', () => {
    const snapshot = createStatementSnapshot([
      '## Constraints', '1 <= n <= 100',
      '## Subtask 1', 'n <= 10',
      '## Subtask 2', 'n <= 100',
    ].join('\n'));
    const spec = validTraditionalSpec(snapshot.statementHash);
    spec.constraints = [
      { ...spec.constraints[0], evidence: { quote: '1 <= n <= 100', section: 'Constraints' } },
      {
        id: 'c_s1', expression: 'n <= 10', machineCheckable: true,
        scope: { subtaskId: 1 }, evidence: { quote: 'n <= 10', section: 'Subtask 1' },
      },
      {
        id: 'c_s2', expression: 'n <= 100', machineCheckable: true,
        scope: { subtaskId: 2 }, evidence: { quote: 'n <= 100', section: 'Subtask 2' },
      },
    ];
    spec.subtasks = [
      { id: 1, score: 40, constraintIds: ['c_n', 'c_s1'] },
      { id: 2, score: 60, constraintIds: ['c_n', 'c_s2'] },
    ];

    expect(validateProblemSpecEvidence(parseAndValidate(spec), snapshot).subtasks)
      .toEqual(spec.subtasks);
  });

  it('rejects duplicate field, constraint, invariant, or cross-category IDs', () => {
    const duplicateField = validTraditionalSpec();
    duplicateField.inputFields.push({ ...duplicateField.inputFields[0] });
    const crossCategory = validTraditionalSpec();
    crossCategory.invariants.push({
      id: 'c_n', kind: 'custom', expression: 'x', machineCheckable: false,
      evidence: { quote: '1 <= n <= 100' },
    });

    expect(() => parseAndValidate(duplicateField)).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
    expect(() => parseAndValidate(crossCategory)).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });

  it('rejects nonexistent dependsOn and subtask constraint references', () => {
    const badDependency = validTraditionalSpec();
    badDependency.inputFields[0].dependsOn = ['missing'];
    const badConstraint = validTraditionalSpec();
    badConstraint.subtasks = [{ id: 1, score: 100, constraintIds: ['missing'] }];

    expect(() => parseAndValidate(badDependency)).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
    expect(() => parseAndValidate(badConstraint)).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });

  it.each([
    ['nonpositive id', { id: 0, score: 100, constraintIds: ['c_n'] }],
    ['invalid score', { id: 1, score: 101, constraintIds: ['c_n'] }],
  ])('rejects an invalid subtask: %s', (_label, subtask) => {
    const spec = validTraditionalSpec();
    spec.subtasks = [subtask];
    expect(() => parseAndValidate(spec)).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });

  it('rejects a constraint scope that names no declared subtask', () => {
    const spec = validTraditionalSpec();
    spec.constraints[0].scope = { subtaskId: 9 };
    expect(() => parseAndValidate(spec)).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });

  it('rejects unknown output policies', () => {
    const spec = validTraditionalSpec() as unknown as Record<string, unknown>;
    spec.outputPolicy = { kind: 'approximate' };
    expect(() => parseProblemSpecV1(JSON.stringify(spec)))
      .toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });

  it('requires strict JSON without fences, prefixes, or suffixes', () => {
    const json = JSON.stringify(validTraditionalSpec());
    for (const raw of [`\`\`\`json\n${json}\n\`\`\``, `result: ${json}`, `${json}\nDone`]) {
      expect(() => parseProblemSpecV1(raw)).toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
    }
  });

  it('rejects unknown fields, nested metadata, oversized strings, and abnormal arrays', () => {
    const unknown = { ...validTraditionalSpec(), metadata: { source: 'model' } };
    const nested = validTraditionalSpec() as unknown as Record<string, any>;
    nested.inputFields[0].metadata = { arbitrary: true };
    const oversized = validTraditionalSpec();
    oversized.constraints[0].expression = 'x'.repeat(10_000);
    const abnormal = validTraditionalSpec();
    abnormal.uncertainties = Array.from({ length: 101 }, (_, index) => ({
      code: `u${index}`, description: 'unknown',
    }));

    for (const candidate of [unknown, nested, oversized, abnormal]) {
      expect(() => parseProblemSpecV1(JSON.stringify(candidate)))
        .toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
    }
  });

  it('rejects duplicate uncertainty codes', () => {
    const spec = validTraditionalSpec();
    spec.uncertainties = [
      { code: 'u_format', description: 'first ambiguity' },
      { code: 'u_format', description: 'second ambiguity' },
    ];

    expect(() => parseProblemSpecV1(JSON.stringify(spec)))
      .toThrow(expect.objectContaining({ code: 'SPEC_PARSE_FAILED' }));
  });
});

describe('ProblemSpec evidence grounding', () => {
  it('returns SPEC_EVIDENCE_NOT_FOUND when a quote is absent', () => {
    const snapshot = traditionalStatement();
    const spec = parseAndValidate(validTraditionalSpec(snapshot.statementHash));
    spec.constraints[0].evidence.quote = 'n is prime';

    expect(() => validateProblemSpecEvidence(spec, snapshot)).toThrow(expect.objectContaining({
      code: 'SPEC_EVIDENCE_NOT_FOUND',
      artifact: 'spec',
    }));
  });

  it('grounds optional uncertainty evidence and rejects missing or ambiguous text', () => {
    const uniqueSnapshot = traditionalStatement();
    const unique = validTraditionalSpec(uniqueSnapshot.statementHash);
    unique.uncertainties = [{
      code: 'u_input',
      description: 'input wording needs review',
      evidence: 'The first line contains n.',
    }];
    expect(() => validateProblemSpecEvidence(
      parseAndValidate(unique), uniqueSnapshot,
    )).not.toThrow();

    const missing = validTraditionalSpec(uniqueSnapshot.statementHash);
    missing.uncertainties = [{
      code: 'u_missing', description: 'missing quote', evidence: 'not in statement',
    }];
    expect(() => validateProblemSpecEvidence(
      parseAndValidate(missing), uniqueSnapshot,
    )).toThrow(expect.objectContaining({ code: 'SPEC_EVIDENCE_NOT_FOUND' }));

    const repeatedSnapshot = createStatementSnapshot('## A\nambiguous\n## B\nambiguous');
    const repeated = validTraditionalSpec(repeatedSnapshot.statementHash);
    repeated.constraints = [];
    repeated.uncertainties = [{
      code: 'u_repeat', description: 'repeated quote', evidence: 'ambiguous',
    }];
    expect(() => validateProblemSpecEvidence(
      parseAndValidate(repeated), repeatedSnapshot,
    )).toThrow(expect.objectContaining({ code: 'SPEC_EVIDENCE_NOT_FOUND' }));
  });

  it('rejects an ambiguous repeated quote without a section', () => {
    const snapshot = createStatementSnapshot('## A\nn <= 10\n## B\nn <= 10');
    const spec = validTraditionalSpec(snapshot.statementHash);
    spec.constraints[0].evidence = { quote: 'n <= 10' };

    expect(() => validateProblemSpecEvidence(parseAndValidate(spec), snapshot))
      .toThrow(expect.objectContaining({ code: 'SPEC_EVIDENCE_NOT_FOUND' }));
  });

  it('uses a section to locate one occurrence of a repeated quote', () => {
    const snapshot = createStatementSnapshot('## A\nn <= 10\n## B\nn <= 10');
    const spec = validTraditionalSpec(snapshot.statementHash);
    spec.constraints[0].evidence = { quote: 'n <= 10', section: 'B' };

    const validated = validateProblemSpecEvidence(parseAndValidate(spec), snapshot);

    expect(validated.constraints[0].evidence.startOffset)
      .toBe(snapshot.normalizedMarkdown.lastIndexOf('n <= 10'));
  });

  it('overwrites forged model offsets with server-computed offsets', () => {
    const snapshot = traditionalStatement();
    const spec = validTraditionalSpec(snapshot.statementHash);
    spec.constraints[0].evidence.startOffset = 0;
    spec.constraints[0].evidence.endOffset = 1;

    const validated = validateProblemSpecEvidence(parseAndValidate(spec), snapshot);

    expect(validated.constraints[0].evidence.startOffset)
      .toBe(snapshot.normalizedMarkdown.indexOf('1 <= n <= 100'));
    expect(validated.constraints[0].evidence.endOffset)
      .toBe(snapshot.normalizedMarkdown.indexOf('1 <= n <= 100') + '1 <= n <= 100'.length);
  });

  it('grounds evidence in a Markdown table at the statement tail', () => {
    const snapshot = traditionalStatement('\n| m | 1 <= m <= 999 |');
    const spec = validTraditionalSpec(snapshot.statementHash);
    spec.constraints[0].evidence = { quote: '1 <= m <= 999', section: 'Constraints' };
    spec.constraints[0].expression = '1 <= m <= 999';

    const validated = validateProblemSpecEvidence(parseAndValidate(spec), snapshot);

    expect(validated.constraints[0].evidence.endOffset).toBe(snapshot.normalizedMarkdown.length - 2);
  });

  it('rejects a statement hash that was not computed from the complete normalized statement', () => {
    const snapshot = traditionalStatement();
    const spec = parseAndValidate(validTraditionalSpec('0'.repeat(64)));

    expect(() => validateProblemSpecEvidence(spec, snapshot))
      .toThrow(expect.objectContaining({ code: 'SPEC_EVIDENCE_NOT_FOUND' }));
  });

  it('builds one strict extractor prompt from every complete snapshot chunk', () => {
    const tail = 'Final constraint: z must be even.';
    const snapshot = createStatementSnapshot(`# P\n${'x'.repeat(13_000)}\n${tail}`);

    const prompt = buildProblemSpecPrompt({
      snapshot,
      requestedProblemKind: 'auto',
      hasCustomChecker: false,
    });

    expect(prompt.systemPrompt).toContain('严格 JSON');
    expect(prompt.systemPrompt).toContain('schemaVersion');
    expect(prompt.userPrompt).toContain(snapshot.statementHash);
    expect(prompt.userPrompt).toContain(tail);
    expect(prompt.userPrompt).not.toContain('题面过长已截断');
    for (const chunk of snapshot.chunks) expect(prompt.userPrompt).toContain(chunk.content);
  });

  it('exposes only a typed evidence failure rather than the missing quote text', () => {
    const snapshot = traditionalStatement();
    const spec = parseAndValidate(validTraditionalSpec(snapshot.statementHash));
    spec.constraints[0].evidence.quote = 'private missing evidence sentence';

    try {
      validateProblemSpecEvidence(spec, snapshot);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TestdataPipelineError);
      expect((error as TestdataPipelineError).code).toBe('SPEC_EVIDENCE_NOT_FOUND');
      expect((error as TestdataPipelineError).safeDetails).toEqual({});
    }
  });
});
