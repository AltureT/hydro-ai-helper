/**
 * 学生端每日次数（设计稿“学生端面板”①②③）
 * - QuotaBar：今日剩余 N / M 次、重置时间、进度条
 * - CreditNotice：额度因违规降低时说明原因（违规类别和时间）、预计恢复时间和申诉入口；不显示规则细节（FR-034）
 * - QuotaBlockedNotice：额度用完 / AI 被管理员关闭，两种文案不同
 */

import React, { useState } from 'react';
import { i18n } from '../utils/i18n';
import { Icon } from '../components/Icon';
import {
  creditReduction,
  remainingPercent,
  resetLabel,
  violationTimeLabel,
  type CreditViolationView,
  type QuotaBlock,
  type QuotaStatusView,
} from './quotaView';

const C = {
  border: '#eef1f5',
  text: '#1e2536',
  muted: '#64748b',
  track: '#eef2f8',
  primary: '#2563eb',
  warn: '#f59e0b',
  danger: '#ef4444',
};

export function formatResetText(resetAt: string): string {
  const label = resetLabel(resetAt);
  if (!label) return '';
  if (label.kind === 'tomorrow') return i18n('ai_helper_student_quota_reset_tomorrow', label.time);
  if (label.kind === 'today') return i18n('ai_helper_student_quota_reset_today', label.time);
  return i18n('ai_helper_student_quota_reset_date', label.date, label.time);
}

export const QuotaBar: React.FC<{ status: QuotaStatusView }> = ({ status }) => {
  if (status.disabled || status.limit === null) return null;
  const percent = remainingPercent(status);
  const color = percent <= 0 ? C.danger : percent <= 20 ? C.warn : C.primary;
  return (
    <div style={{ padding: '8px 16px', borderBottom: `1px solid ${C.border}`, background: '#fff', flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', fontSize: '12px' }}>
        <span style={{ color: C.text }}>
          {i18n('ai_helper_student_quota_remaining', status.remaining ?? 0, status.limit)}
        </span>
        <span style={{ color: C.muted, whiteSpace: 'nowrap' }}>{formatResetText(status.resetAt)}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={status.limit}
        aria-valuenow={status.remaining ?? 0}
        aria-label={i18n('ai_helper_student_quota_remaining', status.remaining ?? 0, status.limit)}
        style={{ height: '4px', background: C.track, borderRadius: '999px', marginTop: '6px', overflow: 'hidden' }}
      >
        <div style={{ width: `${percent}%`, height: '100%', background: color, borderRadius: '999px', transition: 'width 300ms ease' }} />
      </div>
    </div>
  );
};

function violationTimeText(at: string): string {
  const label = violationTimeLabel(at);
  if (!label) return '';
  if (label.kind === 'today') return i18n('ai_helper_student_credit_time_today', label.time);
  if (label.kind === 'yesterday') return i18n('ai_helper_student_credit_time_yesterday', label.time);
  return i18n('ai_helper_student_credit_time_date', label.date, label.time);
}

const ViolationRow: React.FC<{
  item: CreditViolationView;
  onAppeal: (safetyEventId: string) => Promise<{ ok: boolean; message?: string }>;
}> = ({ item, onAppeal }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appeal = async () => {
    if (!item.safetyEventId || busy) return;
    setBusy(true);
    setError(null);
    const result = await onAppeal(item.safetyEventId);
    setBusy(false);
    if (!result.ok) setError(result.message || i18n('ai_helper_err_safety_appeal_failed'));
  };
  return (
    <li style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: `1px solid ${C.border}` }}>
      <span style={{ fontWeight: 600, color: C.text }}>{i18n(`ai_helper_admin_jailbreak_category_${item.category}`)}</span>
      <span style={{ color: C.muted, flex: 1, minWidth: '120px' }}>
        {violationTimeText(item.at)}
        {' · '}
        {i18n(item.source === 'ai_review' ? 'ai_helper_student_credit_source_review' : 'ai_helper_student_credit_source_realtime')}
      </span>
      {item.appealed && <span style={{ color: C.muted }}>{i18n('ai_helper_student_credit_appealed')}</span>}
      {item.appealable && item.safetyEventId && (
        <button
          type="button"
          onClick={appeal}
          disabled={busy}
          style={{
            border: '1px solid #c7d2fe', background: '#fff', color: C.primary, borderRadius: '999px',
            padding: '2px 10px', fontSize: '12px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.65 : 1, fontFamily: 'inherit',
          }}
        >
          {i18n(busy ? 'ai_helper_safety_appeal_submitting' : 'ai_helper_student_credit_appeal')}
        </button>
      )}
      {error && <span style={{ color: C.danger, width: '100%' }}>{error}</span>}
    </li>
  );
};

/** 额度因违规降低：原因、预计恢复时间、申诉入口（设计稿“学生端面板”②） */
export const CreditNotice: React.FC<{
  status: QuotaStatusView;
  onAppeal: (safetyEventId: string) => Promise<{ ok: boolean; message?: string }>;
}> = ({ status, onAppeal }) => {
  const [open, setOpen] = useState(false);
  const reduction = creditReduction(status);
  if (!reduction) return null;
  const violations = status.credit?.recentViolations || [];
  return (
    <div style={{ padding: '8px 16px', borderBottom: `1px solid ${C.border}`, background: '#fffbeb', fontSize: '12px', lineHeight: 1.6, color: '#92400e', flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
        <Icon name="warning" size={14} style={{ marginTop: '2px', flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          {reduction.recoveryDays
            ? i18n('ai_helper_student_credit_reduced', reduction.from, reduction.to, reduction.recoveryDays)
            : i18n('ai_helper_student_credit_reduced_no_recovery', reduction.from, reduction.to)}
        </span>
        {violations.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            style={{ border: 'none', background: 'transparent', color: C.primary, cursor: 'pointer', padding: 0, fontSize: '12px', whiteSpace: 'nowrap', fontFamily: 'inherit' }}
          >
            {i18n(open ? 'ai_helper_student_credit_hide_reasons' : 'ai_helper_student_credit_why')}
          </button>
        )}
      </div>
      {open && violations.length > 0 && (
        <div style={{ marginTop: '6px', background: '#fff', borderRadius: '8px', padding: '4px 10px 8px', color: C.text }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {violations.map((item, index) => <ViolationRow key={`${item.safetyEventId || index}-${item.at}`} item={item} onAppeal={onAppeal} />)}
          </ul>
          <div style={{ color: C.muted, marginTop: '4px' }}>{i18n('ai_helper_student_credit_appeal_hint')}</div>
        </div>
      )}
    </div>
  );
};

export const QuotaBlockedNotice: React.FC<{ block: QuotaBlock; status: QuotaStatusView | null }> = ({ block, status }) => {
  if (!block) return null;
  const disabled = block === 'disabled';
  return (
    <div
      role="status"
      style={{
        margin: '12px 16px 0',
        padding: '12px 14px',
        borderRadius: '12px',
        border: `1px solid ${disabled ? '#fecaca' : '#fde68a'}`,
        background: disabled ? '#fef2f2' : '#fffbeb',
        color: disabled ? '#991b1b' : '#92400e',
        fontSize: '12.5px',
        lineHeight: 1.6,
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
      }}
    >
      <Icon name={disabled ? 'lock' : 'clock'} size={15} style={{ marginTop: '2px' }} />
      <div>
        {disabled ? (
          <>
            <strong>{i18n('ai_helper_student_quota_disabled_title')}</strong>
            {' '}{i18n('ai_helper_student_quota_disabled_desc')}
          </>
        ) : (
          <>
            <strong>{i18n('ai_helper_student_quota_exhausted_title', status?.used ?? 0, status?.limit ?? 0)}</strong>
            {' '}{status?.resetAt ? i18n('ai_helper_student_quota_exhausted_reset', formatResetText(status.resetAt)) : ''}
            {i18n('ai_helper_student_quota_exhausted_hint')}
          </>
        )}
      </div>
    </div>
  );
};
