/**
 * 学生端每日次数（设计稿“学生端面板”①③）
 * - QuotaBar：今日剩余 N / M 次、重置时间、进度条
 * - QuotaBlockedNotice：额度用完 / AI 被管理员关闭，两种文案不同
 */

import React from 'react';
import { i18n } from '../utils/i18n';
import { Icon } from '../components/Icon';
import {
  remainingPercent,
  resetLabel,
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
