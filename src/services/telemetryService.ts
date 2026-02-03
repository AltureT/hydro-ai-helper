/**
 * Telemetry Service - 遥测数据上报服务
 *
 * 负责收集插件使用数据并定期上报到远程服务器
 * 采用零侵入式设计：通过查询现有数据而非修改业务逻辑
 */

import { createHash } from 'crypto';
import axios from 'axios';
import type { PluginInstallModel } from '../models/pluginInstall';
import type { ConversationModel } from '../models/conversation';

/**
 * 遥测数据接口
 */
interface TelemetryData {
  activeUsers7d: number;      // 最近 7 天活跃用户数
  totalConversations: number; // 总对话数
  lastUsedAt: Date | null;    // 最近使用时间
}

/**
 * 上报负载接口
 */
interface ReportPayload {
  instance_id: string;
  event: 'install' | 'heartbeat';
  version: string;
  installed_at: string;
  first_used_at?: string;
  stats: {
    active_users_7d: number;
    total_conversations: number;
    last_used_at?: string;
  };
  domain_hash: string;
  timestamp: string;
}

/**
 * Telemetry Service 类
 */
export class TelemetryService {
  private readonly DEFAULT_ENDPOINTS = ['https://stats.how2learns.com/api/report'];
  private readonly HEARTBEAT_INTERVAL = 24 * 60 * 60 * 1000; // 24 小时
  private readonly REQUEST_TIMEOUT = 8000; // 8 秒
  private timer?: NodeJS.Timeout;

  constructor(
    private pluginInstallModel: PluginInstallModel,
    private conversationModel: ConversationModel
  ) { }

  /**
   * 初始化遥测服务
   * 检查是否需要上报，并启动定时器
   */
  async init(): Promise<void> {
    try {
      const config = await this.pluginInstallModel.getInstall();
      if (!config) {
        console.error('[TelemetryService] Install record not found');
        return;
      }

      // 检查是否启用遥测
      if (!config.telemetryEnabled) {
        console.log('[TelemetryService] Telemetry disabled by user');
        return;
      }

      // 检查是否需要立即上报
      const shouldReport = this.shouldReport(config.lastReportAt);
      if (shouldReport) {
        // 判断是首次安装还是心跳
        const eventType = config.lastReportAt ? 'heartbeat' : 'install';
        await this.report(eventType);
      }

      // 启动定时器
      this.startHeartbeat();
      console.log('[TelemetryService] Initialized successfully');
    } catch (error) {
      console.error('[TelemetryService] Initialization failed:', error);
    }
  }

  /**
   * 判断是否需要上报
   * @param lastReportAt 最后上报时间
   * @returns 是否需要上报
   */
  private shouldReport(lastReportAt?: Date): boolean {
    if (!lastReportAt) {
      return true; // 首次安装，需要上报
    }

    const now = Date.now();
    const lastReport = lastReportAt.getTime();
    const elapsed = now - lastReport;

    return elapsed >= this.HEARTBEAT_INTERVAL;
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    // 清除旧定时器
    if (this.timer) {
      clearInterval(this.timer);
    }

    // 每 24 小时检查一次
    this.timer = setInterval(async () => {
      try {
        const config = await this.pluginInstallModel.getInstall();
        if (!config || !config.telemetryEnabled) {
          return;
        }

        if (this.shouldReport(config.lastReportAt)) {
          await this.report('heartbeat');
        }
      } catch (error) {
        console.error('[TelemetryService] Heartbeat failed:', error);
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * 收集遥测数据（零侵入式：查询现有数据）
   * @returns 遥测数据
   */
  private async collect(): Promise<TelemetryData> {
    // 统计最近 7 天活跃用户数
    const activeUsers7d = await this.conversationModel.countActiveUsers(7);

    // 统计总对话数
    const totalConversations = await this.conversationModel.getTotalConversations();

    // 查询最近对话时间
    const lastUsedAt = await this.conversationModel.getLastConversationTime();

    return {
      activeUsers7d,
      totalConversations,
      lastUsedAt
    };
  }

  /**
   * 上报数据到远程服务器
   * @param eventType 事件类型
   */
  private async report(eventType: 'install' | 'heartbeat'): Promise<void> {
    try {
      const config = await this.pluginInstallModel.getInstall();
      if (!config) {
        console.error('[TelemetryService] Install record not found');
        return;
      }

      // 收集数据
      const stats = await this.collect();

      // 计算 domain hash（隐私保护）
      const domainHash = createHash('sha256')
        .update(config.domainsSeen.sort().join(','))
        .digest('hex')
        .substring(0, 16);

      // 构造上报负载
      const payload: ReportPayload = {
        instance_id: config.instanceId,
        event: eventType,
        version: config.lastVersion,
        installed_at: config.installedAt.toISOString(),
        first_used_at: config.firstUsedAt?.toISOString(),
        stats: {
          active_users_7d: stats.activeUsers7d,
          total_conversations: stats.totalConversations,
          last_used_at: stats.lastUsedAt?.toISOString()
        },
        domain_hash: domainHash,
        timestamp: new Date().toISOString()
      };

      const endpoints = this.getTelemetryEndpoints(config.preferredTelemetryEndpoint);
      const token = (process.env.AI_HELPER_TELEMETRY_TOKEN || '').trim();

      let lastError: unknown;
      for (const endpoint of endpoints) {
        try {
          await axios.post(endpoint, payload, {
            timeout: this.REQUEST_TIMEOUT,
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {})
            }
          });

          await this.pluginInstallModel.updateLastReportTime();
          await this.pluginInstallModel.updatePreferredTelemetryEndpoint(endpoint);
          console.log(`[TelemetryService] Report sent successfully (${eventType}) -> ${endpoint}`);
          return;
        } catch (error) {
          lastError = error;
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          const statusText = axios.isAxiosError(error) ? error.response?.statusText : undefined;
          console.error('[TelemetryService] Report failed', {
            endpoint,
            status,
            statusText,
            message: axios.isAxiosError(error) ? error.message : String(error)
          });
        }
      }

      console.error('[TelemetryService] All telemetry endpoints failed', {
        endpoints,
        error: axios.isAxiosError(lastError) ? lastError.message : String(lastError)
      });
    } catch (error) {
      console.error('[TelemetryService] Report error:', error);
    }
  }

  private getTelemetryEndpoints(preferred?: string): string[] {
    const raw = process.env.AI_HELPER_TELEMETRY_ENDPOINTS;
    const parsed = parseTelemetryEndpoints(raw);
    const endpoints = parsed.length > 0 ? parsed : this.DEFAULT_ENDPOINTS;
    const normalizedPreferred = preferred ? normalizeTelemetryEndpoint(preferred) : undefined;

    if (normalizedPreferred && endpoints.includes(normalizedPreferred)) {
      return [
        normalizedPreferred,
        ...endpoints.filter((endpoint) => endpoint !== normalizedPreferred)
      ];
    }

    return endpoints;
  }

  /**
   * 停止遥测服务
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log('[TelemetryService] Stopped');
    }
  }
}

function parseTelemetryEndpoints(value?: string): string[] {
  if (!value) {
    return [];
  }

  const endpoints = value
    .split(',')
    .map((raw) => normalizeTelemetryEndpoint(raw))
    .filter((item): item is string => Boolean(item));

  return Array.from(new Set(endpoints));
}

function normalizeTelemetryEndpoint(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }

  url.hash = '';
  url.search = '';

  const basePath = url.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/api/report')) {
    url.pathname = basePath;
    return url.toString();
  }

  const nextPath = basePath && basePath !== '/' ? `${basePath}/api/report` : '/api/report';
  url.pathname = nextPath;
  return url.toString();
}
