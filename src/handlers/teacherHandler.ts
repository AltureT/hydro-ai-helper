/**
 * 教师端 Handler
 * 处理教师查看对话列表和详情的请求
 */

import { Handler, PRIV, db } from 'hydrooj';
import { ConversationModel, type Conversation } from '../models/conversation';
import { MessageModel } from '../models/message';
import { ObjectId } from '../utils/mongo';
import { setJsonResponse, setErrorResponse, setTemplateResponse, expectsJson } from '../lib/httpHelpers';
import { parsePaginationParams } from '../lib/queryHelpers';
import { getDomainId } from '../utils/domainHelper';
import type { UserDocument } from '../types/hydrooj';
import { readGroupParam } from '../utils/groupFilter';

/**
 * 批量获取用户名映射
 * @param uids 用户 ID 数组
 * @returns uid -> uname 映射表
 */
async function getUserNameMap(uids: number[], deletedUserFallback: string): Promise<Map<number, string>> {
  const uniqueUids = [...new Set(uids)];
  const userMap = new Map<number, string>();

  if (uniqueUids.length === 0) {
    return userMap;
  }

  try {
    const userColl = db.collection('user');
    const users = await userColl.find({ _id: { $in: uniqueUids } }).toArray();
    for (const user of users) {
      const u = user as UserDocument;
      userMap.set(u._id, u.uname || deletedUserFallback);
    }
    for (const uid of uniqueUids) {
      if (!userMap.has(uid)) {
        userMap.set(uid, deletedUserFallback);
      }
    }
  } catch (err) {
    console.error('[AI Helper] Failed to fetch user names:', err);
    for (const uid of uniqueUids) {
      userMap.set(uid, deletedUserFallback);
    }
  }

  return userMap;
}

/**
 * 对话概要接口
 */
interface ConversationMetricsDTO {
  v: number;
  studentMessageCount: number;
  studentTotalLength: number;
  submissionsAfter: number | null;
  firstAcceptedIndex: number | null;
  problemDifficulty: number | null;
  backfilledAt: string | null;
}

type MetricsStatus = 'legacy' | 'pending' | 'complete';

function deriveMetricsStatus(metrics?: { backfilledAt: Date | null }): MetricsStatus {
  if (!metrics) return 'legacy';
  return metrics.backfilledAt === null ? 'pending' : 'complete';
}

export interface ConversationSummary {
  _id: string;
  userId: number;
  userName: string;
  /** 建会话时学生所在的小组；undefined 表示没有记录（升级前的会话） */
  groupNames?: string[];
  groupSource?: 'snapshot' | 'backfill';
  problemId: string;
  problemUrl?: string;  // T031: 题目详情页 URL
  startTime: string;
  endTime: string;
  messageCount: number;
  isEffective: boolean;
  metrics?: ConversationMetricsDTO;
  metricsStatus: MetricsStatus;
  tags: string[];
  teacherNote?: string;
  metadata?: {
    problemTitle?: string;
    problemContent?: string;
  };
  firstMessageSummary?: string;  // T048: 学生首条消息摘要（前100字）
  questionType?: string;
}

/**
 * T031/T032: 生成题目详情页 URL
 * @param domainId 域 ID
 * @param problemId 题目 ID
 * @returns 题目详情页 URL
 */
function buildProblemUrl(domainId: string, problemId: string): string {
  if (!problemId) return '';
  // 域前缀格式：/d/:domainId/p/:problemId
  // 主站格式：/p/:problemId
  if (domainId && domainId !== 'system') {
    return `/d/${domainId}/p/${problemId}`;
  }
  return `/p/${problemId}`;
}

/**
 * 列表行：用户名、首条学生消息摘要、题目链接。
 * 系统管理员的对话列表与负责老师的班级视图共用。
 */
export async function summarizeConversations(
  handler: Handler,
  conversations: Conversation[],
  domainId: string,
): Promise<ConversationSummary[]> {
  // 批量获取用户名（避免 N+1 查询）
  const uids = conversations.map(conv => conv.userId);
  const deletedUserLabel = handler.translate('ai_helper_teacher_deleted_user');
  const userNameMap = await getUserNameMap(uids, deletedUserLabel);

  // T048: 批量获取每个会话的第一条学生消息
  const messageModel: MessageModel = handler.ctx.get('messageModel');
  const conversationIds = conversations.map(conv => conv._id);
  const firstMessagesMap = await messageModel.findFirstStudentMessagesForConversations(conversationIds);

  return conversations.map(conv => {
    const convIdStr = conv._id.toString();
    const firstMsg = firstMessagesMap.get(convIdStr);
    // T048: 截取前100字作为摘要
    let firstMessageSummary: string | undefined;
    if (firstMsg?.content) {
      firstMessageSummary = firstMsg.content.length > 100
        ? firstMsg.content.substring(0, 100) + '...'
        : firstMsg.content;
    }

    return {
      _id: convIdStr,
      userId: conv.userId,
      userName: userNameMap.get(conv.userId) || deletedUserLabel,
      groupNames: conv.groupNames,
      groupSource: conv.groupSource,
      problemId: conv.problemId,
      problemUrl: buildProblemUrl(domainId, conv.problemId),  // T031: 题目链接
      startTime: conv.startTime.toISOString(),
      endTime: conv.endTime.toISOString(),
      messageCount: conv.messageCount,
      isEffective: conv.isEffective,
      metrics: conv.metrics ? {
        ...conv.metrics,
        backfilledAt: conv.metrics.backfilledAt?.toISOString() ?? null,
      } : undefined,
      metricsStatus: deriveMetricsStatus(conv.metrics),
      tags: conv.tags,
      teacherNote: conv.teacherNote,
      metadata: conv.metadata,
      firstMessageSummary,  // T048: 学生问题摘要
      questionType: firstMsg?.questionType,
    };
  });
}

/** 详情：会话信息 + 全部消息（按时间升序） */
export async function buildConversationDetail(handler: Handler, conversation: Conversation, domainId: string) {
  const messageModel: MessageModel = handler.ctx.get('messageModel');
  const messages = await messageModel.findByConversationId(conversation._id.toString());
  const messagesFormatted = messages.map(msg => ({
    _id: msg._id.toString(),
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    questionType: msg.questionType,
    attachedCode: msg.attachedCode,
    attachedError: msg.attachedError,
    metadata: msg.metadata
  }));

  const deletedLabel = handler.translate('ai_helper_teacher_deleted_user');
  const userNameMap = await getUserNameMap([conversation.userId], deletedLabel);
  const userName = userNameMap.get(conversation.userId) || deletedLabel;

  // T032: 对话详情响应（包含 problemUrl + metrics）
  const conversationData = {
    _id: conversation._id.toString(),
    userId: conversation.userId,
    userName,
    groupNames: conversation.groupNames,
    groupSource: conversation.groupSource,
    problemId: conversation.problemId,
    problemUrl: buildProblemUrl(domainId, conversation.problemId),  // T032: 题目链接
    startTime: conversation.startTime.toISOString(),
    endTime: conversation.endTime.toISOString(),
    messageCount: conversation.messageCount,
    isEffective: conversation.isEffective,
    metrics: conversation.metrics ? {
      ...conversation.metrics,
      backfilledAt: conversation.metrics.backfilledAt?.toISOString() ?? null,
    } : undefined,
    metricsStatus: deriveMetricsStatus(conversation.metrics),
    tags: conversation.tags,
    teacherNote: conversation.teacherNote,
    metadata: conversation.metadata
  };

  return { conversation: conversationData, messages: messagesFormatted };
}

/**
 * ConversationListHandler - 获取对话列表
 * GET /ai-helper/conversations
 * GET /d/:domainId/ai-helper/conversations
 */
export class ConversationListHandler extends Handler {
  async get() {
    try {
      const wantJson = expectsJson(this);
      const conversationModel: ConversationModel = this.ctx.get('conversationModel');

      // 获取当前域 ID（用于域隔离）
      const domainId = getDomainId(this);

      // 从查询参数读取筛选条件
      const {
        startDate,
        endDate,
        problemId,
        userId,
        page = '1',
        limit = '50'
      } = this.request.query;
      const group = readGroupParam(this.request.query as Record<string, unknown>);

      // 解析分页参数
      const { page: pageNum, limit: limitNum } = parsePaginationParams(page as string, limit as string);

      // 构造筛选条件（始终包含 domainId 以实现域隔离）
      const filters: {
        domainId?: string;
        startDate?: string;
        endDate?: string;
        problemId?: string;
        group?: string;
        userId?: number;
      } = {
        domainId  // 域隔离：只查询当前域的对话
      };

      if (startDate) {
        filters.startDate = startDate as string;
      }

      if (endDate) {
        filters.endDate = endDate as string;
      }

      if (problemId) {
        filters.problemId = problemId as string;
      }

      if (group) {
        filters.group = group;
      }

      if (userId) {
        filters.userId = parseInt(userId as string, 10);
      }

      // 查询对话列表（已通过 domainId 实现域隔离）
      const { conversations, total } = await conversationModel.findByFilters(
        filters,
        pageNum,
        limitNum
      );

      const conversationSummaries = await summarizeConversations(this, conversations, domainId);

      if (wantJson) {
        setJsonResponse(this, {
          conversations: conversationSummaries,
          total,
          page: pageNum,
          limit: limitNum
        });
        return;
      }

      setTemplateResponse(this, 'ai-helper/teacher_conversations.html', {
        total,
        page: pageNum,
        limit: limitNum
      });
    } catch (err) {
      console.error('[AI Helper] ConversationListHandler error:', err);
      setErrorResponse(this, 'INTERNAL_ERROR', err instanceof Error ? err.message : this.translate('ai_helper_err_internal'), 500);
    }
  }
}

/**
 * ConversationDetailHandler - 获取对话详情
 * GET /ai-helper/conversations/:id
 * GET /d/:domainId/ai-helper/conversations/:id
 */
export class ConversationDetailHandler extends Handler {
  async get({ id }: { id: string }) {
    try {
      const wantJson = expectsJson(this);
      const conversationModel: ConversationModel = this.ctx.get('conversationModel');

      // 获取当前域 ID（用于域隔离验证）
      const domainId = getDomainId(this);

      if (!ObjectId.isValid(id)) {
        setErrorResponse(this, 'INVALID_ID', this.translate('ai_helper_teacher_invalid_conversation_id'));
        return;
      }

      // 查询会话详情
      const conversation = await conversationModel.findById(id);

      if (!conversation) {
        setErrorResponse(this, 'NOT_FOUND', this.translate('ai_helper_teacher_conversation_not_found'), 404);
        return;
      }

      // 域隔离验证：确保对话属于当前域
      // 特殊处理：
      // 1. 对话的 domainId 为 'system'（历史数据迁移默认值）时，允许任何域访问
      // 2. 当前访问域为 'system'（主站访问）时，允许访问所有域的对话
      const conversationDomain = conversation.domainId || 'system';
      if (conversationDomain !== domainId && conversationDomain !== 'system' && domainId !== 'system') {
        setErrorResponse(this, 'FORBIDDEN', this.translate('ai_helper_teacher_conversation_forbidden'), 403);
        return;
      }

      const { conversation: conversationData, messages: messagesFormatted } =
        await buildConversationDetail(this, conversation, domainId);

      if (wantJson) {
        setJsonResponse(this, {
          conversation: conversationData,
          messages: messagesFormatted
        });
        return;
      }

      setTemplateResponse(this, 'ai-helper/teacher_conversation_detail.html', {
        conversation: conversationData,
        messages: messagesFormatted
      });
    } catch (err) {
      console.error('[AI Helper] ConversationDetailHandler error:', err);
      setErrorResponse(this, 'INTERNAL_ERROR', err instanceof Error ? err.message : this.translate('ai_helper_err_internal'), 500);
    }
  }
}

// 导出路由权限配置
// 使用 PRIV.PRIV_EDIT_SYSTEM (root-only 权限)
// AI 对话数据敏感，目前仅允许系统管理员访问
export const ConversationListHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
export const ConversationDetailHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
