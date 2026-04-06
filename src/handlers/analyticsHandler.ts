/**
 * AI 使用统计分析 Handler
 * 处理统计分析 API 请求,支持按班级/题目/学生维度聚合数据
 */

import { Handler, PRIV, db } from 'hydrooj';
import type { Document } from 'mongodb';
import { getDomainId } from '../utils/domainHelper';
import { parseProblemId } from '../utils/problemIdHelper';
import type { ProblemDocument, UserDocument } from '../types/hydrooj';
import { applyRateLimit } from '../lib/rateLimitHelper';

/**
 * 统计项接口（包含可选的 displayName）
 */
interface AnalyticsItem {
  key: string | number;
  displayName?: string;
  totalConversations: number;
  effectiveConversations: number;
  effectiveRatio: number;
  studentCount?: number;
  avgConversationsPerStudent?: number;
  avgMessageCount?: number;
  lastUsedAt?: Date;
  // 问题类型统计（扁平化，便于前端排序）
  understand?: number;
  think?: number;
  debug?: number;
  clarify?: number;
  optimize?: number;
}

/**
 * T026: 批量获取题目标题映射
 * @param domainId 域 ID
 * @param problemIds 题目 ID 数组（字符串格式，如 "P1000"）
 * @returns problemId -> title 映射表
 */
async function _getProblemTitleMap(domainId: string, problemIds: string[], problemFallbackPrefix: string): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(problemIds)];
  const titleMap = new Map<string, string>();

  if (uniqueIds.length === 0) {
    return titleMap;
  }

  try {
    const problemColl = db.collection('document');

    const docIds: number[] = [];
    for (const pid of uniqueIds) {
      const numericId = parseProblemId(pid);
      if (numericId !== null) {
        docIds.push(numericId);
      }
    }

    const problems = await problemColl.find({
      domainId,
      docType: 10,
      docId: { $in: docIds }
    }).project({ docId: 1, title: 1 }).toArray();

    for (const prob of problems) {
      const p = prob as ProblemDocument;
      const docId = p.docId;
      const title = p.title || `${problemFallbackPrefix} ${docId}`;
      titleMap.set(String(docId), title);
      titleMap.set(`P${docId}`, title);
    }

    for (const pid of uniqueIds) {
      if (!titleMap.has(pid)) {
        titleMap.set(pid, `${problemFallbackPrefix} ${pid}`);
      }
    }
  } catch (err) {
    console.error('[AI Helper] Failed to fetch problem titles:', err);
    for (const pid of uniqueIds) {
      titleMap.set(pid, `${problemFallbackPrefix} ${pid}`);
    }
  }

  return titleMap;
}

/**
 * T027: 批量获取用户名映射
 * @param userIds 用户 ID 数组（数字格式）
 * @returns userId -> uname 映射表
 */
async function getUserNameMap(userIds: number[], deletedUserFallback: string): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(userIds)];
  const nameMap = new Map<number, string>();

  if (uniqueIds.length === 0) {
    return nameMap;
  }

  try {
    const userColl = db.collection('user');
    const users = await userColl.find({ _id: { $in: uniqueIds } }).toArray();

    for (const user of users) {
      const u = user as UserDocument;
      nameMap.set(u._id, u.uname || deletedUserFallback);
    }

    for (const uid of uniqueIds) {
      if (!nameMap.has(uid)) {
        nameMap.set(uid, deletedUserFallback);
      }
    }
  } catch (err) {
    console.error('[AI Helper] Failed to fetch user names:', err);
    for (const uid of uniqueIds) {
      nameMap.set(uid, deletedUserFallback);
    }
  }

  return nameMap;
}

/**
 * 筛选条件接口
 */
interface AnalyticsFilters {
  domainId?: string;  // 域 ID（用于域隔离）
  startDate?: Date;
  endDate?: Date;
  classId?: string;
  problemId?: string;
}

/**
 * AnalyticsHandler - 教师端统计分析 API
 * GET /ai-helper/analytics?dimension=class|problem|student&startDate=...&endDate=...
 * GET /d/:domainId/ai-helper/analytics?dimension=class|problem|student&startDate=...&endDate=...
 */
export class AnalyticsHandler extends Handler {
  async get() {
    try {
      // 限流：10 次/60秒，fail-open（只读端点）
      if (await applyRateLimit(this, {
        op: 'ai_analytics', periodSecs: 60, maxOps: 10,
        failOpen: true,
        errorMessage: 'ai_helper_analytics_rate_limited',
      })) return;

      // 获取当前域 ID（用于域隔离）
      const domainId = getDomainId(this);

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
            message: this.translate('ai_helper_analytics_invalid_dimension'),
          },
        };
        this.response.type = 'application/json';
        return;
      }

      // 解析筛选条件（始终包含 domainId 以实现域隔离）
      const filters: AnalyticsFilters = {
        domainId  // 域隔离：只统计当前域的数据
      };

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
          message: err instanceof Error ? err.message : this.translate('ai_helper_err_internal'),
        },
      };
      this.response.type = 'application/json';
    }
  }

  /**
   * 按班级维度聚合统计
   * @param filters 筛选条件
   * @returns 按班级聚合的统计数据
   */
  private static metricsAddFieldsStage(): Document {
    return {
      $addFields: {
        _hasMetrics: { $eq: ['$metrics.v', 1] },
        _hasSubmissionContext: { $and: [
          { $eq: ['$metrics.v', 1] },
          { $ne: ['$metrics.backfilledAt', null] },
          { $ne: ['$metrics.submissionsAfter', null] },
        ] },
      },
    };
  }

  private async aggregateByClass(filters: AnalyticsFilters) {
    const db = this.ctx.db;
    const col = db.collection('ai_conversations');

    // 构造 match 条件（始终包含 domainId 以实现域隔离）
    const match: Document = {};

    // 域隔离：只统计当前域的数据
    if (filters.domainId) {
      match.domainId = filters.domainId;
    }

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

    const pipeline: Document[] = [];

    // 1. Match 阶段
    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    // 2. 以 classId + userId 做中间分组,用于统计 studentCount
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
   * @param filters 筛选条件
   * @returns 按题目聚合的统计数据
   */
  private async aggregateByProblem(filters: AnalyticsFilters) {
    const db = this.ctx.db;
    const col = db.collection('ai_conversations');

    // 构造 match 条件（始终包含 domainId 以实现域隔离）
    const match: Document = {};

    // 域隔离：只统计当前域的数据
    if (filters.domainId) {
      match.domainId = filters.domainId;
    }

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

    const pipeline: Document[] = [];

    // 1. Match 阶段
    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    // 2a. 添加分层 metrics 标志
    pipeline.push(AnalyticsHandler.metricsAddFieldsStage());

    // 2b. Lookup ai_messages - 使用 pipeline 模式 + 条件求和统计问题类型
    pipeline.push({
      $lookup: {
        from: 'ai_messages',
        let: { cid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$conversationId', '$$cid'] } } },
          {
            $match: {
              role: 'student',
              questionType: { $in: ['understand', 'think', 'debug', 'clarify', 'optimize'] }
            }
          },
          {
            $group: {
              _id: null,
              understand: { $sum: { $cond: [{ $eq: ['$questionType', 'understand'] }, 1, 0] } },
              think: { $sum: { $cond: [{ $eq: ['$questionType', 'think'] }, 1, 0] } },
              debug: { $sum: { $cond: [{ $eq: ['$questionType', 'debug'] }, 1, 0] } },
              clarify: { $sum: { $cond: [{ $eq: ['$questionType', 'clarify'] }, 1, 0] } },
              optimize: { $sum: { $cond: [{ $eq: ['$questionType', 'optimize'] }, 1, 0] } }
            }
          }
        ],
        as: 'qt'
      }
    });

    // 3. 按 problemId + userId 汇总,用于 studentCount
    // 同时保留 metadata.problemTitle，使用 $first 提取 qt 数组首项
    pipeline.push({
      $group: {
        _id: { problemId: '$problemId', userId: '$userId' },
        conversations: { $sum: 1 },
        totalMessageCount: { $sum: '$messageCount' },
        effectiveConversations: {
          $sum: { $cond: ['$isEffective', 1, 0] },
        },
        problemTitle: { $first: '$metadata.problemTitle' },
        qt_understand: { $sum: { $ifNull: [{ $first: '$qt.understand' }, 0] } },
        qt_think: { $sum: { $ifNull: [{ $first: '$qt.think' }, 0] } },
        qt_debug: { $sum: { $ifNull: [{ $first: '$qt.debug' }, 0] } },
        qt_clarify: { $sum: { $ifNull: [{ $first: '$qt.clarify' }, 0] } },
        qt_optimize: { $sum: { $ifNull: [{ $first: '$qt.optimize' }, 0] } },
        // metrics 分层聚合
        metricsConvCount: { $sum: { $cond: ['$_hasMetrics', 1, 0] } },
        totalStudentMessages: { $sum: { $cond: ['$_hasMetrics', '$metrics.studentMessageCount', 0] } },
        submissionContextCount: { $sum: { $cond: ['$_hasSubmissionContext', 1, 0] } },
        totalSubmissions: { $sum: { $cond: ['$_hasSubmissionContext', '$metrics.submissionsAfter', 0] } },
        acCount: { $sum: { $cond: [
          { $and: ['$_hasSubmissionContext', { $ne: ['$metrics.firstAcceptedIndex', null] }] },
          1, 0,
        ] } },
      },
    });

    // 4. 再按 problemId 汇总
    pipeline.push({
      $group: {
        _id: '$_id.problemId',
        totalConversations: { $sum: '$conversations' },
        effectiveConversations: { $sum: '$effectiveConversations' },
        studentCount: { $sum: 1 },
        totalMessageCount: { $sum: '$totalMessageCount' },
        problemTitle: { $first: '$problemTitle' },
        understand: { $sum: '$qt_understand' },
        think: { $sum: '$qt_think' },
        debug: { $sum: '$qt_debug' },
        clarify: { $sum: '$qt_clarify' },
        optimize: { $sum: '$qt_optimize' },
        metricsConvCount: { $sum: '$metricsConvCount' },
        totalStudentMessages: { $sum: '$totalStudentMessages' },
        submissionContextCount: { $sum: '$submissionContextCount' },
        totalSubmissions: { $sum: '$totalSubmissions' },
        acCount: { $sum: '$acCount' },
      },
    });

    // 5. 派生字段（扁平化输出问题类型统计 + metrics 聚合）
    pipeline.push({
      $project: {
        _id: 0,
        key: '$_id',
        displayName: {
          $ifNull: ['$problemTitle', { $concat: [this.translate('ai_helper_problem_fallback_prefix'), ' ', { $toString: '$_id' }] }]
        },
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
        understand: 1,
        think: 1,
        debug: 1,
        clarify: 1,
        optimize: 1,
        avgStudentMessages: {
          $cond: [{ $gt: ['$metricsConvCount', 0] },
            { $round: [{ $divide: ['$totalStudentMessages', '$metricsConvCount'] }, 1] },
            null],
        },
        avgSubmissionsAfter: {
          $cond: [{ $gt: ['$submissionContextCount', 0] },
            { $round: [{ $divide: ['$totalSubmissions', '$submissionContextCount'] }, 1] },
            null],
        },
        acRate: {
          $cond: [{ $gt: ['$submissionContextCount', 0] },
            { $round: [{ $divide: ['$acCount', '$submissionContextCount'] }, 4] },
            null],
        },
      },
    });

    const items = await col.aggregate(pipeline).toArray();

    return { dimension: 'problem', items };
  }

  /**
   * 按学生维度聚合统计
   * @param filters 筛选条件
   * @returns 按学生聚合的统计数据
   */
  private async aggregateByStudent(filters: AnalyticsFilters) {
    const db = this.ctx.db;
    const col = db.collection('ai_conversations');

    // 构造 match 条件（始终包含 domainId 以实现域隔离）
    const match: Document = {};

    // 域隔离：只统计当前域的数据
    if (filters.domainId) {
      match.domainId = filters.domainId;
    }

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

    const pipeline: Document[] = [];

    // 1. Match 阶段
    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    // 2a. 分层 metrics 标志
    pipeline.push(AnalyticsHandler.metricsAddFieldsStage());

    // 2b. 按 userId 分组
    pipeline.push({
      $group: {
        _id: '$userId',
        totalConversations: { $sum: 1 },
        effectiveConversations: {
          $sum: { $cond: ['$isEffective', 1, 0] },
        },
        totalMessageCount: { $sum: '$messageCount' },
        lastUsedAt: { $max: '$endTime' },
        metricsConvCount: { $sum: { $cond: ['$_hasMetrics', 1, 0] } },
        totalStudentMessages: { $sum: { $cond: ['$_hasMetrics', '$metrics.studentMessageCount', 0] } },
        submissionContextCount: { $sum: { $cond: ['$_hasSubmissionContext', 1, 0] } },
        acCount: { $sum: { $cond: [
          { $and: ['$_hasSubmissionContext', { $ne: ['$metrics.firstAcceptedIndex', null] }] },
          1, 0,
        ] } },
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
        avgStudentMessages: {
          $cond: [{ $gt: ['$metricsConvCount', 0] },
            { $round: [{ $divide: ['$totalStudentMessages', '$metricsConvCount'] }, 1] },
            null],
        },
        acRate: {
          $cond: [{ $gt: ['$submissionContextCount', 0] },
            { $round: [{ $divide: ['$acCount', '$submissionContextCount'] }, 4] },
            null],
        },
      },
    });

    const items = await col.aggregate(pipeline).toArray();

    // T028: 获取用户名并添加 displayName
    const userIds = items.map(item => Number(item.key)).filter(id => !isNaN(id));
    const nameMap = await getUserNameMap(userIds, this.translate('ai_helper_teacher_deleted_user'));

    const enrichedItems: AnalyticsItem[] = items.map(item => {
      const key = Number(item.key);
      const name = nameMap.get(key);
      return {
        ...item,
        displayName: name ? `${name} (${key})` : String(key)
      };
    });

    return { dimension: 'student', items: enrichedItems };
  }
}

// 导出路由权限配置（使用与对话列表相同的权限）
export const AnalyticsHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
