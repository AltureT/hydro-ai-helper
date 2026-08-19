/**
 * Persistent test-data generation jobs. Results can contain a full reference
 * solution, so handlers must also enforce creator and problem-edit access.
 */

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { Collection, Db } from 'mongodb';
import type { ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';
import type {
  GenerationPlan,
  IndependentVerifierBlueprint,
  KillTarget,
  SandboxGenerationArtifacts,
  SandboxSolutionBlueprint,
  TestdataGenerationProgress,
} from '../services/testdataGenService';
import type {
  TestdataArtifact,
  TestdataFailureCode,
  TestdataRetryPolicy,
} from '../services/testdata/failures';

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
  failureCode?: TestdataFailureCode;
  stage?: string;
  artifact?: TestdataArtifact;
  retryPolicy?: TestdataRetryPolicy;
  retryable: boolean;
  recommendDeeperReasoning?: boolean;
}

export const TESTDATA_CHECKPOINT_FIELD_MAX_BYTES = 256 * 1024;

export interface TestdataGenerationCheckpointPayload {
  solution?: SandboxSolutionBlueprint;
  artifacts?: SandboxGenerationArtifacts;
  verifier?: IndependentVerifierBlueprint;
  killTargets?: KillTarget[];
}

export interface TestdataGenerationCheckpointEnvelope extends TestdataGenerationCheckpointPayload {
  /** 单个新 job 内严格递增；旧格式无 revision 的断点不再复用。 */
  revision: number;
}

export interface TestdataGenerationCheckpoint extends TestdataGenerationCheckpointEnvelope {
  optionsHash: string;
  statementHash: string;
}

export interface TestdataCheckpointHashes {
  optionsHash: string;
  statementHash: string;
}

export interface TestdataCheckpointContext {
  existingConfig?: string;
  checkerSource?: string;
  checkerHeaders?: Record<string, string>;
}

interface TestdataResumeScope extends TestdataCheckpointHashes {
  domainId: string;
  problemDocId: number;
  problemId: string;
  createdBy: number;
}

interface ResumeCheckpointJob {
  domainId: string;
  problemDocId: number;
  problemId: string;
  createdBy: number;
  status: TestdataGenerationJobStatus;
  checkpoint?: TestdataGenerationCheckpoint;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => normalizeForStableJson(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeForStableJson(item)]),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeCheckpointOptions(options: unknown): unknown {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return normalizeForStableJson(options);
  }
  const normalized = { ...(options as Record<string, unknown>) };
  if (Array.isArray(normalized.languages)) {
    normalized.languages = [...new Set(normalized.languages.map(language => String(language)))]
      .sort((left, right) => left.localeCompare(right));
  }
  return normalizeForStableJson(normalized);
}

function normalizeExistingConfig(existingConfig: string | undefined): unknown {
  if (existingConfig === undefined || existingConfig.trim() === '') return null;
  try {
    return normalizeForStableJson(yaml.load(existingConfig));
  } catch {
    // 正常入口会先执行 config 硬校验；纯函数仍为异常输入提供确定性 hash。
    return existingConfig.replace(/\r\n?/g, '\n').trim();
  }
}

function normalizeTextForHash(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** 断点只在完整生成选项与题面均完全一致时可复用。 */
export function computeTestdataCheckpointHashes(
  options: unknown,
  statementMarkdown: string,
  context: TestdataCheckpointContext = {},
): TestdataCheckpointHashes {
  const checkerPresent = context.checkerSource !== undefined;
  const checkerHeaders = Object.fromEntries(
    Object.entries(context.checkerHeaders || {})
      .map(([name, content]) => [name, sha256(normalizeTextForHash(content))]),
  );
  return {
    optionsHash: sha256(JSON.stringify(normalizeForStableJson({
      options: normalizeCheckpointOptions(options),
      existingConfig: normalizeExistingConfig(context.existingConfig),
      checker: {
        present: checkerPresent,
        contentHash: checkerPresent
          ? sha256(normalizeTextForHash(context.checkerSource as string))
          : null,
        headers: checkerHeaders,
      },
    }))),
    statementHash: sha256(statementMarkdown),
  };
}

/** MongoDB 单文档安全边界：任一制品过大时同时丢弃它与所有下游制品，禁止混代复用。 */
export function filterTestdataCheckpointUpdate(
  update: TestdataGenerationCheckpointEnvelope,
): TestdataGenerationCheckpointEnvelope {
  const filtered: TestdataGenerationCheckpointEnvelope = { revision: update.revision };
  const keys: Array<keyof TestdataGenerationCheckpointPayload> = [
    'solution',
    'artifacts',
    'verifier',
    'killTargets',
  ];
  for (const key of keys) {
    const value = update[key];
    if (value === undefined) continue;
    try {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= TESTDATA_CHECKPOINT_FIELD_MAX_BYTES) {
        (filtered as unknown as Record<string, unknown>)[key] = value;
      } else {
        break;
      }
    } catch {
      // 不可序列化与超大制品一样会切断依赖链，避免保留来自旧轮次的下游字段。
      break;
    }
  }
  return filtered;
}

/** 严格校验断点作用域；任一不符都由调用方静默转为全新生成。 */
export function selectTestdataResumeCheckpoint(
  job: ResumeCheckpointJob | null | undefined,
  expected: TestdataResumeScope,
): TestdataGenerationCheckpoint | undefined {
  if (!job?.checkpoint || job.status !== 'interrupted') return undefined;
  if (!Number.isSafeInteger(job.checkpoint.revision) || job.checkpoint.revision < 1
    || job.domainId !== expected.domainId
    || job.problemDocId !== expected.problemDocId
    || job.problemId !== expected.problemId
    || job.createdBy !== expected.createdBy
    || job.checkpoint.optionsHash !== expected.optionsHash
    || job.checkpoint.statementHash !== expected.statementHash) {
    return undefined;
  }
  return job.checkpoint;
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
  checkpoint?: TestdataGenerationCheckpoint;
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
  message: '生成服务在任务执行期间重启或失去连接，可从已保存的断点恢复。',
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
          status: 'interrupted', active: false, restorable: true,
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

  async updateCheckpoint(
    id: string | ObjectIdType,
    hashes: TestdataCheckpointHashes,
    update: TestdataGenerationCheckpointEnvelope,
  ): Promise<void> {
    const filtered = filterTestdataCheckpointUpdate(update);
    const now = new Date();
    const checkpoint: TestdataGenerationCheckpoint = { ...hashes, ...filtered };
    await this.collection.updateOne(
      {
        _id: ensureObjectId(id),
        active: true,
        $or: [
          { 'checkpoint.revision': { $lt: update.revision } },
          { 'checkpoint.revision': { $exists: false } },
        ],
      },
      { $set: { checkpoint, updatedAt: now } },
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
        status, active: false, restorable: status === 'interrupted', error,
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
        status: 'interrupted', active: false, restorable: true,
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
        status: 'interrupted', active: false, restorable: true,
        updatedAt: now, completedAt: now, error: interruptedError,
      } },
    );
    return result.modifiedCount;
  }
}
