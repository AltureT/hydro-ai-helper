"use strict";
/**
 * 管理员配置 Handler
 * 处理管理员配置 AI 服务的请求
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestConnectionHandlerPriv = exports.UpdateConfigHandlerPriv = exports.GetConfigHandlerPriv = exports.TestConnectionHandler = exports.UpdateConfigHandler = exports.GetConfigHandler = void 0;
const hydrooj_1 = require("hydrooj");
const crypto_1 = require("../lib/crypto");
const openaiClient_1 = require("../services/openaiClient");
/**
 * GetConfigHandler - 获取当前配置
 * GET /ai-helper/admin/config
 */
class GetConfigHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const aiConfigModel = this.ctx.get('aiConfigModel');
            // 读取配置
            const config = await aiConfigModel.getConfig();
            if (!config) {
                // 尚未配置，返回 null
                this.response.body = {
                    config: null
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
                console.error('[GetConfigHandler] API Key 解密失败:', err);
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
                    apiKeyMasked,
                    hasApiKey,
                    updatedAt: config.updatedAt.toISOString()
                }
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[GetConfigHandler] Error:', err);
            this.response.status = 500;
            this.response.body = {
                error: err instanceof Error ? err.message : '获取配置失败'
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
                if (rate <= 0) {
                    this.response.status = 400;
                    this.response.body = {
                        error: 'rateLimitPerMinute 必须大于 0'
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
                        error: 'timeoutSeconds 必须大于 0'
                    };
                    this.response.type = 'application/json';
                    return;
                }
                partial.timeoutSeconds = timeout;
            }
            if (body.systemPromptTemplate !== undefined) {
                partial.systemPromptTemplate = body.systemPromptTemplate;
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
                        error: `API Key 加密失败: ${err instanceof Error ? err.message : String(err)}`
                    };
                    this.response.type = 'application/json';
                    return;
                }
            }
            // 如果 apiKey 字段不存在或为空字符串，不修改现有 key
            // 更新配置
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
                console.error('[UpdateConfigHandler] API Key 解密失败:', err);
                hasApiKey = false;
            }
            // 返回更新后的配置
            this.response.body = {
                config: {
                    apiBaseUrl: updatedConfig.apiBaseUrl,
                    modelName: updatedConfig.modelName,
                    rateLimitPerMinute: updatedConfig.rateLimitPerMinute,
                    timeoutSeconds: updatedConfig.timeoutSeconds,
                    systemPromptTemplate: updatedConfig.systemPromptTemplate,
                    apiKeyMasked,
                    hasApiKey,
                    updatedAt: updatedConfig.updatedAt.toISOString()
                }
            };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[UpdateConfigHandler] Error:', err);
            this.response.status = 500;
            this.response.body = {
                error: err instanceof Error ? err.message : '更新配置失败'
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
            const aiConfigModel = this.ctx.get('aiConfigModel');
            // 读取当前配置
            const config = await aiConfigModel.getConfig();
            if (!config) {
                this.response.status = 400;
                this.response.body = {
                    success: false,
                    message: 'AI 服务配置不存在，请先设置配置。'
                };
                this.response.type = 'application/json';
                return;
            }
            // 检查配置完整性
            if (!config.apiBaseUrl || !config.modelName || !config.apiKeyEncrypted) {
                this.response.status = 400;
                this.response.body = {
                    success: false,
                    message: 'AI 服务配置不完整，请先设置 API Base URL、模型名称和 API Key。'
                };
                this.response.type = 'application/json';
                return;
            }
            // 解密 API Key
            let apiKey;
            try {
                apiKey = (0, crypto_1.decrypt)(config.apiKeyEncrypted);
            }
            catch (err) {
                this.response.status = 500;
                this.response.body = {
                    success: false,
                    message: `API Key 解密失败: ${err instanceof Error ? err.message : String(err)}`
                };
                this.response.type = 'application/json';
                return;
            }
            // 创建临时 OpenAI 客户端
            const client = new openaiClient_1.OpenAIClient({
                apiBaseUrl: config.apiBaseUrl,
                modelName: config.modelName,
                apiKey,
                timeoutSeconds: config.timeoutSeconds || 30
            });
            // 发送测试请求
            try {
                await client.chat([{ role: 'user', content: 'ping' }], 'You are a health check assistant for AI Helper.');
                this.response.body = {
                    success: true,
                    message: '连接成功！AI 服务配置正确。'
                };
                this.response.type = 'application/json';
            }
            catch (err) {
                // 调用失败，但返回 200(业务层错误，不是 HTTP 错误)
                this.response.status = 200;
                this.response.body = {
                    success: false,
                    message: err instanceof Error ? err.message : '调用 AI 服务失败'
                };
                this.response.type = 'application/json';
            }
        }
        catch (err) {
            console.error('[TestConnectionHandler] Error:', err);
            this.response.status = 500;
            this.response.body = {
                success: false,
                message: err instanceof Error ? err.message : '测试连接失败'
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
//# sourceMappingURL=adminHandler.js.map