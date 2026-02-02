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
/**
 * 仓库配置（按优先级排序）
 */
const REPO_CONFIGS = [
    {
        name: 'Gitee',
        owner: 'alture',
        repo: 'hydro-ai-helper',
        branch: 'main',
        packageJsonUrl: 'https://gitee.com/alture/hydro-ai-helper/raw/main/package.json',
        releasesUrl: 'https://gitee.com/alture/hydro-ai-helper/releases'
    },
    {
        name: 'GitHub',
        owner: 'AltureT',
        repo: 'hydro-ai-helper',
        branch: 'main',
        packageJsonUrl: 'https://raw.githubusercontent.com/AltureT/hydro-ai-helper/main/package.json',
        releasesUrl: 'https://github.com/AltureT/hydro-ai-helper/releases'
    }
];
/**
 * 版本服务类
 */
class VersionService {
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
     * @returns 版本信息或 null（失败时）
     */
    async fetchVersionFromRepo(config) {
        const startTime = Date.now();
        try {
            const response = await axios_1.default.get(config.packageJsonUrl, {
                timeout: 10000,
                headers: {
                    'Accept': 'application/json'
                }
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
                version,
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
    async fetchLatestVersionFromAllRepos() {
        console.log('[VersionService] Checking versions from all repositories...');
        // 并行获取所有仓库的版本
        const results = await Promise.all(REPO_CONFIGS.map(config => this.fetchVersionFromRepo(config)));
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
        // T050: 检查缓存
        if (!forceRefresh) {
            const cached = await this.getCachedVersion();
            if (cached) {
                return {
                    currentVersion: this.currentVersion,
                    latestVersion: cached.latestVersion,
                    hasUpdate: cached.hasUpdate,
                    releaseUrl: cached.releaseUrl || REPO_CONFIGS[0].releasesUrl,
                    releaseNotes: cached.releaseNotes,
                    checkedAt: cached.checkedAt,
                    fromCache: true,
                    source: cached.source
                };
            }
        }
        // 从所有仓库获取最新版本
        try {
            const { version: latestVersion, source, releasesUrl } = await this.fetchLatestVersionFromAllRepos();
            const hasUpdate = this.isNewerVersion(latestVersion, this.currentVersion);
            // 更新缓存
            await this.updateCache({
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
                source
            };
        }
        catch (err) {
            console.error('[VersionService] Failed to check for updates:', err);
            // 如果请求失败，尝试返回过期的缓存数据
            const expiredCache = await this.versionCacheModel.get(VersionService.CACHE_KEY);
            if (expiredCache) {
                return {
                    currentVersion: this.currentVersion,
                    latestVersion: expiredCache.latestVersion,
                    hasUpdate: expiredCache.hasUpdate,
                    releaseUrl: expiredCache.releaseUrl || REPO_CONFIGS[0].releasesUrl,
                    checkedAt: expiredCache.checkedAt,
                    fromCache: true,
                    source: expiredCache.source
                };
            }
            // 完全失败时返回无更新
            return {
                currentVersion: this.currentVersion,
                latestVersion: this.currentVersion,
                hasUpdate: false,
                releaseUrl: REPO_CONFIGS[0].releasesUrl,
                checkedAt: new Date(),
                fromCache: false
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
        const v1Parts = this.parseVersion(version1);
        const v2Parts = this.parseVersion(version2);
        for (let i = 0; i < 3; i++) {
            if (v1Parts[i] > v2Parts[i])
                return true;
            if (v1Parts[i] < v2Parts[i])
                return false;
        }
        return false; // 版本相同
    }
    /**
     * 解析版本号为数字数组
     * @param version 版本字符串（如 "1.2.3"）
     * @returns [major, minor, patch]
     */
    parseVersion(version) {
        // 移除前缀 v 或 V
        const clean = version.replace(/^[vV]/, '');
        // 移除预发布标签（如 -beta.1）
        const base = clean.split('-')[0];
        // 解析主版本号
        const parts = base.split('.').map(p => parseInt(p, 10) || 0);
        return [
            parts[0] || 0,
            parts[1] || 0,
            parts[2] || 0
        ];
    }
    /**
     * T050: 获取缓存的版本信息（24小时有效）
     * @returns 缓存数据或 null
     */
    async getCachedVersion() {
        const cache = await this.versionCacheModel.get(VersionService.CACHE_KEY);
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
     * @param data 版本数据
     */
    async updateCache(data) {
        await this.versionCacheModel.set({
            key: VersionService.CACHE_KEY,
            currentVersion: data.currentVersion,
            latestVersion: data.latestVersion,
            hasUpdate: data.hasUpdate,
            releaseUrl: data.releaseUrl,
            releaseNotes: data.releaseNotes,
            checkedAt: new Date()
        });
    }
    /**
     * 清除版本缓存（用于测试或强制刷新）
     */
    async clearCache() {
        await this.versionCacheModel.delete(VersionService.CACHE_KEY);
    }
}
exports.VersionService = VersionService;
VersionService.CACHE_KEY = 'latest_version';
//# sourceMappingURL=versionService.js.map