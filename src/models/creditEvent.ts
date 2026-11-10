/**
 * CreditEvent Model - 信誉事件（FR-027–FR-032）
 *
 * 每次扣分、每次重置各一条记录，信誉系数由这些记录推导（plan R8），不建缓存表。
 * 复核为误判时撤销对应扣分（保留记录，写入撤销人、时间、原因）。保留 180 天，与安全日志一致。
 */

import type { Collection, Db, Filter } from 'mongodb';
import type { ObjectIdType } from '../utils/mongo';
import type { CreditCategory } from './configSections';

export type CreditEventType = 'deduction' | 'reset';
export type CreditEventSource = 'realtime' | 'ai_review' | 'manual';

export const CREDIT_EVENT_RETENTION_DAYS = 180;
/** 推导系数时回看的天数：最大差距 0.8、每天恢复 0.05 时 16 天恢复完，30 天前的事件不再有影响 */
export const CREDIT_LOOKBACK_DAYS = 30;

export interface CreditEvent {
  _id: ObjectIdType;
  uid: number;
  at: Date;
  type: CreditEventType;
  source: CreditEventSource;
  category?: CreditCategory;
  deduction?: number;
  /** 本次扣分在 1 小时窗口内是第几次（翻倍次数 k） */
  sequence?: number;
  safetyLogId?: ObjectIdType;
  domainId?: string;
  conversationId?: ObjectIdType;
  revokedAt?: Date;
  revokedBy?: number;
  revokeReason?: string;
  /** AI 抽查处罚的学生通知已确认（PR5） */
  noticeAckAt?: Date;
  /** 手动重置的操作人与原因 */
  actorUid?: number;
  reason?: string;
  expireAt: Date;
}

export type CreditEventInput = Omit<CreditEvent, '_id' | 'expireAt'>;

export class CreditEventModel {
  private collection: Collection<CreditEvent>;

  constructor(db: Db) {
    this.collection = db.collection<CreditEvent>('ai_credit_events');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ uid: 1, at: -1 }, { name: 'idx_uid_at' });
    await this.collection.createIndex({ safetyLogId: 1 }, { name: 'idx_safetyLogId', sparse: true });
    await this.collection.createIndex({ at: -1, type: 1 }, { name: 'idx_at_type' });
    await this.collection.createIndex({ expireAt: 1 }, { name: 'ttl_expireAt', expireAfterSeconds: 0 });
    console.log('[CreditEventModel] Indexes created successfully');
  }

  async insert(input: CreditEventInput): Promise<ObjectIdType> {
    const doc = {
      ...input,
      expireAt: new Date(input.at.getTime() + CREDIT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    };
    const result = await this.collection.insertOne(doc as CreditEvent);
    return result.insertedId;
  }

  async insertMany(inputs: CreditEventInput[]): Promise<number> {
    if (!inputs.length) return 0;
    const docs = inputs.map((input) => ({
      ...input,
      expireAt: new Date(input.at.getTime() + CREDIT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    }));
    const result = await this.collection.insertMany(docs as CreditEvent[]);
    return result.insertedCount;
  }

  /** 一个用户在 since 之后的全部事件（含已撤销），按时间正序 */
  async listSince(uid: number, since: Date): Promise<CreditEvent[]> {
    return this.collection.find({ uid, at: { $gte: since } }).sort({ at: 1 }).toArray();
  }

  /** 一页用户的事件，一次 $in 查询 */
  async listSinceMany(uids: number[], since: Date): Promise<Map<number, CreditEvent[]>> {
    const out = new Map<number, CreditEvent[]>();
    if (!uids.length) return out;
    const docs = await this.collection.find({ uid: { $in: uids }, at: { $gte: since } }).sort({ at: 1 }).toArray();
    for (const doc of docs) {
      const list = out.get(doc.uid);
      if (list) list.push(doc);
      else out.set(doc.uid, [doc]);
    }
    return out;
  }

  /** since 之后有未撤销扣分的用户（学生总览“信誉降低”筛选的候选集） */
  async uidsWithDeductionsSince(since: Date, limit = 20000): Promise<number[]> {
    const uids = await this.collection.distinct('uid', {
      type: 'deduction',
      at: { $gte: since },
      revokedAt: { $exists: false },
    } as Filter<CreditEvent>);
    return (uids as number[]).slice(0, limit);
  }

  /** 撤销关联到某条安全记录的扣分，返回被撤销的事件（撤销前） */
  async revokeBySafetyLog(safetyLogId: ObjectIdType, revokedBy: number, reason: string, at: Date): Promise<CreditEvent[]> {
    const filter: Filter<CreditEvent> = { safetyLogId, type: 'deduction', revokedAt: { $exists: false } };
    const targets = await this.collection.find(filter).toArray();
    if (!targets.length) return [];
    await this.collection.updateMany(
      { _id: { $in: targets.map((doc) => doc._id) }, revokedAt: { $exists: false } },
      { $set: { revokedAt: at, revokedBy, revokeReason: reason } },
    );
    return targets;
  }
}
