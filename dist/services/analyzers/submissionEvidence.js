"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERROR_STATUSES = void 0;
exports.submissionTime = submissionTime;
exports.errorCodeSamples = errorCodeSamples;
exports.ERROR_STATUSES = new Set([2, 3, 4, 5, 6, 7]);
/** Hydro assigns the record ObjectId at submission; judgeAt changes on rejudge. */
function submissionTime(record) {
    const id = record._id;
    const time = id?.getTimestamp?.() ?? record.submittedAt ?? record.judgeAt;
    return time instanceof Date && Number.isFinite(time.getTime()) ? time : undefined;
}
/** Keep text and provenance aligned. A sample proves only this submission's result. */
function errorCodeSamples(records, resolvedUids = new Set()) {
    const selected = records.filter(r => exports.ERROR_STATUSES.has(r.status) && r.code?.trim()).slice(0, 3);
    if (!selected.length)
        return undefined;
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
//# sourceMappingURL=submissionEvidence.js.map