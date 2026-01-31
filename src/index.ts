/**
 * HydroOJ AI Learning Assistant Plugin
 *
 * 教学优先的 AI 辅助学习插件
 * - 引导式学习，不提供完整代码
 * - 对话记录可追踪
 * - 符合教学研究需求
 */

import { Context, definePlugin, Schema } from 'hydrooj';
import { HelloHandler, HelloHandlerPriv } from './handlers/testHandler';
import { ChatHandler, ChatHandlerPriv, ProblemStatusHandler, ProblemStatusHandlerPriv } from './handlers/studentHandler';
import {
  ConversationListHandler,
  ConversationListHandlerPriv,
  ConversationDetailHandler,
  ConversationDetailHandlerPriv
} from './handlers/teacherHandler';
import { AnalyticsHandler, AnalyticsHandlerPriv } from './handlers/analyticsHandler';
import { AdminConfigHandler, AdminConfigHandlerPriv } from './handlers/adminConfigHandler';
import { AIHelperDashboardHandler, AIHelperDashboardHandlerPriv } from './handlers/dashboardHandler';
import { ExportHandler, ExportHandlerPriv } from './handlers/exportHandler';
import { TestConnectionHandler, TestConnectionHandlerPriv, FetchModelsHandler, FetchModelsHandlerPriv } from './handlers/adminHandler';
import { VersionCheckHandler, VersionCheckHandlerPriv } from './handlers/versionHandler';
import { UpdateInfoHandler, UpdateInfoHandlerPriv, UpdateHandler, UpdateHandlerPriv } from './handlers/updateHandler';
import { ConversationModel } from './models/conversation';
import { MessageModel } from './models/message';
import { RateLimitRecordModel } from './models/rateLimitRecord';
import { AIConfigModel } from './models/aiConfig';
import { JailbreakLogModel } from './models/jailbreakLog';
import { VersionCacheModel } from './models/versionCache';
import { MigrationService } from './services/migrationService';
import { VersionService } from './services/versionService';

/**
 * 插件配置接口
 */
export interface AIHelperConfig {
  // 未来可在此添加配置项
}

/**
 * 插件入口函数
 * @param ctx HydroOJ Context
 * @param config 插件配置
 */
const configSchema = Schema.object({}).description('AI 助手插件配置（预留）').default({});

const aiHelperPlugin = definePlugin<AIHelperConfig>({
  name: 'hydro-ai-helper',
  schema: configSchema,
  async apply(ctx: Context) {
    // 初始化数据库模型
    const db = ctx.db;
    const conversationModel = new ConversationModel(db);
    const messageModel = new MessageModel(db);
    const rateLimitRecordModel = new RateLimitRecordModel(db);
    const aiConfigModel = new AIConfigModel(db);
    const jailbreakLogModel = new JailbreakLogModel(db);
    const versionCacheModel = new VersionCacheModel(db);

    // 创建数据库索引
    await conversationModel.ensureIndexes();
    await messageModel.ensureIndexes();
    await rateLimitRecordModel.ensureIndexes();
    await aiConfigModel.ensureIndexes();
    await jailbreakLogModel.ensureIndexes();
    await versionCacheModel.ensureIndexes();

    // 执行数据迁移（为历史数据添加 domainId）
    const migrationService = new MigrationService(db);
    await migrationService.runAllMigrations();

    // 将模型实例注入到 ctx 中,供 Handler 使用
    ctx.provide('conversationModel', conversationModel);
    ctx.provide('messageModel', messageModel);
    ctx.provide('rateLimitRecordModel', rateLimitRecordModel);
    ctx.provide('aiConfigModel', aiConfigModel);
    ctx.provide('jailbreakLogModel', jailbreakLogModel);
    ctx.provide('versionCacheModel', versionCacheModel);

    // 初始化版本服务
    const versionService = new VersionService(versionCacheModel);
    ctx.provide('versionService', versionService);

    // 注册测试路由
    // GET /ai-helper/hello - 返回插件状态
    ctx.Route('ai_helper_hello', '/ai-helper/hello', HelloHandler, HelloHandlerPriv);

    // 注册学生端对话路由 (支持域前缀)
    // POST /ai-helper/chat - 学生提交问题获得 AI 回答
    ctx.Route('ai_helper_chat', '/ai-helper/chat', ChatHandler, ChatHandlerPriv);
    // 域前缀路由: /d/:domainId/ai-helper/chat
    ctx.Route('ai_helper_chat_domain', '/d/:domainId/ai-helper/chat', ChatHandler, ChatHandlerPriv);

    // GET /ai-helper/problem-status/:problemId - 查询用户在该题的提交状态（是否已 AC）
    ctx.Route('ai_helper_problem_status', '/ai-helper/problem-status/:problemId', ProblemStatusHandler, ProblemStatusHandlerPriv);
    ctx.Route('ai_helper_problem_status_domain', '/d/:domainId/ai-helper/problem-status/:problemId', ProblemStatusHandler, ProblemStatusHandlerPriv);

    // 注册教师端路由 (支持域前缀)
    // 当前设计：AI 学习助手对话统计非常敏感，仅允许 root 访问。
    // 注意：这里使用的是 root-only 的系统权限（PRIV.PRIV_EDIT_SYSTEM），普通老师也无权访问。
    // TODO(如需求变更): 未来若有专门的教师统计角色，再考虑降低权限。

    // 注入控制面板菜单项（统一入口）
    ctx.injectUI('ControlPanel', 'ai_helper');

    // AI 助手统一入口路由
    ctx.Route('ai_helper', '/ai-helper', AIHelperDashboardHandler, AIHelperDashboardHandlerPriv);
    ctx.Route('ai_helper_domain', '/d/:domainId/ai-helper', AIHelperDashboardHandler, AIHelperDashboardHandlerPriv);

    // GET /ai-helper/conversations - 获取对话列表
    ctx.Route('ai_helper_conversations', '/ai-helper/conversations', ConversationListHandler, ConversationListHandlerPriv);
    ctx.Route('ai_helper_conversations_domain', '/d/:domainId/ai-helper/conversations', ConversationListHandler, ConversationListHandlerPriv);

    // GET /ai-helper/conversations/:id - 获取对话详情
    ctx.Route('ai_helper_conversation_detail', '/ai-helper/conversations/:id', ConversationDetailHandler, ConversationDetailHandlerPriv);
    ctx.Route('ai_helper_conversation_detail_domain', '/d/:domainId/ai-helper/conversations/:id', ConversationDetailHandler, ConversationDetailHandlerPriv);

    // GET /ai-helper/analytics - AI 使用统计页面
    ctx.Route('ai_helper_analytics', '/ai-helper/analytics', AnalyticsHandler, AnalyticsHandlerPriv);
    ctx.Route('ai_helper_analytics_domain', '/d/:domainId/ai-helper/analytics', AnalyticsHandler, AnalyticsHandlerPriv);

    // GET /ai-helper/admin/config - AI 配置页面 & JSON API（通过 Accept 头区分）
    ctx.Route('ai_helper_admin_config', '/ai-helper/admin/config', AdminConfigHandler, AdminConfigHandlerPriv);

    // GET /ai-helper/export - 数据导出 API
    ctx.Route('ai_helper_export', '/ai-helper/export', ExportHandler, ExportHandlerPriv);
    ctx.Route('ai_helper_export_domain', '/d/:domainId/ai-helper/export', ExportHandler, ExportHandlerPriv);

    // POST /ai-helper/admin/test-connection - 测试连接
    ctx.Route('ai_helper_admin_test_connection', '/ai-helper/admin/test-connection', TestConnectionHandler, TestConnectionHandlerPriv);

    // POST /ai-helper/admin/fetch-models - 获取可用模型列表
    ctx.Route('ai_helper_admin_fetch_models', '/ai-helper/admin/fetch-models', FetchModelsHandler, FetchModelsHandlerPriv);

    // T052: GET /ai-helper/version/check - 版本检测
    ctx.Route('ai_helper_version_check', '/ai-helper/version/check', VersionCheckHandler, VersionCheckHandlerPriv);
    ctx.Route('ai_helper_version_check_domain', '/d/:domainId/ai-helper/version/check', VersionCheckHandler, VersionCheckHandlerPriv);

    // 插件更新路由
    // GET /ai-helper/admin/update/info - 获取更新信息
    ctx.Route('ai_helper_update_info', '/ai-helper/admin/update/info', UpdateInfoHandler, UpdateInfoHandlerPriv);
    // POST /ai-helper/admin/update - 执行更新
    ctx.Route('ai_helper_update', '/ai-helper/admin/update', UpdateHandler, UpdateHandlerPriv);
  }
});

export const Config = configSchema;
export const apply = aiHelperPlugin.apply;
export default aiHelperPlugin;
