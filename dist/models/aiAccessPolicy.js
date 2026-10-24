"use strict";
/**
 * AIAccessPolicy Model - 按用户/用户组的 AI 访问策略
 *
 * 管理员手动控制（与 safetyPenaltyService 的自动冷却相互独立）：
 * - 禁用指定账号或用户组
 * - 覆盖每用户日 token 上限（0 = 不限）
 * - 当日一次性追加额度
 * - 覆盖每分钟请求频率
 *
 * 文档以 { domainId, scope, target } 唯一定位：
 * - scope = 'user'  → target 为 uid (number)
 * - scope = 'group' → target 为 HydroOJ 域用户组名 (string)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIAccessPolicyModel = exports.ACCESS_POLICY_SCOPES = void 0;
exports.ACCESS_POLICY_SCOPES = ['user', 'group'];
const PATCHABLE_FIELDS = ['enabled', 'dailyTokenLimit', 'extraTokens', 'rateLimitPerMinute', 'expiresAt', 'reason'];
class AIAccessPolicyModel {
    constructor(db) {
        this.collection = db.collection('ai_access_policies');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ domainId: 1, scope: 1, target: 1 }, { unique: true, name: 'idx_domainId_scope_target_unique' });
        console.log('[AIAccessPolicyModel] Indexes created successfully');
    }
    /**
     * 一次查询取出某用户相关的全部策略（用户级 + 所属组）
     */
    async findForUser(domainId, uid, groupNames) {
        const or = [{ scope: 'user', target: uid }];
        if (groupNames.length > 0)
            or.push({ scope: 'group', target: { $in: groupNames } });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.collection.find({ domainId, $or: or }).toArray();
    }
    async get(domainId, scope, target) {
        return this.collection.findOne({ domainId, scope, target });
    }
    async list(domainId, scope, targets) {
        const query = { domainId };
        if (scope)
            query.scope = scope;
        if (targets)
            query.target = { $in: targets };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.collection.find(query).sort({ updatedAt: -1 }).limit(5000).toArray();
    }
    /**
     * 创建或修改策略，返回修改前后的文档（供审计）
     */
    async upsert(domainId, scope, target, patch, updatedBy) {
        const before = await this.get(domainId, scope, target);
        const $set = { updatedBy, updatedAt: new Date() };
        const $unset = {};
        for (const field of PATCHABLE_FIELDS) {
            const value = patch[field];
            if (value === undefined)
                continue;
            if (value === null)
                $unset[field] = '';
            else
                $set[field] = value;
        }
        const update = {
            $set,
            $setOnInsert: patch.enabled === undefined
                ? { domainId, scope, target, enabled: true }
                : { domainId, scope, target },
        };
        if (Object.keys($unset).length > 0)
            update.$unset = $unset;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.collection.updateOne({ domainId, scope, target }, update, { upsert: true });
        const after = await this.get(domainId, scope, target);
        return { before, after };
    }
    async delete(domainId, scope, target) {
        const before = await this.get(domainId, scope, target);
        if (before)
            await this.collection.deleteOne({ domainId, scope, target });
        return before;
    }
}
exports.AIAccessPolicyModel = AIAccessPolicyModel;
//# sourceMappingURL=aiAccessPolicy.js.map