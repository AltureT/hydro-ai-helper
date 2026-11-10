/**
 * 历史会话小组回填（FR-057，plan R16）
 *
 * 升级前的会话没有 groupNames。系统管理员在统计页手动触发，按学生“当前”所在的小组补写，
 * 并标记 groupSource: 'backfill'，以便与建会话时的快照区分。
 *
 * - 只处理没有 groupNames 字段的会话；学生当前不在任何小组时写入空数组，下次不再处理。
 * - 分批执行：每批 500 条，单次调用最多处理 MAX_PER_CALL 条或 TIME_BUDGET_MS，返回剩余数量，
 *   前端按“继续回填”再次调用。
 * - 只写本插件的 ai_conversations，不改 Hydro 的数据。
 */

import type { Collection, Db } from 'mongodb';
import type { Conversation } from '../models/conversation';
import type { ObjectIdType } from '../utils/mongo';
import { groupColl, type HydroGroupDoc } from '../utils/hydroCompat';
import { AuditService } from './auditService';

export const BACKFILL_BATCH_SIZE = 500;
export const BACKFILL_MAX_PER_CALL = 20000;
export const BACKFILL_TIME_BUDGET_MS = 20000;

const PENDING = { groupNames: { $exists: false } } as const;

export interface BackfillResult {
  updated: number;
  remaining: number;
  /** 本次因时间或数量上限提前停止 */
  partial: boolean;
}

export class GroupBackfillService {
  private readonly conversations: Collection<Conversation>;
  private readonly groups: Collection<HydroGroupDoc>;

  constructor(
    db: Db,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.conversations = db.collection<Conversation>('ai_conversations');
    this.groups = groupColl(db);
  }

  async countPending(domainId: string): Promise<number> {
    return this.conversations.countDocuments({ domainId, ...PENDING });
  }

  /** 本域每名学生当前所在的小组（与建会话时的快照规则一致：排除纯数字名称，排序去重） */
  private async membership(domainId: string): Promise<{ byUid: Map<number, string[]>; groupCount: number }> {
    const docs = await this.groups
      .find({ domainId }, { projection: { name: 1, uids: 1 } })
      .toArray();
    const byUid = new Map<number, Set<string>>();
    let groupCount = 0;
    for (const doc of docs) {
      if (typeof doc.name !== 'string' || /^\d+$/.test(doc.name)) continue;
      groupCount += 1;
      for (const uid of doc.uids || []) {
        if (typeof uid !== 'number') continue;
        const names = byUid.get(uid) ?? new Set<string>();
        names.add(doc.name);
        byUid.set(uid, names);
      }
    }
    return {
      byUid: new Map([...byUid].map(([uid, names]) => [uid, [...names].sort()])),
      groupCount,
    };
  }

  async run(domainId: string, actorUid: number): Promise<BackfillResult> {
    const startedAt = this.now();
    const { byUid, groupCount } = await this.membership(domainId);
    let updated = 0;
    let partial = false;

    for (;;) {
      if (updated >= BACKFILL_MAX_PER_CALL || this.now() - startedAt >= BACKFILL_TIME_BUDGET_MS) {
        partial = true;
        break;
      }
      const batch = await this.conversations
        .find({ domainId, ...PENDING }, { projection: { _id: 1, userId: 1 } })
        .limit(BACKFILL_BATCH_SIZE)
        .toArray();
      if (!batch.length) break;

      // 小组组合相同的学生合并成一次写入（同班学生通常组合相同）
      const bySignature = new Map<string, { names: string[]; ids: ObjectIdType[] }>();
      for (const conv of batch) {
        const names = byUid.get(conv.userId) || [];
        const signature = names.join('\u0000');
        const entry = bySignature.get(signature) ?? { names, ids: [] };
        entry.ids.push(conv._id);
        bySignature.set(signature, entry);
      }
      let batchUpdated = 0;
      for (const { names, ids } of bySignature.values()) {
        const result = await this.conversations.updateMany(
          // 再次限定“没有小组记录”，不覆盖并发写入的快照
          { _id: { $in: ids }, ...PENDING },
          { $set: { groupNames: names, groupSource: 'backfill' } },
        );
        batchUpdated += result.modifiedCount ?? 0;
      }
      updated += batchUpdated;
      // 整批都被别的进程抢先写入时也会前进；整批未变化且仍能查到说明写入失效，避免死循环
      if (batchUpdated === 0) {
        partial = true;
        break;
      }
    }

    const remaining = await this.countPending(domainId);
    if (updated > 0) {
      try {
        await this.audit.record({
          actorUid,
          action: 'group.backfill',
          domainId,
          target: { type: 'domain', id: domainId },
          detail: { updated, remaining, groupCount },
          undoable: false,
        });
      } catch (err) {
        console.error('[AI-Helper] group backfill audit failed:', err instanceof Error ? err.message : String(err));
      }
    }
    return { updated, remaining, partial: partial && remaining > 0 };
  }
}
