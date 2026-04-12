"use strict";
/**
 * Temporal Pattern Analyzer — classifies student submission behavior into 5 patterns
 * based on timing, burst activity, session structure, and AC outcomes.
 *
 * IMPORTANT: records must be sorted by judgeAt ascending (oldest first).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTemporalFeatures = extractTemporalFeatures;
exports.countStatusTransitions = countStatusTransitions;
exports.classifyPattern = classifyPattern;
exports.analyzeTemporalPatterns = analyzeTemporalPatterns;
// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_AC = 1;
const MIN_AFFECTED = 5;
const BURST_INTERVAL_MS = 60000; // 60s
const BURST_MIN_COUNT = 3;
const SESSION_GAP_MS = 30 * 60000; // 30 min
const STUCK_SUBMISSION_THRESHOLD = 8;
const DEFAULT_CONTEST_DURATION_MS = 24 * 60 * 60000;
const PATTERN_LABELS = {
    strategic_solver: '高效解题',
    disengaged: '未充分参与',
    burst_then_quit: '受挫放弃',
    stuck_silent: '沉默挣扎',
    persistent_learner: '持续努力',
};
// Priority for "worst" aggregation (higher = worse)
const PATTERN_PRIORITY = {
    strategic_solver: 0,
    persistent_learner: 1,
    disengaged: 2,
    burst_then_quit: 3,
    stuck_silent: 4,
};
// ── Pure helpers ──────────────────────────────────────────────────────────────
function median(values) {
    if (!values.length)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}
// ── Exported functions ────────────────────────────────────────────────────────
/**
 * Extract temporal features from a sorted sequence of records for one uid:pid pair.
 */
function extractTemporalFeatures(records, contestEndTime) {
    const n = records.length;
    if (n === 0) {
        return {
            totalSubmissions: 0,
            totalActiveMinutes: 0,
            medianInterval: null,
            burstCount: 0,
            distinctSessions: 1,
            firstACIndex: null,
            timeSinceLastSubmit: null,
        };
    }
    const timestamps = records.map(r => r.judgeAt.getTime());
    // totalActiveMinutes
    const totalActiveMinutes = n > 1
        ? (timestamps[n - 1] - timestamps[0]) / 60000
        : 0;
    // inter-submission intervals (ms)
    const intervals = [];
    for (let i = 1; i < n; i++) {
        intervals.push(timestamps[i] - timestamps[i - 1]);
    }
    // medianInterval in SECONDS
    const medianInterval = intervals.length
        ? median(intervals.map(ms => ms / 1000))
        : null;
    // burstCount: number of segments with BURST_MIN_COUNT+ consecutive submissions < BURST_INTERVAL_MS apart
    let burstCount = 0;
    let consecutiveCount = 1;
    for (let i = 0; i < intervals.length; i++) {
        if (intervals[i] < BURST_INTERVAL_MS) {
            consecutiveCount++;
            if (consecutiveCount === BURST_MIN_COUNT) {
                burstCount++;
            }
        }
        else {
            consecutiveCount = 1;
        }
    }
    // distinctSessions: 1 + count of gaps > SESSION_GAP_MS
    const distinctSessions = 1 + intervals.filter(iv => iv > SESSION_GAP_MS).length;
    // firstACIndex
    const firstACIndex = records.findIndex(r => r.status === STATUS_AC);
    // timeSinceLastSubmit
    const timeSinceLastSubmit = contestEndTime != null
        ? contestEndTime.getTime() - timestamps[n - 1]
        : null;
    return {
        totalSubmissions: n,
        totalActiveMinutes,
        medianInterval,
        burstCount,
        distinctSessions,
        firstACIndex: firstACIndex === -1 ? null : firstACIndex,
        timeSinceLastSubmit,
    };
}
/**
 * Count the number of distinct status values minus 1 (i.e. number of transitions).
 */
function countStatusTransitions(records) {
    const statuses = new Set(records.map(r => r.status));
    return Math.max(0, statuses.size - 1);
}
/**
 * Classify a student's temporal pattern for a single uid:pid pair.
 * Returns null when data is insufficient to classify.
 */
function classifyPattern(features, finalStatus, hasAIConversation, statusTransitions = 0, disengagedThreshold = 2 * 60 * 60000) {
    const hasAC = finalStatus === STATUS_AC || features.firstACIndex !== null;
    // 1. strategic_solver
    if (features.firstACIndex !== null && features.firstACIndex <= 2) {
        return 'strategic_solver';
    }
    // 2. disengaged
    if (!hasAC &&
        features.totalSubmissions <= 2 &&
        features.timeSinceLastSubmit !== null &&
        features.timeSinceLastSubmit > disengagedThreshold) {
        return 'disengaged';
    }
    // 3. burst_then_quit
    const TWO_HOURS_MS = 2 * 60 * 60000;
    if (!hasAC &&
        features.burstCount >= 1 &&
        features.timeSinceLastSubmit !== null &&
        features.timeSinceLastSubmit > TWO_HOURS_MS) {
        return 'burst_then_quit';
    }
    // 4. stuck_silent
    if (!hasAC &&
        features.totalSubmissions >= STUCK_SUBMISSION_THRESHOLD &&
        !hasAIConversation) {
        return 'stuck_silent';
    }
    // 5. persistent_learner
    if (!hasAC &&
        features.distinctSessions >= 2 &&
        statusTransitions >= 2) {
        return 'persistent_learner';
    }
    return null;
}
/**
 * Main entry point: analyze temporal patterns across all students and problems.
 */
function analyzeTemporalPatterns(records, pids, studentUids, conversationsByUserPid, contestStartTime, contestEndTime, outProfiles) {
    // Dynamic disengaged threshold
    const contestDurationMs = (contestStartTime && contestEndTime)
        ? contestEndTime.getTime() - contestStartTime.getTime()
        : DEFAULT_CONTEST_DURATION_MS;
    const disengagedThreshold = Math.max(2 * 60 * 60000, contestDurationMs * 0.5);
    // Group records by uid:pid
    const recordsByUidPid = new Map();
    for (const rec of records) {
        const key = `${rec.uid}:${rec.pid}`;
        if (!recordsByUidPid.has(key))
            recordsByUidPid.set(key, []);
        recordsByUidPid.get(key).push(rec);
    }
    // Classify each uid:pid pair, aggregate to student level
    const studentPatterns = new Map();
    for (const uid of studentUids) {
        let worstPattern = null;
        let worstPriority = -1;
        for (const pid of pids) {
            const key = `${uid}:${pid}`;
            const pidRecords = recordsByUidPid.get(key);
            if (!pidRecords || pidRecords.length === 0)
                continue;
            // Records must be sorted ascending
            const sorted = [...pidRecords].sort((a, b) => a.judgeAt.getTime() - b.judgeAt.getTime());
            const features = extractTemporalFeatures(sorted, contestEndTime);
            const finalStatus = sorted[sorted.length - 1].status;
            const hasAIConversation = conversationsByUserPid.get(key) ?? false;
            const statusTransitions = countStatusTransitions(sorted);
            const pattern = classifyPattern(features, finalStatus, hasAIConversation, statusTransitions, disengagedThreshold);
            if (pattern !== null) {
                // Push profile if collector provided
                if (outProfiles) {
                    outProfiles.push({ uid, pid, pattern, features, finalStatus });
                }
                const priority = PATTERN_PRIORITY[pattern];
                if (priority > worstPriority) {
                    worstPriority = priority;
                    worstPattern = pattern;
                }
            }
        }
        if (worstPattern !== null) {
            studentPatterns.set(uid, worstPattern);
        }
    }
    // Group students by pattern
    const patternStudents = new Map();
    for (const [uid, pattern] of studentPatterns) {
        if (!patternStudents.has(pattern))
            patternStudents.set(pattern, []);
        patternStudents.get(pattern).push(uid);
    }
    const totalStudents = studentUids.length || 1;
    const findings = [];
    let counter = 0;
    const actionablePatterns = [
        'stuck_silent',
        'burst_then_quit',
        'disengaged',
        'persistent_learner',
    ];
    for (const pattern of actionablePatterns) {
        const affected = patternStudents.get(pattern) ?? [];
        if (affected.length < MIN_AFFECTED)
            continue;
        counter++;
        const pct = Math.round((affected.length / totalStudents) * 100);
        const label = PATTERN_LABELS[pattern];
        const confidence = affected.length >= 15 ? 'high' : 'low';
        const needsDeepDive = pattern === 'stuck_silent' || pattern === 'burst_then_quit';
        const severity = pattern === 'stuck_silent' || pattern === 'burst_then_quit' ? 'high' : 'medium';
        findings.push({
            id: `finding_temporalPattern_${counter}`,
            dimension: 'temporalPattern',
            severity,
            title: `${affected.length} 名学生呈现"${label}"行为模式（${pct}%）`,
            evidence: {
                affectedStudents: affected,
                affectedProblems: pids,
                metrics: {
                    affectedCount: affected.length,
                    totalStudents,
                    percentage: pct,
                },
            },
            needsDeepDive,
            confidence,
        });
    }
    return findings;
}
//# sourceMappingURL=temporalPatternAnalyzer.js.map