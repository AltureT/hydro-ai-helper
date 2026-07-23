/**
 * JailbreakLog Model - 越狱尝试记录
 */

import type { Collection, Db, Filter, UpdateFilter } from 'mongodb';
import { ObjectId, type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';
import type {
  SafetyAction,
  SafetyConfidence,
  SafetyDetectionSource,
  SafetyReviewStatus,
  SafetyViolationCategory,
} from '../types/safety';
import { SAFETY_PENALTY_WINDOW_MS } from '../services/safetyPenaltyService';

type SafetyPenaltyGroup = 'answer_seeking' | 'high_risk';

interface SafetyPenaltyCounter {
  _id: string;
  domainId: string;
  userId: number;
  group: SafetyPenaltyGroup;
  events: Array<{ id: string; at: Date }>;
  count: number;
  expiresAt: Date;
}

export interface SafetyPenaltySequence {
  counterId: string;
  eventId: string;
  currentCount: number;
}

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
  studentAppealedAt?: Date;
  studentAppealReason?: string;
  penaltyCounterId?: string;
  penaltyEventId?: string;
  expiresAt?: Date;
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
  penaltyCounterId?: string;
  penaltyEventId?: string;
}

export interface JailbreakLogListFilters {
  reviewStatus?: SafetyReviewStatus;
  category?: SafetyViolationCategory;
  appealedOnly?: boolean;
  userId?: number;
  problemId?: string;
  actionTaken?: SafetyAction;
  detectionSource?: SafetyDetectionSource;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface JailbreakReviewSummary {
  total: number;
  pending: number;
  confirmed: number;
  falsePositive: number;
  reviewed: number;
  falsePositiveRate: number;
  appealedPending: number;
}

export interface JailbreakRuleMetric {
  matchedPattern: string;
  category?: SafetyViolationCategory;
  total: number;
  pending: number;
  confirmed: number;
  falsePositive: number;
  reviewed: number;
  falsePositiveRate: number;
}

export interface JailbreakDailyMetric {
  date: string;
  total: number;
  cooldown: number;
  appealed: number;
  falsePositive: number;
}

export interface JailbreakOperationalMetrics {
  windowDays: number;
  total: number;
  cooldown: number;
  appealed: number;
  pendingAppeals: number;
  reviewed: number;
  averageReviewMinutes: number | null;
  averageAppealReviewMinutes: number | null;
  dailyTrend: JailbreakDailyMetric[];
}

export interface JailbreakLogExportResult {
  logs: JailbreakLog[];
  total: number;
  truncated: boolean;
}

export interface JailbreakBulkReviewResult {
  matchedCount: number;
  modifiedCount: number;
}

export const DEFAULT_JAILBREAK_LOG_RETENTION_DAYS = 180;
const MIN_JAILBREAK_LOG_RETENTION_DAYS = 7;
const MAX_JAILBREAK_LOG_RETENTION_DAYS = 3650;
const MAX_STORED_MATCHED_TEXT_LENGTH = 256;

export function resolveJailbreakLogRetentionDays(
  raw: string | undefined = process.env.AI_HELPER_JAILBREAK_LOG_RETENTION_DAYS
): number {
  if (!raw?.trim()) return DEFAULT_JAILBREAK_LOG_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_JAILBREAK_LOG_RETENTION_DAYS;
  return Math.min(
    MAX_JAILBREAK_LOG_RETENTION_DAYS,
    Math.max(MIN_JAILBREAK_LOG_RETENTION_DAYS, Math.floor(parsed))
  );
}

export function sanitizeSafetyLogSnippet(value: string): string {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone]')
    .replace(/\b\d{14,17}[0-9Xx]\b/g, '[id]')
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[secret]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [secret]')
    .slice(0, MAX_STORED_MATCHED_TEXT_LENGTH);
}

export class JailbreakLogModel {
  private collection: Collection<JailbreakLog>;
  private penaltyCounterCollection: Collection<SafetyPenaltyCounter>;
  private retentionDays: number;

  constructor(db: Db, retentionDays: number = resolveJailbreakLogRetentionDays()) {
    this.collection = db.collection<JailbreakLog>('ai_jailbreak_logs');
    this.penaltyCounterCollection = db.collection<SafetyPenaltyCounter>('ai_safety_penalty_counters');
    this.retentionDays = retentionDays;
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt' });
    await this.collection.createIndex(
      { domainId: 1, userId: 1, createdAt: -1 },
      { name: 'idx_domain_user_createdAt' }
    );
    await this.collection.createIndex(
      { domainId: 1, createdAt: -1 },
      { name: 'idx_domain_createdAt' }
    );
    await this.penaltyCounterCollection.createIndex(
      { expiresAt: 1 },
      { name: 'idx_safety_penalty_counter_ttl', expireAfterSeconds: 0 }
    );
    await this.collection.createIndex(
      { domainId: 1, userId: 1, blockedUntil: -1 },
      { name: 'idx_domain_user_blockedUntil' }
    );
    await this.collection.createIndex(
      { domainId: 1, reviewStatus: 1, category: 1, createdAt: -1 },
      { name: 'idx_domain_review_category_createdAt' }
    );
    await this.collection.createIndex(
      { domainId: 1, studentAppealedAt: -1, createdAt: -1 },
      { name: 'idx_domain_appealed_createdAt' }
    );
    await this.collection.createIndex(
      { domainId: 1, problemId: 1, createdAt: -1 },
      { name: 'idx_domain_problem_createdAt' }
    );
    await this.collection.createIndex(
      { expiresAt: 1 },
      { name: 'idx_expiresAt_ttl', expireAfterSeconds: 0 }
    );
    console.log('[JailbreakLogModel] Indexes ensured');
  }

  async create(data: JailbreakLogCreateInput): Promise<ObjectIdType> {
    const createdAt = data.createdAt ?? new Date();
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
      matchedText: sanitizeSafetyLogSnippet(data.matchedText),
      category: data.category,
      confidence: data.confidence,
      riskScore: data.riskScore,
      detectionSource: data.detectionSource,
      actionTaken: data.actionTaken,
      blockedUntil: data.blockedUntil,
      reviewStatus: 'pending',
      penaltyCounterId: data.penaltyCounterId,
      penaltyEventId: data.penaltyEventId,
      expiresAt: this.getExpiryDate(createdAt),
      createdAt
    };

    const result = await this.collection.insertOne(insertDoc as JailbreakLog);
    return result.insertedId;
  }

  async nextPenaltySequence(
    domainId: string,
    userId: number,
    category: SafetyViolationCategory,
    now: Date = new Date()
  ): Promise<SafetyPenaltySequence> {
    const group: SafetyPenaltyGroup = category === 'answer_seeking' ? 'answer_seeking' : 'high_risk';
    const counterId = [encodeURIComponent(domainId), userId, group].join(':');
    const eventId = new ObjectId().toHexString();
    const since = new Date(now.getTime() - SAFETY_PENALTY_WINDOW_MS);
    const expiresAt = new Date(now.getTime() + SAFETY_PENALTY_WINDOW_MS * 2);
    const rawResult = await this.penaltyCounterCollection.findOneAndUpdate(
      { _id: counterId },
      [
        {
          $set: {
            domainId,
            userId,
            group,
            expiresAt,
            events: {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ['$events', []] },
                    as: 'event',
                    cond: { $gte: ['$$event.at', since] },
                  },
                },
                [{ id: eventId, at: now }],
              ],
            },
          },
        },
        { $set: { count: { $size: '$events' } } },
      ],
      { upsert: true, returnDocument: 'after' }
    );
    const counter = rawResult && 'value' in rawResult
      ? rawResult.value as SafetyPenaltyCounter | null
      : rawResult as SafetyPenaltyCounter | null;
    if (!counter || typeof counter.count !== 'number') {
      throw new Error('Failed to atomically increment safety penalty counter');
    }
    return { counterId, eventId, currentCount: counter.count };
  }

  async rollbackPenaltySequence(counterId: string, eventIds: string | string[]): Promise<void> {
    const normalizedEventIds = Array.isArray(eventIds) ? eventIds : [eventIds];
    await this.penaltyCounterCollection.updateOne(
      { _id: counterId },
      [
        {
          $set: {
            events: {
              $filter: {
                input: { $ifNull: ['$events', []] },
                as: 'event',
                cond: { $not: [{ $in: ['$$event.id', normalizedEventIds] }] },
              },
            },
          },
        },
        { $set: { count: { $size: '$events' } } },
      ]
    );
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

    const rawResult = await this.collection.findOneAndUpdate(
      {
        _id: ensureObjectId(id),
        domainId,
        $or: [
          { reviewStatus: 'pending' },
          { reviewStatus: { $exists: false } },
        ],
      },
      update,
      { returnDocument: 'before' }
    );
    const previous = rawResult && 'value' in rawResult
      ? rawResult.value as JailbreakLog | null
      : rawResult as JailbreakLog | null;
    if (!previous) return false;
    if (reviewStatus === 'false_positive' && previous.penaltyCounterId && previous.penaltyEventId) {
      await this.rollbackPenaltySequence(previous.penaltyCounterId, previous.penaltyEventId);
    }
    return true;
  }

  async reviewMany(
    ids: Array<string | ObjectIdType>,
    domainId: string,
    reviewStatus: Exclude<SafetyReviewStatus, 'pending'>,
    reviewedBy: number,
    reviewedAt: Date = new Date()
  ): Promise<JailbreakBulkReviewResult> {
    if (ids.length === 0) return { matchedCount: 0, modifiedCount: 0 };
    const results = await Promise.all(
      ids.map((id) => this.review(id, domainId, reviewStatus, reviewedBy, reviewedAt))
    );
    const matchedCount = results.filter(Boolean).length;
    return { matchedCount, modifiedCount: matchedCount };
  }

  async appealByStudent(
    id: string | ObjectIdType,
    domainId: string,
    userId: number,
    reason?: string,
    appealedAt: Date = new Date()
  ): Promise<'submitted' | 'already_submitted' | 'unavailable'> {
    const pendingReviewFilter = {
      $or: [
        { reviewStatus: 'pending' as const },
        { reviewStatus: { $exists: false } },
      ],
    };
    const result = await this.collection.updateOne(
      {
        _id: ensureObjectId(id),
        domainId,
        userId,
        ...pendingReviewFilter,
        studentAppealedAt: { $exists: false },
      },
      {
        $set: {
          studentAppealedAt: appealedAt,
          ...(reason?.trim() ? { studentAppealReason: sanitizeSafetyLogSnippet(reason.trim()) } : {}),
        },
      }
    );
    if (result.matchedCount > 0) return 'submitted';

    const existingAppeal = await this.collection.findOne({
      _id: ensureObjectId(id),
      domainId,
      userId,
      ...pendingReviewFilter,
      studentAppealedAt: { $exists: true },
    });
    return existingAppeal ? 'already_submitted' : 'unavailable';
  }

  async backfillExpiry(now: Date = new Date()): Promise<number> {
    const result = await this.collection.updateMany(
      { expiresAt: { $exists: false } },
      { $set: { expiresAt: this.getExpiryDate(now) } }
    );
    return result.modifiedCount;
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
    const filter = this.buildListFilter(domainId, filters);

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

  async listForExport(
    domainId: string,
    filters: JailbreakLogListFilters = {},
    limit: number = 5000
  ): Promise<JailbreakLogExportResult> {
    const safeLimit = Math.min(5000, Math.max(1, Math.floor(limit)));
    const filter = this.buildListFilter(domainId, filters);
    const [logs, total] = await Promise.all([
      this.collection
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .toArray(),
      this.collection.countDocuments(filter),
    ]);
    return { logs, total, truncated: total > logs.length };
  }

  async getReviewSummary(domainId?: string): Promise<JailbreakReviewSummary> {
    const baseFilter: Filter<JailbreakLog> = domainId ? { domainId } : {};
    const [total, pending, confirmed, falsePositive, appealedPending] = await Promise.all([
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
      this.collection.countDocuments({
        ...baseFilter,
        studentAppealedAt: { $exists: true },
        $or: [
          { reviewStatus: 'pending' },
          { reviewStatus: { $exists: false } },
        ],
      }),
    ]);
    const reviewed = confirmed + falsePositive;
    const falsePositiveRate = reviewed > 0
      ? Math.round((falsePositive / reviewed) * 1000) / 10
      : 0;

    return { total, pending, confirmed, falsePositive, reviewed, falsePositiveRate, appealedPending };
  }

  async getRuleMetrics(domainId: string, limit: number = 20): Promise<JailbreakRuleMetric[]> {
    const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const rows = await this.collection.aggregate<{
      _id: { matchedPattern: string; category?: SafetyViolationCategory };
      total: number;
      pending: number;
      confirmed: number;
      falsePositive: number;
    }>([
      { $match: { domainId } },
      {
        $group: {
          _id: { matchedPattern: '$matchedPattern', category: '$category' },
          total: { $sum: 1 },
          pending: {
            $sum: {
              $cond: [
                { $eq: [{ $ifNull: ['$reviewStatus', 'pending'] }, 'pending'] },
                1,
                0,
              ],
            },
          },
          confirmed: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'confirmed'] }, 1, 0] } },
          falsePositive: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'false_positive'] }, 1, 0] } },
        },
      },
      { $sort: { falsePositive: -1, total: -1 } },
      { $limit: safeLimit },
    ]).toArray();

    return rows.map((row) => {
      const reviewed = row.confirmed + row.falsePositive;
      return {
        matchedPattern: row._id.matchedPattern,
        category: row._id.category,
        total: row.total,
        pending: row.pending,
        confirmed: row.confirmed,
        falsePositive: row.falsePositive,
        reviewed,
        falsePositiveRate: reviewed > 0
          ? Math.round((row.falsePositive / reviewed) * 1000) / 10
          : 0,
      };
    });
  }

  async getOperationalMetrics(
    domainId: string,
    windowDays: number = 14,
    now: Date = new Date()
  ): Promise<JailbreakOperationalMetrics> {
    const safeWindowDays = Math.min(90, Math.max(1, Math.floor(windowDays)));
    const since = new Date(now.getTime() - safeWindowDays * 24 * 60 * 60 * 1000);
    const rows = await this.collection.aggregate<{
      summary: Array<{
        total: number;
        cooldown: number;
        appealed: number;
        pendingAppeals: number;
        reviewed: number;
        averageReviewMs: number | null;
        averageAppealReviewMs: number | null;
      }>;
      dailyTrend: JailbreakDailyMetric[];
    }>([
      { $match: { domainId, createdAt: { $gte: since, $lte: now } } },
      {
        $facet: {
          summary: [{
            $group: {
              _id: null,
              total: { $sum: 1 },
              cooldown: {
                $sum: { $cond: [{ $in: ['$actionTaken', ['cooldown_60s', 'cooldown_5m']] }, 1, 0] },
              },
              appealed: {
                $sum: { $cond: [{ $ne: [{ $ifNull: ['$studentAppealedAt', null] }, null] }, 1, 0] },
              },
              pendingAppeals: {
                $sum: {
                  $cond: [{
                    $and: [
                      { $ne: [{ $ifNull: ['$studentAppealedAt', null] }, null] },
                      { $eq: [{ $ifNull: ['$reviewStatus', 'pending'] }, 'pending'] },
                    ],
                  }, 1, 0],
                },
              },
              reviewed: {
                $sum: { $cond: [{ $in: ['$reviewStatus', ['confirmed', 'false_positive']] }, 1, 0] },
              },
              averageReviewMs: {
                $avg: {
                  $cond: [
                    { $in: ['$reviewStatus', ['confirmed', 'false_positive']] },
                    { $subtract: ['$reviewedAt', '$createdAt'] },
                    null,
                  ],
                },
              },
              averageAppealReviewMs: {
                $avg: {
                  $cond: [{
                    $and: [
                      { $ne: [{ $ifNull: ['$studentAppealedAt', null] }, null] },
                      { $in: ['$reviewStatus', ['confirmed', 'false_positive']] },
                    ],
                  }, { $subtract: ['$reviewedAt', '$studentAppealedAt'] }, null],
                },
              },
            },
          }],
          dailyTrend: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                total: { $sum: 1 },
                cooldown: {
                  $sum: { $cond: [{ $in: ['$actionTaken', ['cooldown_60s', 'cooldown_5m']] }, 1, 0] },
                },
                appealed: {
                  $sum: { $cond: [{ $ne: [{ $ifNull: ['$studentAppealedAt', null] }, null] }, 1, 0] },
                },
                falsePositive: {
                  $sum: { $cond: [{ $eq: ['$reviewStatus', 'false_positive'] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, date: '$_id', total: 1, cooldown: 1, appealed: 1, falsePositive: 1 } },
          ],
        },
      },
    ]).toArray();
    const result = rows[0];
    const summary = result?.summary?.[0];
    const toMinutes = (milliseconds: number | null | undefined): number | null => (
      typeof milliseconds === 'number' && Number.isFinite(milliseconds)
        ? Math.round((milliseconds / 60000) * 10) / 10
        : null
    );

    return {
      windowDays: safeWindowDays,
      total: summary?.total || 0,
      cooldown: summary?.cooldown || 0,
      appealed: summary?.appealed || 0,
      pendingAppeals: summary?.pendingAppeals || 0,
      reviewed: summary?.reviewed || 0,
      averageReviewMinutes: toMinutes(summary?.averageReviewMs),
      averageAppealReviewMinutes: toMinutes(summary?.averageAppealReviewMs),
      dailyTrend: result?.dailyTrend || [],
    };
  }

  private buildListFilter(
    domainId?: string,
    filters: JailbreakLogListFilters = {}
  ): Filter<JailbreakLog> {
    const filter: Filter<JailbreakLog> = domainId ? { domainId } : {};
    if (filters.category) filter.category = filters.category;
    if (filters.userId !== undefined) filter.userId = filters.userId;
    if (filters.problemId) filter.problemId = filters.problemId;
    if (filters.actionTaken) filter.actionTaken = filters.actionTaken;
    if (filters.detectionSource) filter.detectionSource = filters.detectionSource;
    if (filters.createdFrom || filters.createdTo) {
      filter.createdAt = {
        ...(filters.createdFrom ? { $gte: filters.createdFrom } : {}),
        ...(filters.createdTo ? { $lte: filters.createdTo } : {}),
      };
    }
    if (filters.appealedOnly) {
      filter.studentAppealedAt = { $exists: true };
      filter.$or = [
        { reviewStatus: 'pending' },
        { reviewStatus: { $exists: false } },
      ];
    } else if (filters.reviewStatus === 'pending') {
      // 旧版日志没有 reviewStatus，在管理端兼容视为待复核。
      filter.$or = [
        { reviewStatus: 'pending' },
        { reviewStatus: { $exists: false } },
      ];
    } else if (filters.reviewStatus) {
      filter.reviewStatus = filters.reviewStatus;
    }
    return filter;
  }

  private getExpiryDate(base: Date): Date {
    return new Date(base.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
  }
}
