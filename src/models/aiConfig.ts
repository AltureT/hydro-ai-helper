/**
 * AI Config Model - AI 服务配置数据模型
 *
 * 管理全局 AI 服务配置(API Key、模型名称等)
 * 约定：数据库中最多只有一条配置记录(固定 ID = 'default')
 *
 * v2 新增：支持多 API 端点配置、模型自动获取、Fallback 机制
 */

import type { Db, Collection } from 'mongodb';
import { randomUUID } from 'crypto';

/** 当前配置版本号 */
export const CURRENT_CONFIG_VERSION = 2;

/**
 * API 端点配置
 */
export interface APIEndpoint {
  id: string;                   // 唯一标识 (UUID)
  name: string;                 // 显示名称
  apiBaseUrl: string;           // API Base URL
  apiKeyEncrypted: string;      // 加密后的 API Key
  models: string[];             // 可用模型列表
  modelsLastFetched?: Date;     // 模型列表最后获取时间
  enabled: boolean;             // 是否启用
}

/**
 * 选中的模型（按 fallback 顺序排列）
 */
export interface SelectedModel {
  endpointId: string;           // 端点 ID
  modelName: string;            // 模型名称
}

/**
 * AI 配置接口 (v2)
 */
export interface AIConfig {
  _id: string;                  // 固定为 'default'
  configVersion: number;        // 配置版本号，用于迁移检测
  endpoints: APIEndpoint[];     // API 端点列表
  selectedModels: SelectedModel[]; // 选中的模型（��� fallback 顺序）
  rateLimitPerMinute: number;   // 频率限制(每分钟最大请求数)
  timeoutSeconds: number;       // 超时时间(秒)
  systemPromptTemplate?: string; // 系统提示词模板(可选)
  extraJailbreakPatternsText?: string; // 自定义越狱规则(多行文本)
  updatedAt: Date;              // 最后更新时间
  // 保留旧字段用于向后兼容（迁移完成后可能为空）
  apiBaseUrl?: string;
  modelName?: string;
  apiKeyEncrypted?: string;
}

/**
 * 旧版配置接口（用于迁移检测）
 */
interface LegacyAIConfig {
  _id: string;
  apiBaseUrl: string;
  modelName: string;
  apiKeyEncrypted: string;
  rateLimitPerMinute: number;
  timeoutSeconds: number;
  systemPromptTemplate?: string;
  extraJailbreakPatternsText?: string;
  updatedAt: Date;
  configVersion?: number;
  endpoints?: APIEndpoint[];
  selectedModels?: SelectedModel[];
}

/**
 * AI Config Model 操作类
 * 封装 AI 配置的 CRUD 操作
 */
export class AIConfigModel {
  private collection: Collection<AIConfig>;
  private readonly FIXED_ID = 'default'; // 固定配置记录 ID

  constructor(db: Db) {
    this.collection = db.collection<AIConfig>('ai_config');
  }

  /**
   * 确保索引已创建
   * (单条记录无需复杂索引，仅用于一致性)
   */
  async ensureIndexes(): Promise<void> {
    // 创建 _id 索引(MongoDB 自动创建，此处仅占位)
    console.log('[AIConfigModel] Collection initialized');
  }

  /**
   * 获取当前配置（自动执行懒迁移）
   * @returns 配置对象或 null(若尚未配置)
   */
  async getConfig(): Promise<AIConfig | null> {
    const rawConfig = await this.collection.findOne({ _id: this.FIXED_ID });

    if (!rawConfig) {
      return null;
    }

    // 懒迁移：检测并迁移旧版配置
    if (this.needsMigration(rawConfig as unknown as LegacyAIConfig)) {
      const migratedConfig = this.migrateFromLegacy(rawConfig as unknown as LegacyAIConfig);
      // 持久化迁移后的配置
      await this.collection.updateOne(
        { _id: this.FIXED_ID },
        { $set: migratedConfig }
      );
      return migratedConfig;
    }

    return rawConfig;
  }

  /**
   * 检测是否需要迁移
   */
  private needsMigration(config: LegacyAIConfig): boolean {
    // 无 configVersion 或版本低于当前版本需要迁移
    return !config.configVersion || config.configVersion < CURRENT_CONFIG_VERSION;
  }

  /**
   * 从旧版配置迁移到新版
   */
  private migrateFromLegacy(legacy: LegacyAIConfig): AIConfig {
    console.log('[AIConfigModel] Migrating from legacy config to v2...');

    // 如果已有 endpoints，规范化并保留现有数据
    if (legacy.endpoints && legacy.endpoints.length > 0) {
      const normalizedEndpoints = legacy.endpoints.map((endpoint, index) => ({
        id: endpoint.id || randomUUID(),
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
        } else {
          selectedModels = normalizedEndpoints
            .filter(ep => ep.models.length > 0)
            .map(ep => ({ endpointId: ep.id, modelName: ep.models[0] }));
        }
      }

      return {
        ...legacy,
        configVersion: CURRENT_CONFIG_VERSION,
        endpoints: normalizedEndpoints,
        selectedModels,
      } as AIConfig;
    }

    // 从旧字段创建默认端点
    const defaultEndpoint: APIEndpoint = {
      id: randomUUID(),
      name: '默认端点',
      apiBaseUrl: legacy.apiBaseUrl || '',
      apiKeyEncrypted: legacy.apiKeyEncrypted || '',
      models: legacy.modelName ? [legacy.modelName] : [],
      modelsLastFetched: undefined,
      enabled: true,
    };

    // 创建默认选中模型
    const selectedModels: SelectedModel[] = legacy.modelName
      ? [{ endpointId: defaultEndpoint.id, modelName: legacy.modelName }]
      : [];

    const migratedConfig: AIConfig = {
      _id: legacy._id,
      configVersion: CURRENT_CONFIG_VERSION,
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
  async updateConfig(partial: Partial<Omit<AIConfig, '_id' | 'updatedAt'>>): Promise<AIConfig> {
    const now = new Date();

    // 确保 configVersion 为最新
    const updateData = {
      ...partial,
      configVersion: CURRENT_CONFIG_VERSION,
      updatedAt: now
    };

    // 使用 upsert 更新或创建配置
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      { $set: updateData },
      { upsert: true }
    );

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
  async addEndpoint(endpoint: Omit<APIEndpoint, 'id'>): Promise<APIEndpoint> {
    const config = await this.getConfig();
    const newEndpoint: APIEndpoint = {
      ...endpoint,
      id: randomUUID(),
    };

    const endpoints = config?.endpoints || [];
    endpoints.push(newEndpoint);

    await this.updateConfig({ endpoints });
    return newEndpoint;
  }

  /**
   * 更新端点
   */
  async updateEndpoint(endpointId: string, updates: Partial<Omit<APIEndpoint, 'id'>>): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      throw new Error('配置不存在');
    }

    const endpoints = config.endpoints.map(ep =>
      ep.id === endpointId ? { ...ep, ...updates } : ep
    );

    await this.updateConfig({ endpoints });
  }

  /**
   * 删除端点
   */
  async deleteEndpoint(endpointId: string): Promise<void> {
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
  async updateSelectedModels(selectedModels: SelectedModel[]): Promise<void> {
    await this.updateConfig({ selectedModels });
  }

  /**
   * 根据端点 ID 获取端点配置
   */
  async getEndpointById(endpointId: string): Promise<APIEndpoint | null> {
    const config = await this.getConfig();
    if (!config) {
      return null;
    }
    return config.endpoints.find(ep => ep.id === endpointId) || null;
  }

  /**
   * 删除配置(用于测试或重置)
   */
  async deleteConfig(): Promise<void> {
    await this.collection.deleteOne({ _id: this.FIXED_ID });
  }

  /**
   * 初始化默认配置(若不存在)
   * @param defaults 默认配置值
   */
  async initializeDefaultConfig(defaults: Omit<AIConfig, '_id' | 'updatedAt' | 'configVersion' | 'endpoints' | 'selectedModels'>): Promise<void> {
    const existing = await this.getConfig();

    if (!existing) {
      await this.collection.insertOne({
        _id: this.FIXED_ID,
        configVersion: CURRENT_CONFIG_VERSION,
        endpoints: [],
        selectedModels: [],
        ...defaults,
        updatedAt: new Date()
      } as AIConfig);

      console.log('[AIConfigModel] Default config initialized');
    } else {
      console.log('[AIConfigModel] Config already exists, skipping initialization');
    }
  }

  /**
   * 获取解析后的模型配置（用于 MultiModelClient）
   * 返回按 fallback 顺序排列的完整模型配置
   */
  async getResolvedModelConfigs(): Promise<Array<{
    endpointId: string;
    endpointName: string;
    apiBaseUrl: string;
    apiKeyEncrypted: string;
    modelName: string;
    timeoutSeconds: number;
  }>> {
    const config = await this.getConfig();
    if (!config) {
      return [];
    }

    const results: Array<{
      endpointId: string;
      endpointName: string;
      apiBaseUrl: string;
      apiKeyEncrypted: string;
      modelName: string;
      timeoutSeconds: number;
    }> = [];

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
