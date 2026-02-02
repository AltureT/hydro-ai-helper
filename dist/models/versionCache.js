"use strict";
/**
 * VersionCache Model - 版本缓存数据模型
 *
 * 用于缓存从 Gitee 获取的最新版本信息，避免频繁请求外部 API
 * 缓存有效期为 24 小时
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionCacheModel = exports.VERSION_CACHE_TTL_MS = void 0;
/**
 * 缓存有效期：24 小时（毫秒）
 */
exports.VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * VersionCache Model 操作类
 * 封装版本缓存的 CRUD 操作
 */
class VersionCacheModel {
    constructor(db) {
        this.collection = db.collection('ai_version_cache');
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
        // 创建唯一索引：key 字段
        await this.collection.createIndex({ key: 1 }, {
            name: 'idx_key',
            unique: true
        });
        console.log('[VersionCacheModel] Indexes created successfully');
    }
    /**
     * 获取缓存的版本信息
     * @param key 缓存键
     * @returns 版本缓存记录或 null（不存在或已过期）
     */
    async get(key) {
        const cache = await this.collection.findOne({ key });
        // 如果缓存存在但已过期，返回 null
        if (cache && cache.expireAt < new Date()) {
            return null;
        }
        return cache;
    }
    /**
     * 设置版本缓存
     * @param data 版本缓存数据
     */
    async set(data) {
        const now = new Date();
        const expireAt = new Date(now.getTime() + exports.VERSION_CACHE_TTL_MS);
        await this.collection.updateOne({ key: data.key }, {
            $set: {
                ...data,
                checkedAt: now,
                expireAt
            }
        }, { upsert: true });
    }
    /**
     * 删除指定缓存
     * @param key 缓存键
     */
    async delete(key) {
        await this.collection.deleteOne({ key });
    }
    /**
     * 清除所有缓存
     */
    async clear() {
        await this.collection.deleteMany({});
    }
    /**
     * 获取集合对象
     * @returns MongoDB Collection
     */
    getCollection() {
        return this.collection;
    }
}
exports.VersionCacheModel = VersionCacheModel;
//# sourceMappingURL=versionCache.js.map