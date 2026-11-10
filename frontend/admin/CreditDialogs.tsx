/**
 * 重置信誉（FR-032）：须填写原因，写入审计。用户详情与学生总览的批量操作共用。
 */

import React, { useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, SPACING, getAlertStyle, getButtonStyle, getInputStyle } from '../utils/styles';
import { errorMessage, postJson } from './userManagementApi';
import { Modal, labelStyle, mutedTextStyle } from './userManagementUi';
import { QUOTA_API } from './quotaAdminUi';

export const CREDIT_REASON_MAX = 200;

export const CreditResetModal: React.FC<{
  users: Array<{ uid: number; uname: string }>;
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ users, onClose, onDone }) => {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();
  const tooLong = [...trimmed].length > CREDIT_REASON_MAX;

  const save = async () => {
    if (!trimmed || tooLong) return;
    setSaving(true);
    setError(null);
    try {
      const res = await postJson<{ reset: number[]; missing: number[] }>(
        QUOTA_API.creditReset,
        { uids: users.map((user) => user.uid), reason: trimmed },
        i18n('ai_helper_credit_reset_failed'),
      );
      onDone(users.length === 1 && res.reset.length === 1
        ? i18n('ai_helper_um_credit_reset_done_one', users[0].uname)
        : i18n('ai_helper_um_credit_reset_done', res.reset.length));
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_credit_reset_failed')));
      setSaving(false);
    }
  };

  const names = users.slice(0, 8).map((user) => user.uname).join('、') + (users.length > 8 ? ` ${i18n('ai_helper_um_and_more', users.length - 8)}` : '');

  return (
    <Modal
      title={users.length === 1 ? i18n('ai_helper_um_credit_reset_title_one', users[0].uname) : i18n('ai_helper_um_credit_reset_title', users.length)}
      onClose={onClose}
      footer={(
        <>
          <button type="button" style={getButtonStyle('ghost')} onClick={onClose}>{i18n('ai_helper_um_cancel')}</button>
          <button type="button" style={getButtonStyle('primary')} onClick={save} disabled={saving || !trimmed || tooLong}>
            {saving ? i18n('ai_helper_um_saving') : i18n('ai_helper_um_credit_reset')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: SPACING.base }}>
        {users.length > 1 && <div style={{ fontSize: '14px', color: COLORS.textPrimary }}>{names}</div>}
        <div style={mutedTextStyle}>{i18n('ai_helper_um_credit_reset_hint')}</div>
        <div>
          <label style={{ ...labelStyle, display: 'block', marginBottom: '6px' }} htmlFor="ai-um-credit-reset-reason">
            {i18n('ai_helper_um_credit_reset_reason')}
          </label>
          <textarea
            id="ai-um-credit-reset-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            placeholder={i18n('ai_helper_um_credit_reset_reason_placeholder')}
            style={{ ...getInputStyle(), resize: 'vertical', borderColor: tooLong ? COLORS.error : COLORS.border }}
          />
          {tooLong && <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>{i18n('ai_helper_credit_reason_too_long', CREDIT_REASON_MAX)}</div>}
        </div>
        {error && <div style={getAlertStyle('error')}>{error}</div>}
      </div>
    </Modal>
  );
};

export default CreditResetModal;
