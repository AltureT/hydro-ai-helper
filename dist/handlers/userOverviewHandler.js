"use strict";
/**
 * 跨域学生总览与用户详情（US6，FR-050–FR-054；FR-026）
 *
 * 仅限系统管理员：路由层校验之外，处理器内再校验一次（FR-054）。
 * GET /ai-helper/admin/users        ?q=&mode=prefix|regex&domainId=&group=&quotaGroupId=&status=&page=&pageSize=
 * GET /ai-helper/admin/users/:uid   有效额度及来源、所属域与小组、近期安全记录（不含对话原文）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserOverviewHandlerPriv = exports.UserDetailHandler = exports.UserOverviewHandler = void 0;
exports.parseOverviewFilters = parseOverviewFilters;
const hydrooj_1 = require("hydrooj");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const userOverviewService_1 = require("../services/userOverviewService");
const groupAdminHandler_1 = require("./groupAdminHandler");
function json(handler, status, body) {
    if (status !== 200)
        handler.response.status = status;
    handler.response.body = body;
    handler.response.type = 'application/json';
}
function service(handler) {
    return handler.ctx.get('userOverviewService');
}
function str(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function parseOverviewFilters(query) {
    const q = query || {};
    const status = str(q.status);
    return {
        q: str(q.q),
        mode: q.mode === 'regex' ? 'regex' : 'prefix',
        domainId: str(q.domainId),
        group: str(q.group),
        quotaGroupId: str(q.quotaGroupId),
        status: status && userOverviewService_1.OVERVIEW_STATUSES.includes(status) ? status : undefined,
        page: Number(q.page) || 1,
        pageSize: Number(q.pageSize) || undefined,
    };
}
class UserOverviewHandler extends hydrooj_1.Handler {
    async get() {
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_user_overview',
                periodSecs: 60,
                maxOps: 60,
                failOpen: true,
                errorMessage: 'ai_helper_overview_rate_limited',
            }))
                return;
            const result = await service(this).list(parseOverviewFilters(this.request.query));
            json(this, 200, result);
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_overview_failed', 'USER_OVERVIEW_FAILED');
        }
    }
}
exports.UserOverviewHandler = UserOverviewHandler;
class UserDetailHandler extends hydrooj_1.Handler {
    async get() {
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const result = await service(this).detail(this.request.params?.uid);
            json(this, 200, result);
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_overview_detail_failed', 'USER_DETAIL_FAILED');
        }
    }
}
exports.UserDetailHandler = UserDetailHandler;
exports.UserOverviewHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=userOverviewHandler.js.map