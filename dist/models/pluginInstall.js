"use strict";
/**
 * PluginInstall Model - 插件安装与遥测数据模型
 *
 * 用于记录插件安装信息和遥测配置
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginInstallModel = void 0;
const crypto_1 = require("crypto");
const os_1 = require("os");
/**
 * PluginInstall Model 操作类
 * 封装插件安装记录的 CRUD 操作
 */
class PluginInstallModel {
    constructor(db) {
        this.FIXED_ID = 'install'; // 固定记录 ID
        this.collection = db.collection('ai_plugin_install');
        this.db = db;
    }
    /**
     * 基于 MongoDB 连接信息生成确定性 instanceId
     * 同一 MongoDB + 同一数据库 + 同一主机 = 同一 instanceId
     */
    async generateStableInstanceId() {
        try {
            const admin = this.db.admin();
            const serverStatus = await admin.serverInfo();
            const mongoHost = serverStatus.host || 'unknown';
            const dbName = this.db.databaseName;
            const host = (0, os_1.hostname)();
            return (0, crypto_1.createHash)('sha256')
                .update(`${mongoHost}:${dbName}:${host}`)
                .digest('hex');
        }
        catch {
            // fallback: use db name + hostname
            const dbName = this.db.databaseName;
            const host = (0, os_1.hostname)();
            return (0, crypto_1.createHash)('sha256')
                .update(`${dbName}:${host}`)
                .digest('hex');
        }
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
        const stableId = await this.generateStableInstanceId();
        if (!existing) {
            const now = new Date();
            await this.collection.insertOne({
                _id: this.FIXED_ID,
                instanceId: stableId,
                installedAt: now,
                installedVersion: version,
                lastVersion: version,
                domainsSeen: [],
                telemetryEnabled: true
            });
            console.log('[PluginInstallModel] Install record created with stable instanceId');
        }
        else {
            const updates = { lastVersion: version };
            // Migrate from random UUID to stable ID
            if (existing.instanceId !== stableId) {
                updates.instanceId = stableId;
                console.log('[PluginInstallModel] Migrated instanceId to stable hash');
            }
            await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: updates });
            console.log('[PluginInstallModel] Install record updated, version:', version);
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
    /**
     * 更新最近成功上报的遥测端点
     * @param endpoint 端点 URL
     */
    async updatePreferredTelemetryEndpoint(endpoint) {
        await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: { preferredTelemetryEndpoint: endpoint } });
    }
}
exports.PluginInstallModel = PluginInstallModel;
//# sourceMappingURL=pluginInstall.js.map