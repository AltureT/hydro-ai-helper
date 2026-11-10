"use strict";
/**
 * QuotaGroup Model - 额度组（FR-021–FR-023）
 *
 * 插件级分组，不属于任何域；成员 = 直接添加的用户 ∪ 关联 Hydro 小组的当前成员。
 * - 授予型（grant）：每日 N 次（N ≥ 1），用户所属授予型组取最大；
 * - 限制型（cap）：每日最多 N 次（N ≥ 0，0 = 关闭 AI），取最小。
 * 停用的组保留配置与成员，但不参与计算。
 *
 * 成员与关联只用原子 `$addToSet` / `$pull`，并以写前文档算出实际变化（与小组写入一致）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaGroupModel = exports.QuotaGroupNameTakenError = void 0;
exports.toObjectId = toObjectId;
const mongo_1 = require("../utils/mongo");
class QuotaGroupNameTakenError extends Error {
    constructor() {
        super('QUOTA_GROUP_NAME_TAKEN');
        this.name = 'QuotaGroupNameTakenError';
    }
}
exports.QuotaGroupNameTakenError = QuotaGroupNameTakenError;
function isDuplicateKey(err) {
    return !!err && typeof err === 'object' && err.code === 11000;
}
function toObjectId(id) {
    if (typeof id !== 'string')
        return id;
    return mongo_1.ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new mongo_1.ObjectId(id) : null;
}
class QuotaGroupModel {
    constructor(db) {
        this.collection = db.collection('ai_quota_groups');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ name: 1 }, { name: 'uniq_name', unique: true });
        await this.collection.createIndex({ memberUids: 1 }, { name: 'idx_memberUids' });
        console.log('[QuotaGroupModel] Indexes created successfully');
    }
    /** 额度组数量很少，一次读出全部 */
    async list() {
        return this.collection.find({}).sort({ name: 1 }).limit(1000).toArray();
    }
    async get(id) {
        const _id = toObjectId(id);
        return _id ? this.collection.findOne({ _id }) : null;
    }
    async create(input) {
        if (await this.collection.findOne({ name: input.name }))
            throw new QuotaGroupNameTakenError();
        const now = input.now ?? new Date();
        const doc = {
            _id: new mongo_1.ObjectId(),
            name: input.name,
            mode: input.mode,
            dailyLimit: input.dailyLimit,
            enabled: input.enabled,
            memberUids: [],
            linkedGroups: [],
            createdBy: input.createdBy,
            createdAt: now,
            updatedAt: now,
        };
        try {
            await this.collection.insertOne(doc);
        }
        catch (err) {
            if (isDuplicateKey(err))
                throw new QuotaGroupNameTakenError();
            throw err;
        }
        return doc;
    }
    /** 修改名称、类型、次数、启停；返回 { before, after }，不存在时为 null */
    async update(id, patch, now = new Date()) {
        if (patch.name !== undefined) {
            const clash = await this.collection.findOne({ name: patch.name });
            if (clash && String(clash._id) !== String(id))
                throw new QuotaGroupNameTakenError();
        }
        const $set = { updatedAt: now };
        for (const key of ['name', 'mode', 'dailyLimit', 'enabled']) {
            if (patch[key] !== undefined)
                $set[key] = patch[key];
        }
        let raw;
        try {
            raw = await this.collection.findOneAndUpdate({ _id: id }, { $set }, { returnDocument: 'before' });
        }
        catch (err) {
            if (isDuplicateKey(err))
                throw new QuotaGroupNameTakenError();
            throw err;
        }
        const before = (0, mongo_1.unwrapModifyResult)(raw);
        if (!before)
            return null;
        return { before, after: { ...before, ...$set } };
    }
    async delete(id) {
        return (0, mongo_1.unwrapModifyResult)(await this.collection.findOneAndDelete({ _id: id }));
    }
    /** 原子加入成员，返回实际新加入的 uid；组不存在时返回 null */
    async addMembers(id, uids, now = new Date()) {
        const before = (0, mongo_1.unwrapModifyResult)(await this.collection.findOneAndUpdate({ _id: id }, { $addToSet: { memberUids: { $each: uids } }, $set: { updatedAt: now } }, { returnDocument: 'before' }));
        if (!before)
            return null;
        const existing = new Set(before.memberUids || []);
        return uids.filter((uid) => !existing.has(uid));
    }
    /** 原子移出成员，返回实际被移出的 uid；组不存在时返回 null */
    async removeMembers(id, uids, now = new Date()) {
        const before = (0, mongo_1.unwrapModifyResult)(await this.collection.findOneAndUpdate({ _id: id }, { $pull: { memberUids: { $in: uids } }, $set: { updatedAt: now } }, { returnDocument: 'before' }));
        if (!before)
            return null;
        const existing = new Set(before.memberUids || []);
        return uids.filter((uid) => existing.has(uid));
    }
    /** 关联 Hydro 小组；返回是否新增（已关联时为 false），组不存在时为 null */
    async link(id, link, now = new Date()) {
        const entry = { domainId: link.domainId, name: link.name };
        const before = (0, mongo_1.unwrapModifyResult)(await this.collection.findOneAndUpdate({ _id: id }, { $addToSet: { linkedGroups: entry }, $set: { updatedAt: now } }, { returnDocument: 'before' }));
        if (!before)
            return null;
        return !(before.linkedGroups || []).some((item) => item.domainId === link.domainId && item.name === link.name);
    }
    /** 取消关联；返回是否确有移除，组不存在时为 null */
    async unlink(id, link, now = new Date()) {
        const before = (0, mongo_1.unwrapModifyResult)(await this.collection.findOneAndUpdate({ _id: id }, { $pull: { linkedGroups: { domainId: link.domainId, name: link.name } }, $set: { updatedAt: now } }, { returnDocument: 'before' }));
        if (!before)
            return null;
        return (before.linkedGroups || []).some((item) => item.domainId === link.domainId && item.name === link.name);
    }
}
exports.QuotaGroupModel = QuotaGroupModel;
//# sourceMappingURL=quotaGroup.js.map