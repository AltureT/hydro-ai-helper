/**
 * TestdataGenHandler - AI 测试数据生成 API 处理器
 *
 * 面向教师/出题人，嵌入题目文件页（/p/:pid/files）：
 * - GET  /ai-helper/testdata-gen/context/:problemId  加载题目上下文（题面、已有文件）
 * - POST /ai-helper/testdata-gen/generate            调用 AI 生成文件计划（仅预览，不落盘）
 * - POST /ai-helper/testdata-gen/apply               确认后写入题目测试数据
 *
 * 权限与 HydroOJ 题目文件上传保持一致：
 *   题目所有者且拥有 PERM_EDIT_PROBLEM_SELF，或拥有 PERM_EDIT_PROBLEM。
 * 生成结果包含完整标程，学生角色（无上述权限）无法访问任何端点。
 */

import { ContestModel, Handler, PRIV, PERM, ProblemModel, StorageModel, SystemModel, STATUS, db } from 'hydrooj';
import type { ServerResponse } from 'http';
import { createHash } from 'crypto';
import { posix as pathPosix } from 'path';
import { createMultiModelClientFromConfig, AIServiceError, USER_ERROR_MESSAGE_KEYS, getHttpStatusForCategory, extractAiErrorMetadata } from '../services/openaiClient';
import { createTestdataRoleClientsFromConfig } from '../services/testdata/modelRoles';
import {
  TestdataGenService,
  GenerateOptions,
  TemplateLang,
  SUPPORTED_TEMPLATE_LANGS,
  validateGenerateOptions,
  isSafeTestdataFilename,
  isCancellation,
  extractTestdataErrorMetadata,
  extractTestdataUserMessageKey,
  extractTestdataUserMessageDetail,
  shouldRecommendDeeperReasoning,
  normalizeFileContent,
  buildSkeletonPlan,
  TESTDATA_GEN_LIMITS,
  assertExistingConfigParsable,
  TESTDATA_CONFIG_UNPARSABLE_KEY,
  CPP_ORACLE_UNAVAILABLE_KEY,
  CPP_PROVIDED_STD_COMPILE_FAILED_KEY,
  CPP_ORACLE_INFRA_FAILURE_KEY,
  getTestlibCheckerFilename,
  hasCustomChecker,
  extractStatementSamples,
  type GenerationPlan,
  type TestlibCheckerArtifacts,
} from '../services/testdataGenService';
import {
  TESTDATA_FAILURE_CODES,
  extractTestdataFailureMetadata,
  getUserMessageKeyForFailure,
} from '../services/testdata/failures';
import {
  assessTestdataRisk,
  getTestdataDirectFallbackEnabled,
  getTestdataReliabilityMode,
} from '../services/testdata/risk';
import { isFillInBlankProblem } from '../services/analyzers/codeSelectionService';
import {
  GoJudgeSandboxRunner,
  getTestdataGenerationMode,
  type TestdataGenerationMode,
} from '../services/goJudgeSandboxService';
import { applyRateLimit } from '../lib/rateLimitHelper';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { createSSEWriter, type SSEWriter } from '../lib/sseHelper';
import { API_DEFAULTS } from '../constants/limits';
import { getDomainId } from '../utils/domainHelper';
import { ObjectId, type ObjectIdType } from '../utils/mongo';
import {
  TestdataGenerationJobModel,
  TESTDATA_CHECKPOINT_SCHEMA_VERSION,
  TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS,
  computeTestdataCheckpointHashes,
  selectTestdataResumeCheckpoint,
  type TestdataGenerationJob,
  type TestdataGenerationCheckpoint,
  type TestdataGenerationCheckpointEnvelope,
  type TestdataGenerationCheckpointPayload,
  type TestdataCheckpointHashes,
  type TestdataGenerationJobError,
} from '../models/testdataGenerationJob';
import {
  computeOriginalFileHashes,
  createTestdataEventId,
  createTestdataRunId,
  getStatementLengthBucket,
  type TestdataChangedFileKind,
  type TestdataRunTelemetryService,
  type TestdataRunTelemetrySession,
  type TestdataTelemetryModel,
  type TestdataTeacherOutcomeReason,
} from '../services/testdata/runTelemetry';
import { TESTDATA_PIPELINE_PROMPT_VERSION } from '../services/testdata/pipelineContext';
import {
  MAX_HISTORICAL_MUTATION_CANDIDATES,
  getMutationGateMode,
  normalizeMutationLanguage,
  type HistoricalMutationCandidate,
  type MutationGateMode,
} from '../services/testdata/mutation';

export const TestdataGenHandlerPriv = PRIV.PRIV_USER_PROFILE;

const DOC_TYPE_PROBLEM = 10;

interface ProblemDocLite {
  docId: number;
  pid?: string;
  title?: string;
  content?: string;
  owner?: number;
  config?: string;
  data?: Array<{ _id?: string; name?: string; size?: number }>;
}

function normalizeCheckerPath(filename: string): string | undefined {
  if (!filename || filename.includes('\\') || filename.includes('\0') || pathPosix.isAbsolute(filename)) {
    return undefined;
  }
  const normalized = pathPosix.normalize(filename);
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized.replace(/^\.\//, '');
}

async function readStorageText(storagePath: string): Promise<string> {
  const value = await StorageModel.get(storagePath);
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of value as unknown as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 读取 testlib checker 与同目录头文件，并对每个路径返回显式制品状态。
 */
export async function loadTestlibCheckerArtifacts(
  domainId: string,
  pdoc: ProblemDocLite,
): Promise<TestlibCheckerArtifacts> {
  let configured: string | undefined;
  try {
    configured = getTestlibCheckerFilename(pdoc.config);
  } catch {
    // config 解析硬错误由 service 的统一 guard 报出；这里仍保持显式未配置状态。
    return { configured: false, read: false };
  }
  if (!configured) return { configured: false, read: false };
  const checkerFilename = normalizeCheckerPath(configured);
  if (!checkerFilename) {
    return { configured: true, read: false, failureKind: 'invalid-path' };
  }

  const files = (pdoc.data || []).flatMap(item => {
    const storageName = normalizeCheckerPath(String(item._id ?? item.name ?? ''));
    return storageName ? [{ storageName, logicalName: storageName }] : [];
  });
  const checkerFile = files.find(file => file.logicalName === checkerFilename);
  if (!checkerFile) return { configured: true, read: false, failureKind: 'missing' };
  const checkerDir = pathPosix.dirname(checkerFilename);
  const headerFiles = files.filter(file =>
    pathPosix.dirname(file.logicalName) === checkerDir
    && file.logicalName.toLowerCase().endsWith('.h'));
  const storageBase = `problem/${domainId}/${pdoc.docId}/testdata`;

  try {
    const checkerSource = await readStorageText(`${storageBase}/${checkerFile.storageName}`);
    const headerEntries = await Promise.all(headerFiles.map(async file => [
      pathPosix.basename(file.logicalName),
      await readStorageText(`${storageBase}/${file.storageName}`),
    ] as const));
    return {
      configured: true,
      read: true,
      checkerSource,
      checkerHeaders: Object.fromEntries(headerEntries),
    };
  } catch {
    return { configured: true, read: false, failureKind: 'read' };
  }
}

interface AcceptedStdRecordLite {
  _id: ObjectIdType;
  uid: number;
  lang: string;
  code: string;
}

interface AcceptedStdCandidate {
  recordId: string;
  lang: string;
  submittedAt: string;
  isOwn: boolean;
}

const PYTHON3_RECORD_LANGUAGES = ['py', 'py.py3', 'py.pypy3', 'python', 'python3'];
const ACCEPTED_STD_CANDIDATE_LIMIT = 8;
const HISTORICAL_MUTATION_RECORD_LANGUAGES = [
  ...PYTHON3_RECORD_LANGUAGES,
  'cc', 'cc.cc17', 'cpp', 'cpp17', 'c++17',
];
const HISTORICAL_MUTATION_RECORD_LIMIT = 64;

function canReadAllRecordCodes(handler: Handler): boolean {
  const user = handler.user;
  const hasPriv = typeof user?.hasPriv === 'function'
    && PRIV.PRIV_READ_RECORD_CODE !== undefined
    && user.hasPriv(PRIV.PRIV_READ_RECORD_CODE);
  const hasPerm = typeof user?.hasPerm === 'function'
    && PERM.PERM_READ_RECORD_CODE !== undefined
    && user.hasPerm(PERM.PERM_READ_RECORD_CODE);
  return hasPriv || hasPerm;
}

interface HistoricalMutationRecordLite {
  _id: ObjectIdType;
  domainId?: string;
  pid?: string | number;
  status: number;
  lang: string;
  code: string;
  contest?: unknown;
}

function historicalExpectedStatus(
  status: number,
): HistoricalMutationCandidate['expectedStatus'] | undefined {
  if (status === STATUS.STATUS_WRONG_ANSWER) return 'wrong-answer';
  if (status === STATUS.STATUS_RUNTIME_ERROR) return 'runtime-error';
  if (status === STATUS.STATUS_TIME_LIMIT_EXCEEDED) return 'time-limit';
  return undefined;
}

/**
 * 读取历史错误提交作为请求内 mutation 候选。缺少独立源码读取权限或任一查询不确定时
 * 均 fail closed；候选不会携带记录 ID、digest 或竞赛元数据。
 */
export async function loadHistoricalMutationCandidates(
  handler: Handler,
  domainId: string,
  problemDocId: number,
): Promise<HistoricalMutationCandidate[]> {
  if (!canReadAllRecordCodes(handler)) return [];

  let records: HistoricalMutationRecordLite[];
  try {
    records = await db.collection<HistoricalMutationRecordLite>('record')
      .find({
        domainId,
        pid: problemDocId,
        status: { $in: [
          STATUS.STATUS_WRONG_ANSWER,
          STATUS.STATUS_RUNTIME_ERROR,
          STATUS.STATUS_TIME_LIMIT_EXCEEDED,
        ] },
        lang: { $in: HISTORICAL_MUTATION_RECORD_LANGUAGES },
        code: { $type: 'string', $ne: '' },
      }, {
        projection: { _id: 1, status: 1, lang: 1, code: 1, contest: 1 },
      })
      .sort({ _id: -1 })
      .limit(HISTORICAL_MUTATION_RECORD_LIMIT)
      .toArray();
  } catch {
    return [];
  }

  const contestDone = new Map<string, boolean>();
  const isEligibleContest = async (contest: unknown): Promise<boolean> => {
    if (contest === undefined || contest === null) return true;
    const key = String(contest);
    const cached = contestDone.get(key);
    if (cached !== undefined) return cached;
    try {
      const tdoc = await ContestModel.get(domainId, contest);
      const done = !!tdoc && ContestModel.isDone(tdoc);
      contestDone.set(key, done);
      return done;
    } catch {
      contestDone.set(key, false);
      return false;
    }
  };

  const seenSourceDigests = new Set<string>();
  const candidates: HistoricalMutationCandidate[] = [];
  for (const record of records) {
    if ((record.domainId !== undefined && record.domainId !== domainId)
      || (record.pid !== undefined && String(record.pid) !== String(problemDocId))) continue;
    const expectedStatus = historicalExpectedStatus(record.status);
    const language = typeof record.lang === 'string'
      ? normalizeMutationLanguage(record.lang)
      : undefined;
    const source = typeof record.code === 'string' ? record.code.trim() : '';
    if (!expectedStatus
      || !language
      || !source
      || source.startsWith('@@hydro_submission_file@@')
      || source.length > TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD
      || !(await isEligibleContest(record.contest))) continue;

    const digest = createHash('sha256').update(source).digest('hex');
    if (seenSourceDigests.has(digest)) continue;
    seenSourceDigests.add(digest);
    candidates.push({ language, source, expectedStatus });
    if (candidates.length >= MAX_HISTORICAL_MUTATION_CANDIDATES) break;
  }
  return candidates;
}

function acceptedStdRecordQuery(
  handler: Handler,
  domainId: string,
  problemDocId: number,
): Record<string, unknown> {
  return {
    domainId,
    pid: problemDocId,
    status: STATUS.STATUS_ACCEPTED,
    lang: { $in: PYTHON3_RECORD_LANGUAGES },
    code: { $type: 'string', $ne: '' },
    // 未结束竞赛中的 AC 不能成为题目文件页的隐式源码入口。
    $or: [{ contest: { $exists: false } }, { contest: null }],
    ...(canReadAllRecordCodes(handler) ? {} : { uid: handler.user?._id }),
  };
}

async function listAcceptedStdCandidates(
  handler: Handler,
  domainId: string,
  problemDocId: number,
): Promise<AcceptedStdCandidate[]> {
  const records = await db.collection<AcceptedStdRecordLite>('record')
    .find(acceptedStdRecordQuery(handler, domainId, problemDocId), {
      projection: { _id: 1, uid: 1, lang: 1, code: 1 },
    })
    .sort({ _id: -1 })
    .limit(ACCEPTED_STD_CANDIDATE_LIMIT * 2)
    .toArray();
  const seenCode = new Set<string>();
  const candidates: AcceptedStdCandidate[] = [];
  for (const record of records) {
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    if (!code
      || code.startsWith('@@hydro_submission_file@@')
      || code.length > TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD
      || seenCode.has(code)) continue;
    seenCode.add(code);
    candidates.push({
      recordId: record._id.toHexString(),
      lang: record.lang,
      submittedAt: record._id.getTimestamp().toISOString(),
      isOwn: record.uid === handler.user?._id,
    });
    if (candidates.length >= ACCEPTED_STD_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

async function loadAcceptedStdCode(
  handler: Handler,
  domainId: string,
  problemDocId: number,
  recordId: string,
): Promise<string | null> {
  if (!ObjectId.isValid(recordId)) return null;
  const record = await db.collection<AcceptedStdRecordLite>('record').findOne({
    ...acceptedStdRecordQuery(handler, domainId, problemDocId),
    _id: new ObjectId(recordId),
  }, {
    projection: { code: 1, lang: 1, uid: 1 },
  });
  const code = typeof record?.code === 'string' ? record.code.trim() : '';
  if (!code
    || code.startsWith('@@hydro_submission_file@@')
    || code.length > TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD) return null;
  return code;
}

interface ResolveStdRequestBody {
  problemKind?: string;
  providedStd?: string;
  acceptedStdRecordId?: string;
}

async function resolveRequestedStd(
  handler: Handler,
  domainId: string,
  pdoc: ProblemDocLite,
  body: ResolveStdRequestBody,
): Promise<{
  providedStd?: string;
  providedStdSource?: GenerateOptions['providedStdSource'];
  errorCode?: string;
  errorKey?: string;
}> {
  const manual = typeof body.providedStd === 'string' ? body.providedStd.trim() : '';
  const recordId = typeof body.acceptedStdRecordId === 'string' ? body.acceptedStdRecordId.trim() : '';
  if (manual && recordId) {
    return { errorCode: 'STD_SOURCE_CONFLICT', errorKey: 'ai_helper_testdata_err_std_source_conflict' };
  }
  if (!recordId) return {
    providedStd: manual || undefined,
    ...(manual ? { providedStdSource: 'manual' as const } : {}),
  };
  if (body.problemKind !== 'traditional') {
    return { errorCode: 'AC_STD_TRADITIONAL_ONLY', errorKey: 'ai_helper_testdata_err_ac_std_traditional_only' };
  }
  const acceptedCode = await loadAcceptedStdCode(handler, domainId, pdoc.docId, recordId);
  if (!acceptedCode) {
    return { errorCode: 'AC_STD_UNAVAILABLE', errorKey: 'ai_helper_testdata_err_ac_std_unavailable' };
  }
  return { providedStd: acceptedCode, providedStdSource: 'accepted-record' as const };
}

/**
 * 题目定位：支持数字 docId 与字符串 pid（如 D3102）
 */
async function findProblem(domainId: string, problemId: string): Promise<ProblemDocLite | null> {
  const coll = db.collection('document');
  const or: Record<string, unknown>[] = [{ pid: problemId }];
  const numericId = parseInt(problemId, 10);
  if (!Number.isNaN(numericId) && String(numericId) === problemId) {
    or.push({ docId: numericId });
  }
  const doc = await coll.findOne({ domainId, docType: DOC_TYPE_PROBLEM, $or: or });
  return (doc as unknown as ProblemDocLite) || null;
}

/**
 * 题面可能存储为多语言 JSON（{"zh": "...", "en": "..."}），做兼容解析
 */
export function extractStatementMarkdown(content: string | undefined): string {
  if (!content) return '';
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const zh = parsed.zh ?? parsed['zh_CN'] ?? parsed['zh-CN'];
      if (typeof zh === 'string' && zh.trim()) return zh;
      for (const value of Object.values(parsed)) {
        if (typeof value === 'string' && value.trim()) return value;
      }
    } catch {
      // 非 JSON，按原始 Markdown 处理
    }
  }
  return content;
}

/**
 * 权限检查：与 Hydro 题目文件上传一致。
 * 无权限时写好 403 响应并返回 false。
 */
function checkEditPermission(handler: Handler, pdoc: ProblemDocLite): boolean {
  const user = handler.user;
  const ownsProblem = user && typeof user.own === 'function'
    ? user.own(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)
    : false;
  const hasEditPerm = user && typeof user.hasPerm === 'function'
    ? user.hasPerm(PERM.PERM_EDIT_PROBLEM)
    : false;
  if (ownsProblem || hasEditPerm) return true;
  handler.response.status = 403;
  handler.response.body = {
    error: handler.translate('ai_helper_testdata_err_no_permission'),
    code: 'PERMISSION_DENIED',
  };
  handler.response.type = 'application/json';
  return false;
}

function sendError(handler: Handler, status: number, code: string, messageKey: string): void {
  handler.response.status = status;
  handler.response.body = { error: handler.translate(messageKey), code };
  handler.response.type = 'application/json';
}

const CPP_ORACLE_PROBE_SOURCE = '#include <iostream>\nint main() { return 0; }\n';

/** 每次生成只探测一次；任何非取消失败都按无编译能力降级，不影响 Python-only 路径。 */
async function probeCppOracleAvailability(
  runner: GoJudgeSandboxRunner,
  mode: TestdataGenerationMode,
  signal?: AbortSignal,
): Promise<boolean> {
  if (mode === 'direct') return false;
  let fileId: string | undefined;
  try {
    const result = await runner.compileCpp(CPP_ORACLE_PROBE_SOURCE, { signal });
    if (result.ok === false) return false;
    fileId = result.fileId;
    return true;
  } catch (err) {
    if (signal?.aborted || isCancellation(err)) throw err;
    return false;
  } finally {
    if (fileId) {
      try {
        await runner.deleteCachedFile(fileId);
      } catch {
        // 探针缓存清理失败由 go-judge TTL 兜底，不得阻断生成。
      }
    }
  }
}

function resolveTestdataUserMessage(
  translate: (key: string) => string,
  err: unknown,
): string | undefined {
  const key = extractTestdataUserMessageKey(err);
  if (!key) return undefined;
  const detail = extractTestdataUserMessageDetail(err);
  return detail ? `${translate(key)}\n${detail}` : translate(key);
}

// ─── TestdataGenContextHandler ────────────────────────────────────────────────

/**
 * GET /ai-helper/testdata-gen/context/:problemId
 * 返回题目标题、题面预览与已有测试数据文件名（供前端展示与冲突提示）
 */
export class TestdataGenContextHandler extends Handler {
  async get() {
    try {
      const domainId = getDomainId(this);
      const problemId = String(this.request.params.problemId || '');
      if (!problemId) {
        sendError(this, 400, 'INVALID_PROBLEM_ID', 'ai_helper_testdata_err_problem_not_found');
        return;
      }

      const pdoc = await findProblem(domainId, problemId);
      if (!pdoc) {
        sendError(this, 404, 'PROBLEM_NOT_FOUND', 'ai_helper_testdata_err_problem_not_found');
        return;
      }
      if (!checkEditPermission(this, pdoc)) return;

      const statement = extractStatementMarkdown(pdoc.content);
      const existingFiles = (pdoc.data || [])
        .map(f => String(f._id ?? f.name ?? ''))
        .filter(Boolean);
      const acceptedSolutions = await listAcceptedStdCandidates(this, domainId, pdoc.docId);
      const jobModel = this.ctx.get('testdataGenerationJobModel') as TestdataGenerationJobModel | undefined;
      let restorableJob: ReturnType<typeof serializeGenerationJob> | undefined;
      if (jobModel && typeof this.user?._id === 'number') {
        let savedJob = await jobModel.findRestorable(domainId, pdoc.docId, this.user._id);
        if (savedJob?.active && savedJob.leaseExpiresAt?.getTime() <= Date.now()) {
          await jobModel.markExpiredLeaseInterrupted(savedJob._id);
          savedJob = await jobModel.findRestorable(domainId, pdoc.docId, this.user._id);
        }
        if (savedJob) {
          restorableJob = { ...serializeGenerationJob(savedJob), plan: undefined };
        }
      }

      this.response.body = {
        problem: {
          docId: pdoc.docId,
          pid: pdoc.pid || String(pdoc.docId),
          title: pdoc.title || '',
          statementPreview: statement.slice(0, 300),
          hasStatement: statement.trim().length > 0,
          // 规则引擎初判：题面疑似含待完善（填空）代码，供前端提示
          fillInDetected: isFillInBlankProblem(statement),
        },
        existingFiles,
        acceptedSolutions,
        limits: {
          minCases: TESTDATA_GEN_LIMITS.MIN_CASES,
          maxCases: TESTDATA_GEN_LIMITS.MAX_CASES,
          maxExtraRequirements: TESTDATA_GEN_LIMITS.MAX_EXTRA_REQUIREMENTS,
          maxProvidedStd: TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD,
        },
        restorableJob,
      };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenContextHandler.get] error:', err);
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}

// ─── TestdataGenGenerateHandler ───────────────────────────────────────────────

interface GenerateRequestBody {
  problemId?: string;
  problemKind?: string;
  fillInMode?: string;
  caseCount?: number;
  dataScale?: string;
  languages?: string[];
  providedStd?: string;
  acceptedStdRecordId?: string;
  extraRequirements?: string;
  confirmDirectFallback?: boolean;
  resumeFromJobId?: string;
  replacesJobId?: string;
  /** @deprecated 旧版前端可能仍会发送；统一自适应流程会安全忽略。 */
  generationProfile?: string;
}

const backgroundGenerationControllers = new Map<string, AbortController>();
const TESTDATA_JOB_HEARTBEAT_MS = 30_000;

function buildCancellationJobError(
  translate: (key: string) => string,
): TestdataGenerationJobError {
  return {
    message: translate('ai_helper_err_ai_aborted'),
    code: 'CLIENT_ABORTED',
    failureCode: 'CANCELLED',
    stage: 'canceled',
    artifact: 'pipeline',
    retryPolicy: 'no-retry',
    retryable: false,
  };
}

function buildCancellationResponse(translate: (key: string) => string) {
  const { message, ...contract } = buildCancellationJobError(translate);
  return { error: message, ...contract };
}

type TestdataTelemetryFeature = 'testdata_gen' | 'testdata_skeleton' | 'testdata_apply';
const KNOWN_AI_ERROR_CATEGORIES = new Set([
  'auth', 'rate_limit', 'server', 'client', 'timeout', 'network', 'aborted', 'unknown',
]);

function isKnownAIErrorCategory(value: unknown): value is keyof typeof USER_ERROR_MESSAGE_KEYS {
  return typeof value === 'string' && KNOWN_AI_ERROR_CATEGORIES.has(value);
}

function captureTestdataGenerationFailure(
  ctx: unknown,
  feature: TestdataTelemetryFeature,
  err: unknown,
): void {
  const reporter = (ctx as {
    get?(name: string): { capture?: (...args: unknown[]) => void } | undefined;
  }).get?.('errorReporter');
  if (!reporter?.capture) return;
  const failure = extractTestdataFailureMetadata(err);
  if (failure) {
    reporter.capture(
      'api_failure',
      feature,
      'Typed test-data pipeline failure',
      undefined,
      undefined,
      {
        failureCode: failure.failureCode,
        stage: failure.stage,
        artifact: failure.artifact,
        retryPolicy: failure.retryPolicy,
        ...failure.safeDetails,
      },
    );
    return;
  }
  const safeMetadata: Record<string, unknown> = {};
  if (err instanceof AIServiceError) {
    safeMetadata.aiCategory = isKnownAIErrorCategory(err.category) ? err.category : 'unknown';
    if (typeof err.isRetryable === 'boolean') safeMetadata.retryable = err.isRetryable;
    const totalAttempts = err.context?.totalAttempts;
    if (
      typeof totalAttempts === 'number'
      && Number.isSafeInteger(totalAttempts)
      && totalAttempts >= 0
      && totalAttempts <= 1000
    ) {
      safeMetadata.attemptCount = totalAttempts;
    }
  }
  reporter.capture(
    'api_failure',
    feature,
    'Untyped test-data generation failure',
    undefined,
    err instanceof Error ? err.stack : undefined,
    safeMetadata,
  );
}

function testdataFailureModel(
  error: unknown,
  testdataMetadata: Record<string, unknown> | undefined,
  aiMetadata: Record<string, unknown> | undefined,
): TestdataTelemetryModel {
  const explicitRole = testdataMetadata?.modelTelemetryRole;
  const explicitIdentity = testdataMetadata?.modelTelemetryIdentity;
  if ((explicitRole === 'primary' || explicitRole === 'fallback')
    && typeof explicitIdentity === 'string' && explicitIdentity) {
    return { modelRole: explicitRole, modelIdentity: explicitIdentity };
  }
  const localAiContext = error instanceof AIServiceError ? error.context : undefined;
  const attempts = localAiContext?.attempts || aiMetadata?.attempts;
  const aiAttempts = Array.isArray(attempts)
    ? attempts.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const attempt = value as Record<string, unknown>;
      if (typeof attempt.model !== 'string' || !attempt.model) return [];
      return [typeof attempt.endpoint === 'string' && attempt.endpoint
        ? `${attempt.endpoint}/${attempt.model}`
        : attempt.model];
    })
    : [];
  const directModelName = localAiContext?.modelName
    || (typeof aiMetadata?.modelName === 'string' ? aiMetadata.modelName : undefined);
  const directEndpointId = localAiContext?.endpointId;
  const directModel = directModelName
    ? [directEndpointId ? `${directEndpointId}/${directModelName}` : directModelName]
    : [];
  const identities = [...new Set(aiAttempts.length > 0 ? aiAttempts : directModel)];
  return {
    modelRole: identities.length > 1 ? 'fallback' : 'primary',
    ...(identities.length > 0 ? { modelIdentity: identities[identities.length - 1] } : {}),
  };
}

function emitTestdataTelemetryBestEffort(action: (() => unknown) | undefined): void {
  if (!action) return;
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // Quality telemetry must never change generation, apply, or teacher-outcome behavior.
  }
}

function createTestdataTelemetrySession(input: {
  ctx: Handler['ctx'];
  runId: string;
  statement: string;
  options: GenerateOptions;
  existingConfig?: string;
  checkerArtifacts?: TestlibCheckerArtifacts;
  configuredMode: TestdataGenerationMode;
}): TestdataRunTelemetrySession | undefined {
  const telemetry = input.ctx.get('testdataRunTelemetry') as TestdataRunTelemetryService | undefined;
  if (!telemetry) return undefined;
  const reliabilityMode = getTestdataReliabilityMode();
  const customChecker = hasCustomChecker(input.existingConfig);
  const risk = assessTestdataRisk({
    statement: input.statement,
    hasCustomChecker: customChecker,
    unsupportedCustomChecker: customChecker && !getTestlibCheckerFilename(input.existingConfig),
    directFallbackEnabled: getTestdataDirectFallbackEnabled(),
    confirmDirectFallback: input.options.confirmDirectFallback,
    reliabilityMode,
  });
  return telemetry.createSession({
    runId: input.runId,
    ...(input.configuredMode === 'direct' || input.configuredMode === 'sandbox'
      ? { generationMode: input.configuredMode }
      : {}),
    reliabilityMode,
    riskTier: risk.tier,
    ...(input.options.problemKind === 'traditional' || input.options.problemKind === 'function'
      ? { problemKind: input.options.problemKind }
      : {}),
    hasSubtasks: risk.reasons.some(reason => reason.code === 'SUBTASKS'),
    hasCustomChecker: customChecker,
    hasSamples: extractStatementSamples(input.statement).length > 0,
    hasStatefulOperations: risk.reasons.some(reason => reason.code === 'STATEFUL_OPERATIONS'),
    statementLengthBucket: getStatementLengthBucket(input.statement.length),
    templateLanguagesRequested: [...input.options.languages],
    checkerConfigured: input.checkerArtifacts?.configured ?? false,
    checkerRead: input.checkerArtifacts?.read ?? false,
  });
}

function serializeGenerationPlan(plan: GenerationPlan | undefined) {
  if (!plan) return undefined;
  // Hashes/model identity and any future complete spec are server-only. The
  // browser receives only the bounded ProblemSpec summary declared on GenerationPlan.
  const {
    originalFileHashes: _serverOnlyHashes,
    modelTelemetry: _serverOnlyModelTelemetry,
    problemSpec: _serverOnlyProblemSpec,
    primarySpec: _serverOnlyPrimarySpec,
    criticSpec: _serverOnlyCriticSpec,
    resolvedSpec: _serverOnlyResolvedSpec,
    specConflicts: _serverOnlySpecConflicts,
    adjudication: _serverOnlyAdjudication,
    ...clientPlan
  } = plan as GenerationPlan & {
    problemSpec?: unknown;
    primarySpec?: unknown;
    criticSpec?: unknown;
    resolvedSpec?: unknown;
    specConflicts?: unknown;
    adjudication?: unknown;
  };
  return clientPlan;
}

function generationPlanForJobStorage(plan: GenerationPlan): GenerationPlan {
  // Runtime endpoint/model identity is needed only long enough to derive the
  // keyed telemetry hash. It must not become durable Job state.
  const { modelTelemetry: _runtimeOnlyModelTelemetry, ...storedPlan } = plan;
  return storedPlan;
}

function serializeGenerationJob(job: TestdataGenerationJob) {
  return {
    id: String(job._id),
    problemId: job.problemId,
    problemTitle: job.problemTitle,
    // 仅兼容服务升级时仍打开的旧版页面；新版不读取此字段，后端也不据此设置时限。
    generationProfile: 'hard' as const,
    status: job.status,
    progress: job.progress,
    error: job.error,
    plan: job.status === 'completed' ? serializeGenerationPlan(job.plan) : undefined,
    createdAt: job.createdAt?.toISOString?.() || job.createdAt,
    startedAt: job.startedAt?.toISOString?.() || job.startedAt,
    updatedAt: job.updatedAt?.toISOString?.() || job.updatedAt,
    progressUpdatedAt: job.progressUpdatedAt?.toISOString?.() || job.progressUpdatedAt,
    completedAt: job.completedAt?.toISOString?.() || job.completedAt,
  };
}

async function findAuthorizedGenerationJob(
  handler: Handler,
  jobModel: TestdataGenerationJobModel,
  jobId: string,
): Promise<{ job: TestdataGenerationJob; pdoc: ProblemDocLite } | null> {
  let job: TestdataGenerationJob | null;
  try {
    job = await jobModel.findById(jobId);
  } catch {
    job = null;
  }
  const domainId = getDomainId(handler);
  if (!job || job.domainId !== domainId || job.createdBy !== handler.user?._id) {
    sendError(handler, 404, 'JOB_NOT_FOUND', 'ai_helper_testdata_job_not_found');
    return null;
  }
  const pdoc = await findProblem(domainId, String(job.problemDocId));
  if (!pdoc) {
    sendError(handler, 404, 'PROBLEM_NOT_FOUND', 'ai_helper_testdata_err_problem_not_found');
    return null;
  }
  if (!checkEditPermission(handler, pdoc)) return null;
  if (job.active && job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= Date.now()) {
    await jobModel.markExpiredLeaseInterrupted(job._id);
    job = await jobModel.findById(job._id);
    if (!job) return null;
  }
  return { job, pdoc };
}

interface BackgroundGenerationParams {
  ctx: Handler['ctx'];
  jobModel: TestdataGenerationJobModel;
  job: TestdataGenerationJob;
  pdoc: ProblemDocLite;
  statement: string;
  options: GenerateOptions;
  existingFiles: string[];
  checkpoint?: TestdataGenerationCheckpoint;
  checkpointHashes: TestdataCheckpointHashes;
  checkerArtifacts?: TestlibCheckerArtifacts;
  mutationGateMode: MutationGateMode;
  historicalMutationCandidates: HistoricalMutationCandidate[];
  translate: (key: string) => string;
}

async function runBackgroundGeneration(params: BackgroundGenerationParams): Promise<void> {
  const {
    ctx, jobModel, job, pdoc, statement, options, existingFiles,
    checkpoint, checkpointHashes, checkerArtifacts, mutationGateMode,
    historicalMutationCandidates, translate,
  } = params;
  const jobId = String(job._id);
  const generationMode = getTestdataGenerationMode();
  const telemetrySession = createTestdataTelemetrySession({
    ctx,
    runId: job.runId,
    statement,
    options,
    existingConfig: pdoc.config,
    checkerArtifacts,
    configuredMode: generationMode,
  });
  emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.start()));
  const ac = new AbortController();
  backgroundGenerationControllers.set(jobId, ac);
  let progressWrites = Promise.resolve();
  let checkpointWrites = Promise.resolve();
  let checkpointRevision = 0;
  const checkpointPayload: TestdataGenerationCheckpointPayload = {};
  let checkpointMetadata: Pick<TestdataGenerationCheckpointEnvelope,
    'checkpointSchemaVersion' | 'promptVersion' | 'statementHash' | 'specHash' | 'roleDependencies'> = {};
  if (checkpoint?.checkpointSchemaVersion === TESTDATA_CHECKPOINT_SCHEMA_VERSION) {
    checkpointMetadata = {
      checkpointSchemaVersion: checkpoint.checkpointSchemaVersion,
      promptVersion: checkpoint.promptVersion,
      statementHash: checkpoint.statementHash,
      specHash: checkpoint.specHash,
      roleDependencies: checkpoint.roleDependencies,
    };
  }
  for (const key of ['solution', 'artifacts', 'verifier', 'killTargets'] as const) {
    if (checkpoint?.[key] !== undefined) checkpointPayload[key] = checkpoint[key] as never;
  }
  const persistCheckpoint = (
    update: TestdataGenerationCheckpointPayload | null,
  ): Promise<void> => {
    if (update === null) {
      for (const key of ['solution', 'artifacts', 'verifier', 'killTargets'] as const) {
        delete checkpointPayload[key];
      }
      checkpointMetadata = {};
    } else {
      for (const key of ['solution', 'artifacts', 'verifier', 'killTargets'] as const) {
        if (update[key] !== undefined) checkpointPayload[key] = update[key] as never;
      }
      if (update.checkpointSchemaVersion === TESTDATA_CHECKPOINT_SCHEMA_VERSION) {
        checkpointMetadata = {
          checkpointSchemaVersion: update.checkpointSchemaVersion,
          promptVersion: update.promptVersion,
          statementHash: update.statementHash,
          specHash: update.specHash,
          roleDependencies: update.roleDependencies,
        };
      }
    }
    const envelope: TestdataGenerationCheckpointEnvelope = {
      revision: ++checkpointRevision,
      ...checkpointMetadata,
      ...checkpointPayload,
    };
    checkpointWrites = checkpointWrites
      .then(() => jobModel.updateCheckpoint(job._id, checkpointHashes, envelope))
      .catch(err => {
        console.warn('[TestdataGenJob] checkpoint update failed:', err);
      });
    return checkpointWrites;
  };
  const heartbeatTimer = setInterval(() => {
    jobModel.renewLease(job._id).then(active => {
      if (!active) ac.abort();
    }).catch(err => {
      console.warn('[TestdataGenJob] lease renewal failed:', err);
    });
  }, TESTDATA_JOB_HEARTBEAT_MS);

  try {
    await jobModel.markRunning(job._id);
    ctx.get('featureStatsModel')?.recordAttempt('testdata_generation').catch(() => { /* best-effort */ });
    const reliabilityMode = getTestdataReliabilityMode();
    const sandboxHost = String(SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
    const sandboxRunner = new GoJudgeSandboxRunner(sandboxHost);
    const [aiClient, roleClients, cppOracleAvailable] = await Promise.all([
      createMultiModelClientFromConfig(ctx, undefined, 'testdataGeneration'),
      reliabilityMode === 'legacy'
        ? Promise.resolve(undefined)
        : createTestdataRoleClientsFromConfig(ctx),
      probeCppOracleAvailability(sandboxRunner, generationMode, ac.signal),
    ]);
    const service = new TestdataGenService(aiClient, {
      sandboxRunner,
      mode: generationMode,
      cppOracleAvailable,
      reliabilityMode,
      roleClients,
    });
    const plan = await service.generate({
      runId: job.runId,
      problemTitle: pdoc.title || job.problemId,
      statementMarkdown: statement,
      options,
      existingFiles,
      existingConfig: pdoc.config,
      checkerArtifacts,
      mutationGateMode,
      historicalMutationCandidates,
      fillInDetected: isFillInBlankProblem(statement),
      signal: ac.signal,
      checkpoint,
      onCheckpoint: persistCheckpoint,
      onProgress: progress => {
        emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.progress(progress)));
        progressWrites = progressWrites
          .then(() => jobModel.updateProgress(job._id, progress))
          .catch(err => console.warn('[TestdataGenJob] progress update failed:', err));
      },
      onProblemSpecObservation: observation => {
        telemetrySession?.observeProblemSpec?.(observation);
      },
    });
    await checkpointWrites;
    await progressWrites;
    if (ac.signal.aborted) {
      throw Object.assign(new Error('canceled'), { name: 'AbortError' });
    }
    const saved = await jobModel.complete(job._id, generationPlanForJobStorage(plan));
    if (!saved) return;
    emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.complete(plan)));

    ctx.get('featureStatsModel')?.recordSuccess('testdata_generation').catch(() => { /* best-effort */ });
    const successfulModel = typeof plan.usedModel === 'string'
      ? plan.usedModel.split(' → ').pop()?.trim()
      : undefined;
    const escalatedFromModel = plan.verification?.modelEscalation?.fromModel;
    if (escalatedFromModel) {
      ctx.get('featureStatsModel')?.recordModelOutcome?.(
        'testdata_generation', escalatedFromModel, false,
      ).catch(() => { /* best-effort */ });
    }
    ctx.get('featureStatsModel')?.recordModelOutcome?.(
      'testdata_generation', successfulModel || '', true,
    ).catch(() => { /* best-effort */ });
  } catch (err) {
    await checkpointWrites;
    if (isCancellation(err)) {
      emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.fail(err)));
      await jobModel.cancel(job._id, buildCancellationJobError(translate));
      return;
    }

    console.error('[TestdataGenJob] generation failed:', err);
    const testdataMetadata = extractTestdataErrorMetadata(err);
    const failureMetadata = extractTestdataFailureMetadata(err);
    const testdataUserMessageKey = extractTestdataUserMessageKey(err);
    const testdataUserMessage = resolveTestdataUserMessage(translate, err);
    const aiMetadata = extractAiErrorMetadata(err);
    const usedModels = Array.isArray(testdataMetadata?.usedModels)
      ? testdataMetadata.usedModels.filter((item): item is string => typeof item === 'string')
      : [];
    const failedModel = usedModels[usedModels.length - 1]
      || (typeof aiMetadata?.modelName === 'string' ? aiMetadata.modelName : '');
    ctx.get('featureStatsModel')?.recordModelOutcome?.(
      'testdata_generation', failedModel, false,
    ).catch(() => { /* best-effort */ });
    captureTestdataGenerationFailure(ctx, 'testdata_gen', err);
    emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.fail(
      err,
      testdataFailureModel(err, testdataMetadata, aiMetadata),
    )));

    const jobError: TestdataGenerationJobError = err instanceof AIServiceError
      ? {
        message: translate(USER_ERROR_MESSAGE_KEYS[err.category]),
        code: 'AI_SERVICE_ERROR',
        category: err.category,
        retryable: err.isRetryable,
      }
      : {
        message: testdataUserMessageKey
          ? testdataUserMessage as string
          : err instanceof Error ? err.message : translate('ai_helper_err_internal'),
        code: 'GENERATION_FAILED',
        ...(failureMetadata ? {
          failureCode: failureMetadata.failureCode,
          stage: failureMetadata.stage,
          artifact: failureMetadata.artifact,
          retryPolicy: failureMetadata.retryPolicy,
        } : {}),
        retryable: failureMetadata?.retryPolicy !== 'no-retry',
        recommendDeeperReasoning: shouldRecommendDeeperReasoning(err),
      };
    await jobModel.fail(job._id, jobError);
  } finally {
    clearInterval(heartbeatTimer);
    if (backgroundGenerationControllers.get(jobId) === ac) {
      backgroundGenerationControllers.delete(jobId);
    }
  }
}

/**
 * POST /ai-helper/testdata-gen/generate
 * 调用 AI 生成文件计划并返回（不写入任何文件）
 */
export class TestdataGenGenerateHandler extends Handler {
  async post() {
    let progressStream: SSEWriter | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let streamRawRes: ServerResponse | undefined;
    let streamCloseListener: (() => void) | undefined;
    let telemetrySession: TestdataRunTelemetrySession | undefined;
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const domainId = getDomainId(this);
      const body = (this.request.body || {}) as GenerateRequestBody;

      const problemId = String(body.problemId || '');
      if (!problemId) {
        sendError(this, 400, 'INVALID_PROBLEM_ID', 'ai_helper_testdata_err_problem_not_found');
        return;
      }

      const pdoc = await findProblem(domainId, problemId);
      if (!pdoc) {
        sendError(this, 404, 'PROBLEM_NOT_FOUND', 'ai_helper_testdata_err_problem_not_found');
        return;
      }
      assertExistingConfigParsable(pdoc.config);
      if (!checkEditPermission(this, pdoc)) return;

      // AI 生成开销大：限制每人每 5 分钟 5 次
      if (await applyRateLimit(this, {
        op: 'ai_testdata_gen', periodSecs: 300, maxOps: 5,
        errorMessage: 'ai_helper_testdata_err_rate_limited',
      })) return;

      const resolvedStd = await resolveRequestedStd(this, domainId, pdoc, body);
      if (resolvedStd.errorCode && resolvedStd.errorKey) {
        sendError(this, 400, resolvedStd.errorCode, resolvedStd.errorKey);
        return;
      }
      const options: GenerateOptions = {
        problemKind: (body.problemKind || 'auto') as GenerateOptions['problemKind'],
        fillInMode: (body.fillInMode || 'auto') as GenerateOptions['fillInMode'],
        caseCount: Number(body.caseCount ?? 10),
        dataScale: (body.dataScale || 'auto') as GenerateOptions['dataScale'],
        languages: Array.isArray(body.languages)
          ? (body.languages.filter(l => (SUPPORTED_TEMPLATE_LANGS as readonly string[]).includes(l)) as TemplateLang[])
          : [...SUPPORTED_TEMPLATE_LANGS],
        providedStd: resolvedStd.providedStd,
        providedStdSource: resolvedStd.providedStdSource,
        extraRequirements: typeof body.extraRequirements === 'string' ? body.extraRequirements : undefined,
        confirmDirectFallback: body.confirmDirectFallback === true,
      };
      const optionError = validateGenerateOptions(options);
      if (optionError) {
        sendError(this, 400, 'INVALID_OPTIONS', optionError);
        return;
      }

      const statement = extractStatementMarkdown(pdoc.content);
      if (!statement.trim()) {
        sendError(this, 400, 'EMPTY_STATEMENT', 'ai_helper_testdata_err_empty_statement');
        return;
      }
      const mutationGateMode = getMutationGateMode(
        process.env.AI_HELPER_TESTDATA_MUTATION_GATE,
      );
      const historicalMutationCandidates = mutationGateMode === 'off'
        ? []
        : await loadHistoricalMutationCandidates(this, domainId, pdoc.docId);

      this.ctx.get('featureStatsModel')?.recordAttempt('testdata_generation').catch(() => { /* best-effort */ });

      const sandboxHost = String(SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
      const sandboxRunner = new GoJudgeSandboxRunner(sandboxHost);
      const generationMode = getTestdataGenerationMode();
      const existingFiles = (pdoc.data || [])
        .map(f => String(f._id ?? f.name ?? ''))
        .filter(Boolean);

      // 请求级取消：客户端断开时中止 AI 调用与沙箱管线，避免白跑。
      // 关键：不能用 req 的 'close'/destroyed 判断断开——POST body 被 body-parser
      // 读完后，请求可读流会按正常生命周期置 destroyed=true 并触发 'close'，此时
      // 客户端仍在等响应。真实断开只能看响应连接：res 'close' 且响应尚未写完。
      const requestAc = new AbortController();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const koaCtx = (this as any).context;
      const rawReq = koaCtx?.req;
      const rawRes: ServerResponse | undefined = koaCtx?.res;
      streamRawRes = rawRes;
      // 挂监听前补一次检查：前序 DB/配置操作期间客户端可能已真实断开
      // （aborted / 底层 socket 已销毁），此时直接 499，不白跑整条管线。
      if (rawReq?.aborted || rawReq?.socket?.destroyed) {
        this.response.status = 499;
        this.response.body = buildCancellationResponse(key => this.translate(key));
        this.response.type = 'application/json';
        return;
      }
      streamCloseListener = () => { if (!rawRes?.writableEnded) requestAc.abort(); };
      rawRes?.on?.('close', streamCloseListener);

      const accept = String(this.request.headers?.accept || '').toLowerCase();
      if (accept.includes('text/event-stream') && rawRes) {
        koaCtx.respond = false;
        if ('compress' in koaCtx) koaCtx.compress = false;
        rawReq?.socket?.setNoDelay?.(true);
        rawReq?.socket?.setTimeout?.(0);
        progressStream = createSSEWriter(rawRes);
        keepaliveTimer = setInterval(() => {
          progressStream?.writeComment('keepalive');
        }, API_DEFAULTS.SSE_KEEPALIVE_INTERVAL_MS);
      }

      const checkerArtifacts = await loadTestlibCheckerArtifacts(domainId, pdoc);
      const runId = createTestdataRunId();
      telemetrySession = createTestdataTelemetrySession({
        ctx: this.ctx,
        runId,
        statement,
        options,
        existingConfig: pdoc.config,
        checkerArtifacts,
        configuredMode: generationMode,
      });
      emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.start()));
      const reliabilityMode = getTestdataReliabilityMode();
      const [aiClient, roleClients, cppOracleAvailable] = await Promise.all([
        createMultiModelClientFromConfig(this.ctx, undefined, 'testdataGeneration'),
        reliabilityMode === 'legacy'
          ? Promise.resolve(undefined)
          : createTestdataRoleClientsFromConfig(this.ctx),
        probeCppOracleAvailability(sandboxRunner, generationMode, requestAc.signal),
      ]);
      const service = new TestdataGenService(aiClient, {
        sandboxRunner,
        mode: generationMode,
        cppOracleAvailable,
        reliabilityMode,
        roleClients,
      });
      const plan = await service.generate({
        runId,
        problemTitle: pdoc.title || problemId,
        statementMarkdown: statement,
        options,
        existingFiles,
        existingConfig: pdoc.config,
        checkerArtifacts,
        mutationGateMode,
        historicalMutationCandidates,
        fillInDetected: isFillInBlankProblem(statement),
        signal: requestAc.signal,
        onProgress: progress => {
          emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.progress(progress)));
          progressStream?.writeEvent('progress', progress);
        },
        onProblemSpecObservation: observation => {
          telemetrySession?.observeProblemSpec?.(observation);
        },
      });
      emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.complete(plan)));

      this.ctx.get('featureStatsModel')?.recordSuccess('testdata_generation').catch(() => { /* best-effort */ });
      const successfulModel = typeof plan.usedModel === 'string'
        ? plan.usedModel.split(' → ').pop()?.trim()
        : undefined;
      const escalatedFromModel = plan.verification?.modelEscalation?.fromModel;
      if (escalatedFromModel) {
        this.ctx.get('featureStatsModel')?.recordModelOutcome?.(
          'testdata_generation', escalatedFromModel, false,
        ).catch(() => { /* best-effort */ });
      }
      this.ctx.get('featureStatsModel')?.recordModelOutcome?.(
        'testdata_generation', successfulModel || '', true,
      ).catch(() => { /* best-effort */ });

      if (progressStream) {
        progressStream.writeEvent('result', { plan: serializeGenerationPlan(plan) });
        progressStream.end();
      } else {
        this.response.body = { plan: serializeGenerationPlan(plan) };
        this.response.type = 'application/json';
      }
    } catch (err) {
      // 客户端主动断开：非故障，不上报也不打 error 日志
      if (isCancellation(err)) {
        emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.fail(err)));
        if (progressStream) {
          progressStream.writeEvent('error', buildCancellationResponse(key => this.translate(key)));
          progressStream.end();
        } else {
          this.response.status = 499;
          this.response.body = buildCancellationResponse(key => this.translate(key));
          this.response.type = 'application/json';
        }
        return;
      }
      console.error('[TestdataGenGenerateHandler.post] error:', err);
      const testdataMetadata = extractTestdataErrorMetadata(err);
      const failureMetadata = extractTestdataFailureMetadata(err);
      const testdataUserMessageKey = extractTestdataUserMessageKey(err);
      const testdataUserMessage = resolveTestdataUserMessage(
        key => this.translate(key),
        err,
      );
      const aiMetadata = extractAiErrorMetadata(err);
      const usedModels = Array.isArray(testdataMetadata?.usedModels)
        ? testdataMetadata.usedModels.filter((item): item is string => typeof item === 'string')
        : [];
      const failedModel = usedModels[usedModels.length - 1]
        || (typeof aiMetadata?.modelName === 'string' ? aiMetadata.modelName : '');
      this.ctx.get('featureStatsModel')?.recordModelOutcome?.(
        'testdata_generation', failedModel, false,
      ).catch(() => { /* best-effort */ });
      captureTestdataGenerationFailure(this.ctx, 'testdata_gen', err);
      emitTestdataTelemetryBestEffort(telemetrySession && (() => telemetrySession.fail(
        err,
        testdataFailureModel(err, testdataMetadata, aiMetadata),
      )));
      if (err instanceof AIServiceError) {
        const errorBody = {
          error: this.translate(USER_ERROR_MESSAGE_KEYS[err.category]),
          code: 'AI_SERVICE_ERROR',
          category: err.category,
          retryable: err.isRetryable,
        };
        if (progressStream) {
          progressStream.writeEvent('error', errorBody);
          progressStream.end();
        } else {
          this.response.status = getHttpStatusForCategory(err.category);
          this.response.body = errorBody;
          this.response.type = 'application/json';
        }
        return;
      }
      // 解析/校验失败等业务错误：消息为中文可直接展示
      const errorBody = {
        error: testdataUserMessageKey
          ? testdataUserMessage as string
          : err instanceof Error ? err.message : this.translate('ai_helper_err_internal'),
        code: 'GENERATION_FAILED',
        ...(failureMetadata ? {
          failureCode: failureMetadata.failureCode,
          stage: failureMetadata.stage,
          artifact: failureMetadata.artifact,
          retryPolicy: failureMetadata.retryPolicy,
        } : {}),
        retryable: failureMetadata?.retryPolicy !== 'no-retry',
        recommendDeeperReasoning: shouldRecommendDeeperReasoning(err),
      };
      if (progressStream) {
        progressStream.writeEvent('error', errorBody);
        progressStream.end();
      } else {
        this.response.status = (err as { userMessageKey?: string } | null)?.userMessageKey
          ? 400
          : 502;
        this.response.body = errorBody;
        this.response.type = 'application/json';
      }
    } finally {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (streamRawRes && streamCloseListener) {
        streamRawRes.removeListener?.('close', streamCloseListener);
      }
    }
  }
}

// ─── Persistent background generation jobs ───────────────────────────────────

/** POST /ai-helper/testdata-gen/jobs - 创建后台任务并立即返回任务 ID。 */
export class TestdataGenJobStartHandler extends Handler {
  async post() {
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const domainId = getDomainId(this);
      const body = (this.request.body || {}) as GenerateRequestBody;
      const problemId = String(body.problemId || '');
      if (!problemId) {
        sendError(this, 400, 'INVALID_PROBLEM_ID', 'ai_helper_testdata_err_problem_not_found');
        return;
      }
      const pdoc = await findProblem(domainId, problemId);
      if (!pdoc) {
        sendError(this, 404, 'PROBLEM_NOT_FOUND', 'ai_helper_testdata_err_problem_not_found');
        return;
      }
      assertExistingConfigParsable(pdoc.config);
      if (!checkEditPermission(this, pdoc)) return;

      const jobModel = this.ctx.get('testdataGenerationJobModel') as TestdataGenerationJobModel | undefined;
      if (!jobModel) {
        sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
        return;
      }

      let existingJob = await jobModel.findRestorable(domainId, pdoc.docId, this.user?._id);
      if (existingJob?.active && existingJob.leaseExpiresAt?.getTime() <= Date.now()) {
        await jobModel.markExpiredLeaseInterrupted(existingJob._id);
        existingJob = null;
      }
      if (existingJob?.active) {
        this.response.body = { job: serializeGenerationJob(existingJob), created: false };
        this.response.type = 'application/json';
        return;
      }

      if (await applyRateLimit(this, {
        op: 'ai_testdata_gen', periodSecs: 300, maxOps: 5,
        errorMessage: 'ai_helper_testdata_err_rate_limited',
      })) return;

      const resolvedStd = await resolveRequestedStd(this, domainId, pdoc, body);
      if (resolvedStd.errorCode && resolvedStd.errorKey) {
        sendError(this, 400, resolvedStd.errorCode, resolvedStd.errorKey);
        return;
      }
      const options: GenerateOptions = {
        problemKind: (body.problemKind || 'auto') as GenerateOptions['problemKind'],
        fillInMode: (body.fillInMode || 'auto') as GenerateOptions['fillInMode'],
        caseCount: Number(body.caseCount ?? 10),
        dataScale: (body.dataScale || 'auto') as GenerateOptions['dataScale'],
        languages: Array.isArray(body.languages)
          ? (body.languages.filter(l => (SUPPORTED_TEMPLATE_LANGS as readonly string[]).includes(l)) as TemplateLang[])
          : [...SUPPORTED_TEMPLATE_LANGS],
        providedStd: resolvedStd.providedStd,
        providedStdSource: resolvedStd.providedStdSource,
        extraRequirements: typeof body.extraRequirements === 'string' ? body.extraRequirements : undefined,
        confirmDirectFallback: body.confirmDirectFallback === true,
      };
      const optionError = validateGenerateOptions(options);
      if (optionError) {
        sendError(this, 400, 'INVALID_OPTIONS', optionError);
        return;
      }
      const statement = extractStatementMarkdown(pdoc.content);
      if (!statement.trim()) {
        sendError(this, 400, 'EMPTY_STATEMENT', 'ai_helper_testdata_err_empty_statement');
        return;
      }
      const mutationGateMode = getMutationGateMode(
        process.env.AI_HELPER_TESTDATA_MUTATION_GATE,
      );
      const historicalMutationCandidates = mutationGateMode === 'off'
        ? []
        : await loadHistoricalMutationCandidates(this, domainId, pdoc.docId);
      const existingFiles = (pdoc.data || [])
        .map(f => String(f._id ?? f.name ?? ''))
        .filter(Boolean);
      const checkerArtifacts = await loadTestlibCheckerArtifacts(domainId, pdoc);
      const checkpointHashes = computeTestdataCheckpointHashes(options, statement, {
        existingConfig: pdoc.config,
        checkerArtifacts,
      });
      let checkpoint: TestdataGenerationCheckpoint | undefined;
      const resumeFromJobId = typeof body.resumeFromJobId === 'string'
        ? body.resumeFromJobId.trim()
        : '';
      if (resumeFromJobId) {
        try {
          const resumeJob = await jobModel.findById(resumeFromJobId);
          checkpoint = selectTestdataResumeCheckpoint(resumeJob, {
            domainId,
            problemDocId: pdoc.docId,
            problemId: pdoc.pid || String(pdoc.docId),
            createdBy: this.user?._id,
            ...checkpointHashes,
            checkpointSchemaVersion: TESTDATA_CHECKPOINT_SCHEMA_VERSION,
            promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
            allowV1: getTestdataReliabilityMode() === 'legacy',
          });
        } catch {
          // 断点 ID、作用域或内容异常都静默退回全新生成，不向外泄露任务信息。
        }
      }
      let replacedJob: TestdataGenerationJob | undefined;
      const replacesJobId = typeof body.replacesJobId === 'string'
        ? body.replacesJobId.trim()
        : '';
      if (replacesJobId) {
        const authorized = await findAuthorizedGenerationJob(this, jobModel, replacesJobId);
        if (!authorized) return;
        if (authorized.job.status !== 'completed') {
          sendError(this, 400, 'JOB_RESULT_UNAVAILABLE', 'ai_helper_testdata_job_result_unavailable');
          return;
        }
        replacedJob = authorized.job;
      }
      let regeneratedOutcome: Awaited<ReturnType<
        TestdataGenerationJobModel['recordTeacherOutcome']
      >> | undefined;
      if (replacedJob) {
        try {
          regeneratedOutcome = await jobModel.recordTeacherOutcome(replacedJob._id, {
            eventId: createTestdataEventId(),
            outcome: 'regenerated',
          });
        } catch (err) {
          console.error('[TestdataGenJob] regenerated outcome persistence failed:', err);
          sendError(
            this,
            500,
            'REGENERATION_OUTCOME_PERSIST_FAILED',
            'ai_helper_err_internal',
          );
          return;
        }
        if (regeneratedOutcome.state === 'conflict') {
          sendError(
            this,
            409,
            'OUTCOME_ALREADY_RECORDED',
            'ai_helper_testdata_outcome_already_recorded',
          );
          return;
        }
      }
      const { job, created } = await jobModel.createOrGetActive({
        domainId,
        problemDocId: pdoc.docId,
        problemId: pdoc.pid || String(pdoc.docId),
        problemTitle: pdoc.title || problemId,
        createdBy: this.user?._id,
      });

      if (replacedJob && regeneratedOutcome) {
        const telemetry = this.ctx.get('testdataRunTelemetry') as TestdataRunTelemetryService | undefined;
        emitTestdataTelemetryBestEffort(telemetry && (() => telemetry.emitTeacherOutcome({
          runId: replacedJob.runId,
          eventId: regeneratedOutcome.record.eventId,
          occurredAt: regeneratedOutcome.record.recordedAt,
          outcome: regeneratedOutcome.record.outcome,
        })));
      }

      if (created) {
        // 只保留后台任务真正需要的翻译文本，避免长任务闭包持有整个请求 Handler。
        const backgroundTranslations: Record<string, string> = {
          ai_helper_err_internal: this.translate('ai_helper_err_internal'),
          [TESTDATA_CONFIG_UNPARSABLE_KEY]: this.translate(TESTDATA_CONFIG_UNPARSABLE_KEY),
          [CPP_ORACLE_UNAVAILABLE_KEY]: this.translate(CPP_ORACLE_UNAVAILABLE_KEY),
          [CPP_PROVIDED_STD_COMPILE_FAILED_KEY]: this.translate(CPP_PROVIDED_STD_COMPILE_FAILED_KEY),
          [CPP_ORACLE_INFRA_FAILURE_KEY]: this.translate(CPP_ORACLE_INFRA_FAILURE_KEY),
        };
        for (const key of Object.values(USER_ERROR_MESSAGE_KEYS)) {
          backgroundTranslations[key] = this.translate(key);
        }
        for (const code of TESTDATA_FAILURE_CODES) {
          const key = getUserMessageKeyForFailure(code);
          backgroundTranslations[key] = this.translate(key);
        }
        void runBackgroundGeneration({
          ctx: this.ctx,
          jobModel,
          job,
          pdoc,
          statement,
          options,
          existingFiles,
          checkpoint,
          checkpointHashes,
          checkerArtifacts,
          mutationGateMode,
          historicalMutationCandidates,
          translate: key => backgroundTranslations[key] || key,
        }).catch(err => {
          console.error('[TestdataGenJob] unhandled background failure:', err);
        });
      }
      this.response.status = created ? 202 : 200;
      this.response.body = { job: serializeGenerationJob(job), created };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenJobStartHandler.post] error:', err);
      const testdataUserMessageKey = extractTestdataUserMessageKey(err);
      if (testdataUserMessageKey) {
        sendError(this, 400, 'INVALID_EXISTING_CONFIG', testdataUserMessageKey);
        return;
      }
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}

/** GET /ai-helper/testdata-gen/jobs/:jobId - 查询进度或完整结果。 */
export class TestdataGenJobStatusHandler extends Handler {
  async get() {
    try {
      const jobModel = this.ctx.get('testdataGenerationJobModel') as TestdataGenerationJobModel | undefined;
      if (!jobModel) {
        sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
        return;
      }
      const authorized = await findAuthorizedGenerationJob(
        this, jobModel, String(this.request.params.jobId || ''),
      );
      if (!authorized) return;
      this.response.body = { job: serializeGenerationJob(authorized.job) };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenJobStatusHandler.get] error:', err);
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}

/** POST /ai-helper/testdata-gen/jobs/:jobId/cancel - 跨页面、跨进程请求取消。 */
export class TestdataGenJobCancelHandler extends Handler {
  async post() {
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const jobModel = this.ctx.get('testdataGenerationJobModel') as TestdataGenerationJobModel | undefined;
      if (!jobModel) {
        sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
        return;
      }
      const jobId = String(this.request.params.jobId || '');
      const authorized = await findAuthorizedGenerationJob(this, jobModel, jobId);
      if (!authorized) return;
      await jobModel.cancel(
        authorized.job._id,
        buildCancellationJobError(key => this.translate(key)),
      );
      backgroundGenerationControllers.get(jobId)?.abort();
      const updated = await jobModel.findById(authorized.job._id);
      this.response.body = { job: updated ? serializeGenerationJob(updated) : undefined };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenJobCancelHandler.post] error:', err);
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}

/** POST /ai-helper/testdata-gen/jobs/:jobId/dismiss - 放弃尚未写入的预览。 */
export class TestdataGenJobDismissHandler extends Handler {
  async post() {
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const jobModel = this.ctx.get('testdataGenerationJobModel') as TestdataGenerationJobModel | undefined;
      if (!jobModel) {
        sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
        return;
      }
      const authorized = await findAuthorizedGenerationJob(
        this, jobModel, String(this.request.params.jobId || ''),
      );
      if (!authorized) return;
      if (authorized.job.status !== 'completed') {
        sendError(this, 400, 'JOB_RESULT_UNAVAILABLE', 'ai_helper_testdata_job_result_unavailable');
        return;
      }
      const allowedReasons = new Set<TestdataTeacherOutcomeReason>([
        'wrong_answer', 'invalid_input', 'weak_coverage',
        'template_problem', 'checker_problem', 'other',
      ]);
      const rawReason = (this.request.body as { reason?: unknown } | undefined)?.reason;
      const reason = rawReason === undefined || rawReason === ''
        ? undefined
        : typeof rawReason === 'string' && allowedReasons.has(rawReason as TestdataTeacherOutcomeReason)
          ? rawReason as TestdataTeacherOutcomeReason
          : null;
      if (reason === null) {
        sendError(this, 400, 'INVALID_OUTCOME_REASON', 'ai_helper_testdata_outcome_invalid_reason');
        return;
      }
      const outcome = await jobModel.recordTeacherOutcome(authorized.job._id, {
        eventId: createTestdataEventId(),
        outcome: 'discarded',
        ...(reason ? { reason } : {}),
      });
      if (outcome.state === 'conflict') {
        sendError(this, 409, 'OUTCOME_ALREADY_RECORDED', 'ai_helper_testdata_outcome_already_recorded');
        return;
      }
      const telemetry = this.ctx.get('testdataRunTelemetry') as TestdataRunTelemetryService | undefined;
      emitTestdataTelemetryBestEffort(telemetry && (() => telemetry.emitTeacherOutcome({
        runId: authorized.job.runId,
        eventId: outcome.record.eventId,
        occurredAt: outcome.record.recordedAt,
        outcome: outcome.record.outcome,
        reason: outcome.record.reason,
      })));
      await jobModel.dismiss(authorized.job._id);
      this.response.body = { dismissed: true, outcome: outcome.state };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenJobDismissHandler.post] error:', err);
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}

// ─── TestdataGenSkeletonHandler ───────────────────────────────────────────────

/**
 * POST /ai-helper/testdata-gen/skeleton
 * AI 故障降级方案：不调用 AI，确定性生成结构性文件（compile.sh /
 * config.yaml / 模板骨架）与空白测试点，数据内容由教师在预览中手动填写。
 * 无需限流（无 AI 开销）、不要求题面非空。
 */
export class TestdataGenSkeletonHandler extends Handler {
  async post() {
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const domainId = getDomainId(this);
      const body = (this.request.body || {}) as GenerateRequestBody;

      const problemId = String(body.problemId || '');
      if (!problemId) {
        sendError(this, 400, 'INVALID_PROBLEM_ID', 'ai_helper_testdata_err_problem_not_found');
        return;
      }

      const pdoc = await findProblem(domainId, problemId);
      if (!pdoc) {
        sendError(this, 404, 'PROBLEM_NOT_FOUND', 'ai_helper_testdata_err_problem_not_found');
        return;
      }
      if (!checkEditPermission(this, pdoc)) return;

      const resolvedStd = await resolveRequestedStd(this, domainId, pdoc, body);
      if (resolvedStd.errorCode && resolvedStd.errorKey) {
        sendError(this, 400, resolvedStd.errorCode, resolvedStd.errorKey);
        return;
      }
      const options: GenerateOptions = {
        problemKind: (body.problemKind || 'auto') as GenerateOptions['problemKind'],
        fillInMode: (body.fillInMode || 'auto') as GenerateOptions['fillInMode'],
        caseCount: Number(body.caseCount ?? 10),
        dataScale: (body.dataScale || 'auto') as GenerateOptions['dataScale'],
        languages: Array.isArray(body.languages)
          ? (body.languages.filter(l => (SUPPORTED_TEMPLATE_LANGS as readonly string[]).includes(l)) as TemplateLang[])
          : [...SUPPORTED_TEMPLATE_LANGS],
        providedStd: resolvedStd.providedStd,
        providedStdSource: resolvedStd.providedStdSource,
      };
      const optionError = validateGenerateOptions(options);
      if (optionError) {
        sendError(this, 400, 'INVALID_OPTIONS', optionError);
        return;
      }

      this.ctx.get('featureStatsModel')?.recordAttempt('testdata_skeleton').catch(() => { /* best-effort */ });
      const existingFiles = (pdoc.data || [])
        .map(f => String(f._id ?? f.name ?? ''))
        .filter(Boolean);
      const plan = buildSkeletonPlan(options, extractStatementMarkdown(pdoc.content), existingFiles, pdoc.config);
      this.ctx.get('featureStatsModel')?.recordSuccess('testdata_skeleton').catch(() => { /* best-effort */ });

      this.response.body = { plan: serializeGenerationPlan(plan) };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenSkeletonHandler.post] error:', err);
      captureTestdataGenerationFailure(this.ctx, 'testdata_skeleton', err);
      const testdataUserMessageKey = extractTestdataUserMessageKey(err);
      if (testdataUserMessageKey) {
        sendError(this, 400, 'INVALID_EXISTING_CONFIG', testdataUserMessageKey);
        return;
      }
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}

// ─── TestdataGenApplyHandler ──────────────────────────────────────────────────

interface ApplyRequestBody {
  problemId?: string;
  jobId?: string;
  files?: Array<{ name?: string; content?: string }>;
}

/**
 * POST /ai-helper/testdata-gen/apply
 * 将（教师确认/编辑后的）文件写入题目测试数据。
 * 通过 ProblemModel.addTestdata 写入，config.yaml 会由 Hydro 自动同步到评测设置。
 */
export class TestdataGenApplyHandler extends Handler {
  async post() {
    let claimedJobModel: TestdataGenerationJobModel | undefined;
    let claimedJobId: TestdataGenerationJob['_id'] | undefined;
    let outcomeClaimId: string | undefined;
    let releaseOutcomeClaim = false;
    let outcomeClaimHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let outcomeClaimLeaseLost = false;
    let renewOutcomeClaim: (() => Promise<boolean>) | undefined;
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const domainId = getDomainId(this);
      const body = (this.request.body || {}) as ApplyRequestBody;

      const problemId = String(body.problemId || '');
      if (!problemId) {
        sendError(this, 400, 'INVALID_PROBLEM_ID', 'ai_helper_testdata_err_problem_not_found');
        return;
      }

      const pdoc = await findProblem(domainId, problemId);
      if (!pdoc) {
        sendError(this, 404, 'PROBLEM_NOT_FOUND', 'ai_helper_testdata_err_problem_not_found');
        return;
      }
      if (!checkEditPermission(this, pdoc)) return;

      let generationJob: TestdataGenerationJob | undefined;
      let generationJobModel: TestdataGenerationJobModel | undefined;
      const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
      if (jobId) {
        generationJobModel = this.ctx.get('testdataGenerationJobModel') as TestdataGenerationJobModel | undefined;
        if (!generationJobModel) {
          sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
          return;
        }
        const authorized = await findAuthorizedGenerationJob(this, generationJobModel, jobId);
        if (!authorized) return;
        if (authorized.job.problemDocId !== pdoc.docId || authorized.job.status !== 'completed') {
          sendError(this, 400, 'JOB_RESULT_UNAVAILABLE', 'ai_helper_testdata_job_result_unavailable');
          return;
        }
        if (authorized.job.teacherOutcome || authorized.job.appliedAt) {
          sendError(this, 409, 'OUTCOME_ALREADY_RECORDED', 'ai_helper_testdata_outcome_already_recorded');
          return;
        }
        generationJob = authorized.job;
      }

      const files = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) {
        sendError(this, 400, 'NO_FILES', 'ai_helper_testdata_err_no_files');
        return;
      }
      if (files.length > TESTDATA_GEN_LIMITS.MAX_FILE_COUNT) {
        sendError(this, 400, 'TOO_MANY_FILES', 'ai_helper_testdata_err_too_many_files');
        return;
      }

      // 逐个校验文件名与大小
      let totalSize = 0;
      const validated: Array<{ name: string; content: string }> = [];
      const seenNames = new Set<string>();
      for (const f of files) {
        const name = String(f.name || '');
        if (!isSafeTestdataFilename(name)) {
          sendError(this, 400, 'INVALID_FILENAME', 'ai_helper_testdata_err_invalid_filename');
          return;
        }
        if (seenNames.has(name)) continue; // 去重，保留首个
        seenNames.add(name);
        if (typeof f.content !== 'string') {
          sendError(this, 400, 'INVALID_CONTENT', 'ai_helper_testdata_err_invalid_content');
          return;
        }
        const content = normalizeFileContent(f.content);
        const size = Buffer.byteLength(content, 'utf-8');
        if (size > TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
          sendError(this, 400, 'FILE_TOO_LARGE', 'ai_helper_testdata_err_file_too_large');
          return;
        }
        totalSize += size;
        validated.push({ name, content });
      }
      if (totalSize > TESTDATA_GEN_LIMITS.MAX_TOTAL_SIZE) {
        sendError(this, 400, 'TOTAL_TOO_LARGE', 'ai_helper_testdata_err_total_too_large');
        return;
      }

      if (generationJob && generationJobModel) {
        outcomeClaimId = createTestdataEventId();
        const claimed = await generationJobModel.claimTeacherOutcome(
          generationJob._id,
          outcomeClaimId,
        );
        if (!claimed) {
          sendError(this, 409, 'OUTCOME_ALREADY_RECORDED', 'ai_helper_testdata_outcome_already_recorded');
          return;
        }
        claimedJobModel = generationJobModel;
        claimedJobId = generationJob._id;
        releaseOutcomeClaim = true;
        let renewal = Promise.resolve(true);
        renewOutcomeClaim = () => {
          renewal = renewal.then(async active => {
            if (!active) return false;
            try {
              const renewed = await generationJobModel.renewTeacherOutcomeClaim(
                generationJob._id,
                outcomeClaimId as string,
              );
              if (!renewed) outcomeClaimLeaseLost = true;
              return renewed;
            } catch (err) {
              outcomeClaimLeaseLost = true;
              console.warn('[TestdataGenApplyHandler] outcome claim renewal failed:', err);
              return false;
            }
          });
          return renewal;
        };
        outcomeClaimHeartbeatTimer = setInterval(() => {
          void renewOutcomeClaim?.();
        }, Math.max(1_000, Math.floor(TESTDATA_TEACHER_OUTCOME_CLAIM_LEASE_MS / 3)));
      }

      this.ctx.get('featureStatsModel')?.recordAttempt('testdata_apply').catch(() => { /* best-effort */ });

      // config.yaml 最后写入：确保测试点文件就位后再触发评测设置同步
      validated.sort((a, b) => {
        const aIsConfig = a.name === 'config.yaml' ? 1 : 0;
        const bIsConfig = b.name === 'config.yaml' ? 1 : 0;
        return aIsConfig - bIsConfig;
      });

      const written: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const f of validated) {
        if (renewOutcomeClaim && !(await renewOutcomeClaim())) break;
        try {
          await ProblemModel.addTestdata(
            domainId, pdoc.docId, f.name,
            Buffer.from(f.content, 'utf-8'),
            this.user?._id,
          );
          written.push(f.name);
        } catch (err) {
          console.error(`[TestdataGenApplyHandler] 写入 ${f.name} 失败:`, err);
          failed.push({ name: f.name, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (renewOutcomeClaim && !outcomeClaimLeaseLost && !(await renewOutcomeClaim())) {
        outcomeClaimLeaseLost = true;
      }
      if (outcomeClaimHeartbeatTimer) {
        clearInterval(outcomeClaimHeartbeatTimer);
        outcomeClaimHeartbeatTimer = undefined;
      }
      if (outcomeClaimLeaseLost) {
        releaseOutcomeClaim = false;
        this.response.status = 409;
        this.response.body = {
          written,
          failed,
          error: this.translate('ai_helper_testdata_outcome_already_recorded'),
          code: 'APPLY_STATE_CONFLICT',
        };
        this.response.type = 'application/json';
        return;
      }

      if (written.length > 0 && failed.length === 0) {
        this.ctx.get('featureStatsModel')?.recordSuccess('testdata_apply').catch(() => { /* best-effort */ });
        if (generationJob && generationJobModel) {
          const plan = generationJob.plan;
          let teacherOutcomeConflict = false;
          if (plan?.runId && plan.originalFileHashes && outcomeClaimId) {
            try {
              const appliedHashes = computeOriginalFileHashes(validated);
              const changedFileNames = new Set(validated
                .filter(file => plan.originalFileHashes?.[file.name] !== appliedHashes[file.name])
                .map(file => file.name));
              const plannedKinds = new Map(plan.files.map(file => [file.name, file.kind]));
              const changedFileKinds = [...new Set([...changedFileNames]
                .map(name => plannedKinds.get(name))
                .filter((kind): kind is TestdataChangedFileKind => kind !== undefined))];
              const input = changedFileNames.size === 0
                ? {
                  eventId: outcomeClaimId,
                  outcome: 'accepted_unchanged' as const,
                }
                : {
                  eventId: outcomeClaimId,
                  outcome: 'accepted_edited' as const,
                  editedFileCount: changedFileNames.size,
                  changedFileKinds,
                };
              const outcome = await generationJobModel.recordTeacherOutcome(
                generationJob._id,
                input,
                outcomeClaimId,
              );
              if (outcome.state === 'recorded') {
                const telemetry = this.ctx.get('testdataRunTelemetry') as TestdataRunTelemetryService | undefined;
                emitTestdataTelemetryBestEffort(telemetry && (() => telemetry.emitTeacherOutcome({
                  runId: plan.runId,
                  eventId: outcome.record.eventId,
                  occurredAt: outcome.record.recordedAt,
                  outcome: outcome.record.outcome,
                  reason: outcome.record.reason,
                  editedFileCount: outcome.record.editedFileCount,
                  changedFileKinds: outcome.record.changedFileKinds,
                })));
              } else {
                teacherOutcomeConflict = true;
              }
            } catch (err) {
              // Local outcome persistence is the source of truth for the teacher loop.
              // If it fails after files were written, retain the claim and surface the
              // real file result instead of falsely reporting a completed apply.
              teacherOutcomeConflict = true;
              console.warn('[TestdataGenApplyHandler] teacher outcome persistence failed:', err);
            }
          }
          if (outcomeClaimId) {
            if (teacherOutcomeConflict) {
              // claim 所有权异常时 fail closed；文件真实写入结果仍随响应返回。
              releaseOutcomeClaim = false;
              this.response.status = 409;
              this.response.body = {
                written,
                failed,
                error: this.translate('ai_helper_testdata_outcome_already_recorded'),
                code: 'APPLY_STATE_CONFLICT',
              };
              this.response.type = 'application/json';
              return;
            }
            try {
              const markedApplied = await generationJobModel.markApplied(generationJob._id, outcomeClaimId);
              if (!markedApplied) {
                releaseOutcomeClaim = false;
                this.response.status = 409;
                this.response.body = {
                  written,
                  failed,
                  error: this.translate('ai_helper_testdata_outcome_already_recorded'),
                  code: 'APPLY_STATE_CONFLICT',
                };
                this.response.type = 'application/json';
                return;
              }
              releaseOutcomeClaim = false;
            } catch (err) {
              // 文件已写入但 claim 无法原子终结：保留 claim 并显式返回状态冲突。
              releaseOutcomeClaim = false;
              console.warn('[TestdataGenApplyHandler] applied state persistence failed:', err);
              this.response.status = 409;
              this.response.body = {
                written,
                failed,
                error: this.translate('ai_helper_testdata_outcome_already_recorded'),
                code: 'APPLY_STATE_CONFLICT',
              };
              this.response.type = 'application/json';
              return;
            }
          }
        }
      } else if (failed.length > 0 && generationJob?.runId) {
        const telemetry = this.ctx.get('testdataRunTelemetry') as TestdataRunTelemetryService | undefined;
        try {
          const event = await generationJobModel?.getOrCreateApplyFailureEvent(
            generationJob._id,
            generationJob.applyFailureEventId,
          );
          emitTestdataTelemetryBestEffort(telemetry && event && (() => telemetry.emitApplyFailure(
            generationJob.runId,
            event.eventId,
            event.occurredAt,
          )));
        } catch (err) {
          console.warn('[TestdataGenApplyHandler] apply failure event persistence failed:', err);
        }
      }

      this.response.body = { written, failed };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenApplyHandler.post] error:', err);
      captureTestdataGenerationFailure(this.ctx, 'testdata_apply', err);
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    } finally {
      if (outcomeClaimHeartbeatTimer) clearInterval(outcomeClaimHeartbeatTimer);
      if (releaseOutcomeClaim && claimedJobModel && claimedJobId && outcomeClaimId) {
        try {
          await claimedJobModel.releaseTeacherOutcomeClaim(claimedJobId, outcomeClaimId);
        } catch (err) {
          console.warn('[TestdataGenApplyHandler] outcome claim release failed:', err);
        }
      }
    }
  }
}
