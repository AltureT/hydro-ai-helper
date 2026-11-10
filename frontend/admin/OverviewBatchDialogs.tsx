/**
 * 学生总览的批量操作（FR-051、FR-052）：加入 / 移出 Hydro 小组（可同时入域）、加入 / 移出额度组
 */

import React, { useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, SPACING, getAlertStyle, getButtonStyle, getInputStyle } from '../utils/styles';
import { errorMessage, getJson, postJson } from './userManagementApi';
import {
  domainApiUrl,
  validateGroupNameClient,
  type ApplyResponse,
  type GroupListResponse,
} from './userManagementLogic';
import { Modal, PillGroup, labelStyle, mutedTextStyle } from './userManagementUi';
import { nonMembersOf, type OverviewRow, type QuotaGroupView } from './quotaAdminLogic';
import { QUOTA_API, formatGroupLimit } from './quotaAdminUi';

type BatchAction = 'add' | 'remove';

function Who({ rows }: { rows: OverviewRow[] }) {
  return (
    <div style={{ fontSize: '14px', color: COLORS.textPrimary }}>
      {rows.slice(0, 8).map((row) => row.uname).join('、')}
      {rows.length > 8 ? ` ${i18n('ai_helper_um_and_more', rows.length - 8)}` : ''}
    </div>
  );
}

export const HydroGroupBatchDialog: React.FC<{
  rows: OverviewRow[];
  domains: Array<{ id: string; name: string }>;
  defaultDomainId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ rows, domains, defaultDomainId, onClose, onDone }) => {
  const [domainId, setDomainId] = useState(domains.some((d) => d.id === defaultDomainId) ? defaultDomainId : domains[0]?.id || defaultDomainId);
  const [action, setAction] = useState<BatchAction>('add');
  const [list, setList] = useState<GroupListResponse | null>(null);
  const [groupName, setGroupName] = useState('');
  const [joinDomain, setJoinDomain] = useState(true);
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setList(null);
    getJson<GroupListResponse>(domainApiUrl(domainId, '/ai-helper/groups'), i18n('ai_helper_group_list_failed'))
      .then((res) => {
        if (cancelled) return;
        setList(res);
        setRole(res.defaultJoinRole || res.joinRoles[0] || '');
      })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, i18n('ai_helper_group_list_failed'))); });
    return () => { cancelled = true; };
  }, [domainId]);

  const existing = (list?.groups || []).filter((group) => group.existsInHydro).map((group) => group.name);
  const outsiders = action === 'add' ? nonMembersOf(rows, domainId) : [];
  const nameError = groupName.trim() ? validateGroupNameClient(groupName) : 'empty';
  const isNew = !!groupName.trim() && !existing.includes(groupName.trim());
  const canSave = !saving && !!list && !nameError && (action === 'add' || !isNew) && (!outsiders.length || !joinDomain || !!role);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await postJson<ApplyResponse>(domainApiUrl(domainId, '/ai-helper/groups/apply'), {
        groupName: groupName.trim(),
        action,
        uids: rows.map((row) => row.uid),
        ...(action === 'add' && outsiders.length && joinDomain ? { joinDomain: { role } } : {}),
      }, i18n('ai_helper_group_apply_failed'));
      onDone(action === 'add'
        ? i18n('ai_helper_um_overview_group_added', res.added.length, groupName.trim(), res.joined.length)
        : i18n('ai_helper_um_overview_group_removed', res.removed.length, groupName.trim()));
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_group_apply_failed')));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={i18n('ai_helper_um_overview_group_dialog', rows.length)}
      onClose={onClose}
      width={520}
      footer={(
        <>
          <button type="button" style={getButtonStyle('ghost')} onClick={onClose}>{i18n('ai_helper_um_cancel')}</button>
          <button type="button" style={getButtonStyle(action === 'remove' ? 'danger' : 'primary')} onClick={save} disabled={!canSave}>
            {saving ? i18n('ai_helper_um_saving') : action === 'add' ? i18n('ai_helper_um_overview_do_add') : i18n('ai_helper_um_overview_do_remove')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: SPACING.base }}>
        <Who rows={rows} />
        <PillGroup<BatchAction>
          ariaLabel={i18n('ai_helper_um_overview_action')}
          value={action}
          onChange={setAction}
          options={[{ id: 'add', label: i18n('ai_helper_um_overview_add') }, { id: 'remove', label: i18n('ai_helper_um_overview_remove') }]}
        />
        <div style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
          <div>
            <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-batch-domain">{i18n('ai_helper_um_domain')}</label>
            <select id="ai-um-batch-domain" value={domainId} onChange={(event) => setDomainId(event.target.value)} style={{ ...getInputStyle(), width: 'auto' }}>
              {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: '180px' }}>
            <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-batch-group">{i18n('ai_helper_um_target_group')}</label>
            <input
              id="ai-um-batch-group"
              list="ai-um-batch-group-list"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder={i18n('ai_helper_um_overview_group_placeholder')}
              style={getInputStyle()}
            />
            <datalist id="ai-um-batch-group-list">
              {existing.map((name) => <option key={name} value={name} />)}
            </datalist>
          </div>
        </div>
        {isNew && action === 'add' && !nameError && <div style={mutedTextStyle}>{i18n('ai_helper_um_overview_group_new', groupName.trim())}</div>}
        {isNew && action === 'remove' && <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>{i18n('ai_helper_um_overview_group_missing')}</div>}
        {outsiders.length > 0 && list && (
          <div style={getAlertStyle('warning')}>
            <div>{i18n('ai_helper_um_overview_outsiders', outsiders.length, domains.find((d) => d.id === domainId)?.name || domainId)}</div>
            <label style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', marginTop: SPACING.sm, flexWrap: 'wrap' }}>
              <input type="checkbox" checked={joinDomain} onChange={(event) => setJoinDomain(event.target.checked)} />
              {i18n('ai_helper_um_overview_join_domain')}
              {joinDomain && (
                <select aria-label={i18n('ai_helper_um_join_role')} value={role} onChange={(event) => setRole(event.target.value)} style={{ ...getInputStyle(), width: 'auto' }}>
                  {list.joinRoles.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              )}
            </label>
          </div>
        )}
        {error && <div style={getAlertStyle('error')}>{error}</div>}
      </div>
    </Modal>
  );
};

export const QuotaGroupBatchDialog: React.FC<{
  rows: OverviewRow[];
  groups: QuotaGroupView[];
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ rows, groups, onClose, onDone }) => {
  const [action, setAction] = useState<BatchAction>('add');
  const [groupId, setGroupId] = useState(groups[0]?.id || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = groups.find((item) => item.id === groupId);

  const save = async () => {
    if (!group) return;
    setSaving(true);
    setError(null);
    try {
      const res = await postJson<{ changed: number[]; missing: number[] }>(QUOTA_API.groups, {
        action: 'members', id: group.id, op: action, uids: rows.map((row) => row.uid),
      }, i18n('ai_helper_quota_group_save_failed'));
      onDone(action === 'add'
        ? i18n('ai_helper_um_overview_qgroup_added', res.changed.length, group.name)
        : i18n('ai_helper_um_overview_qgroup_removed', res.changed.length, group.name));
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_quota_group_save_failed')));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={i18n('ai_helper_um_overview_qgroup_dialog', rows.length)}
      onClose={onClose}
      footer={(
        <>
          <button type="button" style={getButtonStyle('ghost')} onClick={onClose}>{i18n('ai_helper_um_cancel')}</button>
          <button type="button" style={getButtonStyle(action === 'remove' ? 'danger' : 'primary')} onClick={save} disabled={saving || !group}>
            {saving ? i18n('ai_helper_um_saving') : action === 'add' ? i18n('ai_helper_um_overview_do_add') : i18n('ai_helper_um_overview_do_remove')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: SPACING.base }}>
        <Who rows={rows} />
        <PillGroup<BatchAction>
          ariaLabel={i18n('ai_helper_um_overview_action')}
          value={action}
          onChange={setAction}
          options={[{ id: 'add', label: i18n('ai_helper_um_overview_add') }, { id: 'remove', label: i18n('ai_helper_um_overview_remove') }]}
        />
        {groups.length === 0 ? (
          <div style={mutedTextStyle}>{i18n('ai_helper_um_overview_no_qgroups')}</div>
        ) : (
          <div>
            <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-batch-qgroup">{i18n('ai_helper_um_qgroup_title')}</label>
            <select id="ai-um-batch-qgroup" value={groupId} onChange={(event) => setGroupId(event.target.value)} style={getInputStyle()}>
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {`${item.name} · ${formatGroupLimit(item.mode, item.dailyLimit)}${item.enabled ? '' : ` · ${i18n('ai_helper_um_qgroup_disabled')}`}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <div style={mutedTextStyle}>{i18n('ai_helper_um_overview_qgroup_hint')}</div>
        {error && <div style={getAlertStyle('error')}>{error}</div>}
      </div>
    </Modal>
  );
};
