import {
  correlateAtRiskTemporal,
  correlateDifficultyError,
  correlateErrorAI,
  analyzeCorrelations,
} from '../../../services/analyzers/correlationAnalyzer';
import { TeachingFinding, StudentTemporalProfile } from '../../../models/teachingSummary';

function makeFinding(dimension: string, uids: number[], problems?: number[]): TeachingFinding {
  return {
    id: `finding_${dimension}_1`,
    dimension: dimension as any,
    severity: 'high',
    title: 'test finding',
    evidence: {
      affectedStudents: uids,
      affectedProblems: problems || [1],
      metrics: { affectedCount: uids.length },
    },
    needsDeepDive: false,
  };
}

describe('correlateAtRiskTemporal', () => {
  it('generates cross-correlation for at-risk students with temporal patterns', () => {
    const atRiskUids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const profiles: StudentTemporalProfile[] = [
      { uid: 1, pid: 1, pattern: 'burst_then_quit', features: {} as any, finalStatus: 2 },
      { uid: 2, pid: 1, pattern: 'burst_then_quit', features: {} as any, finalStatus: 2 },
      { uid: 3, pid: 1, pattern: 'burst_then_quit', features: {} as any, finalStatus: 2 },
      { uid: 4, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 5, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 6, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
      { uid: 7, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
      { uid: 8, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
      { uid: 9, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
      { uid: 10, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
    ];
    const result = correlateAtRiskTemporal(atRiskUids, profiles, 30);
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe('crossCorrelation');
    expect(result!.evidence.metrics.persistent_learner).toBe(4);
    expect(result!.evidence.metrics.burst_then_quit).toBe(3);
  });

  it('returns null when at-risk group < 5', () => {
    expect(correlateAtRiskTemporal([1, 2, 3], [], 30)).toBeNull();
  });

  it('includes count and totalStudents in metrics', () => {
    const atRiskUids = [1, 2, 3, 4, 5];
    const profiles: StudentTemporalProfile[] = [
      { uid: 1, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 2, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 3, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
      { uid: 4, pid: 1, pattern: 'burst_then_quit', features: {} as any, finalStatus: 2 },
      { uid: 5, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
    ];
    const result = correlateAtRiskTemporal(atRiskUids, profiles, 20);
    expect(result).not.toBeNull();
    expect(result!.evidence.metrics.affectedCount).toBe(5);
    expect(result!.evidence.metrics.totalStudents).toBe(20);
  });

  it('picks worst pattern per student when multiple profiles exist', () => {
    const atRiskUids = [1, 2, 3, 4, 5];
    // uid=1 has both persistent_learner and stuck_silent; stuck_silent should win
    const profiles: StudentTemporalProfile[] = [
      { uid: 1, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
      { uid: 1, pid: 2, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 2, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
      { uid: 3, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
      { uid: 4, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
      { uid: 5, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
    ];
    const result = correlateAtRiskTemporal(atRiskUids, profiles, 20);
    expect(result).not.toBeNull();
    expect(result!.evidence.metrics.stuck_silent).toBe(1);
    expect(result!.evidence.metrics.persistent_learner).toBeUndefined();
  });
});

describe('correlateDifficultyError', () => {
  it('generates correlation for low-pass-rate problem with error cluster', () => {
    const diffFinding = makeFinding('difficulty', [1, 2, 3, 4, 5, 6, 7], [42]);
    diffFinding.evidence.metrics = { passRate: 10, attempted: 20, accepted: 2 };
    const errorFindings = [makeFinding('errorCluster', [1, 2, 3, 4, 5], [42])];
    errorFindings[0].title = '题目 42：60% WA';
    const result = correlateDifficultyError(diffFinding, errorFindings, 20);
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe('crossCorrelation');
  });

  it('returns null when no error clusters match the problem', () => {
    const diffFinding = makeFinding('difficulty', [1, 2, 3, 4, 5], [42]);
    const errorFindings = [makeFinding('errorCluster', [1, 2, 3], [99])]; // different problem
    expect(correlateDifficultyError(diffFinding, errorFindings, 20)).toBeNull();
  });

  it('picks the largest cluster when multiple match', () => {
    const diffFinding = makeFinding('difficulty', [1, 2, 3, 4, 5, 6, 7, 8], [42]);
    diffFinding.evidence.metrics = { passRate: 20, attempted: 20, accepted: 4 };
    const small = makeFinding('errorCluster', [1, 2, 3], [42]);
    const large = makeFinding('errorCluster', [1, 2, 3, 4, 5, 6], [42]);
    const result = correlateDifficultyError(diffFinding, [small, large], 20);
    expect(result).not.toBeNull();
    expect(result!.evidence.metrics.clusterSize).toBe(6);
  });

  it('returns null when difficultyFinding has no affected problems', () => {
    const diffFinding = makeFinding('difficulty', [1, 2, 3, 4, 5], []);
    diffFinding.evidence.affectedProblems = [];
    const errorFindings = [makeFinding('errorCluster', [1, 2, 3, 4, 5], [42])];
    expect(correlateDifficultyError(diffFinding, errorFindings, 20)).toBeNull();
  });
});

describe('correlateErrorAI', () => {
  it('generates finding when AI users have significantly higher AC rate', () => {
    // 6 AI users: all AC, 6 non-AI users: none AC
    const errorFinding = makeFinding('commonError', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [42]);
    const aiUserUids = new Set([1, 2, 3, 4, 5, 6]);
    const recordsByPidUid = new Map<string, Array<{ status: number }>>();
    for (let uid = 1; uid <= 6; uid++) {
      recordsByPidUid.set(`42:${uid}`, [{ status: 1 }]);
    }
    for (let uid = 7; uid <= 12; uid++) {
      recordsByPidUid.set(`42:${uid}`, [{ status: 2 }]);
    }
    const result = correlateErrorAI(errorFinding, aiUserUids, recordsByPidUid, 20);
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe('crossCorrelation');
    expect(result!.evidence.metrics.aiRate).toBe(100);
    expect(result!.evidence.metrics.nonAiRate).toBe(0);
    expect(result!.evidence.metrics.diff).toBe(100);
  });

  it('returns null when difference < 5%', () => {
    const errorFinding = makeFinding('commonError', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [42]);
    const aiUserUids = new Set([1, 2, 3, 4, 5]);
    const recordsByPidUid = new Map<string, Array<{ status: number }>>();
    // Both groups: ~50% AC rate (3/5 vs 3/5 = 60% vs 60%, diff = 0)
    for (let uid = 1; uid <= 5; uid++) {
      recordsByPidUid.set(`42:${uid}`, [{ status: uid <= 3 ? 1 : 2 }]);
    }
    for (let uid = 6; uid <= 10; uid++) {
      recordsByPidUid.set(`42:${uid}`, [{ status: uid <= 8 ? 1 : 2 }]);
    }
    const result = correlateErrorAI(errorFinding, aiUserUids, recordsByPidUid, 20);
    expect(result).toBeNull();
  });

  it('returns null when either group is too small', () => {
    const errorFinding = makeFinding('commonError', [1, 2, 3, 4, 5, 6, 7], [42]);
    // Only 3 AI users — below MIN_GROUP_SIZE
    const aiUserUids = new Set([1, 2, 3]);
    const recordsByPidUid = new Map<string, Array<{ status: number }>>();
    const result = correlateErrorAI(errorFinding, aiUserUids, recordsByPidUid, 20);
    expect(result).toBeNull();
  });
});

describe('analyzeCorrelations', () => {
  it('returns empty array when no correlatable findings exist', () => {
    expect(analyzeCorrelations([], [], 30)).toEqual([]);
  });

  it('runs atRisk×temporal pair', () => {
    const atRiskFinding = makeFinding('atRisk', [1, 2, 3, 4, 5, 6, 7]);
    const profiles: StudentTemporalProfile[] = [
      { uid: 1, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 2, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 3, pid: 1, pattern: 'burst_then_quit', features: {} as any, finalStatus: 2 },
      { uid: 4, pid: 1, pattern: 'burst_then_quit', features: {} as any, finalStatus: 2 },
      { uid: 5, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
      { uid: 6, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
      { uid: 7, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
    ];
    const results = analyzeCorrelations([atRiskFinding], profiles, 20);
    expect(results).toHaveLength(1);
    expect(results[0].dimension).toBe('crossCorrelation');
  });

  it('runs difficulty×errorCluster pair', () => {
    const diffFinding = makeFinding('difficulty', [1, 2, 3, 4, 5, 6, 7], [42]);
    diffFinding.evidence.metrics = { passRate: 15, attempted: 20, accepted: 3 };
    const clusterFinding = makeFinding('errorCluster', [1, 2, 3, 4, 5], [42]);
    const results = analyzeCorrelations([diffFinding, clusterFinding], [], 20);
    expect(results).toHaveLength(1);
    expect(results[0].dimension).toBe('crossCorrelation');
  });

  it('resets counter on each call', () => {
    const atRiskFinding = makeFinding('atRisk', [1, 2, 3, 4, 5]);
    const profiles: StudentTemporalProfile[] = [
      { uid: 1, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 2, pid: 1, pattern: 'stuck_silent', features: {} as any, finalStatus: 2 },
      { uid: 3, pid: 1, pattern: 'burst_then_quit', features: {} as any, finalStatus: 2 },
      { uid: 4, pid: 1, pattern: 'disengaged', features: {} as any, finalStatus: 2 },
      { uid: 5, pid: 1, pattern: 'persistent_learner', features: {} as any, finalStatus: 2 },
    ];
    const first = analyzeCorrelations([atRiskFinding], profiles, 20);
    const second = analyzeCorrelations([atRiskFinding], profiles, 20);
    expect(first[0].id).toBe(second[0].id);
  });
});
