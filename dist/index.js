"use strict";
/**
 * HydroOJ AI Learning Assistant Plugin
 *
 * 教学优先的 AI 辅助学习插件
 * - 引导式学习，不提供完整代码
 * - 对话记录可追踪
 * - 符合教学研究需求
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply = exports.Config = void 0;
console.log('[AI-Helper] Loading plugin...');
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
const updateHandler_1 = require("./handlers/updateHandler");
console.log('[AI-Helper] updateHandler OK');
const conversation_1 = require("./models/conversation");
const message_1 = require("./models/message");
const rateLimitRecord_1 = require("./models/rateLimitRecord");
const aiConfig_1 = require("./models/aiConfig");
const jailbreakLog_1 = require("./models/jailbreakLog");
const versionCache_1 = require("./models/versionCache");
const pluginInstall_1 = require("./models/pluginInstall");
console.log('[AI-Helper] models OK');
const migrationService_1 = require("./services/migrationService");
const versionService_1 = require("./services/versionService");
const telemetryService_1 = require("./services/telemetryService");
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
        // 初始化数据库模型
        const db = ctx.db;
        const conversationModel = new conversation_1.ConversationModel(db);
        const messageModel = new message_1.MessageModel(db);
        const rateLimitRecordModel = new rateLimitRecord_1.RateLimitRecordModel(db);
        const aiConfigModel = new aiConfig_1.AIConfigModel(db);
        const jailbreakLogModel = new jailbreakLog_1.JailbreakLogModel(db);
        const versionCacheModel = new versionCache_1.VersionCacheModel(db);
        const pluginInstallModel = new pluginInstall_1.PluginInstallModel(db);
        // 创建数据库索引
        await conversationModel.ensureIndexes();
        await messageModel.ensureIndexes();
        await rateLimitRecordModel.ensureIndexes();
        await aiConfigModel.ensureIndexes();
        await jailbreakLogModel.ensureIndexes();
        await versionCacheModel.ensureIndexes();
        await pluginInstallModel.ensureIndexes();
        // 执行数据迁移（为历史数据添加 domainId）
        const migrationService = new migrationService_1.MigrationService(db);
        await migrationService.runAllMigrations();
        // 初始化插件安装记录
        const packageJson = require('../package.json');
        const currentVersion = packageJson.version || '1.8.0';
        await pluginInstallModel.createIfMissing(currentVersion);
        // 将模型实例注入到 ctx 中,供 Handler 使用
        ctx.provide('conversationModel', conversationModel);
        ctx.provide('messageModel', messageModel);
        ctx.provide('rateLimitRecordModel', rateLimitRecordModel);
        ctx.provide('aiConfigModel', aiConfigModel);
        ctx.provide('jailbreakLogModel', jailbreakLogModel);
        ctx.provide('versionCacheModel', versionCacheModel);
        ctx.provide('pluginInstallModel', pluginInstallModel);
        // 初始化版本服务
        const versionService = new versionService_1.VersionService(versionCacheModel);
        ctx.provide('versionService', versionService);
        // 初始化遥测服务（延迟 5 秒启动，避免阻塞插件加载）
        const telemetryService = new telemetryService_1.TelemetryService(pluginInstallModel, conversationModel);
        setTimeout(() => {
            telemetryService.init().catch(err => {
                console.error('[AI-Helper] Telemetry service initialization failed:', err);
            });
        }, 5000);
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
        // GET /ai-helper/admin/config - AI 配置页面 & JSON API（通过 Accept 头区分）
        ctx.Route('ai_helper_admin_config', '/ai-helper/admin/config', adminConfigHandler_1.AdminConfigHandler, adminConfigHandler_1.AdminConfigHandlerPriv);
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
    }
});
exports.Config = configSchema;
exports.apply = aiHelperPlugin.apply;
exports.default = aiHelperPlugin;
//# sourceMappingURL=index.js.map