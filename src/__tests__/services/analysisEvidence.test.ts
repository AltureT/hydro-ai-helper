import { ObjectId } from '../../utils/mongo';
import { TeachingAnalysisService } from '../../services/teachingAnalysisService';
import { analyzeErrorClusters, errorSignature } from '../../services/analyzers/errorClusterAnalyzer';
import { consolidateFindings } from '../../services/analyzers/findingConsolidator';
import { extractTemporalFeatures, classifyPattern } from '../../services/analyzers/temporalPatternAnalyzer';
import { reportContent } from '../../services/reportContent';

const students = Array.from({ length: 10 }, (_, i) => i + 1);
const contest = new ObjectId();
function record(uid: number, second: number, status: number, code = `source-${second}`) {
  return { _id: ObjectId.createFromTime(second), domainId: 'test', contest, uid, pid: 1, status, code,
    judgeAt: new Date('2026-01-01'), testCases: [{ id: 1, status }] };
}

function database(records: any[], conversations: any[] = [], messages: any[] = []) {
  const find = jest.fn((filter: any) => ({
    sort: jest.fn(() => ({ toArray: async () => records.filter(r =>
      r.domainId === filter.domainId && String(r.contest) === String(filter.contest)
      && filter.pid.$in.includes(r.pid) && filter.uid.$in.includes(r.uid)
      && (!filter._id?.$gte || String(r._id) >= String(filter._id.$gte))
      && (!filter._id?.$lt || String(r._id) < String(filter._id.$lt)),
    ).sort((a, b) => String(a._id).localeCompare(String(b._id))) })),
  }));
  return { find, collection: (name: string) => name === 'record' ? { find }
    : { find: () => ({ toArray: async () => name === 'ai_conversations' ? conversations : name === 'ai_messages' ? messages : [] }) } };
}

describe('analysis evidence provenance and current outcomes', () => {
  it('keeps historical WA samples, counts later AC, and excludes unrelated assignments/domains', async () => {
    const failed = students.map(uid => record(uid, 100 + uid, 2, `failed-${uid}`));
    const passed = students.map(uid => record(uid, 200 + uid, 1, `accepted-${uid}`));
    const db = database([...passed, ...failed,
      { ...record(1, 300, 7, 'foreign-assignment'), contest: new ObjectId() },
      { ...record(1, 301, 7, 'foreign-domain'), domainId: 'other' },
    ]);
    const result = await new TeachingAnalysisService(db as any).analyze({
      domainId: 'test', contestId: contest, pids: [1], studentUids: students,
    });
    const common = result.findings.find(f => f.dimension === 'commonError')!;
    expect(common.evidence.metrics).toMatchObject({ resolvedCount: 10, unresolvedCount: 0 });
    expect(common.evidence.samples?.code).toEqual(['failed-1', 'failed-2', 'failed-3']);
    expect(common.evidence.samples?.codeSources?.every(s => s.status === 2 && s.resolved)).toBe(true);
    expect(common.evidence.samples?.codeSources?.[0].recordId).toBe(String(failed[0]._id));
    expect(result.findings.some(f => f.dimension === 'errorCluster')).toBe(false);
    expect(db.find).toHaveBeenCalledTimes(1);
    expect(db.find.mock.calls[0][0]).toMatchObject({ domainId: 'test', contest });
    expect(result.fillInCandidates.every(c => c.code.startsWith('accepted-'))).toBe(true);
  });

  it('binds cluster samples to the latest matching failure and ignores AC or pending students', () => {
    const all = [
      ...students.map(uid => record(uid, 100 + uid, 3, `old-TLE-${uid}`)),
      ...students.map(uid => record(uid, 200 + uid, 2, `latest-WA-${uid}`)),
      record(9, 309, 1), record(10, 310, 10),
    ];
    const findings = analyzeErrorClusters(all, [1], 10);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.errorSignature).toBe('WA:tests[1]');
    expect(finding.evidence.affectedStudents).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(finding.evidence.samples?.code).toEqual(['latest-WA-1', 'latest-WA-2', 'latest-WA-3']);
    expect(finding.evidence.samples?.codeSources?.every(s => s.status === 2)).toBe(true);
  });

  it('does not cluster missing judge details or conflate signatures sharing the first five cases', () => {
    expect(analyzeErrorClusters(students.map(uid => ({ pid: 1, uid, status: 2 })), [1], 10)).toEqual([]);
    const base = { pid: 1, uid: 1, status: 2 };
    const cases = (last: number) => [1, 2, 3, 4, 5, last].map(id => ({ id, status: 2 }));
    expect(errorSignature({ ...base, testCases: cases(6) })).not.toBe(errorSignature({ ...base, testCases: cases(7) }));
  });

  it('does not attach a TLE cluster to a WA cohort even when all students overlap', () => {
    const base = { severity: 'medium' as const, needsDeepDive: true,
      evidence: { affectedStudents: students, affectedProblems: [1], metrics: {} } };
    const result = consolidateFindings([
      { ...base, id: 'wa', dimension: 'commonError', title: 'WA', errorStatus: 2 },
      { ...base, id: 'tle', dimension: 'errorCluster', title: 'TLE', errorStatus: 3, errorSignature: 'TLE:tests[1]' },
    ]);
    expect(result).toHaveLength(2);
  });

  it('uses submission time instead of rejudge time and never counts a future deadline as inactivity', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T10:00:00Z'));
    try {
      const submitted = new Date('2026-01-01T09:59:00Z');
      const features = extractTemporalFeatures([{ ...record(1, submitted.getTime() / 1000, 2),
        judgeAt: new Date('2026-02-01') }], new Date('2026-01-02'));
      expect(features.timeSinceLastSubmit).toBe(60_000);
      expect(classifyPattern(features, 2, false)).toBeNull();
    } finally { jest.useRealTimers(); }
  });

  it('does not turn system failures into repeated student errors', () => {
    const features = extractTemporalFeatures([
      ...Array.from({ length: 7 }, (_, i) => record(1, 100 + i, 8)), record(1, 108, 2),
    ]);
    expect(features.totalSubmissions).toBe(1);
    expect(classifyPattern(features, 2, false)).toBeNull();
  });

  it('does not produce an AI success-rate comparison from pending or system-error-only records', async () => {
    const records = students.map(uid => record(uid, 100 + uid, uid <= 5 ? 10 : 1));
    const conversations = students.slice(0, 5).map(uid => ({ _id: `c${uid}`, userId: uid, problemId: '1' }));
    const messages = conversations.map(c => ({ conversationId: c._id, role: 'student', timestamp: new Date() }));
    const result = await new TeachingAnalysisService(database(records, conversations, messages) as any).analyze({
      domainId: 'test', contestId: contest, pids: [1], studentUids: students,
    });
    expect(result.stats.aiUserCount).toBe(5);
    expect(result.findings.some(f => f.dimension === 'aiEffectiveness')).toBe(false);
  });

  it('does not let an AC outside a shortened deadline resolve an in-window failure', async () => {
    const records = students.flatMap(uid => [record(uid, 100 + uid, 2), record(uid, 200 + uid, 1)]);
    const result = await new TeachingAnalysisService(database(records) as any).analyze({
      domainId: 'test', contestId: contest, pids: [1], studentUids: students,
      contestStartTime: new Date(100_000), contestEndTime: new Date(200_000), dataSnapshotAt: new Date(300_000),
    });
    expect(result.findings.find(f => f.dimension === 'commonError')?.evidence.metrics)
      .toMatchObject({ resolvedCount: 0, unresolvedCount: 10 });
    expect(result.fillInCandidates).toEqual([]);
  });

  it('folds an error correlation only into its originating cohort and retains confidence', () => {
    const base = { severity: 'medium' as const, needsDeepDive: false,
      evidence: { affectedStudents: students, affectedProblems: [1], metrics: {} } };
    const findings = consolidateFindings([
      { ...base, id: 'wa', dimension: 'commonError', title: 'WA', errorStatus: 2 },
      { ...base, id: 'tle', dimension: 'commonError', title: 'TLE', errorStatus: 3 },
      { ...base, id: 'cross', dimension: 'crossCorrelation', title: 'TLE comparison', sourceFindingId: 'tle', confidence: 'low' },
    ]);
    expect(findings.find(f => f.id === 'wa')?.supplements).toBeUndefined();
    expect(findings.find(f => f.id === 'tle')?.supplements).toEqual(['TLE comparison（数据有限，仅供参考）']);
  });
});

describe('report reasoning wrappers', () => {
  it('removes provider prefixes but preserves literal think tags inside code', () => {
    const body = '### Report\n```html\n<think>literal</think>\n```';
    expect(reportContent(`<think>(thinking...)</think>${body}`)).toBe(body);
    expect(reportContent(body)).toBe(body);
  });
  it('rejects unfinished or empty output instead of saving an empty successful report', () => {
    expect(() => reportContent('<think>unfinished')).toThrow();
    expect(() => reportContent('<think>hidden</think>')).toThrow();
  });
});
