"use strict";
/**
 * 额度组与个人覆盖接口（US3）
 *
 * 全部仅限系统管理员（PRIV_EDIT_SYSTEM）：路由层校验之外，处理器内再校验一次（FR-021、FR-025）。
 * GET  /ai-helper/admin/quota/groups            额度组列表（含成员数、关联小组）+ 域列表
 * POST /ai-helper/admin/quota/groups            { action: create | update | delete | members | link | unlink, ... }
 * GET  /ai-helper/admin/quota/groups/detail     ?id= 直接成员与关联小组
 * GET  /ai-helper/admin/quota/overrides         当前有效的个人覆盖
 * POST /ai-helper/admin/quota/overrides         { action: set | clear, uids, mode?, dailyLimit?, expiresAt?, reason? }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaAdminHandlerPriv = exports.QuotaOverridesHandler = exports.QuotaGroupDetailHandler = exports.QuotaGroupsHandler = void 0;
const hydrooj_1 = require("hydrooj");
const csrfHelper_1 = require("../lib/csrfHelper");
const hydroGroupService_1 = require("../services/hydroGroupService");
const groupAdminHandler_1 = require("./groupAdminHandler");
function json(handler, status, body) {
    if (status !== 200)
        handler.response.status = status;
    handler.response.body = body;
    handler.response.type = 'application/json';
}
function service(handler) {
    return handler.ctx.get('quotaAdminService');
}
function body(handler) {
    const raw = handler.request.body;
    return raw && typeof raw === 'object' ? raw : {};
}
function actor(handler) {
    return Number(handler.user?._id);
}
class QuotaGroupsHandler extends hydrooj_1.Handler {
    async get() {
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            json(this, 200, await service(this).listGroups());
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_quota_groups_failed', 'QUOTA_GROUPS_FAILED');
        }
    }
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const b = body(this);
            const svc = service(this);
            switch (b.action) {
                case 'create':
                    json(this, 200, { success: true, group: await svc.createGroup({ name: b.name, mode: b.mode, dailyLimit: b.dailyLimit, enabled: b.enabled }, actor(this)) });
                    return;
                case 'update':
                    json(this, 200, { success: true, group: await svc.updateGroup(b.id, { name: b.name, mode: b.mode, dailyLimit: b.dailyLimit, enabled: b.enabled }, actor(this)) });
                    return;
                case 'delete':
                    json(this, 200, { success: true, ...await svc.deleteGroup(b.id, actor(this)) });
                    return;
                case 'members':
                    json(this, 200, { success: true, ...await svc.changeMembers(b.id, b.op, b.uids, actor(this)) });
                    return;
                case 'link':
                    json(this, 200, { success: true, ...await svc.link(b.id, b.link, actor(this)) });
                    return;
                case 'unlink':
                    json(this, 200, { success: true, ...await svc.unlink(b.id, b.link, actor(this)) });
                    return;
                default:
                    throw new hydroGroupService_1.GroupServiceError('INVALID_ACTION', 400, 'ai_helper_quota_action_invalid');
            }
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_quota_group_save_failed', 'QUOTA_GROUP_SAVE_FAILED');
        }
    }
}
exports.QuotaGroupsHandler = QuotaGroupsHandler;
class QuotaGroupDetailHandler extends hydrooj_1.Handler {
    async get() {
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const id = this.request.query?.id;
            json(this, 200, await service(this).groupDetail(typeof id === 'string' ? id : undefined));
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_quota_groups_failed', 'QUOTA_GROUPS_FAILED');
        }
    }
}
exports.QuotaGroupDetailHandler = QuotaGroupDetailHandler;
class QuotaOverridesHandler extends hydrooj_1.Handler {
    async get() {
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            json(this, 200, await service(this).listOverrides());
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_quota_overrides_failed', 'QUOTA_OVERRIDES_FAILED');
        }
    }
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const b = body(this);
            if (b.action === 'set') {
                json(this, 200, { success: true, ...await service(this).setOverrides(b.uids, { mode: b.mode, dailyLimit: b.dailyLimit, expiresAt: b.expiresAt, reason: b.reason }, actor(this)) });
                return;
            }
            if (b.action === 'clear') {
                json(this, 200, { success: true, ...await service(this).clearOverrides(b.uids, actor(this)) });
                return;
            }
            throw new hydroGroupService_1.GroupServiceError('INVALID_ACTION', 400, 'ai_helper_quota_action_invalid');
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_quota_override_save_failed', 'QUOTA_OVERRIDE_SAVE_FAILED');
        }
    }
}
exports.QuotaOverridesHandler = QuotaOverridesHandler;
exports.QuotaAdminHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=quotaAdminHandler.js.map