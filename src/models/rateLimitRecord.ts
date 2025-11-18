/**
 * RateLimitRecord Model - 频率限制记录数据模型
 *
 * 用于记录每个用户每分钟的请求次数，并通过 TTL 自动清理
 */

import type { Db, Collection } from 'mongodb';
import { ObjectId, type ObjectIdType } from '../utils/mongo';

/**
 * 频率限制记录接口
 */
export interface RateLimitRecord {
  _id?: ObjectIdType;       // MongoDB ObjectId
  userId: number;           // 用户 ID（与 HydroOJ 用户系统保持一致）
  minuteKey: string;        // 形如 "2025-11-18T09:32" 的分钟粒度时间键
  count: number;            // 当前分钟内已请求次数
  expireAt: Date;           // TTL 过期时间（通常为当前分钟结束后略多一些）
}

/**
 * RateLimitRecord Model 操作类
 * 封装频率限制记录的操作
 */
export class RateLimitRecordModel {
  private collection: Collection<RateLimitRecord>;

  constructor(db: Db) {
    this.collection = db.collection<RateLimitRecord>('ai_rate_limit_records');
  }

  /**
   * 确保索引已创建
   * 创建 TTL 索引，自动清理过期记录
   */
  async ensureIndexes(): Promise<void> {
    // 创建 TTL 索引：expireAt 字段，过期后自动删除
    await this.collection.createIndex(
      { expireAt: 1 },
      {
        name: 'idx_expireAt_ttl',
        expireAfterSeconds: 0  // 到达 expireAt 时间后立即删除
      }
    );

    // 创建复合唯一索引：userId + minuteKey（确保每个用户每分钟只有一条记录）
    await this.collection.createIndex(
      { userId: 1, minuteKey: 1 },
      {
        name: 'idx_userId_minuteKey',
        unique: true
      }
    );

    console.log('[RateLimitRecordModel] Indexes created successfully');
  }

  /**
   * 获取集合对象（供 RateLimitService 使用）
   * @returns MongoDB Collection
   */
  getCollection(): Collection<RateLimitRecord> {
    return this.collection;
  }
}

/**
 * 工厂函数：获取频率限制记录集合
 * @param db MongoDB Database 对象
 * @returns Collection<RateLimitRecord>
 */
export function getRateLimitCollection(db: Db): Collection<RateLimitRecord> {
  return db.collection<RateLimitRecord>('ai_rate_limit_records');
}
