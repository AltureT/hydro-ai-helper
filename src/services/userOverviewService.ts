/**
 * UserOverviewService - 跨域学生总览（US6，FR-050–FR-054）与用户详情（FR-026）
 *
 * 仅系统管理员可用（处理器校验）。只返回统计与成员信息，不返回对话原文或安全记录的命中片段。
 *
 * 筛选思路：先由“所属域 / 小组 / 额度组 / 状态”各自得到候选 uid，取交集后再查 user 集合；
 * 需要按有效额度判断的状态（已用完、≥80%、AI 已关闭）只在候选集上计算后分页。
 */

import type { Collection, Db } from 'mongodb';
import { PRIV } from 'hydrooj';
import { domainUserColl, groupColl, memberFilter } from '../utils/hydroCompat';
import { dateKey } from '../utils/timezone';
import { normalizeQuotaConfig } from '../models/configSections';
import type { AIConfigModel } from '../models/aiConfig';
import type { QuotaUsageModel } from '../models/quotaUsage';
import type { QuotaOverrideModel } from '../models/quotaOverride';
import { GroupServiceError, MAX_REGEX_LENGTH, SEARCH_MAX_TIME_MS } from './hydroGroupService';
import type { QuotaGroupResolver } from './quotaGroupResolver';
import type { QuotaService, QuotaUserQuota } from './quotaService';
import type { CreditEventView, CreditSummary } from './creditService';

export const OVERVIEW_PAGE_SIZE = 50;
/** 需要逐个计算有效额度的筛选最多检查这么多人，超出时提示缩小范围 */
export const OVERVIEW_SCAN_MAX = 5000;
const VIOLATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DETAIL_VIOLATIONS_LIMIT = 10;
const HIGH_USAGE_RATIO = 0.8;

export type OverviewStatus = 'exhausted' | 'high_usage' | 'credit_reduced' | 'disabled' | 'violations';
export const OVERVIEW_STATUSES: readonly OverviewStatus[] = ['exhausted', 'high_usage', 'credit_reduced', 'disabled', 'violations'];

/** 信誉系数的来源（CreditService）；未接入时总览不显示信誉 */
export interface CreditOverviewSource {
  getSummaries(uids: number[], now: Date): Promise<Map<number, CreditSummary>>;
  reducedUids(candidates: number[] | undefined, now: Date): Promise<number[]>;
  detail(uid: number, now: Date): Promise<CreditSummary & { events: CreditEventView[] }>;
}

export interface OverviewCredit {
  m: number;
  reduced: boolean;
  recoveryAt: string | null;
}

export interface OverviewFilters {
  q?: string;
  mode?: 'prefix' | 'regex';
  domainId?: string;
  group?: string;
  quotaGroupId?: string;
  status?: OverviewStatus;
  page?: number;
}

export interface OverviewQuota {
  limit: number | null;
  used: number;
  remaining: number | null;
  disabled: boolean;
  source: QuotaUserQuota['source'];
  capped: boolean;
  override: { mode: 'limit' | 'disabled'; dailyLimit?: number } | null;
  /** 启用中、且决定了结果的额度组 */
  appliedGroups: Array<{ id: string; name: string; mode: 'grant' | 'cap'; dailyLimit: number }>;
  /** 所属的全部额度组（含停用的） */
  groupCount: number;
}

export interface OverviewRow {
  uid: number;
  uname: string;
  domains: Array<{ id: string; name: string }>;
  groups: Array<{ domainId: string; name: string }>;
  quota: OverviewQuota;
  credit: OverviewCredit | null;
  violations7d: number;
}

export interface OverviewResult {
  rows: OverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** 候选人数超过扫描上限，结果只覆盖前 OVERVIEW_SCAN_MAX 人 */
  truncated: boolean;
}

export interface UserDetailViolation {
  id: string;
  category?: string;
  domainId?: string;
  domainName?: string;
  actionTaken?: string;
  reviewStatus?: string;
  createdAt: string;
}

export interface UserDetail {
  uid: number;
  uname: string;
  domains: Array<{ id: string; name: string }>;
  groups: Array<{ domainId: string; domainName: string; name: string }>;
  quota: QuotaUserQuota & { overrideSetByName?: string };
  violations7d: number;
  recentViolations: UserDetailViolation[];
  credit: (OverviewCredit & {
    events: Array<CreditEventView & { domainName?: string; actorName?: string; revokedByName?: string }>;
  }) | null;
}

interface UserDocLite {
  _id: number;
  uname: string;
  unameLower?: string;
  priv?: number;
}

interface SafetyLogLite {
  _id: { toString(): string };
  userId?: number;
  domainId?: string;
  category?: string;
  actionTaken?: string;
  reviewStatus?: string;
  createdAt: Date;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function intersect(current: Set<number> | null, next: Iterable<number>): Set<number> {
  const incoming = new Set(next);
  if (!current) return incoming;
  return new Set([...current].filter((uid) => incoming.has(uid)));
}

function isMaxTimeError(err: unknown): boolean {
  const e = err as { code?: unknown; codeName?: unknown } | null;
  return !!e && (e.code === 50 || e.codeName === 'MaxTimeMSExpired');
}

function toOverviewQuota(quota: QuotaUserQuota): OverviewQuota {
  return {
    limit: quota.limit,
    used: quota.used,
    remaining: quota.remaining,
    disabled: quota.disabled,
    source: quota.source,
    capped: quota.capped,
    override: quota.override?.active
      ? { mode: quota.override.mode, ...(quota.override.mode === 'limit' ? { dailyLimit: quota.override.dailyLimit } : {}) }
      : null,
    appliedGroups: quota.groups
      .filter((group) => group.applied)
      .map((group) => ({ id: group.id, name: group.name, mode: group.mode, dailyLimit: group.dailyLimit })),
    groupCount: quota.groups.length,
  };
}

function matchesStatus(quota: QuotaUserQuota, status: OverviewStatus): boolean {
  if (status === 'disabled') return quota.disabled;
  if (quota.disabled || quota.limit === null || quota.limit <= 0) return false;
  if (status === 'exhausted') return quota.used >= quota.limit;
  if (status === 'high_usage') return quota.used >= quota.limit * HIGH_USAGE_RATIO;
  return true;
}

export class UserOverviewService {
  private readonly users: Collection<UserDocLite>;
  private readonly domains: Collection<{ _id: string; name?: string }>;
  private readonly safetyLogs: Collection<SafetyLogLite>;

  constructor(
    private readonly db: Db,
    private readonly quotaService: QuotaService,
    private readonly resolver: QuotaGroupResolver,
    private readonly overrides: QuotaOverrideModel,
    private readonly usage: QuotaUsageModel,
    private readonly configModel: Pick<AIConfigModel, 'getConfig'>,
    private readonly clock: () => Date = () => new Date(),
    private readonly credit?: CreditOverviewSource,
  ) {
    this.users = db.collection<UserDocLite>('user');
    this.domains = db.collection<{ _id: string; name?: string }>('domain');
    this.safetyLogs = db.collection<SafetyLogLite>('ai_jailbreak_logs');
  }

  private async domainNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const docs = await this.domains.find({ _id: { $in: ids } }, { projection: { _id: 1, name: 1 } }).toArray();
    return new Map(docs.map((doc) => [doc._id, doc.name || doc._id]));
  }

  private unameFilter(filters: OverviewFilters): Record<string, unknown> {
    const q = typeof filters.q === 'string' ? filters.q.trim() : '';
    if (!q) return {};
    if (filters.mode === 'regex') {
      if (q.length > MAX_REGEX_LENGTH) {
        throw new GroupServiceError('QUERY_TOO_LONG', 400, 'ai_helper_group_search_regex_too_long', [MAX_REGEX_LENGTH]);
      }
      try {
        // eslint-disable-next-line no-new
        new RegExp(q);
      } catch {
        throw new GroupServiceError('INVALID_REGEX', 400, 'ai_helper_group_search_regex_invalid');
      }
      return { uname: { $regex: q, $options: 'i' } };
    }
    return { unameLower: { $regex: `^${escapeRegex(q.toLowerCase())}` } };
  }

  /** 各筛选条件得到的候选 uid 的交集；null 表示不限 */
  private async candidates(filters: OverviewFilters, now: Date): Promise<Set<number> | null> {
    let set: Set<number> | null = null;
    if (filters.group && !filters.domainId) {
      throw new GroupServiceError('DOMAIN_REQUIRED', 400, 'ai_helper_overview_group_needs_domain');
    }
    if (filters.domainId) {
      const rows = await domainUserColl(this.db)
        .find({ domainId: filters.domainId, ...memberFilter() }, { projection: { uid: 1 } })
        .toArray();
      set = intersect(set, rows.map((row) => row.uid));
    }
    if (filters.group && filters.domainId) {
      const group = await groupColl(this.db).findOne({ domainId: filters.domainId, name: filters.group });
      set = intersect(set, group?.uids || []);
    }
    if (filters.quotaGroupId) {
      const members = await this.resolver.membersOf(filters.quotaGroupId);
      if (!members) throw new GroupServiceError('QUOTA_GROUP_NOT_FOUND', 404, 'ai_helper_quota_group_not_found');
      set = intersect(set, members);
    }
    if (filters.status === 'violations') {
      const uids = await this.safetyLogs.distinct('userId', {
        createdAt: { $gte: new Date(now.getTime() - VIOLATION_WINDOW_MS) },
        reviewStatus: { $ne: 'false_positive' },
      }) as number[];
      set = intersect(set, uids.filter((uid) => typeof uid === 'number'));
    } else if (filters.status === 'credit_reduced') {
      set = intersect(set, this.credit ? await this.credit.reducedUids(set ? [...set] : undefined, now) : []);
    } else if (filters.status === 'disabled') {
      const [overridden, zeroCap] = await Promise.all([
        this.overrides.activeUids(now, 'disabled'),
        this.resolver.zeroCapMembers(),
      ]);
      set = intersect(set, new Set([...overridden, ...zeroCap]));
    } else if (filters.status === 'exhausted' || filters.status === 'high_usage') {
      const cfg = await this.configModel.getConfig();
      const tz = normalizeQuotaConfig(cfg?.quotaConfig).timezone;
      const used = await this.usage.usersWithUsage(dateKey(tz, now));
      set = intersect(set, used.map((row) => row.uid));
    }
    return set;
  }

  async list(filters: OverviewFilters): Promise<OverviewResult> {
    const now = this.clock();
    const page = Math.max(1, Math.floor(Number(filters.page) || 1));
    const candidateSet = await this.candidates(filters, now);
    const filter: Record<string, unknown> = {
      _id: { $gt: 1 },
      priv: { $bitsAllSet: Number(PRIV.PRIV_USER_PROFILE) },
      ...this.unameFilter(filters),
    };
    if (candidateSet) {
      if (!candidateSet.size) return { rows: [], total: 0, page, pageSize: OVERVIEW_PAGE_SIZE, pageCount: 0, truncated: false };
      filter._id = { $gt: 1, $in: [...candidateSet] };
    }

    const computedStatus = filters.status && filters.status !== 'violations' && filters.status !== 'credit_reduced' ? filters.status : null;
    try {
      if (computedStatus) {
        const docs = await this.users
          .find(filter, { projection: { _id: 1, uname: 1, unameLower: 1 }, maxTimeMS: SEARCH_MAX_TIME_MS })
          .sort({ unameLower: 1 })
          .limit(OVERVIEW_SCAN_MAX + 1)
          .toArray();
        const truncated = docs.length > OVERVIEW_SCAN_MAX;
        const scanned = docs.slice(0, OVERVIEW_SCAN_MAX);
        const quotas = await this.quotaService.explainMany(scanned.map((doc) => doc._id));
        const matched = scanned.filter((doc) => {
          const quota = quotas.get(doc._id);
          return !!quota && matchesStatus(quota, computedStatus);
        });
        const pageDocs = matched.slice((page - 1) * OVERVIEW_PAGE_SIZE, page * OVERVIEW_PAGE_SIZE);
        return {
          rows: await this.annotate(pageDocs, now, quotas),
          total: matched.length,
          page,
          pageSize: OVERVIEW_PAGE_SIZE,
          pageCount: Math.ceil(matched.length / OVERVIEW_PAGE_SIZE),
          truncated,
        };
      }
      const [total, docs] = await Promise.all([
        this.users.countDocuments(filter, { maxTimeMS: SEARCH_MAX_TIME_MS }),
        this.users
          .find(filter, { projection: { _id: 1, uname: 1, unameLower: 1 }, maxTimeMS: SEARCH_MAX_TIME_MS })
          .sort({ unameLower: 1 })
          .skip((page - 1) * OVERVIEW_PAGE_SIZE)
          .limit(OVERVIEW_PAGE_SIZE)
          .toArray(),
      ]);
      return {
        rows: await this.annotate(docs, now),
        total,
        page,
        pageSize: OVERVIEW_PAGE_SIZE,
        pageCount: Math.ceil(total / OVERVIEW_PAGE_SIZE),
        truncated: false,
      };
    } catch (err) {
      if (isMaxTimeError(err)) throw new GroupServiceError('SEARCH_TIMEOUT', 400, 'ai_helper_group_search_timeout');
      throw err;
    }
  }

  private async membership(uids: number[]) {
    const [rows, groups] = await Promise.all([
      domainUserColl(this.db).find({ uid: { $in: uids }, ...memberFilter() }, { projection: { uid: 1, domainId: 1 } }).toArray(),
      groupColl(this.db).find({ uids: { $in: uids } }, { projection: { domainId: 1, name: 1, uids: 1 } }).toArray(),
    ]);
    const names = await this.domainNames([...new Set([...rows.map((row) => row.domainId), ...groups.map((group) => group.domainId)])]);
    const domainsByUid = new Map<number, Array<{ id: string; name: string }>>();
    for (const row of rows) {
      const list = domainsByUid.get(row.uid) || [];
      list.push({ id: row.domainId, name: names.get(row.domainId) || row.domainId });
      domainsByUid.set(row.uid, list);
    }
    const wanted = new Set(uids);
    const groupsByUid = new Map<number, Array<{ domainId: string; domainName: string; name: string }>>();
    for (const group of groups) {
      if (/^\d+$/.test(group.name)) continue; // Hydro 内部的“作业组”以数字命名，不展示
      for (const uid of group.uids || []) {
        if (!wanted.has(uid)) continue;
        const list = groupsByUid.get(uid) || [];
        list.push({ domainId: group.domainId, domainName: names.get(group.domainId) || group.domainId, name: group.name });
        groupsByUid.set(uid, list);
      }
    }
    return { domainsByUid, groupsByUid };
  }

  private async violationCounts(uids: number[], now: Date): Promise<Map<number, number>> {
    const docs = await this.safetyLogs
      .find(
        { userId: { $in: uids }, createdAt: { $gte: new Date(now.getTime() - VIOLATION_WINDOW_MS) }, reviewStatus: { $ne: 'false_positive' } },
        { projection: { userId: 1 } },
      )
      .limit(20000)
      .toArray();
    const counts = new Map<number, number>();
    for (const doc of docs) {
      if (typeof doc.userId === 'number') counts.set(doc.userId, (counts.get(doc.userId) || 0) + 1);
    }
    return counts;
  }

  private async annotate(docs: UserDocLite[], now: Date, known?: Map<number, QuotaUserQuota>): Promise<OverviewRow[]> {
    if (!docs.length) return [];
    const uids = docs.map((doc) => doc._id);
    const [{ domainsByUid, groupsByUid }, quotas, violations, credits] = await Promise.all([
      this.membership(uids),
      known ? Promise.resolve(known) : this.quotaService.explainMany(uids),
      this.violationCounts(uids, now),
      this.credit ? this.credit.getSummaries(uids, now) : Promise.resolve(null),
    ]);
    return docs.map((doc) => {
      const quota = quotas.get(doc._id) as QuotaUserQuota;
      return {
        uid: doc._id,
        uname: doc.uname,
        domains: (domainsByUid.get(doc._id) || []).sort((a, b) => a.name.localeCompare(b.name)),
        groups: (groupsByUid.get(doc._id) || [])
          .map(({ domainId, name }) => ({ domainId, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        quota: toOverviewQuota(quota),
        credit: credits ? toOverviewCredit(credits.get(doc._id)) : null,
        violations7d: violations.get(doc._id) || 0,
      };
    });
  }

  /** 详情里的信誉记录：补上域名、操作人与撤销人的用户名 */
  private async creditDetail(uid: number, now: Date): Promise<UserDetail['credit']> {
    if (!this.credit) return null;
    const detail = await this.credit.detail(uid, now);
    const peopleIds = [...new Set(detail.events.flatMap((event) => [event.actorUid, event.revokedBy]).filter((id): id is number => typeof id === 'number'))];
    const [people, domainNames] = await Promise.all([
      peopleIds.length
        ? this.users.find({ _id: { $in: peopleIds } }, { projection: { _id: 1, uname: 1 } }).toArray()
        : Promise.resolve([] as UserDocLite[]),
      this.domainNames([...new Set(detail.events.map((event) => event.domainId).filter((id): id is string => !!id))]),
    ]);
    const unames = new Map(people.map((person) => [person._id, person.uname]));
    return {
      ...(toOverviewCredit(detail) as OverviewCredit),
      events: detail.events.map((event) => ({
        ...event,
        ...(event.domainId ? { domainName: domainNames.get(event.domainId) || event.domainId } : {}),
        ...(event.actorUid !== undefined ? { actorName: unames.get(event.actorUid) || String(event.actorUid) } : {}),
        ...(event.revokedBy !== undefined ? { revokedByName: unames.get(event.revokedBy) || String(event.revokedBy) } : {}),
      })),
    };
  }

  async detail(uidRaw: unknown): Promise<UserDetail> {
    const uid = typeof uidRaw === 'string' && /^\d+$/.test(uidRaw) ? Number(uidRaw) : uidRaw;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 1) {
      throw new GroupServiceError('USER_NOT_FOUND', 404, 'ai_helper_overview_user_not_found');
    }
    const user = await this.users.findOne({ _id: uid }, { projection: { _id: 1, uname: 1, priv: 1 } });
    if (!user) throw new GroupServiceError('USER_NOT_FOUND', 404, 'ai_helper_overview_user_not_found');
    const now = this.clock();
    const [{ domainsByUid, groupsByUid }, quota, violations, recent, credit] = await Promise.all([
      this.membership([uid]),
      this.quotaService.explain(uid),
      this.violationCounts([uid], now),
      this.safetyLogs
        .find(
          { userId: uid, createdAt: { $gte: new Date(now.getTime() - VIOLATION_WINDOW_MS * 4) } },
          { projection: { _id: 1, domainId: 1, category: 1, actionTaken: 1, reviewStatus: 1, createdAt: 1 } },
        )
        .sort({ createdAt: -1 })
        .limit(DETAIL_VIOLATIONS_LIMIT)
        .toArray(),
      this.creditDetail(uid, now),
    ]);
    const names = await this.domainNames([...new Set(recent.map((log) => log.domainId).filter((id): id is string => !!id))]);
    let overrideSetByName: string | undefined;
    if (quota.override?.setBy !== undefined) {
      const setter = await this.users.findOne({ _id: quota.override.setBy }, { projection: { uname: 1 } });
      overrideSetByName = setter?.uname;
    }
    return {
      uid,
      uname: user.uname,
      domains: (domainsByUid.get(uid) || []).sort((a, b) => a.name.localeCompare(b.name)),
      groups: (groupsByUid.get(uid) || []).sort((a, b) => a.name.localeCompare(b.name)),
      quota: { ...quota, ...(overrideSetByName ? { overrideSetByName } : {}) },
      violations7d: violations.get(uid) || 0,
      recentViolations: recent.map((log) => ({
        id: String(log._id),
        ...(log.category ? { category: log.category } : {}),
        ...(log.domainId ? { domainId: log.domainId, domainName: names.get(log.domainId) || log.domainId } : {}),
        ...(log.actionTaken ? { actionTaken: log.actionTaken } : {}),
        ...(log.reviewStatus ? { reviewStatus: log.reviewStatus } : {}),
        createdAt: new Date(log.createdAt).toISOString(),
      })),
      credit,
    };
  }
}

function toOverviewCredit(summary: CreditSummary | undefined): OverviewCredit {
  if (!summary) return { m: 1, reduced: false, recoveryAt: null };
  return { m: summary.m, reduced: summary.reduced, recoveryAt: summary.recoveryAt ? summary.recoveryAt.toISOString() : null };
}
