"use strict";
/**
 * AI 配置 v4 新增配置段：次数额度与信誉、偏题守卫、AI 抽查、负责老师访问
 *
 * - DEFAULT_*：v3 → v4 懒迁移补入的默认值（全部为“不限 / 关闭”）
 * - normalize*：读取时兜底（字段缺失或类型错误时用默认值）
 * - apply*Patch：管理员 PUT 时的白名单与校验；只接受已知字段，非法值整体拒绝而不是静默修正
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_OFF_TOPIC_KEYWORD_LENGTH = exports.MAX_OFF_TOPIC_KEYWORDS = exports.DEFAULT_AI_REVIEW_CONFIG = exports.DEFAULT_TOPIC_GUARD_CONFIG = exports.DEFAULT_QUOTA_CONFIG = exports.DEFAULT_CREDIT_CONFIG = exports.CREDIT_CATEGORIES = void 0;
exports.normalizeCreditConfig = normalizeCreditConfig;
exports.normalizeQuotaConfig = normalizeQuotaConfig;
exports.normalizeTopicGuardConfig = normalizeTopicGuardConfig;
exports.normalizeAIReviewConfig = normalizeAIReviewConfig;
exports.normalizeV4Sections = normalizeV4Sections;
exports.applyQuotaConfigPatch = applyQuotaConfigPatch;
exports.applyTopicGuardConfigPatch = applyTopicGuardConfigPatch;
exports.applyAIReviewConfigPatch = applyAIReviewConfigPatch;
const timezone_1 = require("../utils/timezone");
exports.CREDIT_CATEGORIES = [
    'off_topic', 'answer_seeking', 'prompt_injection', 'prompt_exfiltration', 'obfuscated_injection',
];
exports.DEFAULT_CREDIT_CONFIG = {
    floor: 0.2,
    recoveryPerDay: 0.05,
    escalationWindowMinutes: 60,
    maxDeduction: 0.4,
    weights: {
        off_topic: 0.05,
        answer_seeking: 0.1,
        prompt_injection: 0.25,
        prompt_exfiltration: 0.25,
        obfuscated_injection: 0.25,
    },
};
exports.DEFAULT_QUOTA_CONFIG = {
    dailyMessageLimit: 0,
    timezone: timezone_1.DEFAULT_TIMEZONE,
    guaranteeCount: 3,
    credit: exports.DEFAULT_CREDIT_CONFIG,
};
exports.DEFAULT_TOPIC_GUARD_CONFIG = {
    customOffTopicKeywords: [],
    codeExemptMinChars: 30,
    strikeWindowHours: 24,
};
exports.DEFAULT_AI_REVIEW_CONFIG = {
    enabled: false,
    runAt: '02:00',
    sampleRate: 0.05,
    maxConversations: 200,
    breakerWindow: 50,
    breakerMinSample: 10,
    breakerThreshold: 0.2,
};
/** 字段取值范围（校验与读取兜底共用） */
const LIMITS = {
    dailyMessageLimit: { min: 0, max: 100000, integer: true },
    guaranteeCount: { min: 0, max: 1000, integer: true },
    floor: { min: 0, max: 1, integer: false },
    recoveryPerDay: { min: 0, max: 1, integer: false },
    escalationWindowMinutes: { min: 1, max: 1440, integer: true },
    maxDeduction: { min: 0, max: 1, integer: false },
    weight: { min: 0, max: 1, integer: false },
    codeExemptMinChars: { min: 0, max: 10000, integer: true },
    strikeWindowHours: { min: 1, max: 168, integer: true },
    sampleRate: { min: 0, max: 1, integer: false },
    maxConversations: { min: 1, max: 5000, integer: true },
    breakerWindow: { min: 10, max: 1000, integer: true },
    breakerMinSample: { min: 1, max: 1000, integer: true },
    breakerThreshold: { min: 0, max: 1, integer: false },
};
exports.MAX_OFF_TOPIC_KEYWORDS = 200;
exports.MAX_OFF_TOPIC_KEYWORD_LENGTH = 50;
const RUN_AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function inRange(value, limit) {
    return typeof value === 'number' && Number.isFinite(value)
        && value >= limit.min && value <= limit.max
        && (!limit.integer || Number.isInteger(value));
}
function pickNumber(value, limit, fallback) {
    return inRange(value, limit) ? value : fallback;
}
function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
// ─── 读取兜底 ────────────────────────────────────────────────────────────────
function normalizeCreditConfig(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const weightsSrc = isPlainObject(src.weights) ? src.weights : {};
    const weights = {};
    for (const category of exports.CREDIT_CATEGORIES) {
        weights[category] = pickNumber(weightsSrc[category], LIMITS.weight, exports.DEFAULT_CREDIT_CONFIG.weights[category]);
    }
    return {
        floor: pickNumber(src.floor, LIMITS.floor, exports.DEFAULT_CREDIT_CONFIG.floor),
        recoveryPerDay: pickNumber(src.recoveryPerDay, LIMITS.recoveryPerDay, exports.DEFAULT_CREDIT_CONFIG.recoveryPerDay),
        escalationWindowMinutes: pickNumber(src.escalationWindowMinutes, LIMITS.escalationWindowMinutes, exports.DEFAULT_CREDIT_CONFIG.escalationWindowMinutes),
        maxDeduction: pickNumber(src.maxDeduction, LIMITS.maxDeduction, exports.DEFAULT_CREDIT_CONFIG.maxDeduction),
        weights,
    };
}
function normalizeQuotaConfig(raw) {
    const src = isPlainObject(raw) ? raw : {};
    return {
        dailyMessageLimit: pickNumber(src.dailyMessageLimit, LIMITS.dailyMessageLimit, exports.DEFAULT_QUOTA_CONFIG.dailyMessageLimit),
        timezone: (0, timezone_1.isValidTimezone)(src.timezone) ? src.timezone : exports.DEFAULT_QUOTA_CONFIG.timezone,
        guaranteeCount: pickNumber(src.guaranteeCount, LIMITS.guaranteeCount, exports.DEFAULT_QUOTA_CONFIG.guaranteeCount),
        credit: normalizeCreditConfig(src.credit),
    };
}
function normalizeKeywords(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'string')
            continue;
        const keyword = item.trim();
        if (!keyword || keyword.length > exports.MAX_OFF_TOPIC_KEYWORD_LENGTH || out.includes(keyword))
            continue;
        out.push(keyword);
        if (out.length >= exports.MAX_OFF_TOPIC_KEYWORDS)
            break;
    }
    return out;
}
function normalizeTopicGuardConfig(raw) {
    const src = isPlainObject(raw) ? raw : {};
    return {
        customOffTopicKeywords: normalizeKeywords(src.customOffTopicKeywords),
        codeExemptMinChars: pickNumber(src.codeExemptMinChars, LIMITS.codeExemptMinChars, exports.DEFAULT_TOPIC_GUARD_CONFIG.codeExemptMinChars),
        strikeWindowHours: pickNumber(src.strikeWindowHours, LIMITS.strikeWindowHours, exports.DEFAULT_TOPIC_GUARD_CONFIG.strikeWindowHours),
    };
}
function normalizeAIReviewConfig(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const breakerWindow = pickNumber(src.breakerWindow, LIMITS.breakerWindow, exports.DEFAULT_AI_REVIEW_CONFIG.breakerWindow);
    const breakerMinSample = pickNumber(src.breakerMinSample, LIMITS.breakerMinSample, exports.DEFAULT_AI_REVIEW_CONFIG.breakerMinSample);
    return {
        enabled: typeof src.enabled === 'boolean' ? src.enabled : exports.DEFAULT_AI_REVIEW_CONFIG.enabled,
        runAt: typeof src.runAt === 'string' && RUN_AT_RE.test(src.runAt) ? src.runAt : exports.DEFAULT_AI_REVIEW_CONFIG.runAt,
        sampleRate: pickNumber(src.sampleRate, LIMITS.sampleRate, exports.DEFAULT_AI_REVIEW_CONFIG.sampleRate),
        maxConversations: pickNumber(src.maxConversations, LIMITS.maxConversations, exports.DEFAULT_AI_REVIEW_CONFIG.maxConversations),
        breakerWindow,
        breakerMinSample: Math.min(breakerMinSample, breakerWindow),
        breakerThreshold: pickNumber(src.breakerThreshold, LIMITS.breakerThreshold, exports.DEFAULT_AI_REVIEW_CONFIG.breakerThreshold),
    };
}
/** 读取配置时补全 v4 配置段 */
function normalizeV4Sections(config) {
    return {
        quotaConfig: normalizeQuotaConfig(config?.quotaConfig),
        topicGuardConfig: normalizeTopicGuardConfig(config?.topicGuardConfig),
        aiReviewConfig: normalizeAIReviewConfig(config?.aiReviewConfig),
        groupTeacherAccessEnabled: config?.groupTeacherAccessEnabled === true,
    };
}
function applyNumber(target, src, key, limit, fieldPath) {
    if (!(key in src))
        return null;
    const value = src[key];
    if (!inRange(value, limit))
        return fieldPath;
    target[key] = value;
    return null;
}
/** 把 PUT 中的 quotaConfig 部分合并到当前配置；未提供的字段保持不变 */
function applyQuotaConfigPatch(current, raw) {
    if (!isPlainObject(raw))
        return { ok: false, field: 'quotaConfig' };
    const next = { ...current, credit: { ...current.credit, weights: { ...current.credit.weights } } };
    const errors = [
        applyNumber(next, raw, 'dailyMessageLimit', LIMITS.dailyMessageLimit, 'quotaConfig.dailyMessageLimit'),
        applyNumber(next, raw, 'guaranteeCount', LIMITS.guaranteeCount, 'quotaConfig.guaranteeCount'),
    ].filter(Boolean);
    if (errors.length)
        return { ok: false, field: errors[0] };
    if ('timezone' in raw) {
        if (!(0, timezone_1.isValidTimezone)(raw.timezone))
            return { ok: false, field: 'quotaConfig.timezone', code: 'INVALID_TIMEZONE' };
        next.timezone = raw.timezone;
    }
    if ('credit' in raw) {
        const credit = raw.credit;
        if (!isPlainObject(credit))
            return { ok: false, field: 'quotaConfig.credit' };
        const creditTarget = next.credit;
        const creditErrors = [
            applyNumber(creditTarget, credit, 'floor', LIMITS.floor, 'quotaConfig.credit.floor'),
            applyNumber(creditTarget, credit, 'recoveryPerDay', LIMITS.recoveryPerDay, 'quotaConfig.credit.recoveryPerDay'),
            applyNumber(creditTarget, credit, 'escalationWindowMinutes', LIMITS.escalationWindowMinutes, 'quotaConfig.credit.escalationWindowMinutes'),
            applyNumber(creditTarget, credit, 'maxDeduction', LIMITS.maxDeduction, 'quotaConfig.credit.maxDeduction'),
        ].filter(Boolean);
        if (creditErrors.length)
            return { ok: false, field: creditErrors[0] };
        if ('weights' in credit) {
            const weights = credit.weights;
            if (!isPlainObject(weights))
                return { ok: false, field: 'quotaConfig.credit.weights' };
            for (const category of exports.CREDIT_CATEGORIES) {
                if (!(category in weights))
                    continue;
                if (!inRange(weights[category], LIMITS.weight)) {
                    return { ok: false, field: `quotaConfig.credit.weights.${category}` };
                }
                next.credit.weights[category] = weights[category];
            }
        }
    }
    return { ok: true, value: next };
}
function applyTopicGuardConfigPatch(current, raw) {
    if (!isPlainObject(raw))
        return { ok: false, field: 'topicGuardConfig' };
    const next = { ...current, customOffTopicKeywords: [...current.customOffTopicKeywords] };
    const errors = [
        applyNumber(next, raw, 'codeExemptMinChars', LIMITS.codeExemptMinChars, 'topicGuardConfig.codeExemptMinChars'),
        applyNumber(next, raw, 'strikeWindowHours', LIMITS.strikeWindowHours, 'topicGuardConfig.strikeWindowHours'),
    ].filter(Boolean);
    if (errors.length)
        return { ok: false, field: errors[0] };
    if ('customOffTopicKeywords' in raw) {
        const list = raw.customOffTopicKeywords;
        if (!Array.isArray(list) || list.length > exports.MAX_OFF_TOPIC_KEYWORDS
            || list.some((item) => typeof item !== 'string' || item.trim().length > exports.MAX_OFF_TOPIC_KEYWORD_LENGTH)) {
            return { ok: false, field: 'topicGuardConfig.customOffTopicKeywords' };
        }
        next.customOffTopicKeywords = normalizeKeywords(list);
    }
    return { ok: true, value: next };
}
function applyAIReviewConfigPatch(current, raw) {
    if (!isPlainObject(raw))
        return { ok: false, field: 'aiReviewConfig' };
    const next = { ...current };
    const target = next;
    const errors = [
        applyNumber(target, raw, 'sampleRate', LIMITS.sampleRate, 'aiReviewConfig.sampleRate'),
        applyNumber(target, raw, 'maxConversations', LIMITS.maxConversations, 'aiReviewConfig.maxConversations'),
        applyNumber(target, raw, 'breakerWindow', LIMITS.breakerWindow, 'aiReviewConfig.breakerWindow'),
        applyNumber(target, raw, 'breakerMinSample', LIMITS.breakerMinSample, 'aiReviewConfig.breakerMinSample'),
        applyNumber(target, raw, 'breakerThreshold', LIMITS.breakerThreshold, 'aiReviewConfig.breakerThreshold'),
    ].filter(Boolean);
    if (errors.length)
        return { ok: false, field: errors[0] };
    if ('enabled' in raw) {
        if (typeof raw.enabled !== 'boolean')
            return { ok: false, field: 'aiReviewConfig.enabled' };
        next.enabled = raw.enabled;
    }
    if ('runAt' in raw) {
        if (typeof raw.runAt !== 'string' || !RUN_AT_RE.test(raw.runAt))
            return { ok: false, field: 'aiReviewConfig.runAt' };
        next.runAt = raw.runAt;
    }
    if (next.breakerMinSample > next.breakerWindow)
        return { ok: false, field: 'aiReviewConfig.breakerMinSample' };
    return { ok: true, value: next };
}
//# sourceMappingURL=configSections.js.map