/**
 * 按用户名批量添加成员（设计稿“批量添加成员”）
 * 1 查找用户 → 2 确认名单 → 3 加入小组；结果可撤销
 */

import React, { useMemo, useState } from 'react';
import { i18n } from '../utils/i18n';
import { Icon } from '../components/Icon';
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
  tableRootStyle,
} from '../utils/styles';
import { ApiError, errorMessage, postJson } from './userManagementApi';
import {
  MAX_BATCH_USERS,
  defaultSelection,
  domainApiUrl,
  membersOnlySelection,
  selectedNonMembers,
  validateGroupNameClient,
  type ApplyResponse,
  type GroupListItem,
  type SearchMode,
  type SearchResponse,
  type SearchScope,
} from './userManagementLogic';
import { Badge, PillGroup, TableScroll, labelStyle, linkButtonStyle, mutedTextStyle } from './userManagementUi';

const PREVIEW_ROWS = 8;

interface GroupBatchAddViewProps {
  domainId: string;
  domainName: string;
  groups: GroupListItem[];
  joinRoles: string[];
  defaultJoinRole: string | null;
  presetGroup?: string | null;
  onBack: (changed: boolean) => void;
  onOpenAudit: () => void;
  showToast: (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;
}

interface LastResult {
  action: 'add' | 'remove';
  groupName: string;
  response: ApplyResponse;
  undone?: boolean;
}

const StepHeader: React.FC<{ index: number; title: string; extra?: React.ReactNode }> = ({ index, title, extra }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap', marginBottom: SPACING.md }}>
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '26px', height: '26px', borderRadius: RADIUS.full,
      background: COLORS.primary, color: '#fff', fontSize: '13px', fontWeight: 700, flex: 'none',
    }}>{index}</span>
    <span style={{ fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>{title}</span>
    {extra}
  </div>
);

export const GroupBatchAddView: React.FC<GroupBatchAddViewProps> = ({
  domainId, domainName, groups, joinRoles, defaultJoinRole, presetGroup, onBack, onOpenAudit, showToast,
}) => {
  const existingGroups = useMemo(() => groups.filter((group) => group.existsInHydro), [groups]);
  const [mode, setMode] = useState<SearchMode>('prefix');
  const [scope, setScope] = useState<SearchScope>('domain');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [target, setTarget] = useState<'existing' | 'new'>(
    presetGroup || existingGroups.length ? 'existing' : 'new',
  );
  const [existingGroup, setExistingGroup] = useState<string>(presetGroup || existingGroups[0]?.name || '');
  const [newGroupName, setNewGroupName] = useState('');
  const [joinEnabled, setJoinEnabled] = useState(true);
  const [joinRole, setJoinRole] = useState<string>(defaultJoinRole || joinRoles[0] || '');
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [changed, setChanged] = useState(false);

  const users = result?.users || [];
  const managerCount = users.filter((user) => user.isManager).length;
  const nonMembers = selectedNonMembers(users, selected);
  const targetName = target === 'existing' ? existingGroup : newGroupName.trim();
  const newNameError = target === 'new' && newGroupName ? validateGroupNameClient(newGroupName) : null;
  const canSubmit = !!targetName && selected.size > 0 && !submitting
    && !(target === 'new' && validateGroupNameClient(newGroupName))
    && !(joinEnabled && nonMembers.length > 0 && !joinRole);

  const runSearch = async (silent = false) => {
    if (!query.trim()) {
      setSearchError(i18n('ai_helper_group_search_query_required'));
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const res = await postJson<SearchResponse>(
        domainApiUrl(domainId, '/ai-helper/groups/search'),
        { mode, query, scope },
        i18n('ai_helper_group_search_failed'),
      );
      setResult(res);
      if (!silent) {
        setSelected(defaultSelection(res.users));
        setExpanded(false);
      } else {
        const present = new Set(res.users.map((user) => user.uid));
        setSelected((prev) => new Set([...prev].filter((uid) => present.has(uid))));
      }
    } catch (err) {
      setSearchError(errorMessage(err, i18n('ai_helper_group_search_failed')));
      if (!silent) setResult(null);
    } finally {
      setSearching(false);
    }
  };

  const toggle = (uid: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const apply = async (action: 'add' | 'remove') => {
    if (!canSubmit && action === 'add') return;
    if (action === 'remove' && !window.confirm(i18n('ai_helper_um_batch_remove_confirm', selected.size, targetName))) return;
    setSubmitting(true);
    try {
      const response = await postJson<ApplyResponse>(
        domainApiUrl(domainId, '/ai-helper/groups/apply'),
        {
          groupName: targetName,
          action,
          uids: [...selected],
          ...(action === 'add' && joinEnabled && nonMembers.length > 0 ? { joinDomain: { role: joinRole } } : {}),
        },
        i18n('ai_helper_group_apply_failed'),
      );
      setLastResult({ action, groupName: targetName, response });
      setChanged(true);
      if (target === 'new') {
        setTarget('existing');
        setExistingGroup(targetName);
        setNewGroupName('');
      }
      await runSearch(true);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_group_apply_failed')), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const undo = async () => {
    if (!lastResult?.response.auditId) return;
    setUndoing(true);
    try {
      await postJson(domainApiUrl(domainId, '/ai-helper/groups/undo'), { auditId: lastResult.response.auditId }, i18n('ai_helper_group_undo_failed'));
      setLastResult({ ...lastResult, undone: true });
      showToast(i18n('ai_helper_um_undo_done'), 'success');
      await runSearch(true);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_group_undo_failed')), err instanceof ApiError && err.status === 409 ? 'warning' : 'error');
    } finally {
      setUndoing(false);
    }
  };

  const shownUsers = expanded ? users : users.slice(0, PREVIEW_ROWS);
  const allSelected = users.length > 0 && users.every((user) => selected.has(user.uid));

  const resultText = (() => {
    if (!lastResult) return '';
    const { action, groupName, response } = lastResult;
    if (action === 'add') {
      let text = i18n('ai_helper_um_batch_result_added', response.added.length, groupName);
      if (response.unchanged.length) text += i18n('ai_helper_um_batch_result_already', response.unchanged.length);
      if (response.joined.length) text += i18n('ai_helper_um_batch_result_joined', response.joined.length);
      return `${text}${i18n('ai_helper_um_period')}`;
    }
    let text = i18n('ai_helper_um_batch_result_removed', response.removed.length, groupName);
    if (response.unchanged.length) text += i18n('ai_helper_um_batch_result_not_in', response.unchanged.length);
    return `${text}${i18n('ai_helper_um_period')}`;
  })();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.base, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => onBack(changed)} style={linkButtonStyle}>
          <Icon name="arrowLeft" /> {i18n('ai_helper_um_nav_groups')}
        </button>
        <span style={{ color: COLORS.textMuted }}>/</span>
        <span style={{ fontWeight: 600, color: COLORS.textPrimary }}>{i18n('ai_helper_um_batch_title')}</span>
        <span style={{ ...mutedTextStyle, marginLeft: 'auto' }}>{i18n('ai_helper_um_current_domain', `${domainName}（${domainId}）`)}</span>
      </div>

      {/* Step 1 */}
      <section style={{ ...cardStyle, padding: SPACING.lg, marginBottom: SPACING.base }}>
        <StepHeader index={1} title={i18n('ai_helper_um_batch_step_find')} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.lg, marginBottom: SPACING.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' }}>
            <span style={labelStyle}>{i18n('ai_helper_um_batch_mode')}</span>
            <PillGroup<SearchMode>
              ariaLabel={i18n('ai_helper_um_batch_mode')}
              value={mode}
              onChange={setMode}
              options={[
                { id: 'prefix', label: i18n('ai_helper_um_batch_mode_prefix') },
                { id: 'regex', label: i18n('ai_helper_um_batch_mode_regex') },
                { id: 'list', label: i18n('ai_helper_um_batch_mode_list') },
              ]}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' }}>
            <span style={labelStyle}>{i18n('ai_helper_um_batch_scope')}</span>
            <PillGroup<SearchScope>
              ariaLabel={i18n('ai_helper_um_batch_scope')}
              value={mode === 'list' ? 'all' : scope}
              onChange={setScope}
              disabled={mode === 'list'}
              options={[
                { id: 'domain', label: i18n('ai_helper_um_batch_scope_domain') },
                { id: 'all', label: i18n('ai_helper_um_batch_scope_all') },
              ]}
            />
          </div>
        </div>
        <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-batch-query">
          {mode === 'prefix' ? i18n('ai_helper_um_batch_query_prefix')
            : mode === 'regex' ? i18n('ai_helper_um_batch_query_regex') : i18n('ai_helper_um_batch_query_list')}
        </label>
        <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {mode === 'list' ? (
            <textarea
              id="ai-um-batch-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              rows={6}
              placeholder={'2301张三\n2301李四'}
              style={{ ...getInputStyle(), flex: '1 1 320px', width: 'auto', resize: 'vertical' }}
            />
          ) : (
            <input
              id="ai-um-batch-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') runSearch(); }}
              placeholder={mode === 'prefix' ? '2301' : '^230[12]'}
              style={{ ...getInputStyle(), flex: '1 1 320px', width: 'auto' }}
            />
          )}
          <button type="button" onClick={() => runSearch()} disabled={searching} style={getButtonStyle('primary')}>
            <Icon name="search" /> {searching ? i18n('ai_helper_um_searching') : i18n('ai_helper_um_search')}
          </button>
        </div>
        <p style={{ ...mutedTextStyle, margin: `${SPACING.sm} 0 0` }}>
          {mode === 'list' ? i18n('ai_helper_um_batch_hint_list', MAX_BATCH_USERS) : i18n('ai_helper_um_batch_hint', MAX_BATCH_USERS)}
        </p>
        {searchError && <div style={{ ...getAlertStyle('error'), marginTop: SPACING.md }}>{searchError}</div>}
      </section>

      {/* Step 2 */}
      {result && (
        <section style={{ ...cardStyle, padding: SPACING.lg, marginBottom: SPACING.base }}>
          <StepHeader
            index={2}
            title={i18n('ai_helper_um_batch_step_confirm')}
            extra={result.overflow ? null : (
              <>
                <Badge variant="info">{i18n('ai_helper_um_batch_matched', users.length)}</Badge>
                <Badge variant="ok">{i18n('ai_helper_um_batch_selected', selected.size)}</Badge>
                {managerCount > 0 && <Badge variant="warn">{i18n('ai_helper_um_batch_managers_unselected', managerCount)}</Badge>}
              </>
            )}
          />
          {result.overflow && (
            <div style={getAlertStyle('warning')}>{i18n('ai_helper_um_batch_overflow', MAX_BATCH_USERS)}</div>
          )}
          {!!result.unmatched?.length && (
            <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.md }}>
              {i18n('ai_helper_um_batch_unmatched', result.unmatched.length)}
              <span style={{ overflowWrap: 'break-word' }}>{result.unmatched.slice(0, 30).join('、')}{result.unmatched.length > 30 ? ' …' : ''}</span>
            </div>
          )}
          {!result.overflow && users.length === 0 && (
            <div style={mutedTextStyle}>{i18n('ai_helper_um_batch_no_match')}</div>
          )}
          {users.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: SPACING.sm, marginBottom: SPACING.sm, flexWrap: 'wrap' }}>
                <button type="button" style={getButtonStyle('secondary')} onClick={() => setSelected(new Set(users.map((u) => u.uid)))}>
                  {i18n('ai_helper_um_select_all')}
                </button>
                <button type="button" style={getButtonStyle('secondary')} onClick={() => setSelected(membersOnlySelection(users))}>
                  {i18n('ai_helper_um_select_members_only')}
                </button>
                <button type="button" style={getButtonStyle('ghost')} onClick={() => setSelected(new Set())}>
                  {i18n('ai_helper_um_select_none')}
                </button>
              </div>
              <TableScroll>
                <table style={tableRootStyle}>
                  <thead>
                    <tr>
                      <th style={{ ...getTableHeaderStyle(), width: '36px' }}>
                        <input
                          type="checkbox"
                          aria-label={i18n('ai_helper_um_select_all')}
                          checked={allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(users.map((u) => u.uid)))}
                        />
                      </th>
                      <th style={getTableHeaderStyle()}>uid</th>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_uname')}</th>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_role')}</th>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_member')}</th>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_groups')}</th>
                      {scope === 'all' || mode === 'list' ? <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_domains')}</th> : null}
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_um_col_note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownUsers.map((user) => {
                      const inTarget = !!targetName && user.groups.includes(targetName);
                      return (
                        <tr key={user.uid} style={{ background: selected.has(user.uid) ? '#eff6ff' : 'transparent' }}>
                          <td style={getTableCellStyle()}>
                            <input
                              type="checkbox"
                              aria-label={user.uname}
                              checked={selected.has(user.uid)}
                              onChange={() => toggle(user.uid)}
                            />
                          </td>
                          <td style={{ ...getTableCellStyle(), color: COLORS.textMuted }}>{user.uid}</td>
                          <td style={getTableCellStyle()}>{user.uname}</td>
                          <td style={getTableCellStyle()}>{user.role || '—'}</td>
                          <td style={getTableCellStyle()}>
                            {user.isMember
                              ? <Badge variant="ok">{i18n('ai_helper_um_yes')}</Badge>
                              : <Badge variant="warn">{i18n('ai_helper_um_not_member_will_join')}</Badge>}
                          </td>
                          <td className="ai-um-wrap" style={getTableCellStyle()}>{user.groups.length ? user.groups.join('、') : '—'}</td>
                          {scope === 'all' || mode === 'list' ? (
                            <td className="ai-um-wrap" style={{ ...getTableCellStyle(), fontSize: '13px' }}>
                              {user.domains?.length ? user.domains.map((d) => d.name).join('、') : '—'}
                            </td>
                          ) : null}
                          <td style={{ ...getTableCellStyle(), fontSize: '13px', color: COLORS.textMuted }}>
                            {user.isManager ? i18n('ai_helper_um_note_manager') : inTarget ? i18n('ai_helper_um_note_in_target') : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
              {users.length > PREVIEW_ROWS && (
                <div style={{ ...mutedTextStyle, marginTop: SPACING.sm }}>
                  {expanded ? null : i18n('ai_helper_um_preview_more', PREVIEW_ROWS, users.length - PREVIEW_ROWS)}
                  <button type="button" style={linkButtonStyle} onClick={() => setExpanded(!expanded)}>
                    {expanded ? i18n('ai_helper_um_collapse') : i18n('ai_helper_um_expand_all')}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Step 3 */}
      {result && users.length > 0 && (
        <section style={{ ...cardStyle, padding: SPACING.lg, marginBottom: SPACING.base }}>
          <StepHeader index={3} title={i18n('ai_helper_um_batch_step_apply')} />
          <div style={{ display: 'grid', gap: SPACING.md }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.md, flexWrap: 'wrap' }}>
              <span style={labelStyle}>{i18n('ai_helper_um_target_group')}</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '14px' }}>
                <input
                  type="radio"
                  name="ai-um-target"
                  checked={target === 'existing'}
                  disabled={!existingGroups.length}
                  onChange={() => setTarget('existing')}
                />
                {i18n('ai_helper_um_target_existing')}
              </label>
              <select
                value={existingGroup}
                onChange={(event) => { setExistingGroup(event.target.value); setTarget('existing'); }}
                disabled={!existingGroups.length}
                style={{ ...getInputStyle(), width: 'auto', minWidth: '200px' }}
              >
                {existingGroups.map((group) => (
                  <option key={group.name} value={group.name}>
                    {i18n('ai_helper_um_group_option', group.name, group.memberCount)}
                  </option>
                ))}
              </select>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '14px' }}>
                <input type="radio" name="ai-um-target" checked={target === 'new'} onChange={() => setTarget('new')} />
                {i18n('ai_helper_um_target_new')}
              </label>
              <input
                value={newGroupName}
                onChange={(event) => { setNewGroupName(event.target.value); setTarget('new'); }}
                placeholder={i18n('ai_helper_um_group_name_placeholder')}
                aria-invalid={!!newNameError}
                style={{ ...getInputStyle(), width: 'auto', minWidth: '200px', borderColor: newNameError ? COLORS.error : COLORS.border }}
              />
            </div>
            <div style={{ ...mutedTextStyle, color: newNameError ? COLORS.errorText : COLORS.textMuted }}>
              {newNameError ? i18n(`ai_helper_group_name_err_${newNameError}`) : i18n('ai_helper_um_group_name_rule')}
            </div>

            {nonMembers.length > 0 && (
              <div style={{ ...getAlertStyle('info') }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' }}>
                  <input type="checkbox" checked={joinEnabled} onChange={(event) => setJoinEnabled(event.target.checked)} />
                  <span>{i18n('ai_helper_um_join_domain', nonMembers.length)}</span>
                  <select
                    value={joinRole}
                    onChange={(event) => setJoinRole(event.target.value)}
                    disabled={!joinEnabled}
                    style={{ ...getInputStyle(), width: 'auto', padding: '4px 8px' }}
                  >
                    {joinRoles.map((role) => (
                      <option key={role} value={role}>
                        {role === defaultJoinRole ? i18n('ai_helper_um_join_role_default', role) : role}
                      </option>
                    ))}
                  </select>
                </label>
                <div style={{ marginTop: '6px', fontSize: '13px' }}>
                  {joinEnabled ? i18n('ai_helper_um_join_domain_hint_on') : i18n('ai_helper_um_join_domain_hint_off')}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
              <button type="button" disabled={!canSubmit} onClick={() => apply('add')} style={{ ...getButtonStyle('primary'), opacity: canSubmit ? 1 : 0.55 }}>
                {submitting ? i18n('ai_helper_um_submitting') : i18n('ai_helper_um_add_to_group', selected.size, targetName || '…')}
              </button>
              {target === 'existing' && (
                <button
                  type="button"
                  disabled={!targetName || selected.size === 0 || submitting}
                  onClick={() => apply('remove')}
                  style={getButtonStyle('secondary')}
                >
                  {i18n('ai_helper_um_remove_from_group')}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {lastResult && (
        <div style={{ ...getAlertStyle(lastResult.undone ? 'info' : 'success'), display: 'flex', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 280px' }}>
            {lastResult.undone ? i18n('ai_helper_um_undo_done') : resultText}
          </span>
          {!lastResult.undone && lastResult.response.auditId && (
            <button type="button" disabled={undoing} onClick={undo} style={getButtonStyle('secondary')}>
              {i18n('ai_helper_um_undo_this')}
            </button>
          )}
          <button type="button" onClick={onOpenAudit} style={linkButtonStyle}>{i18n('ai_helper_um_view_audit')}</button>
        </div>
      )}
    </div>
  );
};

export default GroupBatchAddView;
