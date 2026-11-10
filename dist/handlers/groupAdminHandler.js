"use strict";
/**
 * 小组管理接口（US1）
 *
 * 全部仅限系统管理员（PRIV_EDIT_SYSTEM）：路由层校验之外，处理器内再校验一次。
 * GET  /d/:domainId/ai-helper/groups           本域小组 + 扩展信息 + 漂移
 * POST /d/:domainId/ai-helper/groups/search    搜索与预览
 * POST /d/:domainId/ai-helper/groups/apply     批量加入 / 移出
 * POST /d/:domainId/ai-helper/groups/undo      撤销一次操作
 * POST /d/:domainId/ai-helper/groups/meta      扩展信息（含新建空小组、删除失效扩展信息）
 * POST /d/:domainId/ai-helper/groups/drift     恢复 / 忽略被覆盖的成员
 * GET  /d/:domainId/ai-helper/groups/backfill  没有小组记录的历史会话数
 * POST /d/:domainId/ai-helper/groups/backfill  按当前成员关系回填（FR-057）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupAdminHandlerPriv = exports.GroupBackfillHandler = exports.GroupDriftHandler = exports.GroupMetaHandler = exports.GroupUndoHandler = exports.GroupApplyHandler = exports.GroupSearchHandler = exports.GroupListHandler = void 0;
exports.rejectIfNotSystemAdmin = rejectIfNotSystemAdmin;
exports.respondGroupError = respondGroupError;
const hydrooj_1 = require("hydrooj");
const csrfHelper_1 = require("../lib/csrfHelper");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const i18nHelper_1 = require("../utils/i18nHelper");
const domainHelper_1 = require("../utils/domainHelper");
const hydroCompat_1 = require("../utils/hydroCompat");
const hydroGroupService_1 = require("../services/hydroGroupService");
function json(handler, status, body) {
    if (status !== 200)
        handler.response.status = status;
    handler.response.body = body;
    handler.response.type = 'application/json';
}
/** 处理器内二次校验系统管理员权限（纵深防御） */
function rejectIfNotSystemAdmin(handler) {
    const user = handler.user;
    const allowed = typeof user?.hasPriv === 'function'
        ? user.hasPriv(hydrooj_1.PRIV.PRIV_EDIT_SYSTEM)
        : (0, hydroCompat_1.hasSystemPriv)(user?.priv);
    if (allowed)
        return false;
    json(handler, 403, { error: handler.translate('ai_helper_err_system_admin_required'), code: 'SYSTEM_ADMIN_REQUIRED' });
    return true;
}
function respondGroupError(handler, err, fallbackKey, fallbackCode) {
    if (err instanceof hydroGroupService_1.GroupServiceError) {
        json(handler, err.status, {
            error: (0, i18nHelper_1.translateWithParams)(handler, err.i18nKey, ...err.params),
            code: err.code,
        });
        return;
    }
    console.error(`[AI Helper] ${fallbackCode}:`, err instanceof Error ? err.message : 'unknown');
    json(handler, 500, { error: handler.translate(fallbackKey), code: fallbackCode });
}
function service(handler) {
    return handler.ctx.get('hydroGroupService');
}
function body(handler) {
    const raw = handler.request.body;
    return raw && typeof raw === 'object' ? raw : {};
}
class GroupListHandler extends hydrooj_1.Handler {
    async get() {
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            const includeArchived = String(this.request.query?.includeArchived || '') === '1';
            const result = await service(this).list((0, domainHelper_1.getDomainId)(this), { includeArchived });
            json(this, 200, result);
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_list_failed', 'GROUP_LIST_FAILED');
        }
    }
}
exports.GroupListHandler = GroupListHandler;
class GroupSearchHandler extends hydrooj_1.Handler {
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_group_search',
                periodSecs: 60,
                maxOps: 30,
                failOpen: true,
                errorMessage: 'ai_helper_group_search_rate_limited',
            }))
                return;
            const { mode, query, scope } = body(this);
            const result = await service(this).search((0, domainHelper_1.getDomainId)(this), mode, query, scope === 'all' ? 'all' : 'domain');
            json(this, 200, result);
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_search_failed', 'GROUP_SEARCH_FAILED');
        }
    }
}
exports.GroupSearchHandler = GroupSearchHandler;
class GroupApplyHandler extends hydrooj_1.Handler {
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            const { groupName, action, uids, joinDomain } = body(this);
            const result = await service(this).apply({
                domainId: (0, domainHelper_1.getDomainId)(this),
                groupName,
                action,
                uids,
                joinDomain: joinDomain && typeof joinDomain === 'object' ? joinDomain : null,
                actorUid: Number(this.user?._id),
            });
            json(this, 200, result);
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_apply_failed', 'GROUP_APPLY_FAILED');
        }
    }
}
exports.GroupApplyHandler = GroupApplyHandler;
class GroupUndoHandler extends hydrooj_1.Handler {
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            const { auditId } = body(this);
            const result = await service(this).undo((0, domainHelper_1.getDomainId)(this), auditId, Number(this.user?._id));
            json(this, 200, { success: true, ...result });
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_undo_failed', 'GROUP_UNDO_FAILED');
        }
    }
}
exports.GroupUndoHandler = GroupUndoHandler;
class GroupMetaHandler extends hydrooj_1.Handler {
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            const b = body(this);
            const result = await service(this).updateMeta({
                domainId: (0, domainHelper_1.getDomainId)(this),
                groupName: b.groupName,
                action: b.action,
                kind: b.kind,
                academicYear: b.academicYear,
                teacherUids: b.teacherUids,
                archived: b.archived,
                create: b.create,
                actorUid: Number(this.user?._id),
            });
            json(this, 200, { success: true, ...result });
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_meta_failed', 'GROUP_META_FAILED');
        }
    }
}
exports.GroupMetaHandler = GroupMetaHandler;
class GroupDriftHandler extends hydrooj_1.Handler {
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            const { groupName, action, uids } = body(this);
            const result = await service(this).resolveDrift({
                domainId: (0, domainHelper_1.getDomainId)(this),
                groupName,
                action,
                uids,
                actorUid: Number(this.user?._id),
            });
            json(this, 200, { success: true, ...result });
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_drift_failed', 'GROUP_DRIFT_FAILED');
        }
    }
}
exports.GroupDriftHandler = GroupDriftHandler;
class GroupBackfillHandler extends hydrooj_1.Handler {
    backfill() {
        return this.ctx.get('groupBackfillService');
    }
    async get() {
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            json(this, 200, { pending: await this.backfill().countPending((0, domainHelper_1.getDomainId)(this)) });
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_backfill_failed', 'GROUP_BACKFILL_FAILED');
        }
    }
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if (rejectIfNotSystemAdmin(this))
            return;
        try {
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_group_backfill',
                periodSecs: 60,
                maxOps: 6,
                errorMessage: 'ai_helper_err_rate_limited',
            }))
                return;
            const result = await this.backfill().run((0, domainHelper_1.getDomainId)(this), Number(this.user?._id));
            json(this, 200, { success: true, ...result });
        }
        catch (err) {
            respondGroupError(this, err, 'ai_helper_group_backfill_failed', 'GROUP_BACKFILL_FAILED');
        }
    }
}
exports.GroupBackfillHandler = GroupBackfillHandler;
exports.GroupAdminHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=groupAdminHandler.js.map