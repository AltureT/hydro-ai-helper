import {
  consolidateFindings,
  MAX_PRIMARY,
} from '../../../services/analyzers/findingConsolidator';
import { TeachingFinding } from '../../../models/teachingSummary';

function makeFinding(overrides: Partial<TeachingFinding> = {}): TeachingFinding {
  const students = overrides.evidence?.affectedStudents ?? [1, 2, 3, 4, 5];
  return {
    id: overrides.id ?? 'finding_test_1',
    dimension: 'commonError',
    severity: 'medium',
    title: 'test finding',
    needsDeepDive: false,
    ...overrides,
    evidence: {
      affectedStudents: students,
      affectedProblems: [101],
      metrics: { affectedCount: students.length },
      ...(overrides.evidence ?? {}),
    },
  };
}

const range = (n: number, start = 1) => Array.from({ length: n }, (_, i) => start + i);

describe('consolidateFindings — errorCluster merge', () => {
  it('merges an errorCluster into the commonError on the same problem with overlapping students', () => {
    const common = makeFinding({
      id: 'finding_commonError_1',
      dimension: 'commonError',
      title: '百鸡问题 (1138)：42% 学生遇到 WA 错误',
      needsDeepDive: true,
      evidence: {
        affectedStudents: range(42),
        affectedProblems: [1138],
        metrics: { affectedCount: 42 },
      },
    });
    const cluster = makeFinding({
      id: 'finding_errorCluster_1',
      dimension: 'errorCluster',
      title: '百鸡问题：34% 学生遇到相同错误模式 (WA)',
      errorSignature: 'WA:tests[3,4]',
      needsDeepDive: true,
      evidence: {
        affectedStudents: range(34),
        affectedProblems: [1138],
        metrics: { affectedCount: 34 },
        samples: { code: ['int main() {}'] },
      },
    });

    const result = consolidateFindings([common, cluster]);

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.dimension).toBe('commonError');
    expect(merged.errorSignature).toBe('WA:tests[3,4]');
    expect(merged.evidence.samples?.code).toEqual(['int main() {}']);
    expect(merged.evidence.metrics.sameSignatureCount).toBe(34);
    expect(merged.supplements?.length).toBe(1);
    expect(merged.supplements![0]).toContain('WA:tests[3,4]');
  });

  it('keeps an errorCluster standalone when there is no overlapping commonError on that problem', () => {
    const common = makeFinding({
      id: 'finding_commonError_1',
      dimension: 'commonError',
      evidence: {
        affectedStudents: range(10),
        affectedProblems: [200],
        metrics: {},
      },
    });
    const cluster = makeFinding({
      id: 'finding_errorCluster_1',
      dimension: 'errorCluster',
      errorSignature: 'CE:syntax',
      evidence: {
        affectedStudents: range(10, 500),
        affectedProblems: [300],
        metrics: {},
      },
    });

    const result = consolidateFindings([common, cluster]);
    expect(result).toHaveLength(2);
    expect(result.map(f => f.id)).toContain('finding_errorCluster_1');
  });

  it('prefers the commonError whose title mentions the cluster status label', () => {
    const commonWA = makeFinding({
      id: 'finding_commonError_wa',
      dimension: 'commonError',
      title: '题目 A：40% 学生遇到 WA 错误',
      evidence: { affectedStudents: range(20), affectedProblems: [1], metrics: {} },
    });
    const commonTLE = makeFinding({
      id: 'finding_commonError_tle',
      dimension: 'commonError',
      title: '题目 A：38% 学生遇到 TLE 错误',
      evidence: { affectedStudents: range(19), affectedProblems: [1], metrics: {} },
    });
    const cluster = makeFinding({
      id: 'finding_errorCluster_1',
      dimension: 'errorCluster',
      errorSignature: 'TLE:tests[7]',
      evidence: { affectedStudents: range(18), affectedProblems: [1], metrics: {} },
    });

    const result = consolidateFindings([commonWA, commonTLE, cluster]);
    const tle = result.find(f => f.id === 'finding_commonError_tle');
    expect(result).toHaveLength(2);
    expect(tle?.errorSignature).toBe('TLE:tests[7]');
  });
});

describe('consolidateFindings — crossCorrelation folding', () => {
  it('folds a crossCorrelation whose students are contained in a host finding', () => {
    const atRisk = makeFinding({
      id: 'finding_atRisk_1',
      dimension: 'atRisk',
      severity: 'high',
      title: '7 名学生在 ≥70% 的题目上未通过（占比 7%）',
      evidence: { affectedStudents: range(7), affectedProblems: [1, 2, 3], metrics: {} },
    });
    const cross = makeFinding({
      id: 'finding_crossCorrelation_1',
      dimension: 'crossCorrelation',
      title: '7名高危学生行为分布: 2名未参与, 5名沉默挣扎',
      confidence: 'low',
      evidence: { affectedStudents: range(7), affectedProblems: [], metrics: {} },
    });

    const result = consolidateFindings([atRisk, cross]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('finding_atRisk_1');
    expect(result[0].supplements).toContain('7名高危学生行为分布: 2名未参与, 5名沉默挣扎');
  });

  it('keeps a crossCorrelation standalone when no host covers its students', () => {
    const atRisk = makeFinding({
      id: 'finding_atRisk_1',
      dimension: 'atRisk',
      evidence: { affectedStudents: range(7), affectedProblems: [1], metrics: {} },
    });
    const cross = makeFinding({
      id: 'finding_crossCorrelation_1',
      dimension: 'crossCorrelation',
      evidence: { affectedStudents: range(20, 100), affectedProblems: [1], metrics: {} },
    });

    const result = consolidateFindings([atRisk, cross]);
    expect(result.map(f => f.id)).toContain('finding_crossCorrelation_1');
  });
});

describe('consolidateFindings — ranking and capping', () => {
  it('sorts by severity then affected count and marks overflow as secondary', () => {
    const findings = [
      makeFinding({
        id: 'low_small', severity: 'low',
        evidence: { affectedStudents: range(5), affectedProblems: [1], metrics: {} },
      }),
      makeFinding({
        id: 'high_big', severity: 'high', dimension: 'atRisk',
        evidence: { affectedStudents: range(40), affectedProblems: [2], metrics: {} },
      }),
      makeFinding({
        id: 'medium_1', severity: 'medium', dimension: 'temporalPattern',
        evidence: { affectedStudents: range(10), affectedProblems: [3], metrics: {} },
      }),
      makeFinding({
        id: 'medium_2', severity: 'medium', dimension: 'strategy',
        evidence: { affectedStudents: range(20), affectedProblems: [4], metrics: {} },
      }),
      makeFinding({
        id: 'high_small', severity: 'high', dimension: 'difficulty',
        evidence: { affectedStudents: range(8), affectedProblems: [5], metrics: {} },
      }),
      makeFinding({
        id: 'low_tail', severity: 'low', dimension: 'aiEffectiveness',
        evidence: { affectedStudents: range(4), affectedProblems: [6], metrics: {} },
      }),
    ];

    const result = consolidateFindings(findings);

    expect(result.map(f => f.id)).toEqual([
      'high_big', 'high_small', 'medium_2', 'medium_1', 'low_small', 'low_tail',
    ]);
    const secondary = result.filter(f => f.isSecondary).map(f => f.id);
    expect(secondary).toEqual(['low_tail']);
    expect(result.filter(f => !f.isSecondary)).toHaveLength(MAX_PRIMARY);
  });

  it('pins progress findings last without consuming a primary slot', () => {
    const findings = [
      makeFinding({
        id: 'progress_1', dimension: 'progress', severity: 'low',
        evidence: { affectedStudents: range(64), affectedProblems: [1], metrics: {} },
      }),
      makeFinding({
        id: 'error_1', severity: 'high',
        evidence: { affectedStudents: range(42), affectedProblems: [1], metrics: {} },
      }),
    ];

    const result = consolidateFindings(findings);
    expect(result.map(f => f.id)).toEqual(['error_1', 'progress_1']);
    expect(result.find(f => f.id === 'progress_1')?.isSecondary).toBeUndefined();
  });

  it('handles the screenshot scenario: 8 findings collapse to a focused set', () => {
    // 重现用户截图：百鸡问题/再次换钞票各有 commonError+errorCluster,
    // atRisk + 行为分布 crossCorrelation, temporalPattern, progress
    const students1138 = range(42);
    const students1139 = range(35, 200);
    const atRiskUids = range(7, 400);

    const findings = [
      makeFinding({
        id: 'cross_atrisk', dimension: 'crossCorrelation', severity: 'high',
        title: '7名高危学生行为分布: 2名未参与',
        confidence: 'low',
        evidence: { affectedStudents: atRiskUids, affectedProblems: [], metrics: {} },
      }),
      makeFinding({
        id: 'common_1138', dimension: 'commonError', severity: 'medium',
        title: '百鸡问题 (1138)：42% 学生遇到 WA 错误',
        evidence: { affectedStudents: students1138, affectedProblems: [1138], metrics: {} },
      }),
      makeFinding({
        id: 'common_1139', dimension: 'commonError', severity: 'medium',
        title: '再次换钞票 (1139)：35% 学生遇到 WA 错误',
        evidence: { affectedStudents: students1139, affectedProblems: [1139], metrics: {} },
      }),
      makeFinding({
        id: 'atrisk', dimension: 'atRisk', severity: 'medium',
        title: '7 名学生在 ≥70% 的题目上未通过（占比 7%）',
        evidence: { affectedStudents: atRiskUids, affectedProblems: [1138, 1139, 1140], metrics: {} },
      }),
      makeFinding({
        id: 'cluster_1138', dimension: 'errorCluster', severity: 'medium',
        title: '百鸡问题：42% 学生遇到相同错误模式 (WA)',
        errorSignature: 'WA:tests[1,2]',
        evidence: { affectedStudents: students1138, affectedProblems: [1138], metrics: {} },
      }),
      makeFinding({
        id: 'cluster_1139', dimension: 'errorCluster', severity: 'medium',
        title: '再次换钞票：34% 学生遇到相同错误模式 (WA)',
        errorSignature: 'WA:tests[5]',
        evidence: { affectedStudents: students1139.slice(0, 34), affectedProblems: [1139], metrics: {} },
      }),
      makeFinding({
        id: 'temporal', dimension: 'temporalPattern', severity: 'medium',
        title: '10 名学生呈现"未充分参与"行为模式（10%）',
        confidence: 'low',
        evidence: { affectedStudents: range(10, 600), affectedProblems: [1138, 1139, 1140], metrics: {} },
      }),
      makeFinding({
        id: 'progress', dimension: 'progress', severity: 'low',
        title: '64 名学生完成了全部 3 道题目（63%）',
        evidence: { affectedStudents: range(64, 700), affectedProblems: [1138, 1139, 1140], metrics: {} },
      }),
    ];

    const result = consolidateFindings(findings);

    // 8 条 → 5 条：两组 commonError+errorCluster 各合并为一条,
    // crossCorrelation 折叠进 atRisk, progress 保留在末尾
    expect(result).toHaveLength(5);
    expect(result.filter(f => f.isSecondary)).toHaveLength(0);
    expect(result[result.length - 1].dimension).toBe('progress');

    const atRisk = result.find(f => f.id === 'atrisk');
    expect(atRisk?.supplements).toContain('7名高危学生行为分布: 2名未参与');

    const merged1138 = result.find(f => f.id === 'common_1138');
    expect(merged1138?.errorSignature).toBe('WA:tests[1,2]');
  });
});
