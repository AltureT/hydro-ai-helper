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
  'group.backfill': 'ai_helper_um_action_group_backfill',
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
  'transfer.groups': 'ai_helper_um_action_transfer_groups',
  'transfer.users': 'ai_helper_um_action_transfer_users',
  'credit.reset': 'ai_helper_um_action_credit_reset',
  'credit.revoke': 'ai_helper_um_action_credit_revoke',
  'review.run': 'ai_helper_um_action_review_run',
  'review.breaker_trip': 'ai_helper_um_action_review_breaker_trip',
  'review.auto_penalty_disable': 'ai_helper_um_action_review_disable',
  'review.auto_penalty_resume': 'ai_helper_um_action_review_resume',
};

const TRANSFER_API = {
  undo: '/ai-helper/admin/transfer/undo',
  resume: '/ai-helper/admin/transfer/resume',
};

function actionLabel(action: string): string {
  return ACTION_LABEL_KEYS[action] ? i18n(ACTION_LABEL_KEYS[action]) : action;
}

function actionVariant(log: AuditLogItem): BadgeVariant {
  if (log.category === 'settings') return 'ok';
  if (log.category === 'review') return log.action === 'review.run' || log.action === 'review.auto_penalty_resume' ? 'info' : 'warn';
  if (log.category === 'quota') return log.action.endsWith('delete') || log.action.endsWith('clear') ? 'muted' : 'ok';
  if (log.category === 'transfer') return log.detail?.status === 'partial' ? 'warn' : 'info';
  if (log.category === 'credit') return log.action === 'credit.revoke' ? 'muted' : 'ok';
  return 'info';
}

const TARGET_LABEL_KEYS: Record<string, string> = {
  'config:groupTeacherAccessEnabled': 'ai_helper_um_action_teacher_access',
  'review:auto_penalty': 'ai_helper_um_audit_target_auto_penalty',
};

function targetLabel(log: AuditLogItem): string {
  if (log.category === 'transfer') {
    const d = log.detail || {};
    const target = (log.target.label || '').split(' → ').pop() || String(d.targetDomainId ?? '');
    const what = Array.isArray(d.groupNames)
      ? (d.groupNames as unknown[]).map(String).join('、')
      : i18n('ai_helper_transfer_user_count', Array.isArray(d.uids) ? d.uids.length : 0);
    return `${what} → ${target}`;
  }
  if (log.action === 'group.backfill') return i18n('ai_helper_um_audit_target_backfill');
  const key = TARGET_LABEL_KEYS[`${log.target.type}:${log.target.id}`];
  if (key) return i18n(key);
  if (log.action === 'review.run') return log.target.label || i18n('ai_helper_review_trigger_all');
  return log.target.label || log.target.id;
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

const TRANSFER_STATUS_KEYS: Record<string, string> = {
  running: 'ai_helper_um_audit_transfer_running',
  partial: 'ai_helper_um_audit_transfer_partial',
  done: 'ai_helper_um_audit_transfer_done',
  undone: 'ai_helper_um_audit_transfer_undone',
};

/** 跨域转移的一行摘要：方式 · 源域 → 目标域 · 状态 */
function describeTransferAudit(log: AuditLogItem): string {
  const d = log.detail || {};
  const mode = d.mode === 'move' ? i18n('ai_helper_transfer_move') : i18n('ai_helper_transfer_copy');
  const status = TRANSFER_STATUS_KEYS[String(d.status)] ? i18n(TRANSFER_STATUS_KEYS[String(d.status)]) : '';
  return [mode, `${String(d.sourceDomainId ?? '')} → ${String(d.targetDomainId ?? '')}`, status].filter(Boolean).join(' · ');
}

const STEP_TYPE_KEYS: Record<string, string> = {
  join: 'ai_helper_um_audit_step_type_join',
  group: 'ai_helper_um_audit_step_type_group',
  relink: 'ai_helper_um_audit_step_type_relink',
  delete_group: 'ai_helper_um_audit_step_type_delete',
  leave: 'ai_helper_um_audit_step_type_leave',
  pull: 'ai_helper_um_audit_step_type_pull',
};

/** 跨域转移审计中每一步的说明（步骤详情来自服务端的 stepAuditDetail） */
export function describeTransferStep(step: NonNullable<AuditLogItem['steps']>[number]): string {
  const d = step.detail || {};
  const type = String(d.type || '');
  if (step.name === 'resume') return i18n('ai_helper_um_audit_step_resume');
  if (step.status === 'failed') {
    const label = STEP_TYPE_KEYS[type] ? i18n(STEP_TYPE_KEYS[type]) : step.name;
    return i18n('ai_helper_um_audit_step_failed', label, String(d.error || '—'));
  }
  const to = (d.to || {}) as Record<string, unknown>;
  switch (type) {
    case 'join': return i18n('ai_helper_um_audit_step_join', String(d.domainId), Number(d.count) || 0, String(d.role || '—'));
    case 'group': return d.created
      ? i18n('ai_helper_um_audit_step_group_created', String(d.domainId), String(d.name), Number(d.added) || 0)
      : i18n('ai_helper_um_audit_step_group_merged', String(d.domainId), String(d.name), Number(d.added) || 0);
    case 'relink': return i18n('ai_helper_um_audit_step_relink', String(d.quotaGroup), String(to.domainId), String(to.name));
    case 'delete_group': return i18n('ai_helper_um_audit_step_delete', String(d.domainId), String(d.name), Number(d.members) || 0);
    case 'leave': return i18n('ai_helper_um_audit_step_leave', String(d.domainId), Number(d.count) || 0);
    case 'pull': {
      const groups = Array.isArray(d.groups) ? (d.groups as unknown[]).map(String) : [];
      return groups.length
        ? i18n('ai_helper_um_audit_step_pull', String(d.domainId), groups.join('、'))
        : i18n('ai_helper_um_audit_step_pull_none', String(d.domainId));
    }
    default: return step.name;
  }
}

/** 信誉审计的摘要：重置（人数与原因）、复核为误判后撤销扣分（类别与分值） */
function describeCreditAudit(log: AuditLogItem): string {
  const d = log.detail || {};
  if (log.action === 'credit.reset') {
    return i18n('ai_helper_um_audit_credit_reset', Array.isArray(d.uids) ? d.uids.length : 0, String(d.reason || ''));
  }
  const category = typeof d.category === 'string' ? i18n(`ai_helper_admin_jailbreak_category_${d.category}`) : '—';
  return i18n('ai_helper_um_audit_credit_revoke', category, String(Math.round(Number(d.deduction || 0) * 100) / 100));
}

/** AI 抽查审计：手动抽查对象、熔断时的误判统计 */
function describeReviewAudit(log: AuditLogItem): string {
  const d = log.detail || {};
  if (log.action === 'review.run') {
    if (Array.isArray(d.uids)) return i18n('ai_helper_um_audit_review_run_users', d.uids.length);
    if (typeof d.conversationCount === 'number') return i18n('ai_helper_um_audit_review_run_conversations', d.conversationCount);
    return i18n('ai_helper_um_audit_review_run_all');
  }
  const stats = (log.action === 'review.breaker_trip' ? d : d.trippedStats) as Record<string, unknown> | undefined;
  if (stats && typeof stats.sample === 'number') {
    return i18n('ai_helper_um_audit_review_breaker', Number(stats.falsePositives || 0), stats.sample, `${Math.round(Number(stats.rate || 0) * 1000) / 10}%`);
  }
  return '—';
}

function changeSummary(log: AuditLogItem): string {
  if (log.category === 'review') return describeReviewAudit(log);
  if (log.category === 'group') return describeGroupAudit(log);
  if (log.category === 'quota') return describeQuotaAudit(log);
  if (log.category === 'transfer') return describeTransferAudit(log);
  if (log.category === 'credit') return describeCreditAudit(log);
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
  if (log.category === 'transfer') {
    const d = log.detail || {};
    lines.push(describeTransferAudit(log));
    if (Array.isArray(d.groupNames)) lines.push(i18n('ai_helper_um_audit_transfer_groups', (d.groupNames as unknown[]).map(String).join('、')));
    if (Array.isArray(d.uids)) {
      const uids = (d.uids as unknown[]).filter((uid): uid is number => typeof uid === 'number');
      lines.push(i18n('ai_helper_um_audit_transfer_users', uids.length, named(uids)));
    }
    if (d.targetGroup) lines.push(i18n('ai_helper_um_audit_transfer_target_group', String(d.targetGroup)));
    if (d.removeMembersFromSource) lines.push(i18n('ai_helper_um_audit_transfer_remove_members'));
    for (const step of log.steps || []) lines.push(describeTransferStep(step));
    return lines;
  }
  if (summary.added.length) lines.push(i18n('ai_helper_um_detail_added', summary.added.length, named(summary.added)));
  if (summary.removed.length) lines.push(i18n('ai_helper_um_detail_removed', summary.removed.length, named(summary.removed)));
  if (summary.joined.length) {
    lines.push(i18n('ai_helper_um_detail_joined', summary.joined.length, summary.joinRole || '—', named(summary.joined)));
  }
  if (summary.dismissed.length) lines.push(i18n('ai_helper_um_detail_dismissed', summary.dismissed.length, named(summary.dismissed)));
  if (log.action === 'group.meta' || log.action === 'settings.teacher_access') lines.push(changeSummary(log));
  if (log.action === 'group.backfill') {
    const d = log.detail || {};
    lines.push(i18n('ai_helper_um_audit_backfill_detail', Number(d.updated) || 0, Number(d.remaining) || 0, Number(d.groupCount) || 0));
    return lines;
  }
  if (log.category === 'review') {
    lines.push(changeSummary(log));
    const uids = Array.isArray(log.detail?.uids) ? (log.detail.uids as unknown[]).filter((uid): uid is number => typeof uid === 'number') : [];
    if (uids.length) lines.push(i18n('ai_helper_um_audit_review_run_users_list', uids.length, named(uids)));
    return lines;
  }
  if (log.category === 'credit') {
    lines.push(changeSummary(log));
    const uids = Array.isArray(log.detail?.uids) ? (log.detail.uids as unknown[]).filter((uid): uid is number => typeof uid === 'number') : [];
    if (uids.length) lines.push(i18n('ai_helper_um_audit_credit_users', uids.length, named(uids)));
    const before = Array.isArray(log.detail?.before) ? log.detail.before as Array<{ uid?: number; m?: number }> : [];
    if (before.length) {
      lines.push(i18n('ai_helper_um_audit_credit_before', before
        .map((item) => `${log.uidNames[String(item.uid)] || `#${item.uid}`} ${Math.round(Number(item.m) * 100) / 100}`)
        .join('、')));
    }
  }
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
  if (log.category === 'transfer' && log.detail?.status !== 'running') return TRANSFER_API.undo;
  return null;
}

function canResume(log: AuditLogItem): boolean {
  return log.category === 'transfer' && log.detail?.status === 'partial' && !log.undoneAt;
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
    const isTransfer = log.category === 'transfer';
    let confirmText = log.action === 'group.add' && joined
      ? `${i18n('ai_helper_um_undo_confirm')}\n${i18n('ai_helper_um_undo_confirm_joined', joined)}`
      : i18n('ai_helper_um_undo_confirm');
    if (isTransfer) {
      confirmText = i18n(log.detail?.status === 'partial' ? 'ai_helper_transfer_undo_partial_confirm' : 'ai_helper_transfer_undo_confirm');
    }
    if (!window.confirm(confirmText)) return;
    const failedText = i18n(isTransfer ? 'ai_helper_transfer_undo_failed' : 'ai_helper_group_undo_failed');
    setUndoing(true);
    try {
      await postJson(url, { auditId: log.id }, failedText);
      showToast(i18n('ai_helper_um_undo_done'), 'success');
      setDetail(null);
      load(page);
    } catch (err) {
      showToast(errorMessage(err, failedText), 'error');
    } finally {
      setUndoing(false);
    }
  };

  const resume = async (log: AuditLogItem) => {
    setUndoing(true);
    try {
      const res = await postJson<{ status: string }>(TRANSFER_API.resume, { auditId: log.id }, i18n('ai_helper_transfer_execute_failed'));
      showToast(i18n(res.status === 'done' ? 'ai_helper_transfer_resume_done' : 'ai_helper_transfer_resume_partial'), res.status === 'done' ? 'success' : 'warning');
      setDetail(null);
      load(page);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_transfer_execute_failed')), 'error');
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
            <option value="transfer">{i18n('ai_helper_um_audit_category_transfer')}</option>
            <option value="credit">{i18n('ai_helper_um_audit_category_credit')}</option>
            <option value="review">{i18n('ai_helper_um_audit_category_review')}</option>
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
              <div style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
                {canResume(detail) && (
                  <button type="button" disabled={undoing} onClick={() => resume(detail)} style={getButtonStyle('primary')}>
                    {i18n('ai_helper_transfer_resume')}
                  </button>
                )}
                <button type="button" disabled={undoing} onClick={() => undo(detail)} style={getButtonStyle(canResume(detail) ? 'secondary' : 'primary')}>
                  {canResume(detail) ? i18n('ai_helper_transfer_undo_partial') : i18n('ai_helper_um_undo_this')}
                </button>
              </div>
              <p style={{ ...mutedTextStyle, marginTop: SPACING.sm }}>
                {i18n(detail.category === 'transfer' ? 'ai_helper_transfer_undo_note' : 'ai_helper_um_undo_note')}
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
