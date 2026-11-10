"use strict";
/**
 * CreditEvent Model - 信誉事件（FR-027–FR-032）
 *
 * 每次扣分、每次重置各一条记录，信誉系数由这些记录推导（plan R8），不建缓存表。
 * 复核为误判时撤销对应扣分（保留记录，写入撤销人、时间、原因）。保留 180 天，与安全日志一致。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreditEventModel = exports.CREDIT_LOOKBACK_DAYS = exports.CREDIT_EVENT_RETENTION_DAYS = void 0;
exports.CREDIT_EVENT_RETENTION_DAYS = 180;
/** 推导系数时回看的天数：最大差距 0.8、每天恢复 0.05 时 16 天恢复完，30 天前的事件不再有影响 */
exports.CREDIT_LOOKBACK_DAYS = 30;
class CreditEventModel {
    constructor(db) {
        this.collection = db.collection('ai_credit_events');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ uid: 1, at: -1 }, { name: 'idx_uid_at' });
        await this.collection.createIndex({ safetyLogId: 1 }, { name: 'idx_safetyLogId', sparse: true });
        await this.collection.createIndex({ at: -1, type: 1 }, { name: 'idx_at_type' });
        await this.collection.createIndex({ expireAt: 1 }, { name: 'ttl_expireAt', expireAfterSeconds: 0 });
        console.log('[CreditEventModel] Indexes created successfully');
    }
    async insert(input) {
        const doc = {
            ...input,
            expireAt: new Date(input.at.getTime() + exports.CREDIT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        };
        const result = await this.collection.insertOne(doc);
        return result.insertedId;
    }
    async insertMany(inputs) {
        if (!inputs.length)
            return 0;
        const docs = inputs.map((input) => ({
            ...input,
            expireAt: new Date(input.at.getTime() + exports.CREDIT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        }));
        const result = await this.collection.insertMany(docs);
        return result.insertedCount;
    }
    /** 一个用户在 since 之后的全部事件（含已撤销），按时间正序 */
    async listSince(uid, since) {
        return this.collection.find({ uid, at: { $gte: since } }).sort({ at: 1 }).toArray();
    }
    /** 一页用户的事件，一次 $in 查询 */
    async listSinceMany(uids, since) {
        const out = new Map();
        if (!uids.length)
            return out;
        const docs = await this.collection.find({ uid: { $in: uids }, at: { $gte: since } }).sort({ at: 1 }).toArray();
        for (const doc of docs) {
            const list = out.get(doc.uid);
            if (list)
                list.push(doc);
            else
                out.set(doc.uid, [doc]);
        }
        return out;
    }
    /** since 之后有未撤销扣分的用户（学生总览“信誉降低”筛选的候选集） */
    async uidsWithDeductionsSince(since, limit = 20000) {
        const uids = await this.collection.distinct('uid', {
            type: 'deduction',
            at: { $gte: since },
            revokedAt: { $exists: false },
        });
        return uids.slice(0, limit);
    }
    /** 某会话中的实时规则扣分（AI 抽查判断“涉及的消息已被实时规则扣过分”，FR-044） */
    async listRealtimeForConversation(uid, conversationId) {
        return this.collection
            .find({ uid, conversationId, type: 'deduction', source: 'realtime' })
            .sort({ at: 1 })
            .toArray();
    }
    /** 学生尚未确认的 AI 抽查处罚通知（FR-046）；已撤销的不再提示 */
    async pendingReviewNotices(uid, since, limit = 5) {
        return this.collection
            .find({
            uid,
            type: 'deduction',
            source: 'ai_review',
            at: { $gte: since },
            revokedAt: { $exists: false },
            noticeAckAt: { $exists: false },
        })
            .sort({ at: -1 })
            .limit(limit)
            .toArray();
    }
    /** 学生确认通知：只能确认本人的 AI 抽查扣分 */
    async ackReviewNotice(id, uid, at) {
        const result = await this.collection.updateOne({ _id: id, uid, source: 'ai_review', type: 'deduction' }, { $set: { noticeAckAt: at } });
        return result.matchedCount > 0;
    }
    /** 撤销关联到某条安全记录的扣分，返回被撤销的事件（撤销前） */
    async revokeBySafetyLog(safetyLogId, revokedBy, reason, at) {
        const filter = { safetyLogId, type: 'deduction', revokedAt: { $exists: false } };
        const targets = await this.collection.find(filter).toArray();
        if (!targets.length)
            return [];
        await this.collection.updateMany({ _id: { $in: targets.map((doc) => doc._id) }, revokedAt: { $exists: false } }, { $set: { revokedAt: at, revokedBy, revokeReason: reason } });
        return targets;
    }
}
exports.CreditEventModel = CreditEventModel;
//# sourceMappingURL=creditEvent.js.map