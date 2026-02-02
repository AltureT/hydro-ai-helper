"use strict";
/**
 * Version Handler - 版本检测 API 处理器
 *
 * T051: 提供版本检测接口
 * GET /ai-helper/version/check - 检查版本更新
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionCheckHandlerPriv = exports.VersionCheckHandler = void 0;
const hydrooj_1 = require("hydrooj");
const httpHelpers_1 = require("../lib/httpHelpers");
/**
 * VersionCheckHandler - 检查版本更新
 * GET /ai-helper/version/check
 * GET /d/:domainId/ai-helper/version/check
 *
 * 查询参数：
 * - refresh: 是否强制刷新（忽略缓存），默认 false
 *
 * 响应：
 * {
 *   currentVersion: string,    // 当前安装版本
 *   latestVersion: string,     // 远程最新版本
 *   hasUpdate: boolean,        // 是否有可用更新
 *   releaseUrl: string,        // 发布页面 URL
 *   releaseNotes?: string,     // 更新说明（如有）
 *   checkedAt: string,         // 检查时间（ISO 格式）
 *   fromCache: boolean         // 是否来自缓存
 * }
 */
class VersionCheckHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const versionService = this.ctx.get('versionService');
            // 检查是否强制刷新
            const refresh = this.request.query.refresh === 'true';
            // 检查版本更新
            const result = await versionService.checkForUpdates(refresh);
            (0, httpHelpers_1.setJsonResponse)(this, {
                currentVersion: result.currentVersion,
                latestVersion: result.latestVersion,
                hasUpdate: result.hasUpdate,
                releaseUrl: result.releaseUrl,
                releaseNotes: result.releaseNotes,
                checkedAt: result.checkedAt.toISOString(),
                fromCache: result.fromCache,
                source: result.source
            });
        }
        catch (err) {
            console.error('[VersionCheckHandler] Error:', err);
            (0, httpHelpers_1.setErrorResponse)(this, 'VERSION_CHECK_FAILED', err instanceof Error ? err.message : '版本检查失败', 500);
        }
    }
}
exports.VersionCheckHandler = VersionCheckHandler;
// 导出路由权限配置
// 使用 PRIV.PRIV_EDIT_SYSTEM (root-only 权限)
// 版本检查仅限管理员访问
exports.VersionCheckHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=versionHandler.js.map