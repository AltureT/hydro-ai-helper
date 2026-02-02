"use strict";
/**
 * PluginInstall Model - 插件安装与遥测数据模型
 *
 * 用于记录插件安装信息和遥测配置
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginInstallModel = void 0;
const crypto_1 = require("crypto");
/**
 * PluginInstall Model 操作类
 * 封装插件安装记录的 CRUD 操作
 */
class PluginInstallModel {
    constructor(db) {
        this.FIXED_ID = 'install'; // 固定记录 ID
        this.collection = db.collection('ai_plugin_install');
    }
    /**
     * 确保索引已创建
     * (单条记录无需复杂索引，仅用于一致性)
     */
    async ensureIndexes() {
        console.log('[PluginInstallModel] Collection initialized');
    }
    /**
     * 获取安装记录
     * @returns 安装记录或 null
     */
    async getInstall() {
        return this.collection.findOne({ _id: this.FIXED_ID });
    }
    /**
     * 创建安装记录（如果不存在）
     * @param version 当前版本号
     */
    async createIfMissing(version) {
        const existing = await this.getInstall();
        if (!existing) {
            const now = new Date();
            await this.collection.insertOne({
                _id: this.FIXED_ID,
                instanceId: (0, crypto_1.randomUUID)(),
                installedAt: now,
                installedVersion: version,
                lastVersion: version,
                domainsSeen: [],
                telemetryEnabled: true
            });
            console.log('[PluginInstallModel] Install record created');
        }
        else {
            // 更新版本号
            await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: { lastVersion: version } });
            console.log('[PluginInstallModel] Install record already exists, version updated');
        }
    }
    /**
     * 标记首次使用时间
     */
    async markFirstUse() {
        const existing = await this.getInstall();
        if (existing && !existing.firstUsedAt) {
            await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: { firstUsedAt: new Date() } });
        }
    }
    /**
     * 更新最近使用时间
     */
    async markLastUse() {
        await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: { lastUsedAt: new Date() } });
    }
    /**
     * 添加 domainId（如果不存在）
     * @param domainId 域 ID
     */
    async addDomain(domainId) {
        await this.collection.updateOne({ _id: this.FIXED_ID }, { $addToSet: { domainsSeen: domainId } });
    }
    /**
     * 更新最后上报时间
     */
    async updateLastReportTime() {
        await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: { lastReportAt: new Date() } });
    }
    /**
     * 更新遥测开关
     * @param enabled 是否启用
     */
    async updateTelemetryEnabled(enabled) {
        await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: { telemetryEnabled: enabled } });
    }
}
exports.PluginInstallModel = PluginInstallModel;
//# sourceMappingURL=pluginInstall.js.map