"use strict";
/**
 * AIAccessAudit Model - AI 访问策略变更审计日志
 *
 * 每次策略创建/修改/删除都写入一条记录（谁、何时、改了什么、前后快照）。
 * 永久保留，便于追溯学生额度和禁用的来源。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIAccessAuditModel = void 0;
function snapshot(policy) {
    if (!policy)
        return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, ...rest } = policy;
    return rest;
}
class AIAccessAuditModel {
    constructor(db) {
        this.collection = db.collection('ai_access_audit');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ domainId: 1, createdAt: -1 }, { name: 'idx_domainId_createdAt' });
        await this.collection.createIndex({ domainId: 1, scope: 1, target: 1, createdAt: -1 }, { name: 'idx_domainId_scope_target_createdAt' });
        console.log('[AIAccessAuditModel] Indexes created successfully');
    }
    async record(params) {
        await this.collection.insertOne({
            domainId: params.domainId,
            scope: params.scope,
            target: params.target,
            action: params.action,
            before: snapshot(params.before),
            after: snapshot(params.after),
            operatorUid: params.operatorUid,
            ...(params.batchId ? { batchId: params.batchId } : {}),
            createdAt: new Date(),
        });
    }
    async list(domainId, options = {}) {
        const query = { domainId };
        if (options.scope)
            query.scope = options.scope;
        if (options.target !== undefined)
            query.target = options.target;
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
        return this.collection
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
    }
}
exports.AIAccessAuditModel = AIAccessAuditModel;
//# sourceMappingURL=aiAccessAudit.js.map