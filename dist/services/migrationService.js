"use strict";
/**
 * MigrationService - 数据迁移服务
 *
 * 用于处理历史数据的迁移，包括：
 * - 为现有 Conversation 记录添加 domainId 字段
 * - 清理不再需要的旧索引
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationService = exports.DEFAULT_DOMAIN_ID = void 0;
/**
 * 默认域 ID（用于迁移没有 domainId 的历史数据）
 */
exports.DEFAULT_DOMAIN_ID = 'system';
const MIGRATION_BATCH_SIZE = 500;
const MISSING_DOMAIN_FILTER = {
    $or: [
        { domainId: { $exists: false } },
        { domainId: null },
        { domainId: '' }
    ]
};
/**
 * MigrationService 类
 * 封装数据迁移相关操作
 */
class MigrationService {
    constructor(db) {
        this.db = db;
    }
    /**
     * 迁移 Conversation 记录的 domainId 字段
     * 为所有没有 domainId 的记录添加默认值
     *
     * @returns 迁移的记录数
     */
    async migrateConversationDomainIds() {
        const collection = this.db.collection('ai_conversations');
        // 兼容历史脏数据：domainId 缺失 / null / 空字符串都回填为 system
        const result = await collection.updateMany(MISSING_DOMAIN_FILTER, { $set: { domainId: exports.DEFAULT_DOMAIN_ID } });
        console.log(`[MigrationService] Migrated ${result.modifiedCount} conversation records with domainId`);
        return result.modifiedCount;
    }
    /**
     * 迁移 RateLimitRecord 记录
     * 由于 RateLimitRecord 使用 TTL 自动过期，旧记录会自动清理
     * 这里主要处理正在使用中的记录
     *
     * @returns 迁移的记录数
     */
    async migrateRateLimitRecords() {
        const collection = this.db.collection('ai_rate_limit_records');
        // 兼容历史脏数据：domainId 缺失 / null / 空字符串都回填为 system
        const result = await collection.updateMany(MISSING_DOMAIN_FILTER, { $set: { domainId: exports.DEFAULT_DOMAIN_ID } });
        console.log(`[MigrationService] Migrated ${result.modifiedCount} rate limit records with domainId`);
        return result.modifiedCount;
    }
    /**
     * 迁移旧版安全日志的 domainId。
     *
     * 旧日志里的 conversationId/problemId 是在请求完成会话归属校验前记录的，
     * 不能作为可信租户证据。所有缺失域的历史日志统一进入 system 隔离域，
     * 保留数据供系统管理员审计，同时避免猜测归属造成跨域泄露。
     *
     * 使用游标和批量写入，避免历史日志较多时一次性加载到内存。
     */
    async migrateJailbreakLogDomainIds() {
        const logCollection = this.db.collection('ai_jailbreak_logs');
        const cursor = logCollection.find(MISSING_DOMAIN_FILTER, { projection: { _id: 1 } }).batchSize(MIGRATION_BATCH_SIZE);
        let migrated = 0;
        let batch = [];
        const flushBatch = async () => {
            if (batch.length === 0)
                return;
            const result = await logCollection.bulkWrite(batch.map((log) => ({
                updateOne: {
                    // 保留缺失域条件，避免覆盖迁移期间被其他流程修复的记录。
                    filter: { _id: log._id, ...MISSING_DOMAIN_FILTER },
                    update: { $set: { domainId: exports.DEFAULT_DOMAIN_ID } }
                }
            })), { ordered: false });
            migrated += result.modifiedCount;
            batch = [];
        };
        for await (const log of cursor) {
            batch.push(log);
            if (batch.length >= MIGRATION_BATCH_SIZE)
                await flushBatch();
        }
        await flushBatch();
        console.log(`[MigrationService] Migrated ${migrated} jailbreak log records with domainId`);
        return migrated;
    }
    /**
     * 删除旧的唯一索引（如果存在）
     * 用于清理从 userId + minuteKey 到 domainId + userId + minuteKey 的索引变更
     */
    async dropOldRateLimitIndex() {
        const collection = this.db.collection('ai_rate_limit_records');
        try {
            // 尝试删除旧索引（如果存在）
            await collection.dropIndex('idx_userId_minuteKey');
            console.log('[MigrationService] Dropped old index: idx_userId_minuteKey');
        }
        catch (err) {
            // 索引不存在时忽略错误
            if (err.message?.includes('not found')) {
                console.log('[MigrationService] Old index idx_userId_minuteKey does not exist, skipping');
            }
            else {
                throw err;
            }
        }
    }
    /**
     * 执行所有迁移
     * @returns 迁移统计信息
     */
    async runAllMigrations() {
        console.log('[MigrationService] Starting data migration...');
        // 先删除旧索引
        await this.dropOldRateLimitIndex();
        // 迁移数据
        const conversationsMigrated = await this.migrateConversationDomainIds();
        let jailbreakLogsMigrated = 0;
        try {
            jailbreakLogsMigrated = await this.migrateJailbreakLogDomainIds();
        }
        catch (err) {
            // 迁移失败不应让整个 AI 助手在路由注册前离线；缺少 domainId 的日志
            // 仍不会被任何租户查询命中，下次重启会通过幂等条件继续重试。
            console.warn('[MigrationService] Jailbreak log domain migration failed; will retry on next startup:', err);
        }
        const rateLimitRecordsMigrated = await this.migrateRateLimitRecords();
        console.log('[MigrationService] Data migration completed');
        return {
            conversationsMigrated,
            rateLimitRecordsMigrated,
            jailbreakLogsMigrated
        };
    }
}
exports.MigrationService = MigrationService;
//# sourceMappingURL=migrationService.js.map