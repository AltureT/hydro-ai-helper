/**
 * JailbreakLog Model - 越狱尝试记录
 */

import type { Collection, Db, Filter, UpdateFilter } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';
import type {
  SafetyAction,
  SafetyConfidence,
  SafetyDetectionSource,
  SafetyReviewStatus,
  SafetyViolationCategory,
} from '../types/safety';

export type JailbreakQuestionType = 'understand' | 'think' | 'debug' | 'review' | 'clarify' | 'optimize';

export interface JailbreakLog {
  _id: ObjectIdType;
  domainId?: string;
  userId?: number;
  problemId?: string;
  conversationId?: ObjectIdType;
  questionType?: JailbreakQuestionType;
  matchedPattern: string;
  matchedText: string;
  category?: SafetyViolationCategory;
  confidence?: SafetyConfidence;
  riskScore?: number;
  detectionSource?: SafetyDetectionSource;
  actionTaken?: SafetyAction;
  blockedUntil?: Date;
  reviewStatus?: SafetyReviewStatus;
  reviewedAt?: Date;
  reviewedBy?: number;
  createdAt: Date;
}

export interface JailbreakLogCreateInput {
  domainId?: string;
  userId?: number;
  problemId?: string;
  conversationId?: string | ObjectIdType;
  questionType?: JailbreakQuestionType;
  matchedPattern: string;
  matchedText: string;
  category?: SafetyViolationCategory;
  confidence?: SafetyConfidence;
  riskScore?: number;
  detectionSource?: SafetyDetectionSource;
  actionTaken?: SafetyAction;
  blockedUntil?: Date;
  createdAt?: Date;
}

export interface JailbreakLogListFilters {
  reviewStatus?: SafetyReviewStatus;
  category?: SafetyViolationCategory;
}

export interface JailbreakReviewSummary {
  total: number;
  pending: number;
  confirmed: number;
  falsePositive: number;
  reviewed: number;
  falsePositiveRate: number;
}

export class JailbreakLogModel {
  private collection: Collection<JailbreakLog>;

  constructor(db: Db) {
    this.collection = db.collection<JailbreakLog>('ai_jailbreak_logs');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt' });
    await this.collection.createIndex(
      { domainId: 1, userId: 1, createdAt: -1 },
      { name: 'idx_domain_user_createdAt' }
    );
    await this.collection.createIndex(
      { domainId: 1, userId: 1, blockedUntil: -1 },
      { name: 'idx_domain_user_blockedUntil' }
    );
    await this.collection.createIndex(
      { domainId: 1, reviewStatus: 1, category: 1, createdAt: -1 },
      { name: 'idx_domain_review_category_createdAt' }
    );
    console.log('[JailbreakLogModel] Indexes ensured');
  }

  async create(data: JailbreakLogCreateInput): Promise<ObjectIdType> {
    const insertDoc: Omit<JailbreakLog, '_id'> = {
      domainId: data.domainId,
      userId: data.userId,
      problemId: data.problemId,
      conversationId:
        data.conversationId === undefined
          ? undefined
          : ensureObjectId(data.conversationId),
      questionType: data.questionType,
      matchedPattern: data.matchedPattern,
      matchedText: data.matchedText,
      category: data.category,
      confidence: data.confidence,
      riskScore: data.riskScore,
      detectionSource: data.detectionSource,
      actionTaken: data.actionTaken,
      blockedUntil: data.blockedUntil,
      reviewStatus: 'pending',
      createdAt: data.createdAt ?? new Date()
    };

    const result = await this.collection.insertOne(insertDoc as JailbreakLog);
    return result.insertedId;
  }

  async listRecent(limit: number = 20, domainId?: string): Promise<JailbreakLog[]> {
    const filter: Filter<JailbreakLog> = domainId ? { domainId } : {};
    return this.collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async countRecentByCategories(
    domainId: string,
    userId: number,
    categories: SafetyViolationCategory[],
    since: Date
  ): Promise<number> {
    return this.collection.countDocuments({
      domainId,
      userId,
      category: { $in: categories },
      confidence: 'high',
      reviewStatus: { $ne: 'false_positive' },
      createdAt: { $gte: since },
    });
  }

  async findActiveCooldown(
    domainId: string,
    userId: number,
    now: Date = new Date()
  ): Promise<JailbreakLog | null> {
    return this.collection.findOne(
      {
        domainId,
        userId,
        blockedUntil: { $gt: now },
        reviewStatus: { $ne: 'false_positive' },
      },
      { sort: { blockedUntil: -1 } }
    );
  }

  async review(
    id: string | ObjectIdType,
    domainId: string,
    reviewStatus: Exclude<SafetyReviewStatus, 'pending'>,
    reviewedBy: number,
    reviewedAt: Date = new Date()
  ): Promise<boolean> {
    const update: UpdateFilter<JailbreakLog> = {
      $set: { reviewStatus, reviewedAt, reviewedBy },
    };
    if (reviewStatus === 'false_positive') {
      update.$unset = { blockedUntil: '' };
    }

    const result = await this.collection.updateOne(
      { _id: ensureObjectId(id), domainId },
      update
    );
    return result.matchedCount > 0;
  }

  /**
   * 分页查询越狱记录
   * @param page 页码（从1开始）
   * @param limit 每页条数（最大100）
   * @returns 分页结果
   */
  async listWithPagination(
    page: number = 1,
    limit: number = 20,
    domainId?: string,
    filters: JailbreakLogListFilters = {}
  ): Promise<{
    logs: JailbreakLog[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    // 参数边界处理
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const skip = (safePage - 1) * safeLimit;
    const filter: Filter<JailbreakLog> = domainId ? { domainId } : {};
    if (filters.category) filter.category = filters.category;
    if (filters.reviewStatus === 'pending') {
      // 旧版日志没有 reviewStatus，在管理端兼容视为待复核。
      filter.$or = [
        { reviewStatus: 'pending' },
        { reviewStatus: { $exists: false } },
      ];
    } else if (filters.reviewStatus) {
      filter.reviewStatus = filters.reviewStatus;
    }

    // 并行查询数据和总数
    const [logs, total] = await Promise.all([
      this.collection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .toArray(),
      this.collection.countDocuments(filter)
    ]);

    const totalPages = Math.ceil(total / safeLimit);

    return {
      logs,
      total,
      page: safePage,
      totalPages
    };
  }

  async getReviewSummary(domainId?: string): Promise<JailbreakReviewSummary> {
    const baseFilter: Filter<JailbreakLog> = domainId ? { domainId } : {};
    const [total, pending, confirmed, falsePositive] = await Promise.all([
      this.collection.countDocuments(baseFilter),
      this.collection.countDocuments({
        ...baseFilter,
        $or: [
          { reviewStatus: 'pending' },
          { reviewStatus: { $exists: false } },
        ],
      }),
      this.collection.countDocuments({ ...baseFilter, reviewStatus: 'confirmed' }),
      this.collection.countDocuments({ ...baseFilter, reviewStatus: 'false_positive' }),
    ]);
    const reviewed = confirmed + falsePositive;
    const falsePositiveRate = reviewed > 0
      ? Math.round((falsePositive / reviewed) * 1000) / 10
      : 0;

    return { total, pending, confirmed, falsePositive, reviewed, falsePositiveRate };
  }
}
