"use strict";
/**
 * AI 助手统一入口 Handler
 * 将三个独立页面整合为一个带 Tab 切换的统一入口
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIHelperDashboardHandlerPriv = exports.AIHelperDashboardHandler = void 0;
const hydrooj_1 = require("hydrooj");
/**
 * AIHelperDashboardHandler - 统一入口页面
 * GET /ai-helper - 渲染统一入口模板
 * GET /d/:domainId/ai-helper - 域前缀路由
 */
class AIHelperDashboardHandler extends hydrooj_1.Handler {
    async get() {
        this.response.template = 'ai-helper/dashboard.html';
        this.response.body = {};
    }
}
exports.AIHelperDashboardHandler = AIHelperDashboardHandler;
exports.AIHelperDashboardHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=dashboardHandler.js.map