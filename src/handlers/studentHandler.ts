/**
 * 学生端对话 Handler
 * 处理学生的 AI 对话请求
 */

import { Handler, PRIV, ProblemModel, RecordModel, STATUS } from 'hydrooj';
import { OpenAIClient, ChatMessage, createOpenAIClientFromConfig, createMultiModelClientFromConfig, MultiModelClient } from '../services/openaiClient';
import { PromptService, QuestionType, type ValidateInputResult } from '../services/promptService';
import { RateLimitService } from '../services/rateLimitService';
import { EffectivenessService } from '../services/effectivenessService';
import { ConversationModel } from '../models/conversation';
import { MessageModel } from '../models/message';
import { AIConfigModel, AIConfig } from '../models/aiConfig';
import { type ObjectIdType } from '../utils/mongo';
import { getDomainId } from '../utils/domainHelper';

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

      // 获取当前域 ID（用于域隔离）
      const domainId = getDomainId(this);

      // 频率限制检查（在任何 AI 请求调用之前执行）
      const DEFAULT_RATE_LIMIT_PER_MINUTE = 1;  // 临时改为 1 方便测试
      const rateLimitService = new RateLimitService(this.ctx);
      const allowed = await rateLimitService.checkAndIncrement(domainId, userId, DEFAULT_RATE_LIMIT_PER_MINUTE);

      if (!allowed) {
        // 返回 429 + JSON 提示
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
      const validQuestionTypes: QuestionType[] = ['understand', 'think', 'debug', 'clarify', 'optimize'];
      if (!validQuestionTypes.includes(questionType as QuestionType)) {
        throw new Error('无效的问题类型');
      }

      // 服务端授权校验：optimize 类型需要用户已 AC 该题
      // 防止用户绕过前端直接发送 optimize 请求
      if (questionType === 'optimize') {
        // 先获取题目文档，获取数字类型的 docId（RecordDoc.pid 是 number 类型）
        const pdoc = await ProblemModel.get(domainId, problemId, ['docId']);
        if (!pdoc) {
          this.response.status = 404;
          this.response.body = { error: '题目不存在' };
          this.response.type = 'application/json';
          return;
        }

        const acRecords = await RecordModel.getMulti(domainId, {
          uid: userId,
          pid: pdoc.docId,  // 使用数字类型的 docId
          status: STATUS.STATUS_ACCEPTED
        })
        .sort({ _id: -1 })
        .limit(1)
        .project({ _id: 1 })
        .toArray();

        if (acRecords.length === 0) {
          this.response.status = 403;
          this.response.body = {
            error: '代码优化功能仅对已通过该题的用户开放',
            code: 'OPTIMIZE_REQUIRES_AC'
          };
          this.response.type = 'application/json';
          return;
        }
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

      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
      const aiConfig: AIConfig | null = await aiConfigModel.getConfig();
      const customSystemPromptTemplate = aiConfig?.systemPromptTemplate?.trim() || undefined;
      const extraJailbreakPatterns = parseExtraJailbreakPatterns(aiConfig?.extraJailbreakPatternsText);

      // 从服务端获取可信的题目内容（用于白名单和 System Prompt）
      // 安全考虑：不使用客户端传入的 problemContent 作为白名单，避免被利用绕过越狱检测
      let trustedProblemTitle: string | undefined;
      let trustedProblemContent: string | undefined;
      try {
        const pdoc = await ProblemModel.get(domainId, problemId, ['title', 'content']);
        if (pdoc) {
          trustedProblemTitle = pdoc.title;
          // 题目内容可能是字符串或 JSON 对象（多语言支持）
          if (typeof pdoc.content === 'string') {
            trustedProblemContent = pdoc.content;
          } else if (pdoc.content && typeof pdoc.content === 'object') {
            // 多语言内容，取第一个可用的值
            const values = Object.values(pdoc.content as Record<string, string>);
            trustedProblemContent = values[0] || '';
          }
        }
      } catch (err) {
        // 题目获取失败不阻塞主流程，但不使用白名单
        console.warn('[ChatHandler] 获取题目内容失败，白名单将为空:', err);
      }

      // 题目内容截断(超过 500 字符) - 用于白名单和 System Prompt
      let processedProblemContent: string | undefined;
      if (trustedProblemContent) {
        if (trustedProblemContent.length > 500) {
          processedProblemContent = trustedProblemContent.substring(0, 500) + '...';
        } else {
          processedProblemContent = trustedProblemContent;
        }
      }

      // 验证用户输入
      // validateInput 现在同时做长度校验和越狱关键词检测，防止学生尝试修改系统规则
      // 使用服务端获取的可信题目内容作为白名单，避免客户端注入绕过检测
      const validation: ValidateInputResult = promptService.validateInput(
        userThinking,
        processedCode,
        extraJailbreakPatterns.length ? extraJailbreakPatterns : undefined,
        processedProblemContent
      );
      if (!validation.valid) {
        if (validation.matchedPattern) {
          try {
            const effectivenessService = new EffectivenessService(this.ctx);
            await effectivenessService.logJailbreakAttempt({
              userId,
              conversationId,
              problemId,
              questionType,
              matchedPattern: validation.matchedPattern,
              matchedText: validation.matchedText || userThinking.substring(0, 120)
            });
          } catch (logErr) {
            console.error('[ChatHandler] 记录越狱日志失败', logErr);
          }
        }
        throw new Error(validation.error || '输入验证失败');
      }

      // 构造 system prompt
      // 优先使用服务端获取的可信题目标题，其次使用前端传入的，最后使用题目ID
      const problemTitleStr = trustedProblemTitle || problemTitle || `题目 ${problemId}`;
      const systemPrompt = promptService.buildSystemPrompt(
        problemTitleStr,
        processedProblemContent,
        customSystemPromptTemplate
      );

      // 处理对话会话 (新建或复用)
      let currentConversationId: ObjectIdType;

      if (conversationId) {
        // 验证 conversationId 格式
        const { ObjectId } = await import('../utils/mongo');
        if (!ObjectId.isValid(conversationId)) {
          this.response.status = 400;
          this.response.body = { error: '无效的会话 ID' };
          this.response.type = 'application/json';
          return;
        }
        // 复用已有会话（验证所有权）
        const conversation = await conversationModel.findById(conversationId);
        if (!conversation) {
          this.response.status = 404;
          this.response.body = { error: '会话不存在' };
          this.response.type = 'application/json';
          return;
        }
        // 验证会话归属当前用户和当前域
        if (conversation.userId !== userId || conversation.domainId !== domainId) {
          this.response.status = 403;
          this.response.body = { error: '无权访问此会话' };
          this.response.type = 'application/json';
          return;
        }
        currentConversationId = conversation._id;
      } else {
        // 创建新会话
        const now = new Date();
        currentConversationId = await conversationModel.create({
          domainId,
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

      // 加载历史消息用于多轮对话（排除刚保存的当前消息）
      // 使用 findRecentByConversationId 仅加载最近 7 条，避免长对话的内存压力
      const historyMessages = (await messageModel.findRecentByConversationId(currentConversationId, 7))
        .slice(0, -1)
        .map((msg) => ({
          role: msg.role,
          content: msg.content
        }));

      // 构造 user prompt（包含历史上下文）
      const userPrompt = promptService.buildUserPrompt(
        questionType as QuestionType,
        userThinking,
        processedCode,
        undefined, // errorInfo 暂不支持
        historyMessages
      );

      // 准备消息数组
      const messages: ChatMessage[] = [
        { role: 'user', content: userPrompt }
      ];

      // 从数据库配置创建多模型 AI 客户端（支持 fallback）
      let multiModelClient: MultiModelClient;
      try {
        multiModelClient = await createMultiModelClientFromConfig(this.ctx, aiConfig ?? undefined);
      } catch (error) {
        // 配置不存在或不完整
        console.error('[AI Helper] 创建 AI 客户端失败:', error);
        this.response.status = 500;
        this.response.body = { error: error instanceof Error ? error.message : 'AI 服务未配置' };
        this.response.type = 'application/json';
        return;
      }

      // 调用 AI 服务（支持多模型 fallback）
      let aiResponse: string;

      try {
        const result = await multiModelClient.chat(messages, systemPrompt);
        aiResponse = result.content;
        // 可选：记录使用的模型信息
        console.log(`[AI Helper] 使用模型: ${result.usedModel.endpointName}/${result.usedModel.modelName}`);
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

function parseExtraJailbreakPatterns(raw?: string | null): RegExp[] {
  if (!raw) {
    return [];
  }

  const patterns: RegExp[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const patternText = line.trim();
    if (!patternText) continue;
    try {
      patterns.push(new RegExp(patternText, 'gi'));
    } catch (err) {
      console.warn('[ChatHandler] 自定义越狱规则解析失败，已跳过:', patternText, err);
    }
  }

  return patterns;
}

/**
 * ProblemStatusHandler - 查询用户在指定题目的提交状态
 * GET /ai-helper/problem-status/:problemId
 * 返回用户是否已 AC 该题，以及最近一次 AC 的代码
 */
export class ProblemStatusHandler extends Handler {
  async get({ problemId }: { problemId: string }) {
    // 输入验证：problemId 不能为空且长度合理
    if (!problemId || typeof problemId !== 'string' || problemId.length > 50) {
      this.response.status = 400;
      this.response.body = { error: '无效的题目 ID' };
      this.response.type = 'application/json';
      return;
    }

    const userId = this.user._id;
    const domainId = getDomainId(this);

    // 先获取题目文档，获取数字类型的 docId（RecordDoc.pid 是 number 类型）
    const pdoc = await ProblemModel.get(domainId, problemId, ['docId']);
    if (!pdoc) {
      // 题目不存在时返回 hasAccepted: false
      this.response.body = { hasAccepted: false };
      this.response.type = 'application/json';
      return;
    }

    // 使用数字类型的 docId 查询 AC 记录
    const acRecord = await RecordModel.getMulti(domainId, {
      uid: userId,
      pid: pdoc.docId,  // 使用数字类型的 docId
      status: STATUS.STATUS_ACCEPTED
    })
    .sort({ _id: -1 })
    .limit(1)
    .project({ status: 1, code: 1, lang: 1 })
    .toArray();

    const hasAccepted = acRecord.length > 0;
    const acCode = hasAccepted ? acRecord[0].code : undefined;
    const acLang = hasAccepted ? acRecord[0].lang : undefined;

    this.response.body = {
      hasAccepted,
      acCode,    // 最近一次 AC 的代码
      acLang     // 代码语言
    };
    this.response.type = 'application/json';
  }
}

export const ProblemStatusHandlerPriv = PRIV.PRIV_USER_PROFILE;
