import {
  assessTestdataRisk,
  getTestdataDirectFallbackEnabled,
  getTestdataReliabilityMode,
  type TestdataRiskInput,
} from '../../services/testdata/risk';

const sampleStatement = '## Input\n```input\n1\n```\n## Output\n```output\n1\n```';

function assess(overrides: Partial<TestdataRiskInput> = {}) {
  return assessTestdataRisk({
    statement: sampleStatement,
    directFallbackEnabled: false,
    reliabilityMode: 'observe',
    ...overrides,
  });
}

describe('deterministic test-data risk assessment', () => {
  afterEach(() => {
    delete process.env.AI_HELPER_TESTDATA_RELIABILITY_MODE;
    delete process.env.AI_HELPER_TESTDATA_ALLOW_DIRECT_FALLBACK;
  });

  it.each([
    ['custom checker', { hasCustomChecker: true }, 'CUSTOM_CHECKER'],
    ['multiple valid outputs', { statement: `${sampleStatement}\nAny valid answer is accepted.` }, 'MULTIPLE_VALID_OUTPUT'],
    ['floating point tolerance', { statement: `${sampleStatement}\nAbsolute or relative error is accepted.` }, 'FLOATING_POINT'],
    ['state operations', { statement: `${sampleStatement}\nProcess ADD, DEL and ROLLBACK operations.` }, 'STATEFUL_OPERATIONS'],
    ['subtasks', { statement: `${sampleStatement}\nSubtask 1: n <= 10.` }, 'SUBTASKS'],
    ['graph structure', { statement: `${sampleStatement}\nGiven a graph with vertices and edges.` }, 'GRAPH_OR_TREE'],
    ['complex nested structure', { statement: `${sampleStatement}\nThe input is a nested matrix structure.` }, 'COMPLEX_STRUCTURE'],
    ['long statement', { statement: `${sampleStatement}${'x'.repeat(16001)}` }, 'STATEMENT_TOO_LONG'],
    ['counted test cases', { statement: `${sampleStatement}\nThe first line contains T test cases.` }, 'COUNTED_TEST_CASES'],
    ['no parseable samples', { statement: 'There is no example section.' }, 'NO_PARSEABLE_SAMPLES'],
    ['spec conflict', { specConflict: true }, 'SPEC_CONFLICT'],
    ['truncated statement', { statementTruncated: true }, 'STATEMENT_TRUNCATED'],
  ] as const)('detects %s without AI or database access', (_label, input, code) => {
    expect(assess(input).reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code }),
    ]));
  });

  it('assigns documented weights and score boundaries 2/3/5/6', () => {
    expect(assess({ statement: `${sampleStatement}\nProcess ADD operations.` })).toMatchObject({ score: 2, tier: 'low' });
    expect(assess({ statement: `${sampleStatement}\nFloating point values are accepted.` })).toMatchObject({ score: 3, tier: 'medium' });
    expect(assess({ statement: `${sampleStatement}\nFloating point values are accepted.\nSubtask 1.` })).toMatchObject({ score: 5, tier: 'medium' });
    expect(assess({ statement: `${sampleStatement}\nFloating point values are accepted.\nGiven a graph.` })).toMatchObject({ score: 5, tier: 'medium' });
    expect(assess({ statement: `${sampleStatement}\nFloating point values are accepted.\nGiven a graph.\nSubtask 1.` })).toMatchObject({ score: 7, tier: 'high' });
    expect(assess({ statement: `${sampleStatement}\nProcess ADD operations.\nGiven a graph.\nSubtask 1.` })).toMatchObject({ score: 6, tier: 'high' });
  });

  it('blocks unsupported custom checkers regardless of score', () => {
    expect(assess({ unsupportedCustomChecker: true })).toMatchObject({
      tier: 'blocked',
      requiresSandbox: true,
      allowsDirectFallback: false,
    });
  });

  it('blocks a truncated statement because its semantics cannot be verified', () => {
    expect(assess({
      statementTruncated: true,
      directFallbackEnabled: true,
      confirmDirectFallback: true,
    })).toMatchObject({
      tier: 'blocked',
      requiresSandbox: true,
      allowsDirectFallback: false,
    });
  });

  it('applies direct fallback rules without exposing statement content', () => {
    const secretStatement = `${sampleStatement}\nsecret-title P1000 input output code`;
    expect(assess({ statement: secretStatement, directFallbackEnabled: false })).toMatchObject({
      tier: 'low', allowsDirectFallback: false,
    });
    expect(assess({ statement: secretStatement, directFallbackEnabled: true })).toMatchObject({
      tier: 'low', allowsDirectFallback: true,
    });
    expect(assess({
      statement: `${sampleStatement}\nFloating point values are accepted.`,
      directFallbackEnabled: true,
      confirmDirectFallback: false,
    })).toMatchObject({ tier: 'medium', allowsDirectFallback: false });
    expect(assess({
      statement: `${sampleStatement}\nFloating point values are accepted.`,
      directFallbackEnabled: true,
      confirmDirectFallback: true,
    })).toMatchObject({ tier: 'medium', allowsDirectFallback: true });
    expect(assess({
      statement: `${sampleStatement}\nFloating point values are accepted.\nGiven a graph.\nSubtask 1.`,
      directFallbackEnabled: true,
      confirmDirectFallback: true,
    })).toMatchObject({ tier: 'high', allowsDirectFallback: false });

    expect(JSON.stringify(assess({ statement: secretStatement }))).not.toContain('P1000');
    expect(JSON.stringify(assess({ statement: secretStatement }))).not.toContain('secret-title');
  });

  it('normalizes reliability mode and records observe-only wouldBlock', () => {
    process.env.AI_HELPER_TESTDATA_RELIABILITY_MODE = 'ENFORCE';
    expect(getTestdataReliabilityMode()).toBe('enforce');
    process.env.AI_HELPER_TESTDATA_RELIABILITY_MODE = 'invalid';
    expect(getTestdataReliabilityMode()).toBe('observe');
    expect(assess({ reliabilityMode: 'observe' }).wouldBlock).toBe(true);
    expect(assess({ reliabilityMode: 'enforce' }).wouldBlock).toBeUndefined();
  });

  it('reads the direct fallback switch as opt-in only', () => {
    expect(getTestdataDirectFallbackEnabled()).toBe(false);
    process.env.AI_HELPER_TESTDATA_ALLOW_DIRECT_FALLBACK = 'true';
    expect(getTestdataDirectFallbackEnabled()).toBe(true);
    process.env.AI_HELPER_TESTDATA_ALLOW_DIRECT_FALLBACK = 'TRUE';
    expect(getTestdataDirectFallbackEnabled()).toBe(true);
    process.env.AI_HELPER_TESTDATA_ALLOW_DIRECT_FALLBACK = '1';
    expect(getTestdataDirectFallbackEnabled()).toBe(false);
  });
});
