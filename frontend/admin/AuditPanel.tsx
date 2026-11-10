/**
 * 操作审计（设计稿“操作审计”）：筛选、列表、详情、撤销
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { formatDateTime } from '../utils/formatDate';
import {
  COLORS,
  SPACING,
  emptyStateStyle,
  getAlertStyle,
  getButtonStyle,
  getInputStyle,
  getPaginationButtonStyle,
  getTableCellStyle,
  getTableHeaderStyle,
  tableRootStyle,
} from '../utils/styles';
import { errorMessage, getJson, postJson } from './userManagementApi';
import {
  domainApiUrl,
  formatUidNames,
  summarizeAuditDetail,
  type AuditListResponse,
  type AuditLogItem,
  type GroupListResponse,
} from './userManagementLogic';
import { describeGroupAudit } from './GroupManagerPanel';
import { formatGroupLimit, formatOverrideSetting } from './quotaAdminUi';
import { Badge, Drawer, TableScroll, labelStyle, linkButtonStyle, mutedTextStyle, type BadgeVariant } from './userManagementUi';

interface AuditPanelProps {
  currentDomainId: string;
  showToast: (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;
}

const ACTION_LABEL_KEYS: Record<string, string> = {
  'group.add': 'ai_helper_um_action_group_add',
  'group.remove': 'ai_helper_um_action_group_remove',
  'group.drift_restore': 'ai_helper_um_action_group_drift_restore',
  'group.drift_dismiss': 'ai_helper_um_action_group_drift_dismiss',
  'group.meta': 'ai_helper_um_action_group_meta',
  'quota.group_create': 'ai_helper_um_action_quota_group_create',
  'quota.group_update': 'ai_helper_um_action_quota_group_update',
  'quota.group_delete': 'ai_helper_um_action_quota_group_delete',
  'quota.group_member_add': 'ai_helper_um_action_quota_member_add',
  'quota.group_member_remove': 'ai_helper_um_action_quota_member_remove',
  'quota.group_link': 'ai_helper_um_action_quota_link',
  'quota.group_unlink': 'ai_helper_um_action_quota_unlink',
  'quota.override_set': 'ai_helper_um_action_override_set',
  'quota.override_clear': 'ai_helper_um_action_override_clear',
  'settings.teacher_access': 'ai_helper_um_action_teacher_access',
};

function actionLabel(action: string): string {
  return ACTION_LABEL_KEYS[action] ? i18n(ACTION_LABEL_KEYS[action]) : action;
}

function actionVariant(log: AuditLogItem): BadgeVariant {
  if (log.category === 'settings') return 'ok';
  if (log.category === 'review') return 'warn';
  if (log.category === 'quota') return log.action.endsWith('delete') || log.action.endsWith('clear') ? 'muted' : 'ok';
  return 'info';
}

const TARGET_LABEL_KEYS: Record<string, string> = {
  'config:groupTeacherAccessEnabled': 'ai_helper_um_action_teacher_access',
};

function targetLabel(log: AuditLogItem): string {
  const key = TARGET_LABEL_KEYS[`${log.target.type}:${log.target.id}`];
  return key ? i18n(key) : log.target.label || log.target.id;
}

function describeQuotaAudit(log: AuditLogItem): string {
  const d = log.detail || {};
  const limitText = (mode: unknown, limit: unknown) => (
    mode === 'grant' || mode === 'cap' ? formatGroupLimit(mode, Number(limit)) : String(limit ?? '')
  );
  switch (log.action) {
    case 'quota.group_create':
      return `${d.mode === 'grant' ? i18n('ai_helper_um_qgroup_type_grant') : i18n('ai_helper_um_qgroup_type_cap')} · ${limitText(d.mode, d.dailyLimit)}`;
    case 'quota.group_update': {
      const before = (d.before || {}) as Record<string, unknown>;
      const after = (d.after || {}) as Record<string, unknown>;
      const parts: string[] = [];
      if ('name' in after) parts.push(`${String(before.name)} → ${String(after.name)}`);
      if ('dailyLimit' in after || 'mode' in after) parts.push(i18n('ai_helper_um_audit_quota_limit_change', String(before.dailyLimit ?? '—'), String(after.dailyLimit ?? '—')));
      if ('enabled' in after) parts.push(after.enabled ? i18n('ai_helper_um_audit_change_enabled') : i18n('ai_helper_um_audit_change_disabled'));
      return parts.join('；') || '—';
    }
    case 'quota.group_delete':
      return i18n('ai_helper_um_audit_quota_deleted', Array.isArray(d.memberUids) ? d.memberUids.length : 0);
    case 'quota.group_member_add':
      return i18n('ai_helper_um_audit_change_add', summarizeAuditDetail(log).added.length);
    case 'quota.group_member_remove':
      return i18n('ai_helper_um_audit_change_remove', summarizeAuditDetail(log).removed.length);
    case 'quota.group_link':
    case 'quota.group_unlink':
      return `${String(d.name)} @ ${String(d.domainId)}`;
    case 'quota.override_set': {
      const count = Array.isArray(d.uids) ? d.uids.length : 0;
      const setting = formatOverrideSetting(d.mode === 'disabled' ? 'disabled' : 'limit', Number(d.dailyLimit));
      return i18n('ai_helper_um_audit_override_set', count, setting, String(d.reason || ''));
    }
    case 'quota.override_clear':
      return i18n('ai_helper_um_audit_override_clear', Array.isArray(d.uids) ? d.uids.length : 0);
    default:
      return '—';
  }
}

function changeSummary(log: AuditLogItem): string {
  if (log.category === 'group') return describeGroupAudit(log);
  if (log.category === 'quota') return describeQuotaAudit(log);
  if (log.action === 'settings.teacher_access') {
    return log.detail?.to ? i18n('ai_helper_um_audit_change_enabled') : i18n('ai_helper_um_audit_change_disabled');
  }
  return '—';
}

function detailLines(log: AuditLogItem): string[] {
  const summary = summarizeAuditDetail(log);
  const lines: string[] = [];
  const named = (uids: number[]) => {
    const { text, more } = formatUidNames(uids, log.uidNames, 8);
    return more ? `${text} ${i18n('ai_helper_um_and_more', more)}` : text;
  };
  if (summary.added.length) lines.push(i18n('ai_helper_um_detail_added', summary.added.length, named(summary.added)));
  if (summary.removed.length) lines.push(i18n('ai_helper_um_detail_removed', summary.removed.length, named(summary.removed)));
  if (summary.joined.length) {
    lines.push(i18n('ai_helper_um_detail_joined', summary.joined.length, summary.joinRole || '—', named(summary.joined)));
  }
  if (summary.dismissed.length) lines.push(i18n('ai_helper_um_detail_dismissed', summary.dismissed.length, named(summary.dismissed)));
  if (log.action === 'group.meta' || log.action === 'settings.teacher_access') lines.push(changeSummary(log));
  if (log.category === 'quota' && !log.action.startsWith('quota.group_member')) {
    lines.push(changeSummary(log));
    const uids = Array.isArray(log.detail?.uids) ? (log.detail.uids as unknown[]).filter((uid): uid is number => typeof uid === 'number') : [];
    if (uids.length) lines.push(i18n('ai_helper_um_audit_override_users', uids.length, named(uids)));
  }
  if (!lines.length) lines.push(i18n('ai_helper_um_detail_no_change'));
  return lines;
}

function undoUrl(log: AuditLogItem): string | null {
  if (log.category === 'group' && log.domainId) return domainApiUrl(log.domainId, '/ai-helper/groups/undo');
  return null;
}

export const AuditPanel: React.FC<AuditPanelProps> = ({ currentDomainId, showToast }) => {
  const [days, setDays] = useState('7');
  const [category, setCategory] = useState('');
  const [actor, setActor] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [domains, setDomains] = useState<Array<{ id: string; name: string }>>([]);
  const [detail, setDetail] = useState<AuditLogItem | null>(null);
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    getJson<GroupListResponse>(domainApiUrl(currentDomainId, '/ai-helper/groups'), i18n('ai_helper_group_list_failed'))
      .then((res) => setDomains(res.domains))
      .catch(() => setDomains([]));
  }, [currentDomainId]);

  const load = useCallback(async (targetPage: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(targetPage), limit: '20', days });
      if (category) params.set('category', category);
      if (actor) params.set('actor', actor);
      if (domainFilter) params.set('domainId', domainFilter);
      const res = await getJson<AuditListResponse>(`${domainApiUrl(currentDomainId, '/ai-helper/admin/audit')}?${params}`, i18n('ai_helper_audit_load_failed'));
      setData(res);
      setPage(res.page);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_audit_load_failed')));
    } finally {
      setLoading(false);
    }
  }, [currentDomainId, days, category, actor, domainFilter]);

  useEffect(() => { load(1); }, [load]);

  const undo = async (log: AuditLogItem) => {
    const url = undoUrl(log);
    if (!url) return;
    const joined = summarizeAuditDetail(log).joined.length;
    const confirmText = log.action === 'group.add' && joined
      ? `${i18n('ai_helper_um_undo_confirm')}\n${i18n('ai_helper_um_undo_confirm_joined', joined)}`
      : i18n('ai_helper_um_undo_confirm');
    if (!window.confirm(confirmText)) return;
    setUndoing(true);
    try {
      await postJson(url, { auditId: log.id }, i18n('ai_helper_group_undo_failed'));
      showToast(i18n('ai_helper_um_undo_done'), 'success');
      setDetail(null);
      load(page);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_group_undo_failed')), 'error');
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: SPACING.md, flexWrap: 'wrap', marginBottom: SPACING.base }}>
        <label style={{ display: 'grid', gap: '4px' }}>
          <span style={labelStyle}>{i18n('ai_helper_um_audit_time')}</span>
          <select value={days} onChange={(event) => setDays(event.target.value)} style={{ ...getInputStyle(), width: 'auto' }}>
            <option value="7">{i18n('ai_helper_um_audit_days', 7)}</option>
            <option value="30">{i18n('ai_helper_um_audit_days', 30)}</option>
            <option value="180">{i18n('ai_helper_um_audit_days', 180)}</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: '4px' }}>
          <span style={labelStyle}>{i18n('ai_helper_um_audit_action')}</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)} style={{ ...getInputStyle(), width: 'auto' }}>
            <option value="">{i18n('ai_helper_um_all')}</option>
            <option value="group">{i18n('ai_helper_um_audit_category_group')}</option>
            <option value="quota">{i18n('ai_helper_um_audit_category_quota')}</option>
            <option value="settings">{i18n('ai_helper_um_audit_category_settings')}</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: '4px' }}>
          <span style={labelStyle}>{i18n('ai_helper_um_audit_actor')}</span>
          <select value={actor} onChange={(event) => setActor(event.target.value)} style={{ ...getInputStyle(), width: 'auto' }}>
            <option value="">{i18n('ai_helper_um_all')}</option>
            <option value="system">{i18n('ai_helper_um_actor_system')}</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: '4px' }}>
          <span style={labelStyle}>{i18n('ai_helper_um_domain')}</span>
          <select value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)} style={{ ...getInputStyle(), width: 'auto', minWidth: '160px' }}>
            <option value="">{i18n('ai_helper_um_all_domains')}</option>
            {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => load(1)} disabled={loading} style={getButtonStyle('secondary')}>
          {i18n('ai_helper_um_refresh')}
        </button>
      </div>

      {error && <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.base }}>{error}</div>}
      {loading && !data && <div style={mutedTextStyle}>{i18n('ai_helper_um_loading')}</div>}
      {data && data.logs.length === 0 && <div style={emptyStateStyle}>{i18n('ai_helper_um_audit_empty')}</div>}

      {data && data.logs.length > 0 && (
        <TableScroll>
          <table style={tableRootStyle}>
            <thead>
              <tr>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_audit_time')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_audit_actor')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_audit_action')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_domain')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_audit_target')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_audit_change')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ ...getTableCellStyle(), whiteSpace: 'nowrap', color: COLORS.textMuted }}>{formatDateTime(log.at)}</td>
                  <td style={getTableCellStyle()}>{log.actorName || i18n('ai_helper_um_actor_system')}</td>
                  <td style={getTableCellStyle()}><Badge variant={actionVariant(log)}>{actionLabel(log.action)}</Badge></td>
                  <td style={{ ...getTableCellStyle(), whiteSpace: 'nowrap' }}>{log.domainName || '—'}</td>
                  <td style={getTableCellStyle()}>{targetLabel(log)}</td>
                  <td className="ai-um-wrap" style={{ ...getTableCellStyle(), fontSize: '13px' }}>{changeSummary(log)}</td>
                  <td style={{ ...getTableCellStyle(), whiteSpace: 'nowrap' }}>
                    {log.undoable && undoUrl(log) && (
                      <button type="button" disabled={undoing} style={linkButtonStyle} onClick={() => undo(log)}>{i18n('ai_helper_um_undo')}</button>
                    )}
                    {log.undoneAt && <Badge variant="muted">{i18n('ai_helper_um_undone')}</Badge>}
                    <button type="button" style={linkButtonStyle} onClick={() => setDetail(log)}>{i18n('ai_helper_um_detail')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {data && data.totalPages > 1 && (
        <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', justifyContent: 'flex-end', marginTop: SPACING.md }}>
          <button type="button" disabled={page <= 1 || loading} onClick={() => load(page - 1)} style={getPaginationButtonStyle(false, page <= 1)}>‹</button>
          <span style={mutedTextStyle}>{`${page} / ${data.totalPages}`}</span>
          <button type="button" disabled={page >= data.totalPages || loading} onClick={() => load(page + 1)} style={getPaginationButtonStyle(false, page >= data.totalPages)}>›</button>
        </div>
      )}

      {detail && (
        <Drawer
          title={i18n('ai_helper_um_detail_title', actionLabel(detail.action), targetLabel(detail))}
          subtitle={`${formatDateTime(detail.at)} · ${detail.actorName || i18n('ai_helper_um_actor_system')}${detail.domainName ? ` · ${detail.domainName}` : ''}`}
          onClose={() => setDetail(null)}
        >
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: SPACING.sm, fontSize: '14px', color: COLORS.textPrimary }}>
            {detailLines(detail).map((line, index) => <li key={index} style={{ overflowWrap: 'break-word' }}>{line}</li>)}
          </ul>
          {detail.undoneAt && (
            <div style={{ ...getAlertStyle('info'), marginTop: SPACING.base }}>
              {i18n('ai_helper_um_detail_undone', formatDateTime(detail.undoneAt), detail.undoneByName || '—')}
            </div>
          )}
          {detail.undoable && undoUrl(detail) && (
            <div style={{ marginTop: SPACING.lg }}>
              <button type="button" disabled={undoing} onClick={() => undo(detail)} style={getButtonStyle('primary')}>
                {i18n('ai_helper_um_undo_this')}
              </button>
              <p style={{ ...mutedTextStyle, marginTop: SPACING.sm }}>
                {i18n('ai_helper_um_undo_note')}
                {detail.action === 'group.add' && summarizeAuditDetail(detail).joined.length
                  ? ` ${i18n('ai_helper_um_undo_confirm_joined', summarizeAuditDetail(detail).joined.length)}`
                  : ''}
              </p>
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
};

export default AuditPanel;
