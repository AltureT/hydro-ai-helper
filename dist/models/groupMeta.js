"use strict";
/**
 * GroupMeta Model - Hydro 小组的插件扩展信息（FR-009/010）
 *
 * Hydro 原生小组只有 { domainId, name, uids }。插件额外保存：
 * - 类型、学年、负责老师、归档状态
 * - pluginAdded 台账：由插件加入、尚未由插件移出的成员。
 *   “漂移” = pluginAdded − 当前 uids，通常是 Hydro 原生页面用旧列表覆盖所致（plan R3）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupMetaModel = void 0;
exports.groupMetaId = groupMetaId;
exports.guessGroupKind = guessGroupKind;
const mongo_1 = require("../utils/mongo");
function groupMetaId(domainId, name) {
    return `${domainId}:${name}`;
}
/** 名称形如“2023级1班”时默认视为班级组 */
function guessGroupKind(name) {
    return /^\d{4}级.+班$/.test(name) ? 'class' : 'other';
}
class GroupMetaModel {
    constructor(db) {
        this.collection = db.collection('ai_group_meta');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ domainId: 1, archived: 1 }, { name: 'idx_domainId_archived' });
        await this.collection.createIndex({ teacherUids: 1 }, { name: 'idx_teacherUids' });
        console.log('[GroupMetaModel] Indexes created successfully');
    }
    insertDefaults(domainId, name, actorUid, now) {
        return {
            domainId,
            name,
            kind: guessGroupKind(name),
            teacherUids: [],
            archived: false,
            ...(actorUid !== undefined ? { createdBy: actorUid } : {}),
            createdAt: now,
        };
    }
    async listByDomain(domainId) {
        return this.collection.find({ domainId }).toArray();
    }
    async get(domainId, name) {
        return this.collection.findOne({ _id: groupMetaId(domainId, name) });
    }
    /** 更新扩展信息，返回更新前的文档（不存在时为 null） */
    async update(domainId, name, patch, actorUid) {
        const now = new Date();
        const set = { updatedAt: now };
        const unset = {};
        if (patch.kind !== undefined)
            set.kind = patch.kind;
        if (patch.teacherUids !== undefined)
            set.teacherUids = patch.teacherUids;
        if (patch.archived !== undefined)
            set.archived = patch.archived;
        if (patch.academicYear !== undefined) {
            if (patch.academicYear)
                set.academicYear = patch.academicYear;
            else
                unset.academicYear = '';
        }
        const defaults = this.insertDefaults(domainId, name, actorUid, now);
        const setOnInsert = { pluginAdded: [] };
        for (const [key, value] of Object.entries(defaults)) {
            if (!(key in set) && !(key in unset))
                setOnInsert[key] = value;
        }
        const raw = await this.collection.findOneAndUpdate({ _id: groupMetaId(domainId, name) }, {
            $set: set,
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
            $setOnInsert: setOnInsert,
        }, { upsert: true, returnDocument: 'before' });
        return (0, mongo_1.unwrapModifyResult)(raw);
    }
    /** 台账：记录由插件加入的成员 */
    async addPluginAdded(domainId, name, uids, actorUid) {
        if (!uids.length)
            return;
        const now = new Date();
        await this.collection.updateOne({ _id: groupMetaId(domainId, name) }, {
            $addToSet: { pluginAdded: { $each: uids } },
            $set: { updatedAt: now },
            $setOnInsert: this.insertDefaults(domainId, name, actorUid, now),
        }, { upsert: true });
    }
    /** 台账：移除成员，返回移除前确实在台账中的 uid */
    async removePluginAdded(domainId, name, uids) {
        if (!uids.length)
            return [];
        const raw = await this.collection.findOneAndUpdate({ _id: groupMetaId(domainId, name) }, { $pull: { pluginAdded: { $in: uids } }, $set: { updatedAt: new Date() } }, { returnDocument: 'before' });
        const before = (0, mongo_1.unwrapModifyResult)(raw);
        const ledger = new Set(before?.pluginAdded || []);
        return uids.filter((uid) => ledger.has(uid));
    }
    async delete(domainId, name) {
        const raw = await this.collection.findOneAndDelete({ _id: groupMetaId(domainId, name) });
        return (0, mongo_1.unwrapModifyResult)(raw);
    }
}
exports.GroupMetaModel = GroupMetaModel;
//# sourceMappingURL=groupMeta.js.map