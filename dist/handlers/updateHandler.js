"use strict";
/**
 * UpdateHandler - 插件更新 API 处理器
 *
 * 提供插件在线更新接口：
 * GET /ai-helper/admin/update/info - 获取更新信息
 * GET /ai-helper/admin/update - 获取更新进度（前端轮询）
 * POST /ai-helper/admin/update - 执行更新
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateHandlerPriv = exports.UpdateHandler = exports.UpdateInfoHandlerPriv = exports.UpdateInfoHandler = void 0;
const hydrooj_1 = require("hydrooj");
const updateService_1 = require("../services/updateService");
const httpHelpers_1 = require("../lib/httpHelpers");
const csrfHelper_1 = require("../lib/csrfHelper");
const i18nHelper_1 = require("../utils/i18nHelper");
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const UPDATE_PROGRESS_FILENAME = '.update.progress.json';
const UPDATE_PROGRESS_MAX_LOGS = 800;
const getProgressFilePath = (pluginPath) => path.join(pluginPath, UPDATE_PROGRESS_FILENAME);
const readProgressFile = async (progressFilePath) => {
    try {
        const raw = await fsPromises.readFile(progressFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
            return null;
        return parsed;
    }
    catch (err) {
        if (err instanceof Error && err.code === 'ENOENT')
            return null;
        console.warn('[UpdateHandler] 读取更新进度文件失败:', err);
        return null;
    }
};
const writeProgressFile = async (progressFilePath, data) => {
    const tmpPath = `${progressFilePath}.tmp.${process.pid}.${Date.now()}`;
    try {
        await fsPromises.writeFile(tmpPath, JSON.stringify(data), 'utf-8');
        await fsPromises.rename(tmpPath, progressFilePath);
    }
    catch (err) {
        console.warn('[UpdateHandler] 写入更新进度文件失败:', err);
        try {
            await fsPromises.unlink(tmpPath);
        }
        catch {
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
class UpdateInfoHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const updateService = new updateService_1.UpdateService();
            const info = updateService.getPluginInfo();
            (0, httpHelpers_1.setJsonResponse)(this, info);
        }
        catch (err) {
            console.error('[UpdateInfoHandler] Error:', err);
            (0, httpHelpers_1.setErrorResponse)(this, 'UPDATE_INFO_FAILED', err instanceof Error ? err.message : this.translate('ai_helper_update_info_failed'), 500);
        }
    }
}
exports.UpdateInfoHandler = UpdateInfoHandler;
// 导出路由权限配置 - root-only
exports.UpdateInfoHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
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
class UpdateHandler extends hydrooj_1.Handler {
    /**
     * 获取更新进度（用于前端轮询）
     * GET /ai-helper/admin/update
     */
    async get() {
        try {
            // 🔒 强制管理员权限检查（PRIV/hasPriv；防御路由配置被绕过）
            if (!this.user.hasPriv(hydrooj_1.PRIV.PRIV_EDIT_SYSTEM)) {
                console.warn(`[UpdateHandler] 权限不足: 用户 ${this.user._id} 尝试读取更新进度`);
                return (0, httpHelpers_1.setErrorResponse)(this, 'PERMISSION_DENIED', this.translate('ai_helper_update_permission_read'), 403);
            }
            const updateService = new updateService_1.UpdateService();
            const pluginPath = updateService.getPluginPath();
            const progressFilePath = getProgressFilePath(pluginPath);
            const progress = await readProgressFile(progressFilePath);
            if (progress) {
                return (0, httpHelpers_1.setJsonResponse)(this, progress);
            }
            return (0, httpHelpers_1.setJsonResponse)(this, {
                status: 'idle',
                step: 'detecting',
                message: this.translate('ai_helper_update_no_task'),
                logs: [],
                pluginPath,
                updatedAt: new Date().toISOString()
            });
        }
        catch (err) {
            console.error('[UpdateHandler] Error:', err);
            (0, httpHelpers_1.setErrorResponse)(this, 'UPDATE_PROGRESS_FAILED', err instanceof Error ? err.message : this.translate('ai_helper_update_progress_failed'), 500);
        }
    }
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        const startedAt = new Date().toISOString();
        try {
            // 🔒 强制管理员权限检查（PRIV/hasPriv；防御路由配置被绕过）
            if (!this.user.hasPriv(hydrooj_1.PRIV.PRIV_EDIT_SYSTEM)) {
                console.warn(`[UpdateHandler] 权限不足: 用户 ${this.user._id} 尝试执行更新操作`);
                return (0, httpHelpers_1.setErrorResponse)(this, 'PERMISSION_DENIED', this.translate('ai_helper_update_permission_execute'), 403);
            }
            const updateService = new updateService_1.UpdateService();
            const pluginPath = updateService.getPluginPath();
            const progressFilePath = getProgressFilePath(pluginPath);
            // 初始化进度文件（前端轮询用）
            const progress = {
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
            let flushTimer = null;
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
                }
                finally {
                    flushing = false;
                }
            };
            const scheduleFlush = () => {
                if (flushTimer)
                    return;
                flushTimer = setTimeout(() => {
                    flushTimer = null;
                    void flush();
                }, 200);
            };
            const translateKey = (key, ...args) => {
                const translated = args.length > 0
                    ? (0, i18nHelper_1.translateWithParams)(this, key, ...args)
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
            (0, httpHelpers_1.setJsonResponse)(this, {
                success: result.success,
                step: result.step,
                message: translatedMessage,
                logs: progress.logs,
                pluginPath: result.pluginPath,
                error: translatedError
            });
        }
        catch (err) {
            console.error('[UpdateHandler] Error:', err);
            // best-effort：写入失败状态（避免前端一直显示“更新中”）
            try {
                const updateService = new updateService_1.UpdateService();
                const pluginPath = updateService.getPluginPath();
                const progressFilePath = getProgressFilePath(pluginPath);
                const failedAt = new Date().toISOString();
                const msg = err instanceof Error ? err.message : this.translate('ai_helper_update_failed');
                const progress = {
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
            }
            catch {
                // ignore
            }
            (0, httpHelpers_1.setErrorResponse)(this, 'UPDATE_FAILED', err instanceof Error ? err.message : this.translate('ai_helper_update_failed'), 500);
        }
    }
}
exports.UpdateHandler = UpdateHandler;
// 导出路由权限配置 - root-only
exports.UpdateHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=updateHandler.js.map