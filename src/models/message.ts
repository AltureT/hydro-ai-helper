/**
 * Message Model - 对话消息数据模型
 *
 * 管理对话中的每条消息 (学生问题 / AI 回答)
 */

import type { Db, Collection } from 'mongodb';
import { ObjectId, type ObjectIdType } from '../utils/mongo';

/**
 * 消息角色类型
 */
export type MessageRole = 'student' | 'ai';

/**
 * 问题类型 (学生消息专用)
 */
export type QuestionType = 'understand' | 'think' | 'debug' | 'review';

/**
 * 对话消息接口
 */
export interface Message {
  _id: ObjectIdType;          // 消息唯一标识
  conversationId: ObjectIdType;   // 所属会话 ID
  role: MessageRole;          // 消息角色 (student / ai)
  content: string;            // 消息内容 (Markdown 格式)
  timestamp: Date;            // 消息时间戳
  questionType?: QuestionType; // 问题类型 (仅学生消息有效)
  attachedCode?: boolean;     // 是否附带代码 (仅学生消息有效)
  attachedError?: boolean;    // 是否附带错误信息 (仅学生消息有效)
  // 可选 metadata 字段 (预留扩展)
  metadata?: {
    codeLength?: number;      // 代码长度 (字符数)
    codeWarning?: string;     // 代码截断警告
  };
}

/**
 * Message Model 操作类
 * 封装对话消息的 CRUD 操作
 */
export class MessageModel {
  private collection: Collection<Message>;

  constructor(db: Db) {
    this.collection = db.collection<Message>('ai_messages');
  }

  /**
   * 确保索引已创建
   * 优化常用查询性能: 按会话 ID + 时间戳查询
   */
  async ensureIndexes(): Promise<void> {
    // 创建复合索引: 会话 ID + 时间戳 (升序)
    await this.collection.createIndex(
      { conversationId: 1, timestamp: 1 },
      { name: 'idx_conversationId_timestamp' }
    );

    // 创建复合索引: 会话 ID + 角色 + 时间戳 (用于按角色筛选并排序)
    await this.collection.createIndex(
      { conversationId: 1, role: 1, timestamp: 1 },
      { name: 'idx_conversationId_role_timestamp' }
    );

    // 创建索引: 会话 ID (用于快速查找某个会话的所有消息)
    await this.collection.createIndex(
      { conversationId: 1 },
      { name: 'idx_conversationId' }
    );

    console.log('[MessageModel] Indexes created successfully');
  }

  /**
   * 创建新消息
   * @param data 消息数据
   * @returns 插入的消息 ID
   */
  async create(data: Omit<Message, '_id'>): Promise<ObjectIdType> {
    const result = await this.collection.insertOne(data as Message);
    return result.insertedId;
  }

  /**
   * 根据会话 ID 查找所有消息 (按时间升序排序)
   * @param conversationId 会话 ID (字符串或 ObjectId)
   * @returns 消息列表
   */
  async findByConversationId(conversationId: string | ObjectIdType): Promise<Message[]> {
    const _conversationId = typeof conversationId === 'string'
      ? new ObjectId(conversationId)
      : conversationId;

    return this.collection
      .find({ conversationId: _conversationId })
      .sort({ timestamp: 1 })  // 按时间升序排序
      .toArray();
  }

  /**
   * 根据 ID 查找单条消息
   * @param id 消息 ID (字符串或 ObjectId)
   * @returns 消息对象或 null
   */
  async findById(id: string | ObjectIdType): Promise<Message | null> {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    return this.collection.findOne({ _id });
  }

  /**
   * 删除会话的所有消息 (用于数据清理或测试)
   * @param conversationId 会话 ID
   * @returns 删除的消息数量
   */
  async deleteByConversationId(conversationId: string | ObjectIdType): Promise<number> {
    const _conversationId = typeof conversationId === 'string'
      ? new ObjectId(conversationId)
      : conversationId;

    const result = await this.collection.deleteMany({ conversationId: _conversationId });
    return result.deletedCount;
  }

  /**
   * 统计会话的消息数量
   * @param conversationId 会话 ID
   * @returns 消息数量
   */
  async countByConversationId(conversationId: string | ObjectIdType): Promise<number> {
    const _conversationId = typeof conversationId === 'string'
      ? new ObjectId(conversationId)
      : conversationId;

    return this.collection.countDocuments({ conversationId: _conversationId });
  }

  /**
   * 获取会话中学生消息的列表 (用于有效对话判定)
   * @param conversationId 会话 ID
   * @returns 学生消息列表
   */
  async findStudentMessagesByConversationId(conversationId: string | ObjectIdType): Promise<Message[]> {
    const _conversationId = typeof conversationId === 'string'
      ? new ObjectId(conversationId)
      : conversationId;

    return this.collection
      .find({ conversationId: _conversationId, role: 'student' })
      .sort({ timestamp: 1 })
      .toArray();
  }

  /**
   * 获取会话中 AI 消息的列表 (用于有效对话判定)
   * @param conversationId 会话 ID
   * @returns AI 消息列表
   */
  async findAiMessagesByConversationId(conversationId: string | ObjectIdType): Promise<Message[]> {
    const _conversationId = typeof conversationId === 'string'
      ? new ObjectId(conversationId)
      : conversationId;

    return this.collection
      .find({ conversationId: _conversationId, role: 'ai' })
      .sort({ timestamp: 1 })
      .toArray();
  }
}
