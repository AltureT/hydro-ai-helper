"use strict";
/**
 * HydroGroupService - 在 Hydro 原生小组上做批量管理（US1，plan R2–R4）
 *
 * 关键约束：
 * - 成员变更只用原子 `$addToSet` / `$pull`，并取写前文档算出实际变化；绝不对 uids 使用 `$set`
 *   （Hydro 的 `UserModel.updateGroup` 与原生页面都是读-改-写，会丢失并发更新）。
 * - 写入后清除该域用户缓存（含多进程广播），作业可见性立即生效。
 * - 每次写入记审计；撤销只回退该次操作实际做出的改变。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HydroGroupService = exports.GroupServiceError = exports.MAX_TEACHERS_PER_GROUP = exports.SEARCH_MAX_TIME_MS = exports.MAX_REGEX_LENGTH = exports.MAX_BATCH_USERS = void 0;
exports.snapshotGroupNames = snapshotGroupNames;
const hydrooj_1 = require("hydrooj");
const hydroCompat_1 = require("../utils/hydroCompat");
const groupName_1 = require("../utils/groupName");
const mongo_1 = require("../utils/mongo");
exports.MAX_BATCH_USERS = 500;
exports.MAX_REGEX_LENGTH = 64;
exports.SEARCH_MAX_TIME_MS = 2000;
exports.MAX_TEACHERS_PER_GROUP = 50;
/** 业务错误：handler 映射为 4xx */
class GroupServiceError extends Error {
    constructor(code, status, i18nKey, params = []) {
        super(code);
        this.code = code;
        this.status = status;
        this.i18nKey = i18nKey;
        this.params = params;
        this.name = 'GroupServiceError';
    }
}
exports.GroupServiceError = GroupServiceError;
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function sanitizeUids(raw) {
    if (!Array.isArray(raw))
        return null;
    const out = [];
    for (const item of raw) {
        const uid = typeof item === 'string' && /^\d+$/.test(item) ? Number(item) : item;
        if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 1)
            return null;
        if (!out.includes(uid))
            out.push(uid);
    }
    return out;
}
function isMemberRow(row) {
    if (!row)
        return false;
    if ((0, hydroCompat_1.isJoinFlagMembership)())
        return row.join === true;
    return !!row.role && row.role !== 'default' && row.role !== 'guest';
}
function isMaxTimeError(err) {
    const e = err;
    return !!e && (e.code === 50 || e.codeName === 'MaxTimeMSExpired');
}
/**
 * 新建会话时记录学生当时在该域所属的全部小组（FR-055，plan R13）。
 * 走 Hydro 的 (domainId, uids) 索引；失败时返回空数组，不阻塞对话。
 */
async function snapshotGroupNames(db, domainId, userId) {
    try {
        const docs = await (0, hydroCompat_1.groupColl)(db)
            .find({ domainId, uids: userId }, { projection: { name: 1 } })
            .toArray();
        const names = docs.map((doc) => doc.name).filter((name) => typeof name === 'string' && !/^\d+$/.test(name));
        return [...new Set(names)].sort();
    }
    catch (err) {
        console.warn('[AI-Helper] snapshotGroupNames failed:', err instanceof Error ? err.message : String(err));
        return [];
    }
}
class HydroGroupService {
    constructor(db, groupMeta, audit, ctx) {
        this.groupMeta = groupMeta;
        this.audit = audit;
        this.ctx = ctx;
        this.groups = (0, hydroCompat_1.groupColl)(db);
        this.users = db.collection('user');
        this.domainUsers = (0, hydroCompat_1.domainUserColl)(db);
        this.domains = db.collection('domain');
    }
    // ─── 读取 ──────────────────────────────────────────────────────────────────
    async getDomainDoc(domainId) {
        try {
            return (await hydrooj_1.DomainModel.get(domainId)) || null;
        }
        catch {
            return null;
        }
    }
    async unameMap(uids) {
        if (!uids.length)
            return new Map();
        const docs = await this.users
            .find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1 } })
            .toArray();
        return new Map(docs.map((doc) => [doc._id, doc.uname]));
    }
    async listDomains() {
        const docs = await this.domains.find({}, { projection: { _id: 1, name: 1 } }).sort({ _id: 1 }).limit(500).toArray();
        return docs.map((doc) => ({ id: doc._id, name: doc.name || doc._id }));
    }
    /** 本域 Hydro 小组 + 扩展信息 + 人数 + 漂移成员 + 已删除小组 */
    async list(domainId, options = {}) {
        const [ddoc, domains, hydroGroups, metas] = await Promise.all([
            this.getDomainDoc(domainId),
            this.listDomains(),
            this.groups.find({ domainId }, { projection: { name: 1, uids: 1 } }).toArray(),
            this.groupMeta.listByDomain(domainId),
        ]);
        const metaByName = new Map(metas.map((meta) => [meta.name, meta]));
        const groupByName = new Map(hydroGroups.filter((group) => !/^\d+$/.test(group.name)).map((group) => [group.name, group]));
        const names = new Set([...groupByName.keys(), ...metaByName.keys()]);
        const lookupUids = new Set();
        const driftByName = new Map();
        for (const name of names) {
            const meta = metaByName.get(name);
            const current = new Set(groupByName.get(name)?.uids || []);
            const drift = (meta?.pluginAdded || []).filter((uid) => !current.has(uid));
            driftByName.set(name, drift);
            drift.forEach((uid) => lookupUids.add(uid));
            (meta?.teacherUids || []).forEach((uid) => lookupUids.add(uid));
        }
        const unames = await this.unameMap([...lookupUids]);
        const named = (uid) => ({ uid, uname: unames.get(uid) || String(uid) });
        const items = [];
        for (const name of names) {
            const meta = metaByName.get(name);
            if (meta?.archived && !options.includeArchived)
                continue;
            const group = groupByName.get(name);
            items.push({
                name,
                existsInHydro: !!group,
                memberCount: group?.uids?.length || 0,
                meta: meta ? {
                    kind: meta.kind,
                    ...(meta.academicYear ? { academicYear: meta.academicYear } : {}),
                    teacherUids: meta.teacherUids || [],
                    teachers: (meta.teacherUids || []).map(named),
                    archived: !!meta.archived,
                } : null,
                drift: (driftByName.get(name) || []).map(named),
            });
        }
        items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
        return {
            domain: { id: domainId, name: ddoc?.name || domainId },
            domains,
            groups: items,
            joinRoles: (0, hydroCompat_1.allowedJoinRoles)(ddoc),
            defaultJoinRole: (0, hydroCompat_1.defaultJoinRole)(ddoc),
            membership: (0, hydroCompat_1.isJoinFlagMembership)() ? 'join_flag' : 'role',
        };
    }
    // ─── 搜索与预览 ────────────────────────────────────────────────────────────
    async search(domainId, mode, rawQuery, scope) {
        if (typeof rawQuery !== 'string' || !rawQuery.trim()) {
            throw new GroupServiceError('INVALID_QUERY', 400, 'ai_helper_group_search_query_required');
        }
        const filter = {
            _id: { $gt: 1 },
            priv: { $bitsAllSet: Number(hydrooj_1.PRIV.PRIV_USER_PROFILE) },
        };
        let listNames = null;
        if (mode === 'prefix') {
            filter.unameLower = { $regex: `^${escapeRegex(rawQuery.trim().toLowerCase())}` };
        }
        else if (mode === 'regex') {
            const pattern = rawQuery.trim();
            if (pattern.length > exports.MAX_REGEX_LENGTH) {
                throw new GroupServiceError('QUERY_TOO_LONG', 400, 'ai_helper_group_search_regex_too_long', [exports.MAX_REGEX_LENGTH]);
            }
            try {
                // eslint-disable-next-line no-new
                new RegExp(pattern);
            }
            catch {
                throw new GroupServiceError('INVALID_REGEX', 400, 'ai_helper_group_search_regex_invalid');
            }
            filter.uname = { $regex: pattern, $options: 'i' };
        }
        else if (mode === 'list') {
            const seen = new Set();
            listNames = [];
            for (const line of rawQuery.split(/[\r\n\t]+/)) {
                const name = line.trim();
                if (!name || seen.has(name.toLowerCase()))
                    continue;
                seen.add(name.toLowerCase());
                listNames.push(name);
            }
            if (listNames.length > exports.MAX_BATCH_USERS) {
                throw new GroupServiceError('LIST_TOO_LONG', 400, 'ai_helper_group_search_list_too_long', [exports.MAX_BATCH_USERS]);
            }
            filter.unameLower = { $in: listNames.map((name) => name.toLowerCase()) };
        }
        else {
            throw new GroupServiceError('INVALID_SEARCH_MODE', 400, 'ai_helper_group_search_mode_invalid');
        }
        // “本域成员”范围只作用于前缀与正则；粘贴名单是明确点名，始终按全部用户匹配并标注是否本域成员
        if (scope === 'domain' && mode !== 'list') {
            const memberRows = await this.domainUsers
                .find({ domainId, ...(0, hydroCompat_1.memberFilter)() }, { projection: { uid: 1 } })
                .toArray();
            filter._id = { $gt: 1, $in: memberRows.map((row) => row.uid) };
        }
        let docs;
        try {
            docs = await this.users
                .find(filter, { projection: { _id: 1, uname: 1, unameLower: 1, priv: 1 }, maxTimeMS: exports.SEARCH_MAX_TIME_MS })
                .sort({ unameLower: 1 })
                .limit(exports.MAX_BATCH_USERS + 1)
                .toArray();
        }
        catch (err) {
            if (isMaxTimeError(err))
                throw new GroupServiceError('SEARCH_TIMEOUT', 400, 'ai_helper_group_search_timeout');
            throw err;
        }
        if (docs.length > exports.MAX_BATCH_USERS)
            return { users: [], overflow: true };
        const users = await this.annotate(domainId, docs, scope === 'all');
        const result = { users, overflow: false };
        if (listNames) {
            const found = new Set(docs.map((doc) => (doc.unameLower || doc.uname.toLowerCase())));
            result.unmatched = listNames.filter((name) => !found.has(name.toLowerCase()));
        }
        return result;
    }
    /** 标注本域角色、成员、管理者、已在小组；全部域范围时附带所属域 */
    async annotate(domainId, docs, withDomains) {
        if (!docs.length)
            return [];
        const uids = docs.map((doc) => doc._id);
        const [ddoc, rows, groups, memberships] = await Promise.all([
            this.getDomainDoc(domainId),
            this.domainUsers.find({ domainId, uid: { $in: uids } }, { projection: { uid: 1, role: 1, join: 1 } }).toArray(),
            this.groups.find({ domainId, uids: { $in: uids } }, { projection: { name: 1, uids: 1 } }).toArray(),
            withDomains
                ? this.domainUsers.find({ uid: { $in: uids }, ...(0, hydroCompat_1.memberFilter)() }, { projection: { uid: 1, domainId: 1 } }).toArray()
                : Promise.resolve([]),
        ]);
        const rowByUid = new Map(rows.map((row) => [row.uid, row]));
        const uidSet = new Set(uids);
        const groupsByUid = new Map();
        for (const group of groups) {
            if (/^\d+$/.test(group.name))
                continue;
            for (const uid of group.uids || []) {
                if (!uidSet.has(uid))
                    continue;
                const list = groupsByUid.get(uid) || [];
                list.push(group.name);
                groupsByUid.set(uid, list);
            }
        }
        let domainsByUid = new Map();
        if (withDomains && memberships.length) {
            const domainIds = [...new Set(memberships.map((row) => row.domainId))];
            const domainDocs = await this.domains.find({ _id: { $in: domainIds } }, { projection: { _id: 1, name: 1 } }).toArray();
            const domainName = new Map(domainDocs.map((doc) => [doc._id, doc.name || doc._id]));
            domainsByUid = new Map();
            for (const row of memberships) {
                const list = domainsByUid.get(row.uid) || [];
                list.push({ id: row.domainId, name: domainName.get(row.domainId) || row.domainId });
                domainsByUid.set(row.uid, list);
            }
        }
        const editDomain = BigInt(hydrooj_1.PERM.PERM_EDIT_DOMAIN);
        return docs.map((doc) => {
            const row = rowByUid.get(doc._id);
            const isMember = isMemberRow(row);
            const role = isMember ? (row?.role || 'default') : null;
            return {
                uid: doc._id,
                uname: doc.uname,
                role,
                isMember,
                isManager: (isMember && (0, hydroCompat_1.roleHasPerm)(ddoc, role, editDomain)) || (0, hydroCompat_1.hasSystemPriv)(doc.priv),
                groups: (groupsByUid.get(doc._id) || []).sort(),
                ...(withDomains ? { domains: domainsByUid.get(doc._id) || [] } : {}),
            };
        });
    }
    // ─── 写入 ──────────────────────────────────────────────────────────────────
    requireGroupName(raw) {
        const result = (0, groupName_1.validateGroupName)(raw);
        if ('error' in result) {
            throw new GroupServiceError('INVALID_GROUP_NAME', 400, `ai_helper_group_name_err_${result.error}`);
        }
        return result.name;
    }
    requireUids(raw, { allowEmpty = false } = {}) {
        const uids = sanitizeUids(raw);
        if (!uids || (!allowEmpty && !uids.length)) {
            throw new GroupServiceError('INVALID_UIDS', 400, 'ai_helper_group_uids_invalid');
        }
        if (uids.length > exports.MAX_BATCH_USERS) {
            throw new GroupServiceError('TOO_MANY_USERS', 400, 'ai_helper_group_too_many_users', [exports.MAX_BATCH_USERS]);
        }
        return uids;
    }
    /** 原子加入：返回实际新加入的 uid（upsert 时小组不存在则全部视为新加入） */
    async atomicAdd(domainId, name, uids) {
        if (!uids.length)
            return [];
        const raw = await this.groups.findOneAndUpdate({ domainId, name }, { $addToSet: { uids: { $each: uids } } }, { upsert: true, returnDocument: 'before' });
        const before = new Set((0, mongo_1.unwrapModifyResult)(raw)?.uids || []);
        return uids.filter((uid) => !before.has(uid));
    }
    /** 原子移出：返回实际被移出的 uid */
    async atomicRemove(domainId, name, uids) {
        if (!uids.length)
            return [];
        const raw = await this.groups.findOneAndUpdate({ domainId, name }, { $pull: { uids: { $in: uids } } }, { returnDocument: 'before' });
        const before = new Set((0, mongo_1.unwrapModifyResult)(raw)?.uids || []);
        return uids.filter((uid) => before.has(uid));
    }
    async existingUids(uids) {
        if (!uids.length)
            return [];
        const docs = await this.users.find({ _id: { $in: uids, $gt: 1 } }, { projection: { _id: 1 } }).toArray();
        const found = new Set(docs.map((doc) => doc._id));
        return uids.filter((uid) => found.has(uid));
    }
    async nonMembers(domainId, uids) {
        const rows = await this.domainUsers
            .find({ domainId, uid: { $in: uids } }, { projection: { uid: 1, role: 1, join: 1 } })
            .toArray();
        const rowByUid = new Map(rows.map((row) => [row.uid, row]));
        return uids.filter((uid) => !isMemberRow(rowByUid.get(uid)));
    }
    /** 校验“同时加入本域”的角色 */
    async resolveJoinRole(domainId, role) {
        const ddoc = await this.getDomainDoc(domainId);
        if (typeof role !== 'string' || !(0, hydroCompat_1.allowedJoinRoles)(ddoc).includes(role)) {
            throw new GroupServiceError('INVALID_JOIN_ROLE', 400, 'ai_helper_group_join_role_invalid');
        }
        return role;
    }
    async apply(input) {
        const name = this.requireGroupName(input.groupName);
        if (input.action !== 'add' && input.action !== 'remove') {
            throw new GroupServiceError('INVALID_ACTION', 400, 'ai_helper_group_action_invalid');
        }
        const requested = this.requireUids(input.uids);
        const { domainId, actorUid } = input;
        let added = [];
        let removed = [];
        let joined = [];
        let joinRole;
        let ledgerRemoved = [];
        if (input.action === 'add') {
            const uids = await this.existingUids(requested);
            if (input.joinDomain) {
                joinRole = await this.resolveJoinRole(domainId, input.joinDomain.role);
                joined = await this.nonMembers(domainId, uids);
                await (0, hydroCompat_1.joinDomain)(domainId, joined, joinRole);
            }
            added = await this.atomicAdd(domainId, name, uids);
            await this.groupMeta.addPluginAdded(domainId, name, added, actorUid);
        }
        else {
            removed = await this.atomicRemove(domainId, name, requested);
            // 管理员经插件明确移出：同步清出台账（即使此人已不在组内），避免误报漂移
            ledgerRemoved = await this.groupMeta.removePluginAdded(domainId, name, requested);
        }
        if (added.length || removed.length || joined.length)
            (0, hydroCompat_1.clearDomainUserCache)(this.ctx, domainId);
        const changed = new Set([...added, ...removed]);
        const unchanged = requested.filter((uid) => !changed.has(uid));
        let auditId = null;
        try {
            auditId = await this.audit.record({
                actorUid,
                action: input.action === 'add' ? 'group.add' : 'group.remove',
                domainId,
                target: { type: 'group', id: name },
                detail: {
                    requested: requested.length,
                    added,
                    removed,
                    joined,
                    ...(joinRole ? { joinRole } : {}),
                    ledgerRemoved,
                    unchangedCount: unchanged.length,
                },
                undoable: added.length > 0 || removed.length > 0 || joined.length > 0 || ledgerRemoved.length > 0,
            });
        }
        catch (err) {
            console.error('[AI-Helper] group audit record failed:', err instanceof Error ? err.message : String(err));
        }
        return { added, removed, joined, unchanged, auditId: auditId ? auditId.toHexString() : null };
    }
    // ─── 撤销 ──────────────────────────────────────────────────────────────────
    async undo(domainId, auditIdRaw, actorUid) {
        if (typeof auditIdRaw !== 'string' || !mongo_1.ObjectId.isValid(auditIdRaw)) {
            throw new GroupServiceError('INVALID_AUDIT_ID', 400, 'ai_helper_group_undo_invalid');
        }
        const id = new mongo_1.ObjectId(auditIdRaw);
        const existing = await this.audit.findById(id);
        if (!existing || existing.category !== 'group') {
            throw new GroupServiceError('AUDIT_NOT_FOUND', 404, 'ai_helper_group_undo_not_found');
        }
        if (existing.domainId !== domainId) {
            throw new GroupServiceError('AUDIT_DOMAIN_MISMATCH', 400, 'ai_helper_group_undo_domain_mismatch');
        }
        const log = await this.audit.markUndone(id, actorUid);
        if (!log)
            throw new GroupServiceError('UNDO_NOT_ALLOWED', 409, 'ai_helper_group_undo_not_allowed');
        try {
            const reverted = await this.revert(log);
            if (Object.values(reverted).some((list) => list.length))
                (0, hydroCompat_1.clearDomainUserCache)(this.ctx, domainId);
            return { reverted };
        }
        catch (err) {
            await this.audit.revertUndoMark(id).catch(() => undefined);
            throw err;
        }
    }
    async revert(log) {
        const domainId = log.domainId;
        const name = log.target.id;
        const detail = log.detail || {};
        const list = (key) => (sanitizeUids(detail[key]) || []);
        switch (log.action) {
            case 'group.add':
            case 'group.drift_restore': {
                const added = list('added');
                const removed = await this.atomicRemove(domainId, name, added);
                await this.groupMeta.removePluginAdded(domainId, name, added);
                const joined = list('joined');
                await (0, hydroCompat_1.leaveDomain)(domainId, joined);
                return { removed, left: joined };
            }
            case 'group.remove': {
                const restored = await this.atomicAdd(domainId, name, list('removed'));
                await this.groupMeta.addPluginAdded(domainId, name, list('ledgerRemoved'), log.actorUid);
                return { added: restored };
            }
            case 'group.drift_dismiss': {
                const dismissed = list('dismissed');
                await this.groupMeta.addPluginAdded(domainId, name, dismissed, log.actorUid);
                return { ledgerRestored: dismissed };
            }
            default:
                throw new GroupServiceError('UNDO_NOT_ALLOWED', 409, 'ai_helper_group_undo_not_allowed');
        }
    }
    // ─── 漂移与扩展信息 ────────────────────────────────────────────────────────
    async currentDrift(domainId, name) {
        const [meta, group] = await Promise.all([
            this.groupMeta.get(domainId, name),
            this.groups.findOne({ domainId, name }, { projection: { uids: 1 } }),
        ]);
        const current = new Set(group?.uids || []);
        return { meta, drift: (meta?.pluginAdded || []).filter((uid) => !current.has(uid)) };
    }
    /** 恢复被覆盖成员（小组已被删除时会重建）或忽略（从台账移除） */
    async resolveDrift(input) {
        const name = this.requireGroupName(input.groupName);
        if (input.action !== 'restore' && input.action !== 'dismiss') {
            throw new GroupServiceError('INVALID_ACTION', 400, 'ai_helper_group_action_invalid');
        }
        const requested = this.requireUids(input.uids);
        const { domainId, actorUid } = input;
        const { drift } = await this.currentDrift(domainId, name);
        const driftSet = new Set(drift);
        const targets = requested.filter((uid) => driftSet.has(uid));
        let restored = [];
        let dismissed = [];
        if (input.action === 'restore') {
            restored = await this.atomicAdd(domainId, name, targets);
            if (restored.length)
                (0, hydroCompat_1.clearDomainUserCache)(this.ctx, domainId);
        }
        else {
            dismissed = await this.groupMeta.removePluginAdded(domainId, name, targets);
        }
        let auditId = null;
        if (restored.length || dismissed.length) {
            try {
                auditId = await this.audit.record({
                    actorUid,
                    action: input.action === 'restore' ? 'group.drift_restore' : 'group.drift_dismiss',
                    domainId,
                    target: { type: 'group', id: name },
                    detail: input.action === 'restore' ? { added: restored } : { dismissed },
                    undoable: true,
                });
            }
            catch (err) {
                console.error('[AI-Helper] drift audit record failed:', err instanceof Error ? err.message : String(err));
            }
        }
        return { restored, dismissed, auditId: auditId ? auditId.toHexString() : null };
    }
    /**
     * 扩展信息：update（含新建空小组）或 delete（仅限 Hydro 中已不存在的小组）
     */
    async updateMeta(input) {
        const name = this.requireGroupName(input.groupName);
        const { domainId, actorUid } = input;
        const hydroGroup = await this.groups.findOne({ domainId, name }, { projection: { _id: 1 } });
        if (input.action === 'delete') {
            if (hydroGroup)
                throw new GroupServiceError('GROUP_STILL_EXISTS', 409, 'ai_helper_group_meta_delete_exists');
            const before = await this.groupMeta.delete(domainId, name);
            if (!before)
                throw new GroupServiceError('GROUP_NOT_FOUND', 404, 'ai_helper_group_not_found');
            await this.recordMetaAudit(actorUid, domainId, name, { deleted: true, before: this.metaSnapshot(before) });
            return { meta: null, created: false, deleted: true };
        }
        const patch = {};
        if (input.kind !== undefined) {
            if (input.kind !== 'class' && input.kind !== 'other')
                throw this.invalidMeta('kind');
            patch.kind = input.kind;
        }
        if (input.academicYear !== undefined) {
            if (input.academicYear !== null && (typeof input.academicYear !== 'string' || input.academicYear.trim().length > 16)) {
                throw this.invalidMeta('academicYear');
            }
            patch.academicYear = typeof input.academicYear === 'string' ? input.academicYear.trim() : null;
        }
        if (input.teacherUids !== undefined) {
            const uids = sanitizeUids(input.teacherUids);
            if (!uids || uids.length > exports.MAX_TEACHERS_PER_GROUP)
                throw this.invalidMeta('teacherUids');
            const existing = await this.existingUids(uids);
            if (existing.length !== uids.length)
                throw this.invalidMeta('teacherUids');
            patch.teacherUids = uids;
        }
        if (input.archived !== undefined) {
            if (typeof input.archived !== 'boolean')
                throw this.invalidMeta('archived');
            patch.archived = input.archived;
        }
        let created = false;
        if (!hydroGroup) {
            const existingMeta = await this.groupMeta.get(domainId, name);
            if (input.create !== true && !existingMeta) {
                throw new GroupServiceError('GROUP_NOT_FOUND', 404, 'ai_helper_group_not_found');
            }
            if (input.create === true) {
                const raw = await this.groups.updateOne({ domainId, name }, { $setOnInsert: { uids: [] } }, { upsert: true });
                created = !!raw?.upsertedCount;
                if (created)
                    (0, hydroCompat_1.clearDomainUserCache)(this.ctx, domainId);
            }
        }
        const before = await this.groupMeta.update(domainId, name, patch, actorUid);
        const after = await this.groupMeta.get(domainId, name);
        await this.recordMetaAudit(actorUid, domainId, name, {
            ...(created ? { created: true } : {}),
            before: before ? this.metaSnapshot(before) : null,
            after: after ? this.metaSnapshot(after) : null,
        });
        return { meta: after, created, deleted: false };
    }
    metaSnapshot(meta) {
        return {
            kind: meta.kind,
            academicYear: meta.academicYear || null,
            teacherUids: meta.teacherUids || [],
            archived: !!meta.archived,
        };
    }
    invalidMeta(field) {
        return new GroupServiceError('INVALID_META', 400, 'ai_helper_group_meta_invalid', [field]);
    }
    async recordMetaAudit(actorUid, domainId, name, detail) {
        try {
            await this.audit.record({
                actorUid,
                action: 'group.meta',
                domainId,
                target: { type: 'group', id: name },
                detail,
                undoable: false,
            });
        }
        catch (err) {
            console.error('[AI-Helper] group meta audit failed:', err instanceof Error ? err.message : String(err));
        }
    }
}
exports.HydroGroupService = HydroGroupService;
//# sourceMappingURL=hydroGroupService.js.map