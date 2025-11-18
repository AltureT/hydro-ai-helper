/**
 * Export Service - 数据导出服务
 *
 * 支持按筛选条件导出会话数据为 CSV 格式
 */

import type { Context } from 'hydrooj';
import { ConversationModel, Conversation } from '../models/conversation';

/**
 * 导出筛选条件接口
 */
export interface ConversationExportFilters {
  startDate?: Date;      // 开始日期 (会话 startTime >= startDate)
  endDate?: Date;        // 结束日期 (会话 startTime <= endDate)
  classId?: string;      // 班级 ID
  problemId?: string;    // 题目 ID
  userId?: string;       // 学生用户 ID (字符串类型,用于传递)
}

/**
 * 导出选项接口
 */
export interface ConversationExportOptions {
  includeSensitive?: boolean;  // 是否包含敏感信息(真实 userId),默认 false
}

/**
 * ExportService 类
 * 负责导出会话级数据为 CSV 字符串
 */
export class ExportService {
  private conversationModel: ConversationModel;

  constructor(private ctx: Context) {
    this.conversationModel = ctx.get('conversationModel');
  }

  /**
   * 导出会话列表为 CSV 字符串
   *
   * @param filters 筛选条件
   * @param options 导出选项
   * @returns CSV 字符串
   */
  async exportConversations(
    filters: ConversationExportFilters,
    options: ConversationExportOptions = {}
  ): Promise<string> {
    // 1. 构造查询条件
    const query: any = {};

    // 时间范围筛选
    if (filters.startDate || filters.endDate) {
      query.startTime = {};
      if (filters.startDate) {
        query.startTime.$gte = filters.startDate;
      }
      if (filters.endDate) {
        query.startTime.$lte = filters.endDate;
      }
    }

    // 班级/题目/用户筛选
    if (filters.classId) {
      query.classId = filters.classId;
    }
    if (filters.problemId) {
      query.problemId = filters.problemId;
    }
    if (filters.userId) {
      query.userId = parseInt(filters.userId, 10); // 转换为 number
    }

    // 2. 查询所有符合条件的会话记录(按开始时间升序排序)
    const db = this.ctx.db;
    const collection = db.collection('ai_conversations');
    const conversations = await collection
      .find(query)
      .sort({ startTime: 1 })
      .toArray() as Conversation[];

    console.log(`[ExportService] Exporting ${conversations.length} conversations`);

    // 3. 脱敏逻辑(如果 includeSensitive=false)
    const userIdMap = new Map<number, string>();
    let userCounter = 1;

    const getAnonymousId = (realUserId: number): string => {
      if (options.includeSensitive) {
        return realUserId.toString();
      }
      if (!userIdMap.has(realUserId)) {
        const anonymousId = `user_${String(userCounter).padStart(3, '0')}`;
        userIdMap.set(realUserId, anonymousId);
        userCounter++;
      }
      return userIdMap.get(realUserId)!;
    };

    // 4. 构建 CSV 数据
    const rows: string[][] = [];

    // 表头
    const headers = [
      'conversationId',
      options.includeSensitive ? 'userId' : 'anonymousId',
      'classId',
      'problemId',
      'problemTitle',
      'startTime',
      'endTime',
      'messageCount',
      'isEffective',
      'teacherNote',
      'tags'
    ];
    rows.push(headers);

    // 数据行
    for (const conv of conversations) {
      const row = [
        conv._id.toString(),
        getAnonymousId(conv.userId),
        conv.classId || '',
        conv.problemId || '',
        conv.metadata?.problemTitle || '',
        conv.startTime.toISOString(),
        conv.endTime.toISOString(),
        conv.messageCount.toString(),
        conv.isEffective ? 'true' : 'false',
        conv.teacherNote || '',
        Array.isArray(conv.tags) ? conv.tags.join(';') : ''
      ];
      rows.push(row);
    }

    // 5. 转换为 CSV 字符串
    return this.convertToCsv(rows);
  }

  /**
   * 将二维数组转换为 CSV 字符串
   *
   * @param rows 二维数组,第一行为表头,后续为数据行
   * @returns CSV 字符串
   */
  private convertToCsv(rows: string[][]): string {
    return rows.map(row => row.map(this.escapeCsvField).join(',')).join('\n');
  }

  /**
   * 转义 CSV 字段
   * 如果字段包含逗号、双引号或换行,则用双引号包裹,并转义内部双引号
   *
   * @param value 字段值
   * @returns 转义后的字符串
   */
  private escapeCsvField(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    const str = String(value);

    // 如果包含逗号、双引号或换行,则用双引号包裹
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }
}
