import {
  assessTestdataRisk,
  getTestdataDirectFallbackEnabled,
  getTestdataReliabilityMode,
  type TestdataRiskInput,
} from '../../services/testdata/risk';
import { extractStatementSamples } from '../../services/testdataGenService';

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
    ['graph structure', { statement: `${sampleStatement}\nGiven a graph with vertices and edges.` }, 'STRUCTURE'],
    ['complex nested structure', { statement: `${sampleStatement}\nThe input is a nested matrix structure.` }, 'STRUCTURE'],
    ['long statement', { statement: `${sampleStatement}${'x'.repeat(16001)}` }, 'STATEMENT_TOO_LONG'],
    ['counted test cases', { statement: `${sampleStatement}\nThe first line contains T test cases.` }, 'COUNTED_TEST_CASES'],
    ['no parseable samples', { statement: 'There is no example section.' }, 'NO_PARSEABLE_SAMPLES'],
    ['spec conflict', { specConflict: true }, 'SPEC_CONFLICT'],
    ['truncated statement', { statementTruncated: true }, 'STATEMENT_TRUNCATED'],
    ['multiple guarantees or conventions', { statement: `${sampleStatement}\n保证输入合法。约定下标从 1 开始。` }, 'MULTIPLE_GUARANTEES_OR_CONVENTIONS'],
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

  it.each([
    ['Hydro numbered fences without headings', '```input1\n1\n```\n```output1\n1\n```'],
    ['Hydro unnumbered fences without headings', '```input\n1\n```\n```output\n1\n```'],
    ['Chinese inline pair', '输入：x = 1\n输出：1'],
    ['English inline pair', 'Input: x = 1\nOutput: 1'],
  ])('shares production sample recognition for %s', (_label, sampleSyntax) => {
    const statement = `${sampleSyntax}\nProcess ADD operations.`;
    expect(extractStatementSamples(statement)).not.toHaveLength(0);
    expect(assess({ statement })).toMatchObject({ score: 2, tier: 'low' });
  });

  it('treats headed untyped fences as no sample because production does not parse them', () => {
    const statement = '## Input\n```\n1\n```\n## Output\n```\n1\n```\nProcess ADD operations.';
    expect(extractStatementSamples(statement)).toHaveLength(0);
    expect(assess({ statement })).toMatchObject({ score: 3, tier: 'medium' });
  });

  it('counts graph, tree, and complex structure as one +2 category', () => {
    const assessment = assess({
      statement: `${sampleStatement}\nGiven a graph with an adjacency matrix and nested structure.`,
    });
    expect(assessment).toMatchObject({ score: 2, tier: 'low' });
    expect(assessment.reasons.filter(reason => reason.code === 'STRUCTURE')).toHaveLength(1);
  });

  it('does not classify 边界 as a graph or tree signal', () => {
    const assessment = assess({ statement: `${sampleStatement}\n请注意数组边界条件。` });
    expect(assessment.reasons.map(reason => reason.code)).not.toContain('STRUCTURE');
    expect(assessment.score).toBe(0);
  });

  it('weights multiple guarantees or conventions at +1 without statement leakage', () => {
    const statement = `${sampleStatement}\n保证所有输入合法；约定结果非负。`;
    const assessment = assess({ statement });
    expect(assessment).toMatchObject({ score: 1, tier: 'low' });
    expect(assessment.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MULTIPLE_GUARANTEES_OR_CONVENTIONS',
        weight: 1,
        messageKey: 'ai_helper_testdata_risk_multiple_guarantees_or_conventions',
      }),
    ]));
    expect(JSON.stringify(assessment)).not.toContain('结果非负');
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

  it.each(['legacy', 'observe', 'enforce'] as const)(
    '%s derives sandbox requirements from the currently safe direct path',
    reliabilityMode => {
      const lowDisabled = assess({ reliabilityMode, directFallbackEnabled: false });
      const lowEnabled = assess({ reliabilityMode, directFallbackEnabled: true });
      const mediumUnconfirmed = assess({
        reliabilityMode,
        statement: `${sampleStatement}\nFloating point output has absolute error.`,
        directFallbackEnabled: true,
        confirmDirectFallback: false,
      });
      const mediumConfirmed = assess({
        reliabilityMode,
        statement: `${sampleStatement}\nFloating point output has absolute error.`,
        directFallbackEnabled: true,
        confirmDirectFallback: true,
      });
      const highConfirmed = assess({
        reliabilityMode,
        statement: `${sampleStatement}\nFloating point output. Given a graph. Subtask 1.`,
        directFallbackEnabled: true,
        confirmDirectFallback: true,
      });

      expect(lowDisabled).toMatchObject({ tier: 'low', allowsDirectFallback: false, requiresSandbox: true });
      expect(lowEnabled).toMatchObject({ tier: 'low', allowsDirectFallback: true, requiresSandbox: false });
      expect(mediumUnconfirmed).toMatchObject({ tier: 'medium', allowsDirectFallback: false, requiresSandbox: true });
      expect(mediumConfirmed).toMatchObject({ tier: 'medium', allowsDirectFallback: true, requiresSandbox: false });
      expect(highConfirmed).toMatchObject({ tier: 'high', allowsDirectFallback: false, requiresSandbox: true });
      expect(lowDisabled.wouldBlock).toBe(reliabilityMode === 'observe' ? true : undefined);
      expect(mediumConfirmed.wouldBlock).toBe(reliabilityMode === 'observe' ? false : undefined);
    },
  );

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
