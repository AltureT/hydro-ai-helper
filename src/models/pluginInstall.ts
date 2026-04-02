/**
 * PluginInstall Model - 插件安装与遥测数据模型
 *
 * 用于记录插件安装信息和遥测配置
 */

import type { Db, Collection } from 'mongodb';
import { createHash } from 'crypto';

/**
 * 插件安装记录接口
 */
export interface PluginInstall {
  _id: string;              // 固定为 'install'
  instanceId: string;       // 随机 UUID，用于去重
  installedAt: Date;        // 首次启动时间
  firstUsedAt?: Date;       // 首次 AI 对话时间
  lastUsedAt?: Date;        // 最近使用时间
  installedVersion: string; // 安装时的版本号
  lastVersion: string;      // 当前运行版本
  domainsSeen: string[];    // 见过的 domainId 列表
  telemetryEnabled: boolean;// 是否允许远程上报（默认 true）
  lastReportAt?: Date;      // 最后一次上报时间
  preferredTelemetryEndpoint?: string; // 最近成功上报的端点（用于自动选择可用端点）
}

/**
 * PluginInstall Model 操作类
 * 封装插件安装记录的 CRUD 操作
 */
export class PluginInstallModel {
  private collection: Collection<PluginInstall>;
  private readonly FIXED_ID = 'install'; // 固定记录 ID
  private db: Db;

  constructor(db: Db) {
    this.collection = db.collection<PluginInstall>('ai_plugin_install');
    this.db = db;
  }

  /**
   * 基于 MongoDB 连接信息生成确定性 instanceId
   * 同一 MongoDB + 同一数据库 = 同一 instanceId（不含 hostname 以兼容 Docker 重建）
   */
  private async generateStableInstanceId(): Promise<string> {
    try {
      const admin = this.db.admin();
      const serverStatus = await admin.serverInfo();
      const mongoHost = serverStatus.host || 'unknown';
      const dbName = this.db.databaseName;
      return createHash('sha256')
        .update(`${mongoHost}:${dbName}`)
        .digest('hex');
    } catch {
      const dbName = this.db.databaseName;
      return createHash('sha256')
        .update(`fallback:${dbName}`)
        .digest('hex');
    }
  }

  /**
   * 确保索引已创建
   * (单条记录无需复杂索引，仅用于一致性)
   */
  async ensureIndexes(): Promise<void> {
    console.log('[PluginInstallModel] Collection initialized');
  }

  /**
   * 获取安装记录
   * @returns 安装记录或 null
   */
  async getInstall(): Promise<PluginInstall | null> {
    return this.collection.findOne({ _id: this.FIXED_ID });
  }

  /**
   * 创建安装记录（如果不存在）
   * @param version 当前版本号
   */
  async createIfMissing(version: string): Promise<void> {
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
      } as PluginInstall);

      console.log('[PluginInstallModel] Install record created with stable instanceId');
    } else {
      const updates: Record<string, any> = { lastVersion: version };
      // Migrate from random UUID to stable ID
      if (existing.instanceId !== stableId) {
        updates.instanceId = stableId;
        console.log('[PluginInstallModel] Migrated instanceId to stable hash');
      }
      await this.collection.updateOne(
        { _id: this.FIXED_ID },
        { $set: updates }
      );
      console.log('[PluginInstallModel] Install record updated, version:', version);
    }
  }

  /**
   * 标记首次使用时间
   */
  async markFirstUse(): Promise<void> {
    const existing = await this.getInstall();
    if (existing && !existing.firstUsedAt) {
      await this.collection.updateOne(
        { _id: this.FIXED_ID },
        { $set: { firstUsedAt: new Date() } }
      );
    }
  }

  /**
   * 更新最近使用时间
   */
  async markLastUse(): Promise<void> {
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      { $set: { lastUsedAt: new Date() } }
    );
  }

  /**
   * 添加 domainId（如果不存在）
   * @param domainId 域 ID
   */
  async addDomain(domainId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      { $addToSet: { domainsSeen: domainId } }
    );
  }

  /**
   * 更新最后上报时间
   */
  async updateLastReportTime(): Promise<void> {
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      { $set: { lastReportAt: new Date() } }
    );
  }

  /**
   * 更新遥测开关
   * @param enabled 是否启用
   */
  async updateTelemetryEnabled(enabled: boolean): Promise<void> {
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      { $set: { telemetryEnabled: enabled } }
    );
  }

  /**
   * 更新最近成功上报的遥测端点
   * @param endpoint 端点 URL
   */
  async updatePreferredTelemetryEndpoint(endpoint: string): Promise<void> {
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      { $set: { preferredTelemetryEndpoint: endpoint } }
    );
  }
}
