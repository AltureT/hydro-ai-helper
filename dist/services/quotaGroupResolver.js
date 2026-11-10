"use strict";
/**
 * QuotaGroupResolver - 额度组成员解析与缓存（plan R11，FR-023、FR-063）
 *
 * - 缓存（进程内，TTL 60 秒）：全部额度组，以及每个被关联的 Hydro 小组的成员集合。
 * - 个人覆盖不缓存：每次按 _id = uid 查询。
 * - 插件写入后本进程立即失效，并广播 `ai-helper/quota-cache-invalidate` 通知其他进程；
 *   Hydro 原生页面改组最多延迟 60 秒生效。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaGroupResolver = exports.QUOTA_CACHE_TTL_MS = exports.QUOTA_CACHE_EVENT = void 0;
const hydroCompat_1 = require("../utils/hydroCompat");
exports.QUOTA_CACHE_EVENT = 'ai-helper/quota-cache-invalidate';
exports.QUOTA_CACHE_TTL_MS = 60 * 1000;
function linkKey(domainId, name) {
    return `${domainId}\u0000${name}`;
}
class QuotaGroupResolver {
    constructor(db, groups, overrides, ctx, clock = () => new Date(), ttlMs = exports.QUOTA_CACHE_TTL_MS) {
        this.db = db;
        this.groups = groups;
        this.overrides = overrides;
        this.ctx = ctx;
        this.clock = clock;
        this.ttlMs = ttlMs;
        this.cache = null;
        this.loading = null;
        this.generation = 0;
    }
    /** 订阅其他进程的失效广播（插件启动时调用一次） */
    listen(ctx) {
        ctx?.on?.(exports.QUOTA_CACHE_EVENT, () => this.invalidateLocal());
    }
    /** 只清本进程缓存 */
    invalidateLocal() {
        this.generation += 1;
        this.cache = null;
        this.loading = null;
    }
    /** 清本进程缓存并通知其他进程 */
    invalidate() {
        this.invalidateLocal();
        try {
            this.ctx?.broadcast?.(exports.QUOTA_CACHE_EVENT);
        }
        catch (err) {
            console.warn('[AI-Helper] quota cache broadcast failed:', err instanceof Error ? err.message : String(err));
        }
    }
    /** 全部额度组及成员集合（缓存 60 秒，并发读取合并为一次查询） */
    async snapshot() {
        const now = this.clock().getTime();
        if (this.cache && now - this.cache.loadedAt < this.ttlMs)
            return this.cache.groups;
        if (this.loading)
            return this.loading;
        const generation = this.generation;
        const promise = this.load().then((groups) => {
            if (generation === this.generation)
                this.cache = { loadedAt: now, groups };
            return groups;
        }).finally(() => {
            if (this.loading === promise)
                this.loading = null;
        });
        this.loading = promise;
        return promise;
    }
    async load() {
        const docs = await this.groups.list();
        const links = new Map();
        for (const doc of docs) {
            for (const link of doc.linkedGroups || [])
                links.set(linkKey(link.domainId, link.name), link);
        }
        const hydroGroups = links.size
            ? await (0, hydroCompat_1.groupColl)(this.db)
                .find({ $or: [...links.values()].map((link) => ({ domainId: link.domainId, name: link.name })) }, { projection: { domainId: 1, name: 1, uids: 1 } })
                .toArray()
            : [];
        const members = new Map(hydroGroups.map((group) => [linkKey(group.domainId, group.name), new Set(group.uids || [])]));
        return docs.map((doc) => ({
            id: String(doc._id),
            name: doc.name,
            mode: doc.mode,
            dailyLimit: doc.dailyLimit,
            enabled: doc.enabled !== false,
            direct: new Set(doc.memberUids || []),
            linked: (doc.linkedGroups || []).map((link) => {
                const uids = members.get(linkKey(link.domainId, link.name));
                return { domainId: link.domainId, name: link.name, exists: !!uids, uids: uids || new Set() };
            }),
        }));
    }
    static membershipOf(group, uid) {
        const via = [];
        if (group.direct.has(uid))
            via.push({ kind: 'direct' });
        for (const link of group.linked) {
            if (link.uids.has(uid))
                via.push({ kind: 'linked', domainId: link.domainId, name: link.name });
        }
        if (!via.length)
            return null;
        return { id: group.id, name: group.name, mode: group.mode, dailyLimit: group.dailyLimit, enabled: group.enabled, via };
    }
    /** 用户所属的全部额度组（含停用的组，由调用方决定是否参与计算） */
    async getGroupMemberships(uid) {
        const groups = await this.snapshot();
        const out = [];
        for (const group of groups) {
            const membership = QuotaGroupResolver.membershipOf(group, uid);
            if (membership)
                out.push(membership);
        }
        return out;
    }
    /** 某个额度组的全部成员 uid（直接 ∪ 关联小组） */
    async membersOf(groupId) {
        const group = (await this.snapshot()).find((item) => item.id === groupId);
        if (!group)
            return null;
        const out = new Set(group.direct);
        for (const link of group.linked)
            for (const uid of link.uids)
                out.add(uid);
        return out;
    }
    /** 启用中、每日 0 次的限制型组的全部成员（AI 被关闭的候选） */
    async zeroCapMembers() {
        const out = new Set();
        for (const group of await this.snapshot()) {
            if (!group.enabled || group.mode !== 'cap' || group.dailyLimit !== 0)
                continue;
            for (const uid of group.direct)
                out.add(uid);
            for (const link of group.linked)
                for (const uid of link.uids)
                    out.add(uid);
        }
        return out;
    }
    async getOverride(uid) {
        return this.overrides.get(uid);
    }
    async getOverrides(uids) {
        const docs = await this.overrides.getMany(uids);
        return new Map(docs.map((doc) => [doc._id, doc]));
    }
}
exports.QuotaGroupResolver = QuotaGroupResolver;
//# sourceMappingURL=quotaGroupResolver.js.map