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
exports.getTelemetryToken = getTelemetryToken;
exports.sendToEndpoint = sendToEndpoint;
exports.getTelemetryBases = getTelemetryBases;
exports.buildTelemetryUrl = buildTelemetryUrl;
exports.normalizeTelemetryBase = normalizeTelemetryBase;
const crypto_1 = require("crypto");
const axios_1 = __importDefault(require("axios"));
/**
 * Telemetry Service 类
 */
class TelemetryService {
    constructor(pluginInstallModel, conversationModel, aiConfigModel, requestStatsModel, errorReporter) {
        this.pluginInstallModel = pluginInstallModel;
        this.conversationModel = conversationModel;
        this.aiConfigModel = aiConfigModel;
        this.requestStatsModel = requestStatsModel;
        this.errorReporter = errorReporter;
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
        // Parallelize independent queries
        const [activeUsers7d, totalConversations, lastUsedAt, requestStats, aiConfig] = await Promise.all([
            this.conversationModel.countActiveUsers(7),
            this.conversationModel.getTotalConversations(),
            this.conversationModel.getLastConversationTime(),
            this.requestStatsModel?.getStats24h().catch(() => null),
            this.aiConfigModel?.getConfig().catch(() => null),
        ]);
        const selfStats = this.errorReporter?.getSelfStats();
        return {
            activeUsers7d,
            totalConversations,
            lastUsedAt,
            apiSuccessCount24h: requestStats?.successCount ?? 0,
            apiFailureCount24h: requestStats?.failureCount ?? 0,
            avgLatencyMs24h: requestStats?.avgLatencyMs ?? 0,
            errorCount24h: requestStats?.failureCount ?? 0,
            suppressedErrorCount: selfStats?.suppressedCount ?? 0,
            droppedErrorCount: selfStats?.droppedCount ?? 0,
            activeEndpointCount: aiConfig?.endpoints.filter(e => e.enabled).length ?? 0,
        };
    }
    /**
     * 从已加载的 config 中提取功能标志（避免重复 getConfig 调用）
     */
    extractFeatureFlags(config) {
        if (!config)
            return TelemetryService.DEFAULT_FEATURES;
        const bc = config.budgetConfig;
        return {
            budget_limits: !!(bc && (bc.dailyTokenLimitPerUser || bc.dailyTokenLimitPerDomain || bc.monthlyTokenLimitPerDomain)),
            custom_jailbreak_patterns: !!(config.extraJailbreakPatternsText && config.extraJailbreakPatternsText.trim()),
            multi_endpoint: config.endpoints.filter(e => e.enabled).length > 1,
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
            const stats = await this.collect();
            const domainHash = (0, crypto_1.createHash)('sha256')
                .update(config.domainsSeen.sort().join(','))
                .digest('hex')
                .substring(0, 16);
            let aiConfig = null;
            try {
                aiConfig = await this.aiConfigModel?.getConfig() ?? null;
            }
            catch { /* */ }
            const features = this.extractFeatureFlags(aiConfig);
            const payload = {
                instance_id: config.instanceId,
                event: eventType,
                version: config.lastVersion,
                installed_at: config.installedAt.toISOString(),
                first_used_at: config.firstUsedAt?.toISOString(),
                stats: {
                    active_users_7d: stats.activeUsers7d,
                    total_conversations: stats.totalConversations,
                    last_used_at: stats.lastUsedAt?.toISOString(),
                    api_success_count_24h: stats.apiSuccessCount24h,
                    api_failure_count_24h: stats.apiFailureCount24h,
                    avg_latency_ms_24h: stats.avgLatencyMs24h,
                    error_count_24h: stats.errorCount24h,
                    suppressed_error_count: stats.suppressedErrorCount,
                    dropped_error_count: stats.droppedErrorCount,
                    active_endpoint_count: stats.activeEndpointCount,
                },
                environment: {
                    node_version: process.version,
                    os_platform: process.platform,
                    os_arch: process.arch,
                },
                features,
                domain_hash: domainHash,
                timestamp: new Date().toISOString()
            };
            const bases = getTelemetryBases(config.preferredTelemetryEndpoint);
            const urls = bases.map(b => buildTelemetryUrl(b, '/api/report'));
            await this.sendToFirstAvailable(urls, payload);
            await this.pluginInstallModel.updateLastReportTime();
            if (bases.length > 0) {
                await this.pluginInstallModel.updatePreferredTelemetryEndpoint(bases[0]);
            }
            console.log(`[TelemetryService] Report sent successfully (${eventType})`);
        }
        catch (error) {
            console.error('[TelemetryService] Report error:', error);
        }
    }
    /**
     * 上报反馈到远程服务器（不受 telemetryEnabled 控制）
     */
    async reportFeedback(feedback) {
        try {
            const config = await this.pluginInstallModel.getInstall();
            if (!config) {
                return false;
            }
            const domainHash = (0, crypto_1.createHash)('sha256')
                .update(config.domainsSeen.sort().join(','))
                .digest('hex')
                .substring(0, 16);
            const payload = {
                instance_id: config.instanceId,
                event: 'feedback',
                version: config.lastVersion,
                domain_hash: domainHash,
                timestamp: new Date().toISOString(),
                feedback: {
                    ...feedback,
                    environment: {
                        node_version: process.version,
                        os_platform: process.platform,
                        os_arch: process.arch,
                    },
                },
            };
            const bases = getTelemetryBases();
            const urls = bases.map(b => buildTelemetryUrl(b, '/api/feedback'));
            await this.sendToFirstAvailable(urls, payload);
            return true;
        }
        catch (error) {
            console.error('[TelemetryService] Feedback report error:', error);
            return false;
        }
    }
    /**
     * 尝试向第一个可用的端点发送数据
     */
    async sendToFirstAvailable(urls, payload) {
        const token = getTelemetryToken();
        let lastError;
        for (const url of urls) {
            try {
                await sendToEndpoint(url, payload, token, this.REQUEST_TIMEOUT);
                return;
            }
            catch (error) {
                lastError = error;
                const status = axios_1.default.isAxiosError(error) ? error.response?.status : undefined;
                console.error('[TelemetryService] Send failed', {
                    url,
                    status,
                    message: axios_1.default.isAxiosError(error) ? error.message : String(error)
                });
            }
        }
        throw lastError || new Error('All telemetry endpoints failed');
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
TelemetryService.DEFAULT_FEATURES = {
    budget_limits: false, custom_jailbreak_patterns: false, multi_endpoint: false,
};
// ─── 导出的共享工具函数 ─────────────────────────────
const DEFAULT_BASE = 'https://stats.how2learns.com';
/**
 * 内置遥测 token，用于官方 stats.how2learns.com 端点认证。
 * 不是真正的秘密（随插件代码分发），但可阻止未安装插件的第三方随意写入遥测数据。
 * 用户可通过环境变量 AI_HELPER_TELEMETRY_TOKEN 覆盖（自建遥测服务场景）。
 */
const DEFAULT_TELEMETRY_TOKEN = '3h5m7qnvzGBJxXQe-Gj7hOf3aDbo2rM8';
/**
 * 获取遥测 token
 */
function getTelemetryToken() {
    const envToken = (process.env.AI_HELPER_TELEMETRY_TOKEN || '').trim();
    return envToken || DEFAULT_TELEMETRY_TOKEN;
}
/**
 * 发送数据到指定端点
 */
async function sendToEndpoint(url, payload, token, timeout = 8000) {
    await axios_1.default.post(url, payload, {
        timeout,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
}
/**
 * 获取遥测基础 URL 列表（优先使用 preferred）
 */
function getTelemetryBases(preferred) {
    const raw = process.env.AI_HELPER_TELEMETRY_ENDPOINTS;
    const parsed = parseTelemetryBases(raw);
    const bases = parsed.length > 0 ? parsed : [DEFAULT_BASE];
    const normalizedPreferred = preferred ? normalizeTelemetryBase(preferred) : undefined;
    if (normalizedPreferred && bases.includes(normalizedPreferred)) {
        return [
            normalizedPreferred,
            ...bases.filter((b) => b !== normalizedPreferred),
        ];
    }
    return bases;
}
/**
 * 构建遥测端点完整 URL
 * @param base 基础 URL (如 https://stats.how2learns.com)
 * @param apiPath API 路径 (如 /api/report, /api/errors, /api/feedback)
 */
function buildTelemetryUrl(base, apiPath) {
    const trimmedBase = base.replace(/\/+$/, '');
    const trimmedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    return `${trimmedBase}${trimmedPath}`;
}
function parseTelemetryBases(value) {
    if (!value) {
        return [];
    }
    const bases = value
        .split(',')
        .map((raw) => normalizeTelemetryBase(raw))
        .filter((item) => Boolean(item));
    return Array.from(new Set(bases));
}
/**
 * 归一化遥测基础 URL（不追加路径）
 */
function normalizeTelemetryBase(value) {
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
    // 去除尾部 /api/report 或其他 api 路径，只保留 base
    let basePath = url.pathname.replace(/\/+$/, '');
    if (basePath.endsWith('/api/report')) {
        basePath = basePath.slice(0, -'/api/report'.length);
    }
    else if (basePath.endsWith('/api/errors')) {
        basePath = basePath.slice(0, -'/api/errors'.length);
    }
    else if (basePath.endsWith('/api/feedback')) {
        basePath = basePath.slice(0, -'/api/feedback'.length);
    }
    url.pathname = basePath || '/';
    return url.toString().replace(/\/+$/, '');
}
//# sourceMappingURL=telemetryService.js.map