"use strict";
/**
 * TeachingAnalysisService - 教学分析服务（数据聚合 + 规则引擎）
 *
 * Layer 1: 从 MongoDB 聚合作业相关数据（提交记录、AI 对话、越狱日志）
 * Layer 2: 跨 8 个维度分析数据，产出 TeachingFinding[]
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeachingAnalysisService = void 0;
const errorClusterAnalyzer_1 = require("./analyzers/errorClusterAnalyzer");
const temporalPatternAnalyzer_1 = require("./analyzers/temporalPatternAnalyzer");
const correlationAnalyzer_1 = require("./analyzers/correlationAnalyzer");
const classSizeStrategy_1 = require("./analyzers/classSizeStrategy");
const codeSelectionService_1 = require("./analyzers/codeSelectionService");
// ─── Constants ───────────────────────────────────────────────────────────────
const MIN_AFFECTED = 5;
/** HydroOJ record status codes (from batchSummaryService.ts STATUS_MAP) */
const STATUS = {
    AC: 1,
    WA: 2,
    TLE: 3,
    MLE: 4,
    OLE: 5,
    RE: 6,
    CE: 7,
};
const STATUS_LABEL = {
    [STATUS.AC]: 'AC',
    [STATUS.WA]: 'WA',
    [STATUS.TLE]: 'TLE',
    [STATUS.MLE]: 'MLE',
    [STATUS.RE]: 'RE',
    [STATUS.CE]: 'CE',
};
// ─── Service ─────────────────────────────────────────────────────────────────
class TeachingAnalysisService {
    constructor(db) {
        this.db = db;
        this.findingCounter = 0;
        this.effectiveMinAffected = MIN_AFFECTED;
    }
    /**
     * 主入口：聚合数据并运行规则引擎
     */
    async analyze(input) {
        console.log('[TeachingAnalysis] Starting analysis for domain=%s, pids=%j, students=%d', input.domainId, input.pids, input.studentUids.length);
        this.findingCounter = 0;
        // Layer 1: Data Aggregation (all independent queries in parallel)
        const [records, conversations, jailbreakLogs, clusteringRecords] = await Promise.all([
            this.fetchRecords(input),
            this.fetchConversations(input),
            this.fetchJailbreakLogs(input),
            this.fetchRecordsForClustering(input),
        ]);
        // Fetch messages using conversation IDs from above (avoids duplicate query)
        const convIds = conversations.map((c) => c._id);
        const messages = convIds.length > 0
            ? await this.db.collection('ai_messages').find({
                conversationId: { $in: convIds },
            }).toArray()
            : [];
        console.log('[TeachingAnalysis] Aggregated: records=%d, conversations=%d, messages=%d, jailbreakLogs=%d, clusteringRecords=%d', records.length, conversations.length, messages.length, jailbreakLogs.length, clusteringRecords.length);
        // Build lookup structures
        const recordsByPidUid = this.groupRecordsByPidUid(records);
        const conversationsByUser = this.groupByField(conversations, 'userId');
        const messagesByConversation = this.groupByField(messages, 'conversationId');
        const jailbreaksByUser = this.groupByField(jailbreakLogs, 'userId');
        // AI users = students who have at least one conversation
        const aiUserUids = new Set(conversations.map((c) => c.userId));
        // Participated = students with at least one submission
        const participatedUids = new Set(records.map((r) => r.uid));
        const stats = {
            totalStudents: input.studentUids.length,
            participatedStudents: participatedUids.size,
            aiUserCount: aiUserUids.size,
            problemCount: input.pids.length,
        };
        // Class size strategy
        const strategy = (0, classSizeStrategy_1.getClassSizeStrategy)(stats.participatedStudents, aiUserUids.size);
        this.effectiveMinAffected = strategy.minAffected;
        console.log('[TeachingAnalysis] Class size strategy: %s (students=%d, minAffected=%d)', strategy.label, stats.participatedStudents, strategy.minAffected);
        // Layer 2: Rule Engine - run all 8 dimensions
        const findings = [];
        const dimensionResults = [
            this.analyzeCommonError(input, recordsByPidUid),
            this.analyzeComprehension(input, conversationsByUser, messagesByConversation, aiUserUids),
            this.analyzeStrategy(input, jailbreaksByUser, conversationsByUser, aiUserUids),
            this.analyzeAtRisk(input, recordsByPidUid),
            this.analyzeDifficulty(input, recordsByPidUid),
            this.analyzeProgress(input, recordsByPidUid),
            this.analyzeCognitivePath(input, recordsByPidUid, aiUserUids),
            this.analyzeAiEffectiveness(input, recordsByPidUid, aiUserUids),
        ];
        for (const results of dimensionResults) {
            for (const f of results) {
                if (f)
                    findings.push(f);
            }
        }
        // Error clustering dimension (uses separate query data)
        const errorClusterFindings = (0, errorClusterAnalyzer_1.analyzeErrorClusters)(clusteringRecords, input.pids, input.studentUids.length, input.pidTitles);
        for (const f of errorClusterFindings) {
            if (f)
                findings.push(f);
        }
        // Build conversationsByUserPid for temporal pattern analyzer
        const conversationsByUserPid = new Map();
        for (const c of conversations) {
            conversationsByUserPid.set(`${c.userId}:${c.problemId}`, true);
        }
        // Temporal pattern analysis
        const temporalProfiles = [];
        const temporalFindings = (0, temporalPatternAnalyzer_1.analyzeTemporalPatterns)(records, input.pids, input.studentUids, conversationsByUserPid, input.contestStartTime, input.contestEndTime, temporalProfiles);
        for (const f of temporalFindings) {
            if (f)
                findings.push(f);
        }
        // Cross-dimensional correlations
        const correlationFindings = (0, correlationAnalyzer_1.analyzeCorrelations)(findings, temporalProfiles, input.studentUids.length, aiUserUids, recordsByPidUid);
        for (const f of correlationFindings) {
            findings.push(f);
        }
        // Filter out findings from disabled dimensions
        const filteredFindings = findings.filter(f => !strategy.disabledDimensions.includes(f.dimension));
        // Fill-in exercise candidates
        const fillInCandidates = [];
        const errorFindings = filteredFindings.filter(f => f.dimension === 'commonError' || f.dimension === 'errorCluster');
        const errorPidSet = new Set(errorFindings.flatMap(f => f.evidence.affectedProblems));
        const fillInPids = [];
        for (const pid of input.pids) {
            if (!errorPidSet.has(pid))
                continue;
            let attempted = 0, firstAC = 0, totalAC = 0, totalSubs = 0;
            for (const uid of input.studentUids) {
                const recs = recordsByPidUid.get(`${pid}:${uid}`) || [];
                if (recs.length === 0)
                    continue;
                attempted++;
                totalSubs += recs.length;
                if (recs.some(r => r.status === 1))
                    totalAC++;
                if (recs[0].status === 1)
                    firstAC++;
            }
            if (attempted === 0)
                continue;
            const trigger = (0, codeSelectionService_1.shouldGenerateFillIn)({
                hasCommonError: true,
                finalACRate: totalAC / attempted,
                firstAttemptACRate: firstAC / attempted,
                avgSubmissionCount: totalSubs / attempted,
            });
            if (trigger)
                fillInPids.push(pid);
        }
        if (fillInPids.length > 0) {
            const acRecords = await this.fetchACSubmissions(input, fillInPids);
            const acByPid = new Map();
            for (const r of acRecords) {
                if (!r.code)
                    continue;
                if (!acByPid.has(r.pid))
                    acByPid.set(r.pid, []);
                acByPid.get(r.pid).push({
                    uid: r.uid, code: r.code, lang: r.lang || 'unknown', score: 0,
                });
            }
            for (const pid of fillInPids) {
                const submissions = acByPid.get(pid) || [];
                const candidates = (0, codeSelectionService_1.selectACCode)(submissions);
                if (candidates.length === 0)
                    continue;
                const title = input.pidTitles?.get(pid) || `题目 ${pid}`;
                const primary = candidates[0];
                fillInCandidates.push({
                    pid, title, lang: primary.lang,
                    reason: '', code: primary.code, blanks: [],
                    alternatives: candidates.slice(1).map(c => ({
                        uid: c.uid, code: c.code, score: c.score,
                    })),
                });
            }
        }
        console.log('[TeachingAnalysis] Completed: %d findings generated', filteredFindings.length);
        return {
            stats,
            findings: filteredFindings,
            temporalProfiles,
            fillInCandidates,
            classSizeLabel: strategy.label,
        };
    }
    // ─── Layer 1: Data Fetching ──────────────────────────────────────────────
    async fetchRecords(input) {
        const filter = {
            domainId: input.domainId,
            pid: { $in: input.pids },
            uid: { $in: input.studentUids },
        };
        if (input.contestStartTime || input.contestEndTime) {
            filter.judgeAt = {};
            if (input.contestStartTime)
                filter.judgeAt.$gte = input.contestStartTime;
            if (input.contestEndTime)
                filter.judgeAt.$lte = input.contestEndTime;
        }
        return this.db.collection('record').find(filter).sort({ judgeAt: 1 }).toArray();
    }
    async fetchConversations(input) {
        const pidStrings = input.pids.map(String);
        const filter = {
            domainId: input.domainId,
            userId: { $in: input.studentUids },
            problemId: { $in: pidStrings },
        };
        return this.db.collection('ai_conversations').find(filter).toArray();
    }
    /**
     * Fetch non-AC records with testCases and compilerTexts for error clustering.
     * Separate query to avoid loading heavy fields for all dimensions.
     * Records are sorted by judgeAt ascending (required by errorClusterAnalyzer).
     */
    async fetchRecordsForClustering(input) {
        const matchStage = {
            domainId: input.domainId,
            pid: { $in: input.pids },
            uid: { $in: input.studentUids },
            status: { $ne: 1 },
        };
        if (input.contestStartTime || input.contestEndTime) {
            matchStage.judgeAt = {};
            if (input.contestStartTime)
                matchStage.judgeAt.$gte = input.contestStartTime;
            if (input.contestEndTime)
                matchStage.judgeAt.$lte = input.contestEndTime;
        }
        return this.db.collection('record').aggregate([
            { $match: matchStage },
            { $project: {
                    pid: 1, uid: 1, status: 1, judgeAt: 1,
                    testCases: { $slice: ['$testCases', 80] },
                    compilerTexts: { $slice: ['$compilerTexts', -3] },
                    code: 1,
                } },
            { $sort: { judgeAt: 1 } },
        ]).toArray();
    }
    async fetchACSubmissions(input, pids) {
        if (pids.length === 0)
            return [];
        const matchStage = {
            domainId: input.domainId,
            pid: { $in: pids },
            uid: { $in: input.studentUids },
            status: 1,
        };
        if (input.contestStartTime || input.contestEndTime) {
            matchStage.judgeAt = {};
            if (input.contestStartTime)
                matchStage.judgeAt.$gte = input.contestStartTime;
            if (input.contestEndTime)
                matchStage.judgeAt.$lte = input.contestEndTime;
        }
        return this.db.collection('record').aggregate([
            { $match: matchStage },
            { $project: { pid: 1, uid: 1, code: 1, lang: 1 } },
            { $sort: { judgeAt: -1 } },
        ]).toArray();
    }
    async fetchJailbreakLogs(input) {
        const filter = {
            userId: { $in: input.studentUids },
        };
        if (input.contestStartTime || input.contestEndTime) {
            filter.createdAt = {};
            if (input.contestStartTime)
                filter.createdAt.$gte = input.contestStartTime;
            if (input.contestEndTime)
                filter.createdAt.$lte = input.contestEndTime;
        }
        return this.db.collection('ai_jailbreak_logs').find(filter).toArray();
    }
    // ─── Helpers ─────────────────────────────────────────────────────────────
    groupRecordsByPidUid(records) {
        const map = new Map();
        for (const r of records) {
            const key = `${r.pid}:${r.uid}`;
            if (!map.has(key))
                map.set(key, []);
            map.get(key).push(r);
        }
        return map;
    }
    groupByField(items, field) {
        const map = new Map();
        for (const item of items) {
            const key = item[field];
            if (key === undefined || key === null)
                continue;
            const keyStr = String(key);
            if (!map.has(keyStr))
                map.set(keyStr, []);
            map.get(keyStr).push(item);
        }
        return map;
    }
    /** Resolve pid to title using pidTitles mapping, fallback to numeric ID */
    pidLabel(pid, input) {
        const title = input.pidTitles?.get(pid);
        return title ? `${title} (${pid})` : `题目 ${pid}`;
    }
    /**
     * 创建 Finding，若受影响学生数 < MIN_AFFECTED 则返回 null
     */
    makeFinding(dimension, severity, title, affectedStudents, affectedProblems, metrics, needsDeepDive, samples) {
        if (affectedStudents.length < this.effectiveMinAffected)
            return null;
        this.findingCounter++;
        return {
            id: `finding_${dimension}_${this.findingCounter}`,
            dimension,
            severity,
            title,
            evidence: {
                affectedStudents,
                affectedProblems,
                metrics,
                ...(samples ? { samples } : {}),
            },
            needsDeepDive,
        };
    }
    // ─── Layer 2: Dimension Analyzers ────────────────────────────────────────
    /**
     * Dim A: commonError — 同一题目上相同非 AC 状态 >30% 的学生，最少 5 人
     */
    analyzeCommonError(input, recordsByPidUid) {
        const findings = [];
        for (const pid of input.pids) {
            // Count students by their most frequent non-AC status on this problem
            const statusStudents = new Map();
            for (const uid of input.studentUids) {
                const key = `${pid}:${uid}`;
                const recs = recordsByPidUid.get(key) || [];
                // Count non-AC statuses for this student on this problem
                const statusCounts = new Map();
                for (const r of recs) {
                    if (r.status !== STATUS.AC) {
                        statusCounts.set(r.status, (statusCounts.get(r.status) || 0) + 1);
                    }
                }
                // Record each non-AC status this student encountered
                for (const status of statusCounts.keys()) {
                    if (!statusStudents.has(status))
                        statusStudents.set(status, new Set());
                    statusStudents.get(status).add(uid);
                }
            }
            const threshold = Math.max(MIN_AFFECTED, Math.ceil(input.studentUids.length * 0.3));
            for (const [status, uids] of statusStudents.entries()) {
                if (uids.size >= threshold) {
                    const label = STATUS_LABEL[status] || `Status_${status}`;
                    const pct = Math.round((uids.size / input.studentUids.length) * 100);
                    const finding = this.makeFinding('commonError', uids.size >= input.studentUids.length * 0.5 ? 'high' : 'medium', `${this.pidLabel(pid, input)}：${pct}% 学生遇到 ${label} 错误`, Array.from(uids), [pid], { affectedCount: uids.size, totalStudents: input.studentUids.length, percentage: pct }, true);
                    findings.push(finding);
                }
            }
        }
        return findings;
    }
    /**
     * Dim B: comprehension — understand/clarify 问题类型占学生消息 >40%
     */
    analyzeComprehension(input, conversationsByUser, messagesByConversation, aiUserUids) {
        const comprehensionStudents = [];
        let totalStudentMsgs = 0;
        let comprehensionMsgs = 0;
        for (const uid of input.studentUids) {
            if (!aiUserUids.has(uid))
                continue;
            const convs = conversationsByUser.get(String(uid)) || [];
            let userComprehensionCount = 0;
            let userTotalStudentMsgs = 0;
            for (const conv of convs) {
                const msgs = messagesByConversation.get(String(conv._id)) || [];
                for (const msg of msgs) {
                    if (msg.role === 'student') {
                        userTotalStudentMsgs++;
                        if (msg.questionType === 'understand' || msg.questionType === 'clarify') {
                            userComprehensionCount++;
                        }
                    }
                }
            }
            totalStudentMsgs += userTotalStudentMsgs;
            comprehensionMsgs += userComprehensionCount;
            if (userTotalStudentMsgs > 0 && userComprehensionCount / userTotalStudentMsgs > 0.4) {
                comprehensionStudents.push(uid);
            }
        }
        const pct = totalStudentMsgs > 0 ? Math.round((comprehensionMsgs / totalStudentMsgs) * 100) : 0;
        const finding = this.makeFinding('comprehension', pct > 60 ? 'high' : 'medium', `${comprehensionStudents.length} 名学生以理解/澄清类提问为主（基于 ${aiUserUids.size} 名 AI 用户数据）`, comprehensionStudents, input.pids, { comprehensionPct: pct, aiUserCount: aiUserUids.size }, true);
        return [finding];
    }
    /**
     * Dim C: strategy — 越狱日志 + 高频 AI 使用
     */
    analyzeStrategy(input, jailbreaksByUser, conversationsByUser, aiUserUids) {
        const findings = [];
        // Sub-dimension: jailbreak attempts
        const jailbreakStudents = [];
        let totalJailbreaks = 0;
        for (const uid of input.studentUids) {
            const logs = jailbreaksByUser.get(String(uid)) || [];
            if (logs.length > 0) {
                jailbreakStudents.push(uid);
                totalJailbreaks += logs.length;
            }
        }
        if (jailbreakStudents.length > 0) {
            findings.push(this.makeFinding('strategy', jailbreakStudents.length >= 10 ? 'high' : 'medium', `${jailbreakStudents.length} 名学生尝试越狱（共 ${totalJailbreaks} 次，基于 ${aiUserUids.size} 名 AI 用户数据）`, jailbreakStudents, input.pids, { jailbreakStudentCount: jailbreakStudents.length, totalJailbreaks, aiUserCount: aiUserUids.size }, true));
        }
        // Sub-dimension: top 10% AI usage frequency
        if (aiUserUids.size >= MIN_AFFECTED) {
            const usageCounts = [];
            for (const uid of aiUserUids) {
                const convs = conversationsByUser.get(String(uid)) || [];
                usageCounts.push({ uid, count: convs.length });
            }
            usageCounts.sort((a, b) => b.count - a.count);
            const top10Idx = Math.max(1, Math.ceil(usageCounts.length * 0.1));
            const threshold = usageCounts[top10Idx - 1]?.count ?? 0;
            const heavyUsers = usageCounts.filter((u) => u.count >= threshold && u.count > 1).map((u) => u.uid);
            if (heavyUsers.length >= MIN_AFFECTED) {
                findings.push(this.makeFinding('strategy', 'low', `${heavyUsers.length} 名学生 AI 使用频率显著偏高（基于 ${aiUserUids.size} 名 AI 用户数据）`, heavyUsers, input.pids, { heavyUserCount: heavyUsers.length, threshold, aiUserCount: aiUserUids.size }, false));
            }
        }
        return findings;
    }
    /**
     * Dim D: atRisk — 学生放弃了 ≥70% 的题目（未 AC）
     */
    analyzeAtRisk(input, recordsByPidUid) {
        const atRiskStudents = [];
        for (const uid of input.studentUids) {
            let notAcCount = 0;
            for (const pid of input.pids) {
                const key = `${pid}:${uid}`;
                const recs = recordsByPidUid.get(key) || [];
                const hasAC = recs.some((r) => r.status === STATUS.AC);
                if (!hasAC)
                    notAcCount++;
            }
            if (input.pids.length > 0 && notAcCount / input.pids.length >= 0.7) {
                atRiskStudents.push(uid);
            }
        }
        const pct = input.studentUids.length > 0
            ? Math.round((atRiskStudents.length / input.studentUids.length) * 100) : 0;
        const finding = this.makeFinding('atRisk', atRiskStudents.length >= input.studentUids.length * 0.3 ? 'high' : 'medium', `${atRiskStudents.length} 名学生在 ≥70% 的题目上未通过（占比 ${pct}%）`, atRiskStudents, input.pids, { atRiskCount: atRiskStudents.length, percentage: pct }, true);
        return [finding];
    }
    /**
     * Dim E: difficulty — 单题通过率 <20%（至少 5 人尝试）
     */
    analyzeDifficulty(input, recordsByPidUid) {
        const findings = [];
        for (const pid of input.pids) {
            let attemptedCount = 0;
            let acCount = 0;
            const failedStudents = [];
            for (const uid of input.studentUids) {
                const key = `${pid}:${uid}`;
                const recs = recordsByPidUid.get(key) || [];
                if (recs.length === 0)
                    continue;
                attemptedCount++;
                const hasAC = recs.some((r) => r.status === STATUS.AC);
                if (hasAC) {
                    acCount++;
                }
                else {
                    failedStudents.push(uid);
                }
            }
            if (attemptedCount < MIN_AFFECTED)
                continue;
            const passRate = attemptedCount > 0 ? acCount / attemptedCount : 0;
            if (passRate < 0.2) {
                const pct = Math.round(passRate * 100);
                findings.push(this.makeFinding('difficulty', passRate < 0.1 ? 'high' : 'medium', `${this.pidLabel(pid, input)} 通过率极低（${pct}%，${acCount}/${attemptedCount}）`, failedStudents, [pid], { passRate: pct, attempted: attemptedCount, accepted: acCount }, true));
            }
        }
        return findings;
    }
    /**
     * Dim F: progress — AC 了所有题目的学生
     */
    analyzeProgress(input, recordsByPidUid) {
        if (input.pids.length === 0)
            return [];
        const allAcStudents = [];
        for (const uid of input.studentUids) {
            let allAc = true;
            for (const pid of input.pids) {
                const key = `${pid}:${uid}`;
                const recs = recordsByPidUid.get(key) || [];
                if (!recs.some((r) => r.status === STATUS.AC)) {
                    allAc = false;
                    break;
                }
            }
            if (allAc)
                allAcStudents.push(uid);
        }
        const pct = input.studentUids.length > 0
            ? Math.round((allAcStudents.length / input.studentUids.length) * 100) : 0;
        const finding = this.makeFinding('progress', 'low', `${allAcStudents.length} 名学生完成了全部 ${input.pids.length} 道题目（${pct}%）`, allAcStudents, input.pids, { completedCount: allAcStudents.length, percentage: pct }, false);
        return [finding];
    }
    /**
     * Dim G: cognitivePath — 暴力猜测模式（≥8 次提交，无 AC，无 AI 使用）
     */
    analyzeCognitivePath(input, recordsByPidUid, aiUserUids) {
        const bruteForceStudents = new Set();
        const affectedProblems = new Set();
        for (const pid of input.pids) {
            for (const uid of input.studentUids) {
                if (aiUserUids.has(uid))
                    continue; // skip AI users
                const key = `${pid}:${uid}`;
                const recs = recordsByPidUid.get(key) || [];
                const hasAC = recs.some((r) => r.status === STATUS.AC);
                if (recs.length >= 8 && !hasAC) {
                    bruteForceStudents.add(uid);
                    affectedProblems.add(pid);
                }
            }
        }
        const finding = this.makeFinding('cognitivePath', bruteForceStudents.size >= 10 ? 'high' : 'medium', `${bruteForceStudents.size} 名学生存在暴力猜测模式（大量提交但未通过且未使用 AI）`, Array.from(bruteForceStudents), Array.from(affectedProblems), { bruteForceCount: bruteForceStudents.size }, true);
        return [finding];
    }
    /**
     * Dim H: aiEffectiveness — 比较 AI 用户与非 AI 用户的通过率
     */
    analyzeAiEffectiveness(input, recordsByPidUid, aiUserUids) {
        if (aiUserUids.size === 0 || input.pids.length === 0)
            return [];
        let aiAcTotal = 0;
        let aiAttemptTotal = 0;
        let nonAiAcTotal = 0;
        let nonAiAttemptTotal = 0;
        const aiStudents = [];
        const nonAiStudents = [];
        for (const uid of input.studentUids) {
            const isAiUser = aiUserUids.has(uid);
            let userAc = 0;
            let userAttempted = 0;
            for (const pid of input.pids) {
                const key = `${pid}:${uid}`;
                const recs = recordsByPidUid.get(key) || [];
                if (recs.length === 0)
                    continue;
                userAttempted++;
                if (recs.some((r) => r.status === STATUS.AC))
                    userAc++;
            }
            if (userAttempted === 0)
                continue;
            if (isAiUser) {
                aiAcTotal += userAc;
                aiAttemptTotal += userAttempted;
                aiStudents.push(uid);
            }
            else {
                nonAiAcTotal += userAc;
                nonAiAttemptTotal += userAttempted;
                nonAiStudents.push(uid);
            }
        }
        if (aiStudents.length < MIN_AFFECTED || nonAiStudents.length < MIN_AFFECTED)
            return [];
        const aiPassRate = aiAttemptTotal > 0 ? aiAcTotal / aiAttemptTotal : 0;
        const nonAiPassRate = nonAiAttemptTotal > 0 ? nonAiAcTotal / nonAiAttemptTotal : 0;
        const diff = Math.round((aiPassRate - nonAiPassRate) * 100);
        const allStudents = [...aiStudents, ...nonAiStudents];
        const severity = Math.abs(diff) >= 20 ? 'high' : Math.abs(diff) >= 10 ? 'medium' : 'low';
        const direction = diff > 0 ? '高于' : diff < 0 ? '低于' : '持平';
        const finding = this.makeFinding('aiEffectiveness', severity, `AI 用户通过率${direction}非 AI 用户 ${Math.abs(diff)} 个百分点（${Math.round(aiPassRate * 100)}% vs ${Math.round(nonAiPassRate * 100)}%）`, allStudents, input.pids, {
            aiPassRate: Math.round(aiPassRate * 100),
            nonAiPassRate: Math.round(nonAiPassRate * 100),
            diff,
            aiUserCount: aiStudents.length,
            nonAiUserCount: nonAiStudents.length,
        }, Math.abs(diff) >= 15);
        return [finding];
    }
}
exports.TeachingAnalysisService = TeachingAnalysisService;
//# sourceMappingURL=teachingAnalysisService.js.map