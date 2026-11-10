/**
 * 学生总览（设计稿“学生总览”，US6）：跨域查看学生的小组、额度与用量、近 7 天违规，并批量操作
 * 仅系统管理员可见；不展示对话原文（FR-053）。信誉列随 PR4 加入，跨域转移随 PR3b 加入。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS,
  RADIUS,
  SPACING,
  cardStyle,
  getAlertStyle,
  getButtonStyle,
  getInputStyle,
  getTableCellStyle,
  getTableHeaderStyle,
} from '../utils/styles';
import { errorMessage, getJson } from './userManagementApi';
import { domainApiUrl, type GroupListResponse } from './userManagementLogic';
import { Badge, TableScroll, linkButtonStyle, mutedTextStyle } from './userManagementUi';
import {
  EMPTY_OVERVIEW_FILTERS,
  overviewQuery,
  pageSelectionState,
  usageMeter,
  type OverviewFiltersState,
  type OverviewQuota,
  type OverviewResponse,
  type OverviewRow,
  type OverviewStatus,
  type QuotaGroupsResponse,
} from './quotaAdminLogic';
import { OverrideFormModal, QUOTA_API, formatOverrideSetting } from './quotaAdminUi';
import { HydroGroupBatchDialog, QuotaGroupBatchDialog } from './OverviewBatchDialogs';
import { UserDetailDrawer } from './UserDetailDrawer';

type ShowToast = (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;
type Dialog = 'group' | 'quota' | 'override' | null;

const TONE_COLORS: Record<string, string> = {
  normal: COLORS.primary,
  warn: COLORS.warning,
  full: COLORS.error,
  off: COLORS.border,
  unlimited: COLORS.border,
};

const STATUS_OPTIONS: Array<{ id: OverviewStatus; key: string }> = [
  { id: '', key: 'ai_helper_um_overview_status_all' },
  { id: 'exhausted', key: 'ai_helper_um_overview_status_exhausted' },
  { id: 'high_usage', key: 'ai_helper_um_overview_status_high' },
  { id: 'disabled', key: 'ai_helper_um_overview_status_disabled' },
  { id: 'violations', key: 'ai_helper_um_overview_status_violations' },
];

function QuotaCell({ quota }: { quota: OverviewQuota }) {
  if (quota.override) {
    return (
      <Badge variant={quota.override.mode === 'disabled' ? 'err' : 'info'}>
        {i18n('ai_helper_um_overview_override', formatOverrideSetting(quota.override.mode, quota.override.dailyLimit))}
      </Badge>
    );
  }
  if (!quota.appliedGroups.length) return <span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_um_overview_default')}</span>;
  return (
    <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
      {quota.appliedGroups.map((group) => (
        <Badge key={group.id} variant={group.mode === 'grant' ? 'info' : 'warn'}>
          {group.mode === 'grant'
            ? group.name
            : group.dailyLimit === 0
              ? i18n('ai_helper_um_overview_cap_zero', group.name)
              : i18n('ai_helper_um_overview_cap', group.name, group.dailyLimit)}
        </Badge>
      ))}
    </span>
  );
}

function UsageCell({ quota }: { quota: OverviewQuota }) {
  const meter = usageMeter(quota);
  let text: string;
  if (quota.disabled) text = i18n('ai_helper_um_detail_ai_off');
  else if (quota.limit === null) text = i18n('ai_helper_um_overview_usage_unlimited', quota.used);
  else if (meter.tone === 'full') text = i18n('ai_helper_um_overview_usage_full', quota.used, quota.limit);
  else text = `${quota.used} / ${quota.limit}`;
  return (
    <div style={{ minWidth: '110px' }}>
      <div style={{ fontSize: '13px', color: meter.tone === 'full' ? COLORS.errorText : quota.disabled ? COLORS.textMuted : COLORS.textPrimary }}>{text}</div>
      {!quota.disabled && quota.limit !== null && (
        <div style={{ height: '4px', background: COLORS.bgHover, borderRadius: RADIUS.full, marginTop: '4px', overflow: 'hidden' }}>
          <div style={{ width: `${meter.percent}%`, height: '100%', background: TONE_COLORS[meter.tone] }} />
        </div>
      )}
    </div>
  );
}

export const UserOverviewPanel: React.FC<{ domainId: string; showToast: ShowToast }> = ({ domainId, showToast }) => {
  const [draft, setDraft] = useState<OverviewFiltersState>(EMPTY_OVERVIEW_FILTERS);
  const [filters, setFilters] = useState<OverviewFiltersState>(EMPTY_OVERVIEW_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<QuotaGroupsResponse | null>(null);
  const [domainGroups, setDomainGroups] = useState<string[]>([]);
  const [selected, setSelected] = useState<Map<number, OverviewRow>>(new Map());
  const [detailUid, setDetailUid] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const headerCheckbox = useRef<HTMLInputElement>(null);

  const loadMeta = useCallback(() => {
    getJson<QuotaGroupsResponse>(QUOTA_API.groups, i18n('ai_helper_quota_groups_failed'))
      .then(setMeta)
      .catch(() => setMeta({ groups: [], domains: [] }));
  }, []);

  useEffect(() => { loadMeta(); }, [loadMeta]);

  useEffect(() => {
    if (!draft.domainId) { setDomainGroups([]); return; }
    let cancelled = false;
    getJson<GroupListResponse>(domainApiUrl(draft.domainId, '/ai-helper/groups'), i18n('ai_helper_group_list_failed'))
      .then((res) => { if (!cancelled) setDomainGroups(res.groups.filter((group) => group.existsInHydro).map((group) => group.name)); })
      .catch(() => { if (!cancelled) setDomainGroups([]); });
    return () => { cancelled = true; };
  }, [draft.domainId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = overviewQuery(filters, page);
      setData(await getJson<OverviewResponse>(`${QUOTA_API.users}${query ? `?${query}` : ''}`, i18n('ai_helper_overview_failed')));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_overview_failed')));
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const selection = pageSelectionState(rows, new Set(selected.keys()));
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = selection === 'some';
  }, [selection]);

  const togglePage = () => {
    const next = new Map(selected);
    if (selection === 'all') rows.forEach((row) => next.delete(row.uid));
    else rows.forEach((row) => next.set(row.uid, row));
    setSelected(next);
  };

  const toggleRow = (row: OverviewRow) => {
    const next = new Map(selected);
    if (next.has(row.uid)) next.delete(row.uid);
    else next.set(row.uid, row);
    setSelected(next);
  };

  const apply = () => { setPage(1); setFilters({ ...draft }); };
  const reset = () => { setDraft(EMPTY_OVERVIEW_FILTERS); setFilters(EMPTY_OVERVIEW_FILTERS); setPage(1); };
  const selectedRows = useMemo(() => [...selected.values()], [selected]);
  const domains = meta?.domains || [];

  const finishBatch = (message: string) => {
    setDialog(null);
    showToast(message, 'success');
    setSelected(new Map());
    load();
    loadMeta();
  };

  const th = getTableHeaderStyle();
  const td = getTableCellStyle();
  const fieldStyle: React.CSSProperties = { ...getInputStyle(), width: 'auto', minWidth: '120px' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: SPACING.base }}>
      <section style={{ ...cardStyle, padding: SPACING.base }}>
        <div style={{ ...mutedTextStyle, marginBottom: SPACING.sm }}>{i18n('ai_helper_um_overview_scope')}</div>
        <form
          onSubmit={(event) => { event.preventDefault(); apply(); }}
          style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap', alignItems: 'center' }}
        >
          <select
            aria-label={i18n('ai_helper_um_overview_name_mode')}
            value={draft.mode}
            onChange={(event) => setDraft({ ...draft, mode: event.target.value as 'prefix' | 'regex' })}
            style={{ ...fieldStyle, minWidth: 0 }}
          >
            <option value="prefix">{i18n('ai_helper_um_overview_name_prefix')}</option>
            <option value="regex">{i18n('ai_helper_um_overview_name_regex')}</option>
          </select>
          <input
            value={draft.q}
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
            placeholder={draft.mode === 'regex' ? '^23\\d{2}' : '2301'}
            aria-label={i18n('ai_helper_um_overview_name_prefix')}
            style={{ ...getInputStyle(), width: '140px' }}
          />
          <select
            aria-label={i18n('ai_helper_um_domain')}
            value={draft.domainId}
            onChange={(event) => setDraft({ ...draft, domainId: event.target.value, group: '' })}
            style={fieldStyle}
          >
            <option value="">{i18n('ai_helper_um_overview_all_domains')}</option>
            {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
          </select>
          <select
            aria-label={i18n('ai_helper_um_overview_group')}
            value={draft.group}
            disabled={!draft.domainId}
            title={draft.domainId ? undefined : i18n('ai_helper_overview_group_needs_domain')}
            onChange={(event) => setDraft({ ...draft, group: event.target.value })}
            style={fieldStyle}
          >
            <option value="">{i18n('ai_helper_um_overview_group_all')}</option>
            {domainGroups.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select
            aria-label={i18n('ai_helper_um_qgroup_title')}
            value={draft.quotaGroupId}
            onChange={(event) => setDraft({ ...draft, quotaGroupId: event.target.value })}
            style={fieldStyle}
          >
            <option value="">{i18n('ai_helper_um_overview_qgroup_all')}</option>
            {(meta?.groups || []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <select
            aria-label={i18n('ai_helper_um_overview_status')}
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value as OverviewStatus })}
            style={fieldStyle}
          >
            {STATUS_OPTIONS.map((option) => <option key={option.id} value={option.id}>{i18n(option.key)}</option>)}
          </select>
          <span style={{ flex: 1 }} />
          <button type="button" style={getButtonStyle('ghost')} onClick={reset}>{i18n('ai_helper_um_overview_reset')}</button>
          <button type="submit" style={getButtonStyle('primary')}>{i18n('ai_helper_um_overview_query')}</button>
        </form>
      </section>

      {/* 始终占位：勾选第一行时不推动表格，避免连续勾选时点错行 */}
      <div
        role="region"
        aria-label={i18n('ai_helper_um_overview_batch_bar')}
        style={{
          display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap', padding: `${SPACING.sm} ${SPACING.base}`,
          background: selected.size ? COLORS.primaryLight : COLORS.bgPage, borderRadius: RADIUS.md,
          border: `1px solid ${selected.size ? `${COLORS.primary}33` : COLORS.border}`,
        }}
      >
        {selected.size > 0
          ? <strong style={{ color: COLORS.primary, fontSize: '14px' }}>{i18n('ai_helper_um_overview_selected', selected.size)}</strong>
          : <span style={mutedTextStyle}>{i18n('ai_helper_um_overview_select_hint')}</span>}
        <button type="button" style={getButtonStyle('secondary')} disabled={!selected.size} onClick={() => setDialog('group')}>{i18n('ai_helper_um_overview_batch_group')}</button>
        <button type="button" style={getButtonStyle('secondary')} disabled={!selected.size} onClick={() => setDialog('quota')}>{i18n('ai_helper_um_overview_batch_qgroup')}</button>
        <button type="button" style={getButtonStyle('secondary')} disabled={!selected.size} onClick={() => setDialog('override')}>{i18n('ai_helper_um_override_dialog_title')}</button>
        <span style={{ flex: 1 }} />
        {selected.size > 0 && (
          <button type="button" style={linkButtonStyle} onClick={() => setSelected(new Map())}>{i18n('ai_helper_um_overview_clear_selection')}</button>
        )}
      </div>

      <section style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        {error && (
          <div style={{ ...getAlertStyle('error'), margin: SPACING.base, display: 'flex', gap: SPACING.sm, alignItems: 'center' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" style={getButtonStyle('secondary')} onClick={load}>{i18n('ai_helper_um_retry')}</button>
          </div>
        )}
        {data?.truncated && <div style={{ ...getAlertStyle('warning'), margin: SPACING.base }}>{i18n('ai_helper_um_overview_truncated')}</div>}
        <TableScroll>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: '36px' }}>
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    aria-label={i18n('ai_helper_um_overview_select_page')}
                    checked={selection === 'all'}
                    disabled={!rows.length}
                    onChange={togglePage}
                  />
                </th>
                <th style={th}>{i18n('ai_helper_um_student')}</th>
                <th style={th}>{i18n('ai_helper_um_domain')}</th>
                <th style={th}>{i18n('ai_helper_um_overview_group')}</th>
                <th style={th}>{i18n('ai_helper_um_overview_quota_col')}</th>
                <th style={th}>{i18n('ai_helper_um_overview_usage_col')}</th>
                <th style={th}>{i18n('ai_helper_um_overview_violations_col')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && (
                <tr><td colSpan={7} style={{ ...td, color: COLORS.textMuted, textAlign: 'center' }}>{i18n('ai_helper_um_loading')}</td></tr>
              )}
              {data && rows.length === 0 && (
                <tr><td colSpan={7} style={{ ...td, color: COLORS.textMuted, textAlign: 'center' }}>{i18n('ai_helper_um_overview_empty')}</td></tr>
              )}
              {rows.map((row) => {
                const checked = selected.has(row.uid);
                return (
                  <tr key={row.uid} style={{ background: checked ? `${COLORS.primaryLight}88` : undefined }}>
                    <td style={td}>
                      <input type="checkbox" checked={checked} aria-label={row.uname} onChange={() => toggleRow(row)} />
                    </td>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => setDetailUid(row.uid)}
                        style={{ ...linkButtonStyle, padding: 0, fontWeight: 600, color: COLORS.textPrimary, textAlign: 'left' }}
                      >
                        {row.uname}
                      </button>
                      <div style={{ ...mutedTextStyle, fontSize: '12px' }}>uid {row.uid}</div>
                    </td>
                    <td className="ai-um-wrap" style={td}>
                      {row.domains.length ? row.domains.map((domain) => domain.name).join('、') : <span style={{ color: COLORS.textMuted }}>—</span>}
                    </td>
                    <td className="ai-um-wrap" style={td}>
                      {row.groups.length ? row.groups.map((group) => group.name).join('、') : <span style={{ color: COLORS.textMuted }}>—</span>}
                    </td>
                    <td style={td}><QuotaCell quota={row.quota} /></td>
                    <td style={td}><UsageCell quota={row.quota} /></td>
                    <td style={{ ...td, color: row.violations7d ? COLORS.errorText : COLORS.textMuted, fontWeight: row.violations7d ? 600 : 400 }}>
                      {row.violations7d}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
        {data && (
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, padding: `${SPACING.sm} ${SPACING.base}`, borderTop: `1px solid ${COLORS.border}`, flexWrap: 'wrap' }}>
            <span style={mutedTextStyle}>{i18n('ai_helper_um_overview_pager', data.total, data.pageCount ? data.page : 0, data.pageCount)}</span>
            <span style={{ flex: 1 }} />
            <button type="button" style={getButtonStyle('secondary')} disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
              {i18n('ai_helper_um_prev_page')}
            </button>
            <button type="button" style={getButtonStyle('secondary')} disabled={page >= data.pageCount || loading} onClick={() => setPage(page + 1)}>
              {i18n('ai_helper_um_next_page')}
            </button>
          </div>
        )}
      </section>

      {detailUid !== null && (
        <UserDetailDrawer
          uid={detailUid}
          domainId={domainId}
          onClose={() => setDetailUid(null)}
          onChanged={load}
          showToast={showToast}
        />
      )}
      {dialog === 'group' && (
        <HydroGroupBatchDialog
          rows={selectedRows}
          domains={domains}
          defaultDomainId={domainId}
          onClose={() => setDialog(null)}
          onDone={finishBatch}
        />
      )}
      {dialog === 'quota' && (
        <QuotaGroupBatchDialog rows={selectedRows} groups={meta?.groups || []} onClose={() => setDialog(null)} onDone={finishBatch} />
      )}
      {dialog === 'override' && (
        <OverrideFormModal
          domainId={domainId}
          users={selectedRows.map((row) => ({ uid: row.uid, uname: row.uname }))}
          lockUsers
          onClose={() => setDialog(null)}
          onSaved={finishBatch}
        />
      )}
    </div>
  );
};

export default UserOverviewPanel;
