/**
 * 个人覆盖（设计稿“额度与信誉”）：优先于所有额度组；须填原因，可设到期时间
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS,
  SPACING,
  cardStyle,
  getAlertStyle,
  getButtonStyle,
  getTableCellStyle,
  getTableHeaderStyle,
} from '../utils/styles';
import { Icon } from '../components/Icon';
import { errorMessage, getJson, postJson } from './userManagementApi';
import { Badge, TableScroll, linkButtonStyle, mutedTextStyle } from './userManagementUi';
import type { OverrideView, OverridesResponse } from './quotaAdminLogic';
import { ConfirmModal, OverrideFormModal, QUOTA_API, formatDate, formatOverrideSetting, formatShortDate } from './quotaAdminUi';

type ShowToast = (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;

export const QuotaOverridesSection: React.FC<{ domainId: string; showToast: ShowToast }> = ({ domainId, showToast }) => {
  const [data, setData] = useState<OverridesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OverrideView | 'new' | null>(null);
  const [clearing, setClearing] = useState<OverrideView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson<OverridesResponse>(QUOTA_API.overrides, i18n('ai_helper_quota_overrides_failed')));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_quota_overrides_failed')));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const clear = async () => {
    if (!clearing) return;
    setBusy(true);
    try {
      await postJson(QUOTA_API.overrides, { action: 'clear', uids: [clearing.uid] }, i18n('ai_helper_quota_override_save_failed'));
      showToast(i18n('ai_helper_um_override_cleared', clearing.uname), 'success');
      setClearing(null);
      await load();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_quota_override_save_failed')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const th = getTableHeaderStyle();
  const td = getTableCellStyle();

  return (
    <section style={{ ...cardStyle, padding: SPACING.lg }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: SPACING.sm, flexWrap: 'wrap', marginBottom: SPACING.base }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>{i18n('ai_helper_um_override_title')}</h3>
        <span style={mutedTextStyle}>{i18n('ai_helper_um_override_subtitle')}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={{ ...getButtonStyle('secondary'), display: 'inline-flex', alignItems: 'center', gap: '6px' }} onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} />
          {i18n('ai_helper_um_override_add')}
        </button>
      </div>

      {error && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.md, display: 'flex', gap: SPACING.sm, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" style={getButtonStyle('secondary')} onClick={load}>{i18n('ai_helper_um_retry')}</button>
        </div>
      )}

      {data && (
        <TableScroll>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>{i18n('ai_helper_um_student')}</th>
                <th style={th}>{i18n('ai_helper_um_override_setting')}</th>
                <th style={th}>{i18n('ai_helper_um_override_expires')}</th>
                <th style={th}>{i18n('ai_helper_um_override_reason')}</th>
                <th style={th}>{i18n('ai_helper_um_override_set_by')}</th>
                <th style={th}>{i18n('ai_helper_um_col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, color: COLORS.textMuted, textAlign: 'center' }}>{i18n('ai_helper_um_override_empty')}</td></tr>
              )}
              {data.items.map((item) => (
                <tr key={item.uid}>
                  <td style={td}>
                    <div style={{ fontWeight: 600, color: COLORS.textPrimary }}>{item.uname}</div>
                    <div style={{ ...mutedTextStyle, fontSize: '12px' }}>uid {item.uid}</div>
                  </td>
                  <td style={td}>
                    <Badge variant={item.mode === 'disabled' ? 'err' : 'info'}>{formatOverrideSetting(item.mode, item.dailyLimit)}</Badge>
                  </td>
                  <td style={td}>{item.expiresAt ? formatDate(item.expiresAt) : i18n('ai_helper_um_override_never')}</td>
                  <td className="ai-um-wrap" style={td}>{item.reason}</td>
                  <td style={td}>{`${item.setByName} · ${formatShortDate(item.setAt)}`}</td>
                  <td style={td}>
                    <button type="button" style={linkButtonStyle} onClick={() => setEditing(item)}>{i18n('ai_helper_um_edit')}</button>
                    <button type="button" style={{ ...linkButtonStyle, color: COLORS.errorText }} onClick={() => setClearing(item)}>
                      {i18n('ai_helper_um_override_clear')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {data && data.total > data.items.length && (
        <div style={{ ...mutedTextStyle, marginTop: SPACING.sm }}>{i18n('ai_helper_um_override_truncated', data.items.length, data.total)}</div>
      )}

      {editing && (
        <OverrideFormModal
          domainId={domainId}
          users={editing === 'new' ? [] : [{ uid: editing.uid, uname: editing.uname }]}
          lockUsers={editing !== 'new'}
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); showToast(message, 'success'); load(); }}
        />
      )}
      {clearing && (
        <ConfirmModal
          title={i18n('ai_helper_um_override_clear_title', clearing.uname)}
          message={i18n('ai_helper_um_override_clear_message', clearing.uname)}
          confirmLabel={i18n('ai_helper_um_override_clear')}
          danger
          busy={busy}
          onConfirm={clear}
          onClose={() => setClearing(null)}
        />
      )}
    </section>
  );
};
