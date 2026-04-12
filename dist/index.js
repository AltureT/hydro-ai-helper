"use strict";
/**
 * HydroOJ AI Learning Assistant Plugin
 *
 * 教学优先的 AI 辅助学习插件
 * - 引导式学习，不提供完整代码
 * - 对话记录可追踪
 * - 符合教学研究需求
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply = exports.Config = void 0;
console.log('[AI-Helper] Loading plugin...');
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const hydrooj_1 = require("hydrooj");
console.log('[AI-Helper] hydrooj imports OK');
const testHandler_1 = require("./handlers/testHandler");
console.log('[AI-Helper] testHandler OK');
const studentHandler_1 = require("./handlers/studentHandler");
console.log('[AI-Helper] studentHandler OK');
const teacherHandler_1 = require("./handlers/teacherHandler");
console.log('[AI-Helper] teacherHandler OK');
const analyticsHandler_1 = require("./handlers/analyticsHandler");
console.log('[AI-Helper] analyticsHandler OK');
const adminConfigHandler_1 = require("./handlers/adminConfigHandler");
console.log('[AI-Helper] adminConfigHandler OK');
const dashboardHandler_1 = require("./handlers/dashboardHandler");
console.log('[AI-Helper] dashboardHandler OK');
const exportHandler_1 = require("./handlers/exportHandler");
console.log('[AI-Helper] exportHandler OK');
const adminHandler_1 = require("./handlers/adminHandler");
console.log('[AI-Helper] adminHandler OK');
const versionHandler_1 = require("./handlers/versionHandler");
console.log('[AI-Helper] versionHandler OK');
const costAnalyticsHandler_1 = require("./handlers/costAnalyticsHandler");
console.log('[AI-Helper] costAnalyticsHandler OK');
const batchSummaryHandler_1 = require("./handlers/batchSummaryHandler");
console.log('[AI-Helper] batchSummaryHandler OK');
const feedbackHandler_1 = require("./handlers/feedbackHandler");
console.log('[AI-Helper] feedbackHandler OK');
const teachingSummaryHandler_1 = require("./handlers/teachingSummaryHandler");
const teachingSummary_1 = require("./models/teachingSummary");
const updateHandler_1 = require("./handlers/updateHandler");
console.log('[AI-Helper] updateHandler OK');
const conversation_1 = require("./models/conversation");
const message_1 = require("./models/message");
const rateLimitRecord_1 = require("./models/rateLimitRecord");
const aiConfig_1 = require("./models/aiConfig");
const jailbreakLog_1 = require("./models/jailbreakLog");
const versionCache_1 = require("./models/versionCache");
const pluginInstall_1 = require("./models/pluginInstall");
const tokenUsage_1 = require("./models/tokenUsage");
const batchSummaryJob_1 = require("./models/batchSummaryJob");
const studentSummary_1 = require("./models/studentSummary");
const studentHistory_1 = require("./models/studentHistory");
console.log('[AI-Helper] models OK');
const migrationService_1 = require("./services/migrationService");
const versionService_1 = require("./services/versionService");
const telemetryService_1 = require("./services/telemetryService");
const effectivenessService_1 = require("./services/effectivenessService");
const errorReporter_1 = require("./services/errorReporter");
const requestStats_1 = require("./models/requestStats");
console.log('[AI-Helper] services OK');
console.log('[AI-Helper] All imports completed successfully');
/**
 * 插件入口函数
 * @param ctx HydroOJ Context
 * @param config 插件配置
 */
const configSchema = hydrooj_1.Schema.object({}).description('AI 助手插件配置（预留）').default({});
const aiHelperPlugin = (0, hydrooj_1.definePlugin)({
    name: 'hydro-ai-helper',
    schema: configSchema,
    async apply(ctx) {
        // 加载 locale 文件（确保插件翻译注册到 HydroOJ i18n 系统）
        const localesDir = path_1.default.resolve(__dirname, '..', 'locales');
        if (fs_1.default.existsSync(localesDir)) {
            for (const file of fs_1.default.readdirSync(localesDir)) {
                if (!file.endsWith('.yaml') && !file.endsWith('.yml'))
                    continue;
                try {
                    const content = fs_1.default.readFileSync(path_1.default.join(localesDir, file), 'utf-8');
                    const dict = js_yaml_1.default.load(content);
                    if (dict && typeof dict === 'object') {
                        ctx.i18n.load(file.split('.')[0], dict);
                    }
                }
                catch (e) {
                    console.warn(`[AI-Helper] Failed to load locale ${file}:`, e);
                }
            }
            console.log('[AI-Helper] Locales loaded');
        }
        // 初始化数据库模型
        const db = ctx.db;
        const conversationModel = new conversation_1.ConversationModel(db);
        const messageModel = new message_1.MessageModel(db);
        // @deprecated — 限流已迁移到 HydroOJ 内置 limitRate (opcount)，
        // rateLimitRecordModel 仅保留以防止引用断裂，ai_rate_limit_records 集合通过 TTL 自动清空。
        const rateLimitRecordModel = new rateLimitRecord_1.RateLimitRecordModel(db);
        const aiConfigModel = new aiConfig_1.AIConfigModel(db);
        const jailbreakLogModel = new jailbreakLog_1.JailbreakLogModel(db);
        const versionCacheModel = new versionCache_1.VersionCacheModel(db);
        const pluginInstallModel = new pluginInstall_1.PluginInstallModel(db);
        const tokenUsageModel = new tokenUsage_1.TokenUsageModel(db);
        const requestStatsModel = new requestStats_1.RequestStatsModel(db);
        const batchSummaryJobModel = new batchSummaryJob_1.BatchSummaryJobModel(db);
        const studentSummaryModel = new studentSummary_1.StudentSummaryModel(db);
        const studentHistoryModel = new studentHistory_1.StudentHistoryModel(db);
        const teachingSummaryModel = new teachingSummary_1.TeachingSummaryModel(db);
        // ErrorReporter 需要在索引创建之前实例化，以便捕获启动错误
        const errorReporter = new errorReporter_1.ErrorReporter(pluginInstallModel);
        // 创建数据库索引（逐个容错，单个失败不阻塞插件加载）
        const safeEnsureIndexes = async (model, name) => {
            try {
                await model.ensureIndexes();
            }
            catch (err) {
                console.warn(`[AI-Helper] ${name} 索引创建失败，插件继续运行:`, err);
                errorReporter.capture('startup_failure', 'db', `Index creation failed: ${name}`, undefined, err instanceof Error ? err.stack : undefined);
            }
        };
        await safeEnsureIndexes(conversationModel, 'conversationModel');
        await safeEnsureIndexes(messageModel, 'messageModel');
        await safeEnsureIndexes(rateLimitRecordModel, 'rateLimitRecordModel');
        await safeEnsureIndexes(aiConfigModel, 'aiConfigModel');
        await safeEnsureIndexes(jailbreakLogModel, 'jailbreakLogModel');
        await safeEnsureIndexes(versionCacheModel, 'versionCacheModel');
        await safeEnsureIndexes(pluginInstallModel, 'pluginInstallModel');
        await safeEnsureIndexes(tokenUsageModel, 'tokenUsageModel');
        await safeEnsureIndexes(requestStatsModel, 'requestStatsModel');
        await safeEnsureIndexes(batchSummaryJobModel, 'batchSummaryJobModel');
        await safeEnsureIndexes(studentSummaryModel, 'studentSummaryModel');
        await safeEnsureIndexes(studentHistoryModel, 'studentHistoryModel');
        await safeEnsureIndexes(teachingSummaryModel, 'teachingSummaryModel');
        // 执行数据迁移（为历史数据添加 domainId）
        const migrationService = new migrationService_1.MigrationService(db);
        await migrationService.runAllMigrations();
        // 初始化插件安装记录
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const packageJson = require('../package.json');
        const currentVersion = packageJson.version || '1.8.0';
        await pluginInstallModel.createIfMissing(currentVersion);
        // 密钥轮换：当 OLD_ENCRYPTION_KEY 存在时，自动重加密所有 API Key
        if (process.env.OLD_ENCRYPTION_KEY) {
            try {
                const reEncryptedCount = await aiConfigModel.reEncryptAllKeys();
                if (reEncryptedCount > 0) {
                    console.log(`[AI-Helper] Key rotation: re-encrypted ${reEncryptedCount} key(s). You can now remove OLD_ENCRYPTION_KEY.`);
                }
                else {
                    console.log('[AI-Helper] Key rotation: all keys already use current encryption key.');
                }
            }
            catch (err) {
                console.error('[AI-Helper] Key rotation failed:', err instanceof Error ? err.message : 'unknown error');
                errorReporter.capture('startup_failure', 'config', `Key rotation failed: ${err instanceof Error ? err.message : 'unknown'}`, undefined, err instanceof Error ? err.stack : undefined);
            }
        }
        // 将模型实例注入到 ctx 中,供 Handler 使用
        ctx.provide('conversationModel', conversationModel);
        ctx.provide('messageModel', messageModel);
        ctx.provide('rateLimitRecordModel', rateLimitRecordModel);
        ctx.provide('aiConfigModel', aiConfigModel);
        ctx.provide('jailbreakLogModel', jailbreakLogModel);
        ctx.provide('versionCacheModel', versionCacheModel);
        ctx.provide('pluginInstallModel', pluginInstallModel);
        ctx.provide('tokenUsageModel', tokenUsageModel);
        ctx.provide('requestStatsModel', requestStatsModel);
        ctx.provide('batchSummaryJobModel', batchSummaryJobModel);
        ctx.provide('studentSummaryModel', studentSummaryModel);
        ctx.provide('studentHistoryModel', studentHistoryModel);
        ctx.provide('teachingSummaryModel', teachingSummaryModel);
        ctx.provide('errorReporter', errorReporter);
        // 初始化版本服务
        const versionService = new versionService_1.VersionService(versionCacheModel);
        ctx.provide('versionService', versionService);
        // 初始化遥测服务（延迟 5 秒启动，避免阻塞插件加载）
        const telemetryService = new telemetryService_1.TelemetryService(pluginInstallModel, conversationModel, aiConfigModel, requestStatsModel, errorReporter);
        ctx.provide('telemetryService', telemetryService);
        setTimeout(() => {
            telemetryService.init().catch(err => {
                console.error('[AI-Helper] Telemetry service initialization failed:', err);
            });
            errorReporter.start();
        }, 5000);
        // 补偿回填独立延迟启动，避免阻塞遥测初始化
        setTimeout(() => {
            const effectivenessService = new effectivenessService_1.EffectivenessService(ctx);
            effectivenessService.compensateBackfill().catch(err => {
                console.error('[AI-Helper] Effectiveness compensate backfill failed:', err);
            });
        }, 10000);
        // 注册测试路由
        // GET /ai-helper/hello - 返回插件状态
        ctx.Route('ai_helper_hello', '/ai-helper/hello', testHandler_1.HelloHandler, testHandler_1.HelloHandlerPriv);
        // 注册学生端对话路由 (支持域前缀)
        // POST /ai-helper/chat - 学生提交问题获得 AI 回答
        ctx.Route('ai_helper_chat', '/ai-helper/chat', studentHandler_1.ChatHandler, studentHandler_1.ChatHandlerPriv);
        // 域前缀路由: /d/:domainId/ai-helper/chat
        ctx.Route('ai_helper_chat_domain', '/d/:domainId/ai-helper/chat', studentHandler_1.ChatHandler, studentHandler_1.ChatHandlerPriv);
        // GET /ai-helper/problem-status/:problemId - 查询用户在该题的提交状态（是否已 AC）
        ctx.Route('ai_helper_problem_status', '/ai-helper/problem-status/:problemId', studentHandler_1.ProblemStatusHandler, studentHandler_1.ProblemStatusHandlerPriv);
        ctx.Route('ai_helper_problem_status_domain', '/d/:domainId/ai-helper/problem-status/:problemId', studentHandler_1.ProblemStatusHandler, studentHandler_1.ProblemStatusHandlerPriv);
        // 注册教师端路由 (支持域前缀)
        // 当前设计：AI 学习助手对话统计非常敏感，仅允许 root 访问。
        // 注意：这里使用的是 root-only 的系统权限（PRIV.PRIV_EDIT_SYSTEM），普通老师也无权访问。
        // TODO(如需求变更): 未来若有专门的教师统计角色，再考虑降低权限。
        // 注入控制面板菜单项（统一入口）
        ctx.injectUI('ControlPanel', 'ai_helper');
        // AI 助手统一入口路由
        ctx.Route('ai_helper', '/ai-helper', dashboardHandler_1.AIHelperDashboardHandler, dashboardHandler_1.AIHelperDashboardHandlerPriv);
        ctx.Route('ai_helper_domain', '/d/:domainId/ai-helper', dashboardHandler_1.AIHelperDashboardHandler, dashboardHandler_1.AIHelperDashboardHandlerPriv);
        // GET /ai-helper/conversations - 获取对话列表
        ctx.Route('ai_helper_conversations', '/ai-helper/conversations', teacherHandler_1.ConversationListHandler, teacherHandler_1.ConversationListHandlerPriv);
        ctx.Route('ai_helper_conversations_domain', '/d/:domainId/ai-helper/conversations', teacherHandler_1.ConversationListHandler, teacherHandler_1.ConversationListHandlerPriv);
        // GET /ai-helper/conversations/:id - 获取对话详情
        ctx.Route('ai_helper_conversation_detail', '/ai-helper/conversations/:id', teacherHandler_1.ConversationDetailHandler, teacherHandler_1.ConversationDetailHandlerPriv);
        ctx.Route('ai_helper_conversation_detail_domain', '/d/:domainId/ai-helper/conversations/:id', teacherHandler_1.ConversationDetailHandler, teacherHandler_1.ConversationDetailHandlerPriv);
        // GET /ai-helper/analytics - AI 使用统计页面
        ctx.Route('ai_helper_analytics', '/ai-helper/analytics', analyticsHandler_1.AnalyticsHandler, analyticsHandler_1.AnalyticsHandlerPriv);
        ctx.Route('ai_helper_analytics_domain', '/d/:domainId/ai-helper/analytics', analyticsHandler_1.AnalyticsHandler, analyticsHandler_1.AnalyticsHandlerPriv);
        // GET /ai-helper/analytics/filter-options - 筛选条件可选值（班级/题目自动补全）
        ctx.Route('ai_helper_analytics_filter_options', '/ai-helper/analytics/filter-options', analyticsHandler_1.AnalyticsFilterOptionsHandler, analyticsHandler_1.AnalyticsFilterOptionsHandlerPriv);
        ctx.Route('ai_helper_analytics_filter_options_domain', '/d/:domainId/ai-helper/analytics/filter-options', analyticsHandler_1.AnalyticsFilterOptionsHandler, analyticsHandler_1.AnalyticsFilterOptionsHandlerPriv);
        // GET /ai-helper/admin/config - AI 配置页面 & JSON API（通过 Accept 头区分）
        ctx.Route('ai_helper_admin_config', '/ai-helper/admin/config', adminConfigHandler_1.AdminConfigHandler, adminConfigHandler_1.AdminConfigHandlerPriv);
        // GET /ai-helper/admin/jailbreak-logs - 越狱日志独立分页端点
        ctx.Route('ai_helper_admin_jailbreak_logs', '/ai-helper/admin/jailbreak-logs', adminConfigHandler_1.JailbreakLogsHandler, adminConfigHandler_1.JailbreakLogsHandlerPriv);
        // GET /ai-helper/export - 数据导出 API
        ctx.Route('ai_helper_export', '/ai-helper/export', exportHandler_1.ExportHandler, exportHandler_1.ExportHandlerPriv);
        ctx.Route('ai_helper_export_domain', '/d/:domainId/ai-helper/export', exportHandler_1.ExportHandler, exportHandler_1.ExportHandlerPriv);
        // POST /ai-helper/admin/test-connection - 测试连接
        ctx.Route('ai_helper_admin_test_connection', '/ai-helper/admin/test-connection', adminHandler_1.TestConnectionHandler, adminHandler_1.TestConnectionHandlerPriv);
        // POST /ai-helper/admin/fetch-models - 获取可用模型列表
        ctx.Route('ai_helper_admin_fetch_models', '/ai-helper/admin/fetch-models', adminHandler_1.FetchModelsHandler, adminHandler_1.FetchModelsHandlerPriv);
        // T052: GET /ai-helper/version/check - 版本检测
        ctx.Route('ai_helper_version_check', '/ai-helper/version/check', versionHandler_1.VersionCheckHandler, versionHandler_1.VersionCheckHandlerPriv);
        ctx.Route('ai_helper_version_check_domain', '/d/:domainId/ai-helper/version/check', versionHandler_1.VersionCheckHandler, versionHandler_1.VersionCheckHandlerPriv);
        // 插件更新路由
        // GET /ai-helper/admin/update/info - 获取更新信息
        ctx.Route('ai_helper_update_info', '/ai-helper/admin/update/info', updateHandler_1.UpdateInfoHandler, updateHandler_1.UpdateInfoHandlerPriv);
        // POST /ai-helper/admin/update - 执行更新
        ctx.Route('ai_helper_update', '/ai-helper/admin/update', updateHandler_1.UpdateHandler, updateHandler_1.UpdateHandlerPriv);
        // POST /ai-helper/admin/feedback - 管理员反馈提交
        ctx.Route('ai_helper_admin_feedback', '/ai-helper/admin/feedback', feedbackHandler_1.FeedbackHandler, feedbackHandler_1.FeedbackHandlerPriv);
        // GET /ai-helper/analytics/cost - 成本分析 API
        ctx.Route('ai_helper_cost_analytics', '/ai-helper/analytics/cost', costAnalyticsHandler_1.CostAnalyticsHandler, costAnalyticsHandler_1.CostAnalyticsHandlerPriv);
        ctx.Route('ai_helper_cost_analytics_domain', '/d/:domainId/ai-helper/analytics/cost', costAnalyticsHandler_1.CostAnalyticsHandler, costAnalyticsHandler_1.CostAnalyticsHandlerPriv);
        // 批量摘要路由
        // GET /ai-helper/batch-summaries/latest?contestId=xxx - 查询最新任务
        ctx.Route('ai_batch_summary_latest', '/ai-helper/batch-summaries/latest', batchSummaryHandler_1.BatchSummaryLatestHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_latest_domain', '/d/:domainId/ai-helper/batch-summaries/latest', batchSummaryHandler_1.BatchSummaryLatestHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // POST /ai-helper/batch-summaries/generate - 触发批量生成
        ctx.Route('ai_batch_summary_generate', '/ai-helper/batch-summaries/generate', batchSummaryHandler_1.BatchSummaryGenerateHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_generate_domain', '/d/:domainId/ai-helper/batch-summaries/generate', batchSummaryHandler_1.BatchSummaryGenerateHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // GET /ai-helper/batch-summaries/:jobId/result - 查询任务结果
        ctx.Route('ai_batch_summary_result', '/ai-helper/batch-summaries/:jobId/result', batchSummaryHandler_1.BatchSummaryResultHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_result_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/result', batchSummaryHandler_1.BatchSummaryResultHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // POST /ai-helper/batch-summaries/:jobId/retry/:userId - 重试失败摘要
        ctx.Route('ai_batch_summary_retry', '/ai-helper/batch-summaries/:jobId/retry/:userId', batchSummaryHandler_1.BatchSummaryRetryHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_retry_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/retry/:userId', batchSummaryHandler_1.BatchSummaryRetryHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // POST /ai-helper/batch-summaries/:jobId/publish - 发布摘要
        ctx.Route('ai_batch_summary_publish', '/ai-helper/batch-summaries/:jobId/publish', batchSummaryHandler_1.BatchSummaryPublishHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_publish_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/publish', batchSummaryHandler_1.BatchSummaryPublishHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // GET /ai-helper/batch-summaries/:jobId/export - 导出 CSV
        ctx.Route('ai_batch_summary_export', '/ai-helper/batch-summaries/:jobId/export', batchSummaryHandler_1.BatchSummaryExportHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_export_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/export', batchSummaryHandler_1.BatchSummaryExportHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // POST /ai-helper/batch-summaries/:jobId/edit/:userId - 编辑摘要
        ctx.Route('ai_batch_summary_edit', '/ai-helper/batch-summaries/:jobId/edit/:userId', batchSummaryHandler_1.BatchSummaryEditHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_edit_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/edit/:userId', batchSummaryHandler_1.BatchSummaryEditHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // POST /ai-helper/batch-summaries/:jobId/retry-failed - 批量重试失败
        ctx.Route('ai_batch_summary_retry_failed', '/ai-helper/batch-summaries/:jobId/retry-failed', batchSummaryHandler_1.BatchSummaryRetryFailedHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_retry_failed_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/retry-failed', batchSummaryHandler_1.BatchSummaryRetryFailedHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // POST /ai-helper/batch-summaries/:jobId/stop - 停止生成
        ctx.Route('ai_batch_summary_stop', '/ai-helper/batch-summaries/:jobId/stop', batchSummaryHandler_1.BatchSummaryStopHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_stop_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/stop', batchSummaryHandler_1.BatchSummaryStopHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // POST /ai-helper/batch-summaries/:jobId/continue - 继续生成
        ctx.Route('ai_batch_summary_continue', '/ai-helper/batch-summaries/:jobId/continue', batchSummaryHandler_1.BatchSummaryContinueHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        ctx.Route('ai_batch_summary_continue_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/continue', batchSummaryHandler_1.BatchSummaryContinueHandler, hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
        // GET /ai-helper/batch-summaries/my-summary?contestId=xxx - 学生查看自己的已发布总结
        ctx.Route('ai_batch_summary_my', '/ai-helper/batch-summaries/my-summary', batchSummaryHandler_1.StudentSummaryHandler, hydrooj_1.PRIV.PRIV_USER_PROFILE);
        ctx.Route('ai_batch_summary_my_domain', '/d/:domainId/ai-helper/batch-summaries/my-summary', batchSummaryHandler_1.StudentSummaryHandler, hydrooj_1.PRIV.PRIV_USER_PROFILE);
        // 教学建议路由
        ctx.Route('ai_teaching_summary', '/ai-helper/teaching-summary/:contestId', teachingSummaryHandler_1.TeachingSummaryHandler, teachingSummaryHandler_1.TeachingSummaryHandlerPriv);
        ctx.Route('ai_teaching_summary_domain', '/d/:domainId/ai-helper/teaching-summary/:contestId', teachingSummaryHandler_1.TeachingSummaryHandler, teachingSummaryHandler_1.TeachingSummaryHandlerPriv);
        ctx.Route('ai_teaching_review', '/ai-helper/teaching-review', teachingSummaryHandler_1.TeachingReviewHandler, teachingSummaryHandler_1.TeachingSummaryHandlerPriv);
        ctx.Route('ai_teaching_review_domain', '/d/:domainId/ai-helper/teaching-review', teachingSummaryHandler_1.TeachingReviewHandler, teachingSummaryHandler_1.TeachingSummaryHandlerPriv);
        ctx.Route('ai_teaching_summary_feedback', '/ai-helper/teaching-summary/:summaryId/feedback', teachingSummaryHandler_1.TeachingSummaryFeedbackHandler, teachingSummaryHandler_1.TeachingSummaryHandlerPriv);
        ctx.Route('ai_teaching_summary_feedback_domain', '/d/:domainId/ai-helper/teaching-summary/:summaryId/feedback', teachingSummaryHandler_1.TeachingSummaryFeedbackHandler, teachingSummaryHandler_1.TeachingSummaryHandlerPriv);
    }
});
exports.Config = configSchema;
exports.apply = aiHelperPlugin.apply;
exports.default = aiHelperPlugin;
//# sourceMappingURL=index.js.map