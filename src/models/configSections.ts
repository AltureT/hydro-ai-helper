/**
 * AI 配置 v4 新增配置段：次数额度与信誉、偏题守卫、AI 抽查、负责老师访问
 *
 * - DEFAULT_*：v3 → v4 懒迁移补入的默认值（全部为“不限 / 关闭”）
 * - normalize*：读取时兜底（字段缺失或类型错误时用默认值）
 * - apply*Patch：管理员 PUT 时的白名单与校验；只接受已知字段，非法值整体拒绝而不是静默修正
 */

import { DEFAULT_TIMEZONE, isValidTimezone } from '../utils/timezone';

export type CreditCategory =
  | 'off_topic'
  | 'answer_seeking'
  | 'prompt_injection'
  | 'prompt_exfiltration'
  | 'obfuscated_injection';

export const CREDIT_CATEGORIES: readonly CreditCategory[] = [
  'off_topic', 'answer_seeking', 'prompt_injection', 'prompt_exfiltration', 'obfuscated_injection',
] as const;

export interface CreditConfig {
  floor: number;
  recoveryPerDay: number;
  escalationWindowMinutes: number;
  maxDeduction: number;
  weights: Record<CreditCategory, number>;
}

export interface QuotaConfig {
  /** 全局每日默认次数，0 = 不限 */
  dailyMessageLimit: number;
  timezone: string;
  guaranteeCount: number;
  credit: CreditConfig;
}

export interface TopicGuardConfig {
  customOffTopicKeywords: string[];
  codeExemptMinChars: number;
  strikeWindowHours: number;
}

export interface AIReviewConfig {
  enabled: boolean;
  runAt: string;
  /** 0–1 */
  sampleRate: number;
  maxConversations: number;
  breakerWindow: number;
  breakerMinSample: number;
  breakerThreshold: number;
}

export interface V4ConfigSections {
  quotaConfig: QuotaConfig;
  topicGuardConfig: TopicGuardConfig;
  aiReviewConfig: AIReviewConfig;
  groupTeacherAccessEnabled: boolean;
}

export const DEFAULT_CREDIT_CONFIG: CreditConfig = {
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

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
  dailyMessageLimit: 0,
  timezone: DEFAULT_TIMEZONE,
  guaranteeCount: 3,
  credit: DEFAULT_CREDIT_CONFIG,
};

export const DEFAULT_TOPIC_GUARD_CONFIG: TopicGuardConfig = {
  customOffTopicKeywords: [],
  codeExemptMinChars: 30,
  strikeWindowHours: 24,
};

export const DEFAULT_AI_REVIEW_CONFIG: AIReviewConfig = {
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
} as const;

type Limit = { min: number; max: number; integer: boolean };

export const MAX_OFF_TOPIC_KEYWORDS = 200;
export const MAX_OFF_TOPIC_KEYWORD_LENGTH = 50;
const RUN_AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function inRange(value: unknown, limit: Limit): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= limit.min && value <= limit.max
    && (!limit.integer || Number.isInteger(value));
}

function pickNumber(value: unknown, limit: Limit, fallback: number): number {
  return inRange(value, limit) ? value : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── 读取兜底 ────────────────────────────────────────────────────────────────

export function normalizeCreditConfig(raw: unknown): CreditConfig {
  const src = isPlainObject(raw) ? raw : {};
  const weightsSrc = isPlainObject(src.weights) ? src.weights : {};
  const weights = {} as Record<CreditCategory, number>;
  for (const category of CREDIT_CATEGORIES) {
    weights[category] = pickNumber(weightsSrc[category], LIMITS.weight, DEFAULT_CREDIT_CONFIG.weights[category]);
  }
  return {
    floor: pickNumber(src.floor, LIMITS.floor, DEFAULT_CREDIT_CONFIG.floor),
    recoveryPerDay: pickNumber(src.recoveryPerDay, LIMITS.recoveryPerDay, DEFAULT_CREDIT_CONFIG.recoveryPerDay),
    escalationWindowMinutes: pickNumber(
      src.escalationWindowMinutes, LIMITS.escalationWindowMinutes, DEFAULT_CREDIT_CONFIG.escalationWindowMinutes,
    ),
    maxDeduction: pickNumber(src.maxDeduction, LIMITS.maxDeduction, DEFAULT_CREDIT_CONFIG.maxDeduction),
    weights,
  };
}

export function normalizeQuotaConfig(raw: unknown): QuotaConfig {
  const src = isPlainObject(raw) ? raw : {};
  return {
    dailyMessageLimit: pickNumber(src.dailyMessageLimit, LIMITS.dailyMessageLimit, DEFAULT_QUOTA_CONFIG.dailyMessageLimit),
    timezone: isValidTimezone(src.timezone) ? src.timezone : DEFAULT_QUOTA_CONFIG.timezone,
    guaranteeCount: pickNumber(src.guaranteeCount, LIMITS.guaranteeCount, DEFAULT_QUOTA_CONFIG.guaranteeCount),
    credit: normalizeCreditConfig(src.credit),
  };
}

function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const keyword = item.trim();
    if (!keyword || keyword.length > MAX_OFF_TOPIC_KEYWORD_LENGTH || out.includes(keyword)) continue;
    out.push(keyword);
    if (out.length >= MAX_OFF_TOPIC_KEYWORDS) break;
  }
  return out;
}

export function normalizeTopicGuardConfig(raw: unknown): TopicGuardConfig {
  const src = isPlainObject(raw) ? raw : {};
  return {
    customOffTopicKeywords: normalizeKeywords(src.customOffTopicKeywords),
    codeExemptMinChars: pickNumber(src.codeExemptMinChars, LIMITS.codeExemptMinChars, DEFAULT_TOPIC_GUARD_CONFIG.codeExemptMinChars),
    strikeWindowHours: pickNumber(src.strikeWindowHours, LIMITS.strikeWindowHours, DEFAULT_TOPIC_GUARD_CONFIG.strikeWindowHours),
  };
}

export function normalizeAIReviewConfig(raw: unknown): AIReviewConfig {
  const src = isPlainObject(raw) ? raw : {};
  const breakerWindow = pickNumber(src.breakerWindow, LIMITS.breakerWindow, DEFAULT_AI_REVIEW_CONFIG.breakerWindow);
  const breakerMinSample = pickNumber(src.breakerMinSample, LIMITS.breakerMinSample, DEFAULT_AI_REVIEW_CONFIG.breakerMinSample);
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_AI_REVIEW_CONFIG.enabled,
    runAt: typeof src.runAt === 'string' && RUN_AT_RE.test(src.runAt) ? src.runAt : DEFAULT_AI_REVIEW_CONFIG.runAt,
    sampleRate: pickNumber(src.sampleRate, LIMITS.sampleRate, DEFAULT_AI_REVIEW_CONFIG.sampleRate),
    maxConversations: pickNumber(src.maxConversations, LIMITS.maxConversations, DEFAULT_AI_REVIEW_CONFIG.maxConversations),
    breakerWindow,
    breakerMinSample: Math.min(breakerMinSample, breakerWindow),
    breakerThreshold: pickNumber(src.breakerThreshold, LIMITS.breakerThreshold, DEFAULT_AI_REVIEW_CONFIG.breakerThreshold),
  };
}

/** 读取配置时补全 v4 配置段 */
export function normalizeV4Sections(config: Partial<Record<keyof V4ConfigSections, unknown>> | null | undefined): V4ConfigSections {
  return {
    quotaConfig: normalizeQuotaConfig(config?.quotaConfig),
    topicGuardConfig: normalizeTopicGuardConfig(config?.topicGuardConfig),
    aiReviewConfig: normalizeAIReviewConfig(config?.aiReviewConfig),
    groupTeacherAccessEnabled: config?.groupTeacherAccessEnabled === true,
  };
}

// ─── 管理员 PUT 校验 ─────────────────────────────────────────────────────────

export type PatchResult<T> = { ok: true; value: T } | { ok: false; field: string; code?: string };

function applyNumber<T extends Record<string, unknown>>(
  target: T, src: Record<string, unknown>, key: keyof T & string, limit: Limit, fieldPath: string,
): string | null {
  if (!(key in src)) return null;
  const value = src[key];
  if (!inRange(value, limit)) return fieldPath;
  (target as Record<string, unknown>)[key] = value;
  return null;
}

/** 把 PUT 中的 quotaConfig 部分合并到当前配置；未提供的字段保持不变 */
export function applyQuotaConfigPatch(current: QuotaConfig, raw: unknown): PatchResult<QuotaConfig> {
  if (!isPlainObject(raw)) return { ok: false, field: 'quotaConfig' };
  const next: QuotaConfig = { ...current, credit: { ...current.credit, weights: { ...current.credit.weights } } };
  const errors = [
    applyNumber(next as unknown as Record<string, unknown>, raw, 'dailyMessageLimit', LIMITS.dailyMessageLimit, 'quotaConfig.dailyMessageLimit'),
    applyNumber(next as unknown as Record<string, unknown>, raw, 'guaranteeCount', LIMITS.guaranteeCount, 'quotaConfig.guaranteeCount'),
  ].filter(Boolean) as string[];
  if (errors.length) return { ok: false, field: errors[0] };

  if ('timezone' in raw) {
    if (!isValidTimezone(raw.timezone)) return { ok: false, field: 'quotaConfig.timezone', code: 'INVALID_TIMEZONE' };
    next.timezone = raw.timezone;
  }

  if ('credit' in raw) {
    const credit = raw.credit;
    if (!isPlainObject(credit)) return { ok: false, field: 'quotaConfig.credit' };
    const creditTarget = next.credit as unknown as Record<string, unknown>;
    const creditErrors = [
      applyNumber(creditTarget, credit, 'floor', LIMITS.floor, 'quotaConfig.credit.floor'),
      applyNumber(creditTarget, credit, 'recoveryPerDay', LIMITS.recoveryPerDay, 'quotaConfig.credit.recoveryPerDay'),
      applyNumber(creditTarget, credit, 'escalationWindowMinutes', LIMITS.escalationWindowMinutes, 'quotaConfig.credit.escalationWindowMinutes'),
      applyNumber(creditTarget, credit, 'maxDeduction', LIMITS.maxDeduction, 'quotaConfig.credit.maxDeduction'),
    ].filter(Boolean) as string[];
    if (creditErrors.length) return { ok: false, field: creditErrors[0] };
    if ('weights' in credit) {
      const weights = credit.weights;
      if (!isPlainObject(weights)) return { ok: false, field: 'quotaConfig.credit.weights' };
      for (const category of CREDIT_CATEGORIES) {
        if (!(category in weights)) continue;
        if (!inRange(weights[category], LIMITS.weight)) {
          return { ok: false, field: `quotaConfig.credit.weights.${category}` };
        }
        next.credit.weights[category] = weights[category] as number;
      }
    }
  }
  return { ok: true, value: next };
}

export function applyTopicGuardConfigPatch(current: TopicGuardConfig, raw: unknown): PatchResult<TopicGuardConfig> {
  if (!isPlainObject(raw)) return { ok: false, field: 'topicGuardConfig' };
  const next: TopicGuardConfig = { ...current, customOffTopicKeywords: [...current.customOffTopicKeywords] };
  const errors = [
    applyNumber(next as unknown as Record<string, unknown>, raw, 'codeExemptMinChars', LIMITS.codeExemptMinChars, 'topicGuardConfig.codeExemptMinChars'),
    applyNumber(next as unknown as Record<string, unknown>, raw, 'strikeWindowHours', LIMITS.strikeWindowHours, 'topicGuardConfig.strikeWindowHours'),
  ].filter(Boolean) as string[];
  if (errors.length) return { ok: false, field: errors[0] };
  if ('customOffTopicKeywords' in raw) {
    const list = raw.customOffTopicKeywords;
    if (!Array.isArray(list) || list.length > MAX_OFF_TOPIC_KEYWORDS
      || list.some((item) => typeof item !== 'string' || item.trim().length > MAX_OFF_TOPIC_KEYWORD_LENGTH)) {
      return { ok: false, field: 'topicGuardConfig.customOffTopicKeywords' };
    }
    next.customOffTopicKeywords = normalizeKeywords(list);
  }
  return { ok: true, value: next };
}

export function applyAIReviewConfigPatch(current: AIReviewConfig, raw: unknown): PatchResult<AIReviewConfig> {
  if (!isPlainObject(raw)) return { ok: false, field: 'aiReviewConfig' };
  const next: AIReviewConfig = { ...current };
  const target = next as unknown as Record<string, unknown>;
  const errors = [
    applyNumber(target, raw, 'sampleRate', LIMITS.sampleRate, 'aiReviewConfig.sampleRate'),
    applyNumber(target, raw, 'maxConversations', LIMITS.maxConversations, 'aiReviewConfig.maxConversations'),
    applyNumber(target, raw, 'breakerWindow', LIMITS.breakerWindow, 'aiReviewConfig.breakerWindow'),
    applyNumber(target, raw, 'breakerMinSample', LIMITS.breakerMinSample, 'aiReviewConfig.breakerMinSample'),
    applyNumber(target, raw, 'breakerThreshold', LIMITS.breakerThreshold, 'aiReviewConfig.breakerThreshold'),
  ].filter(Boolean) as string[];
  if (errors.length) return { ok: false, field: errors[0] };
  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, field: 'aiReviewConfig.enabled' };
    next.enabled = raw.enabled;
  }
  if ('runAt' in raw) {
    if (typeof raw.runAt !== 'string' || !RUN_AT_RE.test(raw.runAt)) return { ok: false, field: 'aiReviewConfig.runAt' };
    next.runAt = raw.runAt;
  }
  if (next.breakerMinSample > next.breakerWindow) return { ok: false, field: 'aiReviewConfig.breakerMinSample' };
  return { ok: true, value: next };
}
