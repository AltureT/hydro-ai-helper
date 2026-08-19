/**
 * PluginInstall Model - 插件安装与遥测数据模型
 *
 * 用于记录插件安装信息和遥测配置
 */

import type { Db, Collection } from 'mongodb';
import { randomBytes, randomUUID } from 'crypto';

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
  /** 仅保存在本机 MongoDB，用于不可逆匿名化模型身份；绝不上传。 */
  testdataTelemetryHmacKey?: string;
}

/**
 * PluginInstall Model 操作类
 * 封装插件安装记录的 CRUD 操作
 */
export class PluginInstallModel {
  private collection: Collection<PluginInstall>;
  private readonly FIXED_ID = 'install'; // 固定记录 ID

  // 合法 instanceId 的格式（randomUUID v4）。任何不匹配此格式的值都是
  // v2.0.x 残留的「确定性哈希」ID，需要迁移为唯一 UUID。
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly HMAC_KEY_RE = /^[a-f0-9]{64}$/;

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
        instanceId: randomUUID(), // 唯一标识，持久化于 MongoDB（数据卷保留即跨容器重建稳定）
        installedAt: now,
        installedVersion: version,
        lastVersion: version,
        domainsSeen: [],
        telemetryEnabled: true,
        testdataTelemetryHmacKey: randomBytes(32).toString('hex'),
      } as PluginInstall);

      console.log('[PluginInstallModel] Install record created');
      return;
    }

    const updates: Record<string, unknown> = { lastVersion: version };
    // 一次性迁移：v2.0.x 的「确定性哈希」instanceId 因 serverInfo() 无 host 字段，
    // 退化为 sha256('unknown:'+dbName)，导致所有部署共享同一个 ID。
    // 凡是非 UUID 格式的旧值，替换为唯一 UUID 以解除碰撞。
    if (!PluginInstallModel.UUID_RE.test(existing.instanceId || '')) {
      updates.instanceId = randomUUID();
      console.log('[PluginInstallModel] Replaced legacy deterministic instanceId with unique UUID');
    }
    if (!PluginInstallModel.HMAC_KEY_RE.test(existing.testdataTelemetryHmacKey || '')) {
      updates.testdataTelemetryHmacKey = randomBytes(32).toString('hex');
    }
    await this.collection.updateOne(
      { _id: this.FIXED_ID },
      { $set: updates }
    );
    console.log('[PluginInstallModel] Install record updated, version:', version);
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
