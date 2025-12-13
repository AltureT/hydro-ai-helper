/**
 * 教师端 Handler
 * 处理教师查看对话列表和详情的请求
 */

import { Handler, PRIV, db } from 'hydrooj';
import { ConversationModel } from '../models/conversation';
import { MessageModel } from '../models/message';
import { ObjectId } from '../utils/mongo';
import { setJsonResponse, setErrorResponse, setTemplateResponse, expectsJson } from '../lib/httpHelpers';
import { parsePaginationParams } from '../lib/queryHelpers';

/**
 * 批量获取用户名映射
 * @param uids 用户 ID 数组
 * @returns uid -> uname 映射表
 */
async function getUserNameMap(uids: number[]): Promise<Map<number, string>> {
  const uniqueUids = [...new Set(uids)];
  const userMap = new Map<number, string>();

  if (uniqueUids.length === 0) {
    return userMap;
  }

  try {
    // 直接使用 HydroOJ db 访问 user 集合
    const userColl = db.collection('user');
    const users = await userColl.find({ _id: { $in: uniqueUids } }).toArray();
    for (const user of users) {
      userMap.set(user._id as number, (user as any).uname || '已删除用户');
    }
    // 对于不存在的用户，设置默认值
    for (const uid of uniqueUids) {
      if (!userMap.has(uid)) {
        userMap.set(uid, '已删除用户');
      }
    }
  } catch (err) {
    console.error('[AI Helper] Failed to fetch user names:', err);
    // 出错时全部使用默认值
    for (const uid of uniqueUids) {
      userMap.set(uid, '已删除用户');
    }
  }

  return userMap;
}

/**
 * 对话概要接口
 */
interface ConversationSummary {
  _id: string;
  userId: number;
  userName: string;
  classId?: string;
  problemId: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  isEffective: boolean;
  tags: string[];
  teacherNote?: string;
  metadata?: {
    problemTitle?: string;
    problemContent?: string;
  };
}

/**
 * ConversationListHandler - 获取对话列表
 * GET /ai-helper/conversations
 */
export class ConversationListHandler extends Handler {
  async get() {
    try {
      const wantJson = expectsJson(this);
      const conversationModel: ConversationModel = this.ctx.get('conversationModel');

      // 从查询参数读取筛选条件
      const {
        startDate,
        endDate,
        problemId,
        classId,
        userId,
        page = '1',
        limit = '50'
      } = this.request.query;

      // 解析分页参数
      const { page: pageNum, limit: limitNum } = parsePaginationParams(page as string, limit as string);

      // 构造筛选条件
      const filters: {
        startDate?: string;
        endDate?: string;
        problemId?: string;
        classId?: string;
        userId?: number;
      } = {};

      if (startDate) {
        filters.startDate = startDate as string;
      }

      if (endDate) {
        filters.endDate = endDate as string;
      }

      if (problemId) {
        filters.problemId = problemId as string;
      }

      if (classId) {
        filters.classId = classId as string;
      }

      if (userId) {
        filters.userId = parseInt(userId as string, 10);
      }

      // TODO(Phase4): 权限控制 - 教师只能查看所负责班级的对话
      // 当前版本暂不限制,所有 root 用户可查看所有对话

      // 查询对话列表
      const { conversations, total } = await conversationModel.findByFilters(
        filters,
        pageNum,
        limitNum
      );

      // 批量获取用户名（避免 N+1 查询）
      const uids = conversations.map(conv => conv.userId);
      const userNameMap = await getUserNameMap(uids);

      // 转换为响应格式
      const conversationSummaries: ConversationSummary[] = conversations.map(conv => ({
        _id: conv._id.toString(),
        userId: conv.userId,
        userName: userNameMap.get(conv.userId) || '已删除用户',
        classId: conv.classId,
        problemId: conv.problemId,
        startTime: conv.startTime.toISOString(),
        endTime: conv.endTime.toISOString(),
        messageCount: conv.messageCount,
        isEffective: conv.isEffective,
        tags: conv.tags,
        teacherNote: conv.teacherNote,
        metadata: conv.metadata
      }));

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
      setErrorResponse(this, 'INTERNAL_ERROR', err instanceof Error ? err.message : '服务器内部错误', 500);
    }
  }
}

/**
 * ConversationDetailHandler - 获取对话详情
 * GET /ai-helper/conversations/:id
 */
export class ConversationDetailHandler extends Handler {
  async get({ id }: { id: string }) {
    try {
      const wantJson = expectsJson(this);
      const conversationModel: ConversationModel = this.ctx.get('conversationModel');
      const messageModel: MessageModel = this.ctx.get('messageModel');

      if (!ObjectId.isValid(id)) {
        setErrorResponse(this, 'INVALID_ID', '无效的会话 ID');
        return;
      }

      // 查询会话详情
      console.log('[AI Helper] Fetching conversation:', id);
      const conversation = await conversationModel.findById(id);

      if (!conversation) {
        console.log('[AI Helper] Conversation not found:', id);
        setErrorResponse(this, 'NOT_FOUND', '会话不存在', 404);
        return;
      }

      console.log('[AI Helper] Conversation found, _id type:', typeof conversation._id, conversation._id.constructor.name);

      // TODO(Phase4): 权限控制 - 教师只能查看所负责班级的对话
      // 当前版本暂不限制，所有 root 用户可查看所有对话

      // 查询会话的所有消息 (按时间升序)
      console.log('[AI Helper] Fetching messages for conversation:', id);
      const messages = await messageModel.findByConversationId(id);
      console.log('[AI Helper] Found', messages.length, 'messages');

      // 转换消息格式
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

      // 获取用户名
      const userNameMap = await getUserNameMap([conversation.userId]);
      const userName = userNameMap.get(conversation.userId) || '已删除用户';

      const conversationData = {
        _id: conversation._id.toString(),
        userId: conversation.userId,
        userName,
        classId: conversation.classId,
        problemId: conversation.problemId,
        startTime: conversation.startTime.toISOString(),
        endTime: conversation.endTime.toISOString(),
        messageCount: conversation.messageCount,
        isEffective: conversation.isEffective,
        tags: conversation.tags,
        teacherNote: conversation.teacherNote,
        metadata: conversation.metadata
      };

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
      setErrorResponse(this, 'INTERNAL_ERROR', err instanceof Error ? err.message : '服务器内部错误', 500);
    }
  }
}

// 导出路由权限配置
// 使用 PRIV.PRIV_EDIT_SYSTEM (root-only 权限)
// AI 对话数据敏感，目前仅允许系统管理员访问
export const ConversationListHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
export const ConversationDetailHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
