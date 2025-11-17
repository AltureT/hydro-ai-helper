/**
 * 教师端 Handler
 * 处理教师查看对话列表和详情的请求
 */

import { Handler, PRIV } from 'hydrooj';
import { ObjectId } from 'mongodb';
import { ConversationModel } from '../models/conversation';
import { MessageModel } from '../models/message';

/**
 * 对话列表响应接口
 */
interface ConversationSummary {
  _id: string;
  userId: number;
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

interface ConversationListResponse {
  conversations: ConversationSummary[];
  total: number;
  page: number;
  limit: number;
}

/**
 * ConversationListHandler - 获取对话列表
 * GET /ai-helper/conversations
 */
export class ConversationListHandler extends Handler {
  async get() {
    try {
      // 获取数据库模型实例
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
      const pageNum = parseInt(page as string, 10) || 1;
      const limitNum = Math.min(parseInt(limit as string, 10) || 50, 100); // 最大 100 条/页

      // 构造筛选条件
      const filters: any = {};

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
      // 当前版本暂不限制,所有教师可查看所有对话

      // 查询对话列表
      const { conversations, total } = await conversationModel.findByFilters(
        filters,
        pageNum,
        limitNum
      );

      // 转换为响应格式
      const conversationSummaries: ConversationSummary[] = conversations.map(conv => ({
        _id: conv._id.toHexString(),
        userId: conv.userId,
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

      // 构造响应
      const response: ConversationListResponse = {
        conversations: conversationSummaries,
        total,
        page: pageNum,
        limit: limitNum
      };

      this.response.body = response;
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[AI Helper] ConversationListHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
      this.response.type = 'application/json';
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
      // 获取数据库模型实例
      const conversationModel: ConversationModel = this.ctx.get('conversationModel');
      const messageModel: MessageModel = this.ctx.get('messageModel');

      // 验证 conversationId 格式
      if (!ObjectId.isValid(id)) {
        this.response.status = 400;
        this.response.body = { error: '无效的会话 ID' };
        this.response.type = 'application/json';
        return;
      }

      // 查询会话详情
      const conversation = await conversationModel.findById(id);

      if (!conversation) {
        this.response.status = 404;
        this.response.body = { error: '会话不存在' };
        this.response.type = 'application/json';
        return;
      }

      // TODO(Phase4): 权限控制 - 教师只能查看所负责班级的对话
      // 当前版本暂不限制

      // 查询会话的所有消息 (按时间升序)
      const messages = await messageModel.findByConversationId(id);

      // 转换消息格式
      const messagesFormatted = messages.map(msg => ({
        _id: msg._id.toHexString(),
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp.toISOString(),
        questionType: msg.questionType,
        attachedCode: msg.attachedCode,
        attachedError: msg.attachedError,
        metadata: msg.metadata
      }));

      // 构造响应
      const response = {
        conversation: {
          _id: conversation._id.toHexString(),
          userId: conversation.userId,
          classId: conversation.classId,
          problemId: conversation.problemId,
          startTime: conversation.startTime.toISOString(),
          endTime: conversation.endTime.toISOString(),
          messageCount: conversation.messageCount,
          isEffective: conversation.isEffective,
          tags: conversation.tags,
          teacherNote: conversation.teacherNote,
          metadata: conversation.metadata
        },
        messages: messagesFormatted
      };

      this.response.body = response;
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[AI Helper] ConversationDetailHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
      this.response.type = 'application/json';
    }
  }
}

// 导出路由权限配置
// TODO: 使用更精确的教师权限 (如 PRIV.PRIV_EDIT_PROBLEM 或自定义教师权限)
// 当前使用较高权限作为占位,确保只有教师/管理员可访问
export const ConversationListHandlerPriv = PRIV.PRIV_EDIT_PROBLEM_SELF;
export const ConversationDetailHandlerPriv = PRIV.PRIV_EDIT_PROBLEM_SELF;
