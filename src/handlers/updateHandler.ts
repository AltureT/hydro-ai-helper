/**
 * UpdateHandler - 插件更新 API 处理器
 *
 * 提供插件在线更新接口：
 * GET /ai-helper/admin/update/info - 获取更新信息
 * GET /ai-helper/admin/update - 获取更新进度（前端轮询）
 * POST /ai-helper/admin/update - 执行更新
 */

import { Handler, PRIV } from 'hydrooj';
import { UpdateService } from '../services/updateService';
import { setJsonResponse, setErrorResponse } from '../lib/httpHelpers';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { translateWithParams } from '../utils/i18nHelper';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

const UPDATE_PROGRESS_FILENAME = '.update.progress.json';
const UPDATE_PROGRESS_MAX_LOGS = 800;

type UpdateProgressStatus = 'idle' | 'running' | 'completed' | 'failed';

interface UpdateProgressData {
  status: UpdateProgressStatus;
  step: string;
  message: string;
  logs: string[];
  pluginPath: string;
  startedAt?: string;
  updatedAt: string;
  error?: string;
}

const getProgressFilePath = (pluginPath: string): string => path.join(pluginPath, UPDATE_PROGRESS_FILENAME);

const readProgressFile = async (progressFilePath: string): Promise<UpdateProgressData | null> => {
  try {
    const raw = await fsPromises.readFile(progressFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as UpdateProgressData;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn('[UpdateHandler] 读取更新进度文件失败:', err);
    return null;
  }
};

const writeProgressFile = async (progressFilePath: string, data: UpdateProgressData): Promise<void> => {
  const tmpPath = `${progressFilePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fsPromises.writeFile(tmpPath, JSON.stringify(data), 'utf-8');
    await fsPromises.rename(tmpPath, progressFilePath);
  } catch (err) {
    console.warn('[UpdateHandler] 写入更新进度文件失败:', err);
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      // ignore
    }
  }
};

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
      setErrorResponse(this, 'UPDATE_INFO_FAILED', err instanceof Error ? err.message : this.translate('ai_helper_update_info_failed'), 500);
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
  /**
   * 获取更新进度（用于前端轮询）
   * GET /ai-helper/admin/update
   */
  async get() {
    try {
      // 🔒 强制管理员权限检查（PRIV/hasPriv；防御路由配置被绕过）
      if (!this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
        console.warn(`[UpdateHandler] 权限不足: 用户 ${this.user._id} 尝试读取更新进度`);
        return setErrorResponse(
          this,
          'PERMISSION_DENIED',
          this.translate('ai_helper_update_permission_read'),
          403
        );
      }

      const updateService = new UpdateService();
      const pluginPath = updateService.getPluginPath();
      const progressFilePath = getProgressFilePath(pluginPath);

      const progress = await readProgressFile(progressFilePath);
      if (progress) {
        return setJsonResponse(this, progress);
      }

      return setJsonResponse(this, {
        status: 'idle',
        step: 'detecting',
        message: this.translate('ai_helper_update_no_task'),
        logs: [],
        pluginPath,
        updatedAt: new Date().toISOString()
      } satisfies UpdateProgressData);
    } catch (err) {
      console.error('[UpdateHandler] Error:', err);
      setErrorResponse(this, 'UPDATE_PROGRESS_FAILED', err instanceof Error ? err.message : this.translate('ai_helper_update_progress_failed'), 500);
    }
  }

  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    const startedAt = new Date().toISOString();
    try {
      // 🔒 强制管理员权限检查（PRIV/hasPriv；防御路由配置被绕过）
      if (!this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
        console.warn(`[UpdateHandler] 权限不足: 用户 ${this.user._id} 尝试执行更新操作`);
        return setErrorResponse(
          this,
          'PERMISSION_DENIED',
          this.translate('ai_helper_update_permission_execute'),
          403
        );
      }

      const updateService = new UpdateService();
      const pluginPath = updateService.getPluginPath();
      const progressFilePath = getProgressFilePath(pluginPath);

      // 初始化进度文件（前端轮询用）
      const progress: UpdateProgressData = {
        status: 'running',
        step: 'detecting',
        message: this.translate('ai_helper_update_started'),
        logs: [],
        pluginPath,
        startedAt,
        updatedAt: startedAt
      };

      // best-effort：进度文件写失败不影响更新流程
      await writeProgressFile(progressFilePath, progress);

      // 写入节流（避免 npm/git 输出过密导致频繁写盘）
      let flushTimer: NodeJS.Timeout | null = null;
      let flushing = false;
      let flushAgain = false;

      const flush = async () => {
        if (flushing) {
          flushAgain = true;
          return;
        }
        flushing = true;
        try {
          do {
            flushAgain = false;
            await writeProgressFile(progressFilePath, progress);
          } while (flushAgain);
        } finally {
          flushing = false;
        }
      };

      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          void flush();
        }, 200);
      };

      const translateKey = (key: string, ...args: string[]): string => {
        const translated = args.length > 0
          ? translateWithParams(this, key, ...args)
          : this.translate(key);
        return translated !== key ? translated : key;
      };

      const result = await updateService.performUpdate((step, messageKey, ...messageArgs) => {
        const translatedMsg = translateKey(messageKey, ...messageArgs);
        const entry = `[${step}] ${translatedMsg}`;
        progress.step = step;
        progress.message = translatedMsg;
        progress.logs.push(entry);
        if (progress.logs.length > UPDATE_PROGRESS_MAX_LOGS) {
          progress.logs = progress.logs.slice(-UPDATE_PROGRESS_MAX_LOGS);
        }
        progress.updatedAt = new Date().toISOString();
        scheduleFlush();

        console.log(`[UpdateHandler] ${step}: ${translatedMsg}`);
      });

      const translatedMessage = result.messageKey
        ? translateKey(result.messageKey, ...(result.messageArgs || []))
        : result.message;
      const translatedError = result.errorKey
        ? translateKey(result.errorKey, ...(result.errorArgs || []))
        : result.error;

      progress.status = result.success ? 'completed' : 'failed';
      progress.step = result.step;
      progress.message = translatedMessage;
      // progress.logs already has translated entries from the callback;
      // trim to max size for the final write
      if (progress.logs.length > UPDATE_PROGRESS_MAX_LOGS) {
        progress.logs = progress.logs.slice(-UPDATE_PROGRESS_MAX_LOGS);
      }
      progress.error = translatedError;
      progress.updatedAt = new Date().toISOString();
      await flush();

      setJsonResponse(this, {
        success: result.success,
        step: result.step,
        message: translatedMessage,
        logs: progress.logs,
        pluginPath: result.pluginPath,
        error: translatedError
      });
    } catch (err) {
      console.error('[UpdateHandler] Error:', err);
      // best-effort：写入失败状态（避免前端一直显示“更新中”）
      try {
        const updateService = new UpdateService();
        const pluginPath = updateService.getPluginPath();
        const progressFilePath = getProgressFilePath(pluginPath);
        const failedAt = new Date().toISOString();
        const msg = err instanceof Error ? err.message : this.translate('ai_helper_update_failed');
        const progress: UpdateProgressData = {
          status: 'failed',
          step: 'failed',
          message: msg,
          logs: [`[failed] ${msg}`],
          pluginPath,
          startedAt,
          updatedAt: failedAt,
          error: msg
        };
        await writeProgressFile(progressFilePath, progress);
      } catch {
        // ignore
      }
      setErrorResponse(this, 'UPDATE_FAILED', err instanceof Error ? err.message : this.translate('ai_helper_update_failed'), 500);
    }
  }
}

// 导出路由权限配置 - root-only
export const UpdateHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
