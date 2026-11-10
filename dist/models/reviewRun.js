"use strict";
/**
 * ReviewRun Model - AI 抽查批次与熔断状态（plan R9、R15）
 *
 * 同一集合中两种文档：
 * - 批次：`_id` 为 `daily:YYYY-MM-DD`（每天一批，重复键即加锁）或 `manual:<ObjectId>`；
 *   候选列表与已处理的会话 id 存在文档中，执行进程每 30 秒续租，租约过期后其他进程可接管并断点续跑。
 * - 熔断状态：`_id: 'state'`，记录自动处罚是否启用、停用原因与恢复人。
 * 批次保留 180 天（与安全日志一致），状态文档不过期。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewRunModel = exports.REVIEW_RUN_RENEW_MS = exports.REVIEW_RUN_LEASE_MS = exports.REVIEW_RUN_RETENTION_DAYS = void 0;
const mongo_1 = require("../utils/mongo");
exports.REVIEW_RUN_RETENTION_DAYS = 180;
/** 租约时长：执行进程每 30 秒续租一次，两次续租失败仍有余量 */
exports.REVIEW_RUN_LEASE_MS = 90 * 1000;
exports.REVIEW_RUN_RENEW_MS = 30 * 1000;
function isDuplicateKeyError(err) {
    return !!err && typeof err === 'object' && err.code === 11000;
}
class ReviewRunModel {
    constructor(db) {
        this.collection = db.collection('ai_review_runs');
    }
    get runs() {
        return this.collection;
    }
    async ensureIndexes() {
        await this.collection.createIndex({ kind: 1, startedAt: -1 }, { name: 'idx_kind_startedAt' });
        await this.collection.createIndex({ kind: 1, status: 1, leaseExpiresAt: 1 }, { name: 'idx_kind_status_lease' });
        await this.collection.createIndex({ expireAt: 1 }, { name: 'ttl_expireAt', expireAfterSeconds: 0 });
        console.log('[ReviewRunModel] Indexes created successfully');
    }
    /** 新建批次；`_id` 已存在（其他进程已负责）时返回 false */
    async tryCreate(input) {
        const doc = {
            _id: input.id,
            kind: 'run',
            trigger: input.trigger,
            ...(input.date ? { date: input.date } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.scopeLabel ? { scopeLabel: input.scopeLabel } : {}),
            ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy } : {}),
            status: 'running',
            candidates: null,
            processedIds: [],
            flaggedCount: 0,
            penalizedCount: 0,
            failedCount: 0,
            tokens: { prompt: 0, completion: 0, total: 0 },
            estimatedCostUSD: 0,
            leaseOwner: input.owner,
            leaseExpiresAt: new Date(input.now.getTime() + exports.REVIEW_RUN_LEASE_MS),
            startedAt: input.now,
            expireAt: new Date(input.now.getTime() + exports.REVIEW_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        };
        try {
            await this.runs.insertOne(doc);
            return true;
        }
        catch (err) {
            if (isDuplicateKeyError(err))
                return false;
            throw err;
        }
    }
    async get(id) {
        return this.runs.findOne({ _id: id, kind: 'run' });
    }
    /** 是否有租约有效的进行中批次 */
    async hasActiveRun(now) {
        const doc = await this.runs.findOne({ kind: 'run', status: 'running', leaseExpiresAt: { $gt: now } }, { projection: { _id: 1 } });
        return !!doc;
    }
    /** 租约已过期的进行中批次（进程崩溃或重启后由其他进程接管） */
    async findExpiredRunning(now, limit = 5) {
        return this.runs
            .find({ kind: 'run', status: 'running', leaseExpiresAt: { $lte: now } })
            .sort({ startedAt: 1 })
            .limit(limit)
            .toArray();
    }
    /** 接管租约已过期的批次；成功返回 true */
    async claimExpired(id, owner, now) {
        const raw = await this.runs.findOneAndUpdate({ _id: id, kind: 'run', status: 'running', leaseExpiresAt: { $lte: now } }, { $set: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + exports.REVIEW_RUN_LEASE_MS) } }, { returnDocument: 'after' });
        return !!(0, mongo_1.unwrapModifyResult)(raw);
    }
    /** 续租；租约已被其他进程接管或批次已结束时返回 false */
    async renewLease(id, owner, now) {
        const result = await this.runs.updateOne({ _id: id, kind: 'run', status: 'running', leaseOwner: owner }, { $set: { leaseExpiresAt: new Date(now.getTime() + exports.REVIEW_RUN_LEASE_MS) } });
        return result.matchedCount > 0;
    }
    async setCandidates(id, owner, candidates) {
        const result = await this.runs.updateOne({ _id: id, kind: 'run', status: 'running', leaseOwner: owner }, { $set: { candidates } });
        return result.matchedCount > 0;
    }
    /** 记录一个会话已处理及其结果；重复处理同一会话时不重复累计 */
    async markProcessed(id, owner, conversationId, progress) {
        const result = await this.runs.updateOne({
            _id: id, kind: 'run', status: 'running', leaseOwner: owner, processedIds: { $ne: conversationId },
        }, {
            $push: { processedIds: conversationId },
            $inc: {
                flaggedCount: progress.flagged || 0,
                penalizedCount: progress.penalized || 0,
                failedCount: progress.failed || 0,
                'tokens.prompt': progress.tokens?.prompt || 0,
                'tokens.completion': progress.tokens?.completion || 0,
                'tokens.total': progress.tokens?.total || 0,
                estimatedCostUSD: progress.costUSD || 0,
            },
        });
        return result.matchedCount > 0;
    }
    async finish(id, owner, status, now, error) {
        const result = await this.runs.updateOne({ _id: id, kind: 'run', status: 'running', leaseOwner: owner }, { $set: { status, finishedAt: now, ...(error ? { error } : {}) } });
        return result.matchedCount > 0;
    }
    /** 运行记录（不含候选明细） */
    async list(limit = 20) {
        const docs = await this.runs
            .find({ kind: 'run' })
            .sort({ startedAt: -1 })
            .limit(limit)
            .toArray();
        return docs.map(({ candidates, processedIds, ...rest }) => ({
            ...rest,
            candidateCount: candidates ? candidates.length : null,
            processedCount: processedIds.length,
        }));
    }
    /** 时间段内的抽查成本（FR-049）。每天至多几个批次，直接在内存中合计 */
    async costBetween(from, to) {
        const docs = await this.runs
            .find({ kind: 'run', startedAt: { $gte: from, $lt: to } }, { projection: { tokens: 1, estimatedCostUSD: 1 } })
            .limit(5000)
            .toArray();
        return docs.reduce((sum, doc) => ({
            totalTokens: sum.totalTokens + (doc.tokens?.total || 0),
            totalCost: sum.totalCost + (doc.estimatedCostUSD || 0),
            runCount: sum.runCount + 1,
        }), { totalTokens: 0, totalCost: 0, runCount: 0 });
    }
    // ─── 熔断状态 ─────────────────────────────────────────
    get states() {
        return this.collection;
    }
    async getState() {
        const doc = await this.states.findOne({ _id: 'state' });
        return doc || { _id: 'state', kind: 'state', autoPenaltyEnabled: true };
    }
    /** 熔断：仅在当前为启用时生效，返回是否本次触发 */
    async trip(stats, now) {
        const result = await this.states.updateOne({ _id: 'state', autoPenaltyEnabled: { $ne: false } }, {
            $set: { kind: 'state', autoPenaltyEnabled: false, trippedAt: now, trippedStats: stats },
            $unset: { disabledAt: '', disabledBy: '' },
        }, { upsert: true }).catch((err) => {
            // 状态文档已为停用时，upsert 会因 _id 冲突失败：视为未触发
            if (isDuplicateKeyError(err))
                return { matchedCount: 0, upsertedCount: 0 };
            throw err;
        });
        return (result.matchedCount || 0) + (result.upsertedCount || 0) > 0;
    }
    /** 管理员手动停用或恢复自动处罚 */
    async setAutoPenalty(enabled, actorUid, now) {
        const update = enabled
            ? {
                $set: { kind: 'state', autoPenaltyEnabled: true, resumedAt: now, resumedBy: actorUid },
                $unset: { disabledAt: '', disabledBy: '' },
            }
            : {
                $set: { kind: 'state', autoPenaltyEnabled: false, disabledAt: now, disabledBy: actorUid },
                $unset: { trippedAt: '', trippedStats: '' },
            };
        await this.states.updateOne({ _id: 'state' }, update, { upsert: true });
        return this.getState();
    }
}
exports.ReviewRunModel = ReviewRunModel;
//# sourceMappingURL=reviewRun.js.map