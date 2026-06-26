"use strict";
/**
 * Version Service - 版本检测服务
 *
 * 提供插件版本检测功能：
 * - 获取当前安装版本
 * - 同时从 Gitee 和 GitHub 仓库检查最新版本
 * - 取两个仓库中更新的版本为准
 * - 语义化版本比较
 * - 24 小时缓存机制
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionService = void 0;
const axios_1 = __importDefault(require("axios"));
const versionCache_1 = require("../models/versionCache");
const updateChannel_1 = require("../constants/updateChannel");
const semver_1 = require("../utils/semver");
/**
 * 仓库配置（按优先级排序）
 *
 * - packageJsonUrl：main 分支的 package.json（edge 通道据此读取最新代码版本）
 * - tagsApiUrl：标签列表 API（stable 通道据此选出最新发布版本 vX.Y.Z）
 */
const REPO_CONFIGS = [
    {
        name: 'Gitee',
        owner: 'alture',
        repo: 'hydro-ai-helper',
        branch: 'main',
        packageJsonUrl: 'https://gitee.com/alture/hydro-ai-helper/raw/main/package.json',
        tagsApiUrl: 'https://gitee.com/api/v5/repos/alture/hydro-ai-helper/tags?per_page=100',
        releasesUrl: 'https://gitee.com/alture/hydro-ai-helper/releases'
    },
    {
        name: 'GitHub',
        owner: 'AltureT',
        repo: 'hydro-ai-helper',
        branch: 'main',
        packageJsonUrl: 'https://raw.githubusercontent.com/AltureT/hydro-ai-helper/main/package.json',
        tagsApiUrl: 'https://api.github.com/repos/AltureT/hydro-ai-helper/tags?per_page=100',
        releasesUrl: 'https://github.com/AltureT/hydro-ai-helper/releases'
    }
];
/**
 * 版本服务类
 */
class VersionService {
    /**
     * 按通道生成缓存键（避免 stable/edge 互相污染缓存）
     */
    cacheKey(channel) {
        return `${VersionService.CACHE_KEY_PREFIX}_${channel}`;
    }
    constructor(versionCacheModel) {
        this.versionCacheModel = versionCacheModel;
        // 从 package.json 读取当前版本（编译时嵌入）
        this.currentVersion = this.readCurrentVersion();
    }
    /**
     * T047: 获取当前安装版本
     * @returns 当前版本号字符串
     */
    getCurrentVersion() {
        return this.currentVersion;
    }
    /**
     * 从 package.json 读取当前版本
     * 在运行时使用 require 读取
     */
    readCurrentVersion() {
        try {
            // 尝试从插件���录读取 package.json
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pkg = require('../../package.json');
            return pkg.version || '0.0.0';
        }
        catch (err) {
            console.error('[VersionService] Failed to read package.json:', err);
            return '0.0.0';
        }
    }
    /**
     * 从单个仓库获取版本信息
     * @param config 仓库配置
     * @param channel 更新通道（stable→最新发布标签；edge→main 的 package.json）
     * @returns 版本信息或 null（失败时）
     */
    async fetchVersionFromRepo(config, channel) {
        const startTime = Date.now();
        try {
            if (channel === 'edge') {
                // edge：读取 main 分支 package.json 的版本号（跟踪最新代码）
                const response = await axios_1.default.get(config.packageJsonUrl, {
                    timeout: 10000,
                    headers: { 'Accept': 'application/json' }
                });
                const latency = Date.now() - startTime;
                const packageJson = response.data;
                let version;
                if (typeof packageJson === 'object' && packageJson.version) {
                    version = packageJson.version;
                }
                else if (typeof packageJson === 'string') {
                    const parsed = JSON.parse(packageJson);
                    version = parsed.version || '0.0.0';
                }
                else {
                    return null;
                }
                return {
                    name: config.name,
                    version: (0, semver_1.normalizeVersion)(version),
                    releasesUrl: config.releasesUrl,
                    latency
                };
            }
            // stable：读取标签列表，选出最新稳定发布版本（与一键更新拉取的目标一致）
            const response = await axios_1.default.get(config.tagsApiUrl, {
                timeout: 10000,
                headers: {
                    'Accept': 'application/json',
                    // GitHub API 要求带 User-Agent，否则返回 403
                    'User-Agent': 'hydro-ai-helper'
                }
            });
            const latency = Date.now() - startTime;
            const data = response.data;
            if (!Array.isArray(data)) {
                return null;
            }
            const tagNames = data
                .map((t) => (t && typeof t.name === 'string' ? t.name : ''))
                .filter(Boolean);
            const latest = (0, semver_1.pickLatestStableTag)(tagNames);
            if (!latest) {
                // 该仓库尚无任何正式发布标签
                return null;
            }
            return {
                name: config.name,
                version: (0, semver_1.normalizeVersion)(latest),
                releasesUrl: config.releasesUrl,
                latency
            };
        }
        catch (err) {
            console.error(`[VersionService] Failed to fetch from ${config.name}:`, err);
            return null;
        }
    }
    /**
     * 从所有仓库获取版本，取最新的
     * @returns 最新版本信息
     */
    async fetchLatestVersionFromAllRepos(channel) {
        console.log(`[VersionService] Checking versions from all repositories (channel: ${channel})...`);
        // 并行获取所有仓库的版本
        const results = await Promise.all(REPO_CONFIGS.map(config => this.fetchVersionFromRepo(config, channel)));
        // 过滤掉失败的结果
        const validResults = results.filter((r) => r !== null);
        if (validResults.length === 0) {
            throw new Error('All repositories failed to respond');
        }
        // 打印获取到的版本
        for (const result of validResults) {
            console.log(`[VersionService] ${result.name}: v${result.version} (${result.latency}ms)`);
        }
        // 找出最新版本
        let latest = validResults[0];
        for (let i = 1; i < validResults.length; i++) {
            if (this.isNewerVersion(validResults[i].version, latest.version)) {
                latest = validResults[i];
            }
        }
        console.log(`[VersionService] Latest version: v${latest.version} from ${latest.name}`);
        return {
            version: latest.version,
            source: latest.name,
            releasesUrl: latest.releasesUrl
        };
    }
    /**
     * T048: 从仓库检查最新版本
     * @param forceRefresh 是否强制刷新（忽略缓存）
     * @returns 版本检查结果
     */
    async checkForUpdates(forceRefresh = false) {
        // 当前实例的更新通道（stable=发布标签 / edge=main 最新代码）
        const channel = (0, updateChannel_1.getUpdateChannel)();
        // T050: 检查缓存（按通道隔离）
        if (!forceRefresh) {
            const cached = await this.getCachedVersion(channel);
            if (cached) {
                // 使用实时版本重新计算 hasUpdate，而非使用缓存中的静态值
                const hasUpdate = (0, semver_1.isNewerVersion)(cached.latestVersion, this.currentVersion);
                return {
                    currentVersion: this.currentVersion,
                    latestVersion: cached.latestVersion,
                    hasUpdate,
                    releaseUrl: cached.releaseUrl || REPO_CONFIGS[0].releasesUrl,
                    releaseNotes: cached.releaseNotes,
                    checkedAt: cached.checkedAt,
                    fromCache: true,
                    source: cached.source,
                    channel
                };
            }
        }
        // 从所有仓库获取最新版本
        try {
            const { version: latestVersion, source, releasesUrl } = await this.fetchLatestVersionFromAllRepos(channel);
            const hasUpdate = (0, semver_1.isNewerVersion)(latestVersion, this.currentVersion);
            // 更新缓存
            await this.updateCache(channel, {
                currentVersion: this.currentVersion,
                latestVersion,
                hasUpdate,
                releaseUrl: releasesUrl,
                source
            });
            return {
                currentVersion: this.currentVersion,
                latestVersion,
                hasUpdate,
                releaseUrl: releasesUrl,
                checkedAt: new Date(),
                fromCache: false,
                source,
                channel
            };
        }
        catch (err) {
            console.error('[VersionService] Failed to check for updates:', err);
            // 如果请求失败，尝试返回过期的缓存数据
            const expiredCache = await this.versionCacheModel.get(this.cacheKey(channel));
            if (expiredCache) {
                // 使用实时版本重新计算 hasUpdate
                const hasUpdate = (0, semver_1.isNewerVersion)(expiredCache.latestVersion, this.currentVersion);
                return {
                    currentVersion: this.currentVersion,
                    latestVersion: expiredCache.latestVersion,
                    hasUpdate,
                    releaseUrl: expiredCache.releaseUrl || REPO_CONFIGS[0].releasesUrl,
                    checkedAt: expiredCache.checkedAt,
                    fromCache: true,
                    source: expiredCache.source,
                    channel
                };
            }
            // 完全失败时返回无更新
            return {
                currentVersion: this.currentVersion,
                latestVersion: this.currentVersion,
                hasUpdate: false,
                releaseUrl: REPO_CONFIGS[0].releasesUrl,
                checkedAt: new Date(),
                fromCache: false,
                channel
            };
        }
    }
    /**
     * T049: 语义化版本比较
     * 判断 version1 是否比 version2 新
     * @param version1 待比较版本
     * @param version2 基准版本
     * @returns true 如果 version1 > version2
     */
    isNewerVersion(version1, version2) {
        return (0, semver_1.isNewerVersion)(version1, version2);
    }
    /**
     * T050: 获取缓存的版本信息（24小时有效）
     * @param channel 更新通道
     * @returns 缓存数据或 null
     */
    async getCachedVersion(channel) {
        const cache = await this.versionCacheModel.get(this.cacheKey(channel));
        if (!cache) {
            return null;
        }
        // 检查缓存是否在 TTL 内
        const now = new Date().getTime();
        const checkedAt = new Date(cache.checkedAt).getTime();
        if (now - checkedAt > versionCache_1.VERSION_CACHE_TTL_MS) {
            return null; // 缓存过期
        }
        return cache;
    }
    /**
     * 更新版本缓存
     * @param channel 更新通道
     * @param data 版本数据
     */
    async updateCache(channel, data) {
        await this.versionCacheModel.set({
            key: this.cacheKey(channel),
            currentVersion: data.currentVersion,
            latestVersion: data.latestVersion,
            hasUpdate: data.hasUpdate,
            releaseUrl: data.releaseUrl,
            releaseNotes: data.releaseNotes,
            source: data.source,
            checkedAt: new Date()
        });
    }
    /**
     * 清除版本缓存（用于测试或强制刷新）
     * 同时清除 stable 与 edge 两个通道的缓存
     */
    async clearCache() {
        await this.versionCacheModel.delete(this.cacheKey('stable'));
        await this.versionCacheModel.delete(this.cacheKey('edge'));
    }
}
exports.VersionService = VersionService;
VersionService.CACHE_KEY_PREFIX = 'latest_version';
//# sourceMappingURL=versionService.js.map