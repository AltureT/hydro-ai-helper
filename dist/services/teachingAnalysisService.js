"use strict";
/**
 * TeachingAnalysisService - 教学分析服务（数据聚合 + 规则引擎）
 *
 * Layer 1: 从 MongoDB 聚合作业相关数据（提交记录、AI 对话、越狱日志）
 * Layer 2: 跨 8 个维度分析数据，产出 TeachingFinding[]
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeachingAnalysisService = void 0;
const ensureObjectId_1 = require("../utils/ensureObjectId");
const errorClusterAnalyzer_1 = require("./analyzers/errorClusterAnalyzer");
const submissionEvidence_1 = require("./analyzers/submissionEvidence");
const recordWindow_1 = require("./analyzers/recordWindow");
const temporalPatternAnalyzer_1 = require("./analyzers/temporalPatternAnalyzer");
const correlationAnalyzer_1 = require("./analyzers/correlationAnalyzer");
const findingConsolidator_1 = require("./analyzers/findingConsolidator");
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
        input = { ...input, dataSnapshotAt: input.dataSnapshotAt ?? new Date() };
        console.log('[TeachingAnalysis] Starting analysis for domain=%s, pids=%j, students=%d', input.domainId, input.pids, input.studentUids.length);
        this.findingCounter = 0;
        // Layer 1: Data Aggregation (all independent queries in parallel)
        const [records, candidateConversations, jailbreakLogs] = await Promise.all([
            this.fetchRecords(input),
            this.fetchConversations(input),
            this.fetchJailbreakLogs(input),
        ]);
        // Fetch messages using conversation IDs from above (avoids duplicate query)
        const convIds = candidateConversations.map((c) => c._id);
        const messages = convIds.length > 0
            ? await this.db.collection('ai_messages').find({
                conversationId: { $in: convIds },
                timestamp: {
                    ...(input.contestStartTime ? { $gte: input.contestStartTime } : {}),
                    $lt: (0, recordWindow_1.recordWindow)(input.dataSnapshotAt, undefined, input.contestEndTime).$lt.getTimestamp(),
                },
            }).toArray()
            : [];
        // A conversation may span assignments. Only actual student messages in the
        // observation window establish AI usage for this report.
        const activeConversationIds = new Set(messages.filter(m => m.role === 'student').map(m => String(m.conversationId)));
        const conversations = candidateConversations.filter(c => activeConversationIds.has(String(c._id)));
        console.log('[TeachingAnalysis] Aggregated: records=%d, conversations=%d, messages=%d, jailbreakLogs=%d, clusteringRecords=%d', records.length, conversations.length, messages.length, jailbreakLogs.length, records.length);
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
        const errorClusterFindings = (0, errorClusterAnalyzer_1.analyzeErrorClusters)(records, input.pids, input.studentUids.length, input.pidTitles);
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
        const correlationFindings = (0, correlationAnalyzer_1.analyzeCorrelations)(findings.filter(f => !strategy.disabledDimensions.includes(f.dimension)), temporalProfiles, input.studentUids.length, aiUserUids, recordsByPidUid);
        for (const f of correlationFindings) {
            findings.push(f);
        }
        // Filter out findings from disabled dimensions, then consolidate:
        // merge duplicate error findings, fold cross-correlations into hosts,
        // rank by severity/impact and mark overflow as secondary
        const filteredFindings = (0, findingConsolidator_1.consolidateFindings)(findings.filter(f => !strategy.disabledDimensions.includes(f.dimension)));
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
            const acRecords = records.filter(r => r.status === STATUS.AC && fillInPids.includes(r.pid));
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
        // Hydro records explicitly carry contest membership; judgeAt is rejudge time.
        return this.db.collection('record').find({
            domainId: input.domainId,
            contest: (0, ensureObjectId_1.ensureObjectId)(input.contestId),
            _id: (0, recordWindow_1.recordWindow)(input.dataSnapshotAt, input.contestStartTime, input.contestEndTime),
            pid: { $in: input.pids },
            uid: { $in: input.studentUids },
        }).sort({ _id: 1 }).toArray();
    }
    async fetchConversations(input) {
        const canonicalIds = new Map(input.pids.map(pid => [String(pid), String(pid)]));
        for (const pid of input.pids) {
            for (const alias of input.pidAliases?.get(pid) ?? []) {
                if (!canonicalIds.has(alias))
                    canonicalIds.set(alias, String(pid));
            }
        }
        const filter = {
            domainId: input.domainId,
            userId: { $in: input.studentUids },
            problemId: { $in: [...canonicalIds.keys()] },
        };
        const conversations = await this.db.collection('ai_conversations').find(filter).toArray();
        return conversations.map(c => ({ ...c, problemId: canonicalIds.get(c.problemId) || c.problemId }));
    }
    async fetchJailbreakLogs(input) {
        const bounds = (0, recordWindow_1.recordWindow)(input.dataSnapshotAt, input.contestStartTime, input.contestEndTime);
        const filter = {
            domainId: input.domainId,
            userId: { $in: input.studentUids },
            category: { $in: ['prompt_injection', 'prompt_exfiltration', 'obfuscated_injection'] },
            reviewStatus: { $ne: 'false_positive' },
            problemId: { $in: [...new Set(input.pids.flatMap(pid => [String(pid), ...(input.pidAliases?.get(pid) ?? [])]))] },
            createdAt: { ...(bounds.$gte ? { $gte: bounds.$gte.getTimestamp() } : {}), $lt: bounds.$lt.getTimestamp() },
        };
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
            const statusStudents = new Map();
            const resolvedUids = new Set();
            const latestErrors = new Map();
            for (const uid of input.studentUids) {
                const recs = recordsByPidUid.get(`${pid}:${uid}`) || [];
                if (recs.some(r => r.status === STATUS.AC))
                    resolvedUids.add(uid);
                for (const r of recs) {
                    if (!submissionEvidence_1.ERROR_STATUSES.has(r.status))
                        continue;
                    if (!statusStudents.has(r.status))
                        statusStudents.set(r.status, new Set());
                    statusStudents.get(r.status).add(uid);
                    latestErrors.set(`${r.status}:${uid}`, r);
                }
            }
            const threshold = Math.max(MIN_AFFECTED, Math.ceil(input.studentUids.length * 0.3));
            for (const [status, uids] of statusStudents.entries()) {
                if (uids.size >= threshold) {
                    const label = STATUS_LABEL[status] || `Status_${status}`;
                    const pct = Math.round((uids.size / input.studentUids.length) * 100);
                    const resolvedCount = [...uids].filter(uid => resolvedUids.has(uid)).length;
                    const unresolvedCount = [...uids].filter(uid => {
                        const recs = recordsByPidUid.get(`${pid}:${uid}`) || [];
                        return !resolvedUids.has(uid) && submissionEvidence_1.ERROR_STATUSES.has(recs[recs.length - 1]?.status);
                    }).length;
                    const finding = this.makeFinding('commonError', unresolvedCount === 0 ? 'low' : unresolvedCount >= input.studentUids.length * 0.5 ? 'high' : 'medium', `${this.pidLabel(pid, input)}：${pct}% 学生曾出现 ${label}（${resolvedCount} 人已通过，${unresolvedCount} 人仍未通过）`, Array.from(uids), [pid], { affectedCount: uids.size, totalStudents: input.studentUids.length, percentage: pct, resolvedCount, unresolvedCount, pendingCount: uids.size - resolvedCount - unresolvedCount }, true);
                    if (finding) {
                        finding.errorStatus = status;
                        finding.evidence.samples = (0, submissionEvidence_1.errorCodeSamples)([...uids].map(uid => latestErrors.get(`${status}:${uid}`)), resolvedUids);
                    }
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
            findings.push(this.makeFinding('strategy', jailbreakStudents.length >= 10 ? 'high' : 'medium', `${jailbreakStudents.length} 名学生触发疑似越狱规则（待复核，共 ${totalJailbreaks} 次，基于 ${aiUserUids.size} 名 AI 用户数据）`, jailbreakStudents, input.pids, { jailbreakStudentCount: jailbreakStudents.length, totalJailbreaks, aiUserCount: aiUserUids.size }, true));
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
                findings.push(this.makeFinding('strategy', 'low', `${heavyUsers.length} 名学生本次 AI 对话数量处于较高分组（基于 ${aiUserUids.size} 名 AI 用户数据）`, heavyUsers, input.pids, { heavyUserCount: heavyUsers.length, threshold, aiUserCount: aiUserUids.size }, false));
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
        const finding = this.makeFinding('atRisk', atRiskStudents.length >= input.studentUids.length * 0.3 ? 'high' : 'medium', `${atRiskStudents.length} 名学生在 ≥70% 的题目上暂无通过记录（含未提交或待评测，占比 ${pct}%，需核实）`, atRiskStudents, input.pids, { atRiskCount: atRiskStudents.length, percentage: pct }, true);
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
                if (!recs.some(r => r.status === STATUS.AC) && !submissionEvidence_1.ERROR_STATUSES.has(recs[recs.length - 1].status))
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
                if (recs.filter(r => submissionEvidence_1.ERROR_STATUSES.has(r.status)).length >= 8 && !hasAC && submissionEvidence_1.ERROR_STATUSES.has(recs[recs.length - 1]?.status)) {
                    bruteForceStudents.add(uid);
                    affectedProblems.add(pid);
                }
            }
        }
        const finding = this.makeFinding('cognitivePath', bruteForceStudents.size >= 10 ? 'high' : 'medium', `${bruteForceStudents.size} 名学生多次提交仍未通过，且本次未记录 AI 对话（建议核实卡点）`, Array.from(bruteForceStudents), Array.from(affectedProblems), { bruteForceCount: bruteForceStudents.size }, true);
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
                if (!recs.some(r => r.status === STATUS.AC) && !submissionEvidence_1.ERROR_STATUSES.has(recs[recs.length - 1].status))
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
        const finding = this.makeFinding('aiEffectiveness', severity, `本次有 AI 对话组的已尝试题目通过率${direction}其他组 ${Math.abs(diff)} 个百分点（${aiAcTotal}/${aiAttemptTotal} 题次，${Math.round(aiPassRate * 100)}% vs ${nonAiAcTotal}/${nonAiAttemptTotal} 题次，${Math.round(nonAiPassRate * 100)}%）；仅为相关观察`, allStudents, input.pids, {
            aiPassRate: Math.round(aiPassRate * 100),
            nonAiPassRate: Math.round(nonAiPassRate * 100),
            diff,
            aiUserCount: aiStudents.length,
            nonAiUserCount: nonAiStudents.length,
            aiAcceptedAttempts: aiAcTotal,
            aiAttemptedPairs: aiAttemptTotal,
            nonAiAcceptedAttempts: nonAiAcTotal,
            nonAiAttemptedPairs: nonAiAttemptTotal,
        }, Math.abs(diff) >= 15);
        return [finding];
    }
}
exports.TeachingAnalysisService = TeachingAnalysisService;
//# sourceMappingURL=teachingAnalysisService.js.map