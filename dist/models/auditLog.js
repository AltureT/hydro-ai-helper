"use strict";
/**
 * AuditLog Model - 用户管理操作审计（FR-059/060）
 *
 * 记录插件发起的小组成员变更、额度与覆盖、信誉、AI 抽查等管理动作。
 * 只保存必要的短片段，保留期与安全日志一致（180 天 TTL）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogModel = exports.AUDIT_ACTIONS = exports.AUDIT_CATEGORIES = exports.AUDIT_RETENTION_DAYS = void 0;
exports.auditCategoryOf = auditCategoryOf;
const mongo_1 = require("../utils/mongo");
exports.AUDIT_RETENTION_DAYS = 180;
const AUDIT_RETENTION_MS = exports.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
exports.AUDIT_CATEGORIES = [
    'group', 'transfer', 'quota', 'credit', 'review', 'settings',
];
exports.AUDIT_ACTIONS = [
    'group.add',
    'group.remove',
    'group.drift_restore',
    'group.drift_dismiss',
    'group.meta',
    'settings.teacher_access',
];
function auditCategoryOf(action) {
    return action.split('.')[0];
}
class AuditLogModel {
    constructor(db) {
        this.collection = db.collection('ai_audit_logs');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ at: -1 }, { name: 'idx_at' });
        await this.collection.createIndex({ domainId: 1, at: -1 }, { name: 'idx_domainId_at' });
        await this.collection.createIndex({ category: 1, at: -1 }, { name: 'idx_category_at' });
        await this.collection.createIndex({ 'target.type': 1, 'target.id': 1 }, { name: 'idx_target' });
        await this.collection.createIndex({ expireAt: 1 }, { name: 'idx_expireAt_ttl', expireAfterSeconds: 0 });
        console.log('[AuditLogModel] Indexes created successfully');
    }
    async insert(data) {
        const at = data.at ?? new Date();
        const doc = {
            ...data,
            at,
            category: auditCategoryOf(data.action),
            expireAt: new Date(at.getTime() + AUDIT_RETENTION_MS),
        };
        const result = await this.collection.insertOne(doc);
        return result.insertedId;
    }
    async findById(id) {
        const _id = typeof id === 'string' ? new mongo_1.ObjectId(id) : id;
        return this.collection.findOne({ _id });
    }
    async appendStep(id, step) {
        await this.collection.updateOne({ _id: id }, { $push: { steps: step } });
    }
    /** 只合并新的 detail 字段，不覆盖整份 detail */
    async mergeDetail(id, patch) {
        const set = {};
        for (const [key, value] of Object.entries(patch))
            set[`detail.${key}`] = value;
        if (Object.keys(set).length)
            await this.collection.updateOne({ _id: id }, { $set: set });
    }
    /**
     * 原子地把记录标记为已撤销。已撤销或不可撤销时返回 null，保证同一操作只会被撤销一次。
     */
    async claimUndo(id, undoneBy, at = new Date()) {
        const raw = await this.collection.findOneAndUpdate({ _id: id, undoable: true, undoneAt: { $exists: false } }, { $set: { undoneAt: at, undoneBy } }, { returnDocument: 'before' });
        return (0, mongo_1.unwrapModifyResult)(raw);
    }
    /** 撤销执行失败时回滚撤销标记，允许管理员重试 */
    async releaseUndo(id) {
        await this.collection.updateOne({ _id: id }, { $unset: { undoneAt: '', undoneBy: '' } });
    }
    async list(filters, page = 1, limit = 20) {
        const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 20));
        const safePage = Math.max(1, Math.floor(page) || 1);
        const query = {};
        if (filters.category)
            query.category = filters.category;
        if (filters.action)
            query.action = filters.action;
        if (filters.actorType === 'system')
            query.actorUid = { $exists: false };
        else if (filters.actorUid !== undefined)
            query.actorUid = filters.actorUid;
        if (filters.domainId)
            query.domainId = filters.domainId;
        if (filters.targetType)
            query['target.type'] = filters.targetType;
        if (filters.targetId)
            query['target.id'] = filters.targetId;
        if (filters.from || filters.to) {
            query.at = {
                ...(filters.from ? { $gte: filters.from } : {}),
                ...(filters.to ? { $lte: filters.to } : {}),
            };
        }
        const [logs, total] = await Promise.all([
            this.collection.find(query).sort({ at: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).toArray(),
            this.collection.countDocuments(query),
        ]);
        return { logs, total, page: safePage, totalPages: Math.ceil(total / safeLimit) };
    }
}
exports.AuditLogModel = AuditLogModel;
//# sourceMappingURL=auditLog.js.map