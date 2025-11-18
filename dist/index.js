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
const hydrooj_1 = require("hydrooj");
const testHandler_1 = require("./handlers/testHandler");
const studentHandler_1 = require("./handlers/studentHandler");
const teacherHandler_1 = require("./handlers/teacherHandler");
const conversation_1 = require("./models/conversation");
const message_1 = require("./models/message");
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
        console.log('[AI Helper] Plugin loaded successfully');
        // 初始化数据库模型
        const db = ctx.db;
        const conversationModel = new conversation_1.ConversationModel(db);
        const messageModel = new message_1.MessageModel(db);
        // 创建数据库索引
        console.log('[AI Helper] Creating database indexes...');
        await conversationModel.ensureIndexes();
        await messageModel.ensureIndexes();
        console.log('[AI Helper] Database indexes created successfully');
        // 将模型实例注入到 ctx 中,供 Handler 使用
        ctx.provide('conversationModel', conversationModel);
        ctx.provide('messageModel', messageModel);
        // 注册测试路由
        // GET /ai-helper/hello - 返回插件状态
        ctx.Route('ai_helper_hello', '/ai-helper/hello', testHandler_1.HelloHandler, testHandler_1.HelloHandlerPriv);
        // 注册学生端对话路由
        // POST /ai-helper/chat - 学生提交问题获得 AI 回答
        ctx.Route('ai_helper_chat', '/ai-helper/chat', studentHandler_1.ChatHandler, studentHandler_1.ChatHandlerPriv);
        // 注册教师端路由
        // 当前设计：AI 学习助手对话统计非常敏感，仅允许 root 访问。
        // 注意：这里使用的是 root-only 的系统权限（PRIV.PRIV_EDIT_SYSTEM），普通老师也无权访问。
        // TODO(如需求变更): 未来若有专门的教师统计角色，再考虑降低权限。
        ctx.injectUI('ControlPanel', 'ai_helper_conversations');
        // GET /ai-helper/conversations - 获取对话列表
        ctx.Route('ai_helper_conversations', '/ai-helper/conversations', teacherHandler_1.ConversationListHandler, teacherHandler_1.ConversationListHandlerPriv);
        // GET /ai-helper/conversations/:id - 获取对话详情
        ctx.Route('ai_helper_conversation_detail', '/ai-helper/conversations/:id', teacherHandler_1.ConversationDetailHandler, teacherHandler_1.ConversationDetailHandlerPriv);
        console.log('[AI Helper] Routes registered:');
        console.log('  - GET /ai-helper/hello (test route)');
        console.log('  - POST /ai-helper/chat (student chat API)');
        console.log('  - GET /ai-helper/conversations (teacher conversation list API)');
        console.log('  - GET /ai-helper/conversations/:id (teacher conversation detail API)');
    }
});
exports.Config = configSchema;
exports.apply = aiHelperPlugin.apply;
exports.default = aiHelperPlugin;
//# sourceMappingURL=index.js.map