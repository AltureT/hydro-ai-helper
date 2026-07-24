import React from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS,
  RADIUS,
  SPACING,
  TYPOGRAPHY,
  cardStyle,
} from '../utils/styles';
import type { JailbreakLogPagination } from './configTypes';

interface JailbreakAnalyticsPanelProps {
  logPagination: JailbreakLogPagination;
  loading: boolean;
}

export const JailbreakAnalyticsPanel: React.FC<JailbreakAnalyticsPanelProps> = ({
  logPagination,
  loading,
}) => {
  const summary = logPagination.summary || {
    total: 0,
    pending: 0,
    confirmed: 0,
    falsePositive: 0,
    reviewed: 0,
    falsePositiveRate: 0,
    appealedPending: 0,
  };
  const summaryItems = [
    { label: i18n('ai_helper_admin_jailbreak_summary_total'), value: summary.total },
    { label: i18n('ai_helper_admin_jailbreak_summary_pending'), value: summary.pending },
    { label: i18n('ai_helper_admin_jailbreak_summary_appealed'), value: summary.appealedPending },
    { label: i18n('ai_helper_admin_jailbreak_summary_reviewed'), value: summary.reviewed },
    { label: i18n('ai_helper_admin_jailbreak_summary_confirmed'), value: summary.confirmed },
    { label: i18n('ai_helper_admin_jailbreak_summary_false_positive'), value: summary.falsePositive },
    {
      label: i18n('ai_helper_admin_jailbreak_summary_false_positive_rate'),
      value: `${summary.falsePositiveRate}%`,
    },
  ];
  const operationalMetrics = logPagination.operationalMetrics;

  return (
    <div
      id="ai-safety-panel-analytics"
      role="tabpanel"
      aria-labelledby="ai-safety-tab-analytics"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.lg,
        marginTop: SPACING.base,
      }}
    >
      <section style={cardStyle}>
        <div style={{ marginBottom: SPACING.base }}>
          <h2 style={{ margin: 0, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
            {i18n('ai_helper_safety_analytics_overview_title')}
          </h2>
          <p style={{ margin: `${SPACING.xs} 0 0`, ...TYPOGRAPHY.xs, color: COLORS.textMuted }}>
            {i18n('ai_helper_safety_analytics_overview_desc')}
          </p>
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: SPACING.sm,
        }}>
          {summaryItems.map((item) => (
            <div key={item.label} style={{
              padding: SPACING.md,
              borderRadius: RADIUS.md,
              backgroundColor: COLORS.bgPage,
              border: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ fontSize: '12px', color: COLORS.textMuted }}>{item.label}</div>
              <div style={{
                marginTop: SPACING.xs,
                fontSize: '20px',
                fontWeight: 600,
                color: COLORS.textPrimary,
              }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={cardStyle}>
        <div style={{ marginBottom: SPACING.base }}>
          <h2 style={{ margin: 0, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
            {operationalMetrics
              ? i18n('ai_helper_admin_jailbreak_operations_title', operationalMetrics.windowDays)
              : i18n('ai_helper_safety_analytics_operations_title')}
          </h2>
          <p style={{ margin: `${SPACING.xs} 0 0`, ...TYPOGRAPHY.xs, color: COLORS.textMuted }}>
            {i18n('ai_helper_safety_analytics_operations_desc')}
          </p>
        </div>
        {operationalMetrics ? (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: SPACING.sm,
              marginBottom: SPACING.base,
            }}>
              {[
                [i18n('ai_helper_admin_jailbreak_operations_total'), operationalMetrics.total],
                [i18n('ai_helper_admin_jailbreak_operations_cooldown'), operationalMetrics.cooldown],
                [i18n('ai_helper_admin_jailbreak_operations_pending_appeals'), operationalMetrics.pendingAppeals],
                [i18n('ai_helper_admin_jailbreak_operations_review_time'), operationalMetrics.averageReviewMinutes ?? '-'],
                [i18n('ai_helper_admin_jailbreak_operations_appeal_time'), operationalMetrics.averageAppealReviewMinutes ?? '-'],
              ].map(([label, value]) => (
                <div key={String(label)} style={{
                  padding: SPACING.md,
                  borderRadius: RADIUS.md,
                  backgroundColor: COLORS.bgPage,
                  border: `1px solid ${COLORS.border}`,
                }}>
                  <div style={{ fontSize: '12px', color: COLORS.textMuted }}>{label}</div>
                  <div style={{
                    marginTop: SPACING.xs,
                    fontWeight: 600,
                    color: COLORS.textPrimary,
                  }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
            {operationalMetrics.dailyTrend.length > 0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ color: COLORS.textSecondary, textAlign: 'left' }}>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_trend_date')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_total')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_operations_cooldown')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_appealed')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_false_positive')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operationalMetrics.dailyTrend.map((row) => (
                      <tr key={row.date} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                        <td style={{ padding: SPACING.sm }}>{row.date}</td>
                        <td style={{ padding: SPACING.sm }}>{row.total}</td>
                        <td style={{ padding: SPACING.sm }}>{row.cooldown}</td>
                        <td style={{ padding: SPACING.sm }}>{row.appealed}</td>
                        <td style={{ padding: SPACING.sm }}>{row.falsePositive}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{
                padding: SPACING.base,
                borderRadius: RADIUS.md,
                border: `1px dashed ${COLORS.border}`,
                backgroundColor: COLORS.bgPage,
                color: COLORS.textMuted,
                fontSize: '14px',
              }}>
                {i18n('ai_helper_safety_analytics_no_trend')}
              </div>
            )}
          </>
        ) : (
          <div style={{
            padding: SPACING.base,
            borderRadius: RADIUS.md,
            border: `1px dashed ${COLORS.border}`,
            backgroundColor: COLORS.bgPage,
            color: COLORS.textMuted,
            fontSize: '14px',
          }}>
            {loading
              ? i18n('ai_helper_safety_analytics_loading')
              : i18n('ai_helper_safety_analytics_no_operations')}
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <div style={{ marginBottom: SPACING.base }}>
          <h2 style={{ margin: 0, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
            {i18n('ai_helper_admin_jailbreak_rule_quality_title')}
          </h2>
          <p style={{ margin: `${SPACING.xs} 0 0`, ...TYPOGRAPHY.xs, color: COLORS.textMuted }}>
            {i18n('ai_helper_safety_analytics_rule_quality_desc')}
          </p>
        </div>
        {logPagination.ruleMetrics?.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ color: COLORS.textSecondary, textAlign: 'left' }}>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_rule')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_filter_category')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_total')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_pending')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_confirmed')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_false_positive')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_false_positive_rate')}</th>
                </tr>
              </thead>
              <tbody>
                {logPagination.ruleMetrics.map((metric) => (
                  <tr
                    key={`${metric.category || ''}:${metric.matchedPattern}`}
                    style={{ borderTop: `1px solid ${COLORS.border}` }}
                  >
                    <td style={{ padding: SPACING.sm, maxWidth: '280px', wordBreak: 'break-all' }}>
                      <code>{metric.matchedPattern}</code>
                    </td>
                    <td style={{ padding: SPACING.sm }}>{metric.category || '-'}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.total}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.pending}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.confirmed}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.falsePositive}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.falsePositiveRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{
            padding: SPACING.base,
            borderRadius: RADIUS.md,
            border: `1px dashed ${COLORS.border}`,
            backgroundColor: COLORS.bgPage,
            color: COLORS.textMuted,
            fontSize: '14px',
          }}>
            {loading
              ? i18n('ai_helper_safety_analytics_loading')
              : i18n('ai_helper_safety_analytics_no_rule_quality')}
          </div>
        )}
      </section>
    </div>
  );
};

export default JailbreakAnalyticsPanel;
