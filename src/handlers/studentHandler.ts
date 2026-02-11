/**
 * 学生端对话 Handler
 * 处理学生的 AI 对话请求
 */

import { Handler, PRIV, ProblemModel, RecordModel, STATUS, db } from 'hydrooj';
import { OpenAIClient, ChatMessage, createOpenAIClientFromConfig, createMultiModelClientFromConfig, MultiModelClient } from '../services/openaiClient';
import { PromptService, QuestionType, type ValidateInputResult } from '../services/promptService';
import { RateLimitService } from '../services/rateLimitService';
import { EffectivenessService } from '../services/effectivenessService';
import { OutputSafetyService } from '../services/outputSafetyService';
import { TopicGuardService } from '../services/topicGuardService';
import { ConversationModel } from '../models/conversation';
import { MessageModel } from '../models/message';
import { AIConfigModel, AIConfig } from '../models/aiConfig';
import { ObjectId, type ObjectIdType } from '../utils/mongo';
import { getDomainId } from '../utils/domainHelper';

/**
 * 学生对话请求接口
 */
interface ChatRequest {
  conversationId?: string;
  problemId: string;
  problemTitle?: string;
  problemContent?: string;
  questionType: QuestionType;
  userThinking: string;
  includeCode: boolean;
  code?: string;
  attachErrorInfo?: boolean;
  clarifyContext?: {
    sourceAiMessageId: string;
    selectedText: string;
  };
}

/**
 * 学生对话响应接口
 */
interface ChatResponse {
  conversationId: string;
  message: {
    id: string;
    role: 'ai';
    content: string;
    timestamp: string;
  };
  remainingRequests?: number;
  codeWarning?: string;
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

      // 获取 AI 配置（用于频率限制和其他设置）
      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
      const aiConfig: AIConfig | null = await aiConfigModel.getConfig();

      // 频率限制检查（在任何 AI 请求调用之前执行）
      // 优先使用配置中的限制，如果没有配置则使用默认值 5
      // 注意：使用 ?? 而非 || 以支持 0 值（0 表示禁用限流）
      const rateLimitPerMinute = aiConfig?.rateLimitPerMinute ?? 5;

      // 仅当限制值 > 0 时才执行频率限制检查（0 表示禁用限流）
      if (rateLimitPerMinute > 0) {
        const rateLimitService = new RateLimitService(this.ctx);
        const allowed = await rateLimitService.checkAndIncrement(domainId, userId, rateLimitPerMinute);

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
        conversationId,
        clarifyContext
      } = this.request.body as ChatRequest;

      // 验证问题类型
      const validQuestionTypes: QuestionType[] = ['understand', 'think', 'debug', 'clarify', 'optimize'];
      if (!validQuestionTypes.includes(questionType as QuestionType)) {
        throw new Error('无效的问题类型');
      }

      // Clarify 预校验：先拒绝无效请求，避免创建空会话
      const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();
      let clarifySourceAiMessageId = '';
      let clarifySelectedTextRaw = '';
      let clarifySelectedTextNorm = '';

      if (questionType === 'clarify') {
        clarifySourceAiMessageId = clarifyContext?.sourceAiMessageId ?? '';
        clarifySelectedTextRaw = clarifyContext?.selectedText ?? '';
        clarifySelectedTextNorm = normalizeText(clarifySelectedTextRaw);

        if (!conversationId) {
          this.response.status = 400;
          this.response.body = {
            error: '追问功能需要基于已有会话',
            code: 'CLARIFY_ANCHOR_INVALID'
          };
          this.response.type = 'application/json';
          return;
        }
        if (!clarifySourceAiMessageId || !clarifySelectedTextNorm) {
          this.response.status = 400;
          this.response.body = {
            error: '追问功能需要选中 AI 回复中的内容',
            code: 'CLARIFY_ANCHOR_INVALID'
          };
          this.response.type = 'application/json';
          return;
        }
        if (!ObjectId.isValid(clarifySourceAiMessageId)) {
          this.response.status = 400;
          this.response.body = {
            error: '无效的消息来源 ID',
            code: 'CLARIFY_ANCHOR_INVALID'
          };
          this.response.type = 'application/json';
          return;
        }
      }

      // 服务端授权校验:optimize 类型需要用户已 AC 该题
      // 防止用户绕过前端直接发送 optimize 请求
      if (questionType === 'optimize') {
        // 先获取题目文档,获取数字类型的 docId(RecordDoc.pid 是 number 类型)
        const pdoc = await ProblemModel.get(domainId, problemId, ['docId']);
        if (!pdoc) {
          this.response.status = 404;
          this.response.body = { error: '题目不存在' };
          this.response.type = 'application/json';
          return;
        }

        // 性能优化:使用 findOne 直接检查 AC 记录存在性(无需排序)
        const dbStart = Date.now();
        const acRecord = await db.collection('record').findOne({
          domainId,
          uid: userId,
          pid: pdoc.docId,
          status: STATUS.STATUS_ACCEPTED
        }, { projection: { _id: 1 } });
        console.log(`[Perf] AC Check: ${Date.now() - dbStart}ms`);

        if (!acRecord) {
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
        if (!ObjectId.isValid(conversationId)) {
          this.response.status = 400;
          this.response.body = {
            error: '无效的会话 ID',
            code: 'INVALID_CONVERSATION_ID'
          };
          this.response.type = 'application/json';
          return;
        }
        // 复用已有会话（验证所有权）
        const conversation = await conversationModel.findById(conversationId);
        if (!conversation) {
          this.response.status = 404;
          this.response.body = {
            error: '会话不存在',
            code: 'CONVERSATION_NOT_FOUND'
          };
          this.response.type = 'application/json';
          return;
        }
        // 验证会话归属当前用户和当前域
        if (conversation.userId !== userId || conversation.domainId !== domainId) {
          this.response.status = 403;
          this.response.body = {
            error: '无权访问此会话',
            code: 'CONVERSATION_ACCESS_DENIED'
          };
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
          classId: undefined,
          startTime: now,
          endTime: now,
          messageCount: 0,
          isEffective: false,
          tags: [],
          metadata: {
            problemTitle: problemTitleStr,
            problemContent: processedProblemContent,
            offTopicStrike: 0
          }
        });
      }

      // P0-1: Clarify 锚点校验
      if (questionType === 'clarify') {
        const sourceMessage = await messageModel.findById(clarifySourceAiMessageId);
        if (!sourceMessage || sourceMessage.role !== 'ai') {
          this.response.status = 400;
          this.response.body = {
            error: '来源消息不存在或不是 AI 回复',
            code: 'CLARIFY_ANCHOR_INVALID'
          };
          this.response.type = 'application/json';
          return;
        }
        if (sourceMessage.conversationId.toHexString() !== currentConversationId.toHexString()) {
          this.response.status = 400;
          this.response.body = {
            error: '来源消息不属于当前会话',
            code: 'CLARIFY_ANCHOR_INVALID'
          };
          this.response.type = 'application/json';
          return;
        }
        // 内容包含校验（支持归一化匹配）
        const sourceContentNorm = normalizeText(sourceMessage.content);
        if (!sourceMessage.content.includes(clarifySelectedTextRaw)
            && !sourceContentNorm.includes(clarifySelectedTextNorm)) {
          this.response.status = 400;
          this.response.body = {
            error: '选中文本不在来源消息内容中',
            code: 'CLARIFY_ANCHOR_INVALID'
          };
          this.response.type = 'application/json';
          return;
        }
      }

      // P1-2: 偏题检测（在 LLM 调用前执行）
      const topicGuardService = new TopicGuardService();
      const topicResult = topicGuardService.evaluate(userThinking, {
        code: processedCode,
        problemTitle: problemTitleStr,
        problemContent: processedProblemContent
      });
      if (topicResult.isOffTopic) {
        const strikeCount = await conversationModel.incrementOffTopicStrike(currentConversationId);
        if (strikeCount >= 2) {
          // 连续偏题 >= 2 次，直接返回固定模板，不调 LLM
          const fixedReply = '这个追问与当前编程题无关。请贴出你的代码片段、报错信息或你已尝试的思路，我再继续帮你。';
          // 先保存学生消息，确保会话消息顺序与实际轮次一致
          const studentMessageTimestamp = new Date();
          await messageModel.create({
            conversationId: currentConversationId,
            role: 'student',
            content: userThinking,
            timestamp: studentMessageTimestamp,
            questionType: questionType as QuestionType,
            attachedCode: includeCode && !!processedCode,
            attachedError: false
          });
          await conversationModel.incrementMessageCount(currentConversationId);

          const aiMessageTimestamp = new Date();
          const aiMessageId = await messageModel.create({
            conversationId: currentConversationId,
            role: 'ai',
            content: fixedReply,
            timestamp: aiMessageTimestamp,
            metadata: { topicGuardBypassedLLM: true }
          });
          await conversationModel.incrementMessageCount(currentConversationId);
          await conversationModel.updateEndTime(currentConversationId, aiMessageTimestamp);

          const response: ChatResponse = {
            conversationId: currentConversationId.toHexString(),
            message: {
              id: aiMessageId.toHexString(),
              role: 'ai',
              content: fixedReply,
              timestamp: aiMessageTimestamp.toISOString()
            }
          };
          this.response.body = response;
          this.response.type = 'application/json';
          return;
        }
      } else {
        // 正常对话，重置偏题计数
        await conversationModel.resetOffTopicStrike(currentConversationId);
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

      // P2: 历史上下文净化 - 过滤掉被标记为 off-topic 的消息
      const historyMessages = (await messageModel.findRecentByConversationId(currentConversationId, 7))
        .slice(0, -1)
        .filter((msg) => !msg.metadata?.safetyRewritten && !msg.metadata?.topicGuardBypassedLLM)
        .map((msg) => ({
          role: msg.role,
          content: msg.content
        }));

      // 构造 user prompt（包含历史上下文 + clarify 锚点信息）
      const userPrompt = promptService.buildUserPrompt(
        questionType as QuestionType,
        userThinking,
        processedCode,
        undefined, // errorInfo 暂不支持
        historyMessages,
        clarifySelectedTextRaw || undefined
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

      // 调用 AI 服务(支持多模型 fallback)
      let aiResponse: string;

      try {
        const aiStart = Date.now();
        const result = await multiModelClient.chat(messages, systemPrompt);
        console.log(`[Perf] AI Response: ${Date.now() - aiStart}ms`);
        aiResponse = result.content;
        // 可选:记录使用的模型信息
        console.log(`[AI Helper] 使用模型: ${result.usedModel.endpointName}/${result.usedModel.modelName}`);
      } catch (error) {
        // 记录错误日志
        console.error('[AI Helper] AI 调用失败:', error);
        this.response.status = 500;
        this.response.body = { error: error instanceof Error ? error.message : 'AI 服务调用失败' };
        this.response.type = 'application/json';
        return;
      }

      // P0-2: 输出安全后处理（AI 响应返回后、保存到数据库前）
      const outputSafetyService = new OutputSafetyService();
      const safetyResult = outputSafetyService.sanitize(aiResponse, {
        questionType: questionType as QuestionType,
        problemTitle: problemTitleStr,
        problemContent: processedProblemContent
      });
      aiResponse = safetyResult.content;

      // 保存 AI 消息到数据库
      const aiMessageTimestamp = new Date();
      const aiMessageId = await messageModel.create({
        conversationId: currentConversationId,
        role: 'ai',
        content: aiResponse,
        timestamp: aiMessageTimestamp,
        metadata: safetyResult.rewritten ? { safetyRewritten: true } : undefined
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

      // 构造响应 (返回真实的 conversationId + AI 消息 ID)
      const response: ChatResponse = {
        conversationId: currentConversationId.toHexString(),
        message: {
          id: aiMessageId.toHexString(),
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

    // 性能优化:使用 findOne 直接获取最新 AC 记录
    const dbStart = Date.now();
    const acRecordDoc = await db.collection('record').findOne({
      domainId,
      uid: userId,
      pid: pdoc.docId,
      status: STATUS.STATUS_ACCEPTED
    }, {
      sort: { _id: -1 },  // 需要排序以获取最新代码
      projection: { status: 1, code: 1, lang: 1 }
    });
    console.log(`[Perf] Status Check: ${Date.now() - dbStart}ms`);

    const hasAccepted = !!acRecordDoc;
    const acCode = acRecordDoc?.code;
    const acLang = acRecordDoc?.lang;

    this.response.body = {
      hasAccepted,
      acCode,    // 最近一次 AC 的代码
      acLang     // 代码语言
    };
    this.response.type = 'application/json';
  }
}

export const ProblemStatusHandlerPriv = PRIV.PRIV_USER_PROFILE;
