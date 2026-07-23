"use strict";
/**
 * 管理员真实模型基准：复用平台 AI 配置中的 testdataGeneration 场景模型链，
 * 串行跑固定难题与隐藏探针。结果仅返回当前浏览器，不写库、不自动上报。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataBenchmarkHandlerPriv = exports.TestdataBenchmarkHandler = void 0;
const hydrooj_1 = require("hydrooj");
const package_json_1 = __importDefault(require("../../package.json"));
const openaiClient_1 = require("../services/openaiClient");
const goJudgeSandboxService_1 = require("../services/goJudgeSandboxService");
const testdataBenchmark_1 = require("../benchmarks/testdataBenchmark");
const testdataBenchmarkCases_1 = require("../benchmarks/testdataBenchmarkCases");
const testdataGenService_1 = require("../services/testdataGenService");
const sseHelper_1 = require("../lib/sseHelper");
const csrfHelper_1 = require("../lib/csrfHelper");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const limits_1 = require("../constants/limits");
function safeModelsFromResults(results) {
    return [...new Set(results.flatMap(result => (result.usedModel || '').split(' → ').map(model => model.trim()).filter(Boolean)))];
}
class TestdataBenchmarkHandler extends hydrooj_1.Handler {
    async post() {
        let progressStream;
        let keepaliveTimer;
        let streamRawRes;
        let streamCloseListener;
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const body = (this.request.body || {});
            if (body.confirmCost !== true) {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_testdata_benchmark_confirm_required'),
                    code: 'BENCHMARK_CONFIRM_REQUIRED',
                };
                this.response.type = 'application/json';
                return;
            }
            const caseIds = Array.isArray(body.caseIds)
                ? [...new Set(body.caseIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
                : [];
            let cases;
            try {
                cases = (0, testdataBenchmarkCases_1.selectTestdataBenchmarkCases)(caseIds);
            }
            catch (err) {
                this.response.status = 400;
                this.response.body = {
                    error: err instanceof Error ? err.message : String(err),
                    code: 'INVALID_BENCHMARK_CASES',
                };
                this.response.type = 'application/json';
                return;
            }
            const requestAc = new AbortController();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const koaCtx = this.context;
            const rawReq = koaCtx?.req;
            const rawRes = koaCtx?.res;
            streamRawRes = rawRes;
            if (rawReq?.aborted || rawReq?.socket?.destroyed) {
                this.response.status = 499;
                this.response.body = { error: this.translate('ai_helper_err_ai_aborted'), code: 'CLIENT_ABORTED' };
                this.response.type = 'application/json';
                return;
            }
            streamCloseListener = () => { if (!rawRes?.writableEnded)
                requestAc.abort(); };
            rawRes?.on?.('close', streamCloseListener);
            const aiClient = await (0, openaiClient_1.createMultiModelClientFromConfig)(this.ctx, undefined, 'testdataGeneration');
            const sandboxHost = String(hydrooj_1.SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
            const runner = new goJudgeSandboxService_1.GoJudgeSandboxRunner(sandboxHost);
            if (!await runner.isAvailable(requestAc.signal)) {
                this.response.status = 503;
                this.response.body = {
                    error: this.translate('ai_helper_testdata_benchmark_sandbox_unavailable'),
                    code: 'SANDBOX_UNAVAILABLE',
                };
                this.response.type = 'application/json';
                return;
            }
            // 只对通过本地配置与沙箱预检的真实运行计数，避免环境故障浪费管理员配额。
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_testdata_benchmark',
                periodSecs: 3600,
                maxOps: 2,
                errorMessage: 'ai_helper_testdata_benchmark_rate_limited',
            }))
                return;
            const accept = String(this.request.headers?.accept || '').toLowerCase();
            if (accept.includes('text/event-stream') && rawRes) {
                koaCtx.respond = false;
                if ('compress' in koaCtx)
                    koaCtx.compress = false;
                rawReq?.socket?.setNoDelay?.(true);
                rawReq?.socket?.setTimeout?.(0);
                progressStream = (0, sseHelper_1.createSSEWriter)(rawRes);
                keepaliveTimer = setInterval(() => progressStream?.writeComment('keepalive'), limits_1.API_DEFAULTS.SSE_KEEPALIVE_INTERVAL_MS);
            }
            const startedAt = new Date().toISOString();
            const results = await (0, testdataBenchmark_1.runTestdataBenchmark)(cases, aiClient, runner, {
                signal: requestAc.signal,
                onCaseStart: (benchmarkCase, index, total) => {
                    progressStream?.writeEvent('case_start', {
                        caseId: benchmarkCase.id,
                        title: benchmarkCase.title,
                        index: index + 1,
                        total,
                    });
                },
                onProgress: (benchmarkCase, progress) => {
                    progressStream?.writeEvent('progress', { caseId: benchmarkCase.id, ...progress });
                },
                onCaseComplete: (result, index, total) => {
                    progressStream?.writeEvent('case_result', {
                        id: result.id,
                        title: result.title,
                        passed: result.passed,
                        durationMs: result.durationMs,
                        usedModel: result.usedModel,
                        failureStage: result.failureStage,
                        qualityGateFailureCount: result.qualityGateFailures.length,
                        hiddenProbesPassed: result.probes.filter(probe => probe.passed).length,
                        hiddenProbesTotal: result.probes.length,
                        index: index + 1,
                        total,
                    });
                },
            });
            const completedAt = new Date().toISOString();
            const models = safeModelsFromResults(results);
            const report = {
                schemaVersion: 1,
                runId: `${completedAt.replace(/[:.]/g, '-')}-platform`,
                startedAt,
                completedAt,
                pluginVersion: package_json_1.default.version,
                models: models.length > 0 ? models : ['testdataGeneration'],
                summary: (0, testdataBenchmark_1.summarizeTestdataBenchmark)(results),
                results,
            };
            const payload = {
                report,
                aggregate: (0, testdataBenchmark_1.createTestdataBenchmarkAggregateSnapshot)(report),
            };
            if (progressStream) {
                progressStream.writeEvent('result', payload);
                progressStream.end();
            }
            else {
                this.response.body = payload;
                this.response.type = 'application/json';
            }
        }
        catch (err) {
            if ((0, testdataGenService_1.isCancellation)(err)) {
                const body = { error: this.translate('ai_helper_err_ai_aborted'), code: 'CLIENT_ABORTED' };
                if (progressStream) {
                    progressStream.writeEvent('error', body);
                    progressStream.end();
                }
                else {
                    this.response.status = 499;
                    this.response.body = body;
                    this.response.type = 'application/json';
                }
                return;
            }
            console.error('[TestdataBenchmarkHandler.post] error:', err);
            const status = err instanceof openaiClient_1.AIServiceError ? (0, openaiClient_1.getHttpStatusForCategory)(err.category) : 502;
            const errorBody = {
                error: err instanceof openaiClient_1.AIServiceError
                    ? this.translate(openaiClient_1.USER_ERROR_MESSAGE_KEYS[err.category])
                    : err instanceof Error ? err.message : this.translate('ai_helper_err_internal'),
                code: err instanceof openaiClient_1.AIServiceError ? 'AI_SERVICE_ERROR' : 'BENCHMARK_FAILED',
            };
            if (progressStream) {
                progressStream.writeEvent('error', errorBody);
                progressStream.end();
            }
            else {
                this.response.status = status;
                this.response.body = errorBody;
                this.response.type = 'application/json';
            }
        }
        finally {
            if (keepaliveTimer)
                clearInterval(keepaliveTimer);
            if (streamRawRes && streamCloseListener) {
                streamRawRes.removeListener?.('close', streamCloseListener);
            }
        }
    }
}
exports.TestdataBenchmarkHandler = TestdataBenchmarkHandler;
exports.TestdataBenchmarkHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=testdataBenchmarkHandler.js.map