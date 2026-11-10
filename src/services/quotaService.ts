/**
 * QuotaService - 每日 AI 次数（US2、US3）
 *
 * 解析有效额度 → 预占 → 确认 / 退还，并提供学生端状态与管理端的额度来源说明（explain）。
 * 额度组、个人覆盖、信誉系数通过 QuotaPolicySources 接入。
 */

import { randomUUID } from 'crypto';
import type { AIConfig, AIConfigModel } from '../models/aiConfig';
import { normalizeQuotaConfig, type QuotaConfig } from '../models/configSections';
import { QuotaUsageModel } from '../models/quotaUsage';
import { dateKey, nextResetAt } from '../utils/timezone';
import {
  defaultLimitFromConfig,
  effective,
  explainBase,
  isOverrideActive,
  type QuotaBaseSource,
  type QuotaLimit,
  type QuotaOverrideInput,
} from './quotaPolicy';
import type { QuotaGroupMembership } from './quotaGroupResolver';

const MIN_RESERVATION_TTL_MS = 10 * 60 * 1000;

export interface QuotaOverrideDetail extends QuotaOverrideInput {
  reason?: string;
  setBy?: number;
  setAt?: Date;
}

/** 额度来源的接入点：额度组与个人覆盖（QuotaGroupResolver），信誉系数（CreditService） */
export interface QuotaPolicySources {
  getOverride?(uid: number, now: Date): Promise<QuotaOverrideDetail | null>;
  getOverrides?(uids: number[], now: Date): Promise<Map<number, QuotaOverrideDetail>>;
  getGroupMemberships?(uid: number): Promise<QuotaGroupMembership[]>;
  getCreditMultiplier?(uid: number, now: Date): Promise<number>;
  getCreditMultipliers?(uids: number[], now: Date): Promise<Map<number, number>>;
}

export interface ResolvedQuota {
  limit: QuotaLimit;
  base: QuotaLimit;
  source: QuotaBaseSource;
  capped: boolean;
  m: number;
  quotaConfig: QuotaConfig;
  timeoutSeconds: number;
}

/** 管理端看到的额度来源（FR-026） */
export interface QuotaExplanation {
  /** 当日有效额度 */
  limit: QuotaLimit;
  base: QuotaLimit;
  source: QuotaBaseSource;
  capped: boolean;
  /** base === 0：AI 被管理员关闭 */
  disabled: boolean;
  defaultLimit: QuotaLimit;
  guaranteeCount: number;
  m: number;
  override: (QuotaOverrideDetail & { active: boolean }) | null;
  /** 所属的全部额度组；applied 表示该组决定了结果（授予型取最大 / 限制型取最小） */
  groups: Array<QuotaGroupMembership & { applied: boolean }>;
}

export interface QuotaUserQuota extends QuotaExplanation {
  used: number;
  remaining: number | null;
  resetAt: string;
  timezone: string;
}

export interface QuotaSnapshot {
  limit: QuotaLimit;
  used: number;
  remaining: number | null;
  resetAt: string;
}

export interface QuotaStatus extends QuotaSnapshot {
  /** 信誉系数换算前的基础额度：与 limit 不同时说明额度因违规降低 */
  base: QuotaLimit;
  /** 管理员禁用（基础额度为 0），与“额度用完”区分 */
  disabled: boolean;
  timezone: string;
}

export interface QuotaReservation {
  uid: number;
  date: string;
  /** 不限额时为 null（不预占） */
  id: string | null;
  limit: QuotaLimit;
  resetAt: Date;
  settled: boolean;
}

export type ReserveResult =
  | { ok: true; reservation: QuotaReservation }
  | { ok: false; code: 'AI_DISABLED_BY_ADMIN' }
  | { ok: false; code: 'QUOTA_EXHAUSTED'; limit: number; used: number; resetAt: Date };

function snapshot(limit: QuotaLimit, used: number, resetAt: Date): QuotaSnapshot {
  return {
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetAt: resetAt.toISOString(),
  };
}

export class QuotaService {
  constructor(
    private readonly usage: QuotaUsageModel,
    private readonly configModel: Pick<AIConfigModel, 'getConfig'>,
    private readonly sources: QuotaPolicySources = {},
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private memberships(uid: number): Promise<QuotaGroupMembership[]> {
    return this.sources.getGroupMemberships ? this.sources.getGroupMemberships(uid) : Promise.resolve([]);
  }

  private multiplier(uid: number, now: Date): Promise<number> {
    return this.sources.getCreditMultiplier ? this.sources.getCreditMultiplier(uid, now) : Promise.resolve(1);
  }

  private build(
    override: QuotaOverrideDetail | null,
    groups: QuotaGroupMembership[],
    m: number,
    quotaConfig: QuotaConfig,
    now: Date,
  ): QuotaExplanation {
    const defaultLimit = defaultLimitFromConfig(quotaConfig.dailyMessageLimit);
    const result = explainBase(override, groups, defaultLimit, now);
    return {
      limit: effective(result.base, m, quotaConfig.guaranteeCount),
      base: result.base,
      source: result.source,
      capped: result.capped,
      disabled: result.base === 0,
      defaultLimit,
      guaranteeCount: quotaConfig.guaranteeCount,
      m,
      override: override ? { ...override, active: isOverrideActive(override, now) } : null,
      groups: groups.map((group) => ({
        ...group,
        applied: group.id === result.grantGroupId || group.id === result.capGroupId,
      })),
    };
  }

  /** 解析用户当前的有效额度；传入已读取的配置可省去一次查询 */
  async resolve(uid: number, config?: AIConfig | null): Promise<ResolvedQuota> {
    const cfg = config === undefined ? await this.configModel.getConfig() : config;
    const quotaConfig = normalizeQuotaConfig(cfg?.quotaConfig);
    const now = this.clock();
    const [override, groups, m] = await Promise.all([
      this.sources.getOverride ? this.sources.getOverride(uid, now) : Promise.resolve(null),
      this.memberships(uid),
      this.multiplier(uid, now),
    ]);
    const explained = this.build(override, groups, m, quotaConfig, now);
    return {
      limit: explained.limit,
      base: explained.base,
      source: explained.source,
      capped: explained.capped,
      m,
      quotaConfig,
      timeoutSeconds: cfg?.timeoutSeconds || 30,
    };
  }

  /** 管理端：一个用户的有效额度、来源与今日用量（FR-026） */
  async explain(uid: number): Promise<QuotaUserQuota> {
    const result = await this.explainMany([uid]);
    return result.get(uid) as QuotaUserQuota;
  }

  /** 管理端批量版本（学生总览一页最多 50 人）：覆盖与用量各一次批量查询 */
  async explainMany(uids: number[]): Promise<Map<number, QuotaUserQuota>> {
    const out = new Map<number, QuotaUserQuota>();
    if (!uids.length) return out;
    const cfg = await this.configModel.getConfig();
    const quotaConfig = normalizeQuotaConfig(cfg?.quotaConfig);
    const now = this.clock();
    const tz = quotaConfig.timezone;
    const date = dateKey(tz, now);
    const resetAt = nextResetAt(tz, now).toISOString();

    const overridesPromise: Promise<Map<number, QuotaOverrideDetail>> = this.sources.getOverrides
      ? this.sources.getOverrides(uids, now)
      : Promise.all(uids.map(async (uid) => [uid, this.sources.getOverride ? await this.sources.getOverride(uid, now) : null] as const))
        .then((pairs) => new Map(pairs.filter((pair): pair is readonly [number, QuotaOverrideDetail] => !!pair[1])));
    const multipliersPromise: Promise<Map<number, number>> = this.sources.getCreditMultipliers
      ? this.sources.getCreditMultipliers(uids, now)
      : Promise.all(uids.map(async (uid) => [uid, await this.multiplier(uid, now)] as const)).then((pairs) => new Map(pairs));
    const [overrides, usage, perUser, multipliers] = await Promise.all([
      overridesPromise,
      this.usage.getMany(uids, date),
      Promise.all(uids.map(async (uid) => ({ uid, groups: await this.memberships(uid) }))),
      multipliersPromise,
    ]);
    for (const { uid, groups } of perUser) {
      const m = multipliers.get(uid) ?? 1;
      const explained = this.build(overrides.get(uid) || null, groups, m, quotaConfig, now);
      const used = usage.get(uid)?.used ?? 0;
      out.set(uid, {
        ...explained,
        used,
        remaining: explained.limit === null ? null : Math.max(0, explained.limit - used),
        resetAt,
        timezone: tz,
      });
    }
    return out;
  }

  /** 请求开始时预占一次；被拒时不留下任何数据 */
  async reserve(uid: number, config?: AIConfig | null): Promise<ReserveResult> {
    const resolved = await this.resolve(uid, config);
    const now = this.clock();
    const tz = resolved.quotaConfig.timezone;
    const date = dateKey(tz, now);
    const resetAt = nextResetAt(tz, now);

    if (resolved.base === 0) return { ok: false, code: 'AI_DISABLED_BY_ADMIN' };
    if (resolved.limit === null) {
      return { ok: true, reservation: { uid, date, id: null, limit: null, resetAt, settled: false } };
    }

    const id = randomUUID();
    const ttlMs = Math.max(MIN_RESERVATION_TTL_MS, resolved.timeoutSeconds * 2 * 1000);
    const reserved = await this.usage.reserve(uid, date, resolved.limit, id, new Date(now.getTime() - ttlMs), now);
    if (!reserved) {
      const doc = await this.usage.get(uid, date);
      return { ok: false, code: 'QUOTA_EXHAUSTED', limit: resolved.limit, used: doc?.used ?? resolved.limit, resetAt };
    }
    return { ok: true, reservation: { uid, date, id, limit: resolved.limit, resetAt, settled: false } };
  }

  /** 成功拿到 AI 回复后确认计次（幂等），返回最新用量 */
  async confirm(reservation: QuotaReservation | null | undefined): Promise<QuotaSnapshot | null> {
    if (!reservation || reservation.settled) return null;
    reservation.settled = true;
    const now = this.clock();
    const used = reservation.id
      ? await this.usage.confirm(reservation.uid, reservation.date, reservation.id, now)
      : await this.usage.increment(reservation.uid, reservation.date, now);
    return snapshot(reservation.limit, used, reservation.resetAt);
  }

  /** 未确认的预占在请求结束时退还（幂等） */
  async release(reservation: QuotaReservation | null | undefined): Promise<void> {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    if (reservation.id) await this.usage.release(reservation.uid, reservation.date, reservation.id);
  }

  /** 学生端状态：今日上限、已用、剩余、重置时间、是否被管理员关闭 */
  async status(uid: number): Promise<QuotaStatus> {
    const resolved = await this.resolve(uid);
    const now = this.clock();
    const tz = resolved.quotaConfig.timezone;
    const doc = await this.usage.get(uid, dateKey(tz, now));
    return {
      ...snapshot(resolved.limit, doc?.used ?? 0, nextResetAt(tz, now)),
      base: resolved.base,
      disabled: resolved.base === 0,
      timezone: tz,
    };
  }
}
