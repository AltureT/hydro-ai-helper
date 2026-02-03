"use strict";
/**
 * Telemetry Service - 遥测数据上报服务
 *
 * 负责收集插件使用数据并定期上报到远程服务器
 * 采用零侵入式设计：通过查询现有数据而非修改业务逻辑
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryService = void 0;
const crypto_1 = require("crypto");
const axios_1 = __importDefault(require("axios"));
/**
 * Telemetry Service 类
 */
class TelemetryService {
    constructor(pluginInstallModel, conversationModel) {
        this.pluginInstallModel = pluginInstallModel;
        this.conversationModel = conversationModel;
        this.DEFAULT_ENDPOINTS = ['https://stats.how2learns.com/api/report'];
        this.HEARTBEAT_INTERVAL = 24 * 60 * 60 * 1000; // 24 小时
        this.REQUEST_TIMEOUT = 8000; // 8 秒
    }
    /**
     * 初始化遥测服务
     * 检查是否需要上报，并启动定时器
     */
    async init() {
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
        }
        catch (error) {
            console.error('[TelemetryService] Initialization failed:', error);
        }
    }
    /**
     * 判断是否需要上报
     * @param lastReportAt 最后上报时间
     * @returns 是否需要上报
     */
    shouldReport(lastReportAt) {
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
    startHeartbeat() {
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
            }
            catch (error) {
                console.error('[TelemetryService] Heartbeat failed:', error);
            }
        }, this.HEARTBEAT_INTERVAL);
    }
    /**
     * 收集遥测数据（零侵入式：查询现有数据）
     * @returns 遥测数据
     */
    async collect() {
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
    async report(eventType) {
        try {
            const config = await this.pluginInstallModel.getInstall();
            if (!config) {
                console.error('[TelemetryService] Install record not found');
                return;
            }
            // 收集数据
            const stats = await this.collect();
            // 计算 domain hash（隐私保护）
            const domainHash = (0, crypto_1.createHash)('sha256')
                .update(config.domainsSeen.sort().join(','))
                .digest('hex')
                .substring(0, 16);
            // 构造上报负载
            const payload = {
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
            let lastError;
            for (const endpoint of endpoints) {
                try {
                    await axios_1.default.post(endpoint, payload, {
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
                }
                catch (error) {
                    lastError = error;
                    const status = axios_1.default.isAxiosError(error) ? error.response?.status : undefined;
                    const statusText = axios_1.default.isAxiosError(error) ? error.response?.statusText : undefined;
                    console.error('[TelemetryService] Report failed', {
                        endpoint,
                        status,
                        statusText,
                        message: axios_1.default.isAxiosError(error) ? error.message : String(error)
                    });
                }
            }
            console.error('[TelemetryService] All telemetry endpoints failed', {
                endpoints,
                error: axios_1.default.isAxiosError(lastError) ? lastError.message : String(lastError)
            });
        }
        catch (error) {
            console.error('[TelemetryService] Report error:', error);
        }
    }
    getTelemetryEndpoints(preferred) {
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
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            console.log('[TelemetryService] Stopped');
        }
    }
}
exports.TelemetryService = TelemetryService;
function parseTelemetryEndpoints(value) {
    if (!value) {
        return [];
    }
    const endpoints = value
        .split(',')
        .map((raw) => normalizeTelemetryEndpoint(raw))
        .filter((item) => Boolean(item));
    return Array.from(new Set(endpoints));
}
function normalizeTelemetryEndpoint(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url;
    try {
        url = new URL(withScheme);
    }
    catch {
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
//# sourceMappingURL=telemetryService.js.map