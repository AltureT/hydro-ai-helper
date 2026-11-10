/**
 * 小组列表（设计稿“小组列表”）
 * 域切换、小组表格与批量选择、漂移侧栏、已删除小组提示、扩展信息编辑、新建小组
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { i18n } from '../utils/i18n';
import { Icon } from '../components/Icon';
import { formatDateTime } from '../utils/formatDate';
import {
  COLORS,
  SPACING,
  emptyStateStyle,
  getAlertStyle,
  getButtonStyle,
  getInputStyle,
  getTableCellStyle,
  getTableHeaderStyle,
  tableRootStyle,
} from '../utils/styles';
import { errorMessage, getJson, postJson } from './userManagementApi';
import {
  domainApiUrl,
  filterGroups,
  parseNameList,
  summarizeAuditDetail,
  validateGroupNameClient,
  type AuditListResponse,
  type AuditLogItem,
  type GroupKind,
  type GroupListItem,
  type GroupListResponse,
  type SearchResponse,
} from './userManagementLogic';
import { GroupBatchAddView } from './GroupBatchAddView';
import { TransferDialog } from './TransferDialog';
import { Badge, Drawer, Modal, TableScroll, labelStyle, linkButtonStyle, mutedTextStyle } from './userManagementUi';

interface GroupManagerPanelProps {
  initialDomainId: string;
  onOpenAudit: () => void;
  showToast: (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;
}

function kindLabel(kind?: GroupKind): string {
  if (!kind) return '—';
  return kind === 'class' ? i18n('ai_helper_um_kind_class') : i18n('ai_helper_um_kind_other');
}

function teacherNames(group: GroupListItem): string {
  const teachers = group.meta?.teachers || [];
  return teachers.length ? teachers.map((teacher) => teacher.uname).join('、') : '—';
}

/** 审计记录在小组侧栏中的一行摘要 */
export function describeGroupAudit(log: AuditLogItem): string {
  const summary = summarizeAuditDetail(log);
  switch (log.action) {
    case 'group.add':
      return summary.joined.length
        ? i18n('ai_helper_um_audit_change_add_joined', summary.added.length, summary.joined.length)
        : i18n('ai_helper_um_audit_change_add', summary.added.length);
    case 'group.remove':
      return i18n('ai_helper_um_audit_change_remove', summary.removed.length);
    case 'group.drift_restore':
      return i18n('ai_helper_um_audit_change_restore', summary.added.length);
    case 'group.drift_dismiss':
      return i18n('ai_helper_um_audit_change_dismiss', summary.dismissed.length);
    case 'group.meta':
      if (summary.created) return i18n('ai_helper_um_audit_change_created');
      if (summary.deleted) return i18n('ai_helper_um_audit_change_meta_deleted');
      return i18n('ai_helper_um_audit_change_meta');
    case 'group.backfill':
      return i18n('ai_helper_um_audit_change_backfill', Number(log.detail?.updated) || 0);
    default:
      return log.action;
  }
}

// ─── 编辑 / 新建弹窗 ─────────────────────────────────────────────────────────

const GroupEditModal: React.FC<{
  domainId: string;
  group: GroupListItem | null;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
  showToast: GroupManagerPanelProps['showToast'];
}> = ({ domainId, group, onClose, onSaved, showToast }) => {
  const creating = !group;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<GroupKind>(group?.meta?.kind || 'class');
  const [kindTouched, setKindTouched] = useState(!!group?.meta);
  const [academicYear, setAcademicYear] = useState(group?.meta?.academicYear || '');
  const [teachersText, setTeachersText] = useState((group?.meta?.teachers || []).map((t) => t.uname).join('\n'));
  const [archived, setArchived] = useState(!!group?.meta?.archived);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = creating && name ? validateGroupNameClient(name) : null;

  useEffect(() => {
    if (creating && !kindTouched) setKind(/^\d{4}级.+班$/.test(name.trim()) ? 'class' : 'other');
  }, [creating, kindTouched, name]);

  const save = async () => {
    const groupName = creating ? name.trim() : (group as GroupListItem).name;
    if (creating && validateGroupNameClient(groupName)) {
      setError(i18n(`ai_helper_group_name_err_${validateGroupNameClient(groupName)}`));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const names = parseNameList(teachersText);
      let teacherUids: number[] = [];
      if (names.length) {
        const found = await postJson<SearchResponse>(
          domainApiUrl(domainId, '/ai-helper/groups/search'),
          { mode: 'list', query: names.join('\n'), scope: 'all' },
          i18n('ai_helper_group_search_failed'),
        );
        if (found.unmatched?.length) {
          setError(i18n('ai_helper_um_teacher_unmatched', found.unmatched.join('、')));
          setSaving(false);
          return;
        }
        teacherUids = found.users.map((user) => user.uid);
      }
      const res = await postJson<{ created: boolean }>(
        domainApiUrl(domainId, '/ai-helper/groups/meta'),
        {
          groupName,
          kind,
          academicYear: academicYear.trim() || null,
          teacherUids,
          archived,
          ...(creating ? { create: true } : {}),
        },
        i18n('ai_helper_group_meta_failed'),
      );
      showToast(creating ? i18n('ai_helper_um_group_created', groupName) : i18n('ai_helper_um_group_saved'), 'success');
      onSaved(groupName, !!res.created);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_group_meta_failed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={creating ? i18n('ai_helper_um_new_group') : i18n('ai_helper_um_edit_group', (group as GroupListItem).name)}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose} style={getButtonStyle('secondary')}>{i18n('ai_helper_um_cancel')}</button>
          <button type="button" onClick={save} disabled={saving || !!nameError || (creating && !name.trim())} style={getButtonStyle('primary')}>
            {saving ? i18n('ai_helper_um_saving') : i18n('ai_helper_um_save')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: SPACING.md }}>
        {creating && (
          <div>
            <label style={labelStyle} htmlFor="ai-um-group-name">{i18n('ai_helper_um_group_name')}</label>
            <input
              id="ai-um-group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={i18n('ai_helper_um_group_name_placeholder')}
              style={{ ...getInputStyle(), marginTop: '6px', borderColor: nameError ? COLORS.error : COLORS.border }}
            />
            <div style={{ ...mutedTextStyle, marginTop: '4px', color: nameError ? COLORS.errorText : COLORS.textMuted }}>
              {nameError ? i18n(`ai_helper_group_name_err_${nameError}`) : i18n('ai_helper_um_group_name_rule')}
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SPACING.md }}>
          <div>
            <label style={labelStyle} htmlFor="ai-um-group-kind">{i18n('ai_helper_um_col_kind')}</label>
            <select
              id="ai-um-group-kind"
              value={kind}
              onChange={(event) => { setKind(event.target.value as GroupKind); setKindTouched(true); }}
              style={{ ...getInputStyle(), marginTop: '6px' }}
            >
              <option value="class">{i18n('ai_helper_um_kind_class')}</option>
              <option value="other">{i18n('ai_helper_um_kind_other')}</option>
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor="ai-um-group-year">{i18n('ai_helper_um_col_year')}</label>
            <input
              id="ai-um-group-year"
              value={academicYear}
              maxLength={16}
              onChange={(event) => setAcademicYear(event.target.value)}
              placeholder="2023"
              style={{ ...getInputStyle(), marginTop: '6px' }}
            />
          </div>
        </div>
        <div>
          <label style={labelStyle} htmlFor="ai-um-group-teachers">{i18n('ai_helper_um_col_teachers')}</label>
          <textarea
            id="ai-um-group-teachers"
            rows={3}
            value={teachersText}
            onChange={(event) => setTeachersText(event.target.value)}
            placeholder={i18n('ai_helper_um_teachers_placeholder')}
            style={{ ...getInputStyle(), marginTop: '6px', resize: 'vertical' }}
          />
          <div style={{ ...mutedTextStyle, marginTop: '4px' }}>{i18n('ai_helper_um_teachers_hint')}</div>
        </div>
        {!creating && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: SPACING.sm, fontSize: '14px' }}>
            <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />
            {i18n('ai_helper_um_archived_label')}
          </label>
        )}
        {error && <div style={getAlertStyle('error')}>{error}</div>}
      </div>
    </Modal>
  );
};

// ─── 小组侧栏 ────────────────────────────────────────────────────────────────

const GroupDrawer: React.FC<{
  domainId: string;
  group: GroupListItem;
  onClose: () => void;
  onChanged: () => void;
  onAddMembers: () => void;
  showToast: GroupManagerPanelProps['showToast'];
}> = ({ domainId, group, onClose, onChanged, onAddMembers, showToast }) => {
  const [recent, setRecent] = useState<AuditLogItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRecent = useCallback(async () => {
    try {
      const params = new URLSearchParams({ targetType: 'group', targetId: group.name, domainId, limit: '5' });
      const res = await getJson<AuditListResponse>(`${domainApiUrl(domainId, '/ai-helper/admin/audit')}?${params}`, i18n('ai_helper_audit_load_failed'));
      setRecent(res.logs);
    } catch {
      setRecent([]);
    }
  }, [domainId, group.name]);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  const resolveDrift = async (action: 'restore' | 'dismiss', uids: number[]) => {
    setBusy(true);
    try {
      const res = await postJson<{ restored: number[]; dismissed: number[] }>(
        domainApiUrl(domainId, '/ai-helper/groups/drift'),
        { groupName: group.name, action, uids },
        i18n('ai_helper_group_drift_failed'),
      );
      showToast(action === 'restore'
        ? i18n('ai_helper_um_drift_restored', res.restored.length)
        : i18n('ai_helper_um_drift_dismissed', res.dismissed.length), 'success');
      onChanged();
      loadRecent();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_group_drift_failed')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const undo = async (log: AuditLogItem) => {
    if (!window.confirm(i18n('ai_helper_um_undo_confirm'))) return;
    setBusy(true);
    try {
      await postJson(domainApiUrl(domainId, '/ai-helper/groups/undo'), { auditId: log.id }, i18n('ai_helper_group_undo_failed'));
      showToast(i18n('ai_helper_um_undo_done'), 'success');
      onChanged();
      loadRecent();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_group_undo_failed')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const subtitleParts = [
    kindLabel(group.meta?.kind),
    group.meta?.academicYear ? i18n('ai_helper_um_year_suffix', group.meta.academicYear) : null,
    group.meta?.teachers?.length ? i18n('ai_helper_um_teacher_prefix', teacherNames(group)) : null,
    i18n('ai_helper_um_member_count', group.memberCount),
  ].filter(Boolean);

  return (
    <Drawer title={group.name} subtitle={subtitleParts.join(' · ')} onClose={onClose}>
      {!group.existsInHydro && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.base }}>{i18n('ai_helper_um_group_missing_short')}</div>
      )}
      {group.drift.length > 0 && (
        <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.base }}>
          <div style={{ fontWeight: 600 }}>{i18n('ai_helper_um_drift_title', group.drift.length)}</div>
          <div style={{ fontSize: '13px', margin: '4px 0 8px' }}>{i18n('ai_helper_um_drift_explain')}</div>
          {group.drift.map((member) => (
            <div key={member.uid} style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, padding: '4px 0', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 160px' }}>{member.uname} <span style={{ color: COLORS.textMuted }}>uid {member.uid}</span></span>
              <button type="button" disabled={busy} style={linkButtonStyle} onClick={() => resolveDrift('restore', [member.uid])}>
                {i18n('ai_helper_um_restore')}
              </button>
              <button type="button" disabled={busy} style={{ ...linkButtonStyle, color: COLORS.textSecondary }} onClick={() => resolveDrift('dismiss', [member.uid])}>
                {i18n('ai_helper_um_dismiss')}
              </button>
            </div>
          ))}
          {group.drift.length > 1 && (
            <div style={{ display: 'flex', gap: SPACING.sm, marginTop: SPACING.sm, flexWrap: 'wrap' }}>
              <button type="button" disabled={busy} style={getButtonStyle('secondary')} onClick={() => resolveDrift('restore', group.drift.map((m) => m.uid))}>
                {i18n('ai_helper_um_restore_all')}
              </button>
              <button type="button" disabled={busy} style={getButtonStyle('ghost')} onClick={() => resolveDrift('dismiss', group.drift.map((m) => m.uid))}>
                {i18n('ai_helper_um_dismiss_all')}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ ...labelStyle, marginBottom: SPACING.sm }}>{i18n('ai_helper_um_recent_ops')}</div>
      {recent === null && <div style={mutedTextStyle}>{i18n('ai_helper_um_loading')}</div>}
      {recent && recent.length === 0 && <div style={mutedTextStyle}>{i18n('ai_helper_um_recent_ops_empty')}</div>}
      {recent && recent.map((log) => (
        <div key={log.id} style={{ display: 'flex', gap: SPACING.sm, alignItems: 'baseline', padding: '6px 0', borderBottom: `1px solid ${COLORS.border}`, fontSize: '13px', flexWrap: 'wrap' }}>
          <span style={{ color: COLORS.textMuted }}>{formatDateTime(log.at)}</span>
          <span>{log.actorName || i18n('ai_helper_um_actor_system')}</span>
          <span style={{ flex: '1 1 120px' }}>{describeGroupAudit(log)}{log.undoneAt ? i18n('ai_helper_um_undone_suffix') : ''}</span>
          {log.undoable && (
            <button type="button" disabled={busy} style={{ ...linkButtonStyle, fontSize: '13px' }} onClick={() => undo(log)}>
              {i18n('ai_helper_um_undo')}
            </button>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: SPACING.sm, marginTop: SPACING.lg, flexWrap: 'wrap' }}>
        <button type="button" style={getButtonStyle('primary')} onClick={onAddMembers}>
          <Icon name="plus" /> {i18n('ai_helper_um_add_members')}
        </button>
      </div>
    </Drawer>
  );
};

// ─── 主面板 ──────────────────────────────────────────────────────────────────

export const GroupManagerPanel: React.FC<GroupManagerPanelProps> = ({ initialDomainId, onOpenAudit, showToast }) => {
  const [domainId, setDomainId] = useState(initialDomainId);
  const [data, setData] = useState<GroupListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerName, setDrawerName] = useState<string | null>(null);
  const [editing, setEditing] = useState<GroupListItem | 'new' | null>(null);
  const [batchPreset, setBatchPreset] = useState<string | null | undefined>(undefined);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const query = showArchived ? '?includeArchived=1' : '';
      const res = await getJson<GroupListResponse>(`${domainApiUrl(domainId, '/ai-helper/groups')}${query}`, i18n('ai_helper_group_list_failed'));
      setData(res);
      setSelected((prev) => new Set([...prev].filter((name) => res.groups.some((group) => group.name === name))));
    } catch (err) {
      setLoadError(errorMessage(err, i18n('ai_helper_group_list_failed')));
    } finally {
      setLoading(false);
    }
  }, [domainId, showArchived]);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => filterGroups(data?.groups || [], keyword), [data, keyword]);
  const missingGroups = (data?.groups || []).filter((group) => !group.existsInHydro);
  const drawerGroup = drawerName ? (data?.groups || []).find((group) => group.name === drawerName) || null : null;
  const domainOptions = useMemo(() => {
    const list = data?.domains || [];
    return list.some((d) => d.id === domainId) ? list : [{ id: domainId, name: data?.domain.name || domainId }, ...list];
  }, [data, domainId]);
  const selectedGroups = (data?.groups || []).filter((group) => selected.has(group.name));

  const setArchived = async (archived: boolean) => {
    setBulkBusy(true);
    let failed = 0;
    for (const group of selectedGroups) {
      try {
        await postJson(domainApiUrl(domainId, '/ai-helper/groups/meta'), { groupName: group.name, archived }, i18n('ai_helper_group_meta_failed'));
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    if (failed) showToast(i18n('ai_helper_um_bulk_partial_failed', failed), 'warning');
    else showToast(archived ? i18n('ai_helper_um_archived_done') : i18n('ai_helper_um_unarchived_done'), 'success');
    load();
  };

  const deleteMeta = async (group: GroupListItem) => {
    if (!window.confirm(i18n('ai_helper_um_meta_delete_confirm', group.name))) return;
    try {
      await postJson(domainApiUrl(domainId, '/ai-helper/groups/meta'), { groupName: group.name, action: 'delete' }, i18n('ai_helper_group_meta_failed'));
      showToast(i18n('ai_helper_um_meta_deleted'), 'success');
      load();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_group_meta_failed')), 'error');
    }
  };

  const recreate = async (group: GroupListItem) => {
    try {
      const res = await postJson<{ restored: number[] }>(
        domainApiUrl(domainId, '/ai-helper/groups/drift'),
        { groupName: group.name, action: 'restore', uids: group.drift.map((member) => member.uid) },
        i18n('ai_helper_group_drift_failed'),
      );
      showToast(i18n('ai_helper_um_drift_restored', res.restored.length), 'success');
      load();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_group_drift_failed')), 'error');
    }
  };

  if (batchPreset !== undefined && data) {
    return (
      <GroupBatchAddView
        domainId={domainId}
        domainName={data.domain.name}
        groups={data.groups}
        joinRoles={data.joinRoles}
        defaultJoinRole={data.defaultJoinRole}
        presetGroup={batchPreset}
        onBack={(changed) => { setBatchPreset(undefined); if (changed) load(); }}
        onOpenAudit={onOpenAudit}
        showToast={showToast}
      />
    );
  }

  const allVisibleSelected = groups.length > 0 && groups.every((group) => selected.has(group.name));

  return (
    <div>
      {/* 工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.md, flexWrap: 'wrap', marginBottom: SPACING.base }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: SPACING.sm }}>
          <span style={labelStyle}>{i18n('ai_helper_um_domain')}</span>
          <select
            value={domainId}
            onChange={(event) => { setDomainId(event.target.value); setSelected(new Set()); setDrawerName(null); }}
            style={{ ...getInputStyle(), width: 'auto', minWidth: '180px' }}
          >
            {domainOptions.map((domain) => (
              <option key={domain.id} value={domain.id}>{`${domain.name}（${domain.id}）`}</option>
            ))}
          </select>
        </label>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={i18n('ai_helper_um_search_groups')}
          aria-label={i18n('ai_helper_um_search_groups')}
          style={{ ...getInputStyle(), width: 'auto', flex: '1 1 160px', maxWidth: '260px' }}
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '14px', color: COLORS.textSecondary }}>
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          {i18n('ai_helper_um_show_archived')}
        </label>
        <div style={{ display: 'flex', gap: SPACING.sm, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <button type="button" style={getButtonStyle('primary')} disabled={!data} onClick={() => setBatchPreset(null)}>
            <Icon name="users" /> {i18n('ai_helper_um_batch_title')}
          </button>
          <button type="button" style={getButtonStyle('secondary')} disabled={!data} onClick={() => setEditing('new')}>
            <Icon name="plus" /> {i18n('ai_helper_um_new_group')}
          </button>
        </div>
      </div>

      {loadError && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.base, display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>{loadError}</span>
          <button type="button" style={getButtonStyle('secondary')} onClick={load}>{i18n('ai_helper_um_retry')}</button>
        </div>
      )}

      {missingGroups.map((group) => (
        <div key={group.name} style={{ ...getAlertStyle('warning'), marginBottom: SPACING.sm, display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 300px' }}>{i18n('ai_helper_um_group_missing', group.name)}</span>
          {group.drift.length > 0 && (
            <button type="button" style={linkButtonStyle} onClick={() => recreate(group)}>
              {i18n('ai_helper_um_group_recreate', group.drift.length)}
            </button>
          )}
          <button type="button" style={{ ...linkButtonStyle, color: COLORS.textSecondary }} onClick={() => deleteMeta(group)}>
            {i18n('ai_helper_um_meta_delete')}
          </button>
        </div>
      ))}

      {selected.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap',
          padding: `${SPACING.sm} ${SPACING.md}`, marginBottom: SPACING.sm,
          background: COLORS.primaryLight, borderRadius: '8px', fontSize: '14px',
        }}>
          <span style={{ fontWeight: 600, color: COLORS.primaryHover }}>{i18n('ai_helper_um_groups_selected', selected.size)}</span>
          {selectedGroups.some((group) => !group.meta?.archived) && (
            <button type="button" disabled={bulkBusy} style={linkButtonStyle} onClick={() => setArchived(true)}>{i18n('ai_helper_um_archive')}</button>
          )}
          {selectedGroups.some((group) => group.meta?.archived) && (
            <button type="button" disabled={bulkBusy} style={linkButtonStyle} onClick={() => setArchived(false)}>{i18n('ai_helper_um_unarchive')}</button>
          )}
          {selectedGroups.some((group) => group.existsInHydro) && (
            <button type="button" disabled={bulkBusy} style={linkButtonStyle} onClick={() => setTransferOpen(true)}>{i18n('ai_helper_transfer_open_groups')}</button>
          )}
          <button type="button" style={{ ...linkButtonStyle, color: COLORS.textSecondary }} onClick={() => setSelected(new Set())}>
            {i18n('ai_helper_um_clear_selection')}
          </button>
        </div>
      )}

      {loading && !data && <div style={mutedTextStyle}>{i18n('ai_helper_um_loading')}</div>}

      {data && groups.length === 0 && (
        <div style={emptyStateStyle}>
          <div>{keyword ? i18n('ai_helper_um_no_group_match') : i18n('ai_helper_um_no_groups')}</div>
          {!keyword && (
            <button type="button" style={{ ...getButtonStyle('primary'), marginTop: SPACING.base }} onClick={() => setBatchPreset(null)}>
              {i18n('ai_helper_um_batch_title')}
            </button>
          )}
        </div>
      )}

      {data && groups.length > 0 && (
        <TableScroll>
          <table style={tableRootStyle}>
            <thead>
              <tr>
                <th style={{ ...getTableHeaderStyle(), width: '36px' }}>
                  <input
                    type="checkbox"
                    aria-label={i18n('ai_helper_um_select_all')}
                    checked={allVisibleSelected}
                    onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(groups.map((group) => group.name)))}
                  />
                </th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_group')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_kind')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_year')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_members')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_teachers')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_status')}</th>
                <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.name} style={{ background: selected.has(group.name) ? '#eff6ff' : 'transparent' }}>
                  <td style={getTableCellStyle()}>
                    <input
                      type="checkbox"
                      aria-label={group.name}
                      checked={selected.has(group.name)}
                      onChange={() => setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.name)) next.delete(group.name);
                        else next.add(group.name);
                        return next;
                      })}
                    />
                  </td>
                  <td style={{ ...getTableCellStyle(), fontWeight: 600 }}>{group.name}</td>
                  <td style={getTableCellStyle()}>{kindLabel(group.meta?.kind)}</td>
                  <td style={getTableCellStyle()}>{group.meta?.academicYear || '—'}</td>
                  <td style={getTableCellStyle()}>{group.memberCount}</td>
                  <td style={getTableCellStyle()}>{teacherNames(group)}</td>
                  <td style={getTableCellStyle()}>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {!group.existsInHydro && <Badge variant="err">{i18n('ai_helper_um_status_missing')}</Badge>}
                      {group.drift.length > 0 && <Badge variant="warn">{i18n('ai_helper_um_status_drift', group.drift.length)}</Badge>}
                      {group.meta?.archived && <Badge variant="muted">{i18n('ai_helper_um_status_archived')}</Badge>}
                      {group.existsInHydro && !group.drift.length && !group.meta?.archived && (
                        <Badge variant="ok">{i18n('ai_helper_um_status_ok')}</Badge>
                      )}
                    </div>
                  </td>
                  <td style={{ ...getTableCellStyle(), whiteSpace: 'nowrap' }}>
                    <button type="button" style={linkButtonStyle} onClick={() => setDrawerName(group.name)}>{i18n('ai_helper_um_members')}</button>
                    <button type="button" style={linkButtonStyle} onClick={() => setEditing(group)}>{i18n('ai_helper_um_edit')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {data && (
        <div style={{ ...mutedTextStyle, marginTop: SPACING.md }}>
          {i18n('ai_helper_um_groups_footer', groups.length)}
        </div>
      )}

      {drawerGroup && (
        <GroupDrawer
          domainId={domainId}
          group={drawerGroup}
          onClose={() => setDrawerName(null)}
          onChanged={load}
          onAddMembers={() => { setDrawerName(null); setBatchPreset(drawerGroup.existsInHydro ? drawerGroup.name : null); }}
          showToast={showToast}
        />
      )}

      {transferOpen && (
        <TransferDialog
          kind="groups"
          domains={domainOptions}
          sourceDomainId={domainId}
          groupNames={selectedGroups.filter((group) => group.existsInHydro).map((group) => group.name)}
          onClose={() => setTransferOpen(false)}
          onFinished={() => { setTransferOpen(false); setSelected(new Set()); load(); }}
          onOpenAudit={onOpenAudit}
        />
      )}

      {editing && (
        <GroupEditModal
          domainId={domainId}
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          showToast={showToast}
        />
      )}
    </div>
  );
};

export default GroupManagerPanel;
