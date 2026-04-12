"use strict";
/**
 * Error Cluster Analyzer — groups non-AC submissions by error signature
 * to find common error patterns across students.
 *
 * IMPORTANT: records must be sorted by judgeAt ascending (oldest first).
 * The analyzer uses last-write-wins to keep each student's latest signature.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorSignature = errorSignature;
exports.normalizeCompilerError = normalizeCompilerError;
exports.analyzeErrorClusters = analyzeErrorClusters;
const STATUS_LABEL = {
    2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE',
};
const MIN_AFFECTED = 5;
function errorSignature(record) {
    if (record.status === 7) {
        if (record.compilerTexts?.length) {
            return `CE:${normalizeCompilerError(record.compilerTexts[0])}`;
        }
        return 'CE:unknown';
    }
    const failingTCs = (record.testCases || []).filter(tc => tc.status !== 1);
    const failingTests = failingTCs
        .map(tc => tc.id ?? tc.subtaskId ?? '?')
        .sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number')
            return a - b;
        return String(a).localeCompare(String(b));
    })
        .slice(0, 5)
        .join(',');
    const suffix = failingTCs.length > 5 ? `...+${failingTCs.length - 5}` : '';
    return `${STATUS_LABEL[record.status] || record.status}:tests[${failingTests}${suffix}]`;
}
function normalizeCompilerError(msg) {
    const lines = msg.split('\n').filter(l => l.trim());
    const errorLine = msg.includes('Traceback') ? lines[lines.length - 1] : lines[0];
    return (errorLine || msg)
        .replace(/line \d+/gi, 'line N')
        .replace(/column \d+/gi, 'col N')
        .replace(/'[a-zA-Z_]\w*'/g, "'VAR'")
        .replace(/\/[\w\/]+\.\w+/g, 'FILE');
}
function analyzeErrorClusters(records, pids, totalStudents, pidTitles) {
    const findings = [];
    let counter = 0;
    // Pre-group by pid to avoid O(pids × records)
    const recordsByPid = new Map();
    for (const rec of records) {
        if (!recordsByPid.has(rec.pid))
            recordsByPid.set(rec.pid, []);
        recordsByPid.get(rec.pid).push(rec);
    }
    for (const pid of pids) {
        const pidRecords = recordsByPid.get(pid) ?? [];
        // Last-write-wins: records must be sorted by judgeAt ascending,
        // so the final set() per uid is the student's latest submission signature.
        const studentSignatures = new Map();
        for (const rec of pidRecords) {
            const sig = errorSignature(rec);
            studentSignatures.set(rec.uid, sig);
        }
        const sigStudents = new Map();
        for (const [uid, sig] of studentSignatures) {
            if (!sigStudents.has(sig))
                sigStudents.set(sig, new Set());
            sigStudents.get(sig).add(uid);
        }
        const threshold = Math.max(MIN_AFFECTED, Math.ceil(totalStudents * 0.3));
        for (const [sig, uids] of sigStudents) {
            if (uids.size < threshold)
                continue;
            counter++;
            const statusLabel = sig.split(':')[0];
            const pct = Math.round((uids.size / totalStudents) * 100);
            const sampleRecord = pidRecords.find(r => uids.has(r.uid) && r.code);
            findings.push({
                id: `finding_errorCluster_${counter}`,
                dimension: 'errorCluster',
                severity: uids.size >= totalStudents * 0.5 ? 'high' : 'medium',
                title: `${pidTitles?.get(pid) || `题目 ${pid}`}：${pct}% 学生遇到相同错误模式 (${statusLabel})`,
                evidence: {
                    affectedStudents: Array.from(uids),
                    affectedProblems: [pid],
                    metrics: {
                        affectedCount: uids.size,
                        totalStudents,
                        percentage: pct,
                    },
                    samples: sampleRecord?.code ? { code: [sampleRecord.code.slice(0, 500)] } : undefined,
                },
                needsDeepDive: true,
            });
        }
    }
    return findings;
}
//# sourceMappingURL=errorClusterAnalyzer.js.map