"use strict";
/**
 * AI 配置页面 Handler
 * 处理管理员配置页面的渲染和配置请求
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JailbreakLogBulkReviewHandlerPriv = exports.JailbreakLogReviewHandlerPriv = exports.JailbreakLogsExportHandlerPriv = exports.JailbreakLogFilterOptionsHandlerPriv = exports.JailbreakLogsHandlerPriv = exports.AdminConfigHandlerPriv = exports.JailbreakLogBulkReviewHandler = exports.JailbreakLogReviewHandler = exports.JailbreakLogsExportHandler = exports.JailbreakLogFilterOptionsHandler = exports.JailbreakLogsHandler = exports.AdminConfigHandler = void 0;
exports.serializeSafetyLogsCsv = serializeSafetyLogsCsv;
const hydrooj_1 = require("hydrooj");
const aiConfig_1 = require("../models/aiConfig");
const crypto_1 = require("../lib/crypto");
const jailbreakRules_1 = require("../constants/jailbreakRules");
const csrfHelper_1 = require("../lib/csrfHelper");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const i18nHelper_1 = require("../utils/i18nHelper");
const domainHelper_1 = require("../utils/domainHelper");
const problemIdHelper_1 = require("../utils/problemIdHelper");
const mongo_1 = require("../utils/mongo");
/**
 * AdminConfigHandler - AI 配置页面
 * GET /ai-helper/admin/config
 */
class AdminConfigHandler extends hydrooj_1.Handler {
    async get() {
        try {
            // 当 Accept 包含 text/html 时才渲染页面；其他情况返回 JSON 配置
            const accept = this.request.headers.accept || '';
            const prefersHtml = accept.includes('text/html');
            if (prefersHtml) {
                this.response.template = 'ai-helper/admin_config.html';
                this.response.body = {};
                return;
            }
            const aiConfigModel = this.ctx.get('aiConfigModel');
            const pluginInstallModel = this.ctx.get('pluginInstallModel');
            // 获取遥测状态
            let telemetry = null;
            try {
                const install = await pluginInstallModel.getInstall();
                if (install) {
                    telemetry = {
                        enabled: install.telemetryEnabled,
                        instanceId: install.instanceId.slice(-8),
                        lastReportAt: install.lastReportAt?.toISOString(),
                        version: install.lastVersion,
                    };
                }
            }
            catch { /* non-critical */ }
            const config = await aiConfigModel.getConfig();
            if (!config) {
                this.response.body = {
                    config: null,
                    telemetry,
                    builtinJailbreakPatterns: jailbreakRules_1.builtinJailbreakPatternSources,
                };
                this.response.type = 'application/json';
                return;
            }
            // 处理端点的 API Key 脱敏
            const endpointsWithMaskedKeys = (config.endpoints || []).map(ep => {
                let apiKeyMasked = '';
                let hasApiKey = false;
                try {
                    if (ep.apiKeyEncrypted) {
                        const apiKeyPlain = (0, crypto_1.decrypt)(ep.apiKeyEncrypted);
                        apiKeyMasked = (0, crypto_1.maskApiKey)(apiKeyPlain);
                        hasApiKey = true;
                    }
                }
                catch {
                    hasApiKey = false;
                }
                return {
                    id: ep.id,
                    name: ep.name,
                    apiBaseUrl: ep.apiBaseUrl,
                    models: ep.models || [],
                    modelsLastFetched: ep.modelsLastFetched?.toISOString(),
                    enabled: ep.enabled,
                    apiKeyMasked,
                    hasApiKey,
                };
            });
            // 兼容旧版：处理旧版单 API Key
            let apiKeyMasked = '';
            let hasApiKey = false;
            try {
                if (config.apiKeyEncrypted) {
                    const apiKeyPlain = (0, crypto_1.decrypt)(config.apiKeyEncrypted);
                    apiKeyMasked = (0, crypto_1.maskApiKey)(apiKeyPlain);
                    hasApiKey = true;
                }
            }
            catch (err) {
                console.error('[AdminConfigHandler] API Key 解密失败:', err instanceof Error ? err.message : 'unknown');
                hasApiKey = false;
            }
            this.response.body = {
                config: {
                    endpoints: endpointsWithMaskedKeys,
                    selectedModels: config.selectedModels || [],
                    scenarioModels: config.scenarioModels || {},
                    apiBaseUrl: config.apiBaseUrl,
                    modelName: config.modelName,
                    rateLimitPerMinute: config.rateLimitPerMinute,
                    timeoutSeconds: config.timeoutSeconds,
                    systemPromptTemplate: config.systemPromptTemplate,
                    extraJailbreakPatternsText: config.extraJailbreakPatternsText || '',
                    budgetConfig: config.budgetConfig || {},
                    apiKeyMasked,
                    hasApiKey,
                    updatedAt: config.updatedAt.toISOString()
                },
                telemetry,
                builtinJailbreakPatterns: jailbreakRules_1.builtinJailbreakPatternSources,
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] AdminConfigHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = { error: this.translate('ai_helper_err_internal'), code: 'INTERNAL_ERROR' };
            this.response.type = 'application/json';
        }
    }
    /**
     * PUT /ai-helper/admin/config
     * 更新配置（支持旧版单端点和新版多端点）
     */
    async put() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const aiConfigModel = this.ctx.get('aiConfigModel');
            const body = this.request.body;
            const partial = {};
            // 处理新版多端点配置
            if (body.endpoints !== undefined) {
                const existingConfig = await aiConfigModel.getConfig();
                const existingEndpoints = existingConfig?.endpoints || [];
                const newEndpoints = [];
                const idMapping = {}; // 临时 ID → 真实 UUID
                for (const ep of body.endpoints) {
                    // 检查是否为临时 ID（前端为未保存端点生成 temp-xxx）
                    const isTemp = ep.id && ep.id.startsWith('temp-');
                    // 查找是否有现有端点
                    const existing = (ep.id && !isTemp) ? existingEndpoints.find(e => e.id === ep.id) : null;
                    let apiKeyEncrypted = existing?.apiKeyEncrypted || '';
                    // 如果提供了新的 API Key，加密它
                    if (ep.apiKey && ep.apiKey.trim()) {
                        try {
                            apiKeyEncrypted = (0, crypto_1.encrypt)(ep.apiKey.trim());
                        }
                        catch (_err) {
                            this.response.status = 500;
                            this.response.body = {
                                error: (0, i18nHelper_1.translateWithParams)(this, 'ai_helper_config_endpoint_encrypt_failed', ep.name),
                                code: 'ENCRYPT_FAILED',
                            };
                            this.response.type = 'application/json';
                            return;
                        }
                    }
                    const realId = existing ? ep.id : (await Promise.resolve().then(() => __importStar(require('crypto')))).randomUUID();
                    if (isTemp && ep.id) {
                        idMapping[ep.id] = realId;
                    }
                    newEndpoints.push({
                        id: realId,
                        name: ep.name,
                        apiBaseUrl: ep.apiBaseUrl,
                        apiKeyEncrypted,
                        models: ep.models || existing?.models || [],
                        modelsLastFetched: existing?.modelsLastFetched,
                        enabled: ep.enabled !== undefined ? ep.enabled : true,
                    });
                }
                partial.endpoints = newEndpoints;
                // 重映射 selectedModels 中的临时 ID
                if (body.selectedModels !== undefined && Object.keys(idMapping).length > 0) {
                    body.selectedModels = body.selectedModels.map(sm => ({
                        ...sm,
                        endpointId: idMapping[sm.endpointId] || sm.endpointId,
                    }));
                }
                // 重映射 scenarioModels 中的临时 ID
                if (body.scenarioModels !== undefined && Object.keys(idMapping).length > 0) {
                    const remapped = {};
                    for (const scenario of aiConfig_1.AI_SCENARIOS) {
                        const chain = body.scenarioModels[scenario];
                        if (Array.isArray(chain)) {
                            remapped[scenario] = chain.map(sm => ({
                                ...sm,
                                endpointId: idMapping[sm.endpointId] || sm.endpointId,
                            }));
                        }
                    }
                    body.scenarioModels = remapped;
                }
            }
            // 处理选中的模型
            if (body.selectedModels !== undefined) {
                partial.selectedModels = body.selectedModels;
            }
            // 处理按场景覆盖的模型链（仅保留已知场景和合法条目）
            if (body.scenarioModels !== undefined) {
                const sanitized = {};
                for (const scenario of aiConfig_1.AI_SCENARIOS) {
                    const chain = body.scenarioModels?.[scenario];
                    if (Array.isArray(chain)) {
                        sanitized[scenario] = chain
                            .filter(sm => sm && typeof sm.endpointId === 'string' && typeof sm.modelName === 'string')
                            .map(sm => ({ endpointId: sm.endpointId, modelName: sm.modelName }));
                    }
                }
                partial.scenarioModels = sanitized;
            }
            // 旧版单端点字段（向后兼容）
            if (body.apiBaseUrl !== undefined) {
                partial.apiBaseUrl = body.apiBaseUrl.trim();
            }
            if (body.modelName !== undefined) {
                partial.modelName = body.modelName.trim();
            }
            if (body.rateLimitPerMinute !== undefined) {
                const rate = parseInt(String(body.rateLimitPerMinute), 10);
                if (Number.isNaN(rate) || rate < 0) {
                    this.response.status = 400;
                    this.response.body = { error: this.translate('ai_helper_config_rate_limit_invalid'), code: 'INVALID_RATE_LIMIT' };
                    this.response.type = 'application/json';
                    return;
                }
                partial.rateLimitPerMinute = rate;
            }
            if (body.timeoutSeconds !== undefined) {
                const timeout = parseInt(String(body.timeoutSeconds), 10);
                if (timeout <= 0) {
                    this.response.status = 400;
                    this.response.body = { error: this.translate('ai_helper_config_timeout_invalid'), code: 'INVALID_TIMEOUT' };
                    this.response.type = 'application/json';
                    return;
                }
                partial.timeoutSeconds = timeout;
            }
            if (body.systemPromptTemplate !== undefined) {
                partial.systemPromptTemplate = body.systemPromptTemplate;
            }
            if (body.extraJailbreakPatternsText !== undefined) {
                partial.extraJailbreakPatternsText = body.extraJailbreakPatternsText;
            }
            if (body.budgetConfig !== undefined) {
                const bc = body.budgetConfig;
                partial.budgetConfig = {
                    dailyTokenLimitPerUser: Math.max(0, Math.floor(Number(bc.dailyTokenLimitPerUser) || 0)),
                    dailyTokenLimitPerDomain: Math.max(0, Math.floor(Number(bc.dailyTokenLimitPerDomain) || 0)),
                    monthlyTokenLimitPerDomain: Math.max(0, Math.floor(Number(bc.monthlyTokenLimitPerDomain) || 0)),
                    softLimitPercent: Math.min(100, Math.max(0, Math.floor(Number(bc.softLimitPercent) || 80))),
                };
            }
            // 遥测开关
            if (body.telemetryEnabled !== undefined) {
                try {
                    const pim = this.ctx.get('pluginInstallModel');
                    await pim.updateTelemetryEnabled(!!body.telemetryEnabled);
                }
                catch (err) {
                    console.error('[AdminConfigHandler] Update telemetry failed:', err);
                }
            }
            // 旧版单 API Key（向后兼容）
            if (body.apiKey !== undefined && body.apiKey !== '') {
                try {
                    partial.apiKeyEncrypted = (0, crypto_1.encrypt)(body.apiKey.trim());
                }
                catch (_err) {
                    this.response.status = 500;
                    this.response.body = {
                        error: this.translate('ai_helper_config_apikey_encrypt_failed'),
                        code: 'ENCRYPT_FAILED',
                    };
                    this.response.type = 'application/json';
                    return;
                }
            }
            await aiConfigModel.updateConfig(partial);
            const updatedConfig = await aiConfigModel.getConfig();
            if (!updatedConfig) {
                throw new Error('配置更新后读取失败');
            }
            // 处理端点的 API Key 脱敏
            const endpointsWithMaskedKeys = (updatedConfig.endpoints || []).map(ep => {
                let apiKeyMasked = '';
                let hasApiKey = false;
                try {
                    if (ep.apiKeyEncrypted) {
                        const apiKeyPlain = (0, crypto_1.decrypt)(ep.apiKeyEncrypted);
                        apiKeyMasked = (0, crypto_1.maskApiKey)(apiKeyPlain);
                        hasApiKey = true;
                    }
                }
                catch {
                    hasApiKey = false;
                }
                return {
                    id: ep.id,
                    name: ep.name,
                    apiBaseUrl: ep.apiBaseUrl,
                    models: ep.models || [],
                    modelsLastFetched: ep.modelsLastFetched?.toISOString(),
                    enabled: ep.enabled,
                    apiKeyMasked,
                    hasApiKey,
                };
            });
            // 兼容旧版：处理单 API Key
            let apiKeyMasked = '';
            let hasApiKey = false;
            try {
                if (updatedConfig.apiKeyEncrypted) {
                    const apiKeyPlain = (0, crypto_1.decrypt)(updatedConfig.apiKeyEncrypted);
                    apiKeyMasked = (0, crypto_1.maskApiKey)(apiKeyPlain);
                    hasApiKey = true;
                }
            }
            catch (err) {
                console.error('[AdminConfigHandler] API Key 解密失败:', err instanceof Error ? err.message : 'unknown');
                hasApiKey = false;
            }
            this.response.body = {
                config: {
                    endpoints: endpointsWithMaskedKeys,
                    selectedModels: updatedConfig.selectedModels || [],
                    scenarioModels: updatedConfig.scenarioModels || {},
                    apiBaseUrl: updatedConfig.apiBaseUrl,
                    modelName: updatedConfig.modelName,
                    rateLimitPerMinute: updatedConfig.rateLimitPerMinute,
                    timeoutSeconds: updatedConfig.timeoutSeconds,
                    systemPromptTemplate: updatedConfig.systemPromptTemplate,
                    extraJailbreakPatternsText: updatedConfig.extraJailbreakPatternsText || '',
                    budgetConfig: updatedConfig.budgetConfig || {},
                    apiKeyMasked,
                    hasApiKey,
                    updatedAt: updatedConfig.updatedAt.toISOString()
                },
                builtinJailbreakPatterns: jailbreakRules_1.builtinJailbreakPatternSources,
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AdminConfigHandler] 更新配置失败:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                error: this.translate('ai_helper_config_update_failed'),
                code: 'CONFIG_UPDATE_FAILED',
            };
            this.response.type = 'application/json';
        }
    }
}
exports.AdminConfigHandler = AdminConfigHandler;
/**
 * JailbreakLogsHandler - 独立的越狱日志分页端点
 * GET /ai-helper/admin/jailbreak-logs?page=1&limit=20
 */
class JailbreakLogsHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            const query = this.request.query || {};
            const page = parseInt(String(query.page || '1'), 10) || 1;
            const limit = parseInt(String(query.limit || '20'), 10) || 20;
            const parsedFilters = parseJailbreakLogFilters(query);
            if (!parsedFilters) {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_filter_invalid'),
                    code: 'INVALID_JAILBREAK_LOG_FILTER',
                };
                this.response.type = 'application/json';
                return;
            }
            const filters = parsedFilters;
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const [logResult, summary, ruleMetrics, operationalMetrics] = await Promise.all([
                jailbreakLogModel.listWithPagination(page, limit, domainId, filters),
                jailbreakLogModel.getReviewSummary(domainId),
                jailbreakLogModel.getRuleMetrics(domainId, 10),
                jailbreakLogModel.getOperationalMetrics(domainId, 14),
            ]);
            this.response.body = {
                logs: logResult.logs.map(formatJailbreakLog),
                total: logResult.total,
                page: logResult.page,
                totalPages: logResult.totalPages,
                summary,
                ruleMetrics,
                operationalMetrics,
                filters,
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] JailbreakLogsHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = { error: this.translate('ai_helper_config_jailbreak_logs_failed'), code: 'JAILBREAK_LOGS_FAILED' };
            this.response.type = 'application/json';
        }
    }
}
exports.JailbreakLogsHandler = JailbreakLogsHandler;
/**
 * JailbreakLogFilterOptionsHandler - 按输入片段返回当前域安全日志中的学生/题目候选项
 * GET /ai-helper/admin/jailbreak-logs/filter-options?kind=user&q=42
 */
class JailbreakLogFilterOptionsHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const query = this.request.query || {};
            const kind = String(query.kind || '');
            const partial = String(query.q || '').trim();
            const requestedLimit = parseInt(String(query.limit || '10'), 10) || 10;
            const limit = Math.min(20, Math.max(1, requestedLimit));
            const invalidPartial = kind === 'user'
                ? !/^\d{1,32}$/.test(partial)
                : !partial || partial.length > 64;
            if (!['user', 'problem'].includes(kind) || invalidPartial) {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_filter_suggestions_invalid'),
                    code: 'INVALID_JAILBREAK_FILTER_SUGGESTION',
                };
                this.response.type = 'application/json';
                return;
            }
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_safety_filter_suggestions',
                periodSecs: 60,
                maxOps: 60,
                failOpen: false,
                errorMessage: 'ai_helper_admin_jailbreak_filter_suggestions_rate_limited',
            }))
                return;
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            if (kind === 'user') {
                const userIds = await jailbreakLogModel.suggestUserIds(domainId, partial, limit);
                const users = userIds.length > 0
                    ? await this.ctx.db.collection('user').find({ _id: { $in: userIds } }, { projection: { _id: 1, uname: 1 } }).toArray()
                    : [];
                const nameById = new Map(users.map((user) => [user._id, user.uname || String(user._id)]));
                this.response.body = {
                    kind,
                    options: userIds.map((id) => ({
                        value: String(id),
                        label: nameById.get(id) || String(id),
                    })),
                };
            }
            else {
                const problemIds = await jailbreakLogModel.suggestProblemIds(domainId, partial, limit);
                const numericIds = [
                    ...new Set(problemIds
                        .map((problemId) => (0, problemIdHelper_1.parseProblemId)(problemId))
                        .filter((problemId) => problemId !== null)),
                ];
                const problems = numericIds.length > 0
                    ? await this.ctx.db.collection('document').find({ domainId, docType: 10, docId: { $in: numericIds } }, { projection: { docId: 1, title: 1 } }).toArray()
                    : [];
                const titleById = new Map(problems.map((problem) => [problem.docId, problem.title || String(problem.docId)]));
                this.response.body = {
                    kind,
                    options: problemIds.map((id) => {
                        const numericId = (0, problemIdHelper_1.parseProblemId)(id);
                        return {
                            value: id,
                            label: numericId === null ? id : titleById.get(numericId) || id,
                        };
                    }),
                };
            }
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] JailbreakLogFilterOptionsHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                error: this.translate('ai_helper_admin_jailbreak_filter_suggestions_failed'),
                code: 'JAILBREAK_FILTER_SUGGESTIONS_FAILED',
            };
            this.response.type = 'application/json';
        }
    }
}
exports.JailbreakLogFilterOptionsHandler = JailbreakLogFilterOptionsHandler;
/**
 * JailbreakLogsExportHandler - 导出当前域内、按当前筛选条件命中的脱敏安全事件
 * GET /ai-helper/admin/jailbreak-logs/export
 */
class JailbreakLogsExportHandler extends hydrooj_1.Handler {
    async get() {
        try {
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_safety_log_export',
                periodSecs: 60,
                maxOps: 3,
                failOpen: true,
                errorMessage: 'ai_helper_export_rate_limited',
            }))
                return;
            const parsedFilters = parseJailbreakLogFilters(this.request.query || {});
            if (!parsedFilters) {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_filter_invalid'),
                    code: 'INVALID_JAILBREAK_LOG_FILTER',
                };
                this.response.type = 'application/json';
                return;
            }
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            const result = await jailbreakLogModel.listForExport((0, domainHelper_1.getDomainId)(this), parsedFilters, 5000);
            const filename = `ai-safety-events-${new Date().toISOString().slice(0, 10)}.csv`;
            this.response.type = 'text/csv; charset=utf-8';
            this.response.addHeader('Content-Disposition', `attachment; filename="${filename}"`);
            this.response.addHeader('X-AI-Helper-Export-Total', String(result.total));
            this.response.addHeader('X-AI-Helper-Export-Truncated', String(result.truncated));
            this.response.body = serializeSafetyLogsCsv(result.logs, {
                total: result.total,
                truncated: result.truncated,
            });
        }
        catch (err) {
            console.error('[AI Helper] JailbreakLogsExportHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                error: this.translate('ai_helper_admin_jailbreak_export_failed'),
                code: 'JAILBREAK_LOG_EXPORT_FAILED',
            };
            this.response.type = 'application/json';
        }
    }
}
exports.JailbreakLogsExportHandler = JailbreakLogsExportHandler;
/**
 * JailbreakLogReviewHandler - 教师/管理员复核安全拦截记录
 * POST /ai-helper/admin/jailbreak-logs/:id/review
 */
class JailbreakLogReviewHandler extends hydrooj_1.Handler {
    async post({ id }) {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            if (!mongo_1.ObjectId.isValid(id)) {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_review_invalid_id'),
                    code: 'INVALID_JAILBREAK_LOG_ID',
                };
                this.response.type = 'application/json';
                return;
            }
            const { reviewStatus } = (this.request.body || {});
            if (reviewStatus !== 'confirmed' && reviewStatus !== 'false_positive') {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_review_invalid_status'),
                    code: 'INVALID_REVIEW_STATUS',
                };
                this.response.type = 'application/json';
                return;
            }
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            const updated = await jailbreakLogModel.review(id, (0, domainHelper_1.getDomainId)(this), reviewStatus, Number(this.user._id));
            if (!updated) {
                this.response.status = 404;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_review_not_found'),
                    code: 'JAILBREAK_LOG_NOT_FOUND',
                };
                this.response.type = 'application/json';
                return;
            }
            this.response.body = { success: true, reviewStatus };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] JailbreakLogReviewHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                error: this.translate('ai_helper_admin_jailbreak_review_failed'),
                code: 'JAILBREAK_LOG_REVIEW_FAILED',
            };
            this.response.type = 'application/json';
        }
    }
}
exports.JailbreakLogReviewHandler = JailbreakLogReviewHandler;
/**
 * JailbreakLogBulkReviewHandler - 批量复核当前域的安全拦截记录
 * POST /ai-helper/admin/jailbreak-logs/bulk-review
 */
class JailbreakLogBulkReviewHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const { ids, reviewStatus } = (this.request.body || {});
            if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100
                || ids.some((id) => typeof id !== 'string' || !mongo_1.ObjectId.isValid(id))) {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_bulk_invalid_ids'),
                    code: 'INVALID_JAILBREAK_LOG_IDS',
                };
                this.response.type = 'application/json';
                return;
            }
            if (reviewStatus !== 'confirmed' && reviewStatus !== 'false_positive') {
                this.response.status = 400;
                this.response.body = {
                    error: this.translate('ai_helper_admin_jailbreak_review_invalid_status'),
                    code: 'INVALID_REVIEW_STATUS',
                };
                this.response.type = 'application/json';
                return;
            }
            const uniqueIds = [...new Set(ids)];
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            const result = await jailbreakLogModel.reviewMany(uniqueIds, (0, domainHelper_1.getDomainId)(this), reviewStatus, Number(this.user._id));
            this.response.body = { success: true, ...result, reviewStatus };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] JailbreakLogBulkReviewHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                error: this.translate('ai_helper_admin_jailbreak_bulk_failed'),
                code: 'JAILBREAK_LOG_BULK_REVIEW_FAILED',
            };
            this.response.type = 'application/json';
        }
    }
}
exports.JailbreakLogBulkReviewHandler = JailbreakLogBulkReviewHandler;
// 导出路由权限配置（使用系统管理员权限）
exports.AdminConfigHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.JailbreakLogsHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.JailbreakLogFilterOptionsHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.JailbreakLogsExportHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.JailbreakLogReviewHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.JailbreakLogBulkReviewHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
function formatJailbreakLog(log) {
    return {
        id: log._id.toHexString(),
        domainId: log.domainId,
        userId: log.userId,
        problemId: log.problemId,
        conversationId: log.conversationId ? log.conversationId.toHexString() : undefined,
        questionType: log.questionType,
        matchedPattern: log.matchedPattern,
        matchedText: log.matchedText,
        category: log.category,
        confidence: log.confidence,
        riskScore: log.riskScore,
        detectionSource: log.detectionSource,
        actionTaken: log.actionTaken,
        blockedUntil: log.blockedUntil?.toISOString(),
        reviewStatus: log.reviewStatus || 'pending',
        reviewedAt: log.reviewedAt?.toISOString(),
        reviewedBy: log.reviewedBy,
        studentAppealedAt: log.studentAppealedAt?.toISOString(),
        studentAppealReason: log.studentAppealReason,
        expiresAt: log.expiresAt?.toISOString(),
        createdAt: log.createdAt.toISOString()
    };
}
const VALID_REVIEW_STATUSES = ['pending', 'confirmed', 'false_positive'];
const VALID_CATEGORIES = [
    'answer_seeking',
    'prompt_injection',
    'prompt_exfiltration',
    'obfuscated_injection',
];
const VALID_ACTIONS = ['blocked', 'cooldown_60s', 'cooldown_5m'];
const VALID_DETECTION_SOURCES = [
    'plain',
    'compacted',
    'base64',
    'hex',
    'conversation',
    'custom',
];
function parseDateFilter(value, endOfDay) {
    if (!value)
        return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return null;
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const parsed = new Date(`${value}${suffix}`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
        ? null
        : parsed;
}
function parseJailbreakLogFilters(query) {
    const reviewStatusRaw = String(query.reviewStatus || '').trim();
    const categoryRaw = String(query.category || '').trim();
    const appealedRaw = String(query.appealed || '').trim();
    const userIdRaw = String(query.userId || '').trim();
    const problemIdRaw = String(query.problemId || '').trim();
    const actionRaw = String(query.actionTaken || '').trim();
    const detectionSourceRaw = String(query.detectionSource || '').trim();
    const dateFromRaw = String(query.dateFrom || '').trim();
    const dateToRaw = String(query.dateTo || '').trim();
    const createdFrom = parseDateFilter(dateFromRaw, false);
    const createdTo = parseDateFilter(dateToRaw, true);
    const userId = userIdRaw ? Number(userIdRaw) : undefined;
    if ((reviewStatusRaw && !VALID_REVIEW_STATUSES.includes(reviewStatusRaw))
        || (categoryRaw && !VALID_CATEGORIES.includes(categoryRaw))
        || (appealedRaw && appealedRaw !== '1')
        || (userIdRaw && (!Number.isSafeInteger(userId) || userId < 0))
        || problemIdRaw.length > 128
        || (actionRaw && !VALID_ACTIONS.includes(actionRaw))
        || (detectionSourceRaw && !VALID_DETECTION_SOURCES.includes(detectionSourceRaw))
        || createdFrom === null
        || createdTo === null
        || (createdFrom && createdTo && createdFrom > createdTo)) {
        return null;
    }
    return {
        ...(reviewStatusRaw ? { reviewStatus: reviewStatusRaw } : {}),
        ...(categoryRaw ? { category: categoryRaw } : {}),
        ...(appealedRaw === '1' ? { appealedOnly: true } : {}),
        ...(userId !== undefined ? { userId } : {}),
        ...(problemIdRaw ? { problemId: problemIdRaw } : {}),
        ...(actionRaw ? { actionTaken: actionRaw } : {}),
        ...(detectionSourceRaw ? { detectionSource: detectionSourceRaw } : {}),
        ...(createdFrom ? { createdFrom } : {}),
        ...(createdTo ? { createdTo } : {}),
    };
}
function escapeCsvCell(value) {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^\s*[=+\-@]/u.test(text))
        text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}
function serializeSafetyLogsCsv(logs, metadata = { total: logs.length, truncated: false }) {
    const columns = [
        { header: 'createdAt', value: (log) => log.createdAt.toISOString() },
        { header: 'eventId', value: (log) => log._id.toHexString() },
        { header: 'userId', value: (log) => log.userId },
        { header: 'problemId', value: (log) => log.problemId },
        { header: 'category', value: (log) => log.category },
        { header: 'confidence', value: (log) => log.confidence },
        { header: 'riskScore', value: (log) => log.riskScore },
        { header: 'detectionSource', value: (log) => log.detectionSource },
        { header: 'actionTaken', value: (log) => log.actionTaken },
        { header: 'reviewStatus', value: (log) => log.reviewStatus || 'pending' },
        { header: 'studentAppealedAt', value: (log) => log.studentAppealedAt?.toISOString() },
        { header: 'reviewedAt', value: (log) => log.reviewedAt?.toISOString() },
        { header: 'matchedPattern', value: (log) => log.matchedPattern },
    ];
    const metadataColumns = ['recordType', 'exportedCount', 'totalMatched', 'truncated'];
    const rows = [
        [...metadataColumns, ...columns.map((column) => column.header)].map(escapeCsvCell).join(','),
        [
            'metadata',
            logs.length,
            metadata.total,
            metadata.truncated,
            ...columns.map(() => ''),
        ].map(escapeCsvCell).join(','),
        ...logs.map((log) => [
            'event', '', '', '', ...columns.map((column) => column.value(log)),
        ].map(escapeCsvCell).join(',')),
    ];
    return `\uFEFF${rows.join('\r\n')}`;
}
//# sourceMappingURL=adminConfigHandler.js.map