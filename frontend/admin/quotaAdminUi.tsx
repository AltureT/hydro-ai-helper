/**
 * 额度管理共用的展示函数与“设置个人额度”对话框
 */

import React, { useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, SPACING, getAlertStyle, getButtonStyle, getInputStyle } from '../utils/styles';
import { errorMessage, postJson } from './userManagementApi';
import { Modal, PillGroup, labelStyle, mutedTextStyle } from './userManagementUi';
import { UserPicker, type PickedUser } from './UserPicker';
import {
  QUOTA_LIMIT_MAX,
  QUOTA_REASON_MAX,
  expiresDateToIso,
  isoToDateInput,
  validateOverrideForm,
  type OverrideFormError,
  type OverrideMode,
  type QuotaGroupMode,
} from './quotaAdminLogic';

export const QUOTA_API = {
  groups: '/ai-helper/admin/quota/groups',
  groupDetail: '/ai-helper/admin/quota/groups/detail',
  overrides: '/ai-helper/admin/quota/overrides',
  users: '/ai-helper/admin/users',
};

export function formatGroupLimit(mode: QuotaGroupMode, limit: number): string {
  if (mode === 'grant') return i18n('ai_helper_um_quota_limit_grant', limit);
  return limit === 0 ? i18n('ai_helper_um_quota_limit_cap_zero') : i18n('ai_helper_um_quota_limit_cap', limit);
}

export function formatGroupMembers(direct: number, linkedOnly: number): string {
  if (direct && linkedOnly) return i18n('ai_helper_um_quota_members_both', direct, linkedOnly);
  if (direct) return i18n('ai_helper_um_quota_members_direct', direct);
  if (linkedOnly) return i18n('ai_helper_um_quota_members_linked', linkedOnly);
  return i18n('ai_helper_um_quota_members_none');
}

export function formatOverrideSetting(mode: OverrideMode, dailyLimit?: number): string {
  return mode === 'disabled'
    ? i18n('ai_helper_um_override_disabled')
    : i18n('ai_helper_um_override_limit', dailyLimit ?? 0);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatShortDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const OVERRIDE_ERROR_KEYS: Record<OverrideFormError, string> = {
  no_users: 'ai_helper_um_override_err_no_users',
  limit: 'ai_helper_um_override_err_limit',
  reason_required: 'ai_helper_um_override_err_reason',
  reason_too_long: 'ai_helper_um_override_err_reason_long',
  expires: 'ai_helper_um_override_err_expires',
};

export interface OverrideFormInitial {
  mode: OverrideMode;
  dailyLimit?: number;
  expiresAt?: string;
  reason?: string;
}

/**
 * 设置个人额度：可在对话框内选人，也可传入固定的人（学生总览批量、编辑某条覆盖）。
 */
export const OverrideFormModal: React.FC<{
  domainId: string;
  users?: PickedUser[];
  lockUsers?: boolean;
  initial?: OverrideFormInitial;
  onClose: () => void;
  onSaved: (message: string) => void;
}> = ({ domainId, users: initialUsers = [], lockUsers = false, initial, onClose, onSaved }) => {
  const [users, setUsers] = useState<PickedUser[]>(initialUsers);
  const [mode, setMode] = useState<OverrideMode>(initial?.mode || 'limit');
  const [limitText, setLimitText] = useState(initial?.dailyLimit ? String(initial.dailyLimit) : '');
  const [expiresDate, setExpiresDate] = useState(isoToDateInput(initial?.expiresAt));
  const [reason, setReason] = useState(initial?.reason || '');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formError = validateOverrideForm({ uids: users.map((user) => user.uid), mode, limitText, reason, expiresDate });

  const save = async () => {
    setTouched(true);
    if (formError) return;
    setSaving(true);
    setError(null);
    try {
      const res = await postJson<{ updated: number[]; missing: number[] }>(QUOTA_API.overrides, {
        action: 'set',
        uids: users.map((user) => user.uid),
        mode,
        ...(mode === 'limit' ? { dailyLimit: Number(limitText.trim()) } : {}),
        expiresAt: expiresDate ? expiresDateToIso(expiresDate) : null,
        reason: reason.trim(),
      }, i18n('ai_helper_quota_override_save_failed'));
      onSaved(i18n('ai_helper_um_override_saved', res.updated.length));
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_quota_override_save_failed')));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={i18n('ai_helper_um_override_dialog_title')}
      onClose={onClose}
      width={560}
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
          <div style={{ ...labelStyle, marginBottom: '6px' }}>{i18n('ai_helper_um_override_users')}</div>
          {lockUsers ? (
            <div style={{ fontSize: '14px', color: COLORS.textPrimary }}>
              {users.slice(0, 8).map((user) => user.uname).join('、')}
              {users.length > 8 ? ` ${i18n('ai_helper_um_and_more', users.length - 8)}` : ''}
            </div>
          ) : (
            <UserPicker domainId={domainId} selected={users} onChange={setUsers} />
          )}
        </div>

        <div>
          <div style={{ ...labelStyle, marginBottom: '6px' }}>{i18n('ai_helper_um_override_setting')}</div>
          <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <PillGroup<OverrideMode>
              ariaLabel={i18n('ai_helper_um_override_setting')}
              value={mode}
              onChange={setMode}
              options={[
                { id: 'limit', label: i18n('ai_helper_um_override_mode_limit') },
                { id: 'disabled', label: i18n('ai_helper_um_override_disabled') },
              ]}
            />
            {mode === 'limit' && (
              <input
                type="number"
                min={1}
                max={QUOTA_LIMIT_MAX}
                inputMode="numeric"
                value={limitText}
                onChange={(event) => setLimitText(event.target.value)}
                aria-label={i18n('ai_helper_um_override_mode_limit')}
                placeholder="100"
                style={{ ...getInputStyle(), width: '120px' }}
              />
            )}
          </div>
          <div style={{ ...mutedTextStyle, marginTop: '4px' }}>{i18n('ai_helper_um_override_setting_hint')}</div>
        </div>

        <div>
          <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-override-expires">
            {i18n('ai_helper_um_override_expires')}
          </label>
          <input
            id="ai-um-override-expires"
            type="date"
            value={expiresDate}
            onChange={(event) => setExpiresDate(event.target.value)}
            style={{ ...getInputStyle(), width: '180px' }}
          />
          <div style={{ ...mutedTextStyle, marginTop: '4px' }}>{i18n('ai_helper_um_override_expires_hint')}</div>
        </div>

        <div>
          <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-override-reason">
            {i18n('ai_helper_um_override_reason')}
          </label>
          <textarea
            id="ai-um-override-reason"
            value={reason}
            maxLength={QUOTA_REASON_MAX}
            rows={2}
            onChange={(event) => setReason(event.target.value)}
            placeholder={i18n('ai_helper_um_override_reason_placeholder')}
            style={{ ...getInputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        {touched && formError && (
          <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>{i18n(OVERRIDE_ERROR_KEYS[formError], QUOTA_LIMIT_MAX)}</div>
        )}
        {error && <div style={getAlertStyle('error')}>{error}</div>}
      </div>
    </Modal>
  );
};

/** 简单的确认对话框 */
export const ConfirmModal: React.FC<{
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}> = ({ title, message, confirmLabel, danger, busy, onConfirm, onClose }) => (
  <Modal
    title={title}
    onClose={onClose}
    footer={(
      <>
        <button type="button" style={getButtonStyle('ghost')} onClick={onClose}>{i18n('ai_helper_um_cancel')}</button>
        <button type="button" style={getButtonStyle(danger ? 'danger' : 'primary')} onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </>
    )}
  >
    <div style={{ fontSize: '14px', lineHeight: 1.7, color: COLORS.textSecondary }}>{message}</div>
  </Modal>
);
