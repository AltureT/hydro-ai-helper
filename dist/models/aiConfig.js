"use strict";
/**
 * AI Config Model - AI 服务配置数据模型
 *
 * 管理全局 AI 服务配置(API Key、模型名称等)
 * 约定：数据库中最多只有一条配置记录(固定 ID = 'default')
 *
 * v2 新增：支持多 API 端点配置、模型自动获取、Fallback 机制
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIConfigModel = exports.CURRENT_CONFIG_VERSION = void 0;
const crypto_1 = require("crypto");
/** 当前配置版本号 */
exports.CURRENT_CONFIG_VERSION = 2;
/**
 * AI Config Model 操作类
 * 封装 AI 配置的 CRUD 操作
 */
class AIConfigModel {
    constructor(db) {
        this.FIXED_ID = 'default'; // 固定配置记录 ID
        this.collection = db.collection('ai_config');
    }
    /**
     * 确保索引已创建
     * (单条记录无需复杂索引，仅用于一致性)
     */
    async ensureIndexes() {
        // 创建 _id 索引(MongoDB 自动创建，此处仅占位)
        console.log('[AIConfigModel] Collection initialized');
    }
    /**
     * 获取当前配置（自动执行懒迁移）
     * @returns 配置对象或 null(若尚未配置)
     */
    async getConfig() {
        const rawConfig = await this.collection.findOne({ _id: this.FIXED_ID });
        if (!rawConfig) {
            return null;
        }
        // 懒迁移：检测并迁移旧版配置
        if (this.needsMigration(rawConfig)) {
            const migratedConfig = this.migrateFromLegacy(rawConfig);
            // 持久化迁移后的配置
            await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: migratedConfig });
            return migratedConfig;
        }
        return rawConfig;
    }
    /**
     * 检测是否需要迁移
     */
    needsMigration(config) {
        // 无 configVersion 或版本低于当前版本需要迁移
        return !config.configVersion || config.configVersion < exports.CURRENT_CONFIG_VERSION;
    }
    /**
     * 从旧版配置迁移到新版
     */
    migrateFromLegacy(legacy) {
        console.log('[AIConfigModel] Migrating from legacy config to v2...');
        // 如果已有 endpoints，规范化并保留现有数据
        if (legacy.endpoints && legacy.endpoints.length > 0) {
            const normalizedEndpoints = legacy.endpoints.map((endpoint, index) => ({
                id: endpoint.id || (0, crypto_1.randomUUID)(),
                name: endpoint.name || `端点 ${index + 1}`,
                apiBaseUrl: endpoint.apiBaseUrl || legacy.apiBaseUrl || '',
                apiKeyEncrypted: endpoint.apiKeyEncrypted || legacy.apiKeyEncrypted || '',
                models: Array.isArray(endpoint.models) ? endpoint.models : [],
                modelsLastFetched: endpoint.modelsLastFetched,
                enabled: endpoint.enabled !== false,
            }));
            const endpointIds = new Set(normalizedEndpoints.map(ep => ep.id));
            let selectedModels = (legacy.selectedModels || []).filter(sm => endpointIds.has(sm.endpointId));
            // 如果没有有效的 selectedModels，尝试从旧配置或端点模型列表推导
            if (selectedModels.length === 0) {
                if (legacy.modelName && normalizedEndpoints[0]) {
                    selectedModels = [{ endpointId: normalizedEndpoints[0].id, modelName: legacy.modelName }];
                }
                else {
                    selectedModels = normalizedEndpoints
                        .filter(ep => ep.models.length > 0)
                        .map(ep => ({ endpointId: ep.id, modelName: ep.models[0] }));
                }
            }
            return {
                ...legacy,
                configVersion: exports.CURRENT_CONFIG_VERSION,
                endpoints: normalizedEndpoints,
                selectedModels,
            };
        }
        // 从旧字段创建默认端点
        const defaultEndpoint = {
            id: (0, crypto_1.randomUUID)(),
            name: '默认端点',
            apiBaseUrl: legacy.apiBaseUrl || '',
            apiKeyEncrypted: legacy.apiKeyEncrypted || '',
            models: legacy.modelName ? [legacy.modelName] : [],
            modelsLastFetched: undefined,
            enabled: true,
        };
        // 创建默认选中模型
        const selectedModels = legacy.modelName
            ? [{ endpointId: defaultEndpoint.id, modelName: legacy.modelName }]
            : [];
        const migratedConfig = {
            _id: legacy._id,
            configVersion: exports.CURRENT_CONFIG_VERSION,
            endpoints: legacy.apiBaseUrl ? [defaultEndpoint] : [],
            selectedModels,
            rateLimitPerMinute: legacy.rateLimitPerMinute,
            timeoutSeconds: legacy.timeoutSeconds,
            systemPromptTemplate: legacy.systemPromptTemplate,
            extraJailbreakPatternsText: legacy.extraJailbreakPatternsText,
            updatedAt: legacy.updatedAt,
            // 保留旧字段便于回滚
            apiBaseUrl: legacy.apiBaseUrl,
            modelName: legacy.modelName,
            apiKeyEncrypted: legacy.apiKeyEncrypted,
        };
        console.log('[AIConfigModel] Migration complete. Created endpoint:', defaultEndpoint.id);
        return migratedConfig;
    }
    /**
     * 更新配置(若不存在则创建)
     * @param partial 要更新的配置字段(部分更新)
     * @returns 更新后的配置对象
     */
    async updateConfig(partial) {
        const now = new Date();
        // 确保 configVersion 为最新
        const updateData = {
            ...partial,
            configVersion: exports.CURRENT_CONFIG_VERSION,
            updatedAt: now
        };
        // 使用 upsert 更新或创建配置
        await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: updateData }, { upsert: true });
        // 查询更新后的配置
        const config = await this.collection.findOne({ _id: this.FIXED_ID });
        if (!config) {
            throw new Error('配置更新失败：无法读取更新后的配置');
        }
        return config;
    }
    /**
     * 添加新端点
     */
    async addEndpoint(endpoint) {
        const config = await this.getConfig();
        const newEndpoint = {
            ...endpoint,
            id: (0, crypto_1.randomUUID)(),
        };
        const endpoints = config?.endpoints || [];
        endpoints.push(newEndpoint);
        await this.updateConfig({ endpoints });
        return newEndpoint;
    }
    /**
     * 更新端点
     */
    async updateEndpoint(endpointId, updates) {
        const config = await this.getConfig();
        if (!config) {
            throw new Error('配置不存在');
        }
        const endpoints = config.endpoints.map(ep => ep.id === endpointId ? { ...ep, ...updates } : ep);
        await this.updateConfig({ endpoints });
    }
    /**
     * 删除端点
     */
    async deleteEndpoint(endpointId) {
        const config = await this.getConfig();
        if (!config) {
            throw new Error('配置不存在');
        }
        const endpoints = config.endpoints.filter(ep => ep.id !== endpointId);
        // 同时移除引用该端点的 selectedModels
        const selectedModels = config.selectedModels.filter(sm => sm.endpointId !== endpointId);
        await this.updateConfig({ endpoints, selectedModels });
    }
    /**
     * 更新选中的模型列表
     */
    async updateSelectedModels(selectedModels) {
        await this.updateConfig({ selectedModels });
    }
    /**
     * 根据端点 ID 获取端点配置
     */
    async getEndpointById(endpointId) {
        const config = await this.getConfig();
        if (!config) {
            return null;
        }
        return config.endpoints.find(ep => ep.id === endpointId) || null;
    }
    /**
     * 删除配置(用于测试或重置)
     */
    async deleteConfig() {
        await this.collection.deleteOne({ _id: this.FIXED_ID });
    }
    /**
     * 初始化默认配置(若不存在)
     * @param defaults 默认配置值
     */
    async initializeDefaultConfig(defaults) {
        const existing = await this.getConfig();
        if (!existing) {
            await this.collection.insertOne({
                _id: this.FIXED_ID,
                configVersion: exports.CURRENT_CONFIG_VERSION,
                endpoints: [],
                selectedModels: [],
                ...defaults,
                updatedAt: new Date()
            });
            console.log('[AIConfigModel] Default config initialized');
        }
        else {
            console.log('[AIConfigModel] Config already exists, skipping initialization');
        }
    }
    /**
     * 获取解析后的模型配置（用于 MultiModelClient）
     * 返回按 fallback 顺序排列的完整模型配置
     */
    async getResolvedModelConfigs() {
        const config = await this.getConfig();
        if (!config) {
            return [];
        }
        const results = [];
        for (const selected of config.selectedModels) {
            const endpoint = config.endpoints.find(ep => ep.id === selected.endpointId);
            if (endpoint && endpoint.enabled !== false) {
                results.push({
                    endpointId: endpoint.id,
                    endpointName: endpoint.name,
                    apiBaseUrl: endpoint.apiBaseUrl,
                    apiKeyEncrypted: endpoint.apiKeyEncrypted,
                    modelName: selected.modelName,
                    timeoutSeconds: config.timeoutSeconds,
                });
            }
        }
        return results;
    }
}
exports.AIConfigModel = AIConfigModel;
//# sourceMappingURL=aiConfig.js.map