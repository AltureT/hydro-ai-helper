/**
 * 测试路由 Handler
 * 用于验证插件加载和路由注册是否成功
 */

import { Handler, PRIV } from 'hydrooj';

/**
 * Hello 测试 Handler
 * GET /ai-helper/hello - 返回插件状态信息
 */
export class HelloHandler extends Handler {
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

// 导出路由权限配置（最低权限 - 任何人可访问）
export const HelloHandlerPriv = PRIV.PRIV_NONE;
