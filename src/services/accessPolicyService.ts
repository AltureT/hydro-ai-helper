/**
 * AccessPolicyService - 按用户/用户组解析 AI 访问策略
 *
 * 优先级（逐字段）：用户策略 > 用户组策略 > 域默认（全局 AIConfig）
 * - enabled：用户策略存在时以其为准；否则任一所属组禁用即禁用
 * - dailyTokenLimit / rateLimitPerMinute：用户策略未设置时，取所属（启用的）组中最宽松的值（0 = 不限）
 * - extraTokens：用户当日追加 + 所属组当日追加的最大值
 * - 已过期（expiresAt <= now）的策略视为不存在
 *
 * 用户组复用 HydroOJ 原生域用户组（user.group 集合：{ domainId, name, uids }）。
 * 与 safetyPenaltyService（自动冷却）相互独立：这里只处理管理员的手动控制。
 */

import { db } from 'hydrooj';
import { randomUUID } from 'crypto';
import type {
  AccessPolicyPatch, AccessPolicyScope, AIAccessPolicy, AIAccessPolicyModel,
} from '../models/aiAccessPolicy';
import type { AIAccessAuditModel } from '../models/aiAccessAudit';

export type PolicySource = 'user' | 'group' | 'default';

export interface EffectiveAccess {
  enabled: boolean;
  enabledSource: PolicySource;
  /** 禁用来源（用户本身或某个组） */
  disabledBy?: { scope: AccessPolicyScope; target: number | string };
  /** undefined = 沿用域默认 budgetConfig.dailyTokenLimitPerUser；0 = 不限 */
  dailyTokenLimit?: number;
  dailyTokenLimitSource: PolicySource;
  /** 今日追加额度（已按日期过滤） */
  extraTokens: number;
  /** undefined = 沿用全局 rateLimitPerMinute；0 = 不限 */
  rateLimitPerMinute?: number;
  rateLimitSource: PolicySource;
  groups: string[];
}

export function todayUTC(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isPolicyActive(policy: AIAccessPolicy, now: Date = new Date()): boolean {
  if (!policy.expiresAt) return true;
  return new Date(policy.expiresAt).getTime() > now.getTime();
}

/** 0 表示不限，因此是最宽松的值；否则取最大值 */
function mostPermissive(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  if (values.some((v) => v === 0)) return 0;
  return Math.max(...values);
}

function extraForToday(policy: AIAccessPolicy | undefined, today: string): number {
  const grant = policy?.extraTokens;
  if (!grant || grant.date !== today) return 0;
  return Math.max(0, grant.amount || 0);
}

/**
 * 纯函数：根据用户相关的策略集合计算生效配置
 */
export function resolveEffectiveAccess(
  policies: AIAccessPolicy[],
  options: { uid: number; groups: string[]; now?: Date },
): EffectiveAccess {
  const now = options.now ?? new Date();
  const today = todayUTC(now);
  const active = policies.filter((p) => isPolicyActive(p, now));
  const userPolicy = active.find((p) => p.scope === 'user' && Number(p.target) === options.uid);
  const groupPolicies = active.filter((p) => p.scope === 'group' && options.groups.includes(String(p.target)));
  const enabledGroups = groupPolicies.filter((p) => p.enabled !== false);

  let enabled = true;
  let enabledSource: PolicySource = 'default';
  let disabledBy: EffectiveAccess['disabledBy'];
  if (userPolicy) {
    enabled = userPolicy.enabled !== false;
    enabledSource = 'user';
    if (!enabled) disabledBy = { scope: 'user', target: options.uid };
  } else {
    const disabledGroup = groupPolicies.find((p) => p.enabled === false);
    if (disabledGroup) {
      enabled = false;
      enabledSource = 'group';
      disabledBy = { scope: 'group', target: disabledGroup.target };
    } else if (enabledGroups.length > 0) {
      enabledSource = 'group';
    }
  }

  const pickNumeric = (field: 'dailyTokenLimit' | 'rateLimitPerMinute'): { value?: number; source: PolicySource } => {
    if (userPolicy && typeof userPolicy[field] === 'number') {
      return { value: userPolicy[field], source: 'user' };
    }
    const groupValue = mostPermissive(
      enabledGroups.map((p) => p[field]).filter((v): v is number => typeof v === 'number'),
    );
    if (groupValue !== undefined) return { value: groupValue, source: 'group' };
    return { value: undefined, source: 'default' };
  };

  const limit = pickNumeric('dailyTokenLimit');
  const rate = pickNumeric('rateLimitPerMinute');
  const groupExtra = enabledGroups.reduce((max, p) => Math.max(max, extraForToday(p, today)), 0);

  return {
    enabled,
    enabledSource,
    ...(disabledBy ? { disabledBy } : {}),
    dailyTokenLimit: limit.value,
    dailyTokenLimitSource: limit.source,
    extraTokens: extraForToday(userPolicy, today) + groupExtra,
    rateLimitPerMinute: rate.value,
    rateLimitSource: rate.source,
    groups: options.groups,
  };
}

export type GroupLookup = (domainId: string, uid: number) => Promise<string[]>;

/**
 * 读取 HydroOJ 原生域用户组（等价于 UserModel.listGroup，但不包含以 uid 命名的伪组）
 */
export const hydroGroupLookup: GroupLookup = async (domainId, uid) => {
  const docs = await db.collection('user.group').find({ domainId, uids: uid }).toArray();
  return docs.map((g: { name?: unknown }) => String(g.name)).filter(Boolean);
};

export interface HydroGroup {
  name: string;
  uids: number[];
}

export async function listHydroGroups(domainId: string): Promise<HydroGroup[]> {
  const docs = await db.collection('user.group').find({ domainId }).toArray();
  return docs
    .map((g: { name?: unknown; uids?: unknown }) => ({
      name: String(g.name),
      uids: Array.isArray(g.uids) ? g.uids.filter((u): u is number => typeof u === 'number') : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 请求级解析器：同一请求内对同一用户只查询一次
 */
export class AccessPolicyResolver {
  private cache = new Map<string, Promise<EffectiveAccess>>();

  constructor(
    private policyModel: Pick<AIAccessPolicyModel, 'findForUser'>,
    private groupLookup: GroupLookup = hydroGroupLookup,
  ) {}

  resolve(domainId: string, uid: number, now: Date = new Date()): Promise<EffectiveAccess> {
    const key = `${domainId}:${uid}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = (async () => {
        const groups = await this.groupLookup(domainId, uid);
        const policies = await this.policyModel.findForUser(domainId, uid, groups);
        return resolveEffectiveAccess(policies, { uid, groups, now });
      })();
      // 失败的查询不缓存，避免同一请求内重试时拿到旧的 rejection
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
    }
    return pending;
  }
}

// ─── 管理端写操作（策略 + 审计） ───────────────────────────────────────────

export const ACCESS_LIMITS = {
  maxDailyTokenLimit: 1_000_000_000,
  maxExtraTokens: 100_000_000,
  maxRateLimitPerMinute: 600,
  maxReasonLength: 200,
  maxGroupNameLength: 100,
} as const;

export interface AccessPolicyInput {
  enabled?: unknown;
  dailyTokenLimit?: unknown;
  extraTokensToday?: unknown;
  rateLimitPerMinute?: unknown;
  expiresAt?: unknown;
  reason?: unknown;
}

export type ParsePatchResult =
  | { ok: true; patch: AccessPolicyPatch }
  | { ok: false; field: string };

function parseOptionalInt(value: unknown, max: number): number | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) return false;
  return n;
}

/**
 * 校验并转换管理端提交的策略字段。
 * extraTokensToday 只设置当天（UTC）的追加额度，0 或 null 清除。
 */
export function parseAccessPolicyInput(input: AccessPolicyInput, now: Date = new Date()): ParsePatchResult {
  const patch: AccessPolicyPatch = {};

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, field: 'enabled' };
    patch.enabled = input.enabled;
  }

  const limit = parseOptionalInt(input.dailyTokenLimit, ACCESS_LIMITS.maxDailyTokenLimit);
  if (limit === false) return { ok: false, field: 'dailyTokenLimit' };
  if (limit !== undefined) patch.dailyTokenLimit = limit;

  const rate = parseOptionalInt(input.rateLimitPerMinute, ACCESS_LIMITS.maxRateLimitPerMinute);
  if (rate === false) return { ok: false, field: 'rateLimitPerMinute' };
  if (rate !== undefined) patch.rateLimitPerMinute = rate;

  const extra = parseOptionalInt(input.extraTokensToday, ACCESS_LIMITS.maxExtraTokens);
  if (extra === false) return { ok: false, field: 'extraTokensToday' };
  if (extra !== undefined) {
    patch.extraTokens = extra ? { date: todayUTC(now), amount: extra } : null;
  }

  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null || input.expiresAt === '') {
      patch.expiresAt = null;
    } else {
      const d = new Date(input.expiresAt as string);
      if (typeof input.expiresAt !== 'string' || Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) {
        return { ok: false, field: 'expiresAt' };
      }
      patch.expiresAt = d;
    }
  }

  if (input.reason !== undefined) {
    if (input.reason === null || input.reason === '') {
      patch.reason = null;
    } else if (typeof input.reason !== 'string' || input.reason.length > ACCESS_LIMITS.maxReasonLength) {
      return { ok: false, field: 'reason' };
    } else {
      patch.reason = input.reason.trim();
    }
  }

  return { ok: true, patch };
}

export interface AccessPolicyWriter {
  policyModel: Pick<AIAccessPolicyModel, 'upsert' | 'delete'>;
  auditModel: Pick<AIAccessAuditModel, 'record'>;
}

export async function upsertPolicyWithAudit(
  models: AccessPolicyWriter,
  params: {
    domainId: string;
    scope: AccessPolicyScope;
    target: number | string;
    patch: AccessPolicyPatch;
    operatorUid: number;
    batchId?: string;
  },
): Promise<AIAccessPolicy | null> {
  const { before, after } = await models.policyModel.upsert(
    params.domainId, params.scope, params.target, params.patch, params.operatorUid,
  );
  await models.auditModel.record({
    domainId: params.domainId,
    scope: params.scope,
    target: params.target,
    action: 'upsert',
    before,
    after,
    operatorUid: params.operatorUid,
    batchId: params.batchId,
  });
  return after;
}

export async function deletePolicyWithAudit(
  models: AccessPolicyWriter,
  params: {
    domainId: string;
    scope: AccessPolicyScope;
    target: number | string;
    operatorUid: number;
    batchId?: string;
  },
): Promise<boolean> {
  const before = await models.policyModel.delete(params.domainId, params.scope, params.target);
  if (!before) return false;
  await models.auditModel.record({
    domainId: params.domainId,
    scope: params.scope,
    target: params.target,
    action: 'delete',
    before,
    after: null,
    operatorUid: params.operatorUid,
    batchId: params.batchId,
  });
  return true;
}

export function newBatchId(): string {
  return randomUUID();
}
