/**
 * 管理员真实模型基准：复用平台 AI 配置中的 testdataGeneration 场景模型链，
 * 串行跑固定难题与隐藏探针。结果仅返回当前浏览器，不写库、不自动上报。
 */

import { Handler, PRIV, SystemModel } from 'hydrooj';
import type { ServerResponse } from 'http';
import packageJson from '../../package.json';
import {
  AIServiceError,
  USER_ERROR_MESSAGE_KEYS,
  createMultiModelClientFromConfig,
  getHttpStatusForCategory,
} from '../services/openaiClient';
import { GoJudgeSandboxRunner } from '../services/goJudgeSandboxService';
import {
  createTestdataBenchmarkAggregateSnapshot,
  runTestdataBenchmark,
  summarizeTestdataBenchmark,
  type TestdataBenchmarkReport,
} from '../benchmarks/testdataBenchmark';
import { selectTestdataBenchmarkCases } from '../benchmarks/testdataBenchmarkCases';
import { isCancellation } from '../services/testdataGenService';
import { createSSEWriter, type SSEWriter } from '../lib/sseHelper';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { applyRateLimit } from '../lib/rateLimitHelper';
import { API_DEFAULTS } from '../constants/limits';

interface TestdataBenchmarkRequestBody {
  confirmCost?: boolean;
  caseIds?: string[];
}

function safeModelsFromResults(results: Array<{ usedModel?: string }>): string[] {
  return [...new Set(results.flatMap(result =>
    (result.usedModel || '').split(' → ').map(model => model.trim()).filter(Boolean)))];
}

export class TestdataBenchmarkHandler extends Handler {
  /**
   * 免费就绪检查：只读取已保存模型配置并探测 Hydro 沙箱，
   * 不向付费模型发起任何请求。
   */
  async get() {
    const sandboxHost = String(SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
    const runner = new GoJudgeSandboxRunner(sandboxHost);
    const [modelConfigured, sandboxAvailable] = await Promise.all([
      createMultiModelClientFromConfig(this.ctx, undefined, 'testdataGeneration')
        .then(() => true)
        .catch(() => false),
      runner.isAvailable().catch(() => false),
    ]);
    this.response.body = { modelConfigured, sandboxAvailable };
    this.response.type = 'application/json';
  }

  async post() {
    let progressStream: SSEWriter | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let streamRawRes: ServerResponse | undefined;
    let streamCloseListener: (() => void) | undefined;
    try {
      if (rejectIfCsrfInvalid(this)) return;
      const body = (this.request.body || {}) as TestdataBenchmarkRequestBody;
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
        cases = selectTestdataBenchmarkCases(caseIds);
      } catch (err) {
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
      const koaCtx = (this as any).context;
      const rawReq = koaCtx?.req;
      const rawRes: ServerResponse | undefined = koaCtx?.res;
      streamRawRes = rawRes;
      if (rawReq?.aborted || rawReq?.socket?.destroyed) {
        this.response.status = 499;
        this.response.body = { error: this.translate('ai_helper_err_ai_aborted'), code: 'CLIENT_ABORTED' };
        this.response.type = 'application/json';
        return;
      }
      streamCloseListener = () => { if (!rawRes?.writableEnded) requestAc.abort(); };
      rawRes?.on?.('close', streamCloseListener);

      const aiClient = await createMultiModelClientFromConfig(this.ctx, undefined, 'testdataGeneration');
      const sandboxHost = String(SystemModel.get('hydrojudge.sandbox_host') || 'http://localhost:5050/');
      const runner = new GoJudgeSandboxRunner(sandboxHost);
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
      if (await applyRateLimit(this, {
        op: 'ai_testdata_benchmark',
        periodSecs: 3600,
        maxOps: 2,
        errorMessage: 'ai_helper_testdata_benchmark_rate_limited',
      })) return;

      const accept = String(this.request.headers?.accept || '').toLowerCase();
      if (accept.includes('text/event-stream') && rawRes) {
        koaCtx.respond = false;
        if ('compress' in koaCtx) koaCtx.compress = false;
        rawReq?.socket?.setNoDelay?.(true);
        rawReq?.socket?.setTimeout?.(0);
        progressStream = createSSEWriter(rawRes);
        keepaliveTimer = setInterval(() => progressStream?.writeComment('keepalive'), API_DEFAULTS.SSE_KEEPALIVE_INTERVAL_MS);
      }

      const startedAt = new Date().toISOString();
      const results = await runTestdataBenchmark(cases, aiClient, runner, {
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
      const report: TestdataBenchmarkReport = {
        schemaVersion: 1,
        runId: `${completedAt.replace(/[:.]/g, '-')}-platform`,
        startedAt,
        completedAt,
        pluginVersion: packageJson.version,
        models: models.length > 0 ? models : ['testdataGeneration'],
        summary: summarizeTestdataBenchmark(results),
        results,
      };
      const payload = {
        report,
        aggregate: createTestdataBenchmarkAggregateSnapshot(report),
      };
      if (progressStream) {
        progressStream.writeEvent('result', payload);
        progressStream.end();
      } else {
        this.response.body = payload;
        this.response.type = 'application/json';
      }
    } catch (err) {
      if (isCancellation(err)) {
        const body = { error: this.translate('ai_helper_err_ai_aborted'), code: 'CLIENT_ABORTED' };
        if (progressStream) {
          progressStream.writeEvent('error', body);
          progressStream.end();
        } else {
          this.response.status = 499;
          this.response.body = body;
          this.response.type = 'application/json';
        }
        return;
      }
      console.error('[TestdataBenchmarkHandler.post] error:', err);
      const status = err instanceof AIServiceError ? getHttpStatusForCategory(err.category) : 502;
      const errorBody = {
        error: err instanceof AIServiceError
          ? this.translate(USER_ERROR_MESSAGE_KEYS[err.category])
          : err instanceof Error ? err.message : this.translate('ai_helper_err_internal'),
        code: err instanceof AIServiceError ? 'AI_SERVICE_ERROR' : 'BENCHMARK_FAILED',
      };
      if (progressStream) {
        progressStream.writeEvent('error', errorBody);
        progressStream.end();
      } else {
        this.response.status = status;
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

export const TestdataBenchmarkHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
