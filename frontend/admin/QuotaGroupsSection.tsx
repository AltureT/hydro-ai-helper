/**
 * 额度组（设计稿“额度与信誉”）：表格、新建 / 编辑、启停、删除、成员与关联 Hydro 小组
 */

import React, { useCallback, useEffect, useState } from 'react';
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
import { Icon } from '../components/Icon';
import { errorMessage, getJson, postJson } from './userManagementApi';
import { domainApiUrl, type GroupListResponse } from './userManagementLogic';
import {
  Badge,
  Drawer,
  LoadingState,
  Modal,
  PillGroup,
  RefreshBar,
  TableScroll,
  labelStyle,
  linkButtonStyle,
  mutedTextStyle,
} from './userManagementUi';
import { UserPicker, type PickedUser } from './UserPicker';
import {
  QUOTA_GROUP_NAME_MAX,
  QUOTA_LIMIT_MAX,
  validateGroupForm,
  type GroupFormError,
  type QuotaGroupDetailResponse,
  type QuotaGroupMode,
  type QuotaGroupView,
  type QuotaGroupsResponse,
} from './quotaAdminLogic';
import { ConfirmModal, QUOTA_API, formatGroupLimit, formatGroupMembers } from './quotaAdminUi';

type ShowToast = (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;

const GROUP_ERROR_KEYS: Record<GroupFormError, string> = {
  name_required: 'ai_helper_um_qgroup_err_name',
  name_too_long: 'ai_helper_um_qgroup_err_name_long',
  limit_grant: 'ai_helper_quota_group_limit_grant_invalid',
  limit_cap: 'ai_helper_quota_group_limit_cap_invalid',
};

const OrderStep: React.FC<{ index: number; children: React.ReactNode }> = ({ index, children }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
    <span
      style={{
        width: '20px', height: '20px', borderRadius: RADIUS.full, background: COLORS.primaryLight, color: COLORS.primary,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700,
      }}
    >
      {index}
    </span>
    <span>{children}</span>
  </span>
);

const GroupFormModal: React.FC<{
  group: QuotaGroupView | null;
  onClose: () => void;
  onSaved: (group: QuotaGroupView, created: boolean) => void;
}> = ({ group, onClose, onSaved }) => {
  const [name, setName] = useState(group?.name || '');
  const [mode, setMode] = useState<QuotaGroupMode>(group?.mode || 'grant');
  const [limitText, setLimitText] = useState(group ? String(group.dailyLimit) : '');
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formError = validateGroupForm({ name, mode, limitText });

  const save = async () => {
    setTouched(true);
    if (formError) return;
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), mode, dailyLimit: Number(limitText.trim()), enabled };
      const res = await postJson<{ group: QuotaGroupView }>(
        QUOTA_API.groups,
        group ? { action: 'update', id: group.id, ...payload } : { action: 'create', ...payload },
        i18n('ai_helper_quota_group_save_failed'),
      );
      onSaved(res.group, !group);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_quota_group_save_failed')));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={group ? i18n('ai_helper_um_qgroup_edit_title', group.name) : i18n('ai_helper_um_qgroup_create_title')}
      onClose={onClose}
      footer={(
        <>
          <button type="button" style={getButtonStyle('ghost')} onClick={onClose}>{i18n('ai_helper_um_cancel')}</button>
          <button type="button" style={getButtonStyle('primary')} onClick={save} disabled={saving || (touched && !!formError)}>
            {saving ? i18n('ai_helper_um_saving') : i18n('ai_helper_um_save')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: SPACING.base }}>
        <div>
          <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-qgroup-name">{i18n('ai_helper_um_qgroup_name')}</label>
          <input
            id="ai-um-qgroup-name"
            value={name}
            maxLength={QUOTA_GROUP_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            placeholder={i18n('ai_helper_um_qgroup_name_placeholder')}
            style={getInputStyle()}
          />
        </div>
        <div>
          <div style={{ ...labelStyle, marginBottom: '6px' }}>{i18n('ai_helper_um_qgroup_type')}</div>
          <PillGroup<QuotaGroupMode>
            ariaLabel={i18n('ai_helper_um_qgroup_type')}
            value={mode}
            onChange={setMode}
            options={[
              { id: 'grant', label: i18n('ai_helper_um_qgroup_type_grant') },
              { id: 'cap', label: i18n('ai_helper_um_qgroup_type_cap') },
            ]}
          />
          <div style={{ ...mutedTextStyle, marginTop: '4px' }}>
            {mode === 'grant' ? i18n('ai_helper_um_qgroup_type_grant_hint') : i18n('ai_helper_um_qgroup_type_cap_hint')}
          </div>
        </div>
        <div>
          <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-qgroup-limit">{i18n('ai_helper_um_qgroup_limit')}</label>
          <input
            id="ai-um-qgroup-limit"
            type="number"
            min={mode === 'grant' ? 1 : 0}
            max={QUOTA_LIMIT_MAX}
            inputMode="numeric"
            value={limitText}
            onChange={(event) => setLimitText(event.target.value)}
            style={{ ...getInputStyle(), width: '160px' }}
          />
        </div>
        {!group && (
          <label style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', fontSize: '14px', color: COLORS.textSecondary }}>
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {i18n('ai_helper_um_qgroup_enable_now')}
          </label>
        )}
        {touched && formError && (
          <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>{i18n(GROUP_ERROR_KEYS[formError], QUOTA_LIMIT_MAX, QUOTA_GROUP_NAME_MAX)}</div>
        )}
        {error && <div style={getAlertStyle('error')}>{error}</div>}
      </div>
    </Modal>
  );
};

const MembersDrawer: React.FC<{
  groupId: string;
  domainId: string;
  domains: Array<{ id: string; name: string }>;
  onClose: () => void;
  onChanged: () => void;
  showToast: ShowToast;
}> = ({ groupId, domainId, domains, onClose, onChanged, showToast }) => {
  const [detail, setDetail] = useState<QuotaGroupDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [linkDomain, setLinkDomain] = useState(domainId);
  const [domainGroups, setDomainGroups] = useState<string[]>([]);
  const [linkName, setLinkName] = useState('');

  const load = useCallback(async () => {
    try {
      setDetail(await getJson<QuotaGroupDetailResponse>(
        `${QUOTA_API.groupDetail}?id=${encodeURIComponent(groupId)}`,
        i18n('ai_helper_quota_groups_failed'),
      ));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_quota_groups_failed')));
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!linkDomain) return;
    let cancelled = false;
    getJson<GroupListResponse>(domainApiUrl(linkDomain, '/ai-helper/groups'), i18n('ai_helper_group_list_failed'))
      .then((res) => {
        if (cancelled) return;
        const names = res.groups.filter((group) => group.existsInHydro).map((group) => group.name);
        setDomainGroups(names);
        setLinkName((current) => (names.includes(current) ? current : names[0] || ''));
      })
      .catch(() => { if (!cancelled) setDomainGroups([]); });
    return () => { cancelled = true; };
  }, [linkDomain]);

  const run = async (body: Record<string, unknown>, success: (res: any) => string) => {
    setBusy(true);
    try {
      const res = await postJson<any>(QUOTA_API.groups, { id: groupId, ...body }, i18n('ai_helper_quota_group_save_failed'));
      showToast(success(res), 'success');
      await load();
      onChanged();
      return true;
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_quota_group_save_failed')), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addPicked = async () => {
    const ok = await run(
      { action: 'members', op: 'add', uids: picked.map((user) => user.uid) },
      (res) => i18n('ai_helper_um_qgroup_members_added', res.changed.length),
    );
    if (ok) setPicked([]);
  };

  const group = detail?.group;
  return (
    <Drawer
      title={group ? i18n('ai_helper_um_qgroup_members_title', group.name) : i18n('ai_helper_um_loading')}
      subtitle={group ? `${formatGroupLimit(group.mode, group.dailyLimit)} · ${formatGroupMembers(group.directCount, group.linkedOnlyCount)}` : undefined}
      onClose={onClose}
    >
      {error && <div style={getAlertStyle('error')}>{error}</div>}
      {detail && group && (
        <div style={{ display: 'grid', gap: SPACING.lg }}>
          <section>
            <h4 style={{ margin: `0 0 ${SPACING.sm}`, fontSize: '15px', color: COLORS.textPrimary }}>{i18n('ai_helper_um_qgroup_direct')}</h4>
            <UserPicker
              domainId={domainId}
              selected={picked}
              onChange={setPicked}
              existing={new Set(detail.direct.map((user) => user.uid))}
            />
            {picked.length > 0 && (
              <button type="button" style={{ ...getButtonStyle('primary'), marginTop: SPACING.sm }} disabled={busy} onClick={addPicked}>
                {i18n('ai_helper_um_qgroup_add_n', picked.length)}
              </button>
            )}
            <div style={{ marginTop: SPACING.md, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, maxHeight: '240px', overflowY: 'auto' }}>
              {detail.direct.length === 0 && <div style={{ ...mutedTextStyle, padding: SPACING.sm }}>{i18n('ai_helper_um_qgroup_direct_empty')}</div>}
              {detail.direct.map((user) => (
                <div key={user.uid} style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, padding: `6px ${SPACING.sm}`, borderBottom: `1px solid ${COLORS.border}` }}>
                  <span style={{ fontWeight: 600, fontSize: '14px', color: COLORS.textPrimary }}>{user.uname}</span>
                  <span style={mutedTextStyle}>uid {user.uid}</span>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    style={linkButtonStyle}
                    disabled={busy}
                    onClick={() => run(
                      { action: 'members', op: 'remove', uids: [user.uid] },
                      () => i18n('ai_helper_um_qgroup_member_removed', user.uname),
                    )}
                  >
                    {i18n('ai_helper_um_remove')}
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h4 style={{ margin: `0 0 ${SPACING.sm}`, fontSize: '15px', color: COLORS.textPrimary }}>{i18n('ai_helper_um_qgroup_linked')}</h4>
            <div style={{ ...getAlertStyle('info'), marginBottom: SPACING.sm }}>{i18n('ai_helper_um_qgroup_linked_notice')}</div>
            {group.linkedGroups.length === 0 && <div style={mutedTextStyle}>{i18n('ai_helper_um_qgroup_linked_empty')}</div>}
            {group.linkedGroups.map((link) => (
              <div key={`${link.domainId}/${link.name}`} style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, padding: '6px 0', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: '14px', color: COLORS.textPrimary }}>{link.name}</span>
                <span style={mutedTextStyle}>@ {link.domainName}</span>
                {link.exists
                  ? <Badge variant="muted">{i18n('ai_helper_um_n_people', link.memberCount)}</Badge>
                  : <Badge variant="err" title={i18n('ai_helper_um_qgroup_link_missing_hint')}>{i18n('ai_helper_um_qgroup_link_missing')}</Badge>}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  style={linkButtonStyle}
                  disabled={busy}
                  onClick={() => run(
                    { action: 'unlink', link: { domainId: link.domainId, name: link.name } },
                    () => i18n('ai_helper_um_qgroup_unlinked', link.name),
                  )}
                >
                  {i18n('ai_helper_um_qgroup_unlink')}
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: SPACING.sm, marginTop: SPACING.sm, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                aria-label={i18n('ai_helper_um_domain')}
                value={linkDomain}
                onChange={(event) => setLinkDomain(event.target.value)}
                style={{ ...getInputStyle(), width: 'auto', maxWidth: '180px' }}
              >
                {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
              </select>
              <select
                aria-label={i18n('ai_helper_um_qgroup_link_group')}
                value={linkName}
                onChange={(event) => setLinkName(event.target.value)}
                disabled={!domainGroups.length}
                style={{ ...getInputStyle(), width: 'auto', maxWidth: '200px' }}
              >
                {!domainGroups.length && <option value="">{i18n('ai_helper_um_qgroup_link_no_groups')}</option>}
                {domainGroups.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <button
                type="button"
                style={getButtonStyle('secondary')}
                disabled={busy || !linkName}
                onClick={() => run(
                  { action: 'link', link: { domainId: linkDomain, name: linkName } },
                  (res) => (res.linked ? i18n('ai_helper_um_qgroup_linked_ok', linkName) : i18n('ai_helper_um_qgroup_linked_already', linkName)),
                )}
              >
                {i18n('ai_helper_um_qgroup_link')}
              </button>
            </div>
          </section>
        </div>
      )}
    </Drawer>
  );
};

export const QuotaGroupsSection: React.FC<{ domainId: string; showToast: ShowToast }> = ({ domainId, showToast }) => {
  const [data, setData] = useState<QuotaGroupsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<QuotaGroupView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<QuotaGroupView | null>(null);
  const [membersOf, setMembersOf] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getJson<QuotaGroupsResponse>(QUOTA_API.groups, i18n('ai_helper_quota_groups_failed')));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_quota_groups_failed')));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (group: QuotaGroupView) => {
    setBusyId(group.id);
    try {
      await postJson(QUOTA_API.groups, { action: 'update', id: group.id, enabled: !group.enabled }, i18n('ai_helper_quota_group_save_failed'));
      showToast(group.enabled ? i18n('ai_helper_um_qgroup_disabled_ok', group.name) : i18n('ai_helper_um_qgroup_enabled_ok', group.name), 'success');
      await load();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_quota_group_save_failed')), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await postJson(QUOTA_API.groups, { action: 'delete', id: deleting.id }, i18n('ai_helper_quota_group_save_failed'));
      showToast(i18n('ai_helper_um_qgroup_deleted', deleting.name), 'success');
      setDeleting(null);
      await load();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_quota_group_save_failed')), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const th = getTableHeaderStyle();
  const td = getTableCellStyle();

  return (
    <section style={{ ...cardStyle, padding: SPACING.lg }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: SPACING.sm, flexWrap: 'wrap', marginBottom: SPACING.base }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>{i18n('ai_helper_um_qgroup_title')}</h3>
        <span style={mutedTextStyle}>{i18n('ai_helper_um_qgroup_subtitle')}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={{ ...getButtonStyle('primary'), display: 'inline-flex', alignItems: 'center', gap: '6px' }} onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} />
          {i18n('ai_helper_um_qgroup_create')}
        </button>
      </div>

      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: SPACING.sm, alignItems: 'center', fontSize: '13px', color: COLORS.textSecondary,
          background: COLORS.bgPage, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, padding: `${SPACING.sm} ${SPACING.md}`,
          marginBottom: SPACING.base,
        }}
      >
        <strong style={{ color: COLORS.textPrimary, marginRight: SPACING.xs }}>{i18n('ai_helper_um_qgroup_order')}</strong>
        <OrderStep index={1}>{i18n('ai_helper_um_qgroup_order_1')}</OrderStep>
        <span aria-hidden="true">→</span>
        <OrderStep index={2}>{i18n('ai_helper_um_qgroup_order_2')}</OrderStep>
        <span aria-hidden="true">→</span>
        <OrderStep index={3}>{i18n('ai_helper_um_qgroup_order_3')}</OrderStep>
      </div>

      {error && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.md, display: 'flex', gap: SPACING.sm, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" style={getButtonStyle('secondary')} onClick={load}>{i18n('ai_helper_um_retry')}</button>
        </div>
      )}
      {loading && !data && <LoadingState label={i18n('ai_helper_um_loading')} />}
      <RefreshBar loading={loading && !!data} />

      {data && (
        <TableScroll>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>{i18n('ai_helper_um_qgroup_name')}</th>
                <th style={th}>{i18n('ai_helper_um_qgroup_type')}</th>
                <th style={th}>{i18n('ai_helper_um_qgroup_limit')}</th>
                <th style={th}>{i18n('ai_helper_um_qgroup_members')}</th>
                <th style={th}>{i18n('ai_helper_um_qgroup_linked')}</th>
                <th style={th}>{i18n('ai_helper_um_qgroup_state')}</th>
                <th style={th}>{i18n('ai_helper_um_col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.length === 0 && (
                <tr><td colSpan={7} style={{ ...td, color: COLORS.textMuted, textAlign: 'center' }}>{i18n('ai_helper_um_qgroup_empty')}</td></tr>
              )}
              {data.groups.map((group) => {
                const stale = group.linkedGroups.filter((link) => !link.exists);
                return (
                  <tr key={group.id} style={{ opacity: group.enabled ? 1 : 0.75 }}>
                    <td style={{ ...td, fontWeight: 600, color: COLORS.textPrimary }}>{group.name}</td>
                    <td style={td}>
                      <Badge variant={group.mode === 'grant' ? 'ok' : 'warn'}>
                        {group.mode === 'grant' ? i18n('ai_helper_um_qgroup_type_grant') : i18n('ai_helper_um_qgroup_type_cap')}
                      </Badge>
                    </td>
                    <td style={td}>{formatGroupLimit(group.mode, group.dailyLimit)}</td>
                    <td style={td}>{formatGroupMembers(group.directCount, group.linkedOnlyCount)}</td>
                    <td className="ai-um-wrap" style={td}>
                      {group.linkedGroups.length === 0 ? '—' : group.linkedGroups.map((link) => `${link.name} @ ${link.domainName}`).join('、')}
                      {stale.length > 0 && (
                        <div style={{ color: COLORS.errorText, fontSize: '12px', marginTop: '2px' }}>
                          {i18n('ai_helper_um_qgroup_stale_links', stale.map((link) => link.name).join('、'))}
                        </div>
                      )}
                    </td>
                    <td style={td}>
                      <Badge variant={group.enabled ? 'ok' : 'muted'}>
                        {group.enabled ? i18n('ai_helper_um_qgroup_enabled') : i18n('ai_helper_um_qgroup_disabled')}
                      </Badge>
                    </td>
                    <td style={td}>
                      <button type="button" style={linkButtonStyle} disabled={busyId === group.id} onClick={() => toggle(group)}>
                        {group.enabled ? i18n('ai_helper_um_qgroup_disable') : i18n('ai_helper_um_qgroup_enable')}
                      </button>
                      <button type="button" style={linkButtonStyle} onClick={() => setMembersOf(group.id)}>{i18n('ai_helper_um_qgroup_members')}</button>
                      <button type="button" style={linkButtonStyle} onClick={() => setEditing(group)}>{i18n('ai_helper_um_edit')}</button>
                      <button type="button" style={{ ...linkButtonStyle, color: COLORS.errorText }} onClick={() => setDeleting(group)}>{i18n('ai_helper_um_delete')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      <div style={{ ...mutedTextStyle, marginTop: SPACING.sm }}>{i18n('ai_helper_um_qgroup_footnote')}</div>

      {editing && (
        <GroupFormModal
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(group, created) => {
            setEditing(null);
            showToast(created ? i18n('ai_helper_um_qgroup_created', group.name) : i18n('ai_helper_um_qgroup_saved', group.name), 'success');
            load();
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={i18n('ai_helper_um_qgroup_delete_title', deleting.name)}
          message={i18n('ai_helper_um_qgroup_delete_message', deleting.name, deleting.totalCount)}
          confirmLabel={i18n('ai_helper_um_delete')}
          danger
          busy={busyId === deleting.id}
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      )}
      {membersOf && data && (
        <MembersDrawer
          groupId={membersOf}
          domainId={domainId}
          domains={data.domains}
          onClose={() => setMembersOf(null)}
          onChanged={load}
          showToast={showToast}
        />
      )}
    </section>
  );
};
