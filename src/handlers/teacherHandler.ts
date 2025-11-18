/**
 * 教师端 Handler
 * 处理教师查看对话列表和详情的请求
 */

import { Handler, PRIV } from 'hydrooj';
import { ConversationModel } from '../models/conversation';
import { MessageModel } from '../models/message';
import { ObjectId } from '../utils/mongo';

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
      // 检测请求类型：浏览器 HTML 访问还是前端 JSON API 调用
      const accept = this.request.headers.accept || '';
      const wantJson = accept.includes('application/json');

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
      // 当前版本暂不限制,所有 root 用户可查看所有对话

      // 查询对话列表
      const { conversations, total } = await conversationModel.findByFilters(
        filters,
        pageNum,
        limitNum
      );

      // 转换为响应格式
      const conversationSummaries: ConversationSummary[] = conversations.map(conv => ({
        _id: conv._id.toString(),
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

      if (wantJson) {
        // JSON API 模式：前端 fetch 调用
        const response: ConversationListResponse = {
          conversations: conversationSummaries,
          total,
          page: pageNum,
          limit: limitNum
        };

        this.response.body = response;
        this.response.type = 'application/json';
        return;
      }

      // HTML 页面模式：浏览器直接访问
      this.response.template = 'ai-helper/teacher_conversations.html';
      this.response.body = {
        total,
        page: pageNum,
        limit: limitNum,
        // 可以传递初始数据，但也可以让前端完全通过 fetch 获取
      };
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
      // 检测请求类型：浏览器 HTML 访问还是前端 JSON API 调用
      const accept = this.request.headers.accept || '';
      const wantJson = accept.includes('application/json');

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
      console.log('[AI Helper] Fetching conversation:', id);
      const conversation = await conversationModel.findById(id);

      if (!conversation) {
        console.log('[AI Helper] Conversation not found:', id);
        this.response.status = 404;
        this.response.body = { error: '会话不存在' };
        this.response.type = 'application/json';
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

      if (wantJson) {
        // JSON API 模式：前端 fetch 调用
        const response = {
          conversation: {
            _id: conversation._id.toString(),
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
        return;
      }

      // HTML 页面模式：浏览器直接访问
      this.response.template = 'ai-helper/teacher_conversation_detail.html';
      this.response.body = {
        conversation: {
          _id: conversation._id.toString(),
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
    } catch (err) {
      console.error('[AI Helper] ConversationDetailHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
      this.response.type = 'application/json';
    }
  }
}

// 导出路由权限配置
// 使用 PRIV.PRIV_EDIT_SYSTEM (root-only 权限)
// AI 对话数据敏感，目前仅允许系统管理员访问
export const ConversationListHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
export const ConversationDetailHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
