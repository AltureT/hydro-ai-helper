"use strict";
/**
 * AI Config Model - AI 服务配置数据模型
 *
 * 管理全局 AI 服务配置(API Key、模型名称等)
 * 约定：数据库中最多只有一条配置记录(固定 ID = 'default')
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIConfigModel = void 0;
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
     * 获取当前配置
     * @returns 配置对象或 null(若尚未配置)
     */
    async getConfig() {
        return this.collection.findOne({ _id: this.FIXED_ID });
    }
    /**
     * 更新配置(若不存在则创建)
     * @param partial 要更新的配置字段(部分更新)
     * @returns 更新后的配置对象
     */
    async updateConfig(partial) {
        const now = new Date();
        // 使用 upsert 更新或创建配置
        await this.collection.updateOne({ _id: this.FIXED_ID }, {
            $set: {
                ...partial,
                updatedAt: now
            }
        }, { upsert: true });
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
                ...defaults,
                updatedAt: new Date()
            });
            console.log('[AIConfigModel] Default config initialized');
        }
        else {
            console.log('[AIConfigModel] Config already exists, skipping initialization');
        }
    }
}
exports.AIConfigModel = AIConfigModel;
//# sourceMappingURL=aiConfig.js.map