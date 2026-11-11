/**
 * 学生总览（设计稿“学生总览”，US6）：跨域查看学生的小组、额度与用量、近 7 天违规，并批量操作
 * 仅系统管理员可见；不展示对话原文（FR-053）。批量栏可打开跨域复制或移动（TransferDialog）、重置信誉。
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
import {
  Badge,
  BusyLabel,
  LoadingBar,
  SkeletonRows,
  TableScroll,
  linkButtonStyle,
  mutedTextStyle,
  useDelayedFlag,
} from './userManagementUi';
import {
  EMPTY_OVERVIEW_FILTERS,
  OVERVIEW_PAGE_SIZES,
  normalizePageSize,
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
import { TransferDialog } from './TransferDialog';
import { CreditResetModal } from './CreditDialogs';
import { formatMultiplier, recoveryDaysFrom } from './creditLogic';

type ShowToast = (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;

const PAGE_SIZE_KEY = 'ai-helper:um:overview:page-size';

/** 每页人数按浏览器记住（读写失败时用默认值） */
function readPageSize(): number {
  try {
    return normalizePageSize(window.localStorage.getItem(PAGE_SIZE_KEY));
  } catch {
    return normalizePageSize(null);
  }
}

function savePageSize(size: number): void {
  try {
    window.localStorage.setItem(PAGE_SIZE_KEY, String(size));
  } catch {
    // 隐私模式等情况下无法保存，下次回到默认值即可
  }
}
type Dialog = 'group' | 'quota' | 'override' | 'transfer' | 'credit' | null;

const TONE_COLORS: Record<string, string> = {
  normal: COLORS.primary,
  warn: COLORS.warning,
  full: COLORS.error,
  off: COLORS.border,
  unlimited: COLORS.border,
};

/** 信誉列：正常显示 1.0；降低时显示系数与恢复天数 */
function CreditCell({ credit }: { credit: OverviewRow['credit'] }) {
  if (!credit) return <span style={{ color: COLORS.textMuted }}>—</span>;
  if (!credit.reduced) return <span style={{ color: COLORS.textMuted }}>{formatMultiplier(credit.m)}</span>;
  const days = recoveryDaysFrom(credit.recoveryAt);
  return (
    <div>
      <span style={{ fontWeight: 650, color: credit.m < 0.6 ? COLORS.errorText : COLORS.warningText }}>{formatMultiplier(credit.m)} ↓</span>
      {days && <div style={{ ...mutedTextStyle, fontSize: '12px' }}>{i18n('ai_helper_um_credit_recovery_days', days)}</div>}
    </div>
  );
}

const STATUS_OPTIONS: Array<{ id: OverviewStatus; key: string }> = [
  { id: '', key: 'ai_helper_um_overview_status_all' },
  { id: 'exhausted', key: 'ai_helper_um_overview_status_exhausted' },
  { id: 'high_usage', key: 'ai_helper_um_overview_status_high' },
  { id: 'credit_reduced', key: 'ai_helper_um_overview_status_credit' },
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

export const UserOverviewPanel: React.FC<{ domainId: string; showToast: ShowToast; onOpenAudit?: () => void }> = ({ domainId, showToast, onOpenAudit }) => {
  const [draft, setDraft] = useState<OverviewFiltersState>(EMPTY_OVERVIEW_FILTERS);
  const [filters, setFilters] = useState<OverviewFiltersState>(EMPTY_OVERVIEW_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  /** 由“查询”按钮发起的加载，按钮上显示转圈 */
  const [querying, setQuerying] = useState(false);
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

  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    // 快速翻页或连续查询时只采用最后一次请求的结果
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const query = overviewQuery(filters, page, pageSize);
      const res = await getJson<OverviewResponse>(`${QUOTA_API.users}${query ? `?${query}` : ''}`, i18n('ai_helper_overview_failed'));
      if (seq !== requestSeq.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(errorMessage(err, i18n('ai_helper_overview_failed')));
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setQuerying(false);
      }
    }
  }, [filters, page, pageSize]);

  useEffect(() => { load(); }, [load]);
  const refreshing = useDelayedFlag(loading && !!data);

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

  const apply = () => {
    setQuerying(true);
    setPage(1);
    // 条件没变时也重新查询（例如别人刚改过数据）
    if (JSON.stringify(draft) === JSON.stringify(filters) && page === 1) load();
    else setFilters({ ...draft });
  };
  const reset = () => { setDraft(EMPTY_OVERVIEW_FILTERS); setFilters(EMPTY_OVERVIEW_FILTERS); setPage(1); };
  const changePageSize = (size: number) => {
    savePageSize(size);
    setPageSize(size);
    setPage(1);
  };
  const selectedRows = useMemo(() => [...selected.values()], [selected]);
  const domains = meta?.domains || [];

  const filterDomainName = domains.find((domain) => domain.id === filters.domainId)?.name || filters.domainId;
  const transferSourceNote = filters.domainId
    ? (filters.group
      ? i18n('ai_helper_transfer_source_note_group', filterDomainName, filters.group)
      : i18n('ai_helper_transfer_source_note', filterDomainName))
    : undefined;

  const finishBatch = (message: string) => {
    setDialog(null);
    showToast(message, 'success');
    setSelected(new Map());
    load();
    loadMeta();
  };

  const hasCredit = rows.some((row) => row.credit !== null);
  const columnCount = hasCredit ? 8 : 7;
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
          <button type="submit" style={getButtonStyle('primary')} disabled={querying} aria-busy={querying}>
            <BusyLabel busy={querying}>{querying ? i18n('ai_helper_um_overview_querying') : i18n('ai_helper_um_overview_query')}</BusyLabel>
          </button>
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
        <button type="button" style={getButtonStyle('secondary')} disabled={!selected.size || domains.length < 2} onClick={() => setDialog('transfer')}>{i18n('ai_helper_transfer_open_users')}</button>
        <button type="button" style={getButtonStyle('secondary')} disabled={!selected.size} onClick={() => setDialog('credit')}>{i18n('ai_helper_um_credit_reset')}</button>
        <span style={{ flex: 1 }} />
        {selected.size > 0 && (
          <button type="button" style={linkButtonStyle} onClick={() => setSelected(new Map())}>{i18n('ai_helper_um_overview_clear_selection')}</button>
        )}
      </div>

      <section aria-busy={loading} style={{ ...cardStyle, padding: 0, overflow: 'hidden', position: 'relative' }}>
        <LoadingBar active={refreshing} />
        {error && (
          <div style={{ ...getAlertStyle('error'), margin: SPACING.base, display: 'flex', gap: SPACING.sm, alignItems: 'center' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" style={getButtonStyle('secondary')} onClick={load}>{i18n('ai_helper_um_retry')}</button>
          </div>
        )}
        {data?.truncated && <div style={{ ...getAlertStyle('warning'), margin: SPACING.base }}>{i18n('ai_helper_um_overview_truncated')}</div>}
        <TableScroll>
          <table style={{ width: '100%', borderCollapse: 'collapse', opacity: refreshing ? 0.55 : 1, transition: 'opacity 150ms' }}>
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
                {hasCredit && <th style={th}>{i18n('ai_helper_um_overview_credit_col')}</th>}
                <th style={th}>{i18n('ai_helper_um_overview_violations_col')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && <SkeletonRows columns={columnCount} label={i18n('ai_helper_um_loading')} />}
              {data && rows.length === 0 && (
                <tr><td colSpan={columnCount} style={{ ...td, color: COLORS.textMuted, textAlign: 'center' }}>{i18n('ai_helper_um_overview_empty')}</td></tr>
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
                    {hasCredit && <td style={td}><CreditCell credit={row.credit} /></td>}
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
            <label style={{ ...mutedTextStyle, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {i18n('ai_helper_um_overview_page_size')}
              <select
                value={pageSize}
                onChange={(event) => changePageSize(Number(event.target.value))}
                style={{ ...getInputStyle(), width: 'auto', padding: '4px 8px', minHeight: 0 }}
              >
                {OVERVIEW_PAGE_SIZES.map((size) => <option key={size} value={size}>{i18n('ai_helper_um_overview_page_size_option', size)}</option>)}
              </select>
            </label>
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
      {dialog === 'transfer' && (
        <TransferDialog
          kind="users"
          domains={domains}
          sourceDomainId={domains.some((domain) => domain.id === filters.domainId) ? filters.domainId : domainId}
          users={selectedRows.map((row) => ({ uid: row.uid, uname: row.uname }))}
          sourceNote={transferSourceNote}
          onClose={() => setDialog(null)}
          onFinished={() => { setDialog(null); setSelected(new Map()); load(); loadMeta(); }}
          onOpenAudit={onOpenAudit}
        />
      )}
      {dialog === 'credit' && (
        <CreditResetModal
          users={selectedRows.map((row) => ({ uid: row.uid, uname: row.uname }))}
          onClose={() => setDialog(null)}
          onDone={finishBatch}
        />
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
