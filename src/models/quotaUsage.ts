/**
 * QuotaUsage Model - 每日 AI 次数（plan R5，FR-011–016）
 *
 * 每个“用户 + 日期”一个文档：`_id = "${uid}:${date}"`，日期按配置时区计算，跨域合计。
 * 并发控制用“预占 → 确认 / 退还”：
 * - 预占：先清理过期预占，再用带 $expr 条件的原子 $push 追加预占；
 *   条件 `used + 预占数 < limit` 与追加在同一次文档更新内完成，并发请求不会超额。
 * - 确认：移除预占并 used + 1；预占已过期被清理时退化为直接 used + 1。
 * - 退还：移除预占。
 * - 不限额：不预占，成功时仍 used + 1，供统计显示。
 */

import type { Collection, Db } from 'mongodb';
import { unwrapModifyResult } from '../utils/mongo';

export const QUOTA_USAGE_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface QuotaReservationEntry {
  id: string;
  at: Date;
}

export interface QuotaUsage {
  _id: string;          // `${uid}:${date}`
  uid: number;
  date: string;         // YYYY-MM-DD（配置时区）
  used: number;
  reservations: QuotaReservationEntry[];
  updatedAt: Date;
  expireAt: Date;
}

export function quotaUsageId(uid: number, date: string): string {
  return `${uid}:${date}`;
}

function expireAtFor(date: string): Date {
  const start = Date.parse(`${date}T00:00:00Z`);
  return new Date((Number.isNaN(start) ? Date.now() : start) + QUOTA_USAGE_RETENTION_DAYS * DAY_MS);
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

export class QuotaUsageModel {
  private collection: Collection<QuotaUsage>;

  constructor(db: Db) {
    this.collection = db.collection<QuotaUsage>('ai_quota_usage');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ expireAt: 1 }, { name: 'idx_expireAt_ttl', expireAfterSeconds: 0 });
    await this.collection.createIndex({ date: 1, used: -1 }, { name: 'idx_date_used' });
    console.log('[QuotaUsageModel] Indexes created successfully');
  }

  async get(uid: number, date: string): Promise<QuotaUsage | null> {
    return this.collection.findOne({ _id: quotaUsageId(uid, date) });
  }

  async getMany(uids: number[], date: string): Promise<Map<number, QuotaUsage>> {
    if (!uids.length) return new Map();
    const docs = await this.collection
      .find({ _id: { $in: uids.map((uid) => quotaUsageId(uid, date)) } })
      .toArray();
    return new Map(docs.map((doc) => [doc.uid, doc]));
  }

  private async ensureDoc(uid: number, date: string, now: Date): Promise<void> {
    try {
      await this.collection.updateOne(
        { _id: quotaUsageId(uid, date) },
        {
          $setOnInsert: {
            uid, date, used: 0, reservations: [], updatedAt: now, expireAt: expireAtFor(date),
          },
        },
        { upsert: true },
      );
    } catch (err) {
      // 并发 upsert 撞唯一键：文档已由另一请求创建
      if (!isDuplicateKey(err)) throw err;
    }
  }

  /**
   * 预占一次。成功返回 true；当日已用 + 进行中预占达到 limit 时返回 false。
   * @param staleBefore 早于该时间的预占视为已失效（请求异常中断未退还）
   */
  async reserve(uid: number, date: string, limit: number, reservationId: string, staleBefore: Date, now: Date = new Date()): Promise<boolean> {
    if (limit <= 0) return false;
    const _id = quotaUsageId(uid, date);
    await this.ensureDoc(uid, date, now);
    await this.collection.updateOne({ _id }, { $pull: { reservations: { at: { $lt: staleBefore } } } });
    const result = await this.collection.updateOne(
      {
        _id,
        $expr: {
          $lt: [
            { $add: [{ $ifNull: ['$used', 0] }, { $size: { $ifNull: ['$reservations', []] } }] },
            limit,
          ],
        },
      },
      {
        $push: { reservations: { id: reservationId, at: now } },
        $set: { updatedAt: now },
      },
    );
    return result.matchedCount === 1;
  }

  /** 确认计次，返回确认后的已用次数 */
  async confirm(uid: number, date: string, reservationId: string, now: Date = new Date()): Promise<number> {
    const _id = quotaUsageId(uid, date);
    const raw = await this.collection.findOneAndUpdate(
      { _id, 'reservations.id': reservationId },
      { $inc: { used: 1 }, $pull: { reservations: { id: reservationId } }, $set: { updatedAt: now } },
      { returnDocument: 'after' },
    );
    const doc = unwrapModifyResult<QuotaUsage>(raw);
    if (doc) return doc.used;
    // 预占已被当作过期清理：仍然计 1 次
    return this.increment(uid, date, now);
  }

  async release(uid: number, date: string, reservationId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: quotaUsageId(uid, date) },
      { $pull: { reservations: { id: reservationId } } },
    );
  }

  /** 不限额时直接计次（也用于确认的退化路径），返回计次后的已用次数 */
  async increment(uid: number, date: string, now: Date = new Date()): Promise<number> {
    const raw = await this.collection.findOneAndUpdate(
      { _id: quotaUsageId(uid, date) },
      {
        $inc: { used: 1 },
        $set: { updatedAt: now },
        $setOnInsert: { uid, date, reservations: [], expireAt: expireAtFor(date) },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return unwrapModifyResult<QuotaUsage>(raw)?.used ?? 1;
  }
}
