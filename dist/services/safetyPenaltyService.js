"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAFETY_PENALTY_WINDOW_MS = void 0;
exports.decideSafetyPenalty = decideSafetyPenalty;
exports.decideSafetyPenaltyFromCount = decideSafetyPenaltyFromCount;
const PENALTY_WINDOW_MS = 10 * 60 * 1000;
exports.SAFETY_PENALTY_WINDOW_MS = PENALTY_WINDOW_MS;
/**
 * 渐进式、会自动衰减的 AI 对话限制。
 * - 普通索要答案：10 分钟内第 3 次才冷却 60 秒。
 * - 明确注入/提示词泄露/编码绕过：10 分钟内第 2 次冷却 5 分钟。
 * 限制只作用于 AI 对话，不影响做题或提交。
 */
async function decideSafetyPenalty(model, domainId, userId, category, now = new Date()) {
    const since = new Date(now.getTime() - PENALTY_WINDOW_MS);
    if (category === 'answer_seeking') {
        const recentCount = await model.countRecentByCategories(domainId, userId, ['answer_seeking'], since);
        if (recentCount >= 2) {
            const retryAfterSeconds = 60;
            return {
                action: 'cooldown_60s',
                retryAfterSeconds,
                blockedUntil: new Date(now.getTime() + retryAfterSeconds * 1000),
                currentCount: recentCount + 1,
                threshold: 3,
                remainingBeforeCooldown: 0,
                windowSeconds: PENALTY_WINDOW_MS / 1000,
            };
        }
        return {
            action: 'blocked',
            currentCount: recentCount + 1,
            threshold: 3,
            remainingBeforeCooldown: 2 - recentCount,
            windowSeconds: PENALTY_WINDOW_MS / 1000,
        };
    }
    const recentHighRiskCount = await model.countRecentByCategories(domainId, userId, ['prompt_injection', 'prompt_exfiltration', 'obfuscated_injection'], since);
    if (recentHighRiskCount >= 1) {
        const retryAfterSeconds = 5 * 60;
        return {
            action: 'cooldown_5m',
            retryAfterSeconds,
            blockedUntil: new Date(now.getTime() + retryAfterSeconds * 1000),
            currentCount: recentHighRiskCount + 1,
            threshold: 2,
            remainingBeforeCooldown: 0,
            windowSeconds: PENALTY_WINDOW_MS / 1000,
        };
    }
    return {
        action: 'blocked',
        currentCount: 1,
        threshold: 2,
        remainingBeforeCooldown: 1,
        windowSeconds: PENALTY_WINDOW_MS / 1000,
    };
}
/**
 * 根据模型层原子递增后返回的当前序号决定处置，避免并发请求同时读到旧计数。
 */
function decideSafetyPenaltyFromCount(category, currentCount, now = new Date()) {
    const normalizedCount = Math.max(1, Math.floor(currentCount));
    const threshold = category === 'answer_seeking' ? 3 : 2;
    const retryAfterSeconds = normalizedCount >= threshold
        ? category === 'answer_seeking' ? 60 : 5 * 60
        : undefined;
    return {
        action: retryAfterSeconds
            ? category === 'answer_seeking' ? 'cooldown_60s' : 'cooldown_5m'
            : 'blocked',
        ...(retryAfterSeconds
            ? {
                retryAfterSeconds,
                blockedUntil: new Date(now.getTime() + retryAfterSeconds * 1000),
            }
            : {}),
        currentCount: normalizedCount,
        threshold,
        remainingBeforeCooldown: Math.max(0, threshold - normalizedCount),
        windowSeconds: PENALTY_WINDOW_MS / 1000,
    };
}
//# sourceMappingURL=safetyPenaltyService.js.map