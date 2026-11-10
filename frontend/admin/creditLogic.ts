/**
 * 信誉规则与信誉记录的前端纯逻辑（不依赖 React / i18n，可单元测试）
 * 计算规则与服务端 creditMath 一致：扣分 = 基础分 × 2^(k−1)，单次不超过上限；系数不低于下限；每天线性恢复。
 */

export type CreditCategory = 'off_topic' | 'answer_seeking' | 'prompt_injection' | 'prompt_exfiltration' | 'obfuscated_injection';

export const CREDIT_CATEGORIES: CreditCategory[] = [
  'off_topic', 'answer_seeking', 'prompt_injection', 'prompt_exfiltration', 'obfuscated_injection',
];

export interface CreditRules {
  floor: number;
  recoveryPerDay: number;
  escalationWindowMinutes: number;
  maxDeduction: number;
  weights: Record<CreditCategory, number>;
}

export const DEFAULT_CREDIT_RULES: CreditRules = {
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

/** 表单里的文本值 */
export interface CreditRulesForm {
  floor: string;
  recoveryPerDay: string;
  escalationWindowMinutes: string;
  maxDeduction: string;
  weights: Record<CreditCategory, string>;
}

export type CreditRulesField = 'floor' | 'recoveryPerDay' | 'escalationWindowMinutes' | 'maxDeduction' | `weights.${CreditCategory}`;

export function rulesToForm(rules: CreditRules): CreditRulesForm {
  const weights = {} as Record<CreditCategory, string>;
  for (const category of CREDIT_CATEGORIES) weights[category] = String(rules.weights[category]);
  return {
    floor: String(rules.floor),
    recoveryPerDay: String(rules.recoveryPerDay),
    escalationWindowMinutes: String(rules.escalationWindowMinutes),
    maxDeduction: String(rules.maxDeduction),
    weights,
  };
}

function parseFraction(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 1 ? value : null;
}

/** 校验表单；有错时返回出错的字段（与服务端 applyQuotaConfigPatch 的范围一致） */
export function parseRulesForm(form: CreditRulesForm): { ok: true; rules: CreditRules } | { ok: false; errors: CreditRulesField[] } {
  const errors: CreditRulesField[] = [];
  const floor = parseFraction(form.floor);
  const recoveryPerDay = parseFraction(form.recoveryPerDay);
  const maxDeduction = parseFraction(form.maxDeduction);
  const windowText = form.escalationWindowMinutes.trim();
  const escalationWindowMinutes = /^\d+$/.test(windowText) ? Number(windowText) : NaN;
  if (floor === null) errors.push('floor');
  if (recoveryPerDay === null) errors.push('recoveryPerDay');
  if (maxDeduction === null) errors.push('maxDeduction');
  if (!Number.isInteger(escalationWindowMinutes) || escalationWindowMinutes < 1 || escalationWindowMinutes > 1440) {
    errors.push('escalationWindowMinutes');
  }
  const weights = {} as Record<CreditCategory, number>;
  for (const category of CREDIT_CATEGORIES) {
    const value = parseFraction(form.weights[category]);
    if (value === null) errors.push(`weights.${category}`);
    else weights[category] = value;
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    rules: {
      floor: floor as number,
      recoveryPerDay: recoveryPerDay as number,
      escalationWindowMinutes,
      maxDeduction: maxDeduction as number,
      weights,
    },
  };
}

export function sameRules(a: CreditRules, b: CreditRules): boolean {
  return a.floor === b.floor && a.recoveryPerDay === b.recoveryPerDay
    && a.escalationWindowMinutes === b.escalationWindowMinutes && a.maxDeduction === b.maxDeduction
    && CREDIT_CATEGORIES.every((category) => a.weights[category] === b.weights[category]);
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface CreditExample {
  base: number;
  deductions: number[];
  m: number;
  daily: number;
  /** 约几天后恢复满额；每日恢复为 0 时为 null */
  recoveryDays: number | null;
}

/**
 * 设计稿“按当前设置举例”：窗口内连续 3 次偏题违规后的系数、当日次数与恢复天数。
 * 示例按同一时刻计算，不计窗口内的少量恢复。
 */
export function creditExample(rules: CreditRules, base: number, guarantee: number, count = 3): CreditExample {
  const deductions = Array.from({ length: count }, (_, i) => round(Math.min(rules.maxDeduction, rules.weights.off_topic * 2 ** i)));
  const maxGap = Math.max(0, 1 - rules.floor);
  const gap = Math.min(maxGap, deductions.reduce((sum, value) => sum + value, 0));
  const m = round(1 - gap);
  const floorCount = Math.floor(base * m + 1e-9);
  const daily = base <= 0 ? 0 : Math.min(base, Math.max(guarantee, floorCount));
  return {
    base,
    deductions,
    m,
    daily,
    recoveryDays: gap <= 0 ? 0 : rules.recoveryPerDay > 0 ? Math.ceil(round(gap / rules.recoveryPerDay, 6)) : null,
  };
}

/** “约 N 天后恢复满额”的天数：向上取整，至少 1 */
export function recoveryDaysFrom(recoveryAt: string | null, now: Date = new Date()): number | null {
  if (!recoveryAt) return null;
  const ms = new Date(recoveryAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/** 系数的显示：两位小数，去掉多余的 0 */
export function formatMultiplier(m: number): string {
  return String(Math.round(m * 100) / 100);
}
