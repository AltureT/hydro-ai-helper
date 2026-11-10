/**
 * 额度组、个人覆盖、学生总览的类型与纯逻辑（不依赖 React / i18n，可单元测试）
 */

export type QuotaGroupMode = 'grant' | 'cap';
export type OverrideMode = 'limit' | 'disabled';

export interface LinkedGroupView {
  domainId: string;
  domainName: string;
  name: string;
  exists: boolean;
  memberCount: number;
}

export interface QuotaGroupView {
  id: string;
  name: string;
  mode: QuotaGroupMode;
  dailyLimit: number;
  enabled: boolean;
  directCount: number;
  linkedOnlyCount: number;
  totalCount: number;
  linkedGroups: LinkedGroupView[];
  createdAt: string;
  updatedAt: string;
}

export interface QuotaGroupsResponse {
  groups: QuotaGroupView[];
  domains: Array<{ id: string; name: string }>;
}

export interface QuotaGroupDetailResponse {
  group: QuotaGroupView;
  direct: Array<{ uid: number; uname: string }>;
}

export interface OverrideView {
  uid: number;
  uname: string;
  mode: OverrideMode;
  dailyLimit?: number;
  expiresAt?: string;
  reason: string;
  setBy: number;
  setByName: string;
  setAt: string;
}

export interface OverridesResponse {
  items: OverrideView[];
  total: number;
}

export type OverviewStatus = '' | 'exhausted' | 'high_usage' | 'disabled' | 'violations';

export interface OverviewFiltersState {
  q: string;
  mode: 'prefix' | 'regex';
  domainId: string;
  group: string;
  quotaGroupId: string;
  status: OverviewStatus;
}

export const EMPTY_OVERVIEW_FILTERS: OverviewFiltersState = {
  q: '', mode: 'prefix', domainId: '', group: '', quotaGroupId: '', status: '',
};

export interface OverviewQuota {
  limit: number | null;
  used: number;
  remaining: number | null;
  disabled: boolean;
  source: 'override' | 'grant' | 'default';
  capped: boolean;
  override: { mode: OverrideMode; dailyLimit?: number } | null;
  appliedGroups: Array<{ id: string; name: string; mode: QuotaGroupMode; dailyLimit: number }>;
  groupCount: number;
}

export interface OverviewRow {
  uid: number;
  uname: string;
  domains: Array<{ id: string; name: string }>;
  groups: Array<{ domainId: string; name: string }>;
  quota: OverviewQuota;
  violations7d: number;
}

export interface OverviewResponse {
  rows: OverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  truncated: boolean;
}

export interface QuotaGroupMembership {
  id: string;
  name: string;
  mode: QuotaGroupMode;
  dailyLimit: number;
  enabled: boolean;
  via: Array<{ kind: 'direct' } | { kind: 'linked'; domainId: string; name: string }>;
  applied: boolean;
}

export interface UserDetailResponse {
  uid: number;
  uname: string;
  domains: Array<{ id: string; name: string }>;
  groups: Array<{ domainId: string; domainName: string; name: string }>;
  quota: {
    limit: number | null;
    base: number | null;
    source: 'override' | 'grant' | 'default';
    capped: boolean;
    disabled: boolean;
    defaultLimit: number | null;
    guaranteeCount: number;
    m: number;
    used: number;
    remaining: number | null;
    resetAt: string;
    timezone: string;
    override: {
      mode: OverrideMode;
      dailyLimit?: number;
      expiresAt?: string;
      reason?: string;
      setBy?: number;
      setAt?: string;
      active: boolean;
    } | null;
    overrideSetByName?: string;
    groups: QuotaGroupMembership[];
  };
  violations7d: number;
  recentViolations: Array<{
    id: string;
    category?: string;
    domainId?: string;
    domainName?: string;
    actionTaken?: string;
    reviewStatus?: string;
    createdAt: string;
  }>;
  credit: null;
}

export const QUOTA_LIMIT_MAX = 100000;
export const QUOTA_GROUP_NAME_MAX = 32;
export const QUOTA_REASON_MAX = 200;

export type GroupFormError = 'name_required' | 'name_too_long' | 'limit_grant' | 'limit_cap';

/** 新建 / 编辑额度组的表单校验（服务端同样校验） */
export function validateGroupForm(input: { name: string; mode: QuotaGroupMode; limitText: string }): GroupFormError | null {
  const name = input.name.trim();
  if (!name) return 'name_required';
  if (name.length > QUOTA_GROUP_NAME_MAX) return 'name_too_long';
  const text = input.limitText.trim();
  const limit = /^\d+$/.test(text) ? Number(text) : NaN;
  const min = input.mode === 'grant' ? 1 : 0;
  if (!Number.isInteger(limit) || limit < min || limit > QUOTA_LIMIT_MAX) {
    return input.mode === 'grant' ? 'limit_grant' : 'limit_cap';
  }
  return null;
}

export type OverrideFormError = 'no_users' | 'limit' | 'reason_required' | 'reason_too_long' | 'expires';

export function validateOverrideForm(input: {
  uids: number[];
  mode: OverrideMode;
  limitText: string;
  reason: string;
  expiresDate: string;
}, now: Date = new Date()): OverrideFormError | null {
  if (!input.uids.length) return 'no_users';
  if (input.mode === 'limit') {
    const text = input.limitText.trim();
    const limit = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > QUOTA_LIMIT_MAX) return 'limit';
  }
  if (input.expiresDate) {
    const iso = expiresDateToIso(input.expiresDate);
    if (!iso || new Date(iso).getTime() <= now.getTime()) return 'expires';
  }
  const reason = input.reason.trim();
  if (!reason) return 'reason_required';
  if (reason.length > QUOTA_REASON_MAX) return 'reason_too_long';
  return null;
}

/** 日期输入（YYYY-MM-DD）→ 当天本地 23:59:59 的 ISO 时间；不合法时返回 null */
export function expiresDateToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1) return null;
  return date.toISOString();
}

/** ISO → 本地日期输入值 YYYY-MM-DD */
export function isoToDateInput(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type UsageTone = 'normal' | 'warn' | 'full' | 'off' | 'unlimited';

/** 今日用量的进度与颜色：≥ 80% 黄色，用完红色 */
export function usageMeter(quota: Pick<OverviewQuota, 'limit' | 'used' | 'disabled'>): { percent: number; tone: UsageTone } {
  if (quota.disabled) return { percent: 0, tone: 'off' };
  if (quota.limit === null) return { percent: 0, tone: 'unlimited' };
  if (quota.limit <= 0) return { percent: 100, tone: 'full' };
  const percent = Math.min(100, Math.round((quota.used / quota.limit) * 100));
  if (quota.used >= quota.limit) return { percent: 100, tone: 'full' };
  return { percent, tone: quota.used >= quota.limit * 0.8 ? 'warn' : 'normal' };
}

export function overviewQuery(filters: OverviewFiltersState, page: number): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) {
    params.set('q', filters.q.trim());
    params.set('mode', filters.mode);
  }
  if (filters.domainId) params.set('domainId', filters.domainId);
  if (filters.domainId && filters.group) params.set('group', filters.group);
  if (filters.quotaGroupId) params.set('quotaGroupId', filters.quotaGroupId);
  if (filters.status) params.set('status', filters.status);
  if (page > 1) params.set('page', String(page));
  return params.toString();
}

export type SelectionState = 'none' | 'some' | 'all';

/** 本页的勾选状态（用于表头复选框） */
export function pageSelectionState(rows: Array<{ uid: number }>, selected: Set<number>): SelectionState {
  if (!rows.length) return 'none';
  const count = rows.filter((row) => selected.has(row.uid)).length;
  if (!count) return 'none';
  return count === rows.length ? 'all' : 'some';
}

/** 选中的人中不是某域成员的（按总览返回的所属域判断） */
export function nonMembersOf(rows: Array<Pick<OverviewRow, 'uid' | 'domains'>>, domainId: string): number[] {
  return rows.filter((row) => !row.domains.some((domain) => domain.id === domainId)).map((row) => row.uid);
}
