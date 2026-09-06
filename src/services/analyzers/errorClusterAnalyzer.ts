/**
 * Error Cluster Analyzer — groups non-AC submissions by error signature
 * to find common error patterns across students.
 *
 * IMPORTANT: records must be sorted by judgeAt ascending (oldest first).
 * The analyzer uses last-write-wins to keep each student's latest signature.
 */

import { TeachingFinding } from '../../models/teachingSummary';
import { createHash } from 'crypto';
import { ERROR_STATUSES, errorCodeSamples, EvidenceRecord } from './submissionEvidence';

const STATUS_LABEL: Record<number, string> = {
  2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE',
};

const MIN_AFFECTED = 5;

interface ClusterRecord extends EvidenceRecord {
  testCases?: Array<{ id?: number; subtaskId?: number; status?: number }>;
  compilerTexts?: string[];
  code?: string;
}

export function errorSignature(record: ClusterRecord): string {
  if (record.status === 7) {
    if (record.compilerTexts?.length) {
      return `CE:${normalizeCompilerError(record.compilerTexts[0])}`;
    }
    return 'CE:unknown';
  }
  const failingTCs = (record.testCases || []).filter(tc => ERROR_STATUSES.has(tc.status));
  const failingTests = failingTCs
    .map(tc => tc.id ?? tc.subtaskId ?? '?')
    .sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a).localeCompare(String(b));
    })
    .slice(0, 5)
    .join(',');
  // Hash the complete failure set so identical first five cases cannot merge
  // different signatures. Subtask IDs disambiguate repeated per-subtask case IDs.
  const fullSignature = failingTCs.map(tc => `${tc.subtaskId ?? ''}:${tc.id ?? '?'}:${tc.status}`).sort();
  const suffix = failingTCs.length > 5 || failingTCs.some(tc => tc.subtaskId !== undefined)
    ? `#${createHash('sha256').update(JSON.stringify(fullSignature)).digest('hex').slice(0, 16)}` : '';
  return `${STATUS_LABEL[record.status] || record.status}:tests[${failingTests}${failingTCs.length > 5 ? `...+${failingTCs.length - 5}` : ''}]${suffix}`;
}

export function normalizeCompilerError(msg: string): string {
  const lines = msg.split('\n').filter(l => l.trim());
  const errorLine = msg.includes('Traceback') ? lines[lines.length - 1] : lines[0];
  return (errorLine || msg)
    .replace(/line \d+/gi, 'line N')
    .replace(/column \d+/gi, 'col N')
    .replace(/'[a-zA-Z_]\w*'/g, "'VAR'")
    .replace(/\/[\w/]+\.\w+/g, 'FILE');
}

export function analyzeErrorClusters(
  records: ClusterRecord[],
  pids: number[],
  totalStudents: number,
  pidTitles?: Map<number, string>,
): (TeachingFinding | null)[] {
  const findings: (TeachingFinding | null)[] = [];
  let counter = 0;

  // Pre-group by pid to avoid O(pids × records)
  const recordsByPid = new Map<number, ClusterRecord[]>();
  for (const rec of records) {
    if (!recordsByPid.has(rec.pid)) recordsByPid.set(rec.pid, []);
    (recordsByPid.get(rec.pid) as ClusterRecord[]).push(rec);
  }

  for (const pid of pids) {
    const pidRecords = recordsByPid.get(pid) ?? [];

    // Last-write-wins: records must be sorted by judgeAt ascending,
    // so the final set() per uid is the student's latest submission signature.
    const latestRecords = new Map<number, ClusterRecord>();
    const resolvedUids = new Set<number>();
    for (const rec of pidRecords) {
      latestRecords.set(rec.uid, rec);
      if (rec.status === 1) resolvedUids.add(rec.uid);
    }

    const sigStudents = new Map<string, Set<number>>();
    for (const [uid, rec] of latestRecords) {
      if (resolvedUids.has(uid) || !ERROR_STATUSES.has(rec.status)) continue;
      // Missing judge detail is not evidence of a shared failing location.
      const hasDetail = rec.status === 7
        ? rec.compilerTexts?.some(t => t.trim())
        : rec.testCases?.some(tc => ERROR_STATUSES.has(tc.status) && (tc.id !== undefined || tc.subtaskId !== undefined));
      if (!hasDetail) continue;
      const sig = errorSignature(rec);
      if (!sigStudents.has(sig)) sigStudents.set(sig, new Set());
      (sigStudents.get(sig) as Set<number>).add(uid);
    }

    const threshold = Math.max(MIN_AFFECTED, Math.ceil(totalStudents * 0.3));

    for (const [sig, uids] of sigStudents) {
      if (uids.size < threshold) continue;

      counter++;
      const statusLabel = sig.split(':')[0];
      const pct = Math.round((uids.size / totalStudents) * 100);
      const matchingRecords = [...uids].map(uid => latestRecords.get(uid));

      findings.push({
        id: `finding_errorCluster_${counter}`,
        dimension: 'errorCluster',
        severity: uids.size >= totalStudents * 0.5 ? 'high' : 'medium',
        title: `${pidTitles?.get(pid) || `题目 ${pid}`}：${pct}% 学生尚未通过，最近提交的判题特征相同 (${statusLabel})`,
        errorSignature: sig,
        errorStatus: matchingRecords[0].status,
        evidence: {
          affectedStudents: Array.from(uids),
          affectedProblems: [pid],
          metrics: {
            affectedCount: uids.size,
            totalStudents,
            percentage: pct,
          },
          samples: errorCodeSamples(matchingRecords),
        },
        needsDeepDive: true,
      });
    }
  }

  return findings;
}
