/**
 * QuotaService - 每日 AI 次数（US2）
 *
 * 解析有效额度 → 预占 → 确认 / 退还，并提供学生端状态。
 * 额度组、个人覆盖、信誉系数通过 QuotaPolicySources 接入（PR3 / PR4），本版本只有全局默认。
 */

import { randomUUID } from 'crypto';
import type { AIConfig, AIConfigModel } from '../models/aiConfig';
import { normalizeQuotaConfig, type QuotaConfig } from '../models/configSections';
import { QuotaUsageModel } from '../models/quotaUsage';
import { dateKey, nextResetAt } from '../utils/timezone';
import {
  defaultLimitFromConfig,
  effective,
  resolveBase,
  type QuotaBaseSource,
  type QuotaLimit,
  type QuotaOverrideInput,
} from './quotaPolicy';

const MIN_RESERVATION_TTL_MS = 10 * 60 * 1000;

/** 额度来源的接入点：后续版本提供额度组、个人覆盖与信誉系数 */
export interface QuotaPolicySources {
  getOverride?(uid: number, now: Date): Promise<QuotaOverrideInput | null>;
  getGroupLimits?(uid: number): Promise<{ grants: number[]; caps: number[] }>;
  getCreditMultiplier?(uid: number, now: Date): Promise<number>;
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

export interface QuotaSnapshot {
  limit: QuotaLimit;
  used: number;
  remaining: number | null;
  resetAt: string;
}

export interface QuotaStatus extends QuotaSnapshot {
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

  /** 解析用户当前的有效额度；传入已读取的配置可省去一次查询 */
  async resolve(uid: number, config?: AIConfig | null): Promise<ResolvedQuota> {
    const cfg = config === undefined ? await this.configModel.getConfig() : config;
    const quotaConfig = normalizeQuotaConfig(cfg?.quotaConfig);
    const now = this.clock();
    const [override, groups, m] = await Promise.all([
      this.sources.getOverride ? this.sources.getOverride(uid, now) : Promise.resolve(null),
      this.sources.getGroupLimits ? this.sources.getGroupLimits(uid) : Promise.resolve({ grants: [], caps: [] }),
      this.sources.getCreditMultiplier ? this.sources.getCreditMultiplier(uid, now) : Promise.resolve(1),
    ]);
    const { base, source, capped } = resolveBase(
      override, groups.grants, groups.caps, defaultLimitFromConfig(quotaConfig.dailyMessageLimit), now,
    );
    return {
      limit: effective(base, m, quotaConfig.guaranteeCount),
      base,
      source,
      capped,
      m,
      quotaConfig,
      timeoutSeconds: cfg?.timeoutSeconds || 30,
    };
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
      disabled: resolved.base === 0,
      timezone: tz,
    };
  }
}
