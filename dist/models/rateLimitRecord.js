"use strict";
/**
 * RateLimitRecord Model - 频率限制记录数据模型
 *
 * 用于记录每个用户每分钟的请求次数，并通过 TTL 自动清理
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimitRecordModel = void 0;
exports.getRateLimitCollection = getRateLimitCollection;
/**
 * RateLimitRecord Model 操作类
 * 封装频率限制记录的操作
 */
class RateLimitRecordModel {
    constructor(db) {
        this.collection = db.collection('ai_rate_limit_records');
    }
    /**
     * 确保索引已创建
     * 创建 TTL 索引，自动清理过期记录
     */
    async ensureIndexes() {
        // 创建 TTL 索引：expireAt 字段，过期后自动删除
        await this.collection.createIndex({ expireAt: 1 }, {
            name: 'idx_expireAt_ttl',
            expireAfterSeconds: 0 // 到达 expireAt 时间后立即删除
        });
        // 创建复合唯一索引：userId + minuteKey（确保每个用户每分钟只有一条记录）
        await this.collection.createIndex({ userId: 1, minuteKey: 1 }, {
            name: 'idx_userId_minuteKey',
            unique: true
        });
        console.log('[RateLimitRecordModel] Indexes created successfully');
    }
    /**
     * 获取集合对象（供 RateLimitService 使用）
     * @returns MongoDB Collection
     */
    getCollection() {
        return this.collection;
    }
}
exports.RateLimitRecordModel = RateLimitRecordModel;
/**
 * 工厂函数：获取频率限制记录集合
 * @param db MongoDB Database 对象
 * @returns Collection<RateLimitRecord>
 */
function getRateLimitCollection(db) {
    return db.collection('ai_rate_limit_records');
}
//# sourceMappingURL=rateLimitRecord.js.map