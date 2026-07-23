/**
 * JailbreakLog Model - 越狱尝试记录
 */

import type { Collection, Db, Filter } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';
import type {
  SafetyAction,
  SafetyConfidence,
  SafetyDetectionSource,
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
      createdAt: { $gte: since },
    });
  }

  async findActiveCooldown(
    domainId: string,
    userId: number,
    now: Date = new Date()
  ): Promise<JailbreakLog | null> {
    return this.collection.findOne(
      { domainId, userId, blockedUntil: { $gt: now } },
      { sort: { blockedUntil: -1 } }
    );
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
    domainId?: string
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
}
