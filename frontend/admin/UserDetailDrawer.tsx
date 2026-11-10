/**
 * 用户详情抽屉（设计稿“学生总览”右侧）：今日额度、额度怎么来的、近期安全记录
 * 只展示统计与成员信息；对话原文在所属域的对话页查看（FR-053）。信誉系数随 PR4 加入。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING, getAlertStyle, getButtonStyle } from '../utils/styles';
import { formatResetText } from '../student/QuotaBar';
import { errorMessage, getJson, postJson } from './userManagementApi';
import { Badge, Drawer, linkButtonStyle, mutedTextStyle } from './userManagementUi';
import type { QuotaGroupMembership, UserDetailResponse } from './quotaAdminLogic';
import {
  ConfirmModal,
  OverrideFormModal,
  QUOTA_API,
  formatDate,
  formatDateTime,
  formatGroupLimit,
  formatOverrideSetting,
} from './quotaAdminUi';

type ShowToast = (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;

function translateOr(key: string, fallback: string): string {
  const text = i18n(key);
  return text && text !== key ? text : fallback;
}

const Row: React.FC<{ label: string; children: React.ReactNode; strong?: boolean }> = ({ label, children, strong }) => (
  <div
    style={{
      display: 'flex', gap: SPACING.md, padding: `${SPACING.sm} 0`, borderTop: `1px solid ${COLORS.border}`,
      fontSize: '14px', alignItems: 'flex-start', fontWeight: strong ? 650 : 400,
    }}
  >
    <div style={{ width: '92px', flexShrink: 0, color: COLORS.textMuted }}>{label}</div>
    <div style={{ flex: 1, minWidth: 0, color: COLORS.textPrimary }}>{children}</div>
  </div>
);

function GroupList({ groups, mode, ignored }: { groups: QuotaGroupMembership[]; mode: 'grant' | 'cap'; ignored: boolean }) {
  const list = groups.filter((group) => group.mode === mode);
  if (!list.length) return <span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_um_detail_none')}</span>;
  return (
    <div style={{ display: 'grid', gap: '4px' }}>
      {list.map((group) => (
        <div key={group.id} style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', opacity: group.enabled && !ignored ? 1 : 0.6 }}>
          <span style={{ fontWeight: 600 }}>{group.name}</span>
          <span>{formatGroupLimit(group.mode, group.dailyLimit)}</span>
          {group.applied && (
            <Badge variant={mode === 'grant' ? 'info' : 'warn'}>
              {mode === 'grant' ? i18n('ai_helper_um_detail_takes_max') : i18n('ai_helper_um_detail_takes_min')}
            </Badge>
          )}
          {!group.enabled && <Badge variant="muted">{i18n('ai_helper_um_qgroup_disabled')}</Badge>}
          {group.via.some((via) => via.kind === 'linked') && (
            <span style={{ ...mutedTextStyle, fontSize: '12px' }}>
              {i18n('ai_helper_um_detail_via_link', group.via
                .filter((via): via is { kind: 'linked'; domainId: string; name: string } => via.kind === 'linked')
                .map((via) => via.name).join('、'))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export const UserDetailDrawer: React.FC<{
  uid: number;
  domainId: string;
  onClose: () => void;
  onChanged: () => void;
  showToast: ShowToast;
}> = ({ uid, domainId, onClose, onChanged, showToast }) => {
  const [detail, setDetail] = useState<UserDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getJson<UserDetailResponse>(`${QUOTA_API.users}/${uid}`, i18n('ai_helper_overview_detail_failed')));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_overview_detail_failed')));
    }
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  const clearOverride = async () => {
    setBusy(true);
    try {
      await postJson(QUOTA_API.overrides, { action: 'clear', uids: [uid] }, i18n('ai_helper_quota_override_save_failed'));
      showToast(i18n('ai_helper_um_override_cleared', detail?.uname || String(uid)), 'success');
      setClearing(false);
      await load();
      onChanged();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_quota_override_save_failed')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const quota = detail?.quota;
  const override = quota?.override?.active ? quota.override : null;

  return (
    <Drawer
      title={detail?.uname || i18n('ai_helper_um_loading')}
      subtitle={detail ? `uid ${detail.uid}${detail.domains.length ? ` · ${detail.domains.map((d) => d.name).join('、')}` : ''}` : undefined}
      onClose={onClose}
    >
      {error && <div style={getAlertStyle('error')}>{error}</div>}
      {detail && quota && (
        <div style={{ display: 'grid', gap: SPACING.lg }}>
          <section style={{ background: COLORS.bgPage, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.lg, padding: SPACING.base }}>
            <div style={{ ...mutedTextStyle, marginBottom: '4px' }}>{i18n('ai_helper_um_detail_today')}</div>
            {quota.disabled ? (
              <div style={{ fontSize: '22px', fontWeight: 700, color: COLORS.errorText }}>{i18n('ai_helper_um_detail_ai_off')}</div>
            ) : quota.limit === null ? (
              <div>
                <span style={{ fontSize: '22px', fontWeight: 700, color: COLORS.textPrimary }}>{i18n('ai_helper_um_detail_unlimited')}</span>
                <span style={{ ...mutedTextStyle, marginLeft: SPACING.sm }}>{i18n('ai_helper_um_detail_used_only', quota.used)}</span>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '28px', fontWeight: 750, color: (quota.remaining ?? 0) > 0 ? COLORS.textPrimary : COLORS.errorText }}>
                  {quota.remaining ?? 0}
                </span>
                <span style={mutedTextStyle}>
                  {i18n('ai_helper_um_detail_remaining', quota.limit, quota.used, formatResetText(quota.resetAt))}
                </span>
              </div>
            )}
          </section>

          <section>
            <h4 style={{ margin: `0 0 ${SPACING.xs}`, fontSize: '15px', color: COLORS.textPrimary }}>{i18n('ai_helper_um_detail_how')}</h4>
            <Row label={i18n('ai_helper_um_detail_default')}>
              {quota.defaultLimit === null ? i18n('ai_helper_um_detail_unlimited') : i18n('ai_helper_um_quota_limit_grant', quota.defaultLimit)}
            </Row>
            <Row label={i18n('ai_helper_um_detail_grant_groups')}>
              <GroupList groups={quota.groups} mode="grant" ignored={!!override} />
            </Row>
            <Row label={i18n('ai_helper_um_detail_cap_groups')}>
              <GroupList groups={quota.groups} mode="cap" ignored={!!override} />
            </Row>
            <Row label={i18n('ai_helper_um_detail_override')}>
              {override ? (
                <div style={{ display: 'grid', gap: '2px' }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge variant={override.mode === 'disabled' ? 'err' : 'info'}>{formatOverrideSetting(override.mode, override.dailyLimit)}</Badge>
                    <span style={mutedTextStyle}>
                      {override.expiresAt
                        ? i18n('ai_helper_um_detail_override_until', formatDate(override.expiresAt))
                        : i18n('ai_helper_um_override_never')}
                    </span>
                  </div>
                  {override.reason && <div style={mutedTextStyle}>{i18n('ai_helper_um_detail_override_reason', override.reason, quota.overrideSetByName || '')}</div>}
                  <div style={mutedTextStyle}>{i18n('ai_helper_um_detail_override_note')}</div>
                  <div>
                    <button type="button" style={{ ...linkButtonStyle, paddingLeft: 0 }} onClick={() => setEditing(true)}>{i18n('ai_helper_um_edit')}</button>
                    <button type="button" style={{ ...linkButtonStyle, color: COLORS.errorText }} onClick={() => setClearing(true)}>{i18n('ai_helper_um_override_clear')}</button>
                  </div>
                </div>
              ) : (
                <span>
                  <span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_um_detail_none')}</span>
                  <button type="button" style={linkButtonStyle} onClick={() => setEditing(true)}>{i18n('ai_helper_um_detail_set')}</button>
                </span>
              )}
            </Row>
            <Row label={i18n('ai_helper_um_detail_effective')} strong>
              {quota.disabled
                ? i18n('ai_helper_um_detail_ai_off')
                : quota.limit === null ? i18n('ai_helper_um_detail_unlimited') : i18n('ai_helper_um_quota_limit_grant', quota.limit)}
            </Row>
          </section>

          <section>
            <h4 style={{ margin: `0 0 ${SPACING.sm}`, fontSize: '15px', color: COLORS.textPrimary }}>
              {i18n('ai_helper_um_detail_violations', detail.violations7d)}
            </h4>
            {detail.recentViolations.length === 0 && <div style={mutedTextStyle}>{i18n('ai_helper_um_detail_violations_none')}</div>}
            {detail.recentViolations.map((item) => (
              <div key={item.id} style={{ padding: `${SPACING.sm} 0`, borderTop: `1px solid ${COLORS.border}`, fontSize: '14px' }}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, color: COLORS.textPrimary }}>
                    {item.category ? translateOr(`ai_helper_admin_jailbreak_category_${item.category}`, item.category) : '—'}
                  </span>
                  {item.reviewStatus === 'false_positive' && <Badge variant="muted">{i18n('ai_helper_admin_jailbreak_review_false_positive')}</Badge>}
                  {item.reviewStatus === 'confirmed' && <Badge variant="err">{i18n('ai_helper_admin_jailbreak_review_confirmed')}</Badge>}
                </div>
                <div style={mutedTextStyle}>
                  {[
                    formatDateTime(item.createdAt),
                    item.domainName,
                    item.actionTaken ? translateOr(`ai_helper_admin_jailbreak_action_${item.actionTaken}`, item.actionTaken) : '',
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
            ))}
          </section>

          <section style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
            <button type="button" style={getButtonStyle('primary')} onClick={() => setEditing(true)}>{i18n('ai_helper_um_override_dialog_title')}</button>
            {detail.domains.map((domain) => (
              <a
                key={domain.id}
                href={`/d/${encodeURIComponent(domain.id)}/ai-helper?tab=conversations&userId=${detail.uid}`}
                style={{ ...getButtonStyle('secondary'), textDecoration: 'none' }}
              >
                {i18n('ai_helper_um_detail_conversations', domain.name)}
              </a>
            ))}
          </section>
        </div>
      )}

      {editing && detail && (
        <OverrideFormModal
          domainId={domainId}
          users={[{ uid: detail.uid, uname: detail.uname }]}
          lockUsers
          initial={override ? { mode: override.mode, dailyLimit: override.dailyLimit, expiresAt: override.expiresAt, reason: override.reason } : undefined}
          onClose={() => setEditing(false)}
          onSaved={(message) => { setEditing(false); showToast(message, 'success'); load(); onChanged(); }}
        />
      )}
      {clearing && detail && (
        <ConfirmModal
          title={i18n('ai_helper_um_override_clear_title', detail.uname)}
          message={i18n('ai_helper_um_override_clear_message', detail.uname)}
          confirmLabel={i18n('ai_helper_um_override_clear')}
          danger
          busy={busy}
          onConfirm={clearOverride}
          onClose={() => setClearing(false)}
        />
      )}
    </Drawer>
  );
};
