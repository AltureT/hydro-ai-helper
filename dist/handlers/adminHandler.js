"use strict";
/**
 * 管理员配置 Handler
 * 处理管理员配置 AI 服务的请求
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FetchModelsHandler = exports.FetchModelsHandlerPriv = exports.TestConnectionHandlerPriv = exports.UpdateConfigHandlerPriv = exports.GetConfigHandlerPriv = exports.TestConnectionHandler = exports.UpdateConfigHandler = exports.GetConfigHandler = void 0;
const hydrooj_1 = require("hydrooj");
const crypto_1 = require("../lib/crypto");
const openaiClient_1 = require("../services/openaiClient");
const jailbreakRules_1 = require("../constants/jailbreakRules");
const rateLimitHelper_1 = require("../lib/rateLimitHelper");
const csrfHelper_1 = require("../lib/csrfHelper");
const i18nHelper_1 = require("../utils/i18nHelper");
/**
 * GetConfigHandler - 获取当前配置
 * GET /ai-helper/admin/config
 */
class GetConfigHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const aiConfigModel = this.ctx.get('aiConfigModel');
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            // 读取配置
            const config = await aiConfigModel.getConfig();
            const recentLogs = await jailbreakLogModel.listRecent(20);
            if (!config) {
                // 尚未配置，返回 null
                this.response.body = {
                    config: null,
                    builtinJailbreakPatterns: jailbreakRules_1.builtinJailbreakPatternSources,
                    recentJailbreakLogs: recentLogs.map(formatJailbreakLog)
                };
                this.response.type = 'application/json';
                return;
            }
            // 解密 API Key 并脱敏
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
                // 解密失败，视为无有效 API Key
                console.error('[GetConfigHandler] API Key 解密失败:', err instanceof Error ? err.message : 'unknown');
                hasApiKey = false;
            }
            // 构造响应(不包含 apiKeyEncrypted 和明文 API Key)
            this.response.body = {
                config: {
                    apiBaseUrl: config.apiBaseUrl,
                    modelName: config.modelName,
                    rateLimitPerMinute: config.rateLimitPerMinute,
                    timeoutSeconds: config.timeoutSeconds,
                    systemPromptTemplate: config.systemPromptTemplate,
                    extraJailbreakPatternsText: config.extraJailbreakPatternsText || '',
                    apiKeyMasked,
                    hasApiKey,
                    updatedAt: config.updatedAt.toISOString()
                },
                builtinJailbreakPatterns: jailbreakRules_1.builtinJailbreakPatternSources,
                recentJailbreakLogs: recentLogs.map(formatJailbreakLog)
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[GetConfigHandler] Error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                error: this.translate('ai_helper_config_get_failed'),
                code: 'CONFIG_GET_FAILED',
            };
            this.response.type = 'application/json';
        }
    }
}
exports.GetConfigHandler = GetConfigHandler;
/**
 * UpdateConfigHandler - 更新配置
 * PUT /ai-helper/admin/config
 */
class UpdateConfigHandler extends hydrooj_1.Handler {
    async put() {
        try {
            const aiConfigModel = this.ctx.get('aiConfigModel');
            // 读取请求体
            const body = this.request.body;
            // 构造部分更新对象
            const partial = {};
            // 更新字段（如果提供）
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
                    this.response.body = {
                        error: this.translate('ai_helper_config_rate_limit_invalid'),
                        code: 'INVALID_RATE_LIMIT',
                    };
                    this.response.type = 'application/json';
                    return;
                }
                partial.rateLimitPerMinute = rate;
            }
            if (body.timeoutSeconds !== undefined) {
                const timeout = parseInt(String(body.timeoutSeconds), 10);
                if (timeout <= 0) {
                    this.response.status = 400;
                    this.response.body = {
                        error: this.translate('ai_helper_config_timeout_invalid'),
                        code: 'INVALID_TIMEOUT',
                    };
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
            // 处理 API Key
            if (body.apiKey !== undefined && body.apiKey !== '') {
                // 提供了新的 API Key，加密后存储
                try {
                    partial.apiKeyEncrypted = (0, crypto_1.encrypt)(body.apiKey.trim());
                }
                catch (err) {
                    this.response.status = 500;
                    this.response.body = {
                        error: this.translate('ai_helper_config_apikey_encrypt_failed'),
                        code: 'ENCRYPT_FAILED',
                    };
                    this.response.type = 'application/json';
                    return;
                }
            }
            // 如果 apiKey 字段不存在或为空字符串，不修改现有 key
            // 更新配置
            const jailbreakLogModel = this.ctx.get('jailbreakLogModel');
            await aiConfigModel.updateConfig(partial);
            // 重新读取配置并返回
            const updatedConfig = await aiConfigModel.getConfig();
            if (!updatedConfig) {
                throw new Error('配置更新后读取失败');
            }
            // 解密 API Key 并脱敏
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
                console.error('[UpdateConfigHandler] API Key 解密失败:', err instanceof Error ? err.message : 'unknown');
                hasApiKey = false;
            }
            // 返回更新后的配置
            const recentLogs = await jailbreakLogModel.listRecent(20);
            this.response.body = {
                config: {
                    apiBaseUrl: updatedConfig.apiBaseUrl,
                    modelName: updatedConfig.modelName,
                    rateLimitPerMinute: updatedConfig.rateLimitPerMinute,
                    timeoutSeconds: updatedConfig.timeoutSeconds,
                    systemPromptTemplate: updatedConfig.systemPromptTemplate,
                    extraJailbreakPatternsText: updatedConfig.extraJailbreakPatternsText || '',
                    apiKeyMasked,
                    hasApiKey,
                    updatedAt: updatedConfig.updatedAt.toISOString()
                },
                builtinJailbreakPatterns: jailbreakRules_1.builtinJailbreakPatternSources,
                recentJailbreakLogs: recentLogs.map(formatJailbreakLog)
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[UpdateConfigHandler] Error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                error: this.translate('ai_helper_config_update_failed'),
                code: 'CONFIG_UPDATE_FAILED',
            };
            this.response.type = 'application/json';
        }
    }
}
exports.UpdateConfigHandler = UpdateConfigHandler;
/**
 * TestConnectionHandler - 测试 AI 服务连接
 * POST /ai-helper/admin/test-connection
 */
class TestConnectionHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            // 限流：5 次/60秒，fail-closed（触发外部 API）
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_admin_test', periodSecs: 60, maxOps: 5,
                errorMessage: 'ai_helper_admin_test_rate_limited',
            }))
                return;
            const aiConfigModel = this.ctx.get('aiConfigModel');
            // 读取当前配置
            const config = await aiConfigModel.getConfig();
            if (!config) {
                this.response.status = 400;
                this.response.body = {
                    success: false,
                    message: this.translate('ai_helper_admin_config_not_exist'),
                };
                this.response.type = 'application/json';
                return;
            }
            // 确定测试目标：优先使用 v2 endpoints，回退到 legacy 字段
            let apiBaseUrl;
            let modelName;
            let apiKeyEncrypted;
            if (config.endpoints?.length > 0 && config.selectedModels?.length > 0) {
                // v2 多端点配置：找到第一个启用的选中模型对应的端点
                for (const sm of config.selectedModels) {
                    const ep = config.endpoints.find(e => e.id === sm.endpointId && e.enabled);
                    if (ep) {
                        apiBaseUrl = ep.apiBaseUrl;
                        apiKeyEncrypted = ep.apiKeyEncrypted;
                        modelName = sm.modelName;
                        break;
                    }
                }
            }
            // 回退到 legacy 字段
            if (!apiBaseUrl || !modelName || !apiKeyEncrypted) {
                apiBaseUrl = apiBaseUrl || config.apiBaseUrl;
                modelName = modelName || config.modelName;
                apiKeyEncrypted = apiKeyEncrypted || config.apiKeyEncrypted;
            }
            if (!apiBaseUrl || !modelName || !apiKeyEncrypted) {
                this.response.status = 400;
                this.response.body = {
                    success: false,
                    message: this.translate('ai_helper_admin_config_incomplete'),
                };
                this.response.type = 'application/json';
                return;
            }
            // 解密 API Key
            let apiKey;
            try {
                apiKey = (0, crypto_1.decrypt)(apiKeyEncrypted);
            }
            catch (err) {
                this.response.status = 500;
                this.response.body = {
                    success: false,
                    message: this.translate('ai_helper_admin_apikey_decrypt_failed'),
                };
                this.response.type = 'application/json';
                return;
            }
            // 创建临时 OpenAI 客户端
            const client = new openaiClient_1.OpenAIClient({
                apiBaseUrl,
                modelName,
                apiKey,
                timeoutSeconds: config.timeoutSeconds || 30
            });
            // 发送测试请求
            try {
                await client.chat([{ role: 'user', content: 'ping' }], 'You are a health check assistant for AI Helper.');
                this.response.body = {
                    success: true,
                    message: this.translate('ai_helper_admin_test_success'),
                };
                this.response.type = 'application/json';
            }
            catch (err) {
                // 调用失败，但返回 200(业务层错误，不是 HTTP 错误)
                this.response.status = 200;
                this.response.body = {
                    success: false,
                    message: this.translate('ai_helper_admin_test_call_failed')
                };
                this.response.type = 'application/json';
            }
        }
        catch (err) {
            console.error('[TestConnectionHandler] Error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                success: false,
                message: this.translate('ai_helper_admin_test_failed')
            };
            this.response.type = 'application/json';
        }
    }
}
exports.TestConnectionHandler = TestConnectionHandler;
/**
 * 导出路由权限配置
 * 使用 PRIV.PRIV_EDIT_SYSTEM (root-only 权限)
 * AI 配置敏感，仅允许系统管理员访问
 */
exports.GetConfigHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.UpdateConfigHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.TestConnectionHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
exports.FetchModelsHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
/**
 * 验证 API Base URL 格式
 * 允许 http: 和 https:，支持内网/本地模型部署
 */
function validateApiBaseUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return 'INVALID_URL_FORMAT';
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return 'INVALID_URL_PROTOCOL';
    }
    return null;
}
/**
 * FetchModelsHandler - 获取 API 端点的可用模型列表
 * POST /ai-helper/admin/fetch-models
 */
class FetchModelsHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            // 限流：10 次/60秒，fail-closed（触发外部 API）
            if (await (0, rateLimitHelper_1.applyRateLimit)(this, {
                op: 'ai_admin_models', periodSecs: 60, maxOps: 10,
                errorMessage: 'ai_helper_admin_models_rate_limited',
            }))
                return;
            const body = this.request.body;
            let apiBaseUrl;
            let apiKey;
            if (body.endpointId) {
                // 从现有端点获取配置
                const aiConfigModel = this.ctx.get('aiConfigModel');
                const endpoint = await aiConfigModel.getEndpointById(body.endpointId);
                if (!endpoint) {
                    this.response.status = 404;
                    this.response.body = { success: false, error: this.translate('ai_helper_admin_endpoint_not_found') };
                    this.response.type = 'application/json';
                    return;
                }
                apiBaseUrl = endpoint.apiBaseUrl;
                try {
                    apiKey = (0, crypto_1.decrypt)(endpoint.apiKeyEncrypted);
                }
                catch {
                    this.response.status = 400;
                    this.response.body = { success: false, error: this.translate('ai_helper_admin_apikey_decrypt_failed') };
                    this.response.type = 'application/json';
                    return;
                }
            }
            else if (body.apiBaseUrl && body.apiKey) {
                // 使用传入的参数
                apiBaseUrl = body.apiBaseUrl;
                apiKey = body.apiKey;
            }
            else {
                this.response.status = 400;
                this.response.body = {
                    success: false,
                    error: this.translate('ai_helper_admin_fetch_models_params_missing')
                };
                this.response.type = 'application/json';
                return;
            }
            // SSRF 防护：验证 URL 安全性
            const urlError = validateApiBaseUrl(apiBaseUrl);
            if (urlError) {
                this.response.status = 400;
                this.response.body = { success: false, error: (0, i18nHelper_1.translateWithParams)(this, 'ai_helper_admin_url_invalid', urlError) };
                this.response.type = 'application/json';
                return;
            }
            // 获取模型列表
            const result = await (0, openaiClient_1.fetchAvailableModels)(apiBaseUrl, apiKey);
            if (result.success) {
                // 如果是从端点获取的，更新端点的模型列表和时间戳
                if (body.endpointId) {
                    const aiConfigModel = this.ctx.get('aiConfigModel');
                    await aiConfigModel.updateEndpoint(body.endpointId, {
                        models: result.models || [],
                        modelsLastFetched: new Date()
                    });
                }
                this.response.body = {
                    success: true,
                    models: result.models
                };
            }
            else {
                let errorMessage = result.error || '';
                if (result.errorKey) {
                    errorMessage = result.errorParams?.length
                        ? (0, i18nHelper_1.translateWithParams)(this, result.errorKey, ...result.errorParams)
                        : this.translate(result.errorKey);
                }
                this.response.body = {
                    success: false,
                    error: errorMessage
                };
            }
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[FetchModelsHandler] Error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = {
                success: false,
                error: this.translate('ai_helper_admin_fetch_models_failed')
            };
            this.response.type = 'application/json';
        }
    }
}
exports.FetchModelsHandler = FetchModelsHandler;
function formatJailbreakLog(log) {
    return {
        id: log._id.toHexString(),
        userId: log.userId,
        problemId: log.problemId,
        conversationId: log.conversationId ? log.conversationId.toHexString() : undefined,
        questionType: log.questionType,
        matchedPattern: log.matchedPattern,
        matchedText: log.matchedText,
        createdAt: log.createdAt.toISOString()
    };
}
//# sourceMappingURL=adminHandler.js.map