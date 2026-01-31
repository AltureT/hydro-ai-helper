/**
 * AI 助手统一入口 Handler
 * 将三个独立页面整合为一个带 Tab 切换的统一入口
 */

import { Handler, PRIV } from 'hydrooj';

/**
 * AIHelperDashboardHandler - 统一入口页面
 * GET /ai-helper - 渲染统一入口模板
 * GET /d/:domainId/ai-helper - 域前缀路由
 */
export class AIHelperDashboardHandler extends Handler {
  async get() {
    this.response.template = 'ai-helper/dashboard.html';
    this.response.body = {};
  }
}

export const AIHelperDashboardHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
