/**
 * QuotaOverride Model - 个人覆盖（FR-025）
 *
 * 每个用户最多一条（_id = uid）：指定每日次数或禁用 AI，可设到期时间，须填写原因。
 * 到期后由 TTL 清理；TTL 有延迟，解析时仍按 expiresAt 判断是否生效。
 */

import type { Collection, Db } from 'mongodb';
import { unwrapModifyResult } from '../utils/mongo';

export type QuotaOverrideMode = 'limit' | 'disabled';

export interface QuotaOverride {
  _id: number;
  mode: QuotaOverrideMode;
  dailyLimit?: number;
  expiresAt?: Date;
  reason: string;
  setBy: number;
  setAt: Date;
}

export interface QuotaOverrideInput {
  mode: QuotaOverrideMode;
  dailyLimit?: number;
  expiresAt?: Date | null;
  reason: string;
  setBy: number;
  setAt: Date;
}

export class QuotaOverrideModel {
  private collection: Collection<QuotaOverride>;

  constructor(db: Db) {
    this.collection = db.collection<QuotaOverride>('ai_quota_overrides');
  }

  async ensureIndexes(): Promise<void> {
    // 未设置 expiresAt 的文档不会被 TTL 删除（永不过期）
    await this.collection.createIndex({ expiresAt: 1 }, { name: 'ttl_expiresAt', expireAfterSeconds: 0 });
    await this.collection.createIndex({ setAt: -1 }, { name: 'idx_setAt' });
    console.log('[QuotaOverrideModel] Indexes created successfully');
  }

  async get(uid: number): Promise<QuotaOverride | null> {
    return this.collection.findOne({ _id: uid });
  }

  async getMany(uids: number[]): Promise<QuotaOverride[]> {
    if (!uids.length) return [];
    return this.collection.find({ _id: { $in: uids } }).toArray();
  }

  /** 当前有效（未到期）的覆盖，按设置时间倒序 */
  async listActive(now: Date, limit = 500): Promise<{ items: QuotaOverride[]; total: number }> {
    const filter = { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] };
    const [items, total] = await Promise.all([
      this.collection.find(filter).sort({ setAt: -1 }).limit(limit).toArray(),
      this.collection.countDocuments(filter),
    ]);
    return { items, total };
  }

  /** 设置当前有效覆盖的用户 uid（用于“AI 已关闭”等筛选） */
  async activeUids(now: Date, mode?: QuotaOverrideMode): Promise<number[]> {
    const filter: Record<string, unknown> = { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] };
    if (mode) filter.mode = mode;
    const docs = await this.collection.find(filter, { projection: { _id: 1 } }).limit(20000).toArray();
    return docs.map((doc) => doc._id);
  }

  /** 设置（覆盖已有），返回设置前的文档 */
  async set(uid: number, input: QuotaOverrideInput): Promise<QuotaOverride | null> {
    const $set: Record<string, unknown> = {
      mode: input.mode,
      reason: input.reason,
      setBy: input.setBy,
      setAt: input.setAt,
    };
    const $unset: Record<string, ''> = {};
    if (input.mode === 'limit') $set.dailyLimit = input.dailyLimit;
    else $unset.dailyLimit = '';
    if (input.expiresAt) $set.expiresAt = input.expiresAt;
    else $unset.expiresAt = '';
    const update: Record<string, unknown> = { $set };
    if (Object.keys($unset).length) update.$unset = $unset;
    return unwrapModifyResult<QuotaOverride>(await this.collection.findOneAndUpdate(
      { _id: uid },
      update,
      { upsert: true, returnDocument: 'before' },
    ));
  }

  /** 清除，返回清除前的文档（不存在时为 null） */
  async clear(uid: number): Promise<QuotaOverride | null> {
    return unwrapModifyResult<QuotaOverride>(await this.collection.findOneAndDelete({ _id: uid }));
  }
}
