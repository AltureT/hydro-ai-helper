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
    // 清理旧版本索引（v1 使用了不被 partialFilterExpression 支持的 $ne）
    try {
      await this.collection.dropIndex('idx_domainId_contestId_active');
    } catch {
      // 旧索引不存在，忽略
    }

    await this.collection.createIndex(
      { domainId: 1, contestId: 1 },
      {
        name: 'idx_domainId_contestId_active_v2',
        unique: true,
        partialFilterExpression: {
          status: { $in: [...ACTIVE_JOB_STATUSES] },
        },
      },
    );

    console.log('[BatchSummaryJobModel] Indexes created successfully');
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
