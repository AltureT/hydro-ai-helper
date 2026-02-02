"use strict";
/**
 * 域辅助工具函数
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDomainId = getDomainId;
/**
 * 从 Handler 获取当前域 ID
 * @param handler Handler 实例
 * @returns 域 ID，默认为 'system'
 */
function getDomainId(handler) {
    const h = handler;
    return handler.args?.domainId || h.domain?._id || 'system';
}
//# sourceMappingURL=domainHelper.js.map