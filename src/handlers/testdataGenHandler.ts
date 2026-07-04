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

import { Handler, PRIV, PERM, ProblemModel, SystemModel, db } from 'hydrooj';
import { createMultiModelClientFromConfig, AIServiceError, USER_ERROR_MESSAGE_KEYS, getHttpStatusForCategory, extractAiErrorMetadata } from '../services/openaiClient';
import {
  TestdataGenService,
  GenerateOptions,
  TemplateLang,
  SUPPORTED_TEMPLATE_LANGS,
  validateGenerateOptions,
  isSafeTestdataFilename,
  normalizeFileContent,
  buildSkeletonPlan,
  TESTDATA_GEN_LIMITS,
} from '../services/testdataGenService';
import { isFillInBlankProblem } from '../services/analyzers/codeSelectionService';
import {
  GoJudgeSandboxRunner,
  getTestdataGenerationMode,
} from '../services/goJudgeSandboxService';
import { applyRateLimit } from '../lib/rateLimitHelper';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { getDomainId } from '../utils/domainHelper';

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
        limits: {
          minCases: TESTDATA_GEN_LIMITS.MIN_CASES,
          maxCases: TESTDATA_GEN_LIMITS.MAX_CASES,
          maxExtraRequirements: TESTDATA_GEN_LIMITS.MAX_EXTRA_REQUIREMENTS,
          maxProvidedStd: TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD,
        },
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
  extraRequirements?: string;
}

/**
 * POST /ai-helper/testdata-gen/generate
 * 调用 AI 生成文件计划并返回（不写入任何文件）
 */
export class TestdataGenGenerateHandler extends Handler {
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

      // AI 生成开销大：限制每人每 5 分钟 5 次
      if (await applyRateLimit(this, {
        op: 'ai_testdata_gen', periodSecs: 300, maxOps: 5,
        errorMessage: 'ai_helper_testdata_err_rate_limited',
      })) return;

      const options: GenerateOptions = {
        problemKind: (body.problemKind || 'auto') as GenerateOptions['problemKind'],
        fillInMode: (body.fillInMode || 'auto') as GenerateOptions['fillInMode'],
        caseCount: Number(body.caseCount ?? 10),
        dataScale: (body.dataScale || 'small') as GenerateOptions['dataScale'],
        languages: Array.isArray(body.languages)
          ? (body.languages.filter(l => (SUPPORTED_TEMPLATE_LANGS as readonly string[]).includes(l)) as TemplateLang[])
          : [...SUPPORTED_TEMPLATE_LANGS],
        providedStd: typeof body.providedStd === 'string' ? body.providedStd : undefined,
        extraRequirements: typeof body.extraRequirements === 'string' ? body.extraRequirements : undefined,
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

      this.ctx.get('featureStatsModel')?.recordAttempt('testdata_generation').catch(() => { /* best-effort */ });

      const aiClient = await createMultiModelClientFromConfig(this.ctx, undefined, 'testdataGeneration');
      const sandboxHost = String(SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
      const service = new TestdataGenService(aiClient, {
        sandboxRunner: new GoJudgeSandboxRunner(sandboxHost),
        mode: getTestdataGenerationMode(),
      });
      const existingFiles = (pdoc.data || [])
        .map(f => String(f._id ?? f.name ?? ''))
        .filter(Boolean);

      const plan = await service.generate({
        problemTitle: pdoc.title || problemId,
        statementMarkdown: statement,
        options,
        existingFiles,
        fillInDetected: isFillInBlankProblem(statement),
      });

      this.ctx.get('featureStatsModel')?.recordSuccess('testdata_generation').catch(() => { /* best-effort */ });

      this.response.body = { plan };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenGenerateHandler.post] error:', err);
      this.ctx.get('errorReporter')?.capture(
        'api_failure', 'testdata_gen',
        err instanceof Error ? err.message : String(err),
        undefined,
        err instanceof Error ? err.stack : undefined,
        { problemId: String((this.request.body as GenerateRequestBody)?.problemId || ''), ...extractAiErrorMetadata(err) },
      );
      if (err instanceof AIServiceError) {
        this.response.status = getHttpStatusForCategory(err.category);
        this.response.body = {
          error: this.translate(USER_ERROR_MESSAGE_KEYS[err.category]),
          code: 'AI_SERVICE_ERROR',
          category: err.category,
          retryable: err.isRetryable,
        };
        this.response.type = 'application/json';
        return;
      }
      // 解析/校验失败等业务错误：消息为中文可直接展示
      this.response.status = 502;
      this.response.body = {
        error: err instanceof Error ? err.message : this.translate('ai_helper_err_internal'),
        code: 'GENERATION_FAILED',
        retryable: true,
      };
      this.response.type = 'application/json';
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

      const options: GenerateOptions = {
        problemKind: (body.problemKind || 'auto') as GenerateOptions['problemKind'],
        fillInMode: (body.fillInMode || 'auto') as GenerateOptions['fillInMode'],
        caseCount: Number(body.caseCount ?? 10),
        dataScale: (body.dataScale || 'small') as GenerateOptions['dataScale'],
        languages: Array.isArray(body.languages)
          ? (body.languages.filter(l => (SUPPORTED_TEMPLATE_LANGS as readonly string[]).includes(l)) as TemplateLang[])
          : [...SUPPORTED_TEMPLATE_LANGS],
        providedStd: typeof body.providedStd === 'string' ? body.providedStd : undefined,
      };
      const optionError = validateGenerateOptions(options);
      if (optionError) {
        sendError(this, 400, 'INVALID_OPTIONS', optionError);
        return;
      }

      this.ctx.get('featureStatsModel')?.recordAttempt('testdata_skeleton').catch(() => { /* best-effort */ });
      const plan = buildSkeletonPlan(options, extractStatementMarkdown(pdoc.content));
      this.ctx.get('featureStatsModel')?.recordSuccess('testdata_skeleton').catch(() => { /* best-effort */ });

      this.response.body = { plan };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenSkeletonHandler.post] error:', err);
      this.ctx.get('errorReporter')?.capture(
        'api_failure', 'testdata_skeleton',
        err instanceof Error ? err.message : String(err),
        undefined,
        err instanceof Error ? err.stack : undefined,
        { problemId: String((this.request.body as GenerateRequestBody)?.problemId || '') },
      );
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}

// ─── TestdataGenApplyHandler ──────────────────────────────────────────────────

interface ApplyRequestBody {
  problemId?: string;
  files?: Array<{ name?: string; content?: string }>;
}

/**
 * POST /ai-helper/testdata-gen/apply
 * 将（教师确认/编辑后的）文件写入题目测试数据。
 * 通过 ProblemModel.addTestdata 写入，config.yaml 会由 Hydro 自动同步到评测设置。
 */
export class TestdataGenApplyHandler extends Handler {
  async post() {
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

      if (written.length > 0 && failed.length === 0) {
        this.ctx.get('featureStatsModel')?.recordSuccess('testdata_apply').catch(() => { /* best-effort */ });
      }

      this.response.body = { written, failed };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TestdataGenApplyHandler.post] error:', err);
      this.ctx.get('errorReporter')?.capture(
        'api_failure', 'testdata_apply',
        err instanceof Error ? err.message : String(err),
        undefined,
        err instanceof Error ? err.stack : undefined,
        { problemId: String((this.request.body as ApplyRequestBody)?.problemId || '') },
      );
      sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
    }
  }
}
