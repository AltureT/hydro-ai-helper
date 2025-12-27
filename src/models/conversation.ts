/**
 * Conversation Model - 对话会话数据模型
 *
 * 管理学生与 AI 的对话会话,记录会话元数据
 */

import type { Db, Collection, Filter } from 'mongodb';
import { ObjectId, type ObjectIdType } from '../utils/mongo';

/**
 * 对话会话接口
 */
export interface Conversation {
  _id: ObjectIdType;       // 会话唯一标识
  domainId: string;        // 域 ID (用于多租户隔离)
  userId: number;          // 学生用户 ID
  problemId: string;       // 题目 ID
  classId?: string;        // 班级 ID (可选)
  startTime: Date;         // 会话开始时间
  endTime: Date;           // 会话最后更新时间
  messageCount: number;    // 消息总数
  isEffective: boolean;    // 是否为有效对话 (教学质量标记)
  teacherNote?: string;    // 教师备注 (可选,预留给后续 Phase)
  tags: string[];          // 标签列表 (预留给后续 Phase)
  // 可选 metadata 字段 (预留扩展)
  metadata?: {
    problemTitle?: string;    // 题目标题
    problemContent?: string;  // 题目描述摘要
  };
}

/**
 * Conversation Model 操作类
 * 封装对话会话的 CRUD 操作
 */
export class ConversationModel {
  private collection: Collection<Conversation>;

  constructor(db: Db) {
    this.collection = db.collection<Conversation>('ai_conversations');
  }

  /**
   * 确保索引已创建
   * 优化常用查询性能: 按用户、题目、时间筛选
   */
  async ensureIndexes(): Promise<void> {
    // 创建索引: 域 ID (用于域隔离查询)
    await this.collection.createIndex(
      { domainId: 1 },
      { name: 'idx_domainId' }
    );

    // 创建复合索引: 域 ID + 开始时间 (域内按时间排序)
    await this.collection.createIndex(
      { domainId: 1, startTime: -1 },
      { name: 'idx_domainId_startTime' }
    );

    // 创建复合索引: 域 ID + 用户 ID + 开始时间
    await this.collection.createIndex(
      { domainId: 1, userId: 1, startTime: -1 },
      { name: 'idx_domainId_userId_startTime' }
    );

    // 创建复合索引: 域 ID + 题目 ID + 开始时间
    await this.collection.createIndex(
      { domainId: 1, problemId: 1, startTime: -1 },
      { name: 'idx_domainId_problemId_startTime' }
    );

    // 创建复合索引: 用户 + 开始时间 (降序)
    await this.collection.createIndex(
      { userId: 1, startTime: -1 },
      { name: 'idx_userId_startTime' }
    );

    // 创建索引: 题目 ID
    await this.collection.createIndex(
      { problemId: 1 },
      { name: 'idx_problemId' }
    );

    // 创建复合索引: 题目 ID + 开始时间
    await this.collection.createIndex(
      { problemId: 1, startTime: -1 },
      { name: 'idx_problemId_startTime' }
    );

    // 创建索引: 班级 ID (稀疏索引,因为 classId 可选)
    await this.collection.createIndex(
      { classId: 1 },
      { name: 'idx_classId', sparse: true }
    );

    // 创建复合索引: 班级 ID + 开始时间 (稀疏)
    await this.collection.createIndex(
      { classId: 1, startTime: -1 },
      { name: 'idx_classId_startTime', sparse: true }
    );

    // 创建索引: 开始时间 (用于时间范围筛选)
    await this.collection.createIndex(
      { startTime: -1 },
      { name: 'idx_startTime' }
    );

    console.log('[ConversationModel] Indexes created successfully');
  }

  /**
   * 创建新的对话会话
   * @param data 会话数据
   * @returns 插入的会话 ID
   */
  async create(data: Omit<Conversation, '_id'>): Promise<ObjectIdType> {
    const result = await this.collection.insertOne(data as Conversation);
    return result.insertedId;
  }

  /**
   * 根据 ID 查找会话
   * @param id 会话 ID (字符串或 ObjectId)
   * @returns 会话对象或 null
   */
  async findById(id: string | ObjectIdType): Promise<Conversation | null> {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    return this.collection.findOne({ _id });
  }

  /**
   * 更新会话的最后更新时间
   * @param id 会话 ID
   * @param endTime 最后更新时间
   */
  async updateEndTime(id: string | ObjectIdType, endTime: Date): Promise<void> {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    await this.collection.updateOne(
      { _id },
      { $set: { endTime } }
    );
  }

  /**
   * 增加会话的消息计数
   * @param id 会话 ID
   */
  async incrementMessageCount(id: string | ObjectIdType): Promise<void> {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    await this.collection.updateOne(
      { _id },
      { $inc: { messageCount: 1 } }
    );
  }

  /**
   * 更新会话的有效性标记
   * @param id 会话 ID
   * @param isEffective 是否有效
   */
  async updateEffectiveness(id: string | ObjectIdType, isEffective: boolean): Promise<void> {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    await this.collection.updateOne(
      { _id },
      { $set: { isEffective } }
    );
  }

  /**
   * 根据筛选条件查找会话列表 (分页)
   * @param filters 筛选条件
   * @param page 页码 (从 1 开始)
   * @param limit 每页条数 (默认 50)
   * @returns 会话列表和总数
   */
  async findByFilters(
    filters: {
      domainId?: string;    // 域 ID (用于域隔离)
      startDate?: string;   // 开始日期 (ISO 8601)
      endDate?: string;     // 结束日期
      problemId?: string;   // 题目 ID
      classId?: string;     // 班级 ID
      userId?: number;      // 学生 ID
    },
    page: number = 1,
    limit: number = 50
  ): Promise<{ conversations: Conversation[]; total: number }> {
    // 构造查询条件
    const query: Filter<Conversation> = {};

    if (filters.domainId) {
      query.domainId = filters.domainId;
    }

    if (filters.userId !== undefined) {
      query.userId = filters.userId;
    }

    if (filters.problemId) {
      query.problemId = filters.problemId;
    }

    if (filters.classId) {
      query.classId = filters.classId;
    }

    // 时间范围筛选
    if (filters.startDate || filters.endDate) {
      query.startTime = {};
      if (filters.startDate) {
        query.startTime.$gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        query.startTime.$lte = new Date(filters.endDate);
      }
    }

    // 查询总数
    const total = await this.collection.countDocuments(query);

    // 查询分页数据 (按开始时间降序排序)
    const skip = (page - 1) * limit;
    const projection: Partial<Record<keyof Conversation, 1 | 0>> = {
      _id: 1,
      domainId: 1,
      userId: 1,
      classId: 1,
      problemId: 1,
      startTime: 1,
      endTime: 1,
      messageCount: 1,
      isEffective: 1,
      tags: 1,
      teacherNote: 1,
      metadata: 1
    };

    const conversations = await this.collection
      .find(query, { projection })
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return { conversations, total };
  }

  /**
   * 更新会话的教师备注和标签 (预留给后续 Phase)
   * @param id 会话 ID
   * @param teacherNote 教师备注
   * @param tags 标签列表
   */
  async updateTeacherAnnotations(
    id: string | ObjectIdType,
    teacherNote?: string,
    tags?: string[]
  ): Promise<void> {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    const update: Partial<Pick<Conversation, 'teacherNote' | 'tags'>> = {};

    if (teacherNote !== undefined) {
      update.teacherNote = teacherNote;
    }

    if (tags !== undefined) {
      update.tags = tags;
    }

    if (Object.keys(update).length > 0) {
      await this.collection.updateOne(
        { _id },
        { $set: update }
      );
    }
  }
}
