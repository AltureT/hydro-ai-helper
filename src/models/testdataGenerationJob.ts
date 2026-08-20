/**
 * Persistent test-data generation jobs. Results can contain a full reference
 * solution, so handlers must also enforce creator and problem-edit access.
 */

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { Collection, Db } from 'mongodb';
import type { ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';
import type { TestdataModelRole } from './aiConfig';
import { TESTDATA_CHECKPOINT_SCHEMA_VERSION } from '../services/testdata/pipelineContext';
export { TESTDATA_CHECKPOINT_SCHEMA_VERSION } from '../services/testdata/pipelineContext';
import {
  VALIDATOR_PROBE_CONSTRUCTION_KINDS,
  type ValidatorProbeRecipe,
} from '../services/testdata/validatorManifest';
import type {
  GenerationPlan,
  IndependentVerifierBlueprint,
  KillTarget,
  SandboxGenerationArtifacts,
  SandboxSolutionBlueprint,
  TestdataGenerationProgress,
  TestlibCheckerArtifacts,
} from '../services/testdataGenService';
import type {
  TestdataArtifact,
  TestdataFailureCode,
  TestdataFailureStage,
  TestdataRetryPolicy,
} from '../services/testdata/failures';
import {
  createTestdataEventId,
  createTestdataRunId,
  type TestdataChangedFileKind,
  type TestdataTeacherOutcome,
  type TestdataTeacherOutcomeReason,
} from '../services/testdata/runTelemetry';

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
  stage?: TestdataFailureStage;
  artifact?: TestdataArtifact;
  retryPolicy?: TestdataRetryPolicy;
  retryable: boolean;
  recommendDeeperReasoning?: boolean;
}

export const TESTDATA_CHECKPOINT_FIELD_MAX_BYTES = 256 * 1024;

const CHECKPOINT_DECLARATION_ID_MAX_LENGTH = 64;
const CHECKPOINT_DECLARATION_OPERATION_MAX_LENGTH = 256;

function boundedCheckpointString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function checkpointStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const result = value.filter(item => boundedCheckpointString(
    item,
    CHECKPOINT_DECLARATION_ID_MAX_LENGTH,
  ));
  return result.length === value.length ? result : undefined;
}

function checkpointProbeRecipe(value: unknown): ValidatorProbeRecipe | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const recipe = value as Record<string, unknown>;
  if (!boundedCheckpointString(recipe.targetId, CHECKPOINT_DECLARATION_ID_MAX_LENGTH)
    || typeof recipe.constructionKind !== 'string'
    || !VALIDATOR_PROBE_CONSTRUCTION_KINDS.includes(
      recipe.constructionKind as ValidatorProbeRecipe['constructionKind'],
    )
    || (recipe.fieldId !== undefined
      && !boundedCheckpointString(recipe.fieldId, CHECKPOINT_DECLARATION_ID_MAX_LENGTH))
    || (recipe.operationName !== undefined
      && !boundedCheckpointString(
        recipe.operationName,
        CHECKPOINT_DECLARATION_OPERATION_MAX_LENGTH,
      ))) return undefined;
  return {
    targetId: recipe.targetId,
    constructionKind: recipe.constructionKind as ValidatorProbeRecipe['constructionKind'],
    ...(recipe.fieldId === undefined ? {} : { fieldId: recipe.fieldId as string }),
    ...(recipe.operationName === undefined
      ? {}
      : { operationName: recipe.operationName as string }),
  };
}

/** Persist only declarations needed to deterministically rebuild verifier probes. */
function checkpointVerifierDeclaration(value: unknown): IndependentVerifierBlueprint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const verifier = value as Record<string, unknown>;
  if (typeof verifier.bruteCode !== 'string'
    || typeof verifier.validatorCode !== 'string'
    || typeof verifier.stressGeneratorCode !== 'string') return undefined;

  let functionSampleInputs: IndependentVerifierBlueprint['functionSampleInputs'];
  if (verifier.functionSampleInputs !== undefined) {
    if (!Array.isArray(verifier.functionSampleInputs)
      || verifier.functionSampleInputs.length > 64) return undefined;
    functionSampleInputs = verifier.functionSampleInputs.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const sample = value as Record<string, unknown>;
      if (!boundedCheckpointString(sample.id, CHECKPOINT_DECLARATION_ID_MAX_LENGTH)
        || typeof sample.input !== 'string') return [];
      return [{ id: sample.id, input: sample.input }];
    });
    if (functionSampleInputs.length !== verifier.functionSampleInputs.length) return undefined;
  }

  let validatorManifest: IndependentVerifierBlueprint['validatorManifest'];
  if (verifier.validatorManifest !== undefined) {
    if (!verifier.validatorManifest || typeof verifier.validatorManifest !== 'object'
      || Array.isArray(verifier.validatorManifest)) return undefined;
    const manifest = verifier.validatorManifest as Record<string, unknown>;
    const constraintIds = checkpointStringArray(manifest.constraintIds);
    const invariantIds = checkpointStringArray(manifest.invariantIds);
    if (!constraintIds || !invariantIds) return undefined;
    validatorManifest = { constraintIds, invariantIds };
  }

  let validatorProbeRecipes: ValidatorProbeRecipe[] | undefined;
  if (verifier.validatorProbeRecipes !== undefined) {
    if (!Array.isArray(verifier.validatorProbeRecipes)
      || verifier.validatorProbeRecipes.length > 64) return undefined;
    validatorProbeRecipes = verifier.validatorProbeRecipes.flatMap(recipe => {
      const projected = checkpointProbeRecipe(recipe);
      return projected ? [projected] : [];
    });
    if (validatorProbeRecipes.length !== verifier.validatorProbeRecipes.length) return undefined;
  }

  return {
    bruteCode: verifier.bruteCode,
    validatorCode: verifier.validatorCode,
    stressGeneratorCode: verifier.stressGeneratorCode,
    ...(verifier.complexityGap === 'exists' || verifier.complexityGap === 'none'
      ? { complexityGap: verifier.complexityGap }
      : {}),
    ...(functionSampleInputs === undefined ? {} : { functionSampleInputs }),
    ...(verifier.validatorManifestStatus === 'valid'
      || verifier.validatorManifestStatus === 'invalid'
      ? { validatorManifestStatus: verifier.validatorManifestStatus }
      : {}),
    ...(validatorManifest === undefined ? {} : { validatorManifest }),
    ...(validatorProbeRecipes === undefined ? {} : { validatorProbeRecipes }),
  };
}

export interface TestdataGenerationCheckpointPayload {
  checkpointSchemaVersion?: typeof TESTDATA_CHECKPOINT_SCHEMA_VERSION;
  promptVersion?: string;
  statementHash?: string;
  specHash?: string;
  roleDependencies?: Partial<Record<TestdataModelRole, string>>;
  solution?: SandboxSolutionBlueprint;
  artifacts?: SandboxGenerationArtifacts;
  /** 仅保存验证器代码与安全的 Manifest/recipe 声明，不保存物化 probe、seed 或调用载荷。 */
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
  checkerArtifacts?: Pick<
    TestlibCheckerArtifacts,
    'configured' | 'read' | 'failureKind' | 'checkerSource' | 'checkerHeaders'
  >;
}

interface TestdataResumeScope extends TestdataCheckpointHashes {
  domainId: string;
  problemDocId: number;
  problemId: string;
  createdBy: number;
  checkpointSchemaVersion?: typeof TESTDATA_CHECKPOINT_SCHEMA_VERSION;
  promptVersion?: string;
  specHash?: string;
  /** Emergency rollback only: v1 has no frozen Spec or role provenance. */
  allowV1?: boolean;
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
  const checkerArtifacts = context.checkerArtifacts;
  const checkerPresent = checkerArtifacts?.checkerSource !== undefined;
  const checkerHeaders = Object.fromEntries(
    Object.entries(checkerArtifacts?.checkerHeaders || {})
      .map(([name, content]) => [name, sha256(normalizeTextForHash(content))]),
  );
  return {
    optionsHash: sha256(JSON.stringify(normalizeForStableJson({
      options: normalizeCheckpointOptions(options),
      existingConfig: normalizeExistingConfig(context.existingConfig),
      checker: {
        configured: checkerArtifacts?.configured ?? false,
        read: checkerArtifacts?.read ?? false,
        failureKind: checkerArtifacts?.failureKind ?? null,
        present: checkerPresent,
        contentHash: checkerPresent
          ? sha256(normalizeTextForHash(checkerArtifacts?.checkerSource as string))
          : null,
        headers: checkerHeaders,
      },
    }))),
    statementHash: sha256(normalizeTextForHash(statementMarkdown)),
  };
}

/** MongoDB 单文档安全边界：任一制品过大时同时丢弃它与所有下游制品，禁止混代复用。 */
export function filterTestdataCheckpointUpdate(
  update: TestdataGenerationCheckpointEnvelope,
): TestdataGenerationCheckpointEnvelope {
  const filtered: TestdataGenerationCheckpointEnvelope = {
    revision: update.revision,
    ...(update.checkpointSchemaVersion === TESTDATA_CHECKPOINT_SCHEMA_VERSION ? {
      checkpointSchemaVersion: TESTDATA_CHECKPOINT_SCHEMA_VERSION,
      promptVersion: update.promptVersion,
      statementHash: update.statementHash,
      specHash: update.specHash,
      roleDependencies: update.roleDependencies,
    } : {}),
  };
  const keys: Array<keyof TestdataGenerationCheckpointPayload> = [
    'solution',
    'artifacts',
    'verifier',
    'killTargets',
  ];
  for (const key of keys) {
    const value = key === 'verifier'
      ? checkpointVerifierDeclaration(update.verifier)
      : update[key];
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
  const checkpoint = job.checkpoint;
  const isV2 = checkpoint.checkpointSchemaVersion === TESTDATA_CHECKPOINT_SCHEMA_VERSION;
  if (!isV2 && !expected.allowV1) return undefined;
  if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1
    || job.domainId !== expected.domainId
    || job.problemDocId !== expected.problemDocId
    || job.problemId !== expected.problemId
    || job.createdBy !== expected.createdBy
    || checkpoint.optionsHash !== expected.optionsHash
    || checkpoint.statementHash !== expected.statementHash) {
    return undefined;
  }
  if (!isV2) return checkpoint;
  if ((expected.checkpointSchemaVersion !== undefined
      && expected.checkpointSchemaVersion !== checkpoint.checkpointSchemaVersion)
    || (expected.promptVersion !== undefined && expected.promptVersion !== checkpoint.promptVersion)
    || (expected.specHash !== undefined && expected.specHash !== checkpoint.specHash)
    || typeof checkpoint.promptVersion !== 'string'
    || !/^[a-f0-9]{64}$/.test(checkpoint.specHash || '')
    || Object.values(checkpoint.roleDependencies || {})
      .some(value => !/^[a-f0-9]{64}$/.test(value || ''))) {
    return undefined;
  }
  return checkpoint;
}

export interface TestdataGenerationJob {
  _id: ObjectIdType;
  runId: string;
  /** Stable local id for the single idempotent apply-failure event slot. */
  applyFailureEventId?: string;
  applyFailureOccurredAt?: Date;
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
  teacherOutcome?: TestdataTeacherOutcomeRecord;
  teacherOutcomeClaim?: TestdataTeacherOutcomeClaim;
  appliedAt?: Date;
  createdAt: Date;
  startedAt: Date | null;
  updatedAt: Date;
  progressUpdatedAt: Date;
  completedAt: Date | null;
  leaseExpiresAt: Date;
  expiresAt: Date;
}

export interface TestdataTeacherOutcomeClaim {
  claimId: string;
  claimedAt: Date;
  leaseExpiresAt: Date;
}

export interface TestdataTeacherOutcomeRecord {
  eventId: string;
  outcome: TestdataTeacherOutcome;
  reason?: TestdataTeacherOutcomeReason;
  editedFileCount?: number;
  changedFileKinds?: TestdataChangedFileKind[];
  recordedAt: Date;
}

export interface TestdataTeacherOutcomeInput {
  eventId: string;
  outcome: TestdataTeacherOutcome;
  reason?: TestdataTeacherOutcomeReason;
  editedFileCount?: number;
  changedFileKinds?: readonly TestdataChangedFileKind[];
}

export const TESTDATA_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
export const TESTDATA_JOB_LEASE_MS = 90 * 1000;
export const TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS = 10 * 60 * 1000;

function availableTeacherOutcomeClaim(now: Date) {
  return {
    $or: [
      { teacherOutcomeClaim: { $exists: false } },
      { 'teacherOutcomeClaim.leaseExpiresAt': { $lte: now } },
      // Recover pre-lease claims left by an interrupted older process.
      { 'teacherOutcomeClaim.leaseExpiresAt': { $exists: false } },
    ],
  };
}

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
      runId: createTestdataRunId(),
      applyFailureEventId: createTestdataEventId(),
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

  async cancel(
    id: string | ObjectIdType,
    error?: TestdataGenerationJobError,
  ): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { _id: ensureObjectId(id), status: { $in: ['pending', 'running'] } },
      { $set: {
        status: 'canceled', active: false, restorable: false,
        cancelRequested: true, updatedAt: now, completedAt: now,
        ...(error ? { error } : {}),
      } },
    );
  }

  async dismiss(id: string | ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: ensureObjectId(id), active: false },
      { $set: { restorable: false, updatedAt: new Date() } },
    );
  }

  async claimTeacherOutcome(id: string | ObjectIdType, claimId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      {
        _id: ensureObjectId(id),
        status: 'completed',
        teacherOutcome: { $exists: false },
        appliedAt: { $exists: false },
        ...availableTeacherOutcomeClaim(now),
      } as never,
      { $set: {
        teacherOutcomeClaim: {
          claimId,
          claimedAt: now,
          leaseExpiresAt: new Date(now.getTime() + TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS),
        },
        updatedAt: now,
      } },
    );
    return result.modifiedCount > 0;
  }

  async releaseTeacherOutcomeClaim(id: string | ObjectIdType, claimId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: ensureObjectId(id), 'teacherOutcomeClaim.claimId': claimId } as never,
      { $unset: { teacherOutcomeClaim: '' }, $set: { updatedAt: new Date() } } as never,
    );
  }

  async renewTeacherOutcomeClaim(id: string | ObjectIdType, claimId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { _id: ensureObjectId(id), 'teacherOutcomeClaim.claimId': claimId } as never,
      { $set: {
        'teacherOutcomeClaim.claimedAt': now,
        'teacherOutcomeClaim.leaseExpiresAt': new Date(
          now.getTime() + TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS,
        ),
        updatedAt: now,
      } } as never,
    );
    return result.matchedCount > 0;
  }

  async getOrCreateApplyFailureEvent(
    id: string | ObjectIdType,
    preferredEventId?: string,
  ): Promise<{ eventId: string; occurredAt: Date } | null> {
    const eventId = preferredEventId || createTestdataEventId();
    const occurredAt = new Date();
    const objectId = ensureObjectId(id);
    const result = await this.collection.updateOne(
      { _id: objectId, applyFailureOccurredAt: { $exists: false } } as never,
      { $set: { applyFailureEventId: eventId, applyFailureOccurredAt: occurredAt } } as never,
    );
    if (result.modifiedCount > 0) return { eventId, occurredAt };
    const existing = await this.collection.findOne(
      { _id: objectId } as never,
      { projection: { applyFailureEventId: 1, applyFailureOccurredAt: 1 } },
    );
    return typeof existing?.applyFailureEventId === 'string'
      && existing.applyFailureOccurredAt instanceof Date
      ? { eventId: existing.applyFailureEventId, occurredAt: existing.applyFailureOccurredAt }
      : null;
  }

  async markApplied(id: string | ObjectIdType, claimId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.collection.updateOne(
      { _id: ensureObjectId(id), 'teacherOutcomeClaim.claimId': claimId } as never,
      {
        $set: { appliedAt: now, restorable: false, updatedAt: now },
        $unset: { teacherOutcomeClaim: '' },
      } as never,
    );
    return result.modifiedCount > 0;
  }

  async recordTeacherOutcome(
    id: string | ObjectIdType,
    input: TestdataTeacherOutcomeInput,
    claimId?: string,
  ): Promise<{
    state: 'recorded' | 'duplicate' | 'conflict';
    record: TestdataTeacherOutcomeRecord;
  }> {
    const now = new Date();
    const record: TestdataTeacherOutcomeRecord = {
      eventId: input.eventId,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.editedFileCount !== undefined ? { editedFileCount: input.editedFileCount } : {}),
      ...(input.changedFileKinds ? { changedFileKinds: [...input.changedFileKinds] } : {}),
      recordedAt: now,
    };
    const objectId = ensureObjectId(id);
    const result = await this.collection.updateOne(
      {
        _id: objectId,
        status: 'completed',
        teacherOutcome: { $exists: false },
        appliedAt: { $exists: false },
        ...(claimId
          ? { 'teacherOutcomeClaim.claimId': claimId }
          : availableTeacherOutcomeClaim(now)),
      } as never,
      {
        $set: { teacherOutcome: record, restorable: false, updatedAt: now },
        ...(!claimId ? { $unset: { teacherOutcomeClaim: '' } } : {}),
      },
    );
    if (result.modifiedCount > 0) return { state: 'recorded', record };
    const existing = await this.collection.findOne(
      { _id: objectId } as never,
      { projection: { teacherOutcome: 1 } },
    );
    const stored = existing?.teacherOutcome;
    if (!stored) return { state: 'conflict', record };
    const duplicate = stored.outcome === input.outcome
      && stored.reason === input.reason
      && stored.editedFileCount === input.editedFileCount
      && JSON.stringify(stored.changedFileKinds || []) === JSON.stringify(input.changedFileKinds || []);
    return { state: duplicate ? 'duplicate' : 'conflict', record: stored };
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
