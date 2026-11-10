"use strict";
/**
 * 负责老师只读视图（US8，FR-058）
 *
 * 路由级只要求登录（PRIV_USER_PROFILE），处理器内校验：系统管理员，或“负责老师访问”已开启且是本域某小组的负责老师。
 * 全部是 GET；会话与统计在服务端按“我负责的小组”和当前域过滤。
 *
 * GET /d/:domainId/ai-helper/class                      页面；JSON 时返回可访问的小组
 * GET /d/:domainId/ai-helper/class/analytics?group=     近 7 天统计
 * GET /d/:domainId/ai-helper/class/conversations?group=&page=  最近对话
 * GET /d/:domainId/ai-helper/class/conversations/:id    对话详情
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClassTeacherHandlerPriv = exports.ClassConversationDetailHandler = exports.ClassConversationListHandler = exports.ClassAnalyticsHandler = exports.ClassTeacherHandler = exports.CLASS_PAGE_SIZE = void 0;
const hydrooj_1 = require("hydrooj");
const httpHelpers_1 = require("../lib/httpHelpers");
const queryHelpers_1 = require("../lib/queryHelpers");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const domainHelper_1 = require("../utils/domainHelper");
const hydroCompat_1 = require("../utils/hydroCompat");
const mongo_1 = require("../utils/mongo");
const groupAdminHandler_1 = require("./groupAdminHandler");
const teacherHandler_1 = require("./teacherHandler");
exports.CLASS_PAGE_SIZE = 20;
function json(handler, status, body) {
    if (status !== 200)
        handler.response.status = status;
    handler.response.body = body;
    handler.response.type = 'application/json';
}
function isSystemAdmin(handler) {
    const user = handler.user;
    return typeof user?.hasPriv === 'function' ? user.hasPriv(hydrooj_1.PRIV.PRIV_EDIT_SYSTEM) : (0, hydroCompat_1.hasSystemPriv)(user?.priv);
}
function service(handler) {
    return handler.ctx.get('classTeacherService');
}
async function limited(handler) {
    return (0, rateLimitHelper_1.applyRateLimit)(handler, {
        op: 'ai_class_view',
        periodSecs: 60,
        maxOps: 60,
        failOpen: true,
        errorMessage: 'ai_helper_err_rate_limited',
    });
}
async function scopeOf(handler) {
    return service(handler).resolveScope((0, domainHelper_1.getDomainId)(handler), Number(handler.user?._id), isSystemAdmin(handler));
}
class ClassTeacherHandler extends hydrooj_1.Handler {
    async get() {
        // 页面本身不含数据，访问校验在 JSON 接口中完成，页面据此显示“无权访问”的原因
        if (!(0, httpHelpers_1.expectsJson)(this)) {
            (0, httpHelpers_1.setTemplateResponse)(this, 'ai-helper/class_teacher.html', {});
            return;
        }
        try {
            if (await limited(this))
                return;
            const scope = await scopeOf(this);
            json(this, 200, {
                domainId: scope.domainId,
                domainName: scope.domainName,
                systemAdmin: scope.systemAdmin,
                groups: scope.groups,
            });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_class_err_load', 'CLASS_LOAD_FAILED');
        }
    }
}
exports.ClassTeacherHandler = ClassTeacherHandler;
class ClassAnalyticsHandler extends hydrooj_1.Handler {
    async get() {
        try {
            if (await limited(this))
                return;
            const scope = await scopeOf(this);
            const group = service(this).requireGroup(scope, this.request.query?.group);
            const stats = await service(this).stats(scope, group);
            json(this, 200, { ...stats, since: stats.since.toISOString() });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_class_err_load', 'CLASS_LOAD_FAILED');
        }
    }
}
exports.ClassAnalyticsHandler = ClassAnalyticsHandler;
class ClassConversationListHandler extends hydrooj_1.Handler {
    async get() {
        try {
            if (await limited(this))
                return;
            const scope = await scopeOf(this);
            const group = service(this).requireGroup(scope, this.request.query?.group);
            const { page } = (0, queryHelpers_1.parsePaginationParams)(String(this.request.query?.page || '1'), String(exports.CLASS_PAGE_SIZE), exports.CLASS_PAGE_SIZE);
            const conversationModel = this.ctx.get('conversationModel');
            const { conversations, total } = await conversationModel.findByFilters({ domainId: scope.domainId, group: group.name }, page, exports.CLASS_PAGE_SIZE);
            const [summaries, flags] = await Promise.all([
                (0, teacherHandler_1.summarizeConversations)(this, conversations, scope.domainId),
                service(this).conversationFlags(scope.domainId, conversations.map((conv) => conv._id)),
            ]);
            json(this, 200, {
                conversations: summaries.map((summary) => ({
                    ...summary,
                    // 老师备注属于系统管理员的批注，不给负责老师看
                    teacherNote: undefined,
                    flags: flags.get(summary._id) || { count: 0, categories: [] },
                })),
                total,
                page,
                limit: exports.CLASS_PAGE_SIZE,
            });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_class_err_load', 'CLASS_LOAD_FAILED');
        }
    }
}
exports.ClassConversationListHandler = ClassConversationListHandler;
class ClassConversationDetailHandler extends hydrooj_1.Handler {
    async get({ id }) {
        try {
            if (await limited(this))
                return;
            const scope = await scopeOf(this);
            const conversationModel = this.ctx.get('conversationModel');
            const conversation = mongo_1.ObjectId.isValid(id) ? await conversationModel.findById(id) : null;
            // 不在范围内与不存在返回同样的 404，不暴露其他班的会话是否存在
            if (!conversation || !service(this).canView(scope, conversation)) {
                json(this, 404, { error: this.translate('ai_helper_teacher_conversation_not_found'), code: 'NOT_FOUND' });
                return;
            }
            const detail = await (0, teacherHandler_1.buildConversationDetail)(this, conversation, scope.domainId);
            json(this, 200, { ...detail, conversation: { ...detail.conversation, teacherNote: undefined } });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_class_err_load', 'CLASS_LOAD_FAILED');
        }
    }
}
exports.ClassConversationDetailHandler = ClassConversationDetailHandler;
exports.ClassTeacherHandlerPriv = hydrooj_1.PRIV.PRIV_USER_PROFILE;
//# sourceMappingURL=classTeacherHandler.js.map