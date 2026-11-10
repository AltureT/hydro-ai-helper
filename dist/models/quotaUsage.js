"use strict";
/**
 * QuotaUsage Model - 每日 AI 次数（plan R5，FR-011–016）
 *
 * 每个“用户 + 日期”一个文档：`_id = "${uid}:${date}"`，日期按配置时区计算，跨域合计。
 * 并发控制用“预占 → 确认 / 退还”：
 * - 预占：先清理过期预占，再用带 $expr 条件的原子 $push 追加预占；
 *   条件 `used + 预占数 < limit` 与追加在同一次文档更新内完成，并发请求不会超额。
 * - 确认：移除预占并 used + 1；预占已过期被清理时退化为直接 used + 1。
 * - 退还：移除预占。
 * - 不限额：不预占，成功时仍 used + 1，供统计显示。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaUsageModel = exports.QUOTA_USAGE_RETENTION_DAYS = void 0;
exports.quotaUsageId = quotaUsageId;
const mongo_1 = require("../utils/mongo");
exports.QUOTA_USAGE_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
function quotaUsageId(uid, date) {
    return `${uid}:${date}`;
}
function expireAtFor(date) {
    const start = Date.parse(`${date}T00:00:00Z`);
    return new Date((Number.isNaN(start) ? Date.now() : start) + exports.QUOTA_USAGE_RETENTION_DAYS * DAY_MS);
}
function isDuplicateKey(err) {
    return err?.code === 11000;
}
class QuotaUsageModel {
    constructor(db) {
        this.collection = db.collection('ai_quota_usage');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ expireAt: 1 }, { name: 'idx_expireAt_ttl', expireAfterSeconds: 0 });
        await this.collection.createIndex({ date: 1, used: -1 }, { name: 'idx_date_used' });
        console.log('[QuotaUsageModel] Indexes created successfully');
    }
    async get(uid, date) {
        return this.collection.findOne({ _id: quotaUsageId(uid, date) });
    }
    async getMany(uids, date) {
        if (!uids.length)
            return new Map();
        const docs = await this.collection
            .find({ _id: { $in: uids.map((uid) => quotaUsageId(uid, date)) } })
            .toArray();
        return new Map(docs.map((doc) => [doc.uid, doc]));
    }
    /** 当天已用 ≥ minUsed 次的用户（走 { date, used } 索引），用于总览的用量筛选 */
    async usersWithUsage(date, minUsed = 1, limit = 20000) {
        const docs = await this.collection
            .find({ date, used: { $gte: Math.max(1, minUsed) } }, { projection: { uid: 1, used: 1 } })
            .limit(limit)
            .toArray();
        return docs.map((doc) => ({ uid: doc.uid, used: doc.used }));
    }
    async ensureDoc(uid, date, now) {
        try {
            await this.collection.updateOne({ _id: quotaUsageId(uid, date) }, {
                $setOnInsert: {
                    uid, date, used: 0, reservations: [], updatedAt: now, expireAt: expireAtFor(date),
                },
            }, { upsert: true });
        }
        catch (err) {
            // 并发 upsert 撞唯一键：文档已由另一请求创建
            if (!isDuplicateKey(err))
                throw err;
        }
    }
    /**
     * 预占一次。成功返回 true；当日已用 + 进行中预占达到 limit 时返回 false。
     * @param staleBefore 早于该时间的预占视为已失效（请求异常中断未退还）
     */
    async reserve(uid, date, limit, reservationId, staleBefore, now = new Date()) {
        if (limit <= 0)
            return false;
        const _id = quotaUsageId(uid, date);
        await this.ensureDoc(uid, date, now);
        await this.collection.updateOne({ _id }, { $pull: { reservations: { at: { $lt: staleBefore } } } });
        const result = await this.collection.updateOne({
            _id,
            $expr: {
                $lt: [
                    { $add: [{ $ifNull: ['$used', 0] }, { $size: { $ifNull: ['$reservations', []] } }] },
                    limit,
                ],
            },
        }, {
            $push: { reservations: { id: reservationId, at: now } },
            $set: { updatedAt: now },
        });
        return result.matchedCount === 1;
    }
    /** 确认计次，返回确认后的已用次数 */
    async confirm(uid, date, reservationId, now = new Date()) {
        const _id = quotaUsageId(uid, date);
        const raw = await this.collection.findOneAndUpdate({ _id, 'reservations.id': reservationId }, { $inc: { used: 1 }, $pull: { reservations: { id: reservationId } }, $set: { updatedAt: now } }, { returnDocument: 'after' });
        const doc = (0, mongo_1.unwrapModifyResult)(raw);
        if (doc)
            return doc.used;
        // 预占已被当作过期清理：仍然计 1 次
        return this.increment(uid, date, now);
    }
    async release(uid, date, reservationId) {
        await this.collection.updateOne({ _id: quotaUsageId(uid, date) }, { $pull: { reservations: { id: reservationId } } });
    }
    /** 不限额时直接计次（也用于确认的退化路径），返回计次后的已用次数 */
    async increment(uid, date, now = new Date()) {
        const raw = await this.collection.findOneAndUpdate({ _id: quotaUsageId(uid, date) }, {
            $inc: { used: 1 },
            $set: { updatedAt: now },
            $setOnInsert: { uid, date, reservations: [], expireAt: expireAtFor(date) },
        }, { upsert: true, returnDocument: 'after' });
        return (0, mongo_1.unwrapModifyResult)(raw)?.used ?? 1;
    }
}
exports.QuotaUsageModel = QuotaUsageModel;
//# sourceMappingURL=quotaUsage.js.map