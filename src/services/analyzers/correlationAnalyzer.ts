/**
 * Cross-Dimensional Correlation Analyzer
 *
 * Combines findings from multiple dimensions (atRisk, difficulty, errorCluster, commonError)
 * with StudentTemporalProfile data to generate 'crossCorrelation' findings.
 */

import {
  TeachingFinding,
  StudentTemporalProfile,
  TemporalPatternLabel,
  ConfidenceLevel,
} from '../../models/teachingSummary';
import { ERROR_STATUSES } from './submissionEvidence';

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_GROUP_SIZE = 5;
const LOW_CONFIDENCE_THRESHOLD = 15;

const PATTERN_LABELS_ZH: Record<TemporalPatternLabel, string> = {
  strategic_solver: '少量提交后通过',
  disengaged: '少量提交后暂无新记录',
  burst_then_quit: '密集提交后暂无新记录',
  stuck_silent: '多次未通过且无 AI 对话记录',
  persistent_learner: '跨时段继续尝试',
};

// Priority for "worst" aggregation (higher = worse)
const PATTERN_PRIORITY: Record<TemporalPatternLabel, number> = {
  strategic_solver: 0,
  persistent_learner: 1,
  disengaged: 2,
  burst_then_quit: 3,
  stuck_silent: 4,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function confidenceFor(groupSize: number): ConfidenceLevel {
  if (groupSize >= LOW_CONFIDENCE_THRESHOLD) return 'high';
  if (groupSize >= MIN_GROUP_SIZE) return 'low';
  return 'insufficient_data';
}

// ── Exported correlation functions ────────────────────────────────────────────

/**
 * Pair 1: Error finding × AI usage
 * Compares AC rates between students who used AI vs those who didn't,
 * for a given error finding's affected students on the first affected problem.
 */
export function correlateErrorAI(
  errorFinding: TeachingFinding,
  aiUserUids: Set<number>,
  recordsByPidUid: Map<string, Array<{ status: number }>>,
  totalStudents: number,
): TeachingFinding | null {
  const affectedStudents = errorFinding.evidence.affectedStudents;
  const pid = errorFinding.evidence.affectedProblems[0];

  if (pid === undefined) return null;

  const withAI: number[] = [];
  const withoutAI: number[] = [];

  for (const uid of affectedStudents) {
    const records = recordsByPidUid.get(`${pid}:${uid}`) ?? [];
    if (!records.some(r => r.status === 1) && !ERROR_STATUSES.has(records[records.length - 1]?.status)) continue;
    if (aiUserUids.has(uid)) {
      withAI.push(uid);
    } else {
      withoutAI.push(uid);
    }
  }

  if (withAI.length < MIN_GROUP_SIZE || withoutAI.length < MIN_GROUP_SIZE) {
    return null;
  }

  // Calculate AC rates for each group on the first affected problem
  function acRate(uids: number[]): number {
    let acCount = 0;
    for (const uid of uids) {
      const key = `${pid}:${uid}`;
      const records = recordsByPidUid.get(key) ?? [];
      if (records.some(r => r.status === 1)) acCount++;
    }
    return Math.round((acCount / uids.length) * 100);
  }

  const aiRate = acRate(withAI);
  const nonAiRate = acRate(withoutAI);
  const diff = Math.abs(aiRate - nonAiRate);

  if (diff < 5) return null;

  // Extract status label from error finding title (e.g. "WA", "TLE", etc.)
  const statusLabels: Record<number, string> = { 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE' };
  const statusLabel = statusLabels[errorFinding.errorStatus] || errorFinding.errorSignature?.split(':')[0] || '错误';

  return {
    id: '', // placeholder, assigned by orchestrator
    dimension: 'crossCorrelation',
    sourceFindingId: errorFinding.id,
    severity: diff >= 20 ? 'high' : diff >= 10 ? 'medium' : 'low',
    title: `曾出现 ${statusLabel} 的学生中，有 AI 对话者 ${withAI.length} 人通过率 ${aiRate}%，其他学生 ${withoutAI.length} 人通过率 ${nonAiRate}%（仅为相关观察）`,
    evidence: {
      affectedStudents: [...withAI, ...withoutAI],
      affectedProblems: [pid],
      metrics: {
        aiRate,
        nonAiRate,
        diff,
        withAICount: withAI.length,
        withoutAICount: withoutAI.length,
        totalStudents,
      },
    },
    needsDeepDive: false,
    confidence: confidenceFor(Math.min(withAI.length, withoutAI.length)),
  };
}

/**
 * Pair 2: At-risk students × temporal patterns
 * Finds the distribution of temporal patterns among at-risk students.
 */
export function correlateAtRiskTemporal(
  atRiskUids: number[],
  temporalProfiles: StudentTemporalProfile[],
  totalStudents: number,
): TeachingFinding | null {
  if (atRiskUids.length < MIN_GROUP_SIZE) return null;

  const atRiskSet = new Set(atRiskUids);

  // For each at-risk student, find their worst pattern across all profiles
  const studentWorstPattern = new Map<number, TemporalPatternLabel>();

  for (const profile of temporalProfiles) {
    if (!atRiskSet.has(profile.uid)) continue;

    const existing = studentWorstPattern.get(profile.uid);
    const newPriority = PATTERN_PRIORITY[profile.pattern];
    const existingPriority = existing !== undefined ? PATTERN_PRIORITY[existing] : -1;

    if (newPriority > existingPriority) {
      studentWorstPattern.set(profile.uid, profile.pattern);
    }
  }

  // Count per pattern
  const patternCounts: Partial<Record<TemporalPatternLabel, number>> = {};
  for (const pattern of studentWorstPattern.values()) {
    patternCounts[pattern] = (patternCounts[pattern] ?? 0) + 1;
  }

  if (Object.keys(patternCounts).length === 0) {
    return null;
  }

  // Build breakdown string sorted by count descending
  const breakdownParts = (Object.entries(patternCounts) as Array<[TemporalPatternLabel, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => `${count}名${PATTERN_LABELS_ZH[pattern]}`);

  const breakdown = breakdownParts.join(', ');
  const count = atRiskUids.length;

  const metrics: Record<string, number> = { affectedCount: count, totalStudents };
  for (const [pattern, cnt] of Object.entries(patternCounts)) {
    metrics[pattern] = cnt as number;
  }

  return {
    id: '', // placeholder, assigned by orchestrator
    dimension: 'crossCorrelation',
    severity: 'high',
    title: `${count} 名待核实完成情况的学生中，可见提交记录分布：${breakdown}`,
    evidence: {
      affectedStudents: atRiskUids,
      affectedProblems: [],
      metrics,
    },
    needsDeepDive: false,
    confidence: confidenceFor(count),
  };
}

/**
 * Pair 3: Difficulty finding × error cluster findings
 * Correlates low-pass-rate problems with concentrated error patterns.
 */
export function correlateDifficultyError(
  difficultyFinding: TeachingFinding,
  errorClusterFindings: TeachingFinding[],
  totalStudents: number,
): TeachingFinding | null {
  const problems = difficultyFinding.evidence.affectedProblems;
  if (problems.length === 0) return null;

  // Find error clusters that share at least one problem with this difficulty finding
  const problemSet = new Set(problems);

  const matchingClusters = errorClusterFindings.filter(f =>
    f.evidence.affectedProblems.some(p => problemSet.has(p)),
  );

  if (matchingClusters.length === 0) return null;

  // Pick the largest cluster (most affected students)
  const largestCluster = matchingClusters.reduce((best, current) =>
    current.evidence.affectedStudents.length > best.evidence.affectedStudents.length
      ? current
      : best,
  );

  const passRate = difficultyFinding.evidence.metrics.passRate
    ?? Math.round(
      ((difficultyFinding.evidence.metrics.accepted ?? 0) /
        Math.max(difficultyFinding.evidence.metrics.attempted ?? 1, 1)) * 100,
    );

  const clusterSize = largestCluster.evidence.affectedStudents.length;
  const attempted = difficultyFinding.evidence.metrics.attempted
    ?? difficultyFinding.evidence.affectedStudents.length;
  const failedAttempted = Math.max(attempted - (difficultyFinding.evidence.metrics.accepted ?? 0), clusterSize);
  const clusterPct = failedAttempted > 0
    ? Math.round((clusterSize / failedAttempted) * 100)
    : Math.round((clusterSize / Math.max(totalStudents, 1)) * 100);

  const pid = problems[0];

  const allAffected = Array.from(
    new Set([
      ...difficultyFinding.evidence.affectedStudents,
      ...largestCluster.evidence.affectedStudents,
    ]),
  );

  return {
    id: '', // placeholder, assigned by orchestrator
    dimension: 'crossCorrelation',
    sourceFindingId: difficultyFinding.id,
    severity: passRate <= 20 ? 'high' : 'medium',
    title: `通过率 ${passRate}% 的题目，${clusterPct}% 尚未通过者的判题特征相同（原因待核实）`,
    evidence: {
      affectedStudents: allAffected,
      affectedProblems: [pid],
      metrics: {
        passRate,
        clusterPct,
        clusterSize,
        attempted,
        totalStudents,
      },
    },
    needsDeepDive: false,
    confidence: confidenceFor(clusterSize),
  };
}

/**
 * Orchestrator: run all 3 correlation pairs and return cross-correlation findings.
 */
export function analyzeCorrelations(
  findings: TeachingFinding[],
  temporalProfiles: StudentTemporalProfile[],
  totalStudents: number,
  aiUserUids?: Set<number>,
  recordsByPidUid?: Map<string, Array<{ status: number }>>,
): TeachingFinding[] {
  const results: TeachingFinding[] = [];

  const errorFindings = findings.filter(
    f => f.dimension === 'commonError' || f.dimension === 'errorCluster',
  );
  const atRiskFindings = findings.filter(f => f.dimension === 'atRisk');
  const difficultyFindings = findings.filter(f => f.dimension === 'difficulty');
  const errorClusterFindings = findings.filter(f => f.dimension === 'errorCluster');

  // Pair 1: error × AI usage
  if (aiUserUids && recordsByPidUid) {
    for (const errorFinding of errorFindings) {
      const result = correlateErrorAI(errorFinding, aiUserUids, recordsByPidUid, totalStudents);
      if (result) results.push(result);
    }
  }

  // Pair 2: atRisk × temporal patterns
  for (const atRiskFinding of atRiskFindings) {
    const result = correlateAtRiskTemporal(
      atRiskFinding.evidence.affectedStudents,
      temporalProfiles,
      totalStudents,
    );
    if (result) results.push({ ...result, sourceFindingId: atRiskFinding.id });
  }

  // Pair 3: difficulty × errorCluster
  for (const diffFinding of difficultyFindings) {
    const result = correlateDifficultyError(diffFinding, errorClusterFindings, totalStudents);
    if (result) results.push(result);
  }

  // Assign sequential IDs (avoids module-level mutable state)
  for (let i = 0; i < results.length; i++) {
    results[i].id = `finding_crossCorrelation_${i + 1}`;
  }

  return results;
}
