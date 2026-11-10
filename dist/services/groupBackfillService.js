"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupBackfillService = exports.BACKFILL_TIME_BUDGET_MS = exports.BACKFILL_MAX_PER_CALL = exports.BACKFILL_BATCH_SIZE = void 0;
const hydroCompat_1 = require("../utils/hydroCompat");
exports.BACKFILL_BATCH_SIZE = 500;
exports.BACKFILL_MAX_PER_CALL = 20000;
exports.BACKFILL_TIME_BUDGET_MS = 20000;
const PENDING = { groupNames: { $exists: false } };
class GroupBackfillService {
    constructor(db, audit, now = Date.now) {
        this.audit = audit;
        this.now = now;
        this.conversations = db.collection('ai_conversations');
        this.groups = (0, hydroCompat_1.groupColl)(db);
    }
    async countPending(domainId) {
        return this.conversations.countDocuments({ domainId, ...PENDING });
    }
    /** 本域每名学生当前所在的小组（与建会话时的快照规则一致：排除纯数字名称，排序去重） */
    async membership(domainId) {
        const docs = await this.groups
            .find({ domainId }, { projection: { name: 1, uids: 1 } })
            .toArray();
        const byUid = new Map();
        let groupCount = 0;
        for (const doc of docs) {
            if (typeof doc.name !== 'string' || /^\d+$/.test(doc.name))
                continue;
            groupCount += 1;
            for (const uid of doc.uids || []) {
                if (typeof uid !== 'number')
                    continue;
                const names = byUid.get(uid) ?? new Set();
                names.add(doc.name);
                byUid.set(uid, names);
            }
        }
        return {
            byUid: new Map([...byUid].map(([uid, names]) => [uid, [...names].sort()])),
            groupCount,
        };
    }
    async run(domainId, actorUid) {
        const startedAt = this.now();
        const { byUid, groupCount } = await this.membership(domainId);
        let updated = 0;
        let partial = false;
        for (;;) {
            if (updated >= exports.BACKFILL_MAX_PER_CALL || this.now() - startedAt >= exports.BACKFILL_TIME_BUDGET_MS) {
                partial = true;
                break;
            }
            const batch = await this.conversations
                .find({ domainId, ...PENDING }, { projection: { _id: 1, userId: 1 } })
                .limit(exports.BACKFILL_BATCH_SIZE)
                .toArray();
            if (!batch.length)
                break;
            // 小组组合相同的学生合并成一次写入（同班学生通常组合相同）
            const bySignature = new Map();
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
                { _id: { $in: ids }, ...PENDING }, { $set: { groupNames: names, groupSource: 'backfill' } });
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
            }
            catch (err) {
                console.error('[AI-Helper] group backfill audit failed:', err instanceof Error ? err.message : String(err));
            }
        }
        return { updated, remaining, partial: partial && remaining > 0 };
    }
}
exports.GroupBackfillService = GroupBackfillService;
//# sourceMappingURL=groupBackfillService.js.map