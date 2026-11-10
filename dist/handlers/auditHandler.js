"use strict";
/**
 * 操作审计接口（FR-059）
 * GET /ai-helper/admin/audit?category=group&actor=system|<uid>&domainId=oi2023&days=7&page=1
 *
 * 仅系统管理员；跨域查看全部记录，可按域筛选。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditListHandlerPriv = exports.AuditListHandler = void 0;
exports.parseAuditFilters = parseAuditFilters;
const hydrooj_1 = require("hydrooj");
const auditLog_1 = require("../models/auditLog");
const groupAdminHandler_1 = require("./groupAdminHandler");
const DETAIL_UID_KEYS = ['added', 'removed', 'joined', 'left', 'dismissed', 'ledgerRemoved', 'uids', 'memberUids'];
const TARGET_TYPES = ['group', 'user', 'quota_group', 'config', 'review', 'transfer'];
const MAX_NAMED_UIDS_PER_LOG = 50;
function parseDate(value, endOfDay) {
    if (!value)
        return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return null;
    const parsed = new Date(`${value}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}
function parseAuditFilters(query, now = new Date()) {
    const category = String(query.category || '').trim();
    const action = String(query.action || '').trim();
    const actor = String(query.actor || '').trim();
    const domainId = String(query.domainId || '').trim();
    const daysRaw = String(query.days || '').trim();
    const from = parseDate(String(query.from || '').trim(), false);
    const to = parseDate(String(query.to || '').trim(), true);
    const targetType = String(query.targetType || '').trim();
    const targetId = String(query.targetId || '').trim();
    if ((category && !auditLog_1.AUDIT_CATEGORIES.includes(category))
        || (action && !auditLog_1.AUDIT_ACTIONS.includes(action))
        || (actor && actor !== 'system' && !/^\d{1,12}$/.test(actor))
        || domainId.length > 64
        || (targetType && !TARGET_TYPES.includes(targetType))
        || targetId.length > 128
        || (targetId && !targetType)
        || from === null || to === null
        || (daysRaw && (!/^\d{1,3}$/.test(daysRaw) || Number(daysRaw) < 1 || Number(daysRaw) > 180))) {
        return null;
    }
    const filters = {};
    if (category)
        filters.category = category;
    if (action)
        filters.action = action;
    if (actor === 'system')
        filters.actorType = 'system';
    else if (actor)
        filters.actorUid = Number(actor);
    if (domainId)
        filters.domainId = domainId;
    if (targetType)
        filters.targetType = targetType;
    if (targetId)
        filters.targetId = targetId;
    if (daysRaw)
        filters.from = new Date(now.getTime() - Number(daysRaw) * 24 * 60 * 60 * 1000);
    if (from)
        filters.from = from;
    if (to)
        filters.to = to;
    if (filters.from && filters.to && filters.from > filters.to)
        return null;
    return filters;
}
async function lookupNames(db, logs) {
    const uids = new Set();
    const domainIds = new Set();
    for (const log of logs) {
        if (typeof log.actorUid === 'number')
            uids.add(log.actorUid);
        if (typeof log.undoneBy === 'number')
            uids.add(log.undoneBy);
        if (log.domainId)
            domainIds.add(log.domainId);
        let named = 0;
        for (const key of DETAIL_UID_KEYS) {
            const list = log.detail?.[key];
            if (!Array.isArray(list))
                continue;
            for (const uid of list) {
                if (typeof uid === 'number' && named < MAX_NAMED_UIDS_PER_LOG) {
                    uids.add(uid);
                    named++;
                }
            }
        }
    }
    const [users, domains] = await Promise.all([
        uids.size
            ? db.collection('user')
                .find({ _id: { $in: [...uids] } }, { projection: { _id: 1, uname: 1 } }).toArray()
            : Promise.resolve([]),
        domainIds.size
            ? db.collection('domain')
                .find({ _id: { $in: [...domainIds] } }, { projection: { _id: 1, name: 1 } }).toArray()
            : Promise.resolve([]),
    ]);
    return {
        unames: new Map(users.map((user) => [user._id, user.uname])),
        domainNames: new Map(domains.map((domain) => [domain._id, domain.name || domain._id])),
    };
}
class AuditListHandler extends hydrooj_1.Handler {
    async get() {
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const query = (this.request.query || {});
            const filters = parseAuditFilters(query);
            if (!filters) {
                this.response.status = 400;
                this.response.body = { error: this.translate('ai_helper_audit_filter_invalid'), code: 'INVALID_AUDIT_FILTER' };
                this.response.type = 'application/json';
                return;
            }
            const page = parseInt(String(query.page || '1'), 10) || 1;
            const limit = parseInt(String(query.limit || '20'), 10) || 20;
            const auditService = this.ctx.get('auditService');
            const result = await auditService.list(filters, page, limit);
            const { unames, domainNames } = await lookupNames(this.ctx.db, result.logs);
            this.response.body = {
                logs: result.logs.map((log) => {
                    const uidNames = {};
                    for (const key of DETAIL_UID_KEYS) {
                        const list = log.detail?.[key];
                        if (!Array.isArray(list))
                            continue;
                        for (const uid of list) {
                            if (typeof uid === 'number' && unames.has(uid))
                                uidNames[String(uid)] = unames.get(uid);
                        }
                    }
                    return {
                        id: log._id.toHexString(),
                        at: log.at.toISOString(),
                        actorUid: log.actorUid ?? null,
                        actorName: typeof log.actorUid === 'number' ? unames.get(log.actorUid) || String(log.actorUid) : null,
                        action: log.action,
                        category: log.category,
                        domainId: log.domainId || null,
                        domainName: log.domainId ? domainNames.get(log.domainId) || log.domainId : null,
                        target: log.target,
                        detail: log.detail || {},
                        steps: log.steps || [],
                        undoable: !!log.undoable && !log.undoneAt,
                        undoneAt: log.undoneAt ? log.undoneAt.toISOString() : null,
                        undoneByName: typeof log.undoneBy === 'number' ? unames.get(log.undoneBy) || String(log.undoneBy) : null,
                        uidNames,
                    };
                }),
                total: result.total,
                page: result.page,
                totalPages: result.totalPages,
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] AuditListHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = { error: this.translate('ai_helper_audit_load_failed'), code: 'AUDIT_LOAD_FAILED' };
            this.response.type = 'application/json';
        }
    }
}
exports.AuditListHandler = AuditListHandler;
exports.AuditListHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=auditHandler.js.map