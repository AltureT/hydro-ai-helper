/**
 * PluginInstall Model - 插件安装与遥测数据模型
 *
 * 用于记录插件安装信息和遥测配置
 */

import type { Db, Collection } from 'mongodb';
import { randomUUID } from 'crypto';

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
}

/**
 * PluginInstall Model 操作类
 * 封装插件安装记录的 CRUD 操作
 */
export class PluginInstallModel {
  private collection: Collection<PluginInstall>;
  private readonly FIXED_ID = 'install'; // 固定记录 ID

  constructor(db: Db) {
    this.collection = db.collection<PluginInstall>('ai_plugin_install');
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

    if (!existing) {
      const now = new Date();
      await this.collection.insertOne({
        _id: this.FIXED_ID,
        instanceId: randomUUID(),
        installedAt: now,
        installedVersion: version,
        lastVersion: version,
        domainsSeen: [],
        telemetryEnabled: true
      } as PluginInstall);

      console.log('[PluginInstallModel] Install record created');
    } else {
      // 更新版本号
      await this.collection.updateOne(
        { _id: this.FIXED_ID },
        { $set: { lastVersion: version } }
      );
      console.log('[PluginInstallModel] Install record already exists, version updated');
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
}
