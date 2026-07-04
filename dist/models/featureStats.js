"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeatureStatsModel = void 0;
const TTL_DAYS = 14;
class FeatureStatsModel {
    constructor(db) {
        this.collection = db.collection('ai_feature_stats');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60, name: 'idx_ttl_updatedAt' });
        await this.collection.createIndex({ date: 1 }, { name: 'idx_date' });
        console.log('[FeatureStatsModel] Indexes created successfully');
    }
    static getDateKey() {
        return new Date().toISOString().slice(0, 10);
    }
    docId(feature) {
        return `${FeatureStatsModel.getDateKey()}:${feature}`;
    }
    /** Record that a feature ran (regardless of outcome). Best-effort. */
    async recordAttempt(feature) {
        const date = FeatureStatsModel.getDateKey();
        await this.collection.updateOne(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { _id: this.docId(feature) }, {
            $inc: { attemptCount: 1 },
            $set: { date, feature, updatedAt: new Date() },
            $setOnInsert: { successCount: 0, lastSuccessAt: null },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, { upsert: true });
    }
    /** Record that a feature produced a valid result. Best-effort. */
    async recordSuccess(feature) {
        const date = FeatureStatsModel.getDateKey();
        const now = new Date();
        await this.collection.updateOne(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { _id: this.docId(feature) }, {
            $inc: { successCount: 1 },
            $set: { date, feature, lastSuccessAt: now, updatedAt: now },
            $setOnInsert: { attemptCount: 0 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, { upsert: true });
    }
    /** Today's per-feature counters, one entry per feature seen today. */
    async getStats24h() {
        const today = FeatureStatsModel.getDateKey();
        const docs = await this.collection.find({ date: today }).toArray();
        return docs.map((doc) => ({
            feature: doc.feature,
            attempts: doc.attemptCount || 0,
            successes: doc.successCount || 0,
            lastSuccessAt: doc.lastSuccessAt || null,
        }));
    }
    /**
     * 近 N 天（含今天）的按日计数。
     *
     * 心跳每 24 小时触发一次，只带"今天"的快照会系统性丢失上次心跳之后到
     * 当天结束之间的计数；带上最近两天，让平台按 (date, feature) 取最大值
     * 累计，即可得到完整的按日用量。
     */
    async getStatsRecentDays(days) {
        const dates = [];
        const now = Date.now();
        for (let i = 0; i < days; i++) {
            dates.push(new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
        }
        const docs = await this.collection.find({ date: { $in: dates } }).toArray();
        return docs.map((doc) => ({
            date: doc.date,
            feature: doc.feature,
            attempts: doc.attemptCount || 0,
            successes: doc.successCount || 0,
            lastSuccessAt: doc.lastSuccessAt || null,
        }));
    }
}
exports.FeatureStatsModel = FeatureStatsModel;
//# sourceMappingURL=featureStats.js.map