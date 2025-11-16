"use strict";
/**
 * 测试路由 Handler
 * 用于验证插件加载和路由注册是否成功
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelloHandlerPriv = exports.HelloHandler = void 0;
const hydrooj_1 = require("hydrooj");
/**
 * Hello 测试 Handler
 * GET /ai-helper/hello - 返回插件状态信息
 */
class HelloHandler extends hydrooj_1.Handler {
    async get() {
        this.response.body = {
            message: 'AI Helper Plugin Loaded',
            version: '0.1.0',
            timestamp: new Date().toISOString(),
            status: 'ok'
        };
        this.response.type = 'application/json';
    }
}
exports.HelloHandler = HelloHandler;
// 导出路由权限配置（最低权限 - 任何人可访问）
exports.HelloHandlerPriv = hydrooj_1.PRIV.PRIV_NONE;
//# sourceMappingURL=testHandler.js.map