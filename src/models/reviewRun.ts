/**
 * ReviewRun Model - AI 抽查批次与熔断状态（plan R9、R15）
 *
 * 同一集合中两种文档：
 * - 批次：`_id` 为 `daily:YYYY-MM-DD`（每天一批，重复键即加锁）或 `manual:<ObjectId>`；
 *   候选列表与已处理的会话 id 存在文档中，执行进程每 30 秒续租，租约过期后其他进程可接管并断点续跑。
 * - 熔断状态：`_id: 'state'`，记录自动处罚是否启用、停用原因与恢复人。
 * 批次保留 180 天（与安全日志一致），状态文档不过期。
 */

import type { Collection, Db, Filter } from 'mongodb';
import { type ObjectIdType, unwrapModifyResult } from '../utils/mongo';

export type ReviewRunTrigger = 'schedule' | 'manual';
export type ReviewRunStatus = 'running' | 'completed' | 'failed' | 'skipped';
export type ReviewCandidateReason = 'medium_confidence' | 'off_topic' | 'high_usage' | 'sample' | 'manual';

export const REVIEW_RUN_RETENTION_DAYS = 180;
/** 租约时长：执行进程每 30 秒续租一次，两次续租失败仍有余量 */
export const REVIEW_RUN_LEASE_MS = 90 * 1000;
export const REVIEW_RUN_RENEW_MS = 30 * 1000;

export interface ReviewCandidate {
  conversationId: ObjectIdType;
  domainId: string;
  userId: number;
  reason: ReviewCandidateReason;
}

export interface ReviewRunScope {
  uids?: number[];
  conversationIds?: string[];
}

export interface ReviewRunTokens {
  prompt: number;
  completion: number;
  total: number;
}

export interface ReviewRun {
  _id: string;
  kind: 'run';
  trigger: ReviewRunTrigger;
  /** 定时批次的日期（配置时区） */
  date?: string;
  scope?: ReviewRunScope;
  /** 手动触发时显示用的对象说明（如学生用户名） */
  scopeLabel?: string;
  requestedBy?: number;
  status: ReviewRunStatus;
  /** 候选尚未选出时为 null */
  candidates: ReviewCandidate[] | null;
  processedIds: string[];
  flaggedCount: number;
  penalizedCount: number;
  failedCount: number;
  tokens: ReviewRunTokens;
  estimatedCostUSD: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  startedAt: Date;
  finishedAt?: Date;
  /** 失败或跳过的原因码 */
  error?: string;
  expireAt: Date;
}

export interface ReviewBreakerStats {
  window: number;
  sample: number;
  falsePositives: number;
  rate: number;
}

export interface ReviewState {
  _id: 'state';
  kind: 'state';
  autoPenaltyEnabled: boolean;
  /** 熔断自动停用 */
  trippedAt?: Date;
  trippedStats?: ReviewBreakerStats;
  /** 管理员手动停用 */
  disabledAt?: Date;
  disabledBy?: number;
  /** 最近一次恢复：熔断只统计这之后产生的自动处罚 */
  resumedAt?: Date;
  resumedBy?: number;
}

export interface ReviewRunProgress {
  flagged?: number;
  penalized?: number;
  failed?: number;
  tokens?: Partial<ReviewRunTokens>;
  costUSD?: number;
}

type ReviewDoc = ReviewRun | ReviewState;

function isDuplicateKeyError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

export class ReviewRunModel {
  private collection: Collection<ReviewDoc>;

  constructor(db: Db) {
    this.collection = db.collection<ReviewDoc>('ai_review_runs');
  }

  private get runs(): Collection<ReviewRun> {
    return this.collection as unknown as Collection<ReviewRun>;
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ kind: 1, startedAt: -1 }, { name: 'idx_kind_startedAt' });
    await this.collection.createIndex({ kind: 1, status: 1, leaseExpiresAt: 1 }, { name: 'idx_kind_status_lease' });
    await this.collection.createIndex({ expireAt: 1 }, { name: 'ttl_expireAt', expireAfterSeconds: 0 });
    console.log('[ReviewRunModel] Indexes created successfully');
  }

  /** 新建批次；`_id` 已存在（其他进程已负责）时返回 false */
  async tryCreate(input: {
    id: string;
    trigger: ReviewRunTrigger;
    owner: string;
    now: Date;
    date?: string;
    scope?: ReviewRunScope;
    scopeLabel?: string;
    requestedBy?: number;
  }): Promise<boolean> {
    const doc: ReviewRun = {
      _id: input.id,
      kind: 'run',
      trigger: input.trigger,
      ...(input.date ? { date: input.date } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.scopeLabel ? { scopeLabel: input.scopeLabel } : {}),
      ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy } : {}),
      status: 'running',
      candidates: null,
      processedIds: [],
      flaggedCount: 0,
      penalizedCount: 0,
      failedCount: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
      estimatedCostUSD: 0,
      leaseOwner: input.owner,
      leaseExpiresAt: new Date(input.now.getTime() + REVIEW_RUN_LEASE_MS),
      startedAt: input.now,
      expireAt: new Date(input.now.getTime() + REVIEW_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    };
    try {
      await this.runs.insertOne(doc);
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async get(id: string): Promise<ReviewRun | null> {
    return this.runs.findOne({ _id: id, kind: 'run' } as Filter<ReviewRun>);
  }

  /** 是否有租约有效的进行中批次 */
  async hasActiveRun(now: Date): Promise<boolean> {
    const doc = await this.runs.findOne(
      { kind: 'run', status: 'running', leaseExpiresAt: { $gt: now } } as Filter<ReviewRun>,
      { projection: { _id: 1 } }
    );
    return !!doc;
  }

  /** 租约已过期的进行中批次（进程崩溃或重启后由其他进程接管） */
  async findExpiredRunning(now: Date, limit = 5): Promise<ReviewRun[]> {
    return this.runs
      .find({ kind: 'run', status: 'running', leaseExpiresAt: { $lte: now } } as Filter<ReviewRun>)
      .sort({ startedAt: 1 })
      .limit(limit)
      .toArray();
  }

  /** 接管租约已过期的批次；成功返回 true */
  async claimExpired(id: string, owner: string, now: Date): Promise<boolean> {
    const raw = await this.runs.findOneAndUpdate(
      { _id: id, kind: 'run', status: 'running', leaseExpiresAt: { $lte: now } } as Filter<ReviewRun>,
      { $set: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + REVIEW_RUN_LEASE_MS) } },
      { returnDocument: 'after' }
    );
    return !!unwrapModifyResult<ReviewRun>(raw);
  }

  /** 续租；租约已被其他进程接管或批次已结束时返回 false */
  async renewLease(id: string, owner: string, now: Date): Promise<boolean> {
    const result = await this.runs.updateOne(
      { _id: id, kind: 'run', status: 'running', leaseOwner: owner } as Filter<ReviewRun>,
      { $set: { leaseExpiresAt: new Date(now.getTime() + REVIEW_RUN_LEASE_MS) } }
    );
    return result.matchedCount > 0;
  }

  async setCandidates(id: string, owner: string, candidates: ReviewCandidate[]): Promise<boolean> {
    const result = await this.runs.updateOne(
      { _id: id, kind: 'run', status: 'running', leaseOwner: owner } as Filter<ReviewRun>,
      { $set: { candidates } }
    );
    return result.matchedCount > 0;
  }

  /** 记录一个会话已处理及其结果；重复处理同一会话时不重复累计 */
  async markProcessed(id: string, owner: string, conversationId: string, progress: ReviewRunProgress): Promise<boolean> {
    const result = await this.runs.updateOne(
      {
        _id: id, kind: 'run', status: 'running', leaseOwner: owner, processedIds: { $ne: conversationId },
      } as Filter<ReviewRun>,
      {
        $push: { processedIds: conversationId },
        $inc: {
          flaggedCount: progress.flagged || 0,
          penalizedCount: progress.penalized || 0,
          failedCount: progress.failed || 0,
          'tokens.prompt': progress.tokens?.prompt || 0,
          'tokens.completion': progress.tokens?.completion || 0,
          'tokens.total': progress.tokens?.total || 0,
          estimatedCostUSD: progress.costUSD || 0,
        },
      }
    );
    return result.matchedCount > 0;
  }

  async finish(id: string, owner: string, status: Exclude<ReviewRunStatus, 'running'>, now: Date, error?: string): Promise<boolean> {
    const result = await this.runs.updateOne(
      { _id: id, kind: 'run', status: 'running', leaseOwner: owner } as Filter<ReviewRun>,
      { $set: { status, finishedAt: now, ...(error ? { error } : {}) } }
    );
    return result.matchedCount > 0;
  }

  /** 运行记录（不含候选明细） */
  async list(limit = 20): Promise<Array<Omit<ReviewRun, 'candidates' | 'processedIds'> & { candidateCount: number | null; processedCount: number }>> {
    const docs = await this.runs
      .find({ kind: 'run' } as Filter<ReviewRun>)
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(({ candidates, processedIds, ...rest }) => ({
      ...rest,
      candidateCount: candidates ? candidates.length : null,
      processedCount: processedIds.length,
    }));
  }

  /** 时间段内的抽查成本（FR-049）。每天至多几个批次，直接在内存中合计 */
  async costBetween(from: Date, to: Date): Promise<{ totalTokens: number; totalCost: number; runCount: number }> {
    const docs = await this.runs
      .find(
        { kind: 'run', startedAt: { $gte: from, $lt: to } } as Filter<ReviewRun>,
        { projection: { tokens: 1, estimatedCostUSD: 1 } }
      )
      .limit(5000)
      .toArray();
    return docs.reduce((sum, doc) => ({
      totalTokens: sum.totalTokens + (doc.tokens?.total || 0),
      totalCost: sum.totalCost + (doc.estimatedCostUSD || 0),
      runCount: sum.runCount + 1,
    }), { totalTokens: 0, totalCost: 0, runCount: 0 });
  }

  // ─── 熔断状态 ─────────────────────────────────────────

  private get states(): Collection<ReviewState> {
    return this.collection as unknown as Collection<ReviewState>;
  }

  async getState(): Promise<ReviewState> {
    const doc = await this.states.findOne({ _id: 'state' });
    return doc || { _id: 'state', kind: 'state', autoPenaltyEnabled: true };
  }

  /** 熔断：仅在当前为启用时生效，返回是否本次触发 */
  async trip(stats: ReviewBreakerStats, now: Date): Promise<boolean> {
    const result = await this.states.updateOne(
      { _id: 'state', autoPenaltyEnabled: { $ne: false } } as Filter<ReviewState>,
      {
        $set: { kind: 'state', autoPenaltyEnabled: false, trippedAt: now, trippedStats: stats },
        $unset: { disabledAt: '', disabledBy: '' },
      },
      { upsert: true }
    ).catch((err) => {
      // 状态文档已为停用时，upsert 会因 _id 冲突失败：视为未触发
      if (isDuplicateKeyError(err)) return { matchedCount: 0, upsertedCount: 0 };
      throw err;
    });
    return (result.matchedCount || 0) + (result.upsertedCount || 0) > 0;
  }

  /** 管理员手动停用或恢复自动处罚 */
  async setAutoPenalty(enabled: boolean, actorUid: number, now: Date): Promise<ReviewState> {
    const update = enabled
      ? {
        $set: { kind: 'state' as const, autoPenaltyEnabled: true, resumedAt: now, resumedBy: actorUid },
        $unset: { disabledAt: '' as const, disabledBy: '' as const },
      }
      : {
        $set: { kind: 'state' as const, autoPenaltyEnabled: false, disabledAt: now, disabledBy: actorUid },
        $unset: { trippedAt: '' as const, trippedStats: '' as const },
      };
    await this.states.updateOne({ _id: 'state' }, update, { upsert: true });
    return this.getState();
  }
}
