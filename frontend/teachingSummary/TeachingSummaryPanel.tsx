/**
 * TeachingSummaryPanel — teacher-facing UI for AI teaching summary generation.
 * Injects into homework/contest scoreboard pages for whole-class analysis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { i18n } from '@hydrooj/ui-default';
import {
  COLORS, SPACING, RADIUS, SHADOWS,
  getButtonStyle, cardStyle, markdownTheme,
} from '../utils/styles';
import { renderMarkdown } from '../utils/markdown';
import { useTeachingSummary, TeachingFinding, TeachingSummary } from './useTeachingSummary';

// ─── i18n with fallback ───────────────────────────────────────────────────────

const I18N_FALLBACK: Record<string, string> = {
  ai_helper_teaching_summary_title: 'AI 教学分析',
  ai_helper_teaching_summary_generate: '生成教学总结',
  ai_helper_teaching_summary_regenerate: '重新生成',
  ai_helper_teaching_summary_generating: '分析中...',
  ai_helper_teaching_summary_loading: '加载中...',
  ai_helper_teaching_summary_focus_placeholder: '可选：输入教学重点（如"递归理解"或"复杂度优化"）',
  ai_helper_teaching_summary_snapshot_notice: '数据快照时间：',
  ai_helper_teaching_summary_participated: '参与学生',
  ai_helper_teaching_summary_findings: '发现项',
  ai_helper_teaching_summary_high_priority: '高优先级',
  ai_helper_teaching_summary_ai_users: 'AI 使用者',
  ai_helper_teaching_summary_low_data_warning: '参与学生不足 10 人，分析结果仅供参考。',
  ai_helper_teaching_summary_findings_title: '教学发现',
  ai_helper_teaching_summary_no_findings: '未发现明显问题',
  ai_helper_teaching_summary_overall_suggestion: 'AI 综合建议',
  ai_helper_teaching_summary_expand: '展开',
  ai_helper_teaching_summary_collapse: '收起',
  ai_helper_teaching_summary_affected: '涉及',
  ai_helper_teaching_summary_students: '名学生',
  ai_helper_teaching_summary_feedback_helpful: '有帮助',
  ai_helper_teaching_summary_feedback_not_helpful: '没帮助',
  ai_helper_teaching_summary_feedback_thanks: '感谢反馈！',
  ai_helper_teaching_summary_copy_warning: '共性错误代码示例：',
  ai_helper_teaching_summary_failed: '生成失败，请重试',
  ai_helper_teaching_summary_empty: '暂无教学总结，点击上方按钮生成',
  ai_helper_teaching_summary_generating_notice: '正在分析学生学习数据，请稍候...',
};

function t(key: string): string {
  const val = i18n(key);
  return val === key ? (I18N_FALLBACK[key] || val) : val;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<string, string> = {
  commonError: '共性错误',
  comprehension: '题意理解',
  strategy: '学习策略',
  atRisk: '高危预警',
  difficulty: '难度异常',
  progress: '进步趋势',
  cognitivePath: '认知路径',
  aiEffectiveness: 'AI 实效',
};

const SEVERITY_COLORS = {
  high: { bg: '#FEF2F2', text: '#DC2626', border: '#FECACA' },
  medium: { bg: '#FFFBEB', text: '#D97706', border: '#FDE68A' },
  low: { bg: '#F0FDF4', text: '#16A34A', border: '#BBF7D0' },
};

// ─── FindingCard subcomponent ─────────────────────────────────────────────────

interface FindingCardProps {
  finding: TeachingFinding;
  deepDiveText?: string;
}

const FindingCard: React.FC<FindingCardProps> = ({ finding, deepDiveText }) => {
  const [expanded, setExpanded] = useState(false);
  const colors = SEVERITY_COLORS[finding.severity] || SEVERITY_COLORS.low;
  const dimensionLabel = DIMENSION_LABELS[finding.dimension] || finding.dimension;
  const affectedCount = finding.evidence.affectedStudents.length;

  return (
    <div style={{
      backgroundColor: COLORS.bgCard,
      border: `1px solid ${COLORS.border}`,
      borderLeft: `3px solid ${colors.text}`,
      borderRadius: RADIUS.md,
      marginBottom: SPACING.md,
      overflow: 'hidden',
      transition: 'box-shadow 200ms ease',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: SPACING.sm,
          padding: `${SPACING.md} ${SPACING.base}`,
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{
          fontSize: '11px', fontWeight: 600, padding: '2px 8px',
          borderRadius: RADIUS.sm,
          backgroundColor: colors.bg,
          border: `1px solid ${colors.border}`,
          color: colors.text,
          flexShrink: 0,
          letterSpacing: '0.02em',
        }}>
          {dimensionLabel}
        </span>

        <span style={{
          flex: 1, fontSize: '14px', fontWeight: 500,
          color: COLORS.textPrimary, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {finding.title}
        </span>

        <span style={{
          fontSize: '12px', color: COLORS.textMuted, flexShrink: 0,
          padding: '2px 8px',
          backgroundColor: COLORS.bgPage,
          borderRadius: RADIUS.full,
        }}>
          {t('ai_helper_teaching_summary_affected')} {affectedCount} {t('ai_helper_teaching_summary_students')}
        </span>

        <span style={{
          display: 'inline-block', width: '16px', height: '16px', flexShrink: 0,
          textAlign: 'center', lineHeight: '16px', fontSize: '12px',
          color: COLORS.textMuted,
          transition: 'transform 200ms ease',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
      </div>

      {expanded && (
        <div style={{
          padding: `0 ${SPACING.base} ${SPACING.base}`,
          borderTop: `1px solid ${COLORS.border}`,
          paddingTop: SPACING.md,
        }}>
          {Object.keys(finding.evidence.metrics).length > 0 && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: SPACING.sm,
              marginBottom: SPACING.md,
              padding: `${SPACING.sm} ${SPACING.md}`,
              backgroundColor: COLORS.bgPage,
              borderRadius: RADIUS.sm,
            }}>
              {Object.entries(finding.evidence.metrics).map(([key, val]) => (
                <span key={key} style={{
                  fontSize: '12px', color: COLORS.textSecondary,
                }}>
                  <span style={{ color: COLORS.textMuted }}>{key}:</span>{' '}
                  <strong>{typeof val === 'number' ? (val % 1 === 0 ? val : val.toFixed(2)) : val}</strong>
                </span>
              ))}
            </div>
          )}

          {finding.aiSuggestion && (
            <div style={{ fontSize: '13px', color: COLORS.textSecondary, marginBottom: SPACING.md, lineHeight: 1.6 }}>
              <strong>{DIMENSION_LABELS[finding.dimension] || finding.dimension}：</strong>
              {finding.aiSuggestion}
            </div>
          )}

          {deepDiveText && (
            <div
              className="markdown-body"
              style={{ marginTop: SPACING.sm }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(deepDiveText) }}
            />
          )}

          {(finding.dimension === 'commonError' || finding.dimension === 'errorCluster')
            && finding.evidence.samples?.code && finding.evidence.samples.code.length > 0 && (
            <div style={{ marginTop: SPACING.md }}>
              <div style={{
                fontSize: '12px', fontWeight: 600, color: COLORS.textSecondary,
                marginBottom: SPACING.sm, letterSpacing: '0.02em',
              }}>
                {t('ai_helper_teaching_summary_copy_warning')}
              </div>
              <pre style={{
                margin: 0, fontSize: '13px', overflowX: 'auto',
                backgroundColor: '#1e293b', borderRadius: RADIUS.md,
                padding: SPACING.base, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                color: '#e2e8f0', lineHeight: 1.6,
                fontFamily: "'SFMono-Regular', 'Menlo', 'Consolas', monospace",
              }}>
                {finding.evidence.samples.code[0]}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Overview bar ─────────────────────────────────────────────────────────────

interface OverviewBarProps {
  stats: TeachingSummary['stats'];
  findingsCount: number;
  highCount: number;
}

const OverviewBar: React.FC<OverviewBarProps> = ({ stats, findingsCount, highCount }) => (
  <div style={{
    display: 'flex', flexWrap: 'wrap', gap: SPACING.lg,
    marginBottom: SPACING.base,
    padding: `${SPACING.sm} 0`,
  }}>
    {[
      { label: t('ai_helper_teaching_summary_participated'), value: stats.participatedStudents },
      { label: t('ai_helper_teaching_summary_findings'), value: findingsCount },
      { label: t('ai_helper_teaching_summary_high_priority'), value: highCount, highlight: highCount > 0 },
      { label: t('ai_helper_teaching_summary_ai_users'), value: stats.aiUserCount },
    ].map(({ label, value, highlight }) => (
      <span key={label} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '4px' }}>
        <span style={{ fontSize: '12px', color: COLORS.textMuted }}>{label}</span>
        <span style={{
          fontSize: '18px', fontWeight: 700,
          color: highlight ? COLORS.error : COLORS.textPrimary,
        }}>
          {value}
        </span>
      </span>
    ))}
  </div>
);

// ─── Main panel ───────────────────────────────────────────────────────────────

interface TeachingSummaryPanelProps {
  domainId: string;
  contestId: string;
  /** Callback to report findings count for parent tab badge */
  onStatsUpdate?: (findingsCount: number) => void;
}

export const TeachingSummaryPanel: React.FC<TeachingSummaryPanelProps> = ({ domainId, contestId, onStatsUpdate }) => {
  const { summary, loading, error, fetchSummary, generate, submitFeedback } = useTeachingSummary(domainId, contestId);

  const [teachingFocus, setTeachingFocus] = useState('');
  const [suggestionExpanded, setSuggestionExpanded] = useState(true);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  useEffect(() => {
    fetchSummary();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Report findings count to parent for tab badge
  useEffect(() => {
    if (onStatsUpdate && summary?.findings) {
      onStatsUpdate(summary.findings.length);
    }
  }, [summary?.findings?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = useCallback(async (regenerate?: boolean) => {
    if (regenerate) {
      const confirmed = window.confirm('将重新生成教学总结，旧数据将被覆盖。确认继续？');
      if (!confirmed) return;
    }
    await generate(teachingFocus || undefined, regenerate);
  }, [generate, teachingFocus]);

  const handleFeedback = useCallback(async (rating: 'up' | 'down') => {
    if (!summary) return;
    await submitFeedback(String(summary._id), rating);
    setFeedbackSubmitted(true);
  }, [summary, submitFeedback]);

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading && !summary) {
    return (
      <div style={{ textAlign: 'center', padding: SPACING.xl, color: COLORS.textMuted, fontSize: '14px' }}>
        {t('ai_helper_teaching_summary_loading')}
      </div>
    );
  }

  // ── No summary yet ────────────────────────────────────────────────────────

  if (!summary) {
    return (
      <div style={{ ...cardStyle, fontFamily: 'inherit' }}>
        <style>{markdownTheme}</style>
        <div style={{ marginBottom: SPACING.base, fontWeight: 600, fontSize: '16px', color: COLORS.textPrimary }}>
          {t('ai_helper_teaching_summary_title')}
        </div>
        <input
          type="text"
          value={teachingFocus}
          onChange={e => setTeachingFocus(e.target.value)}
          placeholder={t('ai_helper_teaching_summary_focus_placeholder')}
          style={{
            width: '100%', padding: `${SPACING.sm} ${SPACING.md}`,
            fontSize: '14px', border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md, marginBottom: SPACING.base,
            outline: 'none', boxSizing: 'border-box',
          }}
        />
        {error && (
          <div style={{
            padding: `${SPACING.sm} ${SPACING.base}`,
            backgroundColor: COLORS.errorBg, color: COLORS.errorText,
            borderLeft: `4px solid ${COLORS.errorBorder}`,
            borderRadius: RADIUS.md, fontSize: '13px',
            marginBottom: SPACING.base,
          }}>
            {error}
          </div>
        )}
        <button
          onClick={() => handleGenerate(false)}
          disabled={loading}
          style={{ ...getButtonStyle('primary'), opacity: loading ? 0.6 : 1 }}
        >
          {loading ? t('ai_helper_teaching_summary_generating') : t('ai_helper_teaching_summary_generate')}
        </button>
        <div style={{
          marginTop: SPACING.base, textAlign: 'center',
          color: COLORS.textMuted, fontSize: '13px',
          border: `2px dashed ${COLORS.border}`, borderRadius: RADIUS.lg,
          padding: SPACING.xl,
        }}>
          {t('ai_helper_teaching_summary_empty')}
        </div>
      </div>
    );
  }

  // ── Generating state ──────────────────────────────────────────────────────

  if (summary.status === 'pending' || summary.status === 'generating') {
    return (
      <div style={{ ...cardStyle, fontFamily: 'inherit', textAlign: 'center' }}>
        <style>{markdownTheme}</style>
        <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: SPACING.base, color: COLORS.textPrimary }}>
          {t('ai_helper_teaching_summary_title')}
        </div>
        <div style={{
          display: 'inline-block', width: '24px', height: '24px',
          border: `3px solid ${COLORS.border}`,
          borderTopColor: COLORS.primary,
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          marginBottom: SPACING.base,
        }} />
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <div style={{ color: COLORS.textMuted, fontSize: '14px' }}>
          {t('ai_helper_teaching_summary_generating_notice')}
        </div>
      </div>
    );
  }

  // ── Failed state ──────────────────────────────────────────────────────────

  if (summary.status === 'failed') {
    return (
      <div style={{ ...cardStyle, fontFamily: 'inherit' }}>
        <style>{markdownTheme}</style>
        <div style={{ marginBottom: SPACING.base, fontWeight: 600, fontSize: '16px', color: COLORS.textPrimary }}>
          {t('ai_helper_teaching_summary_title')}
        </div>
        <div style={{
          padding: `${SPACING.sm} ${SPACING.base}`,
          backgroundColor: COLORS.errorBg, color: COLORS.errorText,
          borderLeft: `4px solid ${COLORS.errorBorder}`,
          borderRadius: RADIUS.md, fontSize: '13px', marginBottom: SPACING.base,
        }}>
          {t('ai_helper_teaching_summary_failed')}
        </div>
        <button onClick={() => handleGenerate(true)} style={getButtonStyle('primary')}>
          {t('ai_helper_teaching_summary_regenerate')}
        </button>
      </div>
    );
  }

  // ── Completed state ───────────────────────────────────────────────────────

  const findings = summary.findings || [];
  const highFindings = findings.filter(f => f.severity === 'high');
  const mediumFindings = findings.filter(f => f.severity === 'medium');
  const lowFindings = findings.filter(f => f.severity === 'low');

  const snapshotDate = summary.dataSnapshotAt
    ? new Date(summary.dataSnapshotAt).toLocaleString('zh-CN', { hour12: false })
    : '';

  return (
    <div style={{ fontFamily: 'inherit', color: COLORS.textPrimary }}>
      <style>{markdownTheme}</style>

      {/* Panel header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: SPACING.lg,
        paddingBottom: SPACING.md,
        borderBottom: `1px solid ${COLORS.border}`,
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '18px', color: COLORS.textPrimary }}>
            {t('ai_helper_teaching_summary_title')}
          </div>
          {snapshotDate && (
            <div style={{ fontSize: '12px', color: COLORS.textMuted, marginTop: '4px' }}>
              {t('ai_helper_teaching_summary_snapshot_notice')}{snapshotDate}
            </div>
          )}
        </div>
        <button
          onClick={() => handleGenerate(true)}
          disabled={loading}
          style={{ ...getButtonStyle('secondary'), fontSize: '13px' }}
        >
          {t('ai_helper_teaching_summary_regenerate')}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: `${SPACING.sm} ${SPACING.base}`,
          backgroundColor: COLORS.errorBg, color: COLORS.errorText,
          borderLeft: `4px solid ${COLORS.errorBorder}`,
          borderRadius: RADIUS.md, fontSize: '13px', marginBottom: SPACING.base,
        }}>
          {error}
        </div>
      )}

      {/* Overview bar */}
      <OverviewBar
        stats={summary.stats}
        findingsCount={findings.length}
        highCount={highFindings.length}
      />

      {/* Low-data warning */}
      {summary.stats.participatedStudents < 10 && (
        <div style={{
          padding: `${SPACING.sm} ${SPACING.base}`,
          backgroundColor: COLORS.warningBg,
          border: `1px solid ${COLORS.warningBorder}`,
          borderRadius: RADIUS.md,
          fontSize: '13px', color: COLORS.warningText,
          marginBottom: SPACING.base,
        }}>
          {t('ai_helper_teaching_summary_low_data_warning')}
        </div>
      )}

      {/* Findings list */}
      <div style={{ marginBottom: SPACING.lg }}>
        <div style={{
          fontWeight: 600, fontSize: '13px', marginBottom: SPACING.md,
          color: COLORS.textMuted, textTransform: 'uppercase' as const,
          letterSpacing: '0.05em',
        }}>
          {t('ai_helper_teaching_summary_findings_title')}
        </div>

        {findings.length === 0 ? (
          <div style={{ color: COLORS.textMuted, fontSize: '13px', fontStyle: 'italic' }}>
            {t('ai_helper_teaching_summary_no_findings')}
          </div>
        ) : (
          <>
            {highFindings.length > 0 && (
              <div style={{ marginBottom: SPACING.sm }}>
                {highFindings.map(f => (
                  <FindingCard key={f.id} finding={f} deepDiveText={summary.deepDiveResults?.[f.id]} />
                ))}
              </div>
            )}
            {mediumFindings.length > 0 && (
              <div style={{ marginBottom: SPACING.sm }}>
                {mediumFindings.map(f => (
                  <FindingCard key={f.id} finding={f} deepDiveText={summary.deepDiveResults?.[f.id]} />
                ))}
              </div>
            )}
            {lowFindings.length > 0 && (
              <div>
                {lowFindings.map(f => (
                  <FindingCard key={f.id} finding={f} deepDiveText={summary.deepDiveResults?.[f.id]} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Overall AI suggestion */}
      {summary.overallSuggestion && (
        <div style={{
          border: `1px solid ${COLORS.border}`,
          borderLeft: `4px solid ${COLORS.hydroGreen}`,
          borderRadius: RADIUS.md,
          marginBottom: SPACING.lg,
          overflow: 'hidden',
        }}>
          <div
            onClick={() => setSuggestionExpanded(!suggestionExpanded)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: `${SPACING.md} ${SPACING.base}`,
              cursor: 'pointer', userSelect: 'none',
              backgroundColor: COLORS.hydroGreenLight,
              borderBottom: suggestionExpanded ? `1px solid ${COLORS.border}` : 'none',
            }}
          >
            <span style={{
              fontWeight: 600, fontSize: '13px', color: COLORS.hydroGreenDark,
              textTransform: 'uppercase' as const, letterSpacing: '0.05em',
            }}>
              {t('ai_helper_teaching_summary_overall_suggestion')}
            </span>
            <span style={{ fontSize: '12px', color: COLORS.textMuted }}>
              {suggestionExpanded ? t('ai_helper_teaching_summary_collapse') : t('ai_helper_teaching_summary_expand')}
            </span>
          </div>
          {suggestionExpanded && (
            <div
              className="markdown-body"
              style={{ padding: `${SPACING.base} ${SPACING.lg}` }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.overallSuggestion) }}
            />
          )}
        </div>
      )}

      {/* Feedback section */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: SPACING.sm,
        padding: `${SPACING.sm} 0`,
        borderTop: `1px solid ${COLORS.border}`,
      }}>
        {feedbackSubmitted ? (
          <span style={{ fontSize: '13px', color: COLORS.successText }}>
            {t('ai_helper_teaching_summary_feedback_thanks')}
          </span>
        ) : (
          <>
            <span style={{ fontSize: '13px', color: COLORS.textMuted }}>
              {t('ai_helper_teaching_summary_overall_suggestion')}：
            </span>
            {(['up', 'down'] as const).map(rating => (
              <button
                key={rating}
                onClick={() => handleFeedback(rating)}
                style={{
                  fontSize: '12px', padding: '3px 8px',
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.sm,
                  backgroundColor: 'transparent',
                  color: summary.feedback?.rating === rating
                    ? (rating === 'up' ? COLORS.successText : COLORS.errorText)
                    : COLORS.textMuted,
                  cursor: 'pointer',
                }}
              >
                {rating === 'up' ? '👍' : '👎'} {t(rating === 'up'
                  ? 'ai_helper_teaching_summary_feedback_helpful'
                  : 'ai_helper_teaching_summary_feedback_not_helpful')}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export default TeachingSummaryPanel;
