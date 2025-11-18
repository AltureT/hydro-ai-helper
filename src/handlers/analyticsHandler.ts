/**
 * AI 使用统计分析 Handler
 * 处理统计分析 API 请求，支持按班级/题目/学生维度聚合数据
 */

import { Handler, PRIV } from 'hydrooj';

/**
 * 筛选条件接口
 */
interface AnalyticsFilters {
  startDate?: Date;
  endDate?: Date;
  classId?: string;
  problemId?: string;
}

/**
 * AnalyticsHandler - 教师端统计分析 API
 * GET /ai-helper/analytics?dimension=class|problem|student&startDate=...&endDate=...
 */
export class AnalyticsHandler extends Handler {
  async get() {
    try {
      // 区分 HTML 页面访问与 JSON API 请求
      const accept = this.request.headers.accept || '';
      const preferJson = accept.includes('application/json');

      // 读取查询参数
      const { dimension, startDate, endDate, classId, problemId } = this.request.query as {
        dimension?: string;
        startDate?: string;
        endDate?: string;
        classId?: string;
        problemId?: string;
      };

      // 浏览器直接访问页面时（无 dimension 参数且未声明 JSON），返回模板而不是报错
      if (!dimension && !preferJson) {
        this.response.template = 'ai-helper/analytics.html';
        this.response.body = {};
        return;
      }

      // 验证 dimension 参数
      if (!dimension || !['class', 'problem', 'student'].includes(dimension)) {
        this.response.status = 400;
        this.response.body = {
          error: {
            code: 'INVALID_DIMENSION',
            message: 'dimension 参数必须为 class / problem / student 之一',
          },
        };
        this.response.type = 'application/json';
        return;
      }

      // 解析筛选条件
      const filters: AnalyticsFilters = {};

      if (startDate) {
        try {
          filters.startDate = new Date(startDate);
        } catch (err) {
          console.error('[AnalyticsHandler] Invalid startDate:', startDate);
        }
      }

      if (endDate) {
        try {
          filters.endDate = new Date(endDate);
        } catch (err) {
          console.error('[AnalyticsHandler] Invalid endDate:', endDate);
        }
      }

      if (classId) {
        filters.classId = String(classId);
      }

      if (problemId) {
        filters.problemId = String(problemId);
      }

      // 根据维度分发到不同聚合方法
      let result;
      if (dimension === 'class') {
        result = await this.aggregateByClass(filters);
      } else if (dimension === 'problem') {
        result = await this.aggregateByProblem(filters);
      } else if (dimension === 'student') {
        result = await this.aggregateByStudent(filters);
      }

      this.response.body = result;
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[AI Helper] AnalyticsHandler error:', err);
      this.response.status = 500;
      this.response.body = {
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : '服务器内部错误',
        },
      };
      this.response.type = 'application/json';
    }
  }

  /**
   * 按班级维度聚合统计
   */
  private async aggregateByClass(filters: AnalyticsFilters) {
    const db = this.ctx.db;
    const col = db.collection('ai_conversations');

    // 构造 match 条件
    const match: any = {};

    if (filters.startDate || filters.endDate) {
      match.startTime = {};
      if (filters.startDate) match.startTime.$gte = filters.startDate;
      if (filters.endDate) match.startTime.$lte = filters.endDate;
    }

    if (filters.classId) {
      match.classId = filters.classId;
    }

    if (filters.problemId) {
      match.problemId = filters.problemId;
    }

    const pipeline: any[] = [];

    // 1. Match 阶段
    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    // 2. 以 classId + userId 做中间分组，用于统计 studentCount
    pipeline.push({
      $group: {
        _id: { classId: '$classId', userId: '$userId' },
        conversations: { $sum: 1 },
        effectiveConversations: {
          $sum: { $cond: ['$isEffective', 1, 0] },
        },
      },
    });

    // 3. 再按 classId 分组，汇总
    pipeline.push({
      $group: {
        _id: '$_id.classId',
        totalConversations: { $sum: '$conversations' },
        effectiveConversations: { $sum: '$effectiveConversations' },
        studentCount: { $sum: 1 }, // 每个 (classId, userId) 对应一名学生
      },
    });

    // 4. 计算派生字段
    pipeline.push({
      $project: {
        _id: 0,
        key: '$_id',
        totalConversations: 1,
        effectiveConversations: 1,
        studentCount: 1,
        avgConversationsPerStudent: {
          $cond: [
            { $gt: ['$studentCount', 0] },
            { $divide: ['$totalConversations', '$studentCount'] },
            0,
          ],
        },
        effectiveRatio: {
          $cond: [
            { $gt: ['$totalConversations', 0] },
            { $divide: ['$effectiveConversations', '$totalConversations'] },
            0,
          ],
        },
      },
    });

    const items = await col.aggregate(pipeline).toArray();

    return { dimension: 'class', items };
  }

  /**
   * 按题目维度聚合统计
   */
  private async aggregateByProblem(filters: AnalyticsFilters) {
    const db = this.ctx.db;
    const col = db.collection('ai_conversations');

    // 构造 match 条件
    const match: any = {};

    if (filters.startDate || filters.endDate) {
      match.startTime = {};
      if (filters.startDate) match.startTime.$gte = filters.startDate;
      if (filters.endDate) match.startTime.$lte = filters.endDate;
    }

    if (filters.classId) {
      match.classId = filters.classId;
    }

    if (filters.problemId) {
      match.problemId = filters.problemId;
    }

    const pipeline: any[] = [];

    // 1. Match 阶段
    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    // 2. 按 problemId + userId 汇总，用于 studentCount
    pipeline.push({
      $group: {
        _id: { problemId: '$problemId', userId: '$userId' },
        conversations: { $sum: 1 },
        totalMessageCount: { $sum: '$messageCount' },
        effectiveConversations: {
          $sum: { $cond: ['$isEffective', 1, 0] },
        },
      },
    });

    // 3. 再按 problemId 汇总
    pipeline.push({
      $group: {
        _id: '$_id.problemId',
        totalConversations: { $sum: '$conversations' },
        effectiveConversations: { $sum: '$effectiveConversations' },
        studentCount: { $sum: 1 },
        totalMessageCount: { $sum: '$totalMessageCount' },
      },
    });

    // 4. 派生字段
    pipeline.push({
      $project: {
        _id: 0,
        key: '$_id',
        totalConversations: 1,
        effectiveConversations: 1,
        studentCount: 1,
        avgMessageCount: {
          $cond: [
            { $gt: ['$totalConversations', 0] },
            { $divide: ['$totalMessageCount', '$totalConversations'] },
            0,
          ],
        },
        effectiveRatio: {
          $cond: [
            { $gt: ['$totalConversations', 0] },
            { $divide: ['$effectiveConversations', '$totalConversations'] },
            0,
          ],
        },
      },
    });

    const items = await col.aggregate(pipeline).toArray();

    return { dimension: 'problem', items };
  }

  /**
   * 按学生维度聚合统计
   */
  private async aggregateByStudent(filters: AnalyticsFilters) {
    const db = this.ctx.db;
    const col = db.collection('ai_conversations');

    // 构造 match 条件
    const match: any = {};

    if (filters.startDate || filters.endDate) {
      match.startTime = {};
      if (filters.startDate) match.startTime.$gte = filters.startDate;
      if (filters.endDate) match.startTime.$lte = filters.endDate;
    }

    if (filters.classId) {
      match.classId = filters.classId;
    }

    if (filters.problemId) {
      match.problemId = filters.problemId;
    }

    const pipeline: any[] = [];

    // 1. Match 阶段
    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    // 2. 按 userId 分组
    pipeline.push({
      $group: {
        _id: '$userId',
        totalConversations: { $sum: 1 },
        effectiveConversations: {
          $sum: { $cond: ['$isEffective', 1, 0] },
        },
        totalMessageCount: { $sum: '$messageCount' },
        lastUsedAt: { $max: '$endTime' },
      },
    });

    // 3. 派生字段
    pipeline.push({
      $project: {
        _id: 0,
        key: '$_id',
        totalConversations: 1,
        effectiveConversations: 1,
        lastUsedAt: 1,
        avgMessageCount: {
          $cond: [
            { $gt: ['$totalConversations', 0] },
            { $divide: ['$totalMessageCount', '$totalConversations'] },
            0,
          ],
        },
        effectiveRatio: {
          $cond: [
            { $gt: ['$totalConversations', 0] },
            { $divide: ['$effectiveConversations', '$totalConversations'] },
            0,
          ],
        },
      },
    });

    const items = await col.aggregate(pipeline).toArray();

    return { dimension: 'student', items };
  }
}

// 导出路由权限配置（使用与对话列表相同的权限）
export const AnalyticsHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
