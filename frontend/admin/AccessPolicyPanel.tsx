/**
 * AI 访问策略管理面板（域管理员）
 * - 用户：查看今日用量与生效额度，单独禁用/调额度/追加今日额度/调频率
 * - 用户组：复用 HydroOJ 域用户组，设置组策略或批量写入成员的用户级策略
 * - 审计：所有策略变更记录
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { buildApiUrl } from '../utils/domainUtils';
import { Toast, useToast } from '../components/Toast';
import {
  COLORS, FONT_FAMILY, RADIUS, SPACING,
  emptyStateStyle, getAlertStyle, getBadgeStyle, getButtonStyle, getInputStyle,
  getPaginationButtonStyle, getTabStyle, getTableCellStyle, getTableHeaderStyle,
  modalContentStyle, modalOverlayStyle, tableRootStyle,
} from '../utils/styles';

type Scope = 'user' | 'group';
type Source = 'user' | 'group' | 'default';
type TabType = 'users' | 'groups' | 'audit';

interface PolicyView {
  scope: Scope;
  target: number | string;
  enabled: boolean;
  dailyTokenLimit: number | null;
  extraTokens: { date: string; amount: number } | null;
  rateLimitPerMinute: number | null;
  expiresAt: string | null;
  expired: boolean;
  reason: string | null;
}

interface UserRow {
  uid: number;
  uname: string;
  groups: string[];
  usage: { totalTokens: number; requestCount: number };
  policy: PolicyView | null;
  effective: {
    enabled: boolean;
    enabledSource: Source;
    disabledBy: { scope: Scope; target: number | string } | null;
    dailyTokenLimit: number;
    dailyTokenLimitSource: Source;
    extraTokens: number;
    rateLimitPerMinute: number;
    rateLimitSource: Source;
  };
}

interface GroupRow {
  name: string;
  memberCount: number;
  policy: PolicyView | null;
}

interface AuditRow {
  id: string;
  scope: Scope;
  target: number | string;
  action: 'upsert' | 'delete';
  before: Partial<PolicyView> | null;
  after: Partial<PolicyView> | null;
  operatorName: string;
  createdAt: string;
}

interface Overview {
  today: string;
  defaults: {
    dailyTokenLimitPerUser: number;
    dailyTokenLimitPerDomain: number;
    monthlyTokenLimitPerDomain: number;
    rateLimitPerMinute: number;
  };
}

/** 编辑对象：单个用户、单个组的组策略，或对组内全部成员批量写入 */
type EditTarget =
  | { kind: 'user'; uid: number; label: string; policy: PolicyView | null }
  | { kind: 'group'; name: string; policy: PolicyView | null }
  | { kind: 'batch'; name: string; memberCount: number };

interface FormState {
  enabled: boolean;
  dailyTokenLimit: string;
  extraTokensToday: string;
  rateLimitPerMinute: string;
  expiresAt: string;
  reason: string;
}

async function requestJson<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const res = await fetch(buildApiUrl(path), {
    method: init?.method || 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error;
    throw new Error(message || `${i18n('ai_helper_access_request_failed')} (${res.status})`);
  }
  return data as T;
}

const formatTokens = (n: number) => (n === 0 ? i18n('ai_helper_access_unlimited') : n.toLocaleString());

const sourceLabel = (source: Source) => i18n(`ai_helper_access_source_${source}`);

/** datetime-local 需要本地时区的 YYYY-MM-DDTHH:mm */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initialForm(policy: PolicyView | null, today: string): FormState {
  return {
    enabled: policy ? policy.enabled : true,
    dailyTokenLimit: policy?.dailyTokenLimit != null ? String(policy.dailyTokenLimit) : '',
    extraTokensToday: policy?.extraTokens && policy.extraTokens.date === today ? String(policy.extraTokens.amount) : '',
    rateLimitPerMinute: policy?.rateLimitPerMinute != null ? String(policy.rateLimitPerMinute) : '',
    expiresAt: toLocalInput(policy?.expiresAt ?? null),
    reason: policy?.reason ?? '',
  };
}

/** 空字符串 = 清除覆盖（null），回退到上一级 */
function formToPayload(form: FormState) {
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return {
    enabled: form.enabled,
    dailyTokenLimit: num(form.dailyTokenLimit),
    extraTokensToday: num(form.extraTokensToday),
    rateLimitPerMinute: num(form.rateLimitPerMinute),
    expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    reason: form.reason.trim() || null,
  };
}

function describePolicy(policy: Partial<PolicyView> | null): string {
  if (!policy) return '—';
  const parts: string[] = [];
  parts.push(policy.enabled === false ? i18n('ai_helper_access_status_disabled') : i18n('ai_helper_access_status_enabled'));
  if (policy.dailyTokenLimit != null) parts.push(`${i18n('ai_helper_access_field_daily_limit')}: ${formatTokens(policy.dailyTokenLimit)}`);
  if (policy.extraTokens) parts.push(i18n('ai_helper_access_extra_badge', policy.extraTokens.amount.toLocaleString(), policy.extraTokens.date));
  if (policy.rateLimitPerMinute != null) parts.push(`${i18n('ai_helper_access_field_rate')}: ${policy.rateLimitPerMinute === 0 ? i18n('ai_helper_access_unlimited') : policy.rateLimitPerMinute}`);
  if (policy.expiresAt) parts.push(`${i18n('ai_helper_access_field_expires')}: ${new Date(policy.expiresAt).toLocaleString()}`);
  if (policy.reason) parts.push(`“${policy.reason}”`);
  return parts.join(' · ');
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '13px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: SPACING.xs };
const hintStyle: React.CSSProperties = { fontSize: '12px', color: COLORS.textMuted, marginTop: '2px' };
const fieldStyle: React.CSSProperties = { marginBottom: SPACING.md };

const PolicyEditor: React.FC<{
  target: EditTarget;
  today: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}> = ({ target, today, onClose, onSaved, onError }) => {
  const existing = target.kind === 'batch' ? null : target.policy;
  const [form, setForm] = useState<FormState>(() => initialForm(existing, today));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const title = target.kind === 'user'
    ? i18n('ai_helper_access_edit_user_title', target.label)
    : target.kind === 'group'
      ? i18n('ai_helper_access_edit_group_title', target.name)
      : i18n('ai_helper_access_batch_title', target.name, target.memberCount);

  const save = async () => {
    setSaving(true);
    try {
      const payload = formToPayload(form);
      if (target.kind === 'batch') {
        const res = await requestJson<{ affected: number }>('/ai-helper/admin/access/batch', {
          method: 'POST', body: { group: target.name, mode: 'apply', ...payload },
        });
        onSaved(i18n('ai_helper_access_batch_done', res.affected));
      } else {
        await requestJson('/ai-helper/admin/access/policy', {
          method: 'POST',
          body: { scope: target.kind, target: target.kind === 'user' ? target.uid : target.name, ...payload },
        });
        onSaved(i18n('ai_helper_access_saved'));
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n('ai_helper_access_request_failed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (target.kind === 'batch') return;
    setSaving(true);
    try {
      await requestJson('/ai-helper/admin/access/policy/delete', {
        method: 'POST',
        body: { scope: target.kind, target: target.kind === 'user' ? target.uid : target.name },
      });
      onSaved(i18n('ai_helper_access_removed'));
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n('ai_helper_access_request_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={modalOverlayStyle} onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ ...modalContentStyle, maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto', fontFamily: FONT_FAMILY }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: `0 0 ${SPACING.base}`, fontSize: '17px', color: COLORS.textPrimary }}>{title}</h3>
        {target.kind === 'user' && (
          <div style={{ ...getAlertStyle('info'), marginBottom: SPACING.base, fontSize: '13px' }}>
            {i18n('ai_helper_access_user_override_note')}
          </div>
        )}
        {target.kind === 'batch' && (
          <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.base, fontSize: '13px' }}>
            {i18n('ai_helper_access_batch_note')}
          </div>
        )}

        <div style={fieldStyle}>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: SPACING.sm, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            {i18n('ai_helper_access_field_enabled')}
          </label>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="ai-access-daily">{i18n('ai_helper_access_field_daily_limit')}</label>
          <input id="ai-access-daily" type="number" min={0} step={1000} style={getInputStyle()}
            placeholder={i18n('ai_helper_access_inherit')}
            value={form.dailyTokenLimit} onChange={(e) => set({ dailyTokenLimit: e.target.value })} />
          <div style={hintStyle}>{i18n('ai_helper_access_field_daily_limit_hint')}</div>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="ai-access-extra">{i18n('ai_helper_access_field_extra')}</label>
          <input id="ai-access-extra" type="number" min={0} step={1000} style={getInputStyle()}
            value={form.extraTokensToday} onChange={(e) => set({ extraTokensToday: e.target.value })} />
          <div style={hintStyle}>{i18n('ai_helper_access_field_extra_hint', today)}</div>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="ai-access-rate">{i18n('ai_helper_access_field_rate')}</label>
          <input id="ai-access-rate" type="number" min={0} step={1} style={getInputStyle()}
            placeholder={i18n('ai_helper_access_inherit')}
            value={form.rateLimitPerMinute} onChange={(e) => set({ rateLimitPerMinute: e.target.value })} />
          <div style={hintStyle}>{i18n('ai_helper_access_field_rate_hint')}</div>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="ai-access-expires">{i18n('ai_helper_access_field_expires')}</label>
          <input id="ai-access-expires" type="datetime-local" style={getInputStyle()}
            value={form.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
          <div style={hintStyle}>{i18n('ai_helper_access_field_expires_hint')}</div>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="ai-access-reason">{i18n('ai_helper_access_field_reason')}</label>
          <input id="ai-access-reason" type="text" maxLength={200} style={getInputStyle()}
            value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
          <div style={hintStyle}>{i18n('ai_helper_access_field_reason_hint')}</div>
        </div>

        <div style={{ display: 'flex', gap: SPACING.sm, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: SPACING.lg }}>
          {existing && (
            <button type="button" style={{ ...getButtonStyle('ghost'), color: COLORS.error, marginRight: 'auto' }}
              disabled={saving} onClick={remove}>
              {i18n('ai_helper_access_remove_policy')}
            </button>
          )}
          <button type="button" style={getButtonStyle('secondary')} disabled={saving} onClick={onClose}>
            {i18n('ai_helper_access_cancel')}
          </button>
          <button type="button" style={getButtonStyle('primary')} disabled={saving} onClick={save}>
            {i18n('ai_helper_access_save')}
          </button>
        </div>
      </div>
    </div>
  );
};

const StatusBadge: React.FC<{ effective: UserRow['effective'] }> = ({ effective }) => {
  if (effective.enabled) {
    return <span style={getBadgeStyle('success')}>{i18n('ai_helper_access_status_enabled')}</span>;
  }
  const title = effective.disabledBy?.scope === 'group'
    ? i18n('ai_helper_access_disabled_by_group', String(effective.disabledBy.target))
    : sourceLabel('user');
  return <span style={getBadgeStyle('error')} title={title}>{i18n('ai_helper_access_status_disabled')} · {title}</span>;
};

export const AccessPolicyPanel: React.FC<{ embedded?: boolean }> = ({ embedded }) => {
  const [tab, setTab] = useState<TabType>('users');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<{ rows: UserRow[]; total: number; page: number; pageSize: number }>({ rows: [], total: 0, page: 1, pageSize: 50 });
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [onlyPolicies, setOnlyPolicies] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const { toasts, showToast, dismissToast } = useToast();

  const today = overview?.today ?? new Date().toISOString().slice(0, 10);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await requestJson<Overview>('/ai-helper/admin/access'));
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n('ai_helper_access_request_failed'));
    }
  }, []);

  const loadGroups = useCallback(async () => {
    const res = await requestJson<{ groups: GroupRow[] }>('/ai-helper/admin/access/groups');
    setGroups(res.groups);
  }, []);

  const loadUsers = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page) });
    if (searchQuery) params.set('q', searchQuery);
    if (groupFilter) params.set('group', groupFilter);
    if (onlyPolicies) params.set('onlyPolicies', '1');
    const res = await requestJson<{ users: UserRow[]; total: number; page: number; pageSize: number }>(
      `/ai-helper/admin/access/users?${params.toString()}`,
    );
    setUsers({ rows: res.users, total: res.total, page: res.page, pageSize: res.pageSize });
  }, [page, searchQuery, groupFilter, onlyPolicies]);

  const loadAudit = useCallback(async () => {
    const res = await requestJson<{ records: AuditRow[] }>('/ai-helper/admin/access/audit?limit=100');
    setAudit(res.records);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'users') await loadUsers();
      else if (tab === 'groups') await loadGroups();
      else await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n('ai_helper_access_request_failed'));
    } finally {
      setLoading(false);
    }
  }, [tab, loadUsers, loadGroups, loadAudit]);

  useEffect(() => {
    loadOverview();
    // 用户页的组筛选下拉框需要组列表
    loadGroups().catch(() => { /* 组列表失败不阻塞用户列表 */ });
  }, [loadOverview, loadGroups]);
  // 搜索输入防抖，避免每次按键都请求
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => { refresh(); }, [refresh]);

  const clearGroupMembers = async (group: GroupRow) => {
    if (!window.confirm(i18n('ai_helper_access_batch_clear_confirm', group.memberCount, group.name))) return;
    try {
      const res = await requestJson<{ affected: number }>('/ai-helper/admin/access/batch', {
        method: 'POST', body: { group: group.name, mode: 'clear' },
      });
      showToast(i18n('ai_helper_access_batch_done', res.affected), 'success');
      refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : i18n('ai_helper_access_request_failed'), 'error');
    }
  };

  const totalPages = Math.max(1, Math.ceil(users.total / users.pageSize));
  const th = getTableHeaderStyle();
  const td = getTableCellStyle();

  return (
    <div style={{ padding: embedded ? SPACING.lg : 'clamp(12px, 3vw, 28px)', fontFamily: FONT_FAMILY, color: COLORS.textPrimary }}>
      {!embedded && <h1 style={{ margin: `0 0 ${SPACING.sm}`, fontSize: '22px', fontWeight: 650 }}>{i18n('ai_helper_access_title')}</h1>}
      <p style={{ margin: `0 0 ${SPACING.base}`, color: COLORS.textSecondary, fontSize: '14px' }}>{i18n('ai_helper_access_subtitle')}</p>

      {overview && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: SPACING.lg, padding: SPACING.md, marginBottom: SPACING.base,
          border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, background: COLORS.bgPage, fontSize: '13px',
        }}>
          <span><strong>{i18n('ai_helper_access_default_daily_user')}:</strong> {formatTokens(overview.defaults.dailyTokenLimitPerUser)}</span>
          <span><strong>{i18n('ai_helper_access_default_rate')}:</strong> {overview.defaults.rateLimitPerMinute === 0 ? i18n('ai_helper_access_unlimited') : overview.defaults.rateLimitPerMinute}</span>
          <span><strong>{i18n('ai_helper_access_default_domain_daily')}:</strong> {formatTokens(overview.defaults.dailyTokenLimitPerDomain)}</span>
          <span><strong>{i18n('ai_helper_access_default_domain_monthly')}:</strong> {formatTokens(overview.defaults.monthlyTokenLimitPerDomain)}</span>
          <span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_access_utc_note', overview.today)}</span>
        </div>
      )}

      <div role="tablist" style={{ display: 'flex', gap: SPACING.sm, borderBottom: `2px solid ${COLORS.border}`, marginBottom: SPACING.base, overflowX: 'auto' }}>
        {(['users', 'groups', 'audit'] as TabType[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            style={{
              ...getTabStyle(tab === id),
              color: tab === id ? COLORS.primary : COLORS.textSecondary,
              borderBottom: tab === id ? `2px solid ${COLORS.primary}` : '2px solid transparent',
              flexShrink: 0,
            }}>
            {i18n(`ai_helper_access_tab_${id}`)}
          </button>
        ))}
      </div>

      {error && <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.base }}>{error}</div>}

      {tab === 'users' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm, alignItems: 'center', marginBottom: SPACING.md }}>
            <input type="search" style={{ ...getInputStyle(), maxWidth: '260px' }}
              placeholder={i18n('ai_helper_access_search_placeholder')}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
            <select style={{ ...getInputStyle(), maxWidth: '220px' }} value={groupFilter}
              onChange={(e) => { setGroupFilter(e.target.value); setPage(1); }}>
              <option value="">{i18n('ai_helper_access_filter_all_groups')}</option>
              {groups.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.memberCount})</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: SPACING.xs, fontSize: '13px', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyPolicies} onChange={(e) => { setOnlyPolicies(e.target.checked); setPage(1); }} />
              {i18n('ai_helper_access_filter_only_policies')}
            </label>
          </div>

          {!loading && users.rows.length === 0 ? (
            <div style={emptyStateStyle}>{i18n('ai_helper_access_no_users')}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={tableRootStyle}>
                <thead>
                  <tr>
                    <th style={th}>{i18n('ai_helper_access_col_user')}</th>
                    <th style={th}>{i18n('ai_helper_access_col_groups')}</th>
                    <th style={th}>{i18n('ai_helper_access_col_usage')}</th>
                    <th style={th}>{i18n('ai_helper_access_col_status')}</th>
                    <th style={th}>{i18n('ai_helper_access_col_rate')}</th>
                    <th style={th}>{i18n('ai_helper_access_col_actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.rows.map((u) => (
                    <tr key={u.uid}>
                      <td style={td}>
                        <div style={{ fontWeight: 600 }}>{u.uname}</div>
                        <div style={{ fontSize: '12px', color: COLORS.textMuted }}>UID {u.uid}</div>
                      </td>
                      <td style={{ ...td, fontSize: '12px' }}>{u.groups.join(', ') || '—'}</td>
                      <td style={td}>
                        <div>{u.usage.totalTokens.toLocaleString()} / {formatTokens(u.effective.dailyTokenLimit)}</div>
                        <div style={{ fontSize: '12px', color: COLORS.textMuted }}>
                          {sourceLabel(u.effective.dailyTokenLimitSource)}
                          {u.effective.extraTokens > 0 && ` · ${i18n('ai_helper_access_extra_badge', u.effective.extraTokens.toLocaleString(), today)}`}
                        </div>
                      </td>
                      <td style={td}>
                        <StatusBadge effective={u.effective} />
                        {u.policy?.expired && <span style={{ ...getBadgeStyle('warning'), marginLeft: SPACING.xs }}>{i18n('ai_helper_access_expired')}</span>}
                      </td>
                      <td style={td}>
                        <div>{u.effective.rateLimitPerMinute === 0 ? i18n('ai_helper_access_unlimited') : u.effective.rateLimitPerMinute}</div>
                        <div style={{ fontSize: '12px', color: COLORS.textMuted }}>{sourceLabel(u.effective.rateLimitSource)}</div>
                      </td>
                      <td style={td}>
                        <button type="button" style={getButtonStyle('secondary')}
                          onClick={() => setEditing({ kind: 'user', uid: u.uid, label: u.uname, policy: u.policy })}>
                          {i18n('ai_helper_access_edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', justifyContent: 'center', marginTop: SPACING.md, fontSize: '13px' }}>
              <button type="button" style={getPaginationButtonStyle(false, page <= 1)} disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
              <span>{i18n('ai_helper_access_page', page, totalPages)}</span>
              <button type="button" style={getPaginationButtonStyle(false, page >= totalPages)} disabled={page >= totalPages} onClick={() => setPage(page + 1)}>›</button>
            </div>
          )}
        </>
      )}

      {tab === 'groups' && (
        !loading && groups.length === 0 ? (
          <div style={emptyStateStyle}>{i18n('ai_helper_access_no_groups')}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableRootStyle}>
              <thead>
                <tr>
                  <th style={th}>{i18n('ai_helper_access_col_group')}</th>
                  <th style={th}>{i18n('ai_helper_access_col_members')}</th>
                  <th style={th}>{i18n('ai_helper_access_col_policy')}</th>
                  <th style={th}>{i18n('ai_helper_access_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.name}>
                    <td style={{ ...td, fontWeight: 600 }}>{g.name}</td>
                    <td style={td}>{g.memberCount}</td>
                    <td style={{ ...td, fontSize: '13px' }}>
                      {g.policy ? describePolicy(g.policy) : <span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_access_no_policy')}</span>}
                      {g.policy?.expired && <span style={{ ...getBadgeStyle('warning'), marginLeft: SPACING.xs }}>{i18n('ai_helper_access_expired')}</span>}
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: SPACING.xs, flexWrap: 'wrap' }}>
                        <button type="button" style={getButtonStyle('secondary')}
                          onClick={() => setEditing({ kind: 'group', name: g.name, policy: g.policy })}>
                          {i18n('ai_helper_access_edit_group_policy')}
                        </button>
                        <button type="button" style={getButtonStyle('secondary')} disabled={g.memberCount === 0}
                          onClick={() => setEditing({ kind: 'batch', name: g.name, memberCount: g.memberCount })}>
                          {i18n('ai_helper_access_batch_apply')}
                        </button>
                        <button type="button" style={{ ...getButtonStyle('ghost'), color: COLORS.error }} disabled={g.memberCount === 0}
                          onClick={() => clearGroupMembers(g)}>
                          {i18n('ai_helper_access_batch_clear')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'audit' && (
        !loading && audit.length === 0 ? (
          <div style={emptyStateStyle}>{i18n('ai_helper_access_no_audit')}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableRootStyle}>
              <thead>
                <tr>
                  <th style={th}>{i18n('ai_helper_access_audit_col_time')}</th>
                  <th style={th}>{i18n('ai_helper_access_audit_col_operator')}</th>
                  <th style={th}>{i18n('ai_helper_access_audit_col_target')}</th>
                  <th style={th}>{i18n('ai_helper_access_audit_col_change')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontSize: '13px' }}>{new Date(r.createdAt).toLocaleString()}</td>
                    <td style={td}>{r.operatorName}</td>
                    <td style={td}>
                      {r.scope === 'user' ? `UID ${r.target}` : `${i18n('ai_helper_access_col_group')}: ${r.target}`}
                    </td>
                    <td style={{ ...td, fontSize: '13px' }}>
                      <span style={getBadgeStyle(r.action === 'delete' ? 'warning' : 'info')}>
                        {i18n(`ai_helper_access_audit_${r.action}`)}
                      </span>
                      <div style={{ color: COLORS.textMuted, marginTop: SPACING.xs }}>{describePolicy(r.before)}</div>
                      <div>→ {describePolicy(r.after)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {loading && <div style={{ padding: SPACING.base, color: COLORS.textMuted, fontSize: '13px' }}>{i18n('ai_helper_access_loading')}</div>}

      {editing && (
        <PolicyEditor
          target={editing}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); showToast(message, 'success'); refresh(); }}
          onError={(message) => showToast(message, 'error')}
        />
      )}
      <Toast messages={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export default AccessPolicyPanel;
