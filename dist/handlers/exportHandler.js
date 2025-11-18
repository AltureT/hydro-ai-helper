"use strict";
/**
 * Export Handler - 数据导出 API Handler
 *
 * 处理教师/管理员导出会话数据的请求
 * GET /ai-helper/export
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportHandlerPriv = exports.ExportHandler = void 0;
const hydrooj_1 = require("hydrooj");
const exportService_1 = require("../services/exportService");
/**
 * ExportHandler - 导出会话数据为 CSV 文件
 * GET /ai-helper/export?format=csv&startDate=...&endDate=...&classId=...&problemId=...&userId=...&includeSensitive=false
 */
class ExportHandler extends hydrooj_1.Handler {
    async get() {
        try {
            // 1. 解析查询参数
            const { format = 'csv', startDate, endDate, classId, problemId, userId, includeSensitive = 'false' } = this.request.query;
            // 2. 验证导出格式(目前仅支持 CSV)
            if (format !== 'csv') {
                this.response.status = 400;
                this.response.body = {
                    error: {
                        code: 'UNSUPPORTED_FORMAT',
                        message: '当前仅支持 CSV 导出(format=csv)'
                    }
                };
                this.response.type = 'application/json';
                return;
            }
            // 3. 构造筛选条件
            const filters = {};
            if (startDate) {
                try {
                    filters.startDate = new Date(startDate);
                }
                catch (err) {
                    this.response.status = 400;
                    this.response.body = {
                        error: {
                            code: 'INVALID_DATE',
                            message: `无效的开始日期: ${startDate}`
                        }
                    };
                    this.response.type = 'application/json';
                    return;
                }
            }
            if (endDate) {
                try {
                    filters.endDate = new Date(endDate);
                }
                catch (err) {
                    this.response.status = 400;
                    this.response.body = {
                        error: {
                            code: 'INVALID_DATE',
                            message: `无效的结束日期: ${endDate}`
                        }
                    };
                    this.response.type = 'application/json';
                    return;
                }
            }
            if (classId) {
                filters.classId = String(classId);
            }
            if (problemId) {
                filters.problemId = String(problemId);
            }
            if (userId) {
                filters.userId = String(userId);
            }
            // 4. 构造导出选项
            const options = {
                includeSensitive: includeSensitive === 'true'
            };
            console.log('[ExportHandler] Exporting conversations with filters:', filters);
            console.log('[ExportHandler] Export options:', options);
            // 5. 调用 ExportService 生成 CSV
            const exportService = new exportService_1.ExportService(this.ctx);
            const csv = await exportService.exportConversations(filters, options);
            // 6. 生成文件名(带时间戳)
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `ai_conversations_${timestamp}.csv`;
            console.log(`[ExportHandler] Generated CSV file: ${filename} (${csv.length} bytes)`);
            // 7. 设置响应头并返回 CSV 文件
            this.response.status = 200;
            this.response.type = 'text/csv';
            this.response.addHeader('Content-Disposition', `attachment; filename="${filename}"`);
            this.response.body = csv;
        }
        catch (err) {
            console.error('[ExportHandler] Export error:', err);
            this.response.status = 500;
            this.response.body = {
                error: {
                    code: 'EXPORT_ERROR',
                    message: err instanceof Error ? err.message : '数据导出失败'
                }
            };
            this.response.type = 'application/json';
        }
    }
}
exports.ExportHandler = ExportHandler;
/**
 * 导出路由权限配置
 * 使用 PRIV.PRIV_EDIT_SYSTEM (root-only 权限)
 * 数据导出敏感,仅允许系统管理员访问
 */
exports.ExportHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=exportHandler.js.map