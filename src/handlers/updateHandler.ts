/**
 * UpdateHandler - 插件更新 API 处理器
 *
 * 提供插件在线更新接口：
 * GET /ai-helper/admin/update/info - 获取更新信息
 * POST /ai-helper/admin/update - 执行更新
 */

import { Handler, PRIV } from 'hydrooj';
import { UpdateService } from '../services/updateService';
import { setJsonResponse, setErrorResponse } from '../lib/httpHelpers';

/**
 * UpdateInfoHandler - 获取更新信息
 * GET /ai-helper/admin/update/info
 *
 * 响应：
 * {
 *   pluginPath: string,      // 插件安装路径
 *   isValid: boolean,        // 路径是否有效
 *   message: string          // 验证消息
 * }
 */
export class UpdateInfoHandler extends Handler {
  async get() {
    try {
      const updateService = new UpdateService();
      const info = updateService.getPluginInfo();

      setJsonResponse(this, info);
    } catch (err) {
      console.error('[UpdateInfoHandler] Error:', err);
      setErrorResponse(this, 'UPDATE_INFO_FAILED', err instanceof Error ? err.message : '获取更新信息失败', 500);
    }
  }
}

// 导出路由权限配置 - root-only
export const UpdateInfoHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;

/**
 * UpdateHandler - 执行更新
 * POST /ai-helper/admin/update
 *
 * 响应：
 * {
 *   success: boolean,
 *   step: string,
 *   message: string,
 *   logs: string[],
 *   pluginPath?: string,
 *   error?: string
 * }
 */
export class UpdateHandler extends Handler {
  async post() {
    try {
      const updateService = new UpdateService();

      // 收集所有日志
      const allLogs: string[] = [];

      // 执行更新
      const result = await updateService.performUpdate((step, log) => {
        allLogs.push(`[${step}] ${log}`);
        console.log(`[UpdateHandler] ${step}: ${log}`);
      });

      setJsonResponse(this, {
        success: result.success,
        step: result.step,
        message: result.message,
        logs: result.logs,
        pluginPath: result.pluginPath,
        error: result.error
      });
    } catch (err) {
      console.error('[UpdateHandler] Error:', err);
      setErrorResponse(this, 'UPDATE_FAILED', err instanceof Error ? err.message : '更新失败', 500);
    }
  }
}

// 导出路由权限配置 - root-only
export const UpdateHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
