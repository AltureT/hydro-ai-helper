/**
 * AI 使用统计页面 Handler
 * 处理统计页面的渲染和数据请求
 */

import { Handler, PRIV } from 'hydrooj';

/**
 * AnalyticsHandler - AI 使用统计页面
 * GET /ai-helper/analytics
 */
export class AnalyticsHandler extends Handler {
  async get() {
    try {
      // 检测请求类型：浏览器 HTML 访问还是前端 JSON API 调用
      const accept = this.request.headers.accept || '';
      const wantJson = accept.includes('application/json');

      if (wantJson) {
        // JSON API 模式：前端 fetch 调用
        // 暂时返回占位数据，后续在 Phase 4 实现具体统计逻辑
        this.response.body = {
          message: 'AI 使用统计 API（开发中）',
          data: {}
        };
        this.response.type = 'application/json';
        return;
      }

      // HTML 页面模式：浏览器直接访问
      this.response.template = 'ai-helper/analytics.html';
      this.response.body = {
        // 可以传递初始数据给模板
      };
    } catch (err) {
      console.error('[AI Helper] AnalyticsHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
      this.response.type = 'application/json';
    }
  }
}

// 导出路由权限配置（使用与对话列表相同的权限）
export const AnalyticsHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
