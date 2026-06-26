"use strict";
/**
 * Semver Utility - 语义化版本工具
 *
 * 集中处理版本号解析、比较以及"稳定发布标签"的筛选逻辑，
 * 供 VersionService（版本检测）与 UpdateService（一键更新）共用，
 * 确保"判断有无更新"与"实际拉取的版本"使用同一套规则。
 *
 * 稳定标签定义：形如 `v1.2.3` / `1.2.3` 的纯三段式版本号；
 * 任何带预发布后缀的标签（如 `v1.2.3-beta.1`）都不视为稳定版，
 * 因此预发布版本不会被推送给普通（stable 通道）用户。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSemver = parseSemver;
exports.normalizeVersion = normalizeVersion;
exports.isNewerVersion = isNewerVersion;
exports.isStableVersionTag = isStableVersionTag;
exports.pickLatestStableTag = pickLatestStableTag;
/** 纯三段式稳定版本标签（可带前缀 v/V），不含预发布后缀 */
const STABLE_TAG_REGEX = /^[vV]?\d+\.\d+\.\d+$/;
/**
 * 解析版本号为 [major, minor, patch]
 * - 去除前缀 v/V
 * - 去除预发布标签（如 -beta.1）后再解析数字
 */
function parseSemver(version) {
    const clean = String(version || '').trim().replace(/^[vV]/, '');
    const base = clean.split('-')[0];
    const parts = base.split('.').map((p) => parseInt(p, 10) || 0);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
/**
 * 去除前缀 v/V，返回规范化版本号字符串（用于显示/缓存）
 */
function normalizeVersion(version) {
    return String(version || '').trim().replace(/^[vV]/, '');
}
/**
 * 判断 version1 是否比 version2 新（严格大于）
 */
function isNewerVersion(version1, version2) {
    const v1 = parseSemver(version1);
    const v2 = parseSemver(version2);
    for (let i = 0; i < 3; i++) {
        if (v1[i] > v2[i])
            return true;
        if (v1[i] < v2[i])
            return false;
    }
    return false;
}
/**
 * 是否为稳定发布标签（纯三段式，无预发布后缀）
 */
function isStableVersionTag(tag) {
    return STABLE_TAG_REGEX.test(String(tag || '').trim());
}
/**
 * 从一组标签中挑选"最新的稳定发布标签"
 * @param tags 标签名数组（如 ['v1.0.0', 'v2.1.0', 'v2.2.0-beta.1']）
 * @returns 最新稳定标签的原始字符串（如 'v2.1.0'），无稳定标签时返回 null
 */
function pickLatestStableTag(tags) {
    let latest = null;
    for (const raw of tags) {
        const tag = String(raw || '').trim();
        if (!isStableVersionTag(tag))
            continue;
        if (latest === null || isNewerVersion(tag, latest)) {
            latest = tag;
        }
    }
    return latest;
}
//# sourceMappingURL=semver.js.map