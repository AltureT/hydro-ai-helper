"use strict";
/**
 * AI 定期抽查（US7，plan R9、R10、R15）
 *
 * 一个批次：熔断检查 → 选出候选（存入批次文档，可断点续跑）→ 逐个会话调用审核模型（并发 2）
 * → 解析与证据核对 → 违规且置信度为中或高时写安全记录（来源 ai_review）→ 满足 FR-044 时自动扣信誉。
 * 审核模型不可用时整批跳过；连续 3 次调用失败时中止，不产生后续处罚（FR-048）。
 * token 与费用只累计在批次文档中，不写入 ai_token_usage，因此不计入任何学生（FR-049）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIReviewService = exports.REVIEW_LOOKBACK_MS = exports.REVIEW_MAX_COMPLETION_TOKENS = exports.REVIEW_MAX_CONSECUTIVE_MODEL_FAILURES = exports.REVIEW_CONCURRENCY = void 0;
const mongo_1 = require("../utils/mongo");
const configSections_1 = require("../models/configSections");
const hydroGroupService_1 = require("./hydroGroupService");
const aiReviewEvidence_1 = require("./aiReviewEvidence");
const aiReviewCandidates_1 = require("./aiReviewCandidates");
const aiReviewPenalty_1 = require("./aiReviewPenalty");
const timezone_1 = require("../utils/timezone");
exports.REVIEW_CONCURRENCY = 2;
exports.REVIEW_MAX_CONSECUTIVE_MODEL_FAILURES = 3;
exports.REVIEW_MAX_COMPLETION_TOKENS = 800;
exports.REVIEW_LOOKBACK_MS = 24 * 60 * 60 * 1000;
class AIReviewService {
    constructor(deps) {
        this.deps = deps;
        this.clock = deps.clock || (() => new Date());
        this.conversations = deps.db.collection('ai_conversations');
        this.candidateSources = deps.candidateSources || this.mongoCandidateSources();
    }
    async configs() {
        const cfg = await this.deps.configModel.getConfig();
        const quota = (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig);
        return { review: (0, configSections_1.normalizeAIReviewConfig)(cfg?.aiReviewConfig), timezone: quota.timezone, weights: quota.credit.weights };
    }
    // ─── 批次 ───────────────────────────────────────────────
    /** 每日批次：当天已有批次（其他进程负责）时返回 null */
    async startDaily(owner) {
        const { timezone } = await this.configs();
        const now = this.clock();
        const date = (0, timezone_1.dateKey)(timezone, now);
        const id = `daily:${date}`;
        const created = await this.deps.runs.tryCreate({ id, trigger: 'schedule', owner, now, date });
        return created ? id : null;
    }
    /** 手动触发（FR-040）：有批次正在运行时拒绝，避免同一会话被并发处罚 */
    async startManual(owner, actorUid, scope, scopeLabel) {
        const now = this.clock();
        if (await this.deps.runs.hasActiveRun(now)) {
            throw new hydroGroupService_1.GroupServiceError('REVIEW_RUNNING', 409, 'ai_helper_review_err_running');
        }
        const id = `manual:${new mongo_1.ObjectId().toHexString()}`;
        await this.deps.runs.tryCreate({
            id, trigger: 'manual', owner, now, requestedBy: actorUid,
            ...(scope ? { scope } : {}),
            ...(scopeLabel ? { scopeLabel } : {}),
        });
        return id;
    }
    /**
     * 执行（或续跑）一个批次。`active()` 返回 false 表示租约已丢失，立即停止且不再写结果。
     */
    async execute(runId, owner, active = () => true) {
        const run = await this.deps.runs.get(runId);
        if (!run || run.status !== 'running' || run.leaseOwner !== owner)
            return null;
        const { review } = await this.configs();
        try {
            await this.checkBreaker();
        }
        catch (err) {
            console.warn('[AIReview] 熔断检查失败:', err instanceof Error ? err.message : err);
        }
        let candidates = run.candidates;
        if (!candidates) {
            const now = this.clock();
            candidates = run.scope && (run.scope.uids?.length || run.scope.conversationIds?.length)
                ? await (0, aiReviewCandidates_1.selectManualCandidates)(this.candidateSources, run.scope, now, review.maxConversations)
                : await (0, aiReviewCandidates_1.selectCandidates)(this.candidateSources, {
                    since: new Date(now.getTime() - exports.REVIEW_LOOKBACK_MS),
                    sampleRate: review.sampleRate,
                    max: review.maxConversations,
                });
            if (!active() || !(await this.deps.runs.setCandidates(runId, owner, candidates)))
                return null;
        }
        const processed = new Set(run.processedIds);
        const pending = candidates.filter((candidate) => !processed.has(String(candidate.conversationId)));
        if (!pending.length) {
            await this.deps.runs.finish(runId, owner, 'completed', this.clock());
            return 'completed';
        }
        let client;
        try {
            client = await this.deps.createClient();
        }
        catch (err) {
            console.warn('[AIReview] 审核模型不可用，本次跳过:', err instanceof Error ? err.message : err);
            await this.deps.runs.finish(runId, owner, 'skipped', this.clock(), 'model_unavailable');
            return 'skipped';
        }
        let consecutiveFailures = 0;
        let aborted = false;
        let leaseLost = false;
        // 同一学生的会话由同一个 worker 依次处理：“当天只处罚一次”的检查不会因并发而失效（FR-044）
        const byUser = new Map();
        for (const candidate of pending) {
            const list = byUser.get(candidate.userId);
            if (list)
                list.push(candidate);
            else
                byUser.set(candidate.userId, [candidate]);
        }
        const groups = [...byUser.values()];
        let cursor = 0;
        const worker = async () => {
            while (!aborted && !leaseLost && cursor < groups.length) {
                const group = groups[cursor++];
                for (const candidate of group) {
                    if (aborted || leaseLost)
                        return;
                    if (!active()) {
                        leaseLost = true;
                        return;
                    }
                    const outcome = await this.reviewConversation(runId, candidate, client).catch((err) => {
                        console.error('[AIReview] 处理会话失败:', err instanceof Error ? err.message : err);
                        return { failed: 1 };
                    });
                    if (outcome.modelFailure) {
                        consecutiveFailures += 1;
                        if (consecutiveFailures >= exports.REVIEW_MAX_CONSECUTIVE_MODEL_FAILURES)
                            aborted = true;
                    }
                    else {
                        consecutiveFailures = 0;
                    }
                    if (!active()) {
                        leaseLost = true;
                        return;
                    }
                    const recorded = await this.deps.runs.markProcessed(runId, owner, String(candidate.conversationId), outcome);
                    if (!recorded) {
                        const latest = await this.deps.runs.get(runId);
                        if (!latest || latest.status !== 'running' || latest.leaseOwner !== owner) {
                            leaseLost = true;
                            return;
                        }
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(exports.REVIEW_CONCURRENCY, groups.length) }, worker));
        if (leaseLost)
            return null;
        const status = aborted ? 'failed' : 'completed';
        await this.deps.runs.finish(runId, owner, status, this.clock(), aborted ? 'model_failed' : undefined);
        return status;
    }
    // ─── 单个会话 ───────────────────────────────────────────
    async reviewConversation(runId, candidate, client) {
        const conversation = await this.conversations.findOne({ _id: candidate.conversationId });
        if (!conversation)
            return {};
        const stored = await this.deps.messages.findByConversationId(conversation._id);
        const messages = stored.map((message) => ({
            id: String(message._id),
            role: message.role === 'student' ? 'student' : 'ai',
            content: message.content || '',
            ...(message.role === 'student' && message.metadata?.codeContent ? { code: message.metadata.codeContent } : {}),
            timestamp: message.timestamp,
        }));
        const transcript = (0, aiReviewEvidence_1.buildReviewTranscript)(messages, conversation.metadata?.problemTitle);
        if (!transcript.studentMessageCount)
            return {};
        let content;
        let usage;
        let modelName = '';
        try {
            const response = await client.chat([{ role: 'user', content: (0, aiReviewEvidence_1.buildReviewUserPrompt)(transcript) }], aiReviewEvidence_1.REVIEW_SYSTEM_PROMPT, { temperature: 0, maxTokens: exports.REVIEW_MAX_COMPLETION_TOKENS, contentMode: 'raw' });
            content = response.content;
            usage = response.usage;
            modelName = response.usedModel?.modelName || '';
        }
        catch (err) {
            console.warn('[AIReview] 审核模型调用失败:', err instanceof Error ? err.message : err);
            return { failed: 1, modelFailure: true };
        }
        const tokens = usage
            ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
            : undefined;
        const costUSD = usage ? this.deps.estimateCost(modelName, usage.promptTokens, usage.completionTokens) : 0;
        const base = { ...(tokens ? { tokens } : {}), costUSD };
        const parsed = (0, aiReviewEvidence_1.parseReviewResult)(content);
        if (!parsed.ok)
            return { ...base, failed: 1 };
        const result = parsed.result;
        // 低置信度不进入复核列表（验收场景 4）
        if (!result.violation || !result.category || result.confidence === 'low')
            return base;
        const check = (0, aiReviewEvidence_1.verifyEvidence)(result.evidence, transcript.refs);
        const now = this.clock();
        const { timezone } = await this.configs();
        const state = await this.deps.runs.getState();
        const evidenceMessageIds = new Set(check.items
            .filter((item) => item.ok)
            .map((item) => transcript.refs.get(item.ref)?.messageId)
            .filter((id) => !!id));
        const evidenceMessages = stored
            .map((message, index) => ({ message, next: stored[index + 1] }))
            .filter(({ message }) => evidenceMessageIds.has(String(message._id)))
            .map(({ message, next }) => ({
            timestamp: message.timestamp,
            followedByFixedReply: !!next && next.role === 'ai' && !!next.metadata?.topicGuardBypassedLLM,
        }));
        const [conversationAlreadyPenalized, userPenalizedToday, realtimeEvents] = await Promise.all([
            this.deps.safetyLogs.hasAutoPenaltyForConversation(conversation._id),
            this.deps.safetyLogs.hasAutoPenaltyForUserSince(conversation.userId, (0, timezone_1.startOfDay)(timezone, now)),
            this.deps.creditEvents.listRealtimeForConversation(conversation.userId, conversation._id),
        ]);
        const decision = (0, aiReviewPenalty_1.decideAutoPenalty)({
            autoPenaltyEnabled: state.autoPenaltyEnabled,
            confidence: result.confidence,
            evidenceVerified: check.verified,
            conversationAlreadyPenalized,
            userPenalizedToday,
            touchesRealtimeDeduction: (0, aiReviewPenalty_1.touchesRealtimeDeduction)(evidenceMessages, realtimeEvents.map((event) => event.at)),
        });
        const firstQuote = check.items[0]?.quote || result.reason || result.category;
        const logId = await this.deps.safetyLogs.create({
            domainId: conversation.domainId,
            userId: conversation.userId,
            ...(conversation.problemId ? { problemId: conversation.problemId } : {}),
            conversationId: conversation._id,
            matchedPattern: 'ai_review',
            matchedText: firstQuote,
            category: result.category,
            confidence: result.confidence,
            detectionSource: 'ai_review',
            actionTaken: decision.penalize ? 'ai_review_penalty' : 'flagged',
            createdAt: now,
            reviewRunId: runId,
            evidence: check.items.map((item) => ({ ref: item.ref, snippet: item.quote, verified: item.ok })),
            evidenceVerified: check.verified,
            autoPenalized: decision.penalize,
            ...(result.reason ? { reviewReason: result.reason } : {}),
        });
        let penalized = 0;
        if (decision.penalize) {
            try {
                const deducted = await this.deps.credit.recordReviewDeduction({
                    uid: conversation.userId,
                    category: result.category,
                    safetyLogId: logId,
                    domainId: conversation.domainId,
                    conversationId: conversation._id,
                    at: now,
                });
                if (deducted)
                    penalized = 1;
                else
                    await this.deps.safetyLogs.downgradeAutoPenalty(logId);
            }
            catch (err) {
                console.error('[AIReview] 写入信誉扣分失败:', err instanceof Error ? err.message : err);
                await this.deps.safetyLogs.downgradeAutoPenalty(logId).catch(() => undefined);
            }
        }
        return { ...base, flagged: 1, penalized };
    }
    // ─── 熔断 ───────────────────────────────────────────────
    /** 当前误判统计（只看最近一次恢复之后产生的自动处罚） */
    async breakerStats(state) {
        const [{ review }, current] = await Promise.all([this.configs(), state ? Promise.resolve(state) : this.deps.runs.getState()]);
        const reviewed = await this.deps.safetyLogs.recentReviewedAutoPenalties(review.breakerWindow, current.resumedAt);
        return { ...(0, aiReviewPenalty_1.evaluateBreaker)(reviewed, review), minSample: review.breakerMinSample, threshold: review.breakerThreshold };
    }
    /**
     * 熔断检查（FR-047）：每批开始前、每次复核 AI 抽查记录后调用。触发时写审计，返回是否本次触发。
     */
    async checkBreaker() {
        const state = await this.deps.runs.getState();
        if (!state.autoPenaltyEnabled)
            return false;
        const stats = await this.breakerStats(state);
        if (!stats.trip)
            return false;
        const { window, sample, falsePositives, rate } = stats;
        const tripped = await this.deps.runs.trip({ window, sample, falsePositives, rate }, this.clock());
        if (tripped) {
            await this.deps.audit.record({
                action: 'review.breaker_trip',
                target: { type: 'review', id: 'auto_penalty' },
                detail: { window, sample, falsePositives, rate, threshold: stats.threshold },
            }).catch((err) => console.error('[AIReview] 写熔断审计失败:', err instanceof Error ? err.message : err));
        }
        return tripped;
    }
    /** 管理员停用或恢复自动处罚（只能由系统管理员恢复，FR-047） */
    async setAutoPenalty(enabled, actorUid) {
        const before = await this.deps.runs.getState();
        const state = await this.deps.runs.setAutoPenalty(enabled, actorUid, this.clock());
        if (before.autoPenaltyEnabled !== enabled) {
            await this.deps.audit.record({
                actorUid,
                action: enabled ? 'review.auto_penalty_resume' : 'review.auto_penalty_disable',
                target: { type: 'review', id: 'auto_penalty' },
                detail: before.trippedStats ? { trippedStats: before.trippedStats } : {},
            });
        }
        return state;
    }
    // ─── 管理页查询 ─────────────────────────────────────────
    async nameMaps(uids, domainIds) {
        const users = this.deps.db.collection('user');
        const domains = this.deps.db.collection('domain');
        const [userDocs, domainDocs] = await Promise.all([
            uids.length ? users.find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1 } }).toArray() : Promise.resolve([]),
            domainIds.length ? domains.find({ _id: { $in: domainIds } }, { projection: { _id: 1, name: 1 } }).toArray() : Promise.resolve([]),
        ]);
        return {
            users: new Map(userDocs.map((doc) => [doc._id, doc.uname])),
            domains: new Map(domainDocs.map((doc) => [doc._id, doc.name || doc._id])),
        };
    }
    async problemTitles(conversationIds) {
        if (!conversationIds.length)
            return new Map();
        const docs = await this.conversations
            .find({ _id: { $in: conversationIds } }, { projection: { _id: 1, metadata: 1 } })
            .toArray();
        return new Map(docs
            .filter((doc) => doc.metadata?.problemTitle)
            .map((doc) => [String(doc._id), doc.metadata?.problemTitle]));
    }
    /** 按用户名找学生（不区分大小写，排除游客与内置账号） */
    async resolveUnames(unames) {
        if (!unames.length)
            return { users: [], missing: [] };
        const docs = await this.deps.db.collection('user')
            .find({ unameLower: { $in: unames.map((name) => name.toLowerCase()) }, _id: { $gt: 1 } }, { projection: { _id: 1, uname: 1, unameLower: 1 } })
            .toArray();
        const found = new Set(docs.map((doc) => doc.unameLower || doc.uname.toLowerCase()));
        return {
            users: docs.map((doc) => ({ uid: doc._id, uname: doc.uname })),
            missing: unames.filter((name) => !found.has(name.toLowerCase())),
        };
    }
    // ─── 候选来源（Mongo） ─────────────────────────────────
    mongoCandidateSources() {
        const toCandidate = (doc) => ({
            conversationId: doc._id, domainId: doc.domainId, userId: doc.userId,
        });
        const projection = { _id: 1, domainId: 1, userId: 1 };
        const active = (since) => ({ endTime: { $gte: since }, messageCount: { $gte: 1 } });
        return {
            mediumConfidenceConversations: async (since) => {
                const hits = await this.deps.safetyLogs.conversationsWithConfidenceSince('medium', since);
                if (!hits.length)
                    return [];
                const ids = [...new Map(hits.map((hit) => [String(hit.conversationId), hit.conversationId])).values()];
                const docs = await this.conversations.find({ _id: { $in: ids } }, { projection }).toArray();
                return docs.map(toCandidate);
            },
            offTopicUsers: (since) => this.deps.safetyLogs.usersWithPenaltyEventsSince('off_topic', since),
            highUsageUsers: async (ratio) => {
                if (!this.deps.quotaUsage || !this.deps.quota)
                    return [];
                const { timezone } = await this.configs();
                const now = this.clock();
                const [today, yesterday] = await Promise.all([
                    this.deps.quotaUsage.usersWithUsage((0, timezone_1.dateKey)(timezone, now), 1, 5000),
                    this.deps.quotaUsage.usersWithUsage((0, timezone_1.previousDateKey)(timezone, now), 1, 5000),
                ]);
                const used = new Map();
                for (const row of [...today, ...yesterday])
                    used.set(row.uid, Math.max(used.get(row.uid) || 0, row.used));
                const uids = [...used.keys()];
                const out = [];
                for (let i = 0; i < uids.length; i += 200) {
                    const explained = await this.deps.quota.explainMany(uids.slice(i, i + 200));
                    for (const [uid, quota] of explained) {
                        if (quota.limit !== null && quota.limit > 0 && (used.get(uid) || 0) >= quota.limit * ratio)
                            out.push(uid);
                    }
                }
                return out;
            },
            conversationsOfUsers: async (uids, since, limit) => {
                if (!uids.length)
                    return [];
                const docs = await this.conversations
                    .find({ userId: { $in: uids }, ...active(since) }, { projection })
                    .sort({ endTime: -1 })
                    .limit(limit)
                    .toArray();
                return docs.map(toCandidate);
            },
            countConversations: (since) => this.conversations.countDocuments(active(since)),
            sampleConversations: async (since, size, excludeIds) => {
                const exclude = excludeIds.filter((id) => mongo_1.ObjectId.isValid(id)).map((id) => new mongo_1.ObjectId(id));
                const docs = await this.conversations.aggregate([
                    { $match: { ...active(since), ...(exclude.length ? { _id: { $nin: exclude } } : {}) } },
                    { $sample: { size } },
                    { $project: projection },
                ]).toArray();
                return docs.map(toCandidate);
            },
            conversationsByIds: async (ids) => {
                const objectIds = ids.filter((id) => mongo_1.ObjectId.isValid(id)).map((id) => new mongo_1.ObjectId(id));
                if (!objectIds.length)
                    return [];
                const docs = await this.conversations.find({ _id: { $in: objectIds } }, { projection }).toArray();
                return docs.map(toCandidate);
            },
        };
    }
}
exports.AIReviewService = AIReviewService;
//# sourceMappingURL=aiReviewService.js.map