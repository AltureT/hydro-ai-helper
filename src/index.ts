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
  apply(ctx: Context) {
    console.log('[AI Helper] Plugin loaded successfully');

    // 注册测试路由
    // GET /ai-helper/hello - 返回插件状态
    ctx.Route('ai_helper_hello', '/ai-helper/hello', HelloHandler, HelloHandlerPriv);

    // 注册学生端对话路由
    // POST /ai-helper/chat - 学生提交问题获得 AI 回答
    ctx.Route('ai_helper_chat', '/ai-helper/chat', ChatHandler, ChatHandlerPriv);

    console.log('[AI Helper] Routes registered:');
    console.log('  - GET /ai-helper/hello (test route)');
    console.log('  - POST /ai-helper/chat (student chat API)');

    // TODO: 在后续任务中注册数据库模型和服务
  }
});

export const Config = configSchema;
export const apply = aiHelperPlugin.apply;
export default aiHelperPlugin;
