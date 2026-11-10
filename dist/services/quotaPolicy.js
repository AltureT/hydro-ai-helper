"use strict";
/**
 * 额度策略纯函数（FR-024、FR-027，plan R11）
 *
 * 次数上限用 `number | null` 表示：null = 不限，0 = 禁用 AI。
 *
 * 基础额度：
 *   1. 未过期的个人覆盖优先（指定次数或禁用）；
 *   2. 否则取所属授予型额度组的最大值，不属于任何授予型组时用全局默认；
 *   3. 再与所属限制型额度组取最小。
 * 当日有效额度 = min(基础, max(保底, ⌊基础 × m⌋))；基础为 0 时为 0，不限时仍不限。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOverrideActive = isOverrideActive;
exports.defaultLimitFromConfig = defaultLimitFromConfig;
exports.resolveBase = resolveBase;
exports.effective = effective;
function isNonNegativeInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function isOverrideActive(override, now) {
    if (!override)
        return false;
    if (override.expiresAt && override.expiresAt.getTime() <= now.getTime())
        return false;
    return override.mode === 'disabled' || (override.mode === 'limit' && isNonNegativeInt(override.dailyLimit));
}
/** 全局默认的配置值 0 表示不限 */
function defaultLimitFromConfig(dailyMessageLimit) {
    return isNonNegativeInt(dailyMessageLimit) && dailyMessageLimit > 0 ? dailyMessageLimit : null;
}
function resolveBase(override, grantLimits, capLimits, defaultLimit, now = new Date()) {
    if (override && isOverrideActive(override, now)) {
        return {
            base: override.mode === 'disabled' ? 0 : override.dailyLimit,
            source: 'override',
            capped: false,
        };
    }
    const grants = grantLimits.filter(isNonNegativeInt);
    let base = grants.length ? Math.max(...grants) : defaultLimit;
    const source = grants.length ? 'grant' : 'default';
    const caps = capLimits.filter(isNonNegativeInt);
    let capped = false;
    if (caps.length) {
        const cap = Math.min(...caps);
        if (base === null || cap < base) {
            base = cap;
            capped = true;
        }
    }
    return { base, source, capped };
}
/** 信誉系数换算当日有效额度 */
function effective(base, m, guarantee) {
    if (base === null)
        return null;
    if (base <= 0)
        return 0;
    const multiplier = Number.isFinite(m) ? Math.min(1, Math.max(0, m)) : 1;
    const floorCount = Math.floor(base * multiplier + 1e-9);
    const minimum = Math.max(0, Math.floor(guarantee));
    return Math.min(base, Math.max(minimum, floorCount));
}
//# sourceMappingURL=quotaPolicy.js.map