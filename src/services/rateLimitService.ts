/**
 * RateLimitService - 频率限制服务
 *
 * 提供基于用户和时间窗口的请求频率限制功能
 */

import type { Context } from 'hydrooj';
import { getRateLimitCollection } from '../models/rateLimitRecord';

/**
 * RateLimitService 类
 * 提供频率限制检查和计数功能
 */
export class RateLimitService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /**
   * 检查用户是否超过频率限制，并原子性地增加计数
   * @param domainId 域 ID (用于多租户隔离)
   * @param userId 用户 ID
   * @param limitPerMinute 每分钟最大请求次数
   * @returns 返回 true 表示允许通过，false 表示已超限
   */
  async checkAndIncrement(domainId: string, userId: number, limitPerMinute: number): Promise<boolean> {
    try {
      // 1. 获取当前时间并生成分钟粒度的时间键
      const now = new Date();
      const minuteKey = now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:mm"

      // 2. 计算过期时间（当前时间 + 2 分钟）
      const expireAt = new Date(now.getTime() + 2 * 60 * 1000);

      // 调试日志
      console.log('[RateLimitService] checkAndIncrement called - domainId:', domainId, 'userId:', userId, 'minuteKey:', minuteKey, 'limit:', limitPerMinute);

      // 3. 获取频率限制记录集合
      const collection = getRateLimitCollection(this.ctx.db);

      // 4. 使用 findOneAndUpdate 原子性地增加计数
      // - 如果记录不存在，则创建新记录（upsert: true）
      // - 如果记录存在，则增加计数（$inc: { count: 1 }）
      // - 返回更新后的文档（returnDocument: 'after'）
      const result = await collection.findOneAndUpdate(
        {
          domainId,
          userId,
          minuteKey
        },
        {
          $setOnInsert: {
            domainId,
            expireAt
          },
          $inc: {
            count: 1
          }
        },
        {
          upsert: true,
          // `returnOriginal` 兼容老版本 MongoDB 驱动,`returnDocument` 兼容新版本
          returnDocument: 'after',
          // @ts-expect-error - 老版本驱动使用 returnOriginal,忽略即可
          returnOriginal: false
        }
      );

      // 兼容处理：部分环境下 findOneAndUpdate 可能不返回 value（老驱动忽略 returnDocument）
      let updatedRecord = result?.value;
      if (!updatedRecord) {
        updatedRecord = await collection.findOne({ domainId, userId, minuteKey });
        if (!updatedRecord) {
          console.log('[RateLimitService] WARNING: findOneAndUpdate returned null and fallback findOne failed, allowing request');
          this.ctx.logger.warn('RateLimitService: findOneAndUpdate returned null and fallback findOne failed, allowing request');
          return true;
        }
      }

      // 5. 检查更新后的计数是否超过限制
      const allowed = updatedRecord.count <= limitPerMinute;

      // 调试日志：显示当前计数
      console.log('[RateLimitService] Current count:', updatedRecord.count, 'limit:', limitPerMinute, 'allowed:', allowed);

      // 6. 记录调试日志（可选，便于排查问题）
      if (!allowed) {
        console.log('[RateLimitService] Rate limit EXCEEDED for user', userId, 'in domain', domainId);
        this.ctx.logger.info(`RateLimitService: User ${userId} in domain ${domainId} exceeded rate limit (${updatedRecord.count}/${limitPerMinute}) at ${minuteKey}`);
      }

      return allowed;
    } catch (err) {
      // 7. 错误处理：出错时默认放行（回退策略）
      // 防止因限流系统故障导致业务完全瘫痪
      this.ctx.logger.error('RateLimitService error:', err);
      return true;
    }
  }

  /**
   * 获取用户当前分钟的剩余请求次数（可选功能，供前端显示）
   * @param domainId 域 ID (用于多租户隔离)
   * @param userId 用户 ID
   * @param limitPerMinute 每分钟最大请求次数
   * @returns 剩余请求次数，如果获取失败则返回 null
   */
  async getRemainingRequests(domainId: string, userId: number, limitPerMinute: number): Promise<number | null> {
    try {
      const now = new Date();
      const minuteKey = now.toISOString().slice(0, 16);

      const collection = getRateLimitCollection(this.ctx.db);

      const record = await collection.findOne({
        domainId,
        userId,
        minuteKey
      });

      if (!record) {
        // 没有记录，说明本分钟还未请求过
        return limitPerMinute;
      }

      const remaining = limitPerMinute - record.count;
      return remaining > 0 ? remaining : 0;
    } catch (err) {
      this.ctx.logger.error('RateLimitService getRemainingRequests error:', err);
      return null;
    }
  }
}
