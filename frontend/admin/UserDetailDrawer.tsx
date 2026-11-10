/**
 * 用户详情抽屉（设计稿“学生总览”右侧）：今日额度、额度怎么来的（含信誉系数）、信誉记录、近期安全记录
 * 只展示统计与成员信息；对话原文在所属域的对话页查看（FR-053）。
 * 信誉记录可直接“标记误判并撤销”（按记录所在域复核，复核为误判即撤销扣分），也可手动重置信誉。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING, getAlertStyle, getButtonStyle } from '../utils/styles';
import { formatResetText } from '../student/QuotaBar';
import { errorMessage, getJson, postJson } from './userManagementApi';
import { Badge, Drawer, linkButtonStyle, mutedTextStyle } from './userManagementUi';
import type { CreditEventView, QuotaGroupMembership, UserDetailResponse } from './quotaAdminLogic';
import { formatMultiplier, recoveryDaysFrom } from './creditLogic';
import { CreditResetModal } from './CreditDialogs';
import { domainApiUrl } from './userManagementLogic';
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

function sourceLabel(event: CreditEventView): string {
  if (event.source === 'ai_review') return i18n('ai_helper_um_credit_source_review');
  if (event.source === 'manual') return i18n('ai_helper_um_credit_source_manual');
  return event.sequence && event.sequence > 1
    ? i18n('ai_helper_um_credit_source_realtime_k', event.sequence)
    : i18n('ai_helper_um_credit_source_realtime');
}

const CreditEventRow: React.FC<{
  event: CreditEventView;
  busy: boolean;
  onRevoke: (event: CreditEventView) => void;
}> = ({ event, busy, onRevoke }) => {
  if (event.type === 'reset') {
    return (
      <div style={{ padding: `${SPACING.sm} 0`, borderTop: `1px solid ${COLORS.border}`, fontSize: '14px' }}>
        <div style={{ fontWeight: 600, color: COLORS.textPrimary }}>{i18n('ai_helper_um_credit_event_reset')}</div>
        <div style={mutedTextStyle}>
          {[formatDateTime(event.at), event.actorName, event.reason].filter(Boolean).join(' · ')}
        </div>
      </div>
    );
  }
  const revoked = !!event.revokedAt;
  return (
    <div style={{ padding: `${SPACING.sm} 0`, borderTop: `1px solid ${COLORS.border}`, fontSize: '14px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, color: revoked ? COLORS.textMuted : COLORS.textPrimary }}>
          {event.category ? translateOr(`ai_helper_admin_jailbreak_category_${event.category}`, event.category) : '—'}
        </span>
        <span style={{ fontWeight: 650, color: revoked ? COLORS.textMuted : COLORS.errorText, textDecoration: revoked ? 'line-through' : 'none' }}>
          −{formatMultiplier(event.deduction ?? 0)}
        </span>
      </div>
      <div style={mutedTextStyle}>
        {[formatDateTime(event.at), event.domainName, sourceLabel(event)].filter(Boolean).join(' · ')}
      </div>
      {revoked ? (
        <div style={mutedTextStyle}>
          {i18n('ai_helper_um_credit_event_revoked', event.revokedByName || '—', formatDate(event.revokedAt as string))}
        </div>
      ) : event.safetyLogId && event.domainId ? (
        <div>
          <a
            href={`/d/${encodeURIComponent(event.domainId)}/ai-helper?tab=safety`}
            style={{ ...linkButtonStyle, paddingLeft: 0, textDecoration: 'none', display: 'inline-block' }}
          >
            {i18n('ai_helper_um_credit_view_record')}
          </a>
          <button type="button" disabled={busy} style={{ ...linkButtonStyle, color: COLORS.errorText }} onClick={() => onRevoke(event)}>
            {i18n('ai_helper_um_credit_revoke')}
          </button>
        </div>
      ) : null}
    </div>
  );
};

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
  const [resetting, setResetting] = useState(false);
  const [revoking, setRevoking] = useState<CreditEventView | null>(null);

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

  /** 标记误判：按安全记录所在域复核；服务端复核为误判后撤销扣分并写审计 */
  const revoke = async () => {
    if (!revoking?.safetyLogId || !revoking.domainId) return;
    setBusy(true);
    try {
      await postJson(
        domainApiUrl(revoking.domainId, `/ai-helper/admin/jailbreak-logs/${encodeURIComponent(revoking.safetyLogId)}/review`),
        { reviewStatus: 'false_positive' },
        i18n('ai_helper_admin_jailbreak_review_failed'),
      );
      showToast(i18n('ai_helper_um_credit_revoked'), 'success');
      setRevoking(null);
      await load();
      onChanged();
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_admin_jailbreak_review_failed')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const quota = detail?.quota;
  const override = quota?.override?.active ? quota.override : null;
  const credit = detail?.credit || null;
  const recoveryDays = credit ? recoveryDaysFrom(credit.recoveryAt) : null;

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
            {credit && (
              <Row label={i18n('ai_helper_um_detail_credit')}>
                <span style={{ fontWeight: 600, color: credit.reduced ? COLORS.errorText : COLORS.textPrimary }}>
                  × {formatMultiplier(credit.m)}
                </span>
                <span style={{ ...mutedTextStyle, marginLeft: SPACING.sm }}>
                  {credit.reduced
                    ? recoveryDays ? i18n('ai_helper_um_credit_recovery_days', recoveryDays) : i18n('ai_helper_um_credit_no_recovery')
                    : i18n('ai_helper_um_credit_normal')}
                </span>
                {credit.reduced && !quota.disabled && quota.limit !== null && (
                  <div style={mutedTextStyle}>{i18n('ai_helper_um_credit_floor_note', quota.guaranteeCount)}</div>
                )}
              </Row>
            )}
            <Row label={i18n('ai_helper_um_detail_effective')} strong>
              {quota.disabled
                ? i18n('ai_helper_um_detail_ai_off')
                : quota.limit === null ? i18n('ai_helper_um_detail_unlimited') : i18n('ai_helper_um_quota_limit_grant', quota.limit)}
            </Row>
          </section>

          {credit && (
            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.xs }}>
                <h4 style={{ margin: 0, fontSize: '15px', color: COLORS.textPrimary, flex: 1 }}>{i18n('ai_helper_um_credit_records')}</h4>
                {credit.reduced && (
                  <button type="button" style={getButtonStyle('secondary')} onClick={() => setResetting(true)}>
                    {i18n('ai_helper_um_credit_reset')}
                  </button>
                )}
              </div>
              {credit.events.length === 0
                ? <div style={mutedTextStyle}>{i18n('ai_helper_um_credit_records_none')}</div>
                : credit.events.map((event) => <CreditEventRow key={event.id} event={event} busy={busy} onRevoke={setRevoking} />)}
            </section>
          )}

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
      {resetting && detail && (
        <CreditResetModal
          users={[{ uid: detail.uid, uname: detail.uname }]}
          onClose={() => setResetting(false)}
          onDone={(message) => { setResetting(false); showToast(message, 'success'); load(); onChanged(); }}
        />
      )}
      {revoking && detail && (
        <ConfirmModal
          title={i18n('ai_helper_um_credit_revoke_title')}
          message={i18n(
            'ai_helper_um_credit_revoke_message',
            revoking.category ? translateOr(`ai_helper_admin_jailbreak_category_${revoking.category}`, revoking.category) : '—',
            formatDateTime(revoking.at),
            revoking.domainName || revoking.domainId || '',
          )}
          confirmLabel={i18n('ai_helper_um_credit_revoke')}
          danger
          busy={busy}
          onConfirm={revoke}
          onClose={() => setRevoking(null)}
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
