/**
 * VersionCache Model - 版本缓存数据模型
 *
 * 用于缓存从 Gitee 获取的最新版本信息，避免频繁请求外部 API
 * 缓存有效期为 24 小时
 */

import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';

/**
 * 版本缓存记录接口
 */
export interface VersionCache {
  _id?: ObjectIdType;          // MongoDB ObjectId
  key: string;                 // 缓存键（如 'latest_version'）
  currentVersion: string;      // 当前安装版本
  latestVersion: string;       // 远程最新版本
  releaseUrl?: string;         // 发布页面 URL
  releaseNotes?: string;       // 版本更新说明
  hasUpdate: boolean;          // 是否有可用更新
  checkedAt: Date;             // 检查时间
  expireAt: Date;              // 缓存过期时间（用于 TTL）
}

/**
 * 缓存有效期：24 小时（毫秒）
 */
export const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * VersionCache Model 操作类
 * 封装版本缓存的 CRUD 操作
 */
export class VersionCacheModel {
  private collection: Collection<VersionCache>;

  constructor(db: Db) {
    this.collection = db.collection<VersionCache>('ai_version_cache');
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

    // 创建唯一索引：key 字段
    await this.collection.createIndex(
      { key: 1 },
      {
        name: 'idx_key',
        unique: true
      }
    );

    console.log('[VersionCacheModel] Indexes created successfully');
  }

  /**
   * 获取缓存的版本信息
   * @param key 缓存键
   * @returns 版本缓存记录或 null（不存在或已过期）
   */
  async get(key: string): Promise<VersionCache | null> {
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
  async set(data: Omit<VersionCache, '_id' | 'expireAt'>): Promise<void> {
    const now = new Date();
    const expireAt = new Date(now.getTime() + VERSION_CACHE_TTL_MS);

    await this.collection.updateOne(
      { key: data.key },
      {
        $set: {
          ...data,
          checkedAt: now,
          expireAt
        }
      },
      { upsert: true }
    );
  }

  /**
   * 删除指定缓存
   * @param key 缓存键
   */
  async delete(key: string): Promise<void> {
    await this.collection.deleteOne({ key });
  }

  /**
   * 清除所有缓存
   */
  async clear(): Promise<void> {
    await this.collection.deleteMany({});
  }

  /**
   * 获取集合对象
   * @returns MongoDB Collection
   */
  getCollection(): Collection<VersionCache> {
    return this.collection;
  }
}
