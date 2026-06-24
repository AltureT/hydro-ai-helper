/**
 * BatchSummaryJob Model - 批量摘要任务数据模型
 *
 * 管理竞赛批量对话摘要任务,跟踪任务状态和进度
 */

import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';

/** All non-archived job statuses (used for partial index and active job queries) */
export const ACTIVE_JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'stopped'] as const;

export interface BatchSummaryJob {
  _id: ObjectIdType;
  domainId: string;
  contestId: ObjectIdType;
  contestTitle: string;
  createdBy: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'archived';
  totalStudents: number;
  completedCount: number;
  failedCount: number;
  config: {
    concurrency: number;
    locale: string;
  };
  createdAt: Date;
  completedAt: Date | null;
}

export class BatchSummaryJobModel {
  private collection: Collection<BatchSummaryJob>;

  constructor(db: Db) {
    this.collection = db.collection<BatchSummaryJob>('ai_batch_summary_jobs');
  }

  /**
   * 确保索引已创建
   * 唯一部分索引: 同一域+竞赛只能有一个非归档任务
   */
  async ensureIndexes(): Promise<void> {
    // 清理旧版本索引（两者都不被 partialFilterExpression 支持，曾导致创建失败）：
    // v1 用了 $ne；v2 用了 $in（MongoDB < 6.0 报 "unsupported expression in
    // partial index"）。逐个尝试删除，不存在则忽略。
    for (const legacy of ['idx_domainId_contestId_active', 'idx_domainId_contestId_active_v2']) {
      try {
        await this.collection.dropIndex(legacy);
      } catch {
        // 旧索引不存在，忽略
      }
    }

    // 清理重复的活跃任务（旧唯一索引可能从未生效，存在重复数据会导致唯一索引创建失败）
    await this.deduplicateActiveJobs();

    // partialFilterExpression 仅支持 等值/$exists/$gt/$gte/$lt/$lte/$type/$and，
    // 不支持 $in 与 $ne。'archived' 在字典序上小于所有活跃状态，因此用
    // { $gt: 'archived' } 即可精确选出活跃集（pending/running/completed/failed/
    // stopped），且在所有 MongoDB 版本上都受支持。下面的不变式校验用于防止将来
    // 新增的状态破坏该字典序假设。
    if (ACTIVE_JOB_STATUSES.some((s) => s <= 'archived')) {
      console.warn(
        '[BatchSummaryJobModel] 状态字典序不变式被破坏：存在 <= "archived" 的活跃状态，部分索引过滤器可能不正确',
      );
    }

    await this.collection.createIndex(
      { domainId: 1, contestId: 1 },
      {
        name: 'idx_domainId_contestId_active_v3',
        unique: true,
        partialFilterExpression: {
          status: { $gt: 'archived' },
        },
      },
    );

    console.log('[BatchSummaryJobModel] Indexes created successfully');
  }

  /**
   * 清理同一域+竞赛下的重复活跃任务，保留最新的一条，其余归档
   */
  private async deduplicateActiveJobs(): Promise<void> {
    const duplicates = await this.collection.aggregate<{
      _id: { domainId: string; contestId: ObjectIdType };
      count: number;
      ids: ObjectIdType[];
    }>([
      { $match: { status: { $in: [...ACTIVE_JOB_STATUSES] } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { domainId: '$domainId', contestId: '$contestId' },
          count: { $sum: 1 },
          ids: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    for (const dup of duplicates) {
      // 保留第一条（最新），其余归档
      const toArchive = dup.ids.slice(1);
      await this.collection.updateMany(
        { _id: { $in: toArchive } },
        { $set: { status: 'archived' as const } },
      );
      console.log(
        `[BatchSummaryJobModel] Archived ${toArchive.length} duplicate active jobs for domain=${dup._id.domainId} contest=${dup._id.contestId}`,
      );
    }
  }

  /**
   * 创建新的批量摘要任务
   */
  async create(params: {
    domainId: string;
    contestId: ObjectIdType;
    contestTitle: string;
    createdBy: number;
    totalStudents?: number;
    config: { concurrency: number; locale: string };
  }): Promise<ObjectIdType> {
    const doc: Omit<BatchSummaryJob, '_id'> = {
      domainId: params.domainId,
      contestId: params.contestId,
      contestTitle: params.contestTitle,
      createdBy: params.createdBy,
      status: 'pending',
      totalStudents: params.totalStudents ?? 0,
      completedCount: 0,
      failedCount: 0,
      config: params.config,
      createdAt: new Date(),
      completedAt: null,
    };

    const result = await this.collection.insertOne(doc as BatchSummaryJob);
    return result.insertedId;
  }

  /**
   * 根据 ID 查找任务
   */
  async findById(id: string | ObjectIdType): Promise<BatchSummaryJob | null> {
    const _id = ensureObjectId(id);
    return this.collection.findOne({ _id });
  }

  /**
   * 查找指定域+竞赛的活跃任务 (status != 'archived')
   */
  async findActiveJob(
    domainId: string,
    contestId: ObjectIdType,
  ): Promise<BatchSummaryJob | null> {
    return this.collection.findOne({
      domainId,
      contestId,
      status: { $in: ['pending', 'running', 'completed', 'failed', 'stopped'] as const },
    });
  }

  /**
   * 更新任务状态
   * 当状态为 completed 或 failed 时自动写入 completedAt
   */
  async updateStatus(
    id: string | ObjectIdType,
    status: BatchSummaryJob['status'],
  ): Promise<void> {
    const _id = ensureObjectId(id);
    const $set: Partial<BatchSummaryJob> = { status };

    if (status === 'completed' || status === 'failed') {
      $set.completedAt = new Date();
    }

    await this.collection.updateOne({ _id }, { $set });
  }

  /**
   * 增加已完成学生计数
   */
  async incrementCompleted(id: string | ObjectIdType): Promise<void> {
    const _id = ensureObjectId(id);
    await this.collection.updateOne(
      { _id },
      { $inc: { completedCount: 1 } },
    );
  }

  /**
   * 增加失败学生计数
   */
  async incrementFailed(id: string | ObjectIdType): Promise<void> {
    const _id = ensureObjectId(id);
    await this.collection.updateOne(
      { _id },
      { $inc: { failedCount: 1 } },
    );
  }

  /**
   * 归档任务
   */
  async archive(id: string | ObjectIdType): Promise<void> {
    const _id = ensureObjectId(id);
    await this.collection.updateOne(
      { _id },
      { $set: { status: 'archived' } },
    );
  }

  async prepareForSupplementary(
    id: string | ObjectIdType,
    newTotal: number,
  ): Promise<void> {
    const _id = ensureObjectId(id);
    await this.collection.updateOne(
      { _id },
      { $set: { totalStudents: newTotal, status: 'running', completedAt: null } },
    );
  }
}
