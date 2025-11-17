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
/**
 * 插件入口函数
 * @param ctx HydroOJ Context
 * @param config 插件配置
 */
const configSchema = hydrooj_1.Schema.object({}).description('AI 助手插件配置（预留）').default({});
const aiHelperPlugin = (0, hydrooj_1.definePlugin)({
    name: 'hydro-ai-helper',
    schema: configSchema,
    apply(ctx) {
        console.log('[AI Helper] Plugin loaded successfully');
        // 注册测试路由
        // GET /ai-helper/hello - 返回插件状态
        ctx.Route('ai_helper_hello', '/ai-helper/hello', testHandler_1.HelloHandler, testHandler_1.HelloHandlerPriv);
        // 注册学生端对话路由
        // POST /ai-helper/chat - 学生提交问题获得 AI 回答
        ctx.Route('ai_helper_chat', '/ai-helper/chat', studentHandler_1.ChatHandler, studentHandler_1.ChatHandlerPriv);
        console.log('[AI Helper] Routes registered:');
        console.log('  - GET /ai-helper/hello (test route)');
        console.log('  - POST /ai-helper/chat (student chat API)');
        // TODO: 在后续任务中注册数据库模型和服务
    }
});
exports.Config = configSchema;
exports.apply = aiHelperPlugin.apply;
exports.default = aiHelperPlugin;
//# sourceMappingURL=index.js.map