/**
 * JailbreakLog Model - 越狱尝试记录
 */

import type { Collection, Db, Filter, UpdateFilter } from 'mongodb';
import { ObjectId, createIndexReusingExisting, type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';
import type {
  SafetyAction,
  SafetyConfidence,
  SafetyDetectionSource,
  SafetyEvidence,
  SafetyReviewStatus,
  SafetyViolationCategory,
} from '../types/safety';
import { SAFETY_PENALTY_WINDOW_MS } from '../services/safetyPenaltyService';

type SafetyPenaltyGroup = 'answer_seeking' | 'high_risk' | 'off_topic';

/** 计数器按用户跨域（plan R12）：`${userId}:${group}`。旧的带域计数器在 20 分钟内自然过期 */
interface SafetyPenaltyCounter {
  _id: string;
  domainId?: string;
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
  /** AI 抽查（PR5）：所属批次、证据、证据是否全部通过核对、是否已自动处罚、审核模型给出的理由 */
  reviewRunId?: string;
  evidence?: SafetyEvidence[];
  evidenceVerified?: boolean;
  autoPenalized?: boolean;
  reviewReason?: string;
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
  reviewRunId?: string;
  evidence?: SafetyEvidence[];
  evidenceVerified?: boolean;
  autoPenalized?: boolean;
  reviewReason?: string;
}

/** AI 抽查证据最多保存的条数与每条片段长度（FR-060：只保存必要的短片段） */
export const MAX_REVIEW_EVIDENCE_ITEMS = 5;
export const MAX_REVIEW_EVIDENCE_SNIPPET_LENGTH = 120;
export const MAX_REVIEW_REASON_LENGTH = 300;

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
  /** 本次实际改变了复核结论的记录（用于撤销对应的信誉扣分） */
  reviewedIds: string[];
}

export const DEFAULT_JAILBREAK_LOG_RETENTION_DAYS = 180;
const MIN_JAILBREAK_LOG_RETENTION_DAYS = 7;
const MAX_JAILBREAK_LOG_RETENTION_DAYS = 3650;
const MAX_STORED_MATCHED_TEXT_LENGTH = 256;
const MAX_FILTER_SUGGESTION_QUERY_LENGTH = 64;

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

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNumericPrefixRanges(query: string): Array<{ userId: { $gte: number; $lt: number } }> {
  if (!/^\d+$/.test(query) || (query.length > 1 && query.startsWith('0'))) return [];
  const prefix = Number(query);
  if (!Number.isSafeInteger(prefix) || prefix < 0) return [];
  if (prefix === 0) return [{ userId: { $gte: 0, $lt: 1 } }];

  const ranges: Array<{ userId: { $gte: number; $lt: number } }> = [];
  for (let suffixDigits = 0; suffixDigits <= 15; suffixDigits += 1) {
    const factor = 10 ** suffixDigits;
    const lower = prefix * factor;
    const upper = (prefix + 1) * factor;
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) break;
    ranges.push({ userId: { $gte: lower, $lt: upper } });
  }
  return ranges;
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
    await createIndexReusingExisting(this.collection, { createdAt: -1 }, { name: 'idx_createdAt' });
    await createIndexReusingExisting(
      this.collection,
      { domainId: 1, userId: 1, createdAt: -1 },
      { name: 'idx_domain_user_createdAt' }
    );
    await createIndexReusingExisting(
      this.collection,
      { domainId: 1, createdAt: -1 },
      { name: 'idx_domain_createdAt' }
    );
    await createIndexReusingExisting(
      this.penaltyCounterCollection,
      { expiresAt: 1 },
      { name: 'idx_safety_penalty_counter_ttl', expireAfterSeconds: 0 }
    );
    await createIndexReusingExisting(
      this.collection,
      { domainId: 1, userId: 1, blockedUntil: -1 },
      { name: 'idx_domain_user_blockedUntil' }
    );
    // 跨域冷却与回退计数按用户查询（plan R12）
    await createIndexReusingExisting(
      this.collection,
      { userId: 1, blockedUntil: -1 },
      { name: 'idx_user_blockedUntil' }
    );
    await createIndexReusingExisting(
      this.collection,
      { userId: 1, createdAt: -1 },
      { name: 'idx_user_createdAt' }
    );
    await createIndexReusingExisting(
      this.collection,
      { domainId: 1, reviewStatus: 1, category: 1, createdAt: -1 },
      { name: 'idx_domain_review_category_createdAt' }
    );
    await createIndexReusingExisting(
      this.collection,
      { domainId: 1, studentAppealedAt: -1, createdAt: -1 },
      { name: 'idx_domain_appealed_createdAt' }
    );
    await createIndexReusingExisting(
      this.collection,
      { domainId: 1, problemId: 1, createdAt: -1 },
      { name: 'idx_domain_problem_createdAt' }
    );
    // AI 抽查：最近发现、熔断样本、处罚去重（PR5）
    await createIndexReusingExisting(
      this.collection,
      { detectionSource: 1, createdAt: -1 },
      { name: 'idx_source_createdAt' }
    );
    await createIndexReusingExisting(
      this.collection,
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
      ...(data.reviewRunId ? { reviewRunId: data.reviewRunId } : {}),
      ...(data.evidence ? {
        evidence: data.evidence.slice(0, MAX_REVIEW_EVIDENCE_ITEMS).map((item) => ({
          ref: String(item.ref).slice(0, 16),
          snippet: sanitizeSafetyLogSnippet(item.snippet).slice(0, MAX_REVIEW_EVIDENCE_SNIPPET_LENGTH),
          verified: !!item.verified,
        })),
      } : {}),
      ...(data.evidenceVerified !== undefined ? { evidenceVerified: data.evidenceVerified } : {}),
      ...(data.autoPenalized !== undefined ? { autoPenalized: data.autoPenalized } : {}),
      ...(data.reviewReason ? { reviewReason: sanitizeSafetyLogSnippet(data.reviewReason).slice(0, MAX_REVIEW_REASON_LENGTH) } : {}),
      expiresAt: this.getExpiryDate(createdAt),
      createdAt
    };

    const result = await this.collection.insertOne(insertDoc as JailbreakLog);
    return result.insertedId;
  }

  /**
   * 原子递增用户在窗口内的违规序号（跨域）。偏题使用单独的分组和更长的窗口（plan R14）。
   */
  async nextPenaltySequence(
    userId: number,
    category: SafetyViolationCategory,
    now: Date = new Date(),
    windowMs: number = SAFETY_PENALTY_WINDOW_MS
  ): Promise<SafetyPenaltySequence> {
    const group: SafetyPenaltyGroup = category === 'answer_seeking'
      ? 'answer_seeking'
      : category === 'off_topic' ? 'off_topic' : 'high_risk';
    const counterId = `${userId}:${group}`;
    const eventId = new ObjectId().toHexString();
    const since = new Date(now.getTime() - windowMs);
    const expiresAt = new Date(now.getTime() + windowMs * 2);
    const rawResult = await this.penaltyCounterCollection.findOneAndUpdate(
      { _id: counterId },
      [
        {
          $set: {
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

  /**
   * 计数器不可用时的回退计数（跨域）。不按置信度过滤：索要答案的前两次是中置信度，
   * 若只数高置信度，回退路径会漏数（plan R7）。
   */
  async countRecentByCategories(
    userId: number,
    categories: SafetyViolationCategory[],
    since: Date
  ): Promise<number> {
    return this.collection.countDocuments({
      userId,
      category: { $in: categories },
      reviewStatus: { $ne: 'false_positive' },
      createdAt: { $gte: since },
    });
  }

  /** 用户当前生效的冷却（跨域，plan R12） */
  async findActiveCooldown(
    userId: number,
    now: Date = new Date()
  ): Promise<JailbreakLog | null> {
    return this.collection.findOne(
      {
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
    if (ids.length === 0) return { matchedCount: 0, modifiedCount: 0, reviewedIds: [] };
    const results = await Promise.all(
      ids.map((id) => this.review(id, domainId, reviewStatus, reviewedBy, reviewedAt))
    );
    const reviewedIds = ids.filter((_, index) => results[index]).map((id) => String(id));
    return { matchedCount: reviewedIds.length, modifiedCount: reviewedIds.length, reviewedIds };
  }

  /** 学生本人的若干安全记录的复核与申诉状态（学生端信誉说明） */
  async findForUser(
    ids: Array<string | ObjectIdType>,
    userId: number
  ): Promise<Array<Pick<JailbreakLog, '_id' | 'domainId' | 'problemId' | 'reviewStatus' | 'studentAppealedAt'>>> {
    if (!ids.length) return [];
    return this.collection
      .find(
        { _id: { $in: ids.map((id) => ensureObjectId(id)) }, userId },
        { projection: { _id: 1, domainId: 1, problemId: 1, reviewStatus: 1, studentAppealedAt: 1 } }
      )
      .toArray();
  }

  /** 学生申诉：按 `{ _id, userId }` 查找本人的记录，不要求与当前域一致（plan R12） */
  async appealByStudent(
    id: string | ObjectIdType,
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
      userId,
      ...pendingReviewFilter,
      studentAppealedAt: { $exists: true },
    });
    return existingAppeal ? 'already_submitted' : 'unavailable';
  }

  // ─── AI 抽查（PR5） ────────────────────────────────────────

  /** 过去一段时间内规则中置信度命中所在的会话（候选来源 1，FR-041） */
  async conversationsWithConfidenceSince(
    confidence: SafetyConfidence,
    since: Date,
    limit = 2000
  ): Promise<Array<{ conversationId: ObjectIdType; domainId?: string; userId?: number }>> {
    const docs = await this.collection
      .find(
        { confidence, createdAt: { $gte: since }, conversationId: { $exists: true }, detectionSource: { $ne: 'ai_review' } },
        { projection: { conversationId: 1, domainId: 1, userId: 1 } }
      )
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs
      .filter((doc) => !!doc.conversationId)
      .map((doc) => ({ conversationId: doc.conversationId as ObjectIdType, domainId: doc.domainId, userId: doc.userId }));
  }

  /** 计数窗口内有过某类计数事件的用户（候选来源 2：出现过偏题提醒） */
  async usersWithPenaltyEventsSince(group: SafetyPenaltyGroup, since: Date, limit = 5000): Promise<number[]> {
    const docs = await this.penaltyCounterCollection
      .find({ group, 'events.at': { $gte: since } }, { projection: { userId: 1 } })
      .limit(limit)
      .toArray();
    return [...new Set(docs.map((doc) => doc.userId).filter((uid) => Number.isSafeInteger(uid)))];
  }

  /** 该会话是否已因 AI 抽查被处罚过（FR-044） */
  async hasAutoPenaltyForConversation(conversationId: string | ObjectIdType): Promise<boolean> {
    const doc = await this.collection.findOne(
      { conversationId: ensureObjectId(conversationId), detectionSource: 'ai_review', autoPenalized: true },
      { projection: { _id: 1 } }
    );
    return !!doc;
  }

  /** 该学生从某时刻起是否被 AI 抽查处罚过（FR-044：当天只处罚一次） */
  async hasAutoPenaltyForUserSince(userId: number, since: Date): Promise<boolean> {
    const doc = await this.collection.findOne(
      { userId, detectionSource: 'ai_review', autoPenalized: true, createdAt: { $gte: since } },
      { projection: { _id: 1 } }
    );
    return !!doc;
  }

  /** 熔断样本：最近已复核的自动处罚（只看恢复时间之后产生的处罚，FR-047） */
  async recentReviewedAutoPenalties(
    limit: number,
    createdAfter?: Date
  ): Promise<Array<Pick<JailbreakLog, '_id' | 'reviewStatus' | 'reviewedAt' | 'createdAt'>>> {
    return this.collection
      .find(
        {
          detectionSource: 'ai_review',
          autoPenalized: true,
          reviewStatus: { $in: ['confirmed', 'false_positive'] },
          ...(createdAfter ? { createdAt: { $gt: createdAfter } } : {}),
        },
        { projection: { _id: 1, reviewStatus: 1, reviewedAt: 1, createdAt: 1 } }
      )
      .sort({ reviewedAt: -1 })
      .limit(limit)
      .toArray();
  }

  /** 抽查标签页的“最近发现” */
  async listAIReviewFindings(limit = 20): Promise<JailbreakLog[]> {
    return this.collection
      .find({ detectionSource: 'ai_review' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  /** 自动处罚的扣分没有写成功：改回“标记待复核”，避免记录与信誉不一致 */
  async downgradeAutoPenalty(id: string | ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: ensureObjectId(id), autoPenalized: true },
      { $set: { autoPenalized: false, actionTaken: 'flagged' } }
    );
  }

  /** 若干安全记录的复核状态（判断复核是否涉及 AI 抽查的自动处罚） */
  async findByIds(ids: Array<string | ObjectIdType>): Promise<JailbreakLog[]> {
    if (!ids.length) return [];
    return this.collection.find({ _id: { $in: ids.map((id) => ensureObjectId(id)) } }).toArray();
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

  async suggestUserIds(
    domainId: string,
    query: string,
    limit: number = 10
  ): Promise<number[]> {
    const normalizedQuery = query.trim().slice(0, MAX_FILTER_SUGGESTION_QUERY_LENGTH);
    if (!normalizedQuery) return [];
    const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
    const prefixRanges = buildNumericPrefixRanges(normalizedQuery);
    if (prefixRanges.length === 0) return [];
    const rows = await this.collection.aggregate<{ _id: number }>([
      { $match: { domainId, $or: prefixRanges } },
      { $group: { _id: '$userId', lastSeen: { $max: '$createdAt' } } },
      { $sort: { lastSeen: -1, _id: 1 } },
      { $limit: safeLimit },
      { $project: { _id: 1 } },
    ], { maxTimeMS: 2000 }).toArray();
    return rows.map((row) => row._id);
  }

  async suggestProblemIds(
    domainId: string,
    query: string,
    limit: number = 10
  ): Promise<string[]> {
    const normalizedQuery = query.trim().slice(0, MAX_FILTER_SUGGESTION_QUERY_LENGTH);
    if (!normalizedQuery) return [];
    const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
    const bareQuery = normalizedQuery.replace(/^[Pp]/, '');
    if (!bareQuery) return [];
    const escapedBareQuery = escapeRegexLiteral(bareQuery);
    const exactPrefix = escapeRegexLiteral(normalizedQuery);
    const problemPrefixFilters = /^[Pp]/.test(normalizedQuery)
      ? [
        { problemId: { $regex: `^P${escapedBareQuery}` } },
        { problemId: { $regex: `^p${escapedBareQuery}` } },
      ]
      : [
        { problemId: { $regex: `^${exactPrefix}` } },
        { problemId: { $regex: `^P${escapedBareQuery}` } },
        { problemId: { $regex: `^p${escapedBareQuery}` } },
      ];
    const rows = await this.collection.aggregate<{ _id: string }>([
      {
        $match: {
          domainId,
          $or: problemPrefixFilters,
        },
      },
      { $group: { _id: '$problemId', lastSeen: { $max: '$createdAt' } } },
      { $sort: { lastSeen: -1, _id: 1 } },
      { $limit: safeLimit },
      { $project: { _id: 1 } },
    ], { maxTimeMS: 2000 }).toArray();
    return rows.map((row) => row._id);
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
