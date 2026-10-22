import { Icon } from '../components/Icon';
import { teachingReviewStyles } from './teachingReviewStyles';
/**
 * TeachingReviewPanel — compact HydroOJ-style list of teaching summaries.
 *
 * The page intentionally uses flat rows and native Hydro colors instead of
 * dashboard cards so it reads like the surrounding contest/admin pages.
 */

import React, { useEffect } from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, SPACING, RADIUS, getPaginationButtonStyle,
} from '../utils/styles';
import { TeachingFinding, TeachingSummary } from './useTeachingSummary';
import { useTeachingReview, FeedbackStats } from './useTeachingReview';

const PAGE_LIMIT = 20;

const SEVERITY_COLORS: Record<TeachingFinding['severity'], string> = {
  high: '#c23531',
  medium: '#d48806',
  low: COLORS.hydroGreenDark,
};

const STATUS_STYLE: Record<TeachingSummary['status'], { color: string; background: string }> = {
  pending: { color: COLORS.textSecondary, background: '#f3f4f6' },
  generating: { color: COLORS.warningText, background: COLORS.warningBg },
  completed: { color: COLORS.hydroGreenDark, background: COLORS.hydroGreenLight },
  failed: { color: COLORS.errorText, background: COLORS.errorBg },
};

const STATUS_LABEL: Record<TeachingSummary['status'], string> = {
  pending: 'ai_helper_teaching_review_status_pending',
  generating: 'ai_helper_teaching_review_status_generating',
  completed: 'ai_helper_teaching_review_status_completed',
  failed: 'ai_helper_teaching_review_status_failed',
};

function formatDate(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildReviewDetailUrl(summary: TeachingSummary): string {
  const domainPrefix = summary.domainId && summary.domainId !== 'system'
    ? `/d/${encodeURIComponent(summary.domainId)}`
    : '';
  const routeType = summary.contestRule === 'homework' ? 'homework' : 'contest';
  return `${domainPrefix}/${routeType}/${encodeURIComponent(String(summary.contestId))}/scoreboard?aiTab=teaching`;
}

function findPrimaryFinding(findings: TeachingFinding[]): TeachingFinding | undefined {
  return findings.find(finding => finding.severity === 'high')
    || findings.find(finding => finding.severity === 'medium')
    || findings[0];
}

interface SeverityMetricProps {
  severity: TeachingFinding['severity'];
  count: number;
  label: string;
}

const SeverityMetric: React.FC<SeverityMetricProps> = ({ severity, count, label }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
    <span aria-hidden="true" style={{
      width: '7px',
      height: '7px',
      borderRadius: '50%',
      backgroundColor: SEVERITY_COLORS[severity],
      flexShrink: 0,
    }} />
    <span>{label} {count}</span>
  </span>
);

const StatusTag: React.FC<{ status: TeachingSummary['status'] }> = ({ status }) => {
  const style = STATUS_STYLE[status];
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '1px 6px',
      borderRadius: RADIUS.sm,
      color: style.color,
      backgroundColor: style.background,
      fontSize: '12px',
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      {i18n(STATUS_LABEL[status])}
    </span>
  );
};

const SummaryRow: React.FC<{ summary: TeachingSummary }> = ({ summary }) => {
  const findings = Array.isArray(summary.findings) ? summary.findings : [];
  const counts = {
    high: findings.filter(finding => finding.severity === 'high').length,
    medium: findings.filter(finding => finding.severity === 'medium').length,
    low: findings.filter(finding => finding.severity === 'low').length,
  };
  const primaryFinding = findPrimaryFinding(findings);
  const status = summary.status || 'completed';

  const feedbackLabel = summary.feedback?.rating === 'up'
    ? i18n('ai_helper_teaching_review_helpful')
    : summary.feedback?.rating === 'down'
      ? i18n('ai_helper_teaching_review_not_helpful')
      : i18n('ai_helper_teaching_review_unrated');

  const feedbackColor = summary.feedback?.rating === 'up'
    ? COLORS.hydroGreenDark
    : summary.feedback?.rating === 'down'
      ? COLORS.errorText
      : COLORS.textSecondary;

  return (
    <a className="teaching-review-row" href={buildReviewDetailUrl(summary)}
      aria-label={`${summary.contestTitle || summary.contestId} - ${i18n('ai_helper_teaching_review_view')}`}>
      <div className="review-row-content">
        <div className="review-row-title">
          <span>{summary.contestTitle || String(summary.contestId)}</span>
          <StatusTag status={status} />
        </div>
        <div className="review-row-meta">
          <time dateTime={summary.createdAt}>{formatDate(summary.createdAt)}</time>
          <span>{i18n('ai_helper_teaching_review_participated')} {summary.stats?.participatedStudents ?? 0}</span>
          <span>{i18n('ai_helper_teaching_review_ai_users')} {summary.stats?.aiUserCount ?? 0}</span>
        </div>
        <p className="review-row-finding">
          <span className="review-finding-label">{i18n('ai_helper_teaching_review_primary_finding')}</span>
          {primaryFinding?.title || (status === 'failed'
            ? i18n('ai_helper_teaching_review_failed_hint')
            : status === 'pending' || status === 'generating'
              ? i18n(STATUS_LABEL[status]) : i18n('ai_helper_teaching_review_no_findings'))}
        </p>
        <div className="review-row-signals">
          <SeverityMetric severity="high" count={counts.high} label={i18n('ai_helper_teaching_review_focus')} />
          <SeverityMetric severity="medium" count={counts.medium} label={i18n('ai_helper_teaching_review_attention')} />
          <SeverityMetric severity="low" count={counts.low} label={i18n('ai_helper_teaching_review_observation')} />
        </div>
      </div>
      <span className="review-row-action">
        <span style={{ color: feedbackColor }}>{feedbackLabel}</span>
        <span className="review-open">{i18n('ai_helper_teaching_review_view')} <Icon name="chevronRight" size={15} /></span>
      </span>
    </a>
  );
};

interface PaginationProps {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
}

const Pagination: React.FC<PaginationProps> = ({ page, total, onPageChange }) => {
  const totalPages = Math.ceil(total / PAGE_LIMIT);
  if (totalPages <= 1) return null;

  const pages: number[] = [];
  for (let current = Math.max(1, page - 2); current <= Math.min(totalPages, page + 2); current++) {
    pages.push(current);
  }

  const pageButtonStyle = (isActive: boolean, isDisabled = false): React.CSSProperties => ({
    ...getPaginationButtonStyle(isActive, isDisabled),
    borderRadius: RADIUS.sm,
    ...(isActive ? {
      color: '#ffffff',
      backgroundColor: COLORS.hydroGreen,
      borderColor: COLORS.hydroGreen,
    } : {}),
  });

  return (
    <nav aria-label="Pagination" style={{ display: 'flex', justifyContent: 'center', gap: SPACING.xs, paddingTop: SPACING.lg }}>
      <button
        type="button"
        style={pageButtonStyle(false, page <= 1)}
        aria-label={i18n('ai_helper_previous_page')}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <Icon name="chevronLeft" />
      </button>
      {pages.map(current => (
        <button
          type="button"
          key={current}
          style={pageButtonStyle(current === page)}
          aria-current={current === page ? 'page' : undefined}
          onClick={() => onPageChange(current)}
        >
          {current}
        </button>
      ))}
      <button
        type="button"
        style={pageButtonStyle(false, page >= totalPages)}
        aria-label={i18n('ai_helper_next_page')}
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        <Icon name="chevronRight" />
      </button>
    </nav>
  );
};

const FeedbackStatsBar: React.FC<{ stats: FeedbackStats }> = ({ stats }) => {
  const total = stats.up + stats.down;
  if (total === 0) return null;
  const positiveRate = Math.round((stats.up / total) * 100);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: SPACING.base,
      flexWrap: 'wrap',
      padding: `${SPACING.sm} 0 ${SPACING.md}`,
      borderBottom: `1px solid ${COLORS.nativeBorder}`,
      color: COLORS.textSecondary,
      fontSize: '12px',
    }}>
      <strong style={{ color: COLORS.nativeText, fontWeight: 600 }}>
        {i18n('ai_helper_teaching_review_feedback')}
      </strong>
      <span style={{ color: COLORS.hydroGreenDark }}>
        {i18n('ai_helper_teaching_review_helpful')} {stats.up}
      </span>
      <span style={{ color: COLORS.errorText }}>
        {i18n('ai_helper_teaching_review_not_helpful')} {stats.down}
      </span>
      <span style={{ color: COLORS.textMuted }}>
        {i18n('ai_helper_teaching_review_positive_rate', positiveRate)}
      </span>
    </div>
  );
};

interface TeachingReviewPanelProps {
  domainId: string;
}

export const TeachingReviewPanel: React.FC<TeachingReviewPanelProps> = ({ domainId }) => {
  const {
    summaries, total, page, loading, error, feedbackStats, fetchList,
  } = useTeachingReview(domainId);

  useEffect(() => {
    fetchList(1);
  }, [fetchList]);

  const handlePageChange = (targetPage: number) => {
    fetchList(targetPage);
    document.getElementById('ai-teaching-review-heading')?.scrollIntoView({ behavior: 'auto', block: 'start' });
  };

  const initialLoading = loading && summaries.length === 0;

  return (
    <section className="ai-teaching-review" aria-labelledby="ai-teaching-review-heading" aria-busy={loading}>
      <style>{teachingReviewStyles}</style>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: SPACING.base,
        paddingBottom: SPACING.md,
        borderBottom: `1px solid ${COLORS.nativeBorder}`,
      }}>
        <div>
          <h2 id="ai-teaching-review-heading" style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: COLORS.nativeText }}>
            {i18n('ai_helper_dashboard_tab_teaching_review')}
          </h2>
          {!initialLoading && (
            <p style={{ margin: '4px 0 0', color: COLORS.textSecondary, fontSize: '12px' }}>
              {i18n('ai_helper_teaching_review_total', total)}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => fetchList(page)}
          style={{
            padding: '5px 12px',
            color: loading ? COLORS.textMuted : COLORS.nativeText,
            backgroundColor: '#ffffff',
            border: `1px solid ${COLORS.nativeBorder}`,
            borderRadius: RADIUS.sm,
            cursor: loading ? 'wait' : 'pointer',
            fontSize: '13px',
          }}
        >
          <Icon name="refresh" size={14} /> {i18n('ai_helper_teaching_review_refresh')}
        </button>
      </div>

      {!initialLoading && <FeedbackStatsBar stats={feedbackStats} />}

      {error && (
        <div role="alert" style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: SPACING.base,
          marginTop: SPACING.base,
          padding: `${SPACING.sm} ${SPACING.md}`,
          color: COLORS.errorText,
          backgroundColor: COLORS.errorBg,
          borderLeft: `3px solid ${COLORS.error}`,
          fontSize: '13px',
        }}>
          <span>{i18n('ai_helper_teaching_review_load_failed')}: {error}</span>
          <button
            type="button"
            onClick={() => fetchList(page)}
            style={{
              padding: '3px 9px',
              color: COLORS.errorText,
              backgroundColor: '#ffffff',
              border: `1px solid ${COLORS.errorBorder}`,
              borderRadius: RADIUS.sm,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {i18n('ai_helper_teaching_review_retry')}
          </button>
        </div>
      )}

      {initialLoading && (
        <div style={{ padding: SPACING.xl, color: COLORS.textMuted, textAlign: 'center', fontSize: '13px' }}>
          {i18n('ai_helper_teaching_review_loading')}
        </div>
      )}

      {!initialLoading && !error && summaries.length === 0 && (
        <div style={{ padding: SPACING.xl, color: COLORS.textMuted, textAlign: 'center', fontSize: '13px' }}>
          {i18n('ai_helper_teaching_review_empty')}
        </div>
      )}

      {summaries.length > 0 && (
        <div>
          {summaries.map(summary => <SummaryRow key={summary._id} summary={summary} />)}
          <Pagination page={page} total={total} onPageChange={handlePageChange} />
        </div>
      )}
    </section>
  );
};

export default TeachingReviewPanel;
