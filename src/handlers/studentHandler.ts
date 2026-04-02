/**
 * 学生端对话 Handler
 * 处理学生的 AI 对话请求
 */

import type { ServerResponse } from 'http';
import { Handler, PRIV, ProblemModel, STATUS, db, ContestModel } from 'hydrooj';
import { formatJudgeInfo } from '../services/judgeInfoService';
import { ChatMessage, createMultiModelClientFromConfig, MultiModelClient, AIServiceError, MultiModelChatResult, USER_ERROR_MESSAGES, getHttpStatusForCategory, TokenUsage } from '../services/openaiClient';
import { PromptService, QuestionType, type ValidateInputResult } from '../services/promptService';
import { PROMPT_LIMITS, API_DEFAULTS } from '../constants/limits';
import { applyRateLimit } from '../lib/rateLimitHelper';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { EffectivenessService } from '../services/effectivenessService';
import { OutputSafetyService } from '../services/outputSafetyService';
import { TopicGuardService } from '../services/topicGuardService';
import { ConversationModel } from '../models/conversation';
import { MessageModel } from '../models/message';
import { AIConfigModel, AIConfig } from '../models/aiConfig';
import { ObjectId, type ObjectIdType } from '../utils/mongo';
import { getDomainId } from '../utils/domainHelper';
import { TokenUsageModel } from '../models/tokenUsage';
import { BudgetService } from '../services/budgetService';
import { createSSEWriter } from '../lib/sseHelper';

function extractContestIdFromReferer(referer: unknown): string | undefined {
  if (typeof referer !== 'string') return undefined;
  const trimmed = referer.trim();
  if (!trimmed) return undefined;
  try {
    // Referer header is usually absolute; provide a base URL for relative fallbacks.
    const u = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? new URL(trimmed)
      : new URL(trimmed, 'http://localhost');
    return u.searchParams.get('tid') || undefined;
  } catch {
    return undefined;
  }
}

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
  contestId?: string;  // 比赛 ID（用于后端校验比赛模式）
  clarifyContext?: {
    sourceAiMessageId: string;
    selectedText: string;
  };
  stream?: boolean;
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
  hasJudgeInfo?: boolean;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  budgetWarning?: string;
}

interface PrepareChatResult {
  userId: number;
  domainId: string;
  questionType: QuestionType;
  userThinking: string;
  includeCode: boolean;
  processedCode: string | undefined;
  codeWarning: string | undefined;
  problemTitleStr: string;
  processedProblemContent: string | undefined;
  currentConversationId: ObjectIdType;
  systemPrompt: string;
  messages: ChatMessage[];
  multiModelClient: MultiModelClient;
  conversationModel: ConversationModel;
  messageModel: MessageModel;
  aiConfig: AIConfig | null;
  budgetWarning: string | undefined;
  judgeInfo: string | undefined;
  effectiveContestId: string | undefined;
}

/**
 * ChatHandler - 处理学生的 AI 对话请求
 * POST /ai-helper/chat
 */
export class ChatHandler extends Handler {
  async post() {
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const prepared = await this.prepareChat();
      if (!prepared) return; // Early exit (response already set)

      if (this.isStreamRequested()) {
        await this.handleStreamResponse(prepared);
      } else {
        await this.handleJsonResponse(prepared);
      }
    } catch (err) {
      console.error('[AI Helper] ChatHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: '服务器内部错误，请稍后重试' };
      this.response.type = 'application/json';
    }
  }

  private isStreamRequested(): boolean {
    const body = this.request.body as ChatRequest;
    if (body.stream === true) return true;
    const accept = this.request.headers?.accept || '';
    return accept.includes('text/event-stream');
  }

  private async prepareChat(): Promise<PrepareChatResult | null> {
    // 获取当前用户 ID（尽早获取，用于频率限制检查）
    const userId = this.user._id;

    // 获取当前域 ID（用于域隔离）
    const domainId = getDomainId(this);

    // 比赛模式校验：仅在比赛进行中禁用
    // 优先使用请求体传入的 contestId，缺失时回退到 referer 中的 tid，降低绕过空间
    const { contestId: requestContestId } = this.request.body as ChatRequest;
    const refererContestId = extractContestIdFromReferer(this.request.headers?.referer);
    const effectiveContestId =
      [requestContestId, refererContestId].find((id): id is string => !!id && ObjectId.isValid(id));

    if (effectiveContestId) {
      try {
        const tdoc = await ContestModel.get(domainId, new ObjectId(effectiveContestId));
        if (tdoc && tdoc.rule !== 'homework' && ContestModel.isOngoing(tdoc)) {
          this.response.status = 403;
          this.response.body = {
            error: '比赛期间 AI 助手不可用，请独立完成作答',
            code: 'CONTEST_MODE_RESTRICTED'
          };
          this.response.type = 'application/json';
          return null;
        }
      } catch (err) {
        console.warn('[ChatHandler] 比赛校验失败:', err);
        this.response.status = 503;
        this.response.body = { error: '比赛状态校验失败，请稍后重试', code: 'CONTEST_CHECK_FAILED' };
        this.response.type = 'application/json';
        return null;
      }
    }

    // 获取 AI 配置（用于频率限制和其他设置）
    const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
    const aiConfig: AIConfig | null = await aiConfigModel.getConfig();

    // 频率限制检查（在任何 AI 请求调用之前执行）
    // 使用 HydroOJ 内置 limitRate (opcount)，fail-closed 策略
    const rateLimitPerMinute = aiConfig?.rateLimitPerMinute ?? 5;

    if (rateLimitPerMinute > 0) {
      // 主限流：N 次/60秒
      if (await applyRateLimit(this, {
        op: 'ai_chat', periodSecs: 60, maxOps: rateLimitPerMinute,
        errorMessage: '提问太频繁了，请仔细思考后再提问',
      })) return null;

      // 突发限流：防止固定窗口边界攻击
      const burstMax = Math.max(1, Math.ceil(rateLimitPerMinute / 3));
      if (await applyRateLimit(this, {
        op: 'ai_chat_burst', periodSecs: 10, maxOps: burstMax,
        errorMessage: '提问太频繁了，请仔细思考后再提问',
      })) return null;
    }

    // 预算控制检查（在 AI 调用之前执行）
    let budgetWarning: string | undefined;
    try {
      const tokenUsageModel: TokenUsageModel = this.ctx.get('tokenUsageModel');
      if (aiConfig?.budgetConfig) {
        const budgetService = new BudgetService(tokenUsageModel);
        const budgetCheck = await budgetService.checkBudget(domainId, userId, aiConfig.budgetConfig);
        if (!budgetCheck.allowed) {
          this.response.status = 429;
          this.response.body = { error: budgetCheck.reason || '今天的 AI 额度已用完', code: 'BUDGET_EXCEEDED' };
          this.response.type = 'application/json';
          return null;
        }
        if (budgetCheck.warning) {
          budgetWarning = budgetCheck.warning;
        }
      }
    } catch (err) {
      console.warn('[ChatHandler] 预算检查失败，放行请求:', err);
    }

    // 获取数据库模型实例
    const conversationModel: ConversationModel = this.ctx.get('conversationModel');
    const messageModel: MessageModel = this.ctx.get('messageModel');

    // 从请求体获取参数
    const {
      problemId,
      problemTitle,
      problemContent: _problemContent,
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
        return null;
      }
      if (!clarifySourceAiMessageId || !clarifySelectedTextNorm) {
        this.response.status = 400;
        this.response.body = {
          error: '追问功能需要选中 AI 回复中的内容',
          code: 'CLARIFY_ANCHOR_INVALID'
        };
        this.response.type = 'application/json';
        return null;
      }
      if (!ObjectId.isValid(clarifySourceAiMessageId)) {
        this.response.status = 400;
        this.response.body = {
          error: '无效的消息来源 ID',
          code: 'CLARIFY_ANCHOR_INVALID'
        };
        this.response.type = 'application/json';
        return null;
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
        return null;
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
        return null;
      }
    }

    // 初始化服务
    const promptService = new PromptService();

    // 代码处理逻辑
    let processedCode: string | undefined;
    let codeWarning: string | undefined;

    if (includeCode && code) {
      // 检查代码长度,超过 5000 字符则截断
      if (code.length > PROMPT_LIMITS.MAX_CODE_LENGTH) {
        processedCode = code.substring(0, PROMPT_LIMITS.MAX_CODE_LENGTH);
        codeWarning = `代码已截断到 ${PROMPT_LIMITS.MAX_CODE_LENGTH} 字符`;
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
    let trustedProblemDocId: number | undefined;
    try {
      const pdoc = await ProblemModel.get(domainId, problemId, ['title', 'content', 'docId']);
      if (pdoc) {
        trustedProblemTitle = pdoc.title;
        trustedProblemDocId = pdoc.docId;
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
      if (trustedProblemContent.length > PROMPT_LIMITS.MAX_PROBLEM_CONTENT_SUMMARY) {
        processedProblemContent = trustedProblemContent.substring(0, PROMPT_LIMITS.MAX_PROBLEM_CONTENT_SUMMARY) + '...';
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
        return null;
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
        return null;
      }
      // 验证会话归属当前用户和当前域
      if (conversation.userId !== userId || conversation.domainId !== domainId) {
        this.response.status = 403;
        this.response.body = {
          error: '无权访问此会话',
          code: 'CONVERSATION_ACCESS_DENIED'
        };
        this.response.type = 'application/json';
        return null;
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
        return null;
      }
      if (sourceMessage.conversationId.toHexString() !== currentConversationId.toHexString()) {
        this.response.status = 400;
        this.response.body = {
          error: '来源消息不属于当前会话',
          code: 'CLARIFY_ANCHOR_INVALID'
        };
        this.response.type = 'application/json';
        return null;
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
        return null;
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
        return null;
      }
    } else {
      // 正常对话，重置偏题计数
      await conversationModel.resetOffTopicStrike(currentConversationId);
    }

    // 查询评测数据（debug 类型时自动附带）
    let judgeInfo: string | undefined;
    if (questionType === 'debug') {
      try {
        const pidForRecord = trustedProblemDocId;
        if (typeof pidForRecord === 'number') {
          const pendingStatuses = [
            STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED,
            STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING
          ];
          const failureStatuses = [
            STATUS.STATUS_WRONG_ANSWER,
            STATUS.STATUS_TIME_LIMIT_EXCEEDED,
            STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
            STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED,
            STATUS.STATUS_RUNTIME_ERROR,
            STATUS.STATUS_COMPILE_ERROR,
            STATUS.STATUS_SYSTEM_ERROR,
            STATUS.STATUS_ETC,
            STATUS.STATUS_HACKED,
            STATUS.STATUS_FORMAT_ERROR
          ].filter((s): s is number => typeof s === 'number');
          const statusFilter = failureStatuses.length
            ? { $in: failureStatuses }
            : { $nin: [STATUS.STATUS_ACCEPTED, ...pendingStatuses] };

          const coll = db.collection('record');
          const queryBase: Record<string, unknown> = {
            domainId,
            uid: userId,
            pid: pidForRecord,
            status: statusFilter
          };
          const findOptions: Record<string, unknown> = {
            sort: { _id: -1 as const },
            projection: {
              status: 1,
              score: 1,
              testCases: { $slice: 80 },
              compilerTexts: { $slice: -5 },
              judgeTexts: { $slice: -5 },
              lang: 1
            }
          };

          let recordDoc: Record<string, unknown> | null = null;
          if (effectiveContestId) {
            recordDoc = await coll.findOne({
              ...queryBase,
              contest: new ObjectId(effectiveContestId)
            }, findOptions);
          }
          if (!recordDoc) {
            recordDoc = await coll.findOne({
              ...queryBase,
              contest: null
            }, findOptions);
          }

          if (recordDoc) {
            judgeInfo = formatJudgeInfo(recordDoc);
          }
        }
      } catch (err) {
        console.warn('[ChatHandler] 获取评测数据失败:', err);
      }
    }

    // 保存学生消息到数据库
    await messageModel.create({
      conversationId: currentConversationId,
      role: 'student',
      content: userThinking,
      timestamp: new Date(),
      questionType: questionType as QuestionType,
      attachedCode: includeCode && !!processedCode,
      attachedError: !!judgeInfo,
      metadata: processedCode ? {
        codeLength: processedCode.length,
        codeWarning,
        codeContent: processedCode
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

    // 构造 user prompt（包含历史上下文 + clarify 锚点信息 + 评测数据）
    const userPrompt = promptService.buildUserPrompt(
      questionType as QuestionType,
      userThinking,
      processedCode,
      judgeInfo,
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
      this.response.body = { error: 'AI 服务暂时不可用，请稍后重试' };
      this.response.type = 'application/json';
      return null;
    }

    return {
      userId,
      domainId,
      questionType: questionType as QuestionType,
      userThinking,
      includeCode,
      processedCode,
      codeWarning,
      problemTitleStr,
      processedProblemContent,
      currentConversationId,
      systemPrompt,
      messages,
      multiModelClient,
      conversationModel,
      messageModel,
      aiConfig,
      budgetWarning,
      judgeInfo,
      effectiveContestId,
    };
  }

  private async handleStreamResponse(p: PrepareChatResult): Promise<void> {
    // Access Koa context via HandlerCommon.context (NOT this.request.ctx — HydroRequest is a plain object)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const koaCtx = (this as any).context;
    const rawRes: ServerResponse | undefined = koaCtx?.res;
    if (!rawRes) {
      return this.handleJsonResponse(p);
    }

    // Prevent Koa from auto-responding and disable compression for SSE
    koaCtx.respond = false;
    if ('compress' in koaCtx) koaCtx.compress = false;

    // Optimise socket for streaming: disable Nagle, remove timeout
    const rawReq = koaCtx.req;
    rawReq?.socket?.setNoDelay?.(true);
    rawReq?.socket?.setTimeout?.(0);

    const sse = createSSEWriter(rawRes);

    // Send meta event
    sse.writeEvent('meta', { conversationId: p.currentConversationId.toHexString() });

    // Keepalive timer
    const keepaliveTimer = setInterval(() => {
      sse.writeComment('keepalive');
    }, API_DEFAULTS.SSE_KEEPALIVE_INTERVAL_MS);

    // AbortController for client disconnect
    const requestAc = new AbortController();
    const onClose = () => requestAc.abort();
    rawReq?.on?.('close', onClose);

    let fullContent = '';
    let streamUsage: TokenUsage | undefined;
    let usedModel: MultiModelChatResult['usedModel'] | undefined;

    try {
      const aiStart = Date.now();
      const streamResult = await p.multiModelClient.chatStream(p.messages, p.systemPrompt, {
        signal: requestAc.signal,
        callbacks: {
          onChunk: (content: string) => {
            fullContent += content;
            sse.writeEvent('chunk', { content });
          },
          onDone: (result) => {
            fullContent = result.content;
            streamUsage = result.usage;
          },
          onError: (error: AIServiceError) => {
            sse.writeEvent('error', {
              error: USER_ERROR_MESSAGES[error.category],
              category: error.category,
              retryable: error.isRetryable,
            });
            try {
              this.ctx.get('errorReporter')?.capture('api_failure', error.category, error.message, error.httpStatus, error.stack, error.context as Record<string, unknown>);
              this.ctx.get('requestStatsModel')?.recordFailure(error.category);
            } catch { /* non-critical */ }
          },
        },
      });
      usedModel = streamResult.usedModel;
      const aiLatencyMs = Date.now() - aiStart;
      console.log(`[Perf] AI Stream Response: ${aiLatencyMs}ms`);
      console.log(`[AI Helper] 使用模型 (stream): ${usedModel.endpointName}/${usedModel.modelName}`);
      try { this.ctx.get('requestStatsModel')?.recordSuccess(aiLatencyMs); } catch { /* non-critical */ }
      // 降级成功上报
      if (streamResult.fallbackErrors?.length) {
        try {
          this.ctx.get('errorReporter')?.capture(
            'api_degraded', streamResult.fallbackErrors[0].category,
            `Primary failed, succeeded on ${usedModel.endpointName}/${usedModel.modelName}`,
            undefined, undefined,
            { endpointId: usedModel.endpointId, succeededOn: `${usedModel.endpointName}/${usedModel.modelName}`, attempts: streamResult.fallbackErrors, totalAttempts: streamResult.fallbackErrors.length + 1 },
          );
        } catch { /* non-critical */ }
      }

      // Safety filter on complete content
      const outputSafetyService = new OutputSafetyService();
      const safetyResult = outputSafetyService.sanitize(fullContent, {
        questionType: p.questionType,
        problemTitle: p.problemTitleStr,
        problemContent: p.processedProblemContent,
      });

      if (safetyResult.rewritten) {
        fullContent = safetyResult.content;
        sse.writeEvent('replace', { content: fullContent });
      }

      // Save AI message to DB
      const aiMessageTimestamp = new Date();
      const aiMessageMetadata: Record<string, string | number | boolean> = {};
      if (safetyResult.rewritten) aiMessageMetadata.safetyRewritten = true;
      if (streamUsage) {
        aiMessageMetadata.promptTokens = streamUsage.promptTokens;
        aiMessageMetadata.completionTokens = streamUsage.completionTokens;
        aiMessageMetadata.totalTokens = streamUsage.totalTokens;
      }
      if (usedModel) aiMessageMetadata.modelName = usedModel.modelName;
      if (aiLatencyMs > 0) aiMessageMetadata.latencyMs = aiLatencyMs;

      const aiMessageId = await p.messageModel.create({
        conversationId: p.currentConversationId,
        role: 'ai',
        content: fullContent,
        timestamp: aiMessageTimestamp,
        metadata: Object.keys(aiMessageMetadata).length > 0 ? aiMessageMetadata : undefined,
      });

      await p.conversationModel.incrementMessageCount(p.currentConversationId);
      await p.conversationModel.updateEndTime(p.currentConversationId, aiMessageTimestamp);

      // Send done event
      sse.writeEvent('done', {
        messageId: aiMessageId.toHexString(),
        usage: streamUsage ? {
          promptTokens: streamUsage.promptTokens,
          completionTokens: streamUsage.completionTokens,
          totalTokens: streamUsage.totalTokens,
        } : undefined,
        budgetWarning: p.budgetWarning || null,
      });

      // Async: record token usage
      if (streamUsage && streamUsage.totalTokens > 0 && usedModel) {
        const capturedUsedModel = usedModel;
        const capturedUsage = streamUsage;
        void (async () => {
          try {
            const tokenUsageModel: TokenUsageModel = this.ctx.get('tokenUsageModel');
            await tokenUsageModel.recordUsage({
              domainId: p.domainId,
              userId: p.userId,
              conversationId: p.currentConversationId,
              messageId: aiMessageId,
              endpointId: capturedUsedModel.endpointId,
              endpointName: capturedUsedModel.endpointName,
              modelName: capturedUsedModel.modelName,
              promptTokens: capturedUsage.promptTokens,
              completionTokens: capturedUsage.completionTokens,
              totalTokens: capturedUsage.totalTokens,
              questionType: p.questionType as string,
              latencyMs: aiLatencyMs,
            });
            const convColl = this.ctx.db.collection('ai_conversations');
            await convColl.updateOne(
              { _id: p.currentConversationId },
              { $inc: { 'metadata.totalTokens': capturedUsage.totalTokens } },
            );
          } catch (err) {
            console.error('[ChatHandler] 记录 token 用量失败:', err);
          }
        })();
      }

      // Async: effectiveness analysis
      try {
        const effectivenessService = new EffectivenessService(this.ctx);
        void effectivenessService.analyzeConversation(p.currentConversationId).catch(
          (err: unknown) => this.ctx.logger.error('Effectiveness analyze failed', err),
        );
      } catch (err) {
        this.ctx.logger.error('Schedule effectiveness analyze failed', err);
      }
    } catch (error) {
      try {
        const er = this.ctx.get('errorReporter');
        const rsm = this.ctx.get('requestStatsModel');
        if (error instanceof AIServiceError) {
          er?.capture('api_failure', error.category, error.message, error.httpStatus, error.stack, error.context as Record<string, unknown>);
          rsm?.recordFailure(error.category);
        } else {
          er?.capture('api_failure', 'unknown', error instanceof Error ? error.message : String(error));
          rsm?.recordFailure('unknown');
        }
      } catch { /* non-critical */ }

      if (!sse.closed) {
        if (error instanceof AIServiceError) {
          sse.writeEvent('error', {
            error: USER_ERROR_MESSAGES[error.category],
            category: error.category,
            retryable: error.isRetryable,
          });
        } else {
          sse.writeEvent('error', {
            error: 'AI 服务异常，请稍后再试',
            category: 'unknown',
            retryable: true,
          });
        }
      }
    } finally {
      clearInterval(keepaliveTimer);
      rawReq?.removeListener?.('close', onClose);
      sse.end();
    }
  }

  private async handleJsonResponse(p: PrepareChatResult): Promise<void> {
    // 调用 AI 服务(支持多模型 fallback + L4 请求级超时)
    let aiResponse: string;
    let aiResult: MultiModelChatResult | null = null;
    let aiLatencyMs = 0;

    // L4 请求级 AbortController
    const requestAc = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawReq = (this as any).context?.req;

    // 提前检查客户端是否已断开（close 事件可能在前序 DB 操作期间已触发）
    if (rawReq?.destroyed || rawReq?.aborted) {
      this.response.status = 499;
      this.response.body = { error: '请求已取消' };
      this.response.type = 'application/json';
      return;
    }

    const onClose = () => requestAc.abort();
    rawReq?.on?.('close', onClose);
    // L4: 请求级超时 — 基于配置值 + 10s buffer，确保比 L3 晚触发
    const configTimeoutMs = (p.aiConfig?.timeoutSeconds || 30) * 1000;
    const requestTimer = setTimeout(() => requestAc.abort(), configTimeoutMs + 10_000);

    try {
      const aiStart = Date.now();
      const result = await p.multiModelClient.chat(p.messages, p.systemPrompt, { signal: requestAc.signal });
      aiLatencyMs = Date.now() - aiStart;
      console.log(`[Perf] AI Response: ${aiLatencyMs}ms`);
      aiResponse = result.content;
      aiResult = result;
      console.log(`[AI Helper] 使用模型: ${result.usedModel.endpointName}/${result.usedModel.modelName}`);
      // 记录成功请求
      try { this.ctx.get('requestStatsModel')?.recordSuccess(aiLatencyMs); } catch { /* non-critical */ }
      // 降级成功上报
      if (result.fallbackErrors?.length) {
        try {
          this.ctx.get('errorReporter')?.capture(
            'api_degraded', result.fallbackErrors[0].category,
            `Primary failed, succeeded on ${result.usedModel.endpointName}/${result.usedModel.modelName}`,
            undefined, undefined,
            { endpointId: result.usedModel.endpointId, succeededOn: `${result.usedModel.endpointName}/${result.usedModel.modelName}`, attempts: result.fallbackErrors, totalAttempts: result.fallbackErrors.length + 1 },
          );
        } catch { /* non-critical */ }
      }
    } catch (error) {
      console.error('[AI Helper] AI 调用失败:', error);
      // 上报错误到遥测
      try {
        const er = this.ctx.get('errorReporter');
        const rsm = this.ctx.get('requestStatsModel');
        if (error instanceof AIServiceError) {
          er?.capture('api_failure', error.category, error.message, error.httpStatus, error.stack, error.context as Record<string, unknown>);
          rsm?.recordFailure(error.category);
        } else {
          er?.capture('api_failure', 'unknown', error instanceof Error ? error.message : String(error));
          rsm?.recordFailure('unknown');
        }
      } catch { /* non-critical */ }

      if (error instanceof AIServiceError) {
        this.response.status = getHttpStatusForCategory(error.category);
        this.response.body = {
          error: USER_ERROR_MESSAGES[error.category],
          code: `AI_${error.category.toUpperCase()}`,
          category: error.category,
          retryable: error.isRetryable,
        };
      } else {
        this.response.status = 500;
        this.response.body = {
          error: 'AI 服务异常，请稍后再试',
          code: 'AI_UNKNOWN',
          category: 'unknown',
          retryable: true,
        };
      }
      this.response.type = 'application/json';
      return;
    } finally {
      clearTimeout(requestTimer);
      rawReq?.removeListener?.('close', onClose);
    }

    // P0-2: 输出安全后处理（AI 响应返回后、保存到数据库前）
    const outputSafetyService = new OutputSafetyService();
    const safetyResult = outputSafetyService.sanitize(aiResponse, {
      questionType: p.questionType,
      problemTitle: p.problemTitleStr,
      problemContent: p.processedProblemContent
    });
    aiResponse = safetyResult.content;

    // 保存 AI 消息到数据库（含 token 用量元数据）
    const aiMessageTimestamp = new Date();
    const aiMessageMetadata: Record<string, string | number | boolean> = {};
    if (safetyResult.rewritten) aiMessageMetadata.safetyRewritten = true;
    if (aiResult?.usage) {
      aiMessageMetadata.promptTokens = aiResult.usage.promptTokens;
      aiMessageMetadata.completionTokens = aiResult.usage.completionTokens;
      aiMessageMetadata.totalTokens = aiResult.usage.totalTokens;
    }
    if (aiResult?.usedModel) {
      aiMessageMetadata.modelName = aiResult.usedModel.modelName;
    }
    if (aiLatencyMs > 0) {
      aiMessageMetadata.latencyMs = aiLatencyMs;
    }

    const aiMessageId = await p.messageModel.create({
      conversationId: p.currentConversationId,
      role: 'ai',
      content: aiResponse,
      timestamp: aiMessageTimestamp,
      metadata: Object.keys(aiMessageMetadata).length > 0 ? aiMessageMetadata : undefined
    });

    // 增加会话的消息计数并更新结束时间
    await p.conversationModel.incrementMessageCount(p.currentConversationId);
    await p.conversationModel.updateEndTime(p.currentConversationId, aiMessageTimestamp);

    // 异步记录 token 用量（不阻塞主流程）
    if (aiResult?.usage && aiResult.usedModel && aiResult.usage.totalTokens > 0) {
      const { usedModel: um, usage: usg } = aiResult;
      void (async () => {
        try {
          const tokenUsageModel: TokenUsageModel = this.ctx.get('tokenUsageModel');
          await tokenUsageModel.recordUsage({
            domainId: p.domainId,
            userId: p.userId,
            conversationId: p.currentConversationId,
            messageId: aiMessageId,
            endpointId: um.endpointId,
            endpointName: um.endpointName,
            modelName: um.modelName,
            promptTokens: usg.promptTokens,
            completionTokens: usg.completionTokens,
            totalTokens: usg.totalTokens,
            questionType: p.questionType as string,
            latencyMs: aiLatencyMs,
          });
          // $inc conversation metadata.totalTokens
          const convColl = this.ctx.db.collection('ai_conversations');
          await convColl.updateOne(
            { _id: p.currentConversationId },
            { $inc: { 'metadata.totalTokens': usg.totalTokens } }
          );
        } catch (err) {
          console.error('[ChatHandler] 记录 token 用量失败:', err);
        }
      })();
    }

    // 后台异步触发有效对话判定（不阻塞主流程）
    try {
      const effectivenessService = new EffectivenessService(this.ctx);
      void effectivenessService.analyzeConversation(p.currentConversationId).catch(
        (err: unknown) => this.ctx.logger.error('Effectiveness analyze failed', err)
      );
    } catch (err) {
      // 捕获同步错误（如构造函数异常），记录日志但不影响主流程
      this.ctx.logger.error('Schedule effectiveness analyze failed', err);
    }

    // 构造响应 (返回真实的 conversationId + AI 消息 ID)
    const response: ChatResponse = {
      conversationId: p.currentConversationId.toHexString(),
      message: {
        id: aiMessageId.toHexString(),
        role: 'ai',
        content: aiResponse,
        timestamp: aiMessageTimestamp.toISOString()
      }
    };

    // 如果代码被截断,添加警告信息
    if (p.codeWarning) {
      response.codeWarning = p.codeWarning;
    }

    if (p.judgeInfo) {
      response.hasJudgeInfo = true;
    }

    if (aiResult?.usage) {
      response.tokenUsage = {
        promptTokens: aiResult.usage.promptTokens,
        completionTokens: aiResult.usage.completionTokens,
        totalTokens: aiResult.usage.totalTokens,
      };
    }

    if (p.budgetWarning) {
      response.budgetWarning = p.budgetWarning;
    }

    this.response.body = response;
    this.response.type = 'application/json';
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
    // 限流：30 次/60秒，fail-open（只读端点）
    if (await applyRateLimit(this, {
      op: 'ai_problem_status', periodSecs: 60, maxOps: 30,
      failOpen: true,
      errorMessage: '请求太频繁，请稍后再试',
    })) return;

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
