/**
 * Persistent test-data generation jobs. Results can contain a full reference
 * solution, so handlers must also enforce creator and problem-edit access.
 */

import type { Collection, Db } from 'mongodb';
import type { ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';
import type {
  GenerationPlan,
  TestdataGenerationProgress,
} from '../services/testdataGenService';

export type TestdataGenerationJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface TestdataGenerationJobError {
  message: string;
  code: string;
  category?: string;
  retryable: boolean;
  recommendDeeperReasoning?: boolean;
}

export interface TestdataGenerationJob {
  _id: ObjectIdType;
  domainId: string;
  problemDocId: number;
  problemId: string;
  problemTitle: string;
  createdBy: number;
  status: TestdataGenerationJobStatus;
  active: boolean;
  restorable: boolean;
  cancelRequested: boolean;
  progress: TestdataGenerationProgress;
  plan?: GenerationPlan;
  error?: TestdataGenerationJobError;
  createdAt: Date;
  startedAt: Date | null;
  updatedAt: Date;
  progressUpdatedAt: Date;
  completedAt: Date | null;
  leaseExpiresAt: Date;
  expiresAt: Date;
}

export const TESTDATA_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
export const TESTDATA_JOB_LEASE_MS = 90 * 1000;

interface CreateJobParams {
  domainId: string;
  problemDocId: number;
  problemId: string;
  problemTitle: string;
  createdBy: number;
}

const interruptedError: TestdataGenerationJobError = {
  message: '生成服务在任务执行期间重启或失去连接，请重新生成。',
  code: 'WORKER_INTERRUPTED',
  retryable: true,
};

export class TestdataGenerationJobModel {
  private collection: Collection<TestdataGenerationJob>;

  constructor(db: Db) {
    this.collection = db.collection<TestdataGenerationJob>('ai_testdata_generation_jobs');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { domainId: 1, problemDocId: 1, createdBy: 1 },
      {
        name: 'idx_testdata_job_one_active',
        unique: true,
        partialFilterExpression: { active: true },
      },
    );
    await this.collection.createIndex(
      { expiresAt: 1 },
      { name: 'idx_testdata_job_expiry', expireAfterSeconds: 0 },
    );
    await this.collection.createIndex(
      { domainId: 1, problemDocId: 1, createdBy: 1, restorable: 1, createdAt: -1 },
      { name: 'idx_testdata_job_restore' },
    );
  }

  private scope(params: Pick<CreateJobParams, 'domainId' | 'problemDocId' | 'createdBy'>) {
    return {
      domainId: params.domainId,
      problemDocId: params.problemDocId,
      createdBy: params.createdBy,
    };
  }

  async createOrGetActive(params: CreateJobParams): Promise<{
    job: TestdataGenerationJob;
    created: boolean;
  }> {
    const scope = this.scope(params);
    const now = new Date();
    await this.collection.updateMany(
      { ...scope, active: true, leaseExpiresAt: { $lte: now } },
      {
        $set: {
          status: 'interrupted', active: false, restorable: false,
          updatedAt: now, completedAt: now, error: interruptedError,
        },
      },
    );
    const active = await this.collection.findOne({ ...scope, active: true });
    if (active) return { job: active, created: false };
    await this.collection.updateMany(
      { ...scope, active: false, restorable: true },
      { $set: { restorable: false, updatedAt: now } },
    );

    const doc: Omit<TestdataGenerationJob, '_id'> = {
      ...params,
      status: 'pending',
      active: true,
      restorable: true,
      cancelRequested: false,
      progress: { stage: 'preparing', percent: 2, attempt: 1 },
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      progressUpdatedAt: now,
      completedAt: null,
      leaseExpiresAt: new Date(now.getTime() + TESTDATA_JOB_LEASE_MS),
      expiresAt: new Date(now.getTime() + TESTDATA_JOB_RETENTION_MS),
    };
    try {
      const result = await this.collection.insertOne(doc as TestdataGenerationJob);
      return { job: { ...doc, _id: result.insertedId }, created: true };
    } catch (err) {
      if ((err as { code?: number })?.code !== 11000) throw err;
      const concurrent = await this.collection.findOne({ ...scope, active: true });
      if (!concurrent) throw err;
      return { job: concurrent, created: false };
    }
  }

  async findById(id: string | ObjectIdType): Promise<TestdataGenerationJob | null> {
    return this.collection.findOne({ _id: ensureObjectId(id) });
  }

  async findRestorable(domainId: string, problemDocId: number, createdBy: number) {
    return this.collection.findOne(
      { domainId, problemDocId, createdBy, restorable: true },
      { sort: { createdAt: -1 } },
    );
  }

  async markRunning(id: string | ObjectIdType): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { _id: ensureObjectId(id), status: 'pending', active: true },
      { $set: {
        status: 'running', startedAt: now, updatedAt: now,
        leaseExpiresAt: new Date(now.getTime() + TESTDATA_JOB_LEASE_MS),
      } },
    );
  }

  async updateProgress(id: string | ObjectIdType, progress: TestdataGenerationProgress) {
    const now = new Date();
    await this.collection.updateOne(
      { _id: ensureObjectId(id), active: true },
      { $set: {
        progress, progressUpdatedAt: now, updatedAt: now,
        leaseExpiresAt: new Date(now.getTime() + TESTDATA_JOB_LEASE_MS),
      } },
    );
  }

  async renewLease(id: string | ObjectIdType): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { _id: ensureObjectId(id), active: true, cancelRequested: false },
      { $set: {
        updatedAt: now,
        leaseExpiresAt: new Date(now.getTime() + TESTDATA_JOB_LEASE_MS),
        // 活跃任务采用滑动保留期，避免长推理在固定 24 小时 TTL 到点时被误删。
        expiresAt: new Date(now.getTime() + TESTDATA_JOB_RETENTION_MS),
      } },
    );
    return result.modifiedCount > 0;
  }

  async complete(id: string | ObjectIdType, plan: GenerationPlan): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { _id: ensureObjectId(id), active: true, cancelRequested: false },
      { $set: {
        status: 'completed', active: false, restorable: true,
        progress: {
          stage: 'complete', percent: 100,
          attempt: plan.verification?.modelEscalation ? 2 : 1,
        },
        progressUpdatedAt: now, plan, updatedAt: now, completedAt: now,
      } },
    );
    return result.modifiedCount > 0;
  }

  async fail(
    id: string | ObjectIdType,
    error: TestdataGenerationJobError,
    status: 'failed' | 'interrupted' = 'failed',
  ): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { _id: ensureObjectId(id), active: true },
      { $set: {
        status, active: false, restorable: false, error,
        updatedAt: now, completedAt: now,
      } },
    );
  }

  async cancel(id: string | ObjectIdType): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { _id: ensureObjectId(id), status: { $in: ['pending', 'running'] } },
      { $set: {
        status: 'canceled', active: false, restorable: false,
        cancelRequested: true, updatedAt: now, completedAt: now,
      } },
    );
  }

  async dismiss(id: string | ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: ensureObjectId(id), active: false },
      { $set: { restorable: false, updatedAt: new Date() } },
    );
  }

  async markApplied(id: string | ObjectIdType): Promise<void> {
    await this.dismiss(id);
  }

  async markExpiredLeaseInterrupted(id: string | ObjectIdType): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { _id: ensureObjectId(id), active: true, leaseExpiresAt: { $lte: now } },
      { $set: {
        status: 'interrupted', active: false, restorable: false,
        updatedAt: now, completedAt: now, error: interruptedError,
      } },
    );
    return result.modifiedCount > 0;
  }

  async markAllExpiredLeasesInterrupted(): Promise<number> {
    const now = new Date();
    const result = await this.collection.updateMany(
      { active: true, leaseExpiresAt: { $lte: now } },
      { $set: {
        status: 'interrupted', active: false, restorable: false,
        updatedAt: now, completedAt: now, error: interruptedError,
      } },
    );
    return result.modifiedCount;
  }
}
