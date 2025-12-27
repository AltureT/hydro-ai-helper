/**
 * Version Service - 版本检测服务
 *
 * 提供插件版本检测功能：
 * - 获取当前安装版本
 * - 从 Gitee 仓库检查最新版本
 * - 语义化版本比较
 * - 24 小时缓存机制
 */

import axios from 'axios';
import { VersionCacheModel, type VersionCache, VERSION_CACHE_TTL_MS } from '../models/versionCache';

/**
 * Gitee 仓库配置
 */
const GITEE_CONFIG = {
  owner: 'alture',
  repo: 'hydro-ai-helper',
  branch: 'main',
  packageJsonPath: 'package.json',
  releasesUrl: 'https://gitee.com/alture/hydro-ai-helper/releases'
};

/**
 * 版本检查结果接口
 */
export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string;
  checkedAt: Date;
  fromCache: boolean;
}

/**
 * 版本服务类
 */
export class VersionService {
  private versionCacheModel: VersionCacheModel;
  private currentVersion: string;
  private static CACHE_KEY = 'latest_version';

  constructor(versionCacheModel: VersionCacheModel) {
    this.versionCacheModel = versionCacheModel;
    // 从 package.json 读取当前版本（编译时嵌入）
    this.currentVersion = this.readCurrentVersion();
  }

  /**
   * T047: 获取当前安装版本
   * @returns 当前版本号字符串
   */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /**
   * 从 package.json 读取当前版本
   * 在运行时使用 require 读取
   */
  private readCurrentVersion(): string {
    try {
      // 尝试从插件目录读取 package.json
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require('../../package.json');
      return pkg.version || '0.0.0';
    } catch (err) {
      console.error('[VersionService] Failed to read package.json:', err);
      return '0.0.0';
    }
  }

  /**
   * T048: 从 Gitee 仓库检查最新版本
   * @param forceRefresh 是否强制刷新（忽略缓存）
   * @returns 版本检查结果
   */
  async checkForUpdates(forceRefresh = false): Promise<VersionCheckResult> {
    // T050: 检查缓存
    if (!forceRefresh) {
      const cached = await this.getCachedVersion();
      if (cached) {
        return {
          currentVersion: this.currentVersion,
          latestVersion: cached.latestVersion,
          hasUpdate: cached.hasUpdate,
          releaseUrl: cached.releaseUrl || GITEE_CONFIG.releasesUrl,
          releaseNotes: cached.releaseNotes,
          checkedAt: cached.checkedAt,
          fromCache: true
        };
      }
    }

    // 从 Gitee 获取最新版本
    try {
      const latestVersion = await this.fetchLatestVersionFromGitee();
      const hasUpdate = this.isNewerVersion(latestVersion, this.currentVersion);

      // 更新缓存
      await this.updateCache({
        currentVersion: this.currentVersion,
        latestVersion,
        hasUpdate,
        releaseUrl: GITEE_CONFIG.releasesUrl
      });

      return {
        currentVersion: this.currentVersion,
        latestVersion,
        hasUpdate,
        releaseUrl: GITEE_CONFIG.releasesUrl,
        checkedAt: new Date(),
        fromCache: false
      };
    } catch (err) {
      console.error('[VersionService] Failed to check for updates:', err);

      // 如果请求失败，尝试返回过期的缓存数据
      const expiredCache = await this.versionCacheModel.get(VersionService.CACHE_KEY);
      if (expiredCache) {
        return {
          currentVersion: this.currentVersion,
          latestVersion: expiredCache.latestVersion,
          hasUpdate: expiredCache.hasUpdate,
          releaseUrl: expiredCache.releaseUrl || GITEE_CONFIG.releasesUrl,
          checkedAt: expiredCache.checkedAt,
          fromCache: true
        };
      }

      // 完全失败时返回无更新
      return {
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        hasUpdate: false,
        releaseUrl: GITEE_CONFIG.releasesUrl,
        checkedAt: new Date(),
        fromCache: false
      };
    }
  }

  /**
   * 从 Gitee API 获取最新版本
   * @returns 最新版本号
   */
  private async fetchLatestVersionFromGitee(): Promise<string> {
    // Gitee Raw 文件 API
    const url = `https://gitee.com/${GITEE_CONFIG.owner}/${GITEE_CONFIG.repo}/raw/${GITEE_CONFIG.branch}/${GITEE_CONFIG.packageJsonPath}`;

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json'
      }
    });

    const packageJson = response.data;
    if (typeof packageJson === 'object' && packageJson.version) {
      return packageJson.version;
    }

    // 如果返回的是字符串，尝试解析
    if (typeof packageJson === 'string') {
      const parsed = JSON.parse(packageJson);
      return parsed.version || '0.0.0';
    }

    throw new Error('Invalid package.json format from Gitee');
  }

  /**
   * T049: 语义化版本比较
   * 判断 version1 是否比 version2 新
   * @param version1 待比较版本
   * @param version2 基准版本
   * @returns true 如果 version1 > version2
   */
  isNewerVersion(version1: string, version2: string): boolean {
    const v1Parts = this.parseVersion(version1);
    const v2Parts = this.parseVersion(version2);

    for (let i = 0; i < 3; i++) {
      if (v1Parts[i] > v2Parts[i]) return true;
      if (v1Parts[i] < v2Parts[i]) return false;
    }

    return false;  // 版本相同
  }

  /**
   * 解析版本号为数字数组
   * @param version 版本字符串（如 "1.2.3"）
   * @returns [major, minor, patch]
   */
  private parseVersion(version: string): [number, number, number] {
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
  private async getCachedVersion(): Promise<VersionCache | null> {
    const cache = await this.versionCacheModel.get(VersionService.CACHE_KEY);

    if (!cache) {
      return null;
    }

    // 检查缓存是否在 TTL 内
    const now = new Date().getTime();
    const checkedAt = new Date(cache.checkedAt).getTime();

    if (now - checkedAt > VERSION_CACHE_TTL_MS) {
      return null;  // 缓存过期
    }

    return cache;
  }

  /**
   * 更新版本缓存
   * @param data 版本数据
   */
  private async updateCache(data: {
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    releaseUrl?: string;
    releaseNotes?: string;
  }): Promise<void> {
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
  async clearCache(): Promise<void> {
    await this.versionCacheModel.delete(VersionService.CACHE_KEY);
  }
}
