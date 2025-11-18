/**
 * AI 配置页面 Handler
 * 处理管理员配置页面的渲染和配置请求
 */

import { Handler, PRIV } from 'hydrooj';

/**
 * AdminConfigHandler - AI 配置页面
 * GET /ai-helper/admin/config
 */
export class AdminConfigHandler extends Handler {
  async get() {
    try {
      // 检测请求类型：浏览器 HTML 访问还是前端 JSON API 调用
      const accept = this.request.headers.accept || '';
      const wantJson = accept.includes('application/json');

      if (wantJson) {
        // JSON API 模式：前端 fetch 调用
        // 暂时返回占位数据，后续在 Phase 4 实现具体配置逻辑
        this.response.body = {
          message: 'AI 配置 API（开发中）',
          data: {}
        };
        this.response.type = 'application/json';
        return;
      }

      // HTML 页面模式：浏览器直接访问
      this.response.template = 'ai-helper/admin_config.html';
      this.response.body = {
        // 可以传递初始数据给模板
      };
    } catch (err) {
      console.error('[AI Helper] AdminConfigHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
      this.response.type = 'application/json';
    }
  }
}

// 导出路由权限配置（使用系统管理员权限）
export const AdminConfigHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
