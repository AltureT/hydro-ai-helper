/**
 * Finding Consolidator — 发现项整合器
 *
 * 规则引擎的 11 个维度常对同一现象从不同角度各出一条发现，教师会看到大量重复内容：
 * commonError 与 errorCluster 对同一题目各出一条、crossCorrelation 把 atRisk 的
 * 学生集合重新切一遍再出一条。本模块在 LLM 调用与前端展示之前做三件事：
 *
 * 1. 合并：同题且学生集合高度重叠的 errorCluster 并入 commonError，
 *    错误签名与代码样本随主发现保留；
 * 2. 折叠：学生集合基本被某个主发现覆盖的 crossCorrelation 降级为该发现的
 *    supplements 补充说明，不再单独成条；
 * 3. 排序限量：按严重度 + 影响人数排序，前 MAX_PRIMARY 条为重点问题，
 *    其余标记 isSecondary（前端在"其他观察"中一行带过）。
 *    progress（正向进展）不参与排序限量，固定排在最后由前端另行展示。
 */

import { TeachingFinding } from '../../models/teachingSummary';

export const MAX_PRIMARY = 5;

/** errorCluster 并入 commonError 所需的最小学生重叠率（占较小集合的比例） */
const MERGE_OVERLAP_THRESHOLD = 0.5;

/** crossCorrelation 折叠为补充说明所需的最小学生包含率 */
const FOLD_CONTAINMENT_THRESHOLD = 0.8;

const SEVERITY_RANK: Record<TeachingFinding['severity'], number> = {
  high: 2,
  medium: 1,
  low: 0,
};

function overlapRatio(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const uid of a) {
    if (setB.has(uid)) shared++;
  }
  return shared / Math.min(a.length, b.length);
}

/** |a ∩ b| / |a| — a 被 b 覆盖的比例 */
function containmentRatio(a: number[], b: number[]): number {
  if (a.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const uid of a) {
    if (setB.has(uid)) shared++;
  }
  return shared / a.length;
}

function maxSeverity(
  a: TeachingFinding['severity'],
  b: TeachingFinding['severity'],
): TeachingFinding['severity'] {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** 从错误签名提取状态标签（如 "WA:tests[3,4]" → "WA"） */
function signatureStatusLabel(signature?: string): string | null {
  if (!signature) return null;
  const idx = signature.indexOf(':');
  return idx > 0 ? signature.slice(0, idx) : signature;
}

function pushSupplement(host: TeachingFinding, text: string): void {
  if (!host.supplements) host.supplements = [];
  if (!host.supplements.includes(text)) host.supplements.push(text);
}

/**
 * Step 1: 将 errorCluster 并入同题、学生高度重叠的 commonError。
 * 优先选择标题含有相同错误状态标签（WA/TLE/...）的宿主。
 */
function mergeErrorClusters(findings: TeachingFinding[]): TeachingFinding[] {
  const commonErrors = findings.filter(f => f.dimension === 'commonError');
  const dropped = new Set<string>();

  for (const cluster of findings) {
    if (cluster.dimension !== 'errorCluster') continue;
    const pid = cluster.evidence.affectedProblems[0];
    if (pid === undefined) continue;

    const candidates = commonErrors
      .filter(host =>
        host.evidence.affectedProblems.length === 1
        && host.evidence.affectedProblems[0] === pid)
      .map(host => ({
        host,
        overlap: overlapRatio(cluster.evidence.affectedStudents, host.evidence.affectedStudents),
      }))
      .filter(({ overlap }) => overlap >= MERGE_OVERLAP_THRESHOLD);

    if (candidates.length === 0) continue;

    // 同状态标签的宿主优先，其次按重叠率
    const statusLabel = signatureStatusLabel(cluster.errorSignature);
    candidates.sort((a, b) => {
      if (statusLabel) {
        const aMatch = a.host.title.includes(statusLabel) ? 1 : 0;
        const bMatch = b.host.title.includes(statusLabel) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
      }
      return b.overlap - a.overlap;
    });

    const host = candidates[0].host;
    host.severity = maxSeverity(host.severity, cluster.severity);
    host.needsDeepDive = host.needsDeepDive || cluster.needsDeepDive;
    if (!host.errorSignature) host.errorSignature = cluster.errorSignature;
    if (!host.evidence.samples?.code?.length && cluster.evidence.samples?.code?.length) {
      host.evidence.samples = cluster.evidence.samples;
    }
    const clusterSize = cluster.evidence.affectedStudents.length;
    host.evidence.metrics.sameSignatureCount = clusterSize;
    pushSupplement(host,
      `${clusterSize} 名学生的最后一次提交失败在同一处（错误签名 ${cluster.errorSignature || '相同错误模式'}），大概率是同一个知识点没讲透`);
    dropped.add(cluster.id);
  }

  return findings.filter(f => !dropped.has(f.id));
}

/**
 * Step 2: 学生集合基本被某主发现覆盖的 crossCorrelation 折叠为其补充说明。
 */
function foldCrossCorrelations(findings: TeachingFinding[]): TeachingFinding[] {
  const hosts = findings.filter(
    f => f.dimension !== 'crossCorrelation' && f.dimension !== 'progress',
  );
  const dropped = new Set<string>();

  for (const cross of findings) {
    if (cross.dimension !== 'crossCorrelation') continue;
    if (cross.evidence.affectedStudents.length === 0) continue;

    let best: TeachingFinding | null = null;
    let bestContainment = 0;
    for (const host of hosts) {
      const containment = containmentRatio(
        cross.evidence.affectedStudents,
        host.evidence.affectedStudents,
      );
      if (containment > bestContainment) {
        bestContainment = containment;
        best = host;
      }
    }

    if (best && bestContainment >= FOLD_CONTAINMENT_THRESHOLD) {
      pushSupplement(best, cross.title);
      dropped.add(cross.id);
    }
  }

  return findings.filter(f => !dropped.has(f.id));
}

/**
 * Step 3: 排序限量。progress 固定最后且不占重点名额。
 */
function rankAndCap(findings: TeachingFinding[]): TeachingFinding[] {
  const progress = findings.filter(f => f.dimension === 'progress');
  const rest = findings.filter(f => f.dimension !== 'progress');

  rest.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return b.evidence.affectedStudents.length - a.evidence.affectedStudents.length;
  });

  rest.forEach((f, idx) => {
    if (idx >= MAX_PRIMARY) f.isSecondary = true;
  });

  return [...rest, ...progress];
}

/**
 * 主入口：合并 → 折叠 → 排序限量。
 * 就地修改传入的 finding 对象（宿主吸收补充信息），返回整合后的新数组。
 */
export function consolidateFindings(findings: TeachingFinding[]): TeachingFinding[] {
  const merged = mergeErrorClusters(findings);
  const folded = foldCrossCorrelations(merged);
  return rankAndCap(folded);
}
