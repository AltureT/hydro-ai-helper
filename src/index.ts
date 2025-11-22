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
import { ChatHandler, ChatHandlerPriv } from './handlers/studentHandler';
import {
  ConversationListHandler,
  ConversationListHandlerPriv,
  ConversationDetailHandler,
  ConversationDetailHandlerPriv
} from './handlers/teacherHandler';
import { AnalyticsHandler, AnalyticsHandlerPriv } from './handlers/analyticsHandler';
import { AdminConfigHandler, AdminConfigHandlerPriv } from './handlers/adminConfigHandler';
import { ExportHandler, ExportHandlerPriv } from './handlers/exportHandler';
import {
  GetConfigHandler,
  GetConfigHandlerPriv,
  UpdateConfigHandler,
  UpdateConfigHandlerPriv,
  TestConnectionHandler,
  TestConnectionHandlerPriv
} from './handlers/adminHandler';
import { ConversationModel } from './models/conversation';
import { MessageModel } from './models/message';
import { RateLimitRecordModel } from './models/rateLimitRecord';
import { AIConfigModel } from './models/aiConfig';
import { JailbreakLogModel } from './models/jailbreakLog';

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
    console.log('[AI Helper] Plugin loaded successfully');

    // 初始化数据库模型
    const db = ctx.db;
    const conversationModel = new ConversationModel(db);
    const messageModel = new MessageModel(db);
    const rateLimitRecordModel = new RateLimitRecordModel(db);
    const aiConfigModel = new AIConfigModel(db);
    const jailbreakLogModel = new JailbreakLogModel(db);

    // 创建数据库索引
    console.log('[AI Helper] Creating database indexes...');
    await conversationModel.ensureIndexes();
    await messageModel.ensureIndexes();
    await rateLimitRecordModel.ensureIndexes();
    await aiConfigModel.ensureIndexes();
    await jailbreakLogModel.ensureIndexes();
    console.log('[AI Helper] Database indexes created successfully');

    // 将模型实例注入到 ctx 中,供 Handler 使用
    ctx.provide('conversationModel', conversationModel);
    ctx.provide('messageModel', messageModel);
    ctx.provide('rateLimitRecordModel', rateLimitRecordModel);
    ctx.provide('aiConfigModel', aiConfigModel);
    ctx.provide('jailbreakLogModel', jailbreakLogModel);

    // 注册测试路由
    // GET /ai-helper/hello - 返回插件状态
    ctx.Route('ai_helper_hello', '/ai-helper/hello', HelloHandler, HelloHandlerPriv);

    // 注册学生端对话路由
    // POST /ai-helper/chat - 学生提交问题获得 AI 回答
    ctx.Route('ai_helper_chat', '/ai-helper/chat', ChatHandler, ChatHandlerPriv);

    // 注册教师端路由
    // 当前设计：AI 学习助手对话统计非常敏感，仅允许 root 访问。
    // 注意：这里使用的是 root-only 的系统权限（PRIV.PRIV_EDIT_SYSTEM），普通老师也无权访问。
    // TODO(如需求变更): 未来若有专门的教师统计角色，再考虑降低权限。

    // 注入控制面板菜单项
    ctx.injectUI('ControlPanel', 'ai_helper_conversations');
    ctx.injectUI('ControlPanel', 'ai_helper_analytics');
    ctx.injectUI('ControlPanel', 'ai_helper_admin_config');

    // GET /ai-helper/conversations - 获取对话列表
    ctx.Route('ai_helper_conversations', '/ai-helper/conversations', ConversationListHandler, ConversationListHandlerPriv);

    // GET /ai-helper/conversations/:id - 获取对话详情
    ctx.Route('ai_helper_conversation_detail', '/ai-helper/conversations/:id', ConversationDetailHandler, ConversationDetailHandlerPriv);

    // GET /ai-helper/analytics - AI 使用统计页面
    ctx.Route('ai_helper_analytics', '/ai-helper/analytics', AnalyticsHandler, AnalyticsHandlerPriv);

    // GET /ai-helper/admin/config - AI 配置页面
    ctx.Route('ai_helper_admin_config', '/ai-helper/admin/config', AdminConfigHandler, AdminConfigHandlerPriv);

    // GET /ai-helper/export - 数据导出 API
    ctx.Route('ai_helper_export', '/ai-helper/export', ExportHandler, ExportHandlerPriv);

    // 管理员配置 API (T021)
    // GET /ai-helper/admin/config - 获取当前配置
    ctx.Route('ai_helper_admin_get_config', '/ai-helper/admin/config', GetConfigHandler, GetConfigHandlerPriv);

    // PUT /ai-helper/admin/config - 更新配置
    ctx.Route('ai_helper_admin_update_config', '/ai-helper/admin/config', UpdateConfigHandler, UpdateConfigHandlerPriv);

    // POST /ai-helper/admin/test-connection - 测试连接
    ctx.Route('ai_helper_admin_test_connection', '/ai-helper/admin/test-connection', TestConnectionHandler, TestConnectionHandlerPriv);

    console.log('[AI Helper] Routes registered:');
    console.log('  - GET /ai-helper/hello (test route)');
    console.log('  - POST /ai-helper/chat (student chat API)');
    console.log('  - GET /ai-helper/conversations (teacher conversation list API)');
    console.log('  - GET /ai-helper/conversations/:id (teacher conversation detail API)');
    console.log('  - GET /ai-helper/analytics (teacher analytics page)');
    console.log('  - GET /ai-helper/admin/config (admin config page - legacy)');
    console.log('  - GET /ai-helper/export (data export API)');
    console.log('  - GET /ai-helper/admin/config (get AI config - T021)');
    console.log('  - PUT /ai-helper/admin/config (update AI config - T021)');
    console.log('  - POST /ai-helper/admin/test-connection (test AI connection - T021)');
  }
});

export const Config = configSchema;
export const apply = aiHelperPlugin.apply;
export default aiHelperPlugin;
