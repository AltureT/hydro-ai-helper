"use strict";
/**
 * UserOverviewService - 跨域学生总览（US6，FR-050–FR-054）与用户详情（FR-026）
 *
 * 仅系统管理员可用（处理器校验）。只返回统计与成员信息，不返回对话原文或安全记录的命中片段。
 *
 * 筛选思路：先由“所属域 / 小组 / 额度组 / 状态”各自得到候选 uid，取交集后再查 user 集合；
 * 需要按有效额度判断的状态（已用完、≥80%、AI 已关闭）只在候选集上计算后分页。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserOverviewService = exports.OVERVIEW_STATUSES = exports.OVERVIEW_SCAN_MAX = exports.OVERVIEW_PAGE_SIZE = void 0;
const hydrooj_1 = require("hydrooj");
const hydroCompat_1 = require("../utils/hydroCompat");
const timezone_1 = require("../utils/timezone");
const configSections_1 = require("../models/configSections");
const hydroGroupService_1 = require("./hydroGroupService");
exports.OVERVIEW_PAGE_SIZE = 50;
/** 需要逐个计算有效额度的筛选最多检查这么多人，超出时提示缩小范围 */
exports.OVERVIEW_SCAN_MAX = 5000;
const VIOLATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DETAIL_VIOLATIONS_LIMIT = 10;
const HIGH_USAGE_RATIO = 0.8;
exports.OVERVIEW_STATUSES = ['exhausted', 'high_usage', 'disabled', 'violations'];
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function intersect(current, next) {
    const incoming = new Set(next);
    if (!current)
        return incoming;
    return new Set([...current].filter((uid) => incoming.has(uid)));
}
function isMaxTimeError(err) {
    const e = err;
    return !!e && (e.code === 50 || e.codeName === 'MaxTimeMSExpired');
}
function toOverviewQuota(quota) {
    return {
        limit: quota.limit,
        used: quota.used,
        remaining: quota.remaining,
        disabled: quota.disabled,
        source: quota.source,
        capped: quota.capped,
        override: quota.override?.active
            ? { mode: quota.override.mode, ...(quota.override.mode === 'limit' ? { dailyLimit: quota.override.dailyLimit } : {}) }
            : null,
        appliedGroups: quota.groups
            .filter((group) => group.applied)
            .map((group) => ({ id: group.id, name: group.name, mode: group.mode, dailyLimit: group.dailyLimit })),
        groupCount: quota.groups.length,
    };
}
function matchesStatus(quota, status) {
    if (status === 'disabled')
        return quota.disabled;
    if (quota.disabled || quota.limit === null || quota.limit <= 0)
        return false;
    if (status === 'exhausted')
        return quota.used >= quota.limit;
    if (status === 'high_usage')
        return quota.used >= quota.limit * HIGH_USAGE_RATIO;
    return true;
}
class UserOverviewService {
    constructor(db, quotaService, resolver, overrides, usage, configModel, clock = () => new Date()) {
        this.db = db;
        this.quotaService = quotaService;
        this.resolver = resolver;
        this.overrides = overrides;
        this.usage = usage;
        this.configModel = configModel;
        this.clock = clock;
        this.users = db.collection('user');
        this.domains = db.collection('domain');
        this.safetyLogs = db.collection('ai_jailbreak_logs');
    }
    async domainNames(ids) {
        if (!ids.length)
            return new Map();
        const docs = await this.domains.find({ _id: { $in: ids } }, { projection: { _id: 1, name: 1 } }).toArray();
        return new Map(docs.map((doc) => [doc._id, doc.name || doc._id]));
    }
    unameFilter(filters) {
        const q = typeof filters.q === 'string' ? filters.q.trim() : '';
        if (!q)
            return {};
        if (filters.mode === 'regex') {
            if (q.length > hydroGroupService_1.MAX_REGEX_LENGTH) {
                throw new hydroGroupService_1.GroupServiceError('QUERY_TOO_LONG', 400, 'ai_helper_group_search_regex_too_long', [hydroGroupService_1.MAX_REGEX_LENGTH]);
            }
            try {
                // eslint-disable-next-line no-new
                new RegExp(q);
            }
            catch {
                throw new hydroGroupService_1.GroupServiceError('INVALID_REGEX', 400, 'ai_helper_group_search_regex_invalid');
            }
            return { uname: { $regex: q, $options: 'i' } };
        }
        return { unameLower: { $regex: `^${escapeRegex(q.toLowerCase())}` } };
    }
    /** 各筛选条件得到的候选 uid 的交集；null 表示不限 */
    async candidates(filters, now) {
        let set = null;
        if (filters.group && !filters.domainId) {
            throw new hydroGroupService_1.GroupServiceError('DOMAIN_REQUIRED', 400, 'ai_helper_overview_group_needs_domain');
        }
        if (filters.domainId) {
            const rows = await (0, hydroCompat_1.domainUserColl)(this.db)
                .find({ domainId: filters.domainId, ...(0, hydroCompat_1.memberFilter)() }, { projection: { uid: 1 } })
                .toArray();
            set = intersect(set, rows.map((row) => row.uid));
        }
        if (filters.group && filters.domainId) {
            const group = await (0, hydroCompat_1.groupColl)(this.db).findOne({ domainId: filters.domainId, name: filters.group });
            set = intersect(set, group?.uids || []);
        }
        if (filters.quotaGroupId) {
            const members = await this.resolver.membersOf(filters.quotaGroupId);
            if (!members)
                throw new hydroGroupService_1.GroupServiceError('QUOTA_GROUP_NOT_FOUND', 404, 'ai_helper_quota_group_not_found');
            set = intersect(set, members);
        }
        if (filters.status === 'violations') {
            const uids = await this.safetyLogs.distinct('userId', {
                createdAt: { $gte: new Date(now.getTime() - VIOLATION_WINDOW_MS) },
                reviewStatus: { $ne: 'false_positive' },
            });
            set = intersect(set, uids.filter((uid) => typeof uid === 'number'));
        }
        else if (filters.status === 'disabled') {
            const [overridden, zeroCap] = await Promise.all([
                this.overrides.activeUids(now, 'disabled'),
                this.resolver.zeroCapMembers(),
            ]);
            set = intersect(set, new Set([...overridden, ...zeroCap]));
        }
        else if (filters.status === 'exhausted' || filters.status === 'high_usage') {
            const cfg = await this.configModel.getConfig();
            const tz = (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig).timezone;
            const used = await this.usage.usersWithUsage((0, timezone_1.dateKey)(tz, now));
            set = intersect(set, used.map((row) => row.uid));
        }
        return set;
    }
    async list(filters) {
        const now = this.clock();
        const page = Math.max(1, Math.floor(Number(filters.page) || 1));
        const candidateSet = await this.candidates(filters, now);
        const filter = {
            _id: { $gt: 1 },
            priv: { $bitsAllSet: Number(hydrooj_1.PRIV.PRIV_USER_PROFILE) },
            ...this.unameFilter(filters),
        };
        if (candidateSet) {
            if (!candidateSet.size)
                return { rows: [], total: 0, page, pageSize: exports.OVERVIEW_PAGE_SIZE, pageCount: 0, truncated: false };
            filter._id = { $gt: 1, $in: [...candidateSet] };
        }
        const computedStatus = filters.status && filters.status !== 'violations' ? filters.status : null;
        try {
            if (computedStatus) {
                const docs = await this.users
                    .find(filter, { projection: { _id: 1, uname: 1, unameLower: 1 }, maxTimeMS: hydroGroupService_1.SEARCH_MAX_TIME_MS })
                    .sort({ unameLower: 1 })
                    .limit(exports.OVERVIEW_SCAN_MAX + 1)
                    .toArray();
                const truncated = docs.length > exports.OVERVIEW_SCAN_MAX;
                const scanned = docs.slice(0, exports.OVERVIEW_SCAN_MAX);
                const quotas = await this.quotaService.explainMany(scanned.map((doc) => doc._id));
                const matched = scanned.filter((doc) => {
                    const quota = quotas.get(doc._id);
                    return !!quota && matchesStatus(quota, computedStatus);
                });
                const pageDocs = matched.slice((page - 1) * exports.OVERVIEW_PAGE_SIZE, page * exports.OVERVIEW_PAGE_SIZE);
                return {
                    rows: await this.annotate(pageDocs, now, quotas),
                    total: matched.length,
                    page,
                    pageSize: exports.OVERVIEW_PAGE_SIZE,
                    pageCount: Math.ceil(matched.length / exports.OVERVIEW_PAGE_SIZE),
                    truncated,
                };
            }
            const [total, docs] = await Promise.all([
                this.users.countDocuments(filter, { maxTimeMS: hydroGroupService_1.SEARCH_MAX_TIME_MS }),
                this.users
                    .find(filter, { projection: { _id: 1, uname: 1, unameLower: 1 }, maxTimeMS: hydroGroupService_1.SEARCH_MAX_TIME_MS })
                    .sort({ unameLower: 1 })
                    .skip((page - 1) * exports.OVERVIEW_PAGE_SIZE)
                    .limit(exports.OVERVIEW_PAGE_SIZE)
                    .toArray(),
            ]);
            return {
                rows: await this.annotate(docs, now),
                total,
                page,
                pageSize: exports.OVERVIEW_PAGE_SIZE,
                pageCount: Math.ceil(total / exports.OVERVIEW_PAGE_SIZE),
                truncated: false,
            };
        }
        catch (err) {
            if (isMaxTimeError(err))
                throw new hydroGroupService_1.GroupServiceError('SEARCH_TIMEOUT', 400, 'ai_helper_group_search_timeout');
            throw err;
        }
    }
    async membership(uids) {
        const [rows, groups] = await Promise.all([
            (0, hydroCompat_1.domainUserColl)(this.db).find({ uid: { $in: uids }, ...(0, hydroCompat_1.memberFilter)() }, { projection: { uid: 1, domainId: 1 } }).toArray(),
            (0, hydroCompat_1.groupColl)(this.db).find({ uids: { $in: uids } }, { projection: { domainId: 1, name: 1, uids: 1 } }).toArray(),
        ]);
        const names = await this.domainNames([...new Set([...rows.map((row) => row.domainId), ...groups.map((group) => group.domainId)])]);
        const domainsByUid = new Map();
        for (const row of rows) {
            const list = domainsByUid.get(row.uid) || [];
            list.push({ id: row.domainId, name: names.get(row.domainId) || row.domainId });
            domainsByUid.set(row.uid, list);
        }
        const wanted = new Set(uids);
        const groupsByUid = new Map();
        for (const group of groups) {
            if (/^\d+$/.test(group.name))
                continue; // Hydro 内部的“作业组”以数字命名，不展示
            for (const uid of group.uids || []) {
                if (!wanted.has(uid))
                    continue;
                const list = groupsByUid.get(uid) || [];
                list.push({ domainId: group.domainId, domainName: names.get(group.domainId) || group.domainId, name: group.name });
                groupsByUid.set(uid, list);
            }
        }
        return { domainsByUid, groupsByUid };
    }
    async violationCounts(uids, now) {
        const docs = await this.safetyLogs
            .find({ userId: { $in: uids }, createdAt: { $gte: new Date(now.getTime() - VIOLATION_WINDOW_MS) }, reviewStatus: { $ne: 'false_positive' } }, { projection: { userId: 1 } })
            .limit(20000)
            .toArray();
        const counts = new Map();
        for (const doc of docs) {
            if (typeof doc.userId === 'number')
                counts.set(doc.userId, (counts.get(doc.userId) || 0) + 1);
        }
        return counts;
    }
    async annotate(docs, now, known) {
        if (!docs.length)
            return [];
        const uids = docs.map((doc) => doc._id);
        const [{ domainsByUid, groupsByUid }, quotas, violations] = await Promise.all([
            this.membership(uids),
            known ? Promise.resolve(known) : this.quotaService.explainMany(uids),
            this.violationCounts(uids, now),
        ]);
        return docs.map((doc) => {
            const quota = quotas.get(doc._id);
            return {
                uid: doc._id,
                uname: doc.uname,
                domains: (domainsByUid.get(doc._id) || []).sort((a, b) => a.name.localeCompare(b.name)),
                groups: (groupsByUid.get(doc._id) || [])
                    .map(({ domainId, name }) => ({ domainId, name }))
                    .sort((a, b) => a.name.localeCompare(b.name)),
                quota: toOverviewQuota(quota),
                violations7d: violations.get(doc._id) || 0,
            };
        });
    }
    async detail(uidRaw) {
        const uid = typeof uidRaw === 'string' && /^\d+$/.test(uidRaw) ? Number(uidRaw) : uidRaw;
        if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 1) {
            throw new hydroGroupService_1.GroupServiceError('USER_NOT_FOUND', 404, 'ai_helper_overview_user_not_found');
        }
        const user = await this.users.findOne({ _id: uid }, { projection: { _id: 1, uname: 1, priv: 1 } });
        if (!user)
            throw new hydroGroupService_1.GroupServiceError('USER_NOT_FOUND', 404, 'ai_helper_overview_user_not_found');
        const now = this.clock();
        const [{ domainsByUid, groupsByUid }, quota, violations, recent] = await Promise.all([
            this.membership([uid]),
            this.quotaService.explain(uid),
            this.violationCounts([uid], now),
            this.safetyLogs
                .find({ userId: uid, createdAt: { $gte: new Date(now.getTime() - VIOLATION_WINDOW_MS * 4) } }, { projection: { _id: 1, domainId: 1, category: 1, actionTaken: 1, reviewStatus: 1, createdAt: 1 } })
                .sort({ createdAt: -1 })
                .limit(DETAIL_VIOLATIONS_LIMIT)
                .toArray(),
        ]);
        const names = await this.domainNames([...new Set(recent.map((log) => log.domainId).filter((id) => !!id))]);
        let overrideSetByName;
        if (quota.override?.setBy !== undefined) {
            const setter = await this.users.findOne({ _id: quota.override.setBy }, { projection: { uname: 1 } });
            overrideSetByName = setter?.uname;
        }
        return {
            uid,
            uname: user.uname,
            domains: (domainsByUid.get(uid) || []).sort((a, b) => a.name.localeCompare(b.name)),
            groups: (groupsByUid.get(uid) || []).sort((a, b) => a.name.localeCompare(b.name)),
            quota: { ...quota, ...(overrideSetByName ? { overrideSetByName } : {}) },
            violations7d: violations.get(uid) || 0,
            recentViolations: recent.map((log) => ({
                id: String(log._id),
                ...(log.category ? { category: log.category } : {}),
                ...(log.domainId ? { domainId: log.domainId, domainName: names.get(log.domainId) || log.domainId } : {}),
                ...(log.actionTaken ? { actionTaken: log.actionTaken } : {}),
                ...(log.reviewStatus ? { reviewStatus: log.reviewStatus } : {}),
                createdAt: new Date(log.createdAt).toISOString(),
            })),
            credit: null,
        };
    }
}
exports.UserOverviewService = UserOverviewService;
//# sourceMappingURL=userOverviewService.js.map