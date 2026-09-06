import { TeachingFinding } from '../../models/teachingSummary';

export const ERROR_STATUSES = new Set([2, 3, 4, 5, 6, 7]);

export interface EvidenceRecord {
  _id?: unknown;
  uid: number;
  pid: number;
  status: number;
  code?: string;
  lang?: string;
  judgeAt?: Date;
  submittedAt?: Date;
}

/** Hydro assigns the record ObjectId at submission; judgeAt changes on rejudge. */
export function submissionTime(record: Pick<EvidenceRecord, '_id' | 'judgeAt' | 'submittedAt'>): Date | undefined {
  const id = record._id as { getTimestamp?: () => Date } | undefined;
  const time = id?.getTimestamp?.() ?? record.submittedAt ?? record.judgeAt;
  return time instanceof Date && Number.isFinite(time.getTime()) ? time : undefined;
}

/** Keep text and provenance aligned. A sample proves only this submission's result. */
export function errorCodeSamples(
  records: EvidenceRecord[],
  resolvedUids = new Set<number>(),
): TeachingFinding['evidence']['samples'] {
  const selected = records.filter(r => ERROR_STATUSES.has(r.status) && r.code?.trim()).slice(0, 3);
  if (!selected.length) return undefined;
  const maxChars = 4000;
  return {
    code: selected.map(r => r.code.length > maxChars
      ? `${r.code.slice(0, maxChars)}\n[代码已截断]` : r.code),
    codeSources: selected.map(r => ({
      recordId: r._id == null ? undefined : String(r._id),
      uid: r.uid,
      pid: r.pid,
      status: r.status,
      lang: r.lang,
      submittedAt: submissionTime(r)?.toISOString(),
      truncated: r.code.length > maxChars,
      resolved: resolvedUids.has(r.uid),
    })),
  };
}
