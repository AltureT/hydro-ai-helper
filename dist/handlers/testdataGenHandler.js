"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataGenApplyHandler = exports.TestdataGenSkeletonHandler = exports.TestdataGenJobDismissHandler = exports.TestdataGenJobCancelHandler = exports.TestdataGenJobStatusHandler = exports.TestdataGenJobStartHandler = exports.TestdataGenGenerateHandler = exports.TestdataGenContextHandler = exports.TestdataGenHandlerPriv = void 0;
exports.extractStatementMarkdown = extractStatementMarkdown;
const hydrooj_1 = require("hydrooj");
const openaiClient_1 = require("../services/openaiClient");
const testdataGenService_1 = require("../services/testdataGenService");
const codeSelectionService_1 = require("../services/analyzers/codeSelectionService");
const goJudgeSandboxService_1 = require("../services/goJudgeSandboxService");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const csrfHelper_1 = require("../lib/csrfHelper");
const sseHelper_1 = require("../lib/sseHelper");
const limits_1 = require("../constants/limits");
const domainHelper_1 = require("../utils/domainHelper");
const mongo_1 = require("../utils/mongo");
exports.TestdataGenHandlerPriv = hydrooj_1.PRIV.PRIV_USER_PROFILE;
const DOC_TYPE_PROBLEM = 10;
const PYTHON3_RECORD_LANGUAGES = ['py', 'py.py3', 'py.pypy3', 'python', 'python3'];
const ACCEPTED_STD_CANDIDATE_LIMIT = 8;
function canReadAllRecordCodes(handler) {
    const user = handler.user;
    const hasPriv = typeof user?.hasPriv === 'function'
        && hydrooj_1.PRIV.PRIV_READ_RECORD_CODE !== undefined
        && user.hasPriv(hydrooj_1.PRIV.PRIV_READ_RECORD_CODE);
    const hasPerm = typeof user?.hasPerm === 'function'
        && hydrooj_1.PERM.PERM_READ_RECORD_CODE !== undefined
        && user.hasPerm(hydrooj_1.PERM.PERM_READ_RECORD_CODE);
    return hasPriv || hasPerm;
}
function acceptedStdRecordQuery(handler, domainId, problemDocId) {
    return {
        domainId,
        pid: problemDocId,
        status: hydrooj_1.STATUS.STATUS_ACCEPTED,
        lang: { $in: PYTHON3_RECORD_LANGUAGES },
        code: { $type: 'string', $ne: '' },
        // 未结束竞赛中的 AC 不能成为题目文件页的隐式源码入口。
        $or: [{ contest: { $exists: false } }, { contest: null }],
        ...(canReadAllRecordCodes(handler) ? {} : { uid: handler.user?._id }),
    };
}
async function listAcceptedStdCandidates(handler, domainId, problemDocId) {
    const records = await hydrooj_1.db.collection('record')
        .find(acceptedStdRecordQuery(handler, domainId, problemDocId), {
        projection: { _id: 1, uid: 1, lang: 1, code: 1 },
    })
        .sort({ _id: -1 })
        .limit(ACCEPTED_STD_CANDIDATE_LIMIT * 2)
        .toArray();
    const seenCode = new Set();
    const candidates = [];
    for (const record of records) {
        const code = typeof record.code === 'string' ? record.code.trim() : '';
        if (!code
            || code.startsWith('@@hydro_submission_file@@')
            || code.length > testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD
            || seenCode.has(code))
            continue;
        seenCode.add(code);
        candidates.push({
            recordId: record._id.toHexString(),
            lang: record.lang,
            submittedAt: record._id.getTimestamp().toISOString(),
            isOwn: record.uid === handler.user?._id,
        });
        if (candidates.length >= ACCEPTED_STD_CANDIDATE_LIMIT)
            break;
    }
    return candidates;
}
async function loadAcceptedStdCode(handler, domainId, problemDocId, recordId) {
    if (!mongo_1.ObjectId.isValid(recordId))
        return null;
    const record = await hydrooj_1.db.collection('record').findOne({
        ...acceptedStdRecordQuery(handler, domainId, problemDocId),
        _id: new mongo_1.ObjectId(recordId),
    }, {
        projection: { code: 1, lang: 1, uid: 1 },
    });
    const code = typeof record?.code === 'string' ? record.code.trim() : '';
    if (!code
        || code.startsWith('@@hydro_submission_file@@')
        || code.length > testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD)
        return null;
    return code;
}
async function resolveRequestedStd(handler, domainId, pdoc, body) {
    const manual = typeof body.providedStd === 'string' ? body.providedStd.trim() : '';
    const recordId = typeof body.acceptedStdRecordId === 'string' ? body.acceptedStdRecordId.trim() : '';
    if (manual && recordId) {
        return { errorCode: 'STD_SOURCE_CONFLICT', errorKey: 'ai_helper_testdata_err_std_source_conflict' };
    }
    if (!recordId)
        return {
            providedStd: manual || undefined,
            ...(manual ? { providedStdSource: 'manual' } : {}),
        };
    if (body.problemKind !== 'traditional') {
        return { errorCode: 'AC_STD_TRADITIONAL_ONLY', errorKey: 'ai_helper_testdata_err_ac_std_traditional_only' };
    }
    const acceptedCode = await loadAcceptedStdCode(handler, domainId, pdoc.docId, recordId);
    if (!acceptedCode) {
        return { errorCode: 'AC_STD_UNAVAILABLE', errorKey: 'ai_helper_testdata_err_ac_std_unavailable' };
    }
    return { providedStd: acceptedCode, providedStdSource: 'accepted-record' };
}
/**
 * 题目定位：支持数字 docId 与字符串 pid（如 D3102）
 */
async function findProblem(domainId, problemId) {
    const coll = hydrooj_1.db.collection('document');
    const or = [{ pid: problemId }];
    const numericId = parseInt(problemId, 10);
    if (!Number.isNaN(numericId) && String(numericId) === problemId) {
        or.push({ docId: numericId });
    }
    const doc = await coll.findOne({ domainId, docType: DOC_TYPE_PROBLEM, $or: or });
    return doc || null;
}
/**
 * 题面可能存储为多语言 JSON（{"zh": "...", "en": "..."}），做兼容解析
 */
function extractStatementMarkdown(content) {
    if (!content)
        return '';
    const trimmed = content.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const zh = parsed.zh ?? parsed['zh_CN'] ?? parsed['zh-CN'];
            if (typeof zh === 'string' && zh.trim())
                return zh;
            for (const value of Object.values(parsed)) {
                if (typeof value === 'string' && value.trim())
                    return value;
            }
        }
        catch {
            // 非 JSON，按原始 Markdown 处理
        }
    }
    return content;
}
/**
 * 权限检查：与 Hydro 题目文件上传一致。
 * 无权限时写好 403 响应并返回 false。
 */
function checkEditPermission(handler, pdoc) {
    const user = handler.user;
    const ownsProblem = user && typeof user.own === 'function'
        ? user.own(pdoc, hydrooj_1.PERM.PERM_EDIT_PROBLEM_SELF)
        : false;
    const hasEditPerm = user && typeof user.hasPerm === 'function'
        ? user.hasPerm(hydrooj_1.PERM.PERM_EDIT_PROBLEM)
        : false;
    if (ownsProblem || hasEditPerm)
        return true;
    handler.response.status = 403;
    handler.response.body = {
        error: handler.translate('ai_helper_testdata_err_no_permission'),
        code: 'PERMISSION_DENIED',
    };
    handler.response.type = 'application/json';
    return false;
}
function sendError(handler, status, code, messageKey) {
    handler.response.status = status;
    handler.response.body = { error: handler.translate(messageKey), code };
    handler.response.type = 'application/json';
}
// ─── TestdataGenContextHandler ────────────────────────────────────────────────
/**
 * GET /ai-helper/testdata-gen/context/:problemId
 * 返回题目标题、题面预览与已有测试数据文件名（供前端展示与冲突提示）
 */
class TestdataGenContextHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const domainId = (0, domainHelper_1.getDomainId)(this);
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
            if (!checkEditPermission(this, pdoc))
                return;
            const statement = extractStatementMarkdown(pdoc.content);
            const existingFiles = (pdoc.data || [])
                .map(f => String(f._id ?? f.name ?? ''))
                .filter(Boolean);
            const acceptedSolutions = await listAcceptedStdCandidates(this, domainId, pdoc.docId);
            const jobModel = this.ctx.get('testdataGenerationJobModel');
            let restorableJob;
            if (jobModel && typeof this.user?._id === 'number') {
                let savedJob = await jobModel.findRestorable(domainId, pdoc.docId, this.user._id);
                if (savedJob?.active && savedJob.leaseExpiresAt?.getTime() <= Date.now()) {
                    await jobModel.markExpiredLeaseInterrupted(savedJob._id);
                    savedJob = null;
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
                    fillInDetected: (0, codeSelectionService_1.isFillInBlankProblem)(statement),
                },
                existingFiles,
                acceptedSolutions,
                limits: {
                    minCases: testdataGenService_1.TESTDATA_GEN_LIMITS.MIN_CASES,
                    maxCases: testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_CASES,
                    maxExtraRequirements: testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_EXTRA_REQUIREMENTS,
                    maxProvidedStd: testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD,
                },
                generationProfiles: testdataGenService_1.TESTDATA_GENERATION_PROFILES,
                restorableJob,
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TestdataGenContextHandler.get] error:', err);
            sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
        }
    }
}
exports.TestdataGenContextHandler = TestdataGenContextHandler;
const backgroundGenerationControllers = new Map();
const TESTDATA_JOB_HEARTBEAT_MS = 30000;
function serializeGenerationJob(job) {
    return {
        id: String(job._id),
        problemId: job.problemId,
        problemTitle: job.problemTitle,
        generationProfile: job.generationProfile,
        status: job.status,
        progress: job.progress,
        error: job.error,
        plan: job.status === 'completed' ? job.plan : undefined,
        createdAt: job.createdAt?.toISOString?.() || job.createdAt,
        startedAt: job.startedAt?.toISOString?.() || job.startedAt,
        updatedAt: job.updatedAt?.toISOString?.() || job.updatedAt,
        progressUpdatedAt: job.progressUpdatedAt?.toISOString?.() || job.progressUpdatedAt,
        completedAt: job.completedAt?.toISOString?.() || job.completedAt,
    };
}
async function findAuthorizedGenerationJob(handler, jobModel, jobId) {
    let job;
    try {
        job = await jobModel.findById(jobId);
    }
    catch {
        job = null;
    }
    const domainId = (0, domainHelper_1.getDomainId)(handler);
    if (!job || job.domainId !== domainId || job.createdBy !== handler.user?._id) {
        sendError(handler, 404, 'JOB_NOT_FOUND', 'ai_helper_testdata_job_not_found');
        return null;
    }
    const pdoc = await findProblem(domainId, String(job.problemDocId));
    if (!pdoc) {
        sendError(handler, 404, 'PROBLEM_NOT_FOUND', 'ai_helper_testdata_err_problem_not_found');
        return null;
    }
    if (!checkEditPermission(handler, pdoc))
        return null;
    if (job.active && job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= Date.now()) {
        await jobModel.markExpiredLeaseInterrupted(job._id);
        job = await jobModel.findById(job._id);
        if (!job)
            return null;
    }
    return { job, pdoc };
}
async function runBackgroundGeneration(params) {
    const { ctx, jobModel, job, pdoc, statement, options, existingFiles, generationProfile, translate, } = params;
    const jobId = String(job._id);
    const ac = new AbortController();
    backgroundGenerationControllers.set(jobId, ac);
    let deadlineExceeded = false;
    let progressWrites = Promise.resolve();
    const deadlineTimer = setTimeout(() => {
        deadlineExceeded = true;
        ac.abort();
    }, testdataGenService_1.TESTDATA_GENERATION_PROFILES[generationProfile].totalTimeoutMs);
    const heartbeatTimer = setInterval(() => {
        jobModel.renewLease(job._id).then(active => {
            if (!active)
                ac.abort();
        }).catch(err => {
            console.warn('[TestdataGenJob] lease renewal failed:', err);
        });
    }, TESTDATA_JOB_HEARTBEAT_MS);
    try {
        await jobModel.markRunning(job._id);
        ctx.get('featureStatsModel')?.recordAttempt('testdata_generation').catch(() => { });
        const aiClient = await (0, openaiClient_1.createMultiModelClientFromConfig)(ctx, undefined, 'testdataGeneration');
        const sandboxHost = String(hydrooj_1.SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
        const service = new testdataGenService_1.TestdataGenService(aiClient, {
            sandboxRunner: new goJudgeSandboxService_1.GoJudgeSandboxRunner(sandboxHost),
            mode: (0, goJudgeSandboxService_1.getTestdataGenerationMode)(),
        });
        const plan = await service.generate({
            problemTitle: pdoc.title || job.problemId,
            statementMarkdown: statement,
            options,
            existingFiles,
            existingConfig: pdoc.config,
            fillInDetected: (0, codeSelectionService_1.isFillInBlankProblem)(statement),
            generationProfile,
            signal: ac.signal,
            onProgress: progress => {
                progressWrites = progressWrites
                    .then(() => jobModel.updateProgress(job._id, progress))
                    .catch(err => console.warn('[TestdataGenJob] progress update failed:', err));
            },
        });
        await progressWrites;
        if (ac.signal.aborted) {
            throw Object.assign(new Error('canceled'), { name: 'AbortError' });
        }
        const saved = await jobModel.complete(job._id, plan);
        if (!saved)
            return;
        ctx.get('featureStatsModel')?.recordSuccess('testdata_generation').catch(() => { });
        const successfulModel = typeof plan.usedModel === 'string'
            ? plan.usedModel.split(' → ').pop()?.trim()
            : undefined;
        const escalatedFromModel = plan.verification?.modelEscalation?.fromModel;
        if (escalatedFromModel) {
            ctx.get('featureStatsModel')?.recordModelOutcome?.('testdata_generation', escalatedFromModel, false).catch(() => { });
        }
        ctx.get('featureStatsModel')?.recordModelOutcome?.('testdata_generation', successfulModel || '', true).catch(() => { });
    }
    catch (err) {
        if ((0, testdataGenService_1.isCancellation)(err)) {
            if (deadlineExceeded) {
                await jobModel.fail(job._id, {
                    message: translate('ai_helper_testdata_err_timeout'),
                    code: 'GENERATION_TIMEOUT',
                    category: 'timeout',
                    retryable: true,
                });
            }
            else {
                await jobModel.cancel(job._id);
            }
            return;
        }
        console.error('[TestdataGenJob] generation failed:', err);
        const testdataMetadata = (0, testdataGenService_1.extractTestdataErrorMetadata)(err);
        const aiMetadata = (0, openaiClient_1.extractAiErrorMetadata)(err);
        const usedModels = Array.isArray(testdataMetadata?.usedModels)
            ? testdataMetadata.usedModels.filter((item) => typeof item === 'string')
            : [];
        const failedModel = usedModels[usedModels.length - 1]
            || (typeof aiMetadata?.modelName === 'string' ? aiMetadata.modelName : '');
        ctx.get('featureStatsModel')?.recordModelOutcome?.('testdata_generation', failedModel, false).catch(() => { });
        ctx.get('errorReporter')?.capture('api_failure', 'testdata_gen', err instanceof Error ? err.message : String(err), undefined, err instanceof Error ? err.stack : undefined, { problemId: job.problemId, jobId, ...testdataMetadata, ...aiMetadata });
        const jobError = err instanceof openaiClient_1.AIServiceError
            ? {
                message: translate(openaiClient_1.USER_ERROR_MESSAGE_KEYS[err.category]),
                code: 'AI_SERVICE_ERROR',
                category: err.category,
                retryable: err.isRetryable,
            }
            : {
                message: err instanceof Error ? err.message : translate('ai_helper_err_internal'),
                code: 'GENERATION_FAILED',
                retryable: true,
                recommendDeeperReasoning: (0, testdataGenService_1.shouldRecommendDeeperReasoning)(err),
            };
        await jobModel.fail(job._id, jobError);
    }
    finally {
        clearTimeout(deadlineTimer);
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
class TestdataGenGenerateHandler extends hydrooj_1.Handler {
    async post() {
        let progressStream;
        let keepaliveTimer;
        let streamRawRes;
        let streamCloseListener;
        let generationDeadlineTimer;
        let generationDeadlineExceeded = false;
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const body = (this.request.body || {});
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
            if (!checkEditPermission(this, pdoc))
                return;
            const requestedProfile = body.generationProfile || 'standard';
            if (!(0, testdataGenService_1.isTestdataGenerationProfile)(requestedProfile)) {
                sendError(this, 400, 'INVALID_GENERATION_PROFILE', 'ai_helper_testdata_err_invalid_generation_profile');
                return;
            }
            const generationProfile = requestedProfile;
            const generationTiming = testdataGenService_1.TESTDATA_GENERATION_PROFILES[generationProfile];
            // AI 生成开销大：限制每人每 5 分钟 5 次
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_testdata_gen', periodSecs: 300, maxOps: 5,
                errorMessage: 'ai_helper_testdata_err_rate_limited',
            }))
                return;
            const resolvedStd = await resolveRequestedStd(this, domainId, pdoc, body);
            if (resolvedStd.errorCode && resolvedStd.errorKey) {
                sendError(this, 400, resolvedStd.errorCode, resolvedStd.errorKey);
                return;
            }
            const options = {
                problemKind: (body.problemKind || 'auto'),
                fillInMode: (body.fillInMode || 'auto'),
                caseCount: Number(body.caseCount ?? 10),
                dataScale: (body.dataScale || 'auto'),
                languages: Array.isArray(body.languages)
                    ? body.languages.filter(l => testdataGenService_1.SUPPORTED_TEMPLATE_LANGS.includes(l))
                    : [...testdataGenService_1.SUPPORTED_TEMPLATE_LANGS],
                providedStd: resolvedStd.providedStd,
                providedStdSource: resolvedStd.providedStdSource,
                extraRequirements: typeof body.extraRequirements === 'string' ? body.extraRequirements : undefined,
            };
            const optionError = (0, testdataGenService_1.validateGenerateOptions)(options);
            if (optionError) {
                sendError(this, 400, 'INVALID_OPTIONS', optionError);
                return;
            }
            const statement = extractStatementMarkdown(pdoc.content);
            if (!statement.trim()) {
                sendError(this, 400, 'EMPTY_STATEMENT', 'ai_helper_testdata_err_empty_statement');
                return;
            }
            this.ctx.get('featureStatsModel')?.recordAttempt('testdata_generation').catch(() => { });
            const aiClient = await (0, openaiClient_1.createMultiModelClientFromConfig)(this.ctx, undefined, 'testdataGeneration');
            const sandboxHost = String(hydrooj_1.SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
            const service = new testdataGenService_1.TestdataGenService(aiClient, {
                sandboxRunner: new goJudgeSandboxService_1.GoJudgeSandboxRunner(sandboxHost),
                mode: (0, goJudgeSandboxService_1.getTestdataGenerationMode)(),
            });
            const existingFiles = (pdoc.data || [])
                .map(f => String(f._id ?? f.name ?? ''))
                .filter(Boolean);
            // 请求级取消：客户端断开时中止 AI 调用与沙箱管线，避免白跑。
            // 关键：不能用 req 的 'close'/destroyed 判断断开——POST body 被 body-parser
            // 读完后，请求可读流会按正常生命周期置 destroyed=true 并触发 'close'，此时
            // 客户端仍在等响应。真实断开只能看响应连接：res 'close' 且响应尚未写完。
            const requestAc = new AbortController();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const koaCtx = this.context;
            const rawReq = koaCtx?.req;
            const rawRes = koaCtx?.res;
            streamRawRes = rawRes;
            // 挂监听前补一次检查：前序 DB/配置操作期间客户端可能已真实断开
            // （aborted / 底层 socket 已销毁），此时直接 499，不白跑整条管线。
            if (rawReq?.aborted || rawReq?.socket?.destroyed) {
                this.response.status = 499;
                this.response.body = { error: this.translate('ai_helper_err_ai_aborted'), code: 'CLIENT_ABORTED' };
                this.response.type = 'application/json';
                return;
            }
            streamCloseListener = () => { if (!rawRes?.writableEnded)
                requestAc.abort(); };
            rawRes?.on?.('close', streamCloseListener);
            generationDeadlineTimer = setTimeout(() => {
                generationDeadlineExceeded = true;
                requestAc.abort();
            }, generationTiming.totalTimeoutMs);
            const accept = String(this.request.headers?.accept || '').toLowerCase();
            if (accept.includes('text/event-stream') && rawRes) {
                koaCtx.respond = false;
                if ('compress' in koaCtx)
                    koaCtx.compress = false;
                rawReq?.socket?.setNoDelay?.(true);
                rawReq?.socket?.setTimeout?.(0);
                progressStream = (0, sseHelper_1.createSSEWriter)(rawRes);
                keepaliveTimer = setInterval(() => {
                    progressStream?.writeComment('keepalive');
                }, limits_1.API_DEFAULTS.SSE_KEEPALIVE_INTERVAL_MS);
            }
            const plan = await service.generate({
                problemTitle: pdoc.title || problemId,
                statementMarkdown: statement,
                options,
                existingFiles,
                existingConfig: pdoc.config,
                fillInDetected: (0, codeSelectionService_1.isFillInBlankProblem)(statement),
                generationProfile,
                signal: requestAc.signal,
                onProgress: progress => progressStream?.writeEvent('progress', progress),
            });
            this.ctx.get('featureStatsModel')?.recordSuccess('testdata_generation').catch(() => { });
            const successfulModel = typeof plan.usedModel === 'string'
                ? plan.usedModel.split(' → ').pop()?.trim()
                : undefined;
            const escalatedFromModel = plan.verification?.modelEscalation?.fromModel;
            if (escalatedFromModel) {
                this.ctx.get('featureStatsModel')?.recordModelOutcome?.('testdata_generation', escalatedFromModel, false).catch(() => { });
            }
            this.ctx.get('featureStatsModel')?.recordModelOutcome?.('testdata_generation', successfulModel || '', true).catch(() => { });
            if (progressStream) {
                progressStream.writeEvent('result', { plan });
                progressStream.end();
            }
            else {
                this.response.body = { plan };
                this.response.type = 'application/json';
            }
        }
        catch (err) {
            if ((0, testdataGenService_1.isCancellation)(err) && generationDeadlineExceeded) {
                const errorBody = {
                    error: this.translate('ai_helper_testdata_err_timeout'),
                    code: 'GENERATION_TIMEOUT',
                    category: 'timeout',
                    retryable: true,
                };
                if (progressStream) {
                    progressStream.writeEvent('error', errorBody);
                    progressStream.end();
                }
                else {
                    this.response.status = 504;
                    this.response.body = errorBody;
                    this.response.type = 'application/json';
                }
                return;
            }
            // 客户端主动断开：非故障，不上报也不打 error 日志
            if ((0, testdataGenService_1.isCancellation)(err)) {
                if (progressStream) {
                    progressStream.writeEvent('error', {
                        error: this.translate('ai_helper_err_ai_aborted'),
                        code: 'CLIENT_ABORTED',
                        retryable: true,
                    });
                    progressStream.end();
                }
                else {
                    this.response.status = 499;
                    this.response.body = { error: this.translate('ai_helper_err_ai_aborted'), code: 'CLIENT_ABORTED' };
                    this.response.type = 'application/json';
                }
                return;
            }
            console.error('[TestdataGenGenerateHandler.post] error:', err);
            const testdataMetadata = (0, testdataGenService_1.extractTestdataErrorMetadata)(err);
            const aiMetadata = (0, openaiClient_1.extractAiErrorMetadata)(err);
            const usedModels = Array.isArray(testdataMetadata?.usedModels)
                ? testdataMetadata.usedModels.filter((item) => typeof item === 'string')
                : [];
            const failedModel = usedModels[usedModels.length - 1]
                || (typeof aiMetadata?.modelName === 'string' ? aiMetadata.modelName : '');
            this.ctx.get('featureStatsModel')?.recordModelOutcome?.('testdata_generation', failedModel, false).catch(() => { });
            this.ctx.get('errorReporter')?.capture('api_failure', 'testdata_gen', err instanceof Error ? err.message : String(err), undefined, err instanceof Error ? err.stack : undefined, {
                problemId: String(this.request.body?.problemId || ''),
                ...testdataMetadata,
                ...aiMetadata,
            });
            if (err instanceof openaiClient_1.AIServiceError) {
                const errorBody = {
                    error: this.translate(openaiClient_1.USER_ERROR_MESSAGE_KEYS[err.category]),
                    code: 'AI_SERVICE_ERROR',
                    category: err.category,
                    retryable: err.isRetryable,
                };
                if (progressStream) {
                    progressStream.writeEvent('error', errorBody);
                    progressStream.end();
                }
                else {
                    this.response.status = (0, openaiClient_1.getHttpStatusForCategory)(err.category);
                    this.response.body = errorBody;
                    this.response.type = 'application/json';
                }
                return;
            }
            // 解析/校验失败等业务错误：消息为中文可直接展示
            const errorBody = {
                error: err instanceof Error ? err.message : this.translate('ai_helper_err_internal'),
                code: 'GENERATION_FAILED',
                retryable: true,
                recommendDeeperReasoning: (0, testdataGenService_1.shouldRecommendDeeperReasoning)(err),
            };
            if (progressStream) {
                progressStream.writeEvent('error', errorBody);
                progressStream.end();
            }
            else {
                this.response.status = 502;
                this.response.body = errorBody;
                this.response.type = 'application/json';
            }
        }
        finally {
            if (keepaliveTimer)
                clearInterval(keepaliveTimer);
            if (generationDeadlineTimer)
                clearTimeout(generationDeadlineTimer);
            if (streamRawRes && streamCloseListener) {
                streamRawRes.removeListener?.('close', streamCloseListener);
            }
        }
    }
}
exports.TestdataGenGenerateHandler = TestdataGenGenerateHandler;
// ─── Persistent background generation jobs ───────────────────────────────────
/** POST /ai-helper/testdata-gen/jobs - 创建后台任务并立即返回任务 ID。 */
class TestdataGenJobStartHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const body = (this.request.body || {});
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
            if (!checkEditPermission(this, pdoc))
                return;
            const requestedProfile = body.generationProfile || 'standard';
            if (!(0, testdataGenService_1.isTestdataGenerationProfile)(requestedProfile)) {
                sendError(this, 400, 'INVALID_GENERATION_PROFILE', 'ai_helper_testdata_err_invalid_generation_profile');
                return;
            }
            const generationProfile = requestedProfile;
            const jobModel = this.ctx.get('testdataGenerationJobModel');
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
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_testdata_gen', periodSecs: 300, maxOps: 5,
                errorMessage: 'ai_helper_testdata_err_rate_limited',
            }))
                return;
            const resolvedStd = await resolveRequestedStd(this, domainId, pdoc, body);
            if (resolvedStd.errorCode && resolvedStd.errorKey) {
                sendError(this, 400, resolvedStd.errorCode, resolvedStd.errorKey);
                return;
            }
            const options = {
                problemKind: (body.problemKind || 'auto'),
                fillInMode: (body.fillInMode || 'auto'),
                caseCount: Number(body.caseCount ?? 10),
                dataScale: (body.dataScale || 'auto'),
                languages: Array.isArray(body.languages)
                    ? body.languages.filter(l => testdataGenService_1.SUPPORTED_TEMPLATE_LANGS.includes(l))
                    : [...testdataGenService_1.SUPPORTED_TEMPLATE_LANGS],
                providedStd: resolvedStd.providedStd,
                providedStdSource: resolvedStd.providedStdSource,
                extraRequirements: typeof body.extraRequirements === 'string' ? body.extraRequirements : undefined,
            };
            const optionError = (0, testdataGenService_1.validateGenerateOptions)(options);
            if (optionError) {
                sendError(this, 400, 'INVALID_OPTIONS', optionError);
                return;
            }
            const statement = extractStatementMarkdown(pdoc.content);
            if (!statement.trim()) {
                sendError(this, 400, 'EMPTY_STATEMENT', 'ai_helper_testdata_err_empty_statement');
                return;
            }
            const existingFiles = (pdoc.data || [])
                .map(f => String(f._id ?? f.name ?? ''))
                .filter(Boolean);
            const { job, created } = await jobModel.createOrGetActive({
                domainId,
                problemDocId: pdoc.docId,
                problemId: pdoc.pid || String(pdoc.docId),
                problemTitle: pdoc.title || problemId,
                createdBy: this.user?._id,
                generationProfile,
            });
            if (created) {
                // 只保留后台任务真正需要的翻译文本，避免长任务闭包持有整个请求 Handler。
                const backgroundTranslations = {
                    ai_helper_testdata_err_timeout: this.translate('ai_helper_testdata_err_timeout'),
                    ai_helper_err_internal: this.translate('ai_helper_err_internal'),
                };
                for (const key of Object.values(openaiClient_1.USER_ERROR_MESSAGE_KEYS)) {
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
                    generationProfile,
                    translate: key => backgroundTranslations[key] || key,
                }).catch(err => {
                    console.error('[TestdataGenJob] unhandled background failure:', err);
                });
            }
            this.response.status = created ? 202 : 200;
            this.response.body = { job: serializeGenerationJob(job), created };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TestdataGenJobStartHandler.post] error:', err);
            sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
        }
    }
}
exports.TestdataGenJobStartHandler = TestdataGenJobStartHandler;
/** GET /ai-helper/testdata-gen/jobs/:jobId - 查询进度或完整结果。 */
class TestdataGenJobStatusHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const jobModel = this.ctx.get('testdataGenerationJobModel');
            if (!jobModel) {
                sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
                return;
            }
            const authorized = await findAuthorizedGenerationJob(this, jobModel, String(this.request.params.jobId || ''));
            if (!authorized)
                return;
            this.response.body = { job: serializeGenerationJob(authorized.job) };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TestdataGenJobStatusHandler.get] error:', err);
            sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
        }
    }
}
exports.TestdataGenJobStatusHandler = TestdataGenJobStatusHandler;
/** POST /ai-helper/testdata-gen/jobs/:jobId/cancel - 跨页面、跨进程请求取消。 */
class TestdataGenJobCancelHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const jobModel = this.ctx.get('testdataGenerationJobModel');
            if (!jobModel) {
                sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
                return;
            }
            const jobId = String(this.request.params.jobId || '');
            const authorized = await findAuthorizedGenerationJob(this, jobModel, jobId);
            if (!authorized)
                return;
            await jobModel.cancel(authorized.job._id);
            backgroundGenerationControllers.get(jobId)?.abort();
            const updated = await jobModel.findById(authorized.job._id);
            this.response.body = { job: updated ? serializeGenerationJob(updated) : undefined };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TestdataGenJobCancelHandler.post] error:', err);
            sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
        }
    }
}
exports.TestdataGenJobCancelHandler = TestdataGenJobCancelHandler;
/** POST /ai-helper/testdata-gen/jobs/:jobId/dismiss - 放弃尚未写入的预览。 */
class TestdataGenJobDismissHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const jobModel = this.ctx.get('testdataGenerationJobModel');
            if (!jobModel) {
                sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
                return;
            }
            const authorized = await findAuthorizedGenerationJob(this, jobModel, String(this.request.params.jobId || ''));
            if (!authorized)
                return;
            await jobModel.dismiss(authorized.job._id);
            this.response.body = { dismissed: true };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TestdataGenJobDismissHandler.post] error:', err);
            sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
        }
    }
}
exports.TestdataGenJobDismissHandler = TestdataGenJobDismissHandler;
// ─── TestdataGenSkeletonHandler ───────────────────────────────────────────────
/**
 * POST /ai-helper/testdata-gen/skeleton
 * AI 故障降级方案：不调用 AI，确定性生成结构性文件（compile.sh /
 * config.yaml / 模板骨架）与空白测试点，数据内容由教师在预览中手动填写。
 * 无需限流（无 AI 开销）、不要求题面非空。
 */
class TestdataGenSkeletonHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const body = (this.request.body || {});
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
            if (!checkEditPermission(this, pdoc))
                return;
            const resolvedStd = await resolveRequestedStd(this, domainId, pdoc, body);
            if (resolvedStd.errorCode && resolvedStd.errorKey) {
                sendError(this, 400, resolvedStd.errorCode, resolvedStd.errorKey);
                return;
            }
            const options = {
                problemKind: (body.problemKind || 'auto'),
                fillInMode: (body.fillInMode || 'auto'),
                caseCount: Number(body.caseCount ?? 10),
                dataScale: (body.dataScale || 'auto'),
                languages: Array.isArray(body.languages)
                    ? body.languages.filter(l => testdataGenService_1.SUPPORTED_TEMPLATE_LANGS.includes(l))
                    : [...testdataGenService_1.SUPPORTED_TEMPLATE_LANGS],
                providedStd: resolvedStd.providedStd,
                providedStdSource: resolvedStd.providedStdSource,
            };
            const optionError = (0, testdataGenService_1.validateGenerateOptions)(options);
            if (optionError) {
                sendError(this, 400, 'INVALID_OPTIONS', optionError);
                return;
            }
            this.ctx.get('featureStatsModel')?.recordAttempt('testdata_skeleton').catch(() => { });
            const existingFiles = (pdoc.data || [])
                .map(f => String(f._id ?? f.name ?? ''))
                .filter(Boolean);
            const plan = (0, testdataGenService_1.buildSkeletonPlan)(options, extractStatementMarkdown(pdoc.content), existingFiles, pdoc.config);
            this.ctx.get('featureStatsModel')?.recordSuccess('testdata_skeleton').catch(() => { });
            this.response.body = { plan };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TestdataGenSkeletonHandler.post] error:', err);
            this.ctx.get('errorReporter')?.capture('api_failure', 'testdata_skeleton', err instanceof Error ? err.message : String(err), undefined, err instanceof Error ? err.stack : undefined, { problemId: String(this.request.body?.problemId || '') });
            sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
        }
    }
}
exports.TestdataGenSkeletonHandler = TestdataGenSkeletonHandler;
/**
 * POST /ai-helper/testdata-gen/apply
 * 将（教师确认/编辑后的）文件写入题目测试数据。
 * 通过 ProblemModel.addTestdata 写入，config.yaml 会由 Hydro 自动同步到评测设置。
 */
class TestdataGenApplyHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const body = (this.request.body || {});
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
            if (!checkEditPermission(this, pdoc))
                return;
            let generationJob;
            let generationJobModel;
            const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
            if (jobId) {
                generationJobModel = this.ctx.get('testdataGenerationJobModel');
                if (!generationJobModel) {
                    sendError(this, 503, 'JOB_SERVICE_UNAVAILABLE', 'ai_helper_err_internal');
                    return;
                }
                const authorized = await findAuthorizedGenerationJob(this, generationJobModel, jobId);
                if (!authorized)
                    return;
                if (authorized.job.problemDocId !== pdoc.docId || authorized.job.status !== 'completed') {
                    sendError(this, 400, 'JOB_RESULT_UNAVAILABLE', 'ai_helper_testdata_job_result_unavailable');
                    return;
                }
                generationJob = authorized.job;
            }
            const files = Array.isArray(body.files) ? body.files : [];
            if (files.length === 0) {
                sendError(this, 400, 'NO_FILES', 'ai_helper_testdata_err_no_files');
                return;
            }
            if (files.length > testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_FILE_COUNT) {
                sendError(this, 400, 'TOO_MANY_FILES', 'ai_helper_testdata_err_too_many_files');
                return;
            }
            // 逐个校验文件名与大小
            let totalSize = 0;
            const validated = [];
            const seenNames = new Set();
            for (const f of files) {
                const name = String(f.name || '');
                if (!(0, testdataGenService_1.isSafeTestdataFilename)(name)) {
                    sendError(this, 400, 'INVALID_FILENAME', 'ai_helper_testdata_err_invalid_filename');
                    return;
                }
                if (seenNames.has(name))
                    continue; // 去重，保留首个
                seenNames.add(name);
                if (typeof f.content !== 'string') {
                    sendError(this, 400, 'INVALID_CONTENT', 'ai_helper_testdata_err_invalid_content');
                    return;
                }
                const content = (0, testdataGenService_1.normalizeFileContent)(f.content);
                const size = Buffer.byteLength(content, 'utf-8');
                if (size > testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
                    sendError(this, 400, 'FILE_TOO_LARGE', 'ai_helper_testdata_err_file_too_large');
                    return;
                }
                totalSize += size;
                validated.push({ name, content });
            }
            if (totalSize > testdataGenService_1.TESTDATA_GEN_LIMITS.MAX_TOTAL_SIZE) {
                sendError(this, 400, 'TOTAL_TOO_LARGE', 'ai_helper_testdata_err_total_too_large');
                return;
            }
            this.ctx.get('featureStatsModel')?.recordAttempt('testdata_apply').catch(() => { });
            // config.yaml 最后写入：确保测试点文件就位后再触发评测设置同步
            validated.sort((a, b) => {
                const aIsConfig = a.name === 'config.yaml' ? 1 : 0;
                const bIsConfig = b.name === 'config.yaml' ? 1 : 0;
                return aIsConfig - bIsConfig;
            });
            const written = [];
            const failed = [];
            for (const f of validated) {
                try {
                    await hydrooj_1.ProblemModel.addTestdata(domainId, pdoc.docId, f.name, Buffer.from(f.content, 'utf-8'), this.user?._id);
                    written.push(f.name);
                }
                catch (err) {
                    console.error(`[TestdataGenApplyHandler] 写入 ${f.name} 失败:`, err);
                    failed.push({ name: f.name, error: err instanceof Error ? err.message : String(err) });
                }
            }
            if (written.length > 0 && failed.length === 0) {
                this.ctx.get('featureStatsModel')?.recordSuccess('testdata_apply').catch(() => { });
                if (generationJob && generationJobModel) {
                    await generationJobModel.markApplied(generationJob._id);
                }
            }
            this.response.body = { written, failed };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TestdataGenApplyHandler.post] error:', err);
            this.ctx.get('errorReporter')?.capture('api_failure', 'testdata_apply', err instanceof Error ? err.message : String(err), undefined, err instanceof Error ? err.stack : undefined, { problemId: String(this.request.body?.problemId || '') });
            sendError(this, 500, 'INTERNAL_ERROR', 'ai_helper_err_internal');
        }
    }
}
exports.TestdataGenApplyHandler = TestdataGenApplyHandler;
//# sourceMappingURL=testdataGenHandler.js.map