"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestStatsModel = void 0;
const TTL_DAYS = 90;
class RequestStatsModel {
    constructor(db) {
        this.collection = db.collection('ai_request_daily_stats');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60, name: 'idx_ttl_updatedAt' });
        console.log('[RequestStatsModel] Indexes created successfully');
    }
    static getDateKey() {
        return new Date().toISOString().slice(0, 10);
    }
    async recordSuccess(latencyMs) {
        const dateKey = RequestStatsModel.getDateKey();
        await this.collection.updateOne(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { _id: dateKey }, {
            $inc: {
                successCount: 1,
                totalLatencyMs: latencyMs,
            },
            $set: { updatedAt: new Date() },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, { upsert: true });
    }
    async recordFailure(category) {
        const dateKey = RequestStatsModel.getDateKey();
        await this.collection.updateOne(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { _id: dateKey }, {
            $inc: {
                failureCount: 1,
                [`errorCountByCategory.${category}`]: 1,
            },
            $set: { updatedAt: new Date() },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, { upsert: true });
    }
    async getStats24h() {
        const today = RequestStatsModel.getDateKey();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = await this.collection.findOne({ _id: today });
        if (!doc) {
            return { successCount: 0, failureCount: 0, avgLatencyMs: 0, errorCountByCategory: {} };
        }
        const avgLatencyMs = doc.successCount > 0
            ? Math.round(doc.totalLatencyMs / doc.successCount)
            : 0;
        return {
            successCount: doc.successCount || 0,
            failureCount: doc.failureCount || 0,
            avgLatencyMs,
            errorCountByCategory: doc.errorCountByCategory || {},
        };
    }
}
exports.RequestStatsModel = RequestStatsModel;
//# sourceMappingURL=requestStats.js.map