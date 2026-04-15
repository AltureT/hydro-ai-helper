/**
 * TeachingReviewPanel — timeline list of all teaching summaries in the domain.
 * Shows date, contest title, severity-dot counts, top high-priority findings,
 * and student stats. Supports pagination.
 */

import React, { useEffect } from 'react';
import { i18n } from '@hydrooj/ui-default';
import {
  COLORS, SPACING, RADIUS,
  cardStyle, getButtonStyle, getPaginationButtonStyle,
} from '../utils/styles';
import { TeachingSummary } from './useTeachingSummary';
import { useTeachingReview, FeedbackStats } from './useTeachingReview';

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_DOTS: Record<'high' | 'medium' | 'low', string> = {
  high: '#DC2626',
  medium: '#D97706',
  low: '#16A34A',
};

const PAGE_LIMIT = 20;

// ─── Sub-components ───────────────────────────────────────────────────────────

interface SeverityDotProps {
  color: string;
  count: number;
  label: string;
}

const SeverityDot: React.FC<SeverityDotProps> = ({ color, count, label }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: SPACING.sm }}>
    <span style={{
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      backgroundColor: color,
      flexShrink: 0,
    }} />
    <span style={{ fontSize: '12px', color: COLORS.textSecondary }}>{label}: {count}</span>
  </span>
);

interface SummaryCardProps {
  summary: TeachingSummary;
}

const SummaryCard: React.FC<SummaryCardProps> = ({ summary }) => {
  const highFindings = summary.findings.filter(f => f.severity === 'high');
  const mediumCount = summary.findings.filter(f => f.severity === 'medium').length;
  const lowCount = summary.findings.filter(f => f.severity === 'low').length;

  const dateStr = summary.createdAt
    ? new Date(summary.createdAt).toLocaleDateString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
      })
    : '';

  // Navigate to the contest scoreboard with teaching tab
  const handleClick = () => {
    const contestId = String(summary.contestId);
    // Try homework path first (most common), browser will redirect if wrong
    const domainPrefix = summary.domainId && summary.domainId !== 'system'
      ? `/d/${summary.domainId}` : '';
    window.location.href = `${domainPrefix}/homework/${contestId}/scoreboard`;
  };

  return (
    <div
      onClick={handleClick}
      style={{
        ...cardStyle,
        marginBottom: SPACING.base,
        borderLeft: highFindings.length > 0 ? `3px solid ${SEVERITY_DOTS.high}` : `3px solid ${COLORS.border}`,
        cursor: 'pointer',
        transition: 'box-shadow 200ms ease, border-color 200ms ease',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = ''; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: SPACING.sm }}>
        <div>
          <span style={{ fontSize: '13px', color: COLORS.textMuted, marginRight: SPACING.sm }}>{dateStr}</span>
          <span style={{ fontSize: '15px', fontWeight: 600, color: COLORS.textPrimary }}>
            {summary.contestTitle || summary.contestId}
          </span>
        </div>
        <div style={{ display: 'flex', gap: SPACING.base, fontSize: '12px', color: COLORS.textSecondary }}>
          <span>参与: {summary.stats?.participatedStudents ?? 0}</span>
          <span>AI: {summary.stats?.aiUserCount ?? 0}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', marginBottom: SPACING.sm }}>
        <SeverityDot color={SEVERITY_DOTS.high} count={highFindings.length} label="高" />
        <SeverityDot color={SEVERITY_DOTS.medium} count={mediumCount} label="中" />
        <SeverityDot color={SEVERITY_DOTS.low} count={lowCount} label="低" />
      </div>

      {highFindings.length > 0 && (
        <div style={{ marginTop: SPACING.sm }}>
          {highFindings.slice(0, 2).map(f => (
            <div key={f.id} style={{
              padding: `${SPACING.xs} ${SPACING.sm}`,
              backgroundColor: '#FEF2F2',
              borderRadius: RADIUS.sm,
              marginBottom: SPACING.xs,
              fontSize: '13px',
              color: '#991B1B',
            }}>
              {f.title}
            </div>
          ))}
          {highFindings.length > 2 && (
            <div style={{ fontSize: '12px', color: COLORS.textMuted, marginTop: SPACING.xs }}>
              +{highFindings.length - 2} 项高优先级发现
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: SPACING.sm }}>
        {summary.feedback ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            fontSize: '12px',
            color: summary.feedback.rating === 'up' ? '#16A34A' : '#DC2626',
          }}>
            {summary.feedback.rating === 'up' ? '\u{1F44D}' : '\u{1F44E}'}
            {summary.feedback.rating === 'up' ? '有帮助' : '没帮助'}
          </span>
        ) : (
          <span style={{ fontSize: '12px', color: COLORS.textMuted }}>
            未评价
          </span>
        )}
        <span style={{ fontSize: '12px', color: COLORS.primary }}>
          查看详细分析 →
        </span>
      </div>
    </div>
  );
};

// ─── Pagination ───────────────────────────────────────────────────────────────

interface PaginationProps {
  page: number;
  total: number;
  onPageChange: (p: number) => void;
}

const Pagination: React.FC<PaginationProps> = ({ page, total, onPageChange }) => {
  const totalPages = Math.ceil(total / PAGE_LIMIT);
  if (totalPages <= 1) return null;

  const pages: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) {
    pages.push(p);
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: SPACING.xs, marginTop: SPACING.lg }}>
      <button
        style={getPaginationButtonStyle(false, page <= 1)}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        {'<'}
      </button>
      {pages.map(p => (
        <button
          key={p}
          style={getPaginationButtonStyle(p === page)}
          onClick={() => onPageChange(p)}
        >
          {p}
        </button>
      ))}
      <button
        style={getPaginationButtonStyle(false, page >= totalPages)}
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        {'>'}
      </button>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

interface TeachingReviewPanelProps {
  domainId: string;
}

// ─── Feedback stats bar ──────────────────────────────────────────────────────

const FeedbackStatsBar: React.FC<{ stats: FeedbackStats }> = ({ stats }) => {
  const total = stats.up + stats.down;
  if (total === 0) return null;

  const upPct = Math.round((stats.up / total) * 100);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: SPACING.base,
      padding: `${SPACING.sm} ${SPACING.base}`,
      backgroundColor: '#F8FAFC',
      borderRadius: RADIUS.md,
      marginBottom: SPACING.lg,
      fontSize: '13px',
    }}>
      <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>教学总结反馈</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#16A34A' }}>
        {'\u{1F44D}'} {stats.up}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#DC2626' }}>
        {'\u{1F44E}'} {stats.down}
      </span>
      {/* Progress bar */}
      <div style={{
        flex: 1, height: '6px', backgroundColor: '#FEE2E2',
        borderRadius: '3px', overflow: 'hidden', minWidth: '60px',
      }}>
        <div style={{
          width: `${upPct}%`, height: '100%',
          backgroundColor: '#16A34A', borderRadius: '3px',
          transition: 'width 300ms ease',
        }} />
      </div>
      <span style={{ color: COLORS.textMuted, fontSize: '12px' }}>
        {upPct}% 好评
      </span>
    </div>
  );
};

export const TeachingReviewPanel: React.FC<TeachingReviewPanelProps> = ({ domainId }) => {
  const { summaries, total, page, loading, feedbackStats, fetchList } = useTeachingReview(domainId);

  useEffect(() => {
    fetchList(1);
  }, [fetchList]);

  const handlePageChange = (p: number) => {
    fetchList(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div style={{ padding: SPACING.lg }}>
      {/* Panel header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.lg }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: COLORS.textPrimary }}>
            {i18n('ai_helper_dashboard_tab_teaching_review') || '教学总结回顾'}
          </h2>
          {!loading && total > 0 && (
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: COLORS.textSecondary }}>
              共 {total} 条记录
            </p>
          )}
        </div>
        <button
          style={getButtonStyle('secondary')}
          onClick={() => fetchList(page)}
        >
          刷新
        </button>
      </div>

      {/* Feedback stats */}
      {!loading && <FeedbackStatsBar stats={feedbackStats} />}

      {/* Loading state */}
      {loading && (
        <div style={{ textAlign: 'center', padding: SPACING.xl, color: COLORS.textMuted }}>
          加载中...
        </div>
      )}

      {/* Empty state */}
      {!loading && summaries.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: SPACING.xl,
          color: COLORS.textMuted,
          border: `2px dashed ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          fontSize: '14px',
        }}>
          暂无教学总结记录
        </div>
      )}

      {/* Summary list */}
      {!loading && summaries.length > 0 && (
        <div>
          {summaries.map(s => (
            <SummaryCard key={s._id} summary={s} />
          ))}
          <Pagination page={page} total={total} onPageChange={handlePageChange} />
        </div>
      )}
    </div>
  );
};

export default TeachingReviewPanel;
