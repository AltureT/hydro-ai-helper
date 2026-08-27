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
                instanceId: (0, crypto_1.randomUUID)(), // 唯一标识，持久化于 MongoDB（数据卷保留即跨容器重建稳定）
                installedAt: now,
                installedVersion: version,
                lastVersion: version,
                domainsSeen: [],
                telemetryEnabled: true,
                testdataTelemetryHmacKey: (0, crypto_1.randomBytes)(32).toString('hex'),
            });
            console.log('[PluginInstallModel] Install record created');
            return;
        }
        const updates = { lastVersion: version };
        // 一次性迁移：v2.0.x 的「确定性哈希」instanceId 因 serverInfo() 无 host 字段，
        // 退化为 sha256('unknown:'+dbName)，导致所有部署共享同一个 ID。
        // 凡是非 UUID 格式的旧值，替换为唯一 UUID 以解除碰撞。
        if (!PluginInstallModel.UUID_RE.test(existing.instanceId || '')) {
            updates.instanceId = (0, crypto_1.randomUUID)();
            console.log('[PluginInstallModel] Replaced legacy deterministic instanceId with unique UUID');
        }
        if (!PluginInstallModel.HMAC_KEY_RE.test(existing.testdataTelemetryHmacKey || '')) {
            updates.testdataTelemetryHmacKey = (0, crypto_1.randomBytes)(32).toString('hex');
        }
        await this.collection.updateOne({ _id: this.FIXED_ID }, { $set: updates });
        console.log('[PluginInstallModel] Install record updated, version:', version);
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
// 合法 instanceId 的格式（randomUUID v4）。任何不匹配此格式的值都是
// v2.0.x 残留的「确定性哈希」ID，需要迁移为唯一 UUID。
PluginInstallModel.UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
PluginInstallModel.HMAC_KEY_RE = /^[a-f0-9]{64}$/;
//# sourceMappingURL=pluginInstall.js.map