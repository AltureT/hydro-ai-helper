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

export type QuotaLimit = number | null;

export interface QuotaOverrideInput {
  mode: 'limit' | 'disabled';
  dailyLimit?: number;
  expiresAt?: Date | null;
}

export type QuotaBaseSource = 'override' | 'grant' | 'default';

export interface QuotaBaseResult {
  base: QuotaLimit;
  source: QuotaBaseSource;
  /** 限制型额度组是否降低了结果 */
  capped: boolean;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isOverrideActive(override: QuotaOverrideInput | null | undefined, now: Date): boolean {
  if (!override) return false;
  if (override.expiresAt && override.expiresAt.getTime() <= now.getTime()) return false;
  return override.mode === 'disabled' || (override.mode === 'limit' && isNonNegativeInt(override.dailyLimit));
}

/** 全局默认的配置值 0 表示不限 */
export function defaultLimitFromConfig(dailyMessageLimit: number | undefined): QuotaLimit {
  return isNonNegativeInt(dailyMessageLimit) && dailyMessageLimit > 0 ? dailyMessageLimit : null;
}

export function resolveBase(
  override: QuotaOverrideInput | null | undefined,
  grantLimits: number[],
  capLimits: number[],
  defaultLimit: QuotaLimit,
  now: Date = new Date(),
): QuotaBaseResult {
  if (override && isOverrideActive(override, now)) {
    return {
      base: override.mode === 'disabled' ? 0 : (override.dailyLimit as number),
      source: 'override',
      capped: false,
    };
  }

  const grants = grantLimits.filter(isNonNegativeInt);
  let base: QuotaLimit = grants.length ? Math.max(...grants) : defaultLimit;
  const source: QuotaBaseSource = grants.length ? 'grant' : 'default';

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

/** 参与计算的额度组（停用的组不参与） */
export interface PolicyGroup {
  id: string;
  mode: 'grant' | 'cap';
  dailyLimit: number;
  enabled: boolean;
}

export interface QuotaExplainBase extends QuotaBaseResult {
  /** 决定基础额度的授予型组（取最大的那个）；个人覆盖生效或不属于授予型组时为 null */
  grantGroupId: string | null;
  /** 压低结果的限制型组（取最小的那个）；未被限制时为 null */
  capGroupId: string | null;
}

/** resolveBase 的可解释版本：同时指出是哪个组决定了结果（FR-026） */
export function explainBase(
  override: QuotaOverrideInput | null | undefined,
  groups: PolicyGroup[],
  defaultLimit: QuotaLimit,
  now: Date = new Date(),
): QuotaExplainBase {
  const active = groups.filter((group) => group.enabled && isNonNegativeInt(group.dailyLimit));
  const grants = active.filter((group) => group.mode === 'grant');
  const caps = active.filter((group) => group.mode === 'cap');
  const result = resolveBase(
    override,
    grants.map((group) => group.dailyLimit),
    caps.map((group) => group.dailyLimit),
    defaultLimit,
    now,
  );
  if (result.source === 'override') return { ...result, grantGroupId: null, capGroupId: null };
  const grant = grants.reduce<PolicyGroup | null>((best, group) => (!best || group.dailyLimit > best.dailyLimit ? group : best), null);
  const cap = result.capped
    ? caps.reduce<PolicyGroup | null>((best, group) => (!best || group.dailyLimit < best.dailyLimit ? group : best), null)
    : null;
  return { ...result, grantGroupId: grant?.id ?? null, capGroupId: cap?.id ?? null };
}

/** 信誉系数换算当日有效额度 */
export function effective(base: QuotaLimit, m: number, guarantee: number): QuotaLimit {
  if (base === null) return null;
  if (base <= 0) return 0;
  const multiplier = Number.isFinite(m) ? Math.min(1, Math.max(0, m)) : 1;
  const floorCount = Math.floor(base * multiplier + 1e-9);
  const minimum = Math.max(0, Math.floor(guarantee));
  return Math.min(base, Math.max(minimum, floorCount));
}
