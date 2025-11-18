"use strict";
/**
 * AI 配置页面 Handler
 * 处理管理员配置页面的渲染和配置请求
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminConfigHandlerPriv = exports.AdminConfigHandler = void 0;
const hydrooj_1 = require("hydrooj");
const crypto_1 = require("../lib/crypto");
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
            const config = await aiConfigModel.getConfig();
            if (!config) {
                this.response.body = { config: null };
                this.response.type = 'application/json';
                return;
            }
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
                console.error('[AdminConfigHandler] API Key 解密失败:', err);
                hasApiKey = false;
            }
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
            console.error('[AI Helper] AdminConfigHandler error:', err);
            this.response.status = 500;
            this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
            this.response.type = 'application/json';
        }
    }
    /**
     * PUT /ai-helper/admin/config
     * 更新配置（与 UpdateConfigHandler 逻辑保持一致，避免路由冲突导致 405）
     */
    async put() {
        try {
            const aiConfigModel = this.ctx.get('aiConfigModel');
            const body = this.request.body;
            const partial = {};
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
                    this.response.body = { error: 'rateLimitPerMinute 必须大于 0' };
                    this.response.type = 'application/json';
                    return;
                }
                partial.rateLimitPerMinute = rate;
            }
            if (body.timeoutSeconds !== undefined) {
                const timeout = parseInt(String(body.timeoutSeconds), 10);
                if (timeout <= 0) {
                    this.response.status = 400;
                    this.response.body = { error: 'timeoutSeconds 必须大于 0' };
                    this.response.type = 'application/json';
                    return;
                }
                partial.timeoutSeconds = timeout;
            }
            if (body.systemPromptTemplate !== undefined) {
                partial.systemPromptTemplate = body.systemPromptTemplate;
            }
            if (body.apiKey !== undefined && body.apiKey !== '') {
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
            await aiConfigModel.updateConfig(partial);
            const updatedConfig = await aiConfigModel.getConfig();
            if (!updatedConfig) {
                throw new Error('配置更新后读取失败');
            }
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
                console.error('[AdminConfigHandler] API Key 解密失败:', err);
                hasApiKey = false;
            }
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
            console.error('[AdminConfigHandler] 更新配置失败:', err);
            this.response.status = 500;
            this.response.body = {
                error: err instanceof Error ? err.message : '更新配置失败'
            };
            this.response.type = 'application/json';
        }
    }
}
exports.AdminConfigHandler = AdminConfigHandler;
// 导出路由权限配置（使用系统管理员权限）
exports.AdminConfigHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=adminConfigHandler.js.map