import { SubmissionSampler, RawSubmission, SampledSubmission, SampleResult } from '../../services/submissionSampler';

// Use plain string IDs as ObjectIdType stand-ins for tests
type FakeId = any;

function makeId(n: number): FakeId {
  return `id_${n}` as any;
}

function makeSubmission(overrides: Partial<RawSubmission> & { n?: number }): RawSubmission {
  const n = overrides.n ?? 0;
  return {
    recordId: makeId(n),
    code: overrides.code ?? `code_${n}`,
    status: overrides.status ?? 'WA',
    score: overrides.score ?? 0,
    lang: overrides.lang ?? 'cpp',
    timestamp: overrides.timestamp ?? new Date(1000000 + n * 60000),
    runtime: overrides.runtime ?? 100,
    memory: overrides.memory ?? 1024,
  };
}

describe('SubmissionSampler', () => {
  let sampler: SubmissionSampler;

  beforeEach(() => {
    sampler = new SubmissionSampler();
  });

  // ─── normalizeCode ───────────────────────────────────────────────────────────

  describe('normalizeCode', () => {
    it('strips C++ single-line comments', () => {
      const code = 'int a = 1; // this is a comment\nint b = 2;';
      const result = sampler.normalizeCode(code, 'cpp');
      expect(result).not.toContain('// this is a comment');
      expect(result).toContain('int a = 1');
      expect(result).toContain('int b = 2');
    });

    it('strips C++ multi-line comments', () => {
      const code = 'int a = 1; /* block\n comment */ int b = 2;';
      const result = sampler.normalizeCode(code, 'cpp');
      expect(result).not.toContain('block');
      expect(result).toContain('int a = 1');
      expect(result).toContain('int b = 2');
    });

    it('strips Java single-line and multi-line comments', () => {
      const code = '// java comment\nint x = 0; /* block */ int y = 1;';
      const result = sampler.normalizeCode(code, 'java');
      expect(result).not.toContain('java comment');
      expect(result).not.toContain('block');
      expect(result).toContain('int x = 0');
    });

    it('strips Python single-line comments', () => {
      const code = 'x = 1  # comment here\ny = 2';
      const result = sampler.normalizeCode(code, 'py');
      expect(result).not.toContain('# comment here');
      expect(result).toContain('x = 1');
      expect(result).toContain('y = 2');
    });

    it('collapses whitespace', () => {
      const code = 'int   a  =  1;\n\n\n  int b = 2;';
      const result = sampler.normalizeCode(code, 'cpp');
      // Multiple spaces/newlines should be collapsed to single space
      expect(result).not.toMatch(/\s{2,}/);
    });

    it('handles empty code', () => {
      expect(sampler.normalizeCode('', 'cpp')).toBe('');
    });
  });

  // ─── hashDedup ───────────────────────────────────────────────────────────────

  describe('hashDedup', () => {
    it('merges adjacent identical submissions (keep later one)', () => {
      const subs: RawSubmission[] = [
        makeSubmission({ n: 1, code: 'int main(){}', status: 'WA' }),
        makeSubmission({ n: 2, code: 'int main(){}', status: 'AC' }),
      ];
      const result = sampler.hashDedup(subs, 'cpp');
      expect(result).toHaveLength(1);
      // Keep the later one
      expect(result[0].recordId).toEqual(makeId(2));
      expect(result[0].status).toBe('AC');
    });

    it('keeps non-adjacent identical submissions (revert scenario)', () => {
      const subs: RawSubmission[] = [
        makeSubmission({ n: 1, code: 'int main(){}' }),
        makeSubmission({ n: 2, code: 'int x = 1;' }),
        makeSubmission({ n: 3, code: 'int main(){}' }),
      ];
      const result = sampler.hashDedup(subs, 'cpp');
      expect(result).toHaveLength(3);
    });

    it('handles empty array', () => {
      expect(sampler.hashDedup([], 'cpp')).toEqual([]);
    });

    it('handles single submission', () => {
      const subs = [makeSubmission({ n: 1 })];
      expect(sampler.hashDedup(subs, 'cpp')).toHaveLength(1);
    });

    it('merges a run of three adjacent identical submissions, keeping last', () => {
      const subs: RawSubmission[] = [
        makeSubmission({ n: 1, code: 'same code', status: 'CE' }),
        makeSubmission({ n: 2, code: 'same code', status: 'CE' }),
        makeSubmission({ n: 3, code: 'same code', status: 'WA' }),
      ];
      const result = sampler.hashDedup(subs, 'cpp');
      expect(result).toHaveLength(1);
      expect(result[0].recordId).toEqual(makeId(3));
    });

    it('uses normalization for comparison but returns original code', () => {
      // Same semantic code with different comments → should dedup
      const sub1 = makeSubmission({ n: 1, code: 'int main(){} // comment A' });
      const sub2 = makeSubmission({ n: 2, code: 'int main(){} // comment B' });
      const result = sampler.hashDedup([sub1, sub2], 'cpp');
      expect(result).toHaveLength(1);
      // Original code (with comments) is preserved
      expect(result[0].code).toBe('int main(){} // comment B');
    });
  });

  // ─── markMilestones ──────────────────────────────────────────────────────────

  describe('markMilestones', () => {
    it('marks first and final', () => {
      const subs = [
        makeSubmission({ n: 1 }),
        makeSubmission({ n: 2 }),
        makeSubmission({ n: 3 }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[0].milestones).toContain('first');
      expect(result[2].milestones).toContain('final');
    });

    it('marks first_ac on the first AC submission', () => {
      const subs = [
        makeSubmission({ n: 1, status: 'WA' }),
        makeSubmission({ n: 2, status: 'AC' }),
        makeSubmission({ n: 3, status: 'AC' }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('first_ac');
      expect(result[2].milestones).not.toContain('first_ac');
    });

    it('marks status_change when status type changes', () => {
      const subs = [
        makeSubmission({ n: 1, status: 'WA' }),
        makeSubmission({ n: 2, status: 'TLE' }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('status_change');
    });

    it('does not mark status_change when status is the same', () => {
      const subs = [
        makeSubmission({ n: 1, status: 'WA' }),
        makeSubmission({ n: 2, status: 'WA' }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).not.toContain('status_change');
    });

    it('marks time_gap when gap > 10 minutes', () => {
      const base = new Date(1000000);
      const later = new Date(1000000 + 11 * 60 * 1000); // 11 min later
      const subs = [
        makeSubmission({ n: 1, timestamp: base }),
        makeSubmission({ n: 2, timestamp: later }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('time_gap');
    });

    it('does not mark time_gap when gap <= 10 minutes', () => {
      const base = new Date(1000000);
      const close = new Date(1000000 + 5 * 60 * 1000); // 5 min later
      const subs = [
        makeSubmission({ n: 1, timestamp: base }),
        makeSubmission({ n: 2, timestamp: close }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).not.toContain('time_gap');
    });

    it('marks lang_change when language switches', () => {
      const subs = [
        makeSubmission({ n: 1, lang: 'cpp' }),
        makeSubmission({ n: 2, lang: 'py' }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('lang_change');
    });

    it('marks score_up when passed test case count increases', () => {
      const subs = [
        makeSubmission({ n: 1, score: 20 }),
        makeSubmission({ n: 2, score: 60 }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('score_up');
    });

    it('does not mark score_up when score decreases', () => {
      const subs = [
        makeSubmission({ n: 1, score: 60 }),
        makeSubmission({ n: 2, score: 20 }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).not.toContain('score_up');
    });

    it('marks single submission as both first and final', () => {
      const subs = [makeSubmission({ n: 1 })];
      const result = sampler.markMilestones(subs);
      expect(result[0].milestones).toContain('first');
      expect(result[0].milestones).toContain('final');
    });
  });

  // ─── sample (full pipeline) ──────────────────────────────────────────────────

  describe('sample', () => {
    it('returns empty result for 0 submissions', () => {
      const result = sampler.sample([], 'cpp');
      expect(result.sampledSubmissions).toHaveLength(0);
      expect(result.submissionCount).toBe(0);
      expect(result.allStatuses).toHaveLength(0);
    });

    it('returns single submission directly, marked as first+final', () => {
      const subs = [makeSubmission({ n: 1, status: 'WA' })];
      const result = sampler.sample(subs, 'cpp');
      expect(result.sampledSubmissions).toHaveLength(1);
      expect(result.submissionCount).toBe(1);
      const s = result.sampledSubmissions[0];
      expect(s.milestone).toBe('first+final');
    });

    it('caps at MAX_SAMPLES (5) submissions', () => {
      const subs = Array.from({ length: 20 }, (_, i) =>
        makeSubmission({ n: i + 1, code: `code_version_${i}` })
      );
      const result = sampler.sample(subs, 'cpp');
      expect(result.sampledSubmissions.length).toBeLessThanOrEqual(5);
    });

    it('always includes first and final when more than 1 submission', () => {
      const subs = Array.from({ length: 10 }, (_, i) =>
        makeSubmission({ n: i + 1, code: `code_version_${i}` })
      );
      const result = sampler.sample(subs, 'cpp');
      const milestones = result.sampledSubmissions.map((s) => s.milestone);
      expect(milestones).toContain('final');
      expect(milestones).toContain('first');
    });

    it('merges consecutive CE submissions, keeping only the last', () => {
      const subs = [
        makeSubmission({ n: 1, code: 'int a;', status: 'CE' }),
        makeSubmission({ n: 2, code: 'int a; int b;', status: 'CE' }),
        makeSubmission({ n: 3, code: 'int a; int b; int c;', status: 'CE' }),
        makeSubmission({ n: 4, code: 'int main() { return 0; }', status: 'AC' }),
      ];
      const result = sampler.sample(subs, 'cpp');
      // After CE merge, we should have sub3 (last CE) + sub4 (AC)
      // submissionCount stays 4 (original)
      expect(result.submissionCount).toBe(4);
      // The sampled result should not include sub1 or sub2 from the CE run
      const ids = result.sampledSubmissions.map((s) => s.recordId.toString());
      expect(ids).not.toContain('id_1');
      expect(ids).not.toContain('id_2');
    });

    it('truncates long code with [...truncated...] marker', () => {
      // Create a submission with code > 2000 tokens (7000 chars ~ 2000 tokens)
      const longCode = 'x'.repeat(8000);
      const subs = [makeSubmission({ n: 1, code: longCode, status: 'WA' })];
      const result = sampler.sample(subs, 'cpp');
      expect(result.sampledSubmissions[0].code).toContain('[...truncated...]');
    });

    it('includes allStatuses as ISO_timestamp:STATUS strings', () => {
      const ts = new Date('2024-01-01T00:00:00.000Z');
      const subs = [
        makeSubmission({ n: 1, status: 'WA', timestamp: ts }),
        makeSubmission({ n: 2, status: 'AC', timestamp: new Date(ts.getTime() + 60000) }),
      ];
      const result = sampler.sample(subs, 'cpp');
      expect(result.allStatuses).toHaveLength(2);
      expect(result.allStatuses[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*:WA$/);
      expect(result.allStatuses[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*:AC$/);
    });

    it('CE submissions are capped at CE_TOKEN_CAP (500 tokens)', () => {
      // 500 tokens * 3.5 chars/token = 1750 chars max for CE
      const ceCode = 'c'.repeat(3000); // ~857 tokens, should be capped
      const subs = [makeSubmission({ n: 1, code: ceCode, status: 'CE' })];
      const result = sampler.sample(subs, 'cpp');
      const outputCode = result.sampledSubmissions[0].code;
      // Either truncated or capped — result should be shorter than original
      expect(outputCode.length).toBeLessThan(3000);
    });

    it('milestone priority: final > first_ac in selection', () => {
      const subs = [
        makeSubmission({ n: 1, code: 'code_1', status: 'WA' }),
        makeSubmission({ n: 2, code: 'code_2', status: 'AC' }),
        makeSubmission({ n: 3, code: 'code_3', status: 'AC' }),
      ];
      const result = sampler.sample(subs, 'cpp');
      const milestones = result.sampledSubmissions.map((s) => s.milestone);
      // first_ac should be present when budget allows
      expect(milestones).toContain('first_ac');
      expect(milestones).toContain('final');
    });
  });
});
