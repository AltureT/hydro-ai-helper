/**
 * 学生端对话 Handler
 * 处理学生的 AI 对话请求
 */

import { Handler, PRIV } from 'hydrooj';
import { OpenAIClient, ChatMessage } from '../services/openaiClient';
import { PromptService, QuestionType } from '../services/promptService';

/**
 * 学生对话请求接口
 */
interface ChatRequest {
  conversationId?: string;
  problemId: string;
  problemTitle?: string; // 题目标题,前端读取失败时手动填写
  problemContent?: string; // 题目描述摘要,前端自动截取或手动填写
  questionType: QuestionType;
  userThinking: string;
  includeCode: boolean; // 是否附带代码,默认 false
  code?: string;
  attachErrorInfo?: boolean;
}

/**
 * 学生对话响应接口
 */
interface ChatResponse {
  conversationId: string;
  message: {
    role: 'ai';
    content: string;
    timestamp: string;
  };
  remainingRequests?: number;
  codeWarning?: string; // 代码被截断时的警告信息
}

/**
 * ChatHandler - 处理学生的 AI 对话请求
 * POST /ai-helper/chat
 */
export class ChatHandler extends Handler {
  async post() {
    try {
      // 从请求体获取参数
      const {
        problemId,
        problemTitle,
        problemContent,
        questionType,
        userThinking,
        includeCode,
        code,
        conversationId
      } = this.request.body as ChatRequest;
      // 验证问题类型
      const validQuestionTypes: QuestionType[] = ['understand', 'think', 'debug', 'review'];
      if (!validQuestionTypes.includes(questionType as QuestionType)) {
        throw new Error('无效的问题类型');
      }

      // 初始化服务
      const promptService = new PromptService();

      // 代码处理逻辑
      let processedCode: string | undefined;
      let codeWarning: string | undefined;

      if (includeCode && code) {
        // 检查代码长度,超过 5000 字符则截断
        if (code.length > 5000) {
          processedCode = code.substring(0, 5000);
          codeWarning = '代码已截断到 5000 字符';
        } else {
          processedCode = code;
        }
      } else {
        // includeCode=false 时忽略代码字段
        processedCode = undefined;
      }

      // 验证用户输入
      const validation = promptService.validateInput(userThinking, processedCode);
      if (!validation.valid) {
        throw new Error(validation.error || '输入验证失败');
      }

      // 题目内容截断(超过 500 字符)
      let processedProblemContent: string | undefined;
      if (problemContent) {
        if (problemContent.length > 500) {
          processedProblemContent = problemContent.substring(0, 500) + '...';
        } else {
          processedProblemContent = problemContent;
        }
      }

      // 构造 prompts
      // 使用前端传入的题目标题,如果没有则使用题目ID
      const problemTitleStr = problemTitle || `题目 ${problemId}`;
      const systemPrompt = promptService.buildSystemPrompt(problemTitleStr, processedProblemContent);
      const userPrompt = promptService.buildUserPrompt(
        questionType as QuestionType,
        userThinking,
        processedCode,
        undefined // errorInfo 暂不支持
      );

      // 准备消息数组
      const messages: ChatMessage[] = [
        { role: 'user', content: userPrompt }
      ];

      // TODO: 如果有 conversationId,从数据库加载历史消息
      // 当前版本暂不支持多轮对话

      // 获取 AI 配置
      // TODO: 从数据库读取配置,这里暂时使用环境变量
      const aiConfig = {
        apiBaseUrl: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
        modelName: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        apiKey: process.env.OPENAI_API_KEY || '',
        timeoutSeconds: 30
      };

      // 检查 API Key 是否配置
      if (!aiConfig.apiKey) {
        this.response.status = 500;
        this.response.body = { error: 'AI 服务未配置,请联系管理员' };
        this.response.type = 'application/json';
        return;
      }

      // 调用 AI 服务
      const openaiClient = new OpenAIClient(aiConfig);
      let aiResponse: string;

      try {
        aiResponse = await openaiClient.chat(messages, systemPrompt);
      } catch (error) {
        // 记录错误日志
        console.error('[AI Helper] AI 调用失败:', error);
        this.response.status = 500;
        this.response.body = { error: error instanceof Error ? error.message : 'AI 服务调用失败' };
        this.response.type = 'application/json';
        return;
      }

      // TODO: 保存对话和消息到数据库
      // 当前版本返回临时 conversationId

      // 构造响应
      const response: ChatResponse = {
        conversationId: conversationId || `temp-${Date.now()}`,
        message: {
          role: 'ai',
          content: aiResponse,
          timestamp: new Date().toISOString()
        }
      };

      // 如果代码被截断,添加警告信息
      if (codeWarning) {
        response.codeWarning = codeWarning;
      }

      this.response.body = response;
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[AI Helper] ChatHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
      this.response.type = 'application/json';
    }
  }
}

// 导出路由权限配置 - 需要用户登录
export const ChatHandlerPriv = PRIV.PRIV_USER_PROFILE;
