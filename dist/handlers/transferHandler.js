"use strict";
/**
 * 跨域转移接口（US9）
 *
 * 全部仅限系统管理员（PRIV_EDIT_SYSTEM）：路由层校验之外，处理器内再校验一次。
 * POST /ai-helper/admin/transfer/preview   预览（只读），返回 previewToken（10 分钟有效）
 * POST /ai-helper/admin/transfer/execute   预览请求体 + previewToken + joinRole + removeMembersFromSource? + selectedUids?
 * POST /ai-helper/admin/transfer/resume    { auditId } 继续完成剩余部分
 * POST /ai-helper/admin/transfer/undo      { auditId } 撤销已完成部分
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransferHandlerPriv = exports.TransferUndoHandler = exports.TransferResumeHandler = exports.TransferExecuteHandler = exports.TransferPreviewHandler = void 0;
const hydrooj_1 = require("hydrooj");
const csrfHelper_1 = require("../lib/csrfHelper");
const groupAdminHandler_1 = require("./groupAdminHandler");
function json(handler, status, body) {
    if (status !== 200)
        handler.response.status = status;
    handler.response.body = body;
    handler.response.type = 'application/json';
}
function service(handler) {
    return handler.ctx.get('transferService');
}
function body(handler) {
    const raw = handler.request.body;
    return raw && typeof raw === 'object' ? raw : {};
}
function actor(handler) {
    return Number(handler.user?._id);
}
function guard(handler) {
    return (0, csrfHelper_1.rejectIfCsrfInvalid)(handler) || (0, groupAdminHandler_1.rejectIfNotSystemAdmin)(handler);
}
class TransferPreviewHandler extends hydrooj_1.Handler {
    async post() {
        if (guard(this))
            return;
        try {
            json(this, 200, await service(this).preview(body(this)));
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_transfer_preview_failed', 'TRANSFER_PREVIEW_FAILED');
        }
    }
}
exports.TransferPreviewHandler = TransferPreviewHandler;
class TransferExecuteHandler extends hydrooj_1.Handler {
    async post() {
        if (guard(this))
            return;
        try {
            json(this, 200, await service(this).execute(body(this), actor(this)));
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_transfer_execute_failed', 'TRANSFER_EXECUTE_FAILED');
        }
    }
}
exports.TransferExecuteHandler = TransferExecuteHandler;
class TransferResumeHandler extends hydrooj_1.Handler {
    async post() {
        if (guard(this))
            return;
        try {
            json(this, 200, await service(this).resume(body(this).auditId, actor(this)));
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_transfer_execute_failed', 'TRANSFER_EXECUTE_FAILED');
        }
    }
}
exports.TransferResumeHandler = TransferResumeHandler;
class TransferUndoHandler extends hydrooj_1.Handler {
    async post() {
        if (guard(this))
            return;
        try {
            json(this, 200, { success: true, ...await service(this).undo(body(this).auditId, actor(this)) });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_transfer_undo_failed', 'TRANSFER_UNDO_FAILED');
        }
    }
}
exports.TransferUndoHandler = TransferUndoHandler;
exports.TransferHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=transferHandler.js.map