/**
 * MetricsPanel — 对话有效性信号展示组件
 * 共享用于 ConversationDetail 页面和 ConversationDetailModal
 */

import React, { useState } from 'react';
import { i18n } from '@hydrooj/ui-default';
import type { ConversationMetricsDTO, MetricsStatus } from './analyticsTypes';
import {
  COLORS, SPACING, RADIUS, SHADOWS, TYPOGRAPHY,
  cardStyle, getAlertStyle,
} from '../utils/styles';

interface MetricsPanelProps {
  metrics?: ConversationMetricsDTO;
  metricsStatus: MetricsStatus;
  compact?: boolean;
}

function MetricItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
      <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{label}</div>
      <div style={{ ...TYPOGRAPHY.sm, fontWeight: 500, color: COLORS.textPrimary }}>{value}</div>
    </div>
  );
}

function DifficultyBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: SPACING.sm }}>
      <span style={{
        display: 'inline-block',
        width: '80px',
        height: '8px',
        backgroundColor: COLORS.bgHover,
        borderRadius: RADIUS.full,
        overflow: 'hidden',
      }}>
        <span style={{
          display: 'block',
          width: `${pct}%`,
          height: '100%',
          backgroundColor: pct >= 70 ? COLORS.success : pct >= 30 ? COLORS.accent : COLORS.error,
          borderRadius: RADIUS.full,
        }} />
      </span>
      <span>{pct}%</span>
    </span>
  );
}

function CompactMetrics({ metrics, metricsStatus }: MetricsPanelProps) {
  const m = metrics;
  if (!m) return null;

  const parts: string[] = [];
  parts.push(`\u{1F4AC}${m.studentMessageCount}`);

  if (metricsStatus === 'pending') {
    parts.push(`\u23F3`);
  } else if (m.submissionsAfter !== null) {
    parts.push(`\u{1F4DD}${m.submissionsAfter}`);
    if (m.firstAcceptedIndex !== null) {
      parts.push(`\u2705AC(#${m.firstAcceptedIndex + 1})`);
    } else if (m.submissionsAfter > 0) {
      parts.push(`\u274C`);
    }
  }

  if (m.problemDifficulty !== null) {
    parts.push(`${i18n('ai_helper_teacher_metrics_difficulty')} ${Math.round(m.problemDifficulty * 100)}%`);
  }

  return (
    <span style={{ fontSize: '13px', color: COLORS.textSecondary }}>
      {parts.join(' \u00B7 ')}
    </span>
  );
}

export function MetricsPanel({ metrics, metricsStatus, compact = false }: MetricsPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (metricsStatus === 'legacy' || !metrics) return null;

  if (compact) {
    return <CompactMetrics metrics={metrics} metricsStatus={metricsStatus} />;
  }

  const m = metrics;
  const avgLength = m.studentMessageCount > 0
    ? Math.round(m.studentTotalLength / m.studentMessageCount)
    : 0;

  return (
    <div style={{ ...cardStyle, marginBottom: SPACING.xl }}>
      <h2
        style={{
          margin: `0 0 ${collapsed ? '0' : SPACING.lg}`,
          ...TYPOGRAPHY.md,
          color: COLORS.textPrimary,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
        onClick={() => setCollapsed(!collapsed)}
      >
        {i18n('ai_helper_teacher_metrics_title')}
        <span style={{ fontSize: '12px', color: COLORS.textMuted }}>
          {collapsed ? '\u25B6' : '\u25BC'}
        </span>
      </h2>

      {!collapsed && (
        <>
          <div style={{ marginBottom: SPACING.base }}>
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.sm, fontWeight: 600 }}>
              {i18n('ai_helper_teacher_metrics_engagement')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SPACING.sm }}>
              <MetricItem
                label={i18n('ai_helper_teacher_metrics_msg_count')}
                value={m.studentMessageCount}
              />
              <MetricItem
                label={i18n('ai_helper_teacher_metrics_avg_length')}
                value={`${avgLength} ${i18n('ai_helper_teacher_metrics_chars')}`}
              />
            </div>
          </div>

          <div style={{ marginBottom: SPACING.base }}>
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.sm, fontWeight: 600 }}>
              {i18n('ai_helper_teacher_metrics_context')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SPACING.sm }}>
              <MetricItem
                label={i18n('ai_helper_teacher_metrics_difficulty')}
                value={m.problemDifficulty !== null
                  ? <DifficultyBar value={m.problemDifficulty} />
                  : i18n('ai_helper_teacher_metrics_unknown')}
              />
            </div>
          </div>

          <div style={{ marginBottom: SPACING.base }}>
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.sm, fontWeight: 600 }}>
              {i18n('ai_helper_teacher_metrics_outcome')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SPACING.sm }}>
              {metricsStatus === 'pending' ? (
                <MetricItem
                  label={i18n('ai_helper_teacher_metrics_subs_after')}
                  value={<span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_teacher_signal_pending')}</span>}
                />
              ) : m.submissionsAfter === null ? (
                <MetricItem
                  label={i18n('ai_helper_teacher_metrics_subs_after')}
                  value={i18n('ai_helper_teacher_signal_no_problem')}
                />
              ) : (
                <>
                  <MetricItem
                    label={i18n('ai_helper_teacher_metrics_subs_after')}
                    value={m.submissionsAfter}
                  />
                  <MetricItem
                    label={i18n('ai_helper_teacher_metrics_first_ac')}
                    value={m.firstAcceptedIndex !== null
                      ? i18n('ai_helper_teacher_metrics_submission_n').replace('{0}', String(m.firstAcceptedIndex + 1))
                      : i18n('ai_helper_teacher_metrics_none')}
                  />
                </>
              )}
            </div>
          </div>

          <div style={getAlertStyle('info')}>
            {i18n('ai_helper_teacher_metrics_disclaimer')}
          </div>
        </>
      )}
    </div>
  );
}
