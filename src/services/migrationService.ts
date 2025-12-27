/**
 * MigrationService - 数据迁移服务
 *
 * 用于处理历史数据的迁移，包括：
 * - 为现有 Conversation 记录添加 domainId 字段
 * - 清理不再需要的旧索引
 */

import type { Db } from 'mongodb';

/**
 * 默认域 ID（用于迁移没有 domainId 的历史数据）
 */
export const DEFAULT_DOMAIN_ID = 'system';

/**
 * MigrationService 类
 * 封装数据迁移相关操作
 */
export class MigrationService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * 迁移 Conversation 记录的 domainId 字段
   * 为所有没有 domainId 的记录添加默认值
   *
   * @returns 迁移的记录数
   */
  async migrateConversationDomainIds(): Promise<number> {
    const collection = this.db.collection('ai_conversations');

    // 查找所有没有 domainId 字段的记录
    const result = await collection.updateMany(
      { domainId: { $exists: false } },
      { $set: { domainId: DEFAULT_DOMAIN_ID } }
    );

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
  async migrateRateLimitRecords(): Promise<number> {
    const collection = this.db.collection('ai_rate_limit_records');

    // 为所有没有 domainId 字段的记录添加默认值
    const result = await collection.updateMany(
      { domainId: { $exists: false } },
      { $set: { domainId: DEFAULT_DOMAIN_ID } }
    );

    console.log(`[MigrationService] Migrated ${result.modifiedCount} rate limit records with domainId`);
    return result.modifiedCount;
  }

  /**
   * 删除旧的唯一索引（如果存在）
   * 用于清理从 userId + minuteKey 到 domainId + userId + minuteKey 的索引变更
   */
  async dropOldRateLimitIndex(): Promise<void> {
    const collection = this.db.collection('ai_rate_limit_records');

    try {
      // 尝试删除旧索引（如果存在）
      await collection.dropIndex('idx_userId_minuteKey');
      console.log('[MigrationService] Dropped old index: idx_userId_minuteKey');
    } catch (err) {
      // 索引不存在时忽略错误
      if ((err as Error).message?.includes('not found')) {
        console.log('[MigrationService] Old index idx_userId_minuteKey does not exist, skipping');
      } else {
        throw err;
      }
    }
  }

  /**
   * 执行所有迁移
   * @returns 迁移统计信息
   */
  async runAllMigrations(): Promise<{
    conversationsMigrated: number;
    rateLimitRecordsMigrated: number;
  }> {
    console.log('[MigrationService] Starting data migration...');

    // 先删除旧索引
    await this.dropOldRateLimitIndex();

    // 迁移数据
    const conversationsMigrated = await this.migrateConversationDomainIds();
    const rateLimitRecordsMigrated = await this.migrateRateLimitRecords();

    console.log('[MigrationService] Data migration completed');

    return {
      conversationsMigrated,
      rateLimitRecordsMigrated
    };
  }
}
