/**
 * Rate Limit 辅助查询模块
 *
 * 限流逻辑已迁移到 HydroOJ 内置 limitRate (opcount 模型)。
 * 本文件仅保留 getRemainingRequests() 供前端剩余配额展示使用。
 *
 * @deprecated RateLimitService 类已移除，请使用 src/lib/rateLimitHelper.ts 中的 applyRateLimit()
 */

import type { Db } from 'mongodb';

/**
 * 查询用户当前分钟内在 ai_chat 操作上的剩余请求次数。
 * 通过读取 HydroOJ 的 opcount 集合实现。
 *
 * @param db MongoDB Database 对象
 * @param userId 用户 ID
 * @param maxPerMinute 每分钟最大请求次数
 * @returns 剩余请求次数，如果获取失败则返回 null
 */
export async function getRemainingRequests(
  db: Db,
  userId: number,
  maxPerMinute: number
): Promise<number | null> {
  try {
    const coll = db.collection('opcount');
    const now = new Date();

    // opcount 记录的 key 格式取决于 HydroOJ 版本，
    // 通常包含 op 名称和用户标识。查找最近 60 秒内的记录。
    const _cutoff = new Date(now.getTime() - 60 * 1000);

    const record = await coll.findOne({
      op: 'ai_chat',
      ident: String(userId),
      expireAt: { $gt: now },
    });

    if (!record) {
      return maxPerMinute;
    }

    const remaining = maxPerMinute - (record.opcount || 0);
    return remaining > 0 ? remaining : 0;
  } catch (err) {
    console.error('[RateLimit] getRemainingRequests error:', err);
    return null;
  }
}
