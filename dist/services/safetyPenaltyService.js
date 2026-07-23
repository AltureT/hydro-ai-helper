"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideSafetyPenalty = decideSafetyPenalty;
const PENALTY_WINDOW_MS = 10 * 60 * 1000;
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
            };
        }
        return { action: 'blocked' };
    }
    const recentHighRiskCount = await model.countRecentByCategories(domainId, userId, ['prompt_injection', 'prompt_exfiltration', 'obfuscated_injection'], since);
    if (recentHighRiskCount >= 1) {
        const retryAfterSeconds = 5 * 60;
        return {
            action: 'cooldown_5m',
            retryAfterSeconds,
            blockedUntil: new Date(now.getTime() + retryAfterSeconds * 1000),
        };
    }
    return { action: 'blocked' };
}
//# sourceMappingURL=safetyPenaltyService.js.map