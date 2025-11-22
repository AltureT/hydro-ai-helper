/**
 * 学生端对话 Handler
 * 处理学生的 AI 对话请求
 */

import { Handler, PRIV } from 'hydrooj';
import { OpenAIClient, ChatMessage, createOpenAIClientFromConfig } from '../services/openaiClient';
import { PromptService, QuestionType } from '../services/promptService';
import { RateLimitService } from '../services/rateLimitService';
import { EffectivenessService } from '../services/effectivenessService';
import { ConversationModel } from '../models/conversation';
import { MessageModel } from '../models/message';
import { AIConfigModel, AIConfig } from '../models/aiConfig';
import { type ObjectIdType } from '../utils/mongo';

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
      // 获取当前用户 ID（尽早获取，用于频率限制检查）
      const userId = this.user._id;

      // 调试日志：确认 userId 的值和类型
      console.log('[ChatHandler] Rate limit check - userId:', userId, 'type:', typeof userId);

      // 频率限制检查（在任何 AI 请求调用之前执行）
      const DEFAULT_RATE_LIMIT_PER_MINUTE = 1;  // 临时改为 1 方便测试
      const rateLimitService = new RateLimitService(this.ctx);
      const allowed = await rateLimitService.checkAndIncrement(userId, DEFAULT_RATE_LIMIT_PER_MINUTE);

      console.log('[ChatHandler] Rate limit result - allowed:', allowed);

      if (!allowed) {
        // 返回 429 + JSON 提示
        console.log('[ChatHandler] Rate limit exceeded, returning 429');
        const rateLimitMessage = '提问太频繁了，请仔细思考后再提问';
        this.response.status = 429;
        this.response.body = {
          error: rateLimitMessage,
          code: 'RATE_LIMIT_EXCEEDED'
        };
        this.response.type = 'application/json';
        return;
      }

      // 获取数据库模型实例
      const conversationModel: ConversationModel = this.ctx.get('conversationModel');
      const messageModel: MessageModel = this.ctx.get('messageModel');

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
      // validateInput 现在同时做长度校验和越狱关键词检测，防止学生尝试修改系统规则
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

      // 加载管理员配置，用于合并 System Prompt 模板
      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
      const aiConfig: AIConfig | null = await aiConfigModel.getConfig();
      const customSystemPromptTemplate = aiConfig?.systemPromptTemplate?.trim() || undefined;

      // 构造 prompts
      // 使用前端传入的题目标题,如果没有则使用题目ID
      const problemTitleStr = problemTitle || `题目 ${problemId}`;
      const systemPrompt = promptService.buildSystemPrompt(
        problemTitleStr,
        processedProblemContent,
        customSystemPromptTemplate
      );
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

      // 处理对话会话 (新建或复用)
      let currentConversationId: ObjectIdType;

      if (conversationId) {
        // 复用已有会话
        const conversation = await conversationModel.findById(conversationId);
        if (!conversation) {
          // 会话不存在,返回 404
          this.response.status = 404;
          this.response.body = { error: '会话不存在' };
          this.response.type = 'application/json';
          return;
        }
        currentConversationId = conversation._id;
      } else {
        // 创建新会话
        const now = new Date();
        currentConversationId = await conversationModel.create({
          userId,
          problemId,
          classId: undefined, // TODO: 从用户信息获取班级 ID
          startTime: now,
          endTime: now,
          messageCount: 0,
          isEffective: false, // 初始标记为无效,后续通过有效对话判定服务更新
          tags: [],
          metadata: {
            problemTitle: problemTitleStr,
            problemContent: processedProblemContent
          }
        });
      }

      // 保存学生消息到数据库
      await messageModel.create({
        conversationId: currentConversationId,
        role: 'student',
        content: userThinking,
        timestamp: new Date(),
        questionType: questionType as QuestionType,
        attachedCode: includeCode && !!processedCode,
        attachedError: false, // TODO: 支持附带错误信息
        metadata: processedCode ? {
          codeLength: processedCode.length,
          codeWarning
        } : undefined
      });

      // 增加会话的消息计数
      await conversationModel.incrementMessageCount(currentConversationId);

      // TODO: 加载历史消息用于多轮对话 (后续 Phase)
      // const historyMessages = await messageModel.findByConversationId(currentConversationId);

      // 从数据库配置创建 AI 客户端
      let openaiClient: OpenAIClient;
      try {
        openaiClient = await createOpenAIClientFromConfig(this.ctx, aiConfig ?? undefined);
      } catch (error) {
        // 配置不存在或不完整
        console.error('[AI Helper] 创建 AI 客户端失败:', error);
        this.response.status = 500;
        this.response.body = { error: error instanceof Error ? error.message : 'AI 服务未配置' };
        this.response.type = 'application/json';
        return;
      }

      // 调用 AI 服务
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

      // 保存 AI 消息到数据库
      const aiMessageTimestamp = new Date();
      await messageModel.create({
        conversationId: currentConversationId,
        role: 'ai',
        content: aiResponse,
        timestamp: aiMessageTimestamp,
        questionType: undefined, // AI 消息没有问题类型
        attachedCode: false,
        attachedError: false
      });

      // 增加会话的消息计数并更新结束时间
      await conversationModel.incrementMessageCount(currentConversationId);
      await conversationModel.updateEndTime(currentConversationId, aiMessageTimestamp);

      // 后台异步触发有效对话判定（不阻塞主流程）
      try {
        const effectivenessService = new EffectivenessService(this.ctx);
        // 使用 void 丢弃 Promise，fire-and-forget
        void effectivenessService.analyzeConversation(currentConversationId);
      } catch (err) {
        // 捕获同步错误（如构造函数异常），记录日志但不影响主流程
        this.ctx.logger.error('Schedule effectiveness analyze failed', err);
      }

      // 构造响应 (返回真实的 conversationId)
      const response: ChatResponse = {
        conversationId: currentConversationId.toHexString(),
        message: {
          role: 'ai',
          content: aiResponse,
          timestamp: aiMessageTimestamp.toISOString()
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
