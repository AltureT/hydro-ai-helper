/**
 * 跨域复制或移动（设计稿“跨域转移”，US9）
 *
 * 两个入口：小组列表对选中的小组操作（kind = groups）；学生总览对选中的学生操作（kind = users）。
 * 表单每次变化都会重新预览（只读），确认时带上 previewToken；预览过期或数据变化时自动重新预览。
 * 执行后展示每一步的结果，部分完成时可继续完成剩余部分，也可撤销已完成部分。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING, getAlertStyle, getButtonStyle, getInputStyle } from '../utils/styles';
import { ApiError, errorMessage, getJson, postJson } from './userManagementApi';
import { domainApiUrl, validateGroupNameClient, type GroupListResponse } from './userManagementLogic';
import { Badge, Modal, labelStyle, linkButtonStyle, mutedTextStyle } from './userManagementUi';
import {
  defaultSelection,
  isSelectable,
  remainingWork,
  sanitizeSelection,
  unresolvedConflicts,
  userTransferCounts,
  type ConflictChoice,
  type TransferKind,
  type TransferMode,
  type TransferPreview,
  type TransferProblem,
  type TransferRunResult,
  type TransferSummaryItem,
} from './transferLogic';

export const TRANSFER_API = {
  preview: '/ai-helper/admin/transfer/preview',
  execute: '/ai-helper/admin/transfer/execute',
  resume: '/ai-helper/admin/transfer/resume',
  undo: '/ai-helper/admin/transfer/undo',
};

const PREVIEW_DEBOUNCE_MS = 350;

interface DomainOption { id: string; name: string }

export interface TransferDialogProps {
  kind: TransferKind;
  domains: DomainOption[];
  /** 小组模式：固定为当前域；学生模式：默认源域，可改 */
  sourceDomainId: string;
  groupNames?: string[];
  users?: Array<{ uid: number; uname: string }>;
  /** 学生模式：来自学生总览的筛选条件说明 */
  sourceNote?: string;
  onClose: () => void;
  /** 关闭对话框时调用；changed 表示执行过写操作，父组件应刷新 */
  onFinished: (changed: boolean) => void;
  onOpenAudit?: () => void;
}

type ConflictDraft = { type: 'merge' | 'rename' | ''; renameTo: string };

function domainLabel(domains: DomainOption[], id: string, fallback?: string): string {
  const name = domains.find((domain) => domain.id === id)?.name || fallback || id;
  return name === id ? id : `${name}（${id}）`;
}

function problemText(problem: TransferProblem, preview: TransferPreview): string | null {
  const group = preview.groups?.find((item) => item.name === problem.group);
  switch (problem.code) {
    case 'SOURCE_GROUP_MISSING': return i18n('ai_helper_transfer_problem_source_missing', problem.group || '');
    case 'RENAME_TAKEN': return i18n('ai_helper_transfer_problem_rename_taken', group?.targetName || '');
    case 'DUPLICATE_TARGET': return i18n('ai_helper_transfer_problem_duplicate', group?.targetName || problem.group || '');
    case 'USER_NOT_FOUND': return i18n('ai_helper_transfer_problem_user_missing', problem.uid ?? '');
    case 'TOO_MANY_MEMBERS': return i18n('ai_helper_transfer_problem_too_many');
    default: return null; // CONFLICT_UNRESOLVED 由同名小组的选项提示
  }
}

function summaryText(item: TransferSummaryItem): string {
  const done = item.status === 'done';
  switch (item.type) {
    case 'join':
      return done ? i18n('ai_helper_transfer_result_join', item.done) : i18n('ai_helper_transfer_result_join_partial', item.done, item.total);
    case 'leave':
      return done ? i18n('ai_helper_transfer_result_leave', item.done) : i18n('ai_helper_transfer_result_leave_partial', item.done, item.total);
    case 'group':
      if (!done) return i18n('ai_helper_transfer_result_group_pending', item.name || '');
      return item.created
        ? i18n('ai_helper_transfer_result_group_created', item.name || '', item.added ?? 0)
        : i18n('ai_helper_transfer_result_group_merged', item.name || '', item.added ?? 0);
    case 'relink':
      return done ? i18n('ai_helper_transfer_result_relink', item.name || '') : i18n('ai_helper_transfer_result_relink_pending', item.name || '');
    case 'delete_group':
      return done ? i18n('ai_helper_transfer_result_delete', item.name || '') : i18n('ai_helper_transfer_result_delete_pending', item.name || '');
    case 'pull':
      return done ? i18n('ai_helper_transfer_result_pull', item.total) : i18n('ai_helper_transfer_result_pull_pending', item.total);
    default:
      return item.type;
  }
}

const bulletStyle: React.CSSProperties = { display: 'flex', gap: '10px', alignItems: 'flex-start', fontSize: '14px', lineHeight: 1.6 };

function Bullet({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'muted' | 'ok' | 'err'; children: React.ReactNode }) {
  const color = { info: COLORS.primary, warn: COLORS.warning, muted: COLORS.textMuted, ok: COLORS.success, err: COLORS.error }[tone];
  return (
    <div style={bulletStyle}>
      <span aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, marginTop: '7px', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, color: tone === 'muted' ? COLORS.textMuted : COLORS.textPrimary }}>{children}</div>
    </div>
  );
}

function ModeOption({ active, title, hint, onClick }: { active: boolean; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${title}：${hint}`}
      onClick={onClick}
      style={{
        display: 'flex', gap: '10px', alignItems: 'flex-start', textAlign: 'left', flex: '1 1 200px',
        padding: '12px 14px', borderRadius: '10px', fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit',
        border: `1px solid ${active ? COLORS.primary : COLORS.border}`, background: active ? COLORS.primaryLight : COLORS.bgCard,
        color: COLORS.textPrimary,
      }}
    >
      <span aria-hidden="true" style={{
        width: '14px', height: '14px', borderRadius: '50%', marginTop: '3px', flexShrink: 0, boxSizing: 'border-box',
        border: `${active ? 4 : 1.5}px solid ${active ? COLORS.primary : COLORS.textMuted}`, background: COLORS.bgCard,
      }} />
      <span>
        <strong style={{ display: 'block' }}>{title}</strong>
        <span style={mutedTextStyle}>{hint}</span>
      </span>
    </button>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ ...labelStyle, display: 'block', marginBottom: '6px' }}>{label}</label>
      {children}
    </div>
  );
}

export const TransferDialog: React.FC<TransferDialogProps> = ({
  kind, domains, sourceDomainId, groupNames = [], users = [], sourceNote, onClose, onFinished, onOpenAudit,
}) => {
  const [sourceId, setSourceId] = useState(sourceDomainId);
  const targetOptions = domains.filter((domain) => domain.id !== sourceId);
  const [targetId, setTargetId] = useState(targetOptions[0]?.id || '');
  const [mode, setMode] = useState<TransferMode>('copy');
  const [conflictDrafts, setConflictDrafts] = useState<Record<string, ConflictDraft>>({});
  const [removeMembers, setRemoveMembers] = useState(false);
  const [putInGroup, setPutInGroup] = useState(false);
  const [targetGroupName, setTargetGroupName] = useState('');
  const [targetGroups, setTargetGroups] = useState<string[]>([]);
  const [joinRole, setJoinRole] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showList, setShowList] = useState(false);

  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [previewedKey, setPreviewedKey] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [phase, setPhase] = useState<'form' | 'running' | 'result'>('form');
  const [result, setResult] = useState<TransferRunResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const selectionSource = useRef<string | null>(null);

  // 源域变化后目标域不能与之相同
  useEffect(() => {
    if (!targetId || targetId === sourceId) setTargetId(domains.find((domain) => domain.id !== sourceId)?.id || '');
  }, [sourceId, targetId, domains]);

  // 学生模式：目标域已有的小组（用于“同时放入目标域小组”的候选）
  useEffect(() => {
    if (kind !== 'users' || !targetId) { setTargetGroups([]); return undefined; }
    let cancelled = false;
    getJson<GroupListResponse>(domainApiUrl(targetId, '/ai-helper/groups'), i18n('ai_helper_group_list_failed'))
      .then((res) => { if (!cancelled) setTargetGroups(res.groups.filter((group) => group.existsInHydro).map((group) => group.name)); })
      .catch(() => { if (!cancelled) setTargetGroups([]); });
    return () => { cancelled = true; };
  }, [kind, targetId]);

  const targetGroupError = putInGroup ? validateGroupNameClient(targetGroupName) : null;

  const request = useMemo(() => {
    if (!targetId) return null;
    const base = { kind, mode, sourceDomainId: sourceId, targetDomainId: targetId };
    if (kind === 'groups') {
      const conflicts: Record<string, ConflictChoice> = {};
      for (const [name, draft] of Object.entries(conflictDrafts)) {
        if (draft.type === 'merge') conflicts[name] = 'merge';
        else if (draft.type === 'rename' && draft.renameTo.trim() && !validateGroupNameClient(draft.renameTo)) {
          conflicts[name] = { renameTo: draft.renameTo.trim() };
        }
      }
      return { ...base, groupNames, conflicts };
    }
    return { ...base, uids: users.map((user) => user.uid), targetGroup: putInGroup && !targetGroupError ? targetGroupName.trim() : null };
  }, [kind, mode, sourceId, targetId, groupNames, users, conflictDrafts, putInGroup, targetGroupName, targetGroupError]);
  const requestKey = request ? JSON.stringify(request) : '';

  // 实时预览（去抖）；过期或数据变化时通过 refreshNonce 强制刷新
  useEffect(() => {
    if (!request || phase !== 'form') return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      postJson<TransferPreview>(TRANSFER_API.preview, request, i18n('ai_helper_transfer_preview_failed'))
        .then((res) => {
          if (cancelled) return;
          setPreview(res);
          setPreviewedKey(requestKey);
          setPreviewError(null);
          setJoinRole((prev) => (prev && res.joinRoles.includes(prev) ? prev : res.defaultJoinRole || res.joinRoles[0] || ''));
          if (res.users) {
            // 先判断再更新 ref：setSelected 的回调要到下次渲染才执行，那时 ref 已是新值，
            // 若在回调里比较，第一次预览就会被当成“同一源域”，默认勾选永远为空
            const key = `${res.source.id}`;
            const users = res.users;
            const sameSource = selectionSource.current === key;
            selectionSource.current = key;
            setSelected((prev) => (sameSource ? sanitizeSelection(prev, users, res.mode) : defaultSelection(users, res.mode)));
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewedKey('');
          setPreviewError(errorMessage(err, i18n('ai_helper_transfer_preview_failed')));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, refreshNonce, phase]);

  const fresh = !!preview && previewedKey === requestKey;
  const conflictsLeft = unresolvedConflicts(fresh ? preview : null);
  const problemLines = fresh && preview ? preview.problems.map((problem) => problemText(problem, preview)).filter((text): text is string => !!text) : [];
  const counts = kind === 'users' && preview?.users ? userTransferCounts(preview.users, selected, preview.mode) : null;
  const ownerUser = kind === 'users' && preview?.mode === 'move' ? preview.users?.find((user) => user.isOwner) : undefined;
  const joinCount = kind === 'groups' ? preview?.joinUids.length || 0 : counts?.join || 0;
  const managersUnchecked = kind === 'users' && preview?.users
    ? preview.users.filter((user) => user.isManager && !user.isOwner && !selected.has(user.uid)).length
    : 0;

  const canConfirm = phase === 'form' && fresh && !!preview && !preview.problems.length
    && !targetGroupError && (joinCount === 0 || !!joinRole) && (kind === 'groups' || (counts?.selected || 0) > 0);

  const closeDialog = () => {
    if (phase === 'running') return;
    if (changed) onFinished(true);
    else onClose();
  };

  const execute = async () => {
    if (!preview || !request) return;
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      setNotice(i18n('ai_helper_transfer_preview_refreshed'));
      setRefreshNonce((n) => n + 1);
      return;
    }
    setPhase('running');
    setActionError(null);
    setNotice(null);
    try {
      const res = await postJson<TransferRunResult>(TRANSFER_API.execute, {
        ...request,
        previewToken: preview.previewToken,
        ...(joinCount ? { joinRole } : {}),
        ...(kind === 'groups' && mode === 'move' ? { removeMembersFromSource: removeMembers } : {}),
        ...(kind === 'users' ? { selectedUids: [...selected].sort((a, b) => a - b) } : {}),
      }, i18n('ai_helper_transfer_execute_failed'));
      setChanged(true);
      setResult(res);
      setPhase('result');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setPhase('form');
      if (code === 'PREVIEW_STALE' || code === 'PREVIEW_EXPIRED') {
        setNotice(i18n(code === 'PREVIEW_STALE' ? 'ai_helper_transfer_preview_changed' : 'ai_helper_transfer_preview_refreshed'));
        setRefreshNonce((n) => n + 1);
      } else {
        setActionError(errorMessage(err, i18n('ai_helper_transfer_execute_failed')));
      }
    }
  };

  const resume = async () => {
    if (!result) return;
    setPhase('running');
    setActionError(null);
    try {
      setResult(await postJson<TransferRunResult>(TRANSFER_API.resume, { auditId: result.auditId }, i18n('ai_helper_transfer_execute_failed')));
    } catch (err) {
      setActionError(errorMessage(err, i18n('ai_helper_transfer_execute_failed')));
    }
    setPhase('result');
  };

  const undo = async () => {
    if (!result) return;
    const confirmKey = result.status === 'partial' ? 'ai_helper_transfer_undo_partial_confirm' : 'ai_helper_transfer_undo_confirm';
    if (!window.confirm(i18n(confirmKey))) return;
    setPhase('running');
    setActionError(null);
    try {
      await postJson<{ undone: number }>(TRANSFER_API.undo, { auditId: result.auditId }, i18n('ai_helper_transfer_undo_failed'));
      setResult({ ...result, status: 'undone' });
    } catch (err) {
      setActionError(errorMessage(err, i18n('ai_helper_transfer_undo_failed')));
    }
    setPhase('result');
  };

  const title = kind === 'groups' ? i18n('ai_helper_transfer_title_groups') : i18n('ai_helper_transfer_title_users');

  // ─── 执行结果 ──────────────────────────────────────────────────────────────

  if (result && phase !== 'form') {
    const remaining = remainingWork(result.summary);
    const busy = phase === 'running';
    return (
      <Modal
        title={title}
        onClose={closeDialog}
        width={560}
        footer={(
          <>
            {onOpenAudit && (
              <button type="button" style={getButtonStyle('ghost')} disabled={busy} onClick={() => { onFinished(true); onOpenAudit(); }}>
                {i18n('ai_helper_transfer_open_audit')}
              </button>
            )}
            <span style={{ flex: 1 }} />
            {result.status === 'partial' && (
              <button type="button" style={getButtonStyle('secondary')} disabled={busy} onClick={undo}>{i18n('ai_helper_transfer_undo_partial')}</button>
            )}
            {result.status === 'done' && (
              <button type="button" style={getButtonStyle('secondary')} disabled={busy} onClick={undo}>{i18n('ai_helper_transfer_undo')}</button>
            )}
            {result.status === 'partial' ? (
              <button type="button" style={getButtonStyle('primary')} disabled={busy} onClick={resume}>
                {busy ? i18n('ai_helper_transfer_executing') : remaining.people
                  ? i18n('ai_helper_transfer_resume_people', remaining.people)
                  : i18n('ai_helper_transfer_resume')}
              </button>
            ) : (
              <button type="button" style={getButtonStyle('primary')} disabled={busy} onClick={closeDialog}>{i18n('ai_helper_transfer_close')}</button>
            )}
          </>
        )}
      >
        <div style={{ display: 'grid', gap: SPACING.md }}>
          <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '15px' }}>
              {result.status === 'partial' ? i18n('ai_helper_transfer_result_partial') : result.status === 'undone' ? i18n('ai_helper_transfer_result_undone') : i18n('ai_helper_transfer_result_done')}
            </strong>
            {result.status === 'partial' && <Badge variant="warn">{i18n('ai_helper_transfer_status_partial')}</Badge>}
          </div>
          {result.status === 'undone' ? (
            <div style={mutedTextStyle}>{i18n('ai_helper_transfer_undone_hint')}</div>
          ) : (
            <div style={{ display: 'grid', gap: '6px' }}>
              {result.summary.map((item, index) => (
                <Bullet key={`${item.type}-${item.name || ''}-${index}`} tone={item.status === 'done' ? 'ok' : item.status === 'failed' || item.status === 'partial' ? 'err' : 'muted'}>
                  {summaryText(item)}
                </Bullet>
              ))}
            </div>
          )}
          {result.status === 'partial' && result.error && (
            <div style={getAlertStyle('warning')}>{i18n('ai_helper_transfer_failed_reason', result.error)}</div>
          )}
          {busy && <div style={mutedTextStyle}>{i18n('ai_helper_transfer_executing')}</div>}
          {actionError && <div style={getAlertStyle('error')}>{actionError}</div>}
        </div>
      </Modal>
    );
  }

  // ─── 表单与预览 ────────────────────────────────────────────────────────────

  const running = phase === 'running';
  const confirmLabel = running
    ? i18n('ai_helper_transfer_executing')
    : kind === 'users'
      ? i18n(mode === 'move' ? 'ai_helper_transfer_confirm_move_users' : 'ai_helper_transfer_confirm_copy_users', counts?.selected || 0)
      : i18n(mode === 'move' ? 'ai_helper_transfer_confirm_move' : 'ai_helper_transfer_confirm_copy');

  const roleSelect = preview && joinCount > 0 && (
    <select
      aria-label={i18n('ai_helper_transfer_join_role')}
      value={joinRole}
      onChange={(event) => setJoinRole(event.target.value)}
      style={{ ...getInputStyle(), width: 'auto', padding: '2px 8px', minHeight: 0, margin: '0 4px' }}
    >
      {preview.joinRoles.map((role) => (
        <option key={role} value={role}>{role === preview.defaultJoinRole ? i18n('ai_helper_transfer_role_default', role) : role}</option>
      ))}
    </select>
  );

  return (
    <Modal
      title={title}
      onClose={closeDialog}
      width={600}
      footer={(
        <>
          {kind === 'users' && preview?.users && (
            <button type="button" style={linkButtonStyle} onClick={() => setShowList((v) => !v)}>
              {showList ? i18n('ai_helper_transfer_hide_list') : i18n('ai_helper_transfer_adjust_list', preview.users.length)}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" style={getButtonStyle('ghost')} disabled={running} onClick={closeDialog}>{i18n('ai_helper_um_cancel')}</button>
          <button type="button" style={getButtonStyle(mode === 'move' ? 'danger' : 'primary')} disabled={!canConfirm || running} onClick={execute}>
            {confirmLabel}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: SPACING.base }}>
        {/* 选中的对象与源 / 目标域 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: SPACING.md }}>
          {kind === 'groups' ? (
            <Field label={i18n('ai_helper_transfer_selected_groups')}>
              <div style={{ fontSize: '14px', display: 'grid', gap: '2px' }}>
                {groupNames.map((name) => {
                  const item = preview?.groups?.find((group) => group.name === name);
                  return <div key={name}>{item ? i18n('ai_helper_transfer_group_size', name, item.memberCount) : name}</div>;
                })}
              </div>
            </Field>
          ) : (
            <Field label={i18n('ai_helper_transfer_selected_users')}>
              <div style={{ fontSize: '14px' }}>{i18n('ai_helper_transfer_user_count', users.length)}</div>
              {sourceNote && <div style={mutedTextStyle}>{sourceNote}</div>}
            </Field>
          )}
          <Field label={i18n('ai_helper_transfer_source')} htmlFor={kind === 'users' ? 'ai-transfer-source' : undefined}>
            {kind === 'users' ? (
              <select id="ai-transfer-source" value={sourceId} onChange={(event) => setSourceId(event.target.value)} style={getInputStyle()}>
                {domains.map((domain) => <option key={domain.id} value={domain.id}>{domainLabel(domains, domain.id)}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: '14px', paddingTop: '2px' }}>{domainLabel(domains, sourceId, preview?.source.name)}</div>
            )}
          </Field>
          <Field label={i18n('ai_helper_transfer_target')} htmlFor="ai-transfer-target">
            {targetOptions.length ? (
              <select id="ai-transfer-target" value={targetId} onChange={(event) => setTargetId(event.target.value)} style={getInputStyle()}>
                {targetOptions.map((domain) => <option key={domain.id} value={domain.id}>{domainLabel(domains, domain.id)}</option>)}
              </select>
            ) : (
              <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>{i18n('ai_helper_transfer_no_target')}</div>
            )}
          </Field>
        </div>

        {/* 方式 */}
        <div>
          <div style={{ ...labelStyle, marginBottom: '6px' }}>{i18n('ai_helper_transfer_mode')}</div>
          <div role="radiogroup" aria-label={i18n('ai_helper_transfer_mode')} style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
            <ModeOption
              active={mode === 'copy'}
              title={i18n('ai_helper_transfer_copy')}
              hint={kind === 'groups' ? i18n('ai_helper_transfer_copy_groups_hint') : i18n('ai_helper_transfer_copy_users_hint')}
              onClick={() => setMode('copy')}
            />
            <ModeOption
              active={mode === 'move'}
              title={i18n('ai_helper_transfer_move')}
              hint={kind === 'groups' ? i18n('ai_helper_transfer_move_groups_hint') : i18n('ai_helper_transfer_move_users_hint')}
              onClick={() => setMode('move')}
            />
          </div>
        </div>

        {/* 小组模式：同名冲突 */}
        {kind === 'groups' && preview?.groups?.filter((group) => group.conflict).map((group) => {
          const draft = conflictDrafts[group.name] || { type: '', renameTo: '' };
          const renameError = draft.type === 'rename' && draft.renameTo ? validateGroupNameClient(draft.renameTo) : null;
          const setDraft = (next: Partial<ConflictDraft>) => setConflictDrafts((prev) => ({ ...prev, [group.name]: { ...draft, ...next } }));
          return (
            <div key={group.name} style={getAlertStyle('warning')}>
              <div style={{ fontWeight: 600 }}>{i18n('ai_helper_transfer_conflict', group.name, group.targetMemberCount)}</div>
              <div role="radiogroup" aria-label={i18n('ai_helper_transfer_conflict_choice', group.name)} style={{ display: 'flex', gap: SPACING.base, alignItems: 'center', flexWrap: 'wrap', marginTop: SPACING.sm }}>
                <label style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                  <input type="radio" name={`ai-transfer-conflict-${group.name}`} checked={draft.type === 'merge'} onChange={() => setDraft({ type: 'merge' })} />
                  {i18n('ai_helper_transfer_conflict_merge')}
                </label>
                <label style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input type="radio" name={`ai-transfer-conflict-${group.name}`} checked={draft.type === 'rename'} onChange={() => setDraft({ type: 'rename', renameTo: draft.renameTo || `${group.name}（${preview.target.name}）` })} />
                  {i18n('ai_helper_transfer_conflict_rename')}
                  <input
                    aria-label={i18n('ai_helper_transfer_rename_to', group.name)}
                    value={draft.renameTo}
                    onFocus={() => { if (draft.type !== 'rename') setDraft({ type: 'rename' }); }}
                    onChange={(event) => setDraft({ type: 'rename', renameTo: event.target.value })}
                    style={{ ...getInputStyle(), width: '200px', borderColor: renameError ? COLORS.error : COLORS.border }}
                  />
                </label>
              </div>
              {renameError && <div style={{ ...mutedTextStyle, color: COLORS.errorText, marginTop: '4px' }}>{i18n(`ai_helper_group_name_err_${renameError}`)}</div>}
            </div>
          );
        })}

        {/* 学生模式：同时放入目标域小组 */}
        {kind === 'users' && (
          <div>
            <label style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '14px' }}>
              <input type="checkbox" checked={putInGroup} onChange={(event) => setPutInGroup(event.target.checked)} />
              {i18n('ai_helper_transfer_put_in_group')}
            </label>
            {putInGroup && (
              <div style={{ marginTop: SPACING.sm }}>
                <input
                  aria-label={i18n('ai_helper_transfer_target_group')}
                  list="ai-transfer-target-groups"
                  value={targetGroupName}
                  onChange={(event) => setTargetGroupName(event.target.value)}
                  placeholder={i18n('ai_helper_transfer_target_group_placeholder')}
                  style={{ ...getInputStyle(), borderColor: targetGroupError && targetGroupName ? COLORS.error : COLORS.border }}
                />
                <datalist id="ai-transfer-target-groups">
                  {targetGroups.map((name) => <option key={name} value={name} />)}
                </datalist>
                {targetGroupError && targetGroupName && (
                  <div style={{ ...mutedTextStyle, color: COLORS.errorText, marginTop: '4px' }}>{i18n(`ai_helper_group_name_err_${targetGroupError}`)}</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 学生名单（调整勾选） */}
        {kind === 'users' && showList && preview?.users && (
          <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, maxHeight: '240px', overflowY: 'auto' }}>
            {preview.users.map((user) => {
              const selectable = isSelectable(user, mode);
              return (
                <label
                  key={user.uid}
                  style={{
                    display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap', padding: '6px 12px', fontSize: '14px',
                    borderBottom: `1px solid ${COLORS.border}`, cursor: selectable ? 'pointer' : 'not-allowed', opacity: selectable ? 1 : 0.6,
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={!selectable}
                    checked={selected.has(user.uid)}
                    onChange={() => setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(user.uid)) next.delete(user.uid);
                      else next.add(user.uid);
                      return next;
                    })}
                  />
                  <span>{user.uname}</span>
                  <span style={mutedTextStyle}>#{user.uid}</span>
                  {user.isOwner && <Badge variant="warn">{i18n('ai_helper_transfer_badge_owner')}</Badge>}
                  {!user.isOwner && user.isManager && <Badge variant="info">{i18n('ai_helper_transfer_badge_manager')}</Badge>}
                  {user.inTarget && <Badge variant="muted">{i18n('ai_helper_transfer_badge_in_target')}</Badge>}
                  {!user.inSource && <Badge variant="muted">{i18n('ai_helper_transfer_badge_not_in_source')}</Badge>}
                </label>
              );
            })}
          </div>
        )}

        {/* 执行前预览 */}
        <section aria-label={i18n('ai_helper_transfer_preview')} aria-busy={!fresh} style={{ background: COLORS.bgPage, borderRadius: RADIUS.md, padding: SPACING.md, display: 'grid', gap: '6px', opacity: fresh || !preview ? 1 : 0.6, transition: 'opacity 150ms' }}>
          <div style={{ ...labelStyle, display: 'flex', gap: SPACING.sm, alignItems: 'center' }}>
            {i18n('ai_helper_transfer_preview')}
            {!fresh && !previewError && request && <span style={{ ...mutedTextStyle, fontWeight: 400 }}>{i18n('ai_helper_transfer_previewing')}</span>}
          </div>
          {previewError && <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>{previewError}</div>}
          {preview && kind === 'groups' && (preview.groups || []).map((group) => (
            <React.Fragment key={group.name}>
              {group.resolution === 'merge' && <Bullet>{i18n('ai_helper_transfer_preview_merge', group.targetName, group.willAdd, group.alreadyIn)}</Bullet>}
              {group.resolution === 'new' && <Bullet>{i18n('ai_helper_transfer_preview_new', group.targetName, group.willAdd)}</Bullet>}
              {group.resolution === 'rename' && <Bullet>{i18n('ai_helper_transfer_preview_rename', group.targetName, group.name, group.willAdd)}</Bullet>}
              {group.resolution === null && <Bullet tone="warn">{i18n('ai_helper_transfer_preview_unresolved', group.name)}</Bullet>}
              {preview.mode === 'move' && group.assignments > 0 && <Bullet tone="warn">{i18n('ai_helper_transfer_preview_assignments', group.assignments, group.name)}</Bullet>}
              {preview.mode === 'move' && group.quotaLinks.map((link) => (
                <Bullet key={link.id}>{i18n('ai_helper_transfer_preview_relink', link.name, group.name, group.targetName)}</Bullet>
              ))}
              {preview.mode === 'move' && <Bullet>{i18n('ai_helper_transfer_preview_delete', group.name)}</Bullet>}
            </React.Fragment>
          ))}
          {preview && kind === 'users' && counts && (
            <>
              {counts.join > 0
                ? <Bullet>{i18n('ai_helper_transfer_preview_users_join', counts.join, counts.alreadyInTarget)}{roleSelect}</Bullet>
                : <Bullet>{i18n('ai_helper_transfer_preview_users_all_in', counts.selected)}</Bullet>}
              {preview.targetGroup && (preview.targetGroup.exists
                ? <Bullet>{i18n('ai_helper_transfer_preview_users_group_existing', preview.targetGroup.name, counts.selected, preview.targetGroup.memberCount)}</Bullet>
                : <Bullet>{i18n('ai_helper_transfer_preview_users_group_new', preview.targetGroup.name, counts.selected)}</Bullet>)}
              {preview.mode === 'move' && (counts.sourceGroups.length
                ? <Bullet>{i18n('ai_helper_transfer_preview_users_leave_groups', counts.leave, counts.sourceGroups.length, counts.sourceGroups.join('、'))}</Bullet>
                : <Bullet>{i18n('ai_helper_transfer_preview_users_leave', counts.leave)}</Bullet>)}
              {ownerUser && <Bullet tone="warn">{i18n('ai_helper_transfer_preview_owner_excluded', ownerUser.uname)}</Bullet>}
              {managersUnchecked > 0 && <Bullet tone="muted">{i18n('ai_helper_transfer_preview_managers', managersUnchecked)}</Bullet>}
            </>
          )}
          {preview && kind === 'groups' && joinCount > 0 && (
            <Bullet>{i18n('ai_helper_transfer_preview_groups_join', joinCount)}{roleSelect}</Bullet>
          )}
          {preview && <Bullet tone="muted">{i18n('ai_helper_transfer_preview_records')}</Bullet>}
          {problemLines.map((text) => <Bullet key={text} tone="err">{text}</Bullet>)}
        </section>

        {/* 小组移动：同时移出源域 */}
        {kind === 'groups' && mode === 'move' && (
          <label style={{ display: 'flex', gap: SPACING.sm, alignItems: 'flex-start', fontSize: '14px' }}>
            <input type="checkbox" checked={removeMembers} onChange={(event) => setRemoveMembers(event.target.checked)} style={{ marginTop: '4px' }} />
            <span>
              {i18n('ai_helper_transfer_remove_members')}
              {removeMembers && preview && <span style={{ ...mutedTextStyle, display: 'block' }}>{i18n('ai_helper_transfer_remove_members_count', preview.leaveCandidates.length)}</span>}
            </span>
          </label>
        )}

        {conflictsLeft.length > 0 && <div style={mutedTextStyle}>{i18n('ai_helper_transfer_resolve_conflicts')}</div>}
        {notice && <div style={getAlertStyle('info')}>{notice}</div>}
        {actionError && <div style={getAlertStyle('error')}>{actionError}</div>}
      </div>
    </Modal>
  );
};

export default TransferDialog;
