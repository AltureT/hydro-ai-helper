/**
 * AI Config Model - AI 服务配置数据模型
 *
 * 管理全局 AI 服务配置(API Key、模型名称等)
 * 约定：数据库中最多只有一条配置记录(固定 ID = 'default')
 */

import type { Db, Collection } from 'mongodb';

/**
 * AI 配置接口
 */
export interface AIConfig {
  _id: string;                  // 固定为 'default'
  apiBaseUrl: string;           // API Base URL, 例如: https://api.openai.com/v1
  modelName: string;            // 模型名称, 例如: gpt-4o-mini
  apiKeyEncrypted: string;      // 加密后的 API Key
  rateLimitPerMinute: number;   // 频率限制(每分钟最大请求数)
  timeoutSeconds: number;       // 超时时间(秒)
  systemPromptTemplate?: string; // 系统提示词模板(可选)
  extraJailbreakPatternsText?: string; // 自定义越狱规则(多行文本)
  updatedAt: Date;              // 最后更新时间
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
   * 获取当前配置
   * @returns 配置对象或 null(若尚未配置)
   */
  async getConfig(): Promise<AIConfig | null> {
    return this.collection.findOne({ _id: this.FIXED_ID });
  }

  /**
   * 更新配置(若不存在则创建)
   * @param partial 要更新的配置字段(部分更新)
   * @returns 更新后的配置对象
   */
  async updateConfig(partial: Partial<Omit<AIConfig, '_id' | 'updatedAt'>>): Promise<AIConfig> {
    const now = new Date();

    // 使用 upsert 更新或创建配置
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      {
        $set: {
          ...partial,
          updatedAt: now
        }
      },
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
   * 删除配置(用于测试或重置)
   */
  async deleteConfig(): Promise<void> {
    await this.collection.deleteOne({ _id: this.FIXED_ID });
  }

  /**
   * 初始化默认配置(若不存在)
   * @param defaults 默认配置值
   */
  async initializeDefaultConfig(defaults: Omit<AIConfig, '_id' | 'updatedAt'>): Promise<void> {
    const existing = await this.getConfig();

    if (!existing) {
      await this.collection.insertOne({
        _id: this.FIXED_ID,
        ...defaults,
        updatedAt: new Date()
      } as AIConfig);

      console.log('[AIConfigModel] Default config initialized');
    } else {
      console.log('[AIConfigModel] Config already exists, skipping initialization');
    }
  }
}
