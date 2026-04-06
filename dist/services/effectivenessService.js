"use strict";
/**
 * EffectivenessService - 对话有效性多维信号分析
 *
 * 两阶段分析：
 *   阶段 A（即时）：从消息集合计算 Group 1 对话信号 + Group 3 上下文快照
 *   阶段 B（延迟回填）：30 分钟后从 HydroOJ record 集合获取 Group 2 行为信号
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EffectivenessService = void 0;
const mongo_1 = require("../utils/mongo");
const problemIdHelper_1 = require("../utils/problemIdHelper");
const BACKFILL_DELAY_MS = 30 * 60 * 1000;
const METRICS_VERSION = 1;
const RECORD_STATUS_ACCEPTED = 1;
const LEGACY_RULES = {
    MIN_STUDENT_MESSAGES: 2,
    MIN_STUDENT_AVG_LENGTH: 20,
};
// Debounce map: conversationId hex → timeout handle
const pendingBackfills = new Map();
/**
 * 从 metrics 信号派生 isEffective（向后兼容）
 */
function deriveIsEffective(m) {
    if (m.studentMessageCount < LEGACY_RULES.MIN_STUDENT_MESSAGES)
        return false;
    const avg = m.studentMessageCount > 0
        ? m.studentTotalLength / m.studentMessageCount
        : 0;
    if (avg < LEGACY_RULES.MIN_STUDENT_AVG_LENGTH)
        return false;
    // 未回填：保守标记为 false，等回填后再重新判定
    if (m.backfilledAt === null)
        return false;
    // 已回填 + 无关联题目（submissionsAfter=null）：纯咨询型，
    // 仅靠消息量判定——深度交互（≥4 轮）视为有效
    if (m.submissionsAfter === null) {
        return m.studentMessageCount >= 4;
    }
    // 已回填 + AC → 有效
    if (m.firstAcceptedIndex !== null)
        return true;
    // 已回填 + 有提交但全部失败 → 看投入程度
    if (m.submissionsAfter > 0) {
        return m.studentMessageCount >= 3;
    }
    // 已回填 + 有题目但 0 次提交 → 问问就走，无效
    return false;
}
class EffectivenessService {
    constructor(ctx) {
        this.ctx = ctx;
    }
    /**
     * 阶段 A：即时分析 — 计算 Group 1 + Group 3 并写入 metrics
     */
    async analyzeConversation(conversationId) {
        try {
            const messageModel = this.ctx.get('messageModel');
            const conversationModel = this.ctx.get('conversationModel');
            const convObjectId = typeof conversationId === 'string'
                ? new mongo_1.ObjectId(conversationId)
                : conversationId;
            const conv = await conversationModel.findById(convObjectId);
            if (!conv)
                return false;
            const messages = await messageModel.findByConversationId(convObjectId);
            // Group 1: 对话信号
            const studentMessages = messages.filter(msg => msg.role === 'student');
            const studentMessageCount = studentMessages.length;
            const studentTotalLength = studentMessages.reduce((sum, msg) => sum + msg.content.length, 0);
            // Group 3: 题目难度快照（已有值时跳过，避免每条消息重复查询）
            const problemDifficulty = conv.metrics?.problemDifficulty ?? await this.fetchProblemDifficulty(conv.domainId, conv.problemId);
            const metrics = {
                v: METRICS_VERSION,
                studentMessageCount,
                studentTotalLength,
                submissionsAfter: null,
                firstAcceptedIndex: null,
                problemDifficulty,
                backfilledAt: null,
            };
            const isEffective = deriveIsEffective(metrics);
            await conversationModel.updateMetrics(convObjectId, metrics, isEffective);
            this.scheduleBackfill(convObjectId);
            return isEffective;
        }
        catch (err) {
            this.ctx.logger.error('EffectivenessService analyzeConversation error', err);
            return false;
        }
    }
    /**
     * 阶段 B：延迟回填 — 查询 HydroOJ record 集合获取行为信号
     */
    async backfillBehavioralSignals(conversationId) {
        try {
            const conversationModel = this.ctx.get('conversationModel');
            const conv = await conversationModel.findById(conversationId);
            if (!conv || !conv.metrics)
                return;
            const numericPid = (0, problemIdHelper_1.parseProblemId)(conv.problemId);
            if (conv.domainId === 'system' || numericPid === null) {
                const updated = {
                    ...conv.metrics,
                    submissionsAfter: null,
                    firstAcceptedIndex: null,
                    backfilledAt: new Date(),
                };
                await conversationModel.updateMetrics(conversationId, updated, deriveIsEffective(updated));
                return;
            }
            const windowEnd = new Date(conv.endTime.getTime() + BACKFILL_DELAY_MS);
            const records = await this.ctx.db.collection('record').find({
                domainId: conv.domainId,
                uid: conv.userId,
                pid: numericPid,
                judgeAt: { $gte: conv.startTime, $lte: windowEnd },
            }).sort({ judgeAt: 1 }).toArray();
            const submissionsAfter = records.length;
            let firstAcceptedIndex = null;
            for (let i = 0; i < records.length; i++) {
                if (records[i].status === RECORD_STATUS_ACCEPTED) {
                    firstAcceptedIndex = i;
                    break;
                }
            }
            const updated = {
                ...conv.metrics,
                submissionsAfter,
                firstAcceptedIndex,
                backfilledAt: new Date(),
            };
            const isEffective = deriveIsEffective(updated);
            await conversationModel.updateMetrics(conversationId, updated, isEffective);
        }
        catch (err) {
            this.ctx.logger.error('EffectivenessService backfill error', err);
        }
    }
    /**
     * 补偿回填：扫描 backfilledAt=null 且已超时的文档，并行处理（最多 5 并发）
     */
    async compensateBackfill() {
        try {
            const conversationModel = this.ctx.get('conversationModel');
            const cutoff = new Date(Date.now() - BACKFILL_DELAY_MS);
            const pending = await conversationModel.findPendingBackfill(cutoff, 100);
            if (pending.length === 0)
                return 0;
            // 并行处理，限制并发数为 5
            const CONCURRENCY = 5;
            let count = 0;
            for (let i = 0; i < pending.length; i += CONCURRENCY) {
                const batch = pending.slice(i, i + CONCURRENCY);
                await Promise.allSettled(batch.map(doc => this.backfillBehavioralSignals(doc._id)));
                count += batch.length;
            }
            if (count > 0) {
                this.ctx.logger.info(`[EffectivenessService] Compensated ${count} backfills`);
            }
            return count;
        }
        catch (err) {
            this.ctx.logger.error('EffectivenessService compensateBackfill error', err);
            return 0;
        }
    }
    /**
     * 记录越狱尝试日志
     */
    async logJailbreakAttempt(payload) {
        try {
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            const formattedConversationId = payload.conversationId === undefined
                ? undefined
                : typeof payload.conversationId === 'string'
                    ? new mongo_1.ObjectId(payload.conversationId)
                    : payload.conversationId;
            await jailbreakLogModel.create({
                userId: payload.userId,
                problemId: payload.problemId,
                conversationId: formattedConversationId,
                questionType: payload.questionType,
                matchedPattern: payload.matchedPattern,
                matchedText: payload.matchedText,
                createdAt: payload.createdAt ?? new Date()
            });
        }
        catch (err) {
            this.ctx.logger.error('EffectivenessService logJailbreakAttempt error', err);
        }
    }
    async fetchProblemDifficulty(domainId, problemId) {
        try {
            const numericPid = (0, problemIdHelper_1.parseProblemId)(problemId);
            if (numericPid === null)
                return null;
            const doc = await this.ctx.db.collection('document').findOne({
                domainId,
                docType: 10,
                docId: numericPid,
            });
            if (!doc)
                return null;
            const nSubmit = doc.nSubmit;
            const nAccept = doc.nAccept;
            if (!nSubmit || nSubmit === 0)
                return null;
            return Math.round(((nAccept || 0) / nSubmit) * 10000) / 10000;
        }
        catch {
            return null;
        }
    }
    scheduleBackfill(conversationId) {
        const key = conversationId.toHexString();
        const prev = pendingBackfills.get(key);
        if (prev)
            clearTimeout(prev);
        const timer = setTimeout(() => {
            pendingBackfills.delete(key);
            void this.backfillBehavioralSignals(conversationId).catch((err) => this.ctx.logger.error('Backfill failed', err));
        }, BACKFILL_DELAY_MS);
        pendingBackfills.set(key, timer);
    }
}
exports.EffectivenessService = EffectivenessService;
//# sourceMappingURL=effectivenessService.js.map