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

// ── Constants ─────────────────────────────────────────────────────────────────

let counter = 0;
const MIN_GROUP_SIZE = 5;
const LOW_CONFIDENCE_THRESHOLD = 15;

const PATTERN_LABELS_ZH: Record<TemporalPatternLabel, string> = {
  strategic_solver: '高效解题',
  disengaged: '未参与',
  burst_then_quit: '受挫放弃',
  stuck_silent: '沉默挣扎',
  persistent_learner: '持续努力',
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

export function resetCounter(): void {
  counter = 0;
}

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

  counter++;

  // Extract status label from error finding title (e.g. "WA", "TLE", etc.)
  const titleMatch = errorFinding.title.match(/\(([A-Z]+)\)/);
  const statusLabel = titleMatch ? titleMatch[1] : '错误';

  const groupSize = affectedStudents.length;

  return {
    id: `finding_crossCorrelation_${counter}`,
    dimension: 'crossCorrelation',
    severity: diff >= 20 ? 'high' : diff >= 10 ? 'medium' : 'low',
    title: `AI辅导对 ${statusLabel} 错误有效率${aiRate}% vs 未用AI仅${nonAiRate}%`,
    evidence: {
      affectedStudents: affectedStudents,
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
    confidence: confidenceFor(groupSize),
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
    // No temporal profiles found for at-risk students — still generate finding
  }

  // Build breakdown string sorted by count descending
  const breakdownParts = (Object.entries(patternCounts) as Array<[TemporalPatternLabel, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => `${count}名${PATTERN_LABELS_ZH[pattern]}`);

  const breakdown = breakdownParts.join(', ');
  const count = atRiskUids.length;

  counter++;

  const metrics: Record<string, number> = { affectedCount: count, totalStudents };
  for (const [pattern, cnt] of Object.entries(patternCounts)) {
    metrics[pattern] = cnt as number;
  }

  return {
    id: `finding_crossCorrelation_${counter}`,
    dimension: 'crossCorrelation',
    severity: 'high',
    title: `${count}名高危学生行为分布: ${breakdown}`,
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

  counter++;

  const allAffected = Array.from(
    new Set([
      ...difficultyFinding.evidence.affectedStudents,
      ...largestCluster.evidence.affectedStudents,
    ]),
  );

  return {
    id: `finding_crossCorrelation_${counter}`,
    dimension: 'crossCorrelation',
    severity: passRate <= 20 ? 'high' : 'medium',
    title: `通过率${passRate}%的难题，${clusterPct}%失败集中在同一错误模式`,
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
  resetCounter();

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
    if (result) results.push(result);
  }

  // Pair 3: difficulty × errorCluster
  for (const diffFinding of difficultyFindings) {
    const result = correlateDifficultyError(diffFinding, errorClusterFindings, totalStudents);
    if (result) results.push(result);
  }

  return results;
}
