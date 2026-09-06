/**
 * TeachingSummaryPanel — teacher-facing UI for AI teaching summary generation.
 * Injects into homework/contest scoreboard pages for whole-class analysis.
 *
 * 完成态按教师备课工作流组织为四段：
 * ① 一句话诊断 → ② 下节课回顾清单（含个体干预）→ ③ 学生问题（重点卡片 + 其他观察）
 * → ④ 课后强化训练（可一键复制下发）
 */

import React, { useState, useEffect, useCallback } from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, SPACING, RADIUS,
  getButtonStyle, cardStyle, markdownTheme, LAYOUT,
} from '../utils/styles';
import { renderReportMarkdown as renderMarkdown, reportMarkdownStyles } from '../utils/reportMarkdown';
import { useTeachingSummary, TeachingFinding } from './useTeachingSummary';
import { parseReviewActions, prepareStudentHomework } from './reportContent';
import { teachingSummaryStyles } from './teachingSummaryStyles';

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
  ai_helper_teaching_summary_primary_findings: '重点问题',
  ai_helper_teaching_summary_high_priority: '高优先级',
  ai_helper_teaching_summary_ai_users: 'AI 使用者',
  ai_helper_teaching_summary_completed_all: '完成全部题目',
  ai_helper_teaching_summary_low_data_warning: '参与学生不足 10 人，分析结果仅供参考。',
  ai_helper_teaching_summary_section_diagnosis: '一句话诊断',
  ai_helper_teaching_summary_section_review: '下节课回顾清单',
  ai_helper_teaching_summary_section_problems: '学生问题',
  ai_helper_teaching_summary_section_homework: '课后强化训练',
  ai_helper_teaching_summary_section_full_report: 'AI 完整报告',
  ai_helper_teaching_summary_other_observations: '其他观察',
  ai_helper_teaching_summary_no_findings: '未发现明显问题',
  ai_helper_teaching_summary_overall_suggestion: 'AI 综合建议',
  ai_helper_teaching_summary_affected: '涉及',
  ai_helper_teaching_summary_students: '名学生',
  ai_helper_teaching_summary_student_list: '涉及学生',
  ai_helper_teaching_summary_copy_homework: '复制作业',
  ai_helper_teaching_summary_copied: '已复制',
  ai_helper_teaching_summary_copy_failed: '复制失败，请手动选择文本复制',
  ai_helper_teaching_summary_homework_hint: '可直接复制下发（"建议挖空点说明"为教师参考答案，请勿下发）',
  ai_helper_teaching_summary_feedback_helpful: '有帮助',
  ai_helper_teaching_summary_feedback_not_helpful: '没帮助',
  ai_helper_teaching_summary_feedback_thanks: '感谢反馈！',
  ai_helper_teaching_summary_copy_warning: '共性错误代码示例：',
  ai_helper_teaching_summary_failed: '生成失败，请重试',
  ai_helper_teaching_summary_empty: '暂无教学总结，点击上方按钮生成',
  ai_helper_teaching_summary_generating_notice: '正在分析学生学习数据，请稍候...',
  ai_helper_teaching_summary_phase_collecting_data: '正在收集学生提交记录和对话数据...',
  ai_helper_teaching_summary_phase_analyzing: '正在分析错误模式和学习行为...',
  ai_helper_teaching_summary_phase_generating_suggestion: 'AI 正在生成教学建议...',
  ai_helper_teaching_summary_phase_deep_diving: '正在对重点问题进行深度诊断...',
  ai_helper_teaching_summary_phase_saving: '正在保存分析结果...',
};

function t(key: string): string {
  const val = i18n(key);
  return val === key ? (I18N_FALLBACK[key] || val) : val;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<string, string> = {
  commonError: '共性错误',
  errorCluster: '错误聚类',
  comprehension: '题意理解',
  strategy: '学习策略',
  atRisk: '完成情况',
  difficulty: '题目通过情况',
  progress: '进步趋势',
  cognitivePath: '认知路径',
  aiEffectiveness: 'AI 实效',
  temporalPattern: '行为模式',
  crossCorrelation: '交叉关联',
};

const METRIC_LABELS: Record<string, string> = {
  passRate: '通过率',
  attempted: '尝试人数',
  accepted: '通过人数',
  comprehensionPct: '理解类提问占比',
  aiUserCount: 'AI 使用人数',
  nonAiUserCount: '未使用 AI 人数',
  bruteForceCount: '暴力尝试人数',
  heavyUserCount: '高频使用人数',
  jailbreakStudentCount: '越狱学生数',
  totalJailbreaks: '越狱总次数',
  threshold: '阈值',
  errorRate: '错误率',
  aiPassRate: 'AI 用户通过率',
  nonAiPassRate: '非 AI 通过率',
  diff: '差异',
  sameSignatureCount: '同一错误位学生数',
  aiGroupSize: 'AI组人数',
  nonAiGroupSize: '非AI组人数',
  aiACRate: 'AI组通过率',
  nonAiACRate: '非AI组通过率',
  dominantClusterSize: '主要错误集群人数',
  dominantClusterPct: '主要错误集群占比',
};

/** 这些指标与卡片标题/"涉及 N 名学生"徽标重复，展开时不再显示 */
const REDUNDANT_METRICS = new Set([
  'affectedCount', 'totalStudents', 'percentage',
  'atRiskCount', 'completedCount',
]);

/** 百分比类指标，展示时补 % 号 */
const PERCENT_METRIC = /rate|pct|percentage/i;

/** 学生名单默认展示上限，超出折叠为 +N */
const MAX_VISIBLE_NAMES = 24;

// ─── overallSuggestion 分段解析 ───────────────────────────────────────────────
//
// 主报告是一段 markdown，按 "### " 标题切块归类；识别失败的块进入 rest，
// 由"AI 完整报告"折叠区兜底（兼容旧版含 P0 报告/作业的长文档）。

export interface ParsedSuggestion {
  diagnosis?: string;
  reviewList?: string;
  p1?: string;
  homework?: string;
  rest: string[];
}

export function parseSuggestionSections(md: string): ParsedSuggestion {
  const result: ParsedSuggestion = { rest: [] };
  if (!md || !md.trim()) return result;

  const chunks = md.split(/(?=^###\s)/m).filter(c => c.trim());
  for (const chunk of chunks) {
    const firstLine = chunk.split('\n', 1)[0];
    const body = chunk.replace(/^###[^\n]*\n?/, '').trim();
    if (/一句话诊断/.test(firstLine) && !result.diagnosis) {
      result.diagnosis = body;
    } else if (/下节课回顾清单/.test(firstLine) && !result.reviewList) {
      result.reviewList = body;
    } else if (/个体干预/.test(firstLine) && !result.p1) {
      result.p1 = body;
    } else if (/课后巩固|挖空练习/.test(firstLine) && !result.homework) {
      result.homework = chunk.trim();
    } else {
      result.rest.push(chunk.trim());
    }
  }
  return result;
}

// ─── 剪贴板 ───────────────────────────────────────────────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ─── SkeletonBlock subcomponent ───────────────────────────────────────────────

const SkeletonBlock: React.FC<{ lines?: number }> = ({ lines = 8 }) => (
  <div style={{ padding: `${SPACING.base} ${SPACING.lg}` }}>
    {Array.from({ length: lines }, (_, i) => (
      <div key={i} style={{
        height: '14px',
        backgroundColor: '#e2e8f0',
        borderRadius: '4px',
        marginBottom: '10px',
        width: i === 0 ? '70%' : i === lines - 1 ? '40%' : `${75 + (i * 3) % 20}%`,
        animation: 'skeleton-pulse 1.5s ease-in-out infinite',
      }} />
    ))}
    <style>{`
      @keyframes skeleton-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `}</style>
  </div>
);

// ─── Section shell ────────────────────────────────────────────────────────────

interface SectionCardProps {
  title: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

const SectionCard: React.FC<SectionCardProps> = ({
  title, headerRight, children,
}) => (
  <section className="report-section">
    <div className="report-section-header">
      <h3 className="report-section-title">{title}</h3>
      {headerRight}
    </div>
    <div className="report-section-body">
      {children}
    </div>
  </section>
);

const ReviewActions: React.FC<{ markdown: string }> = ({ markdown }) => {
  const actions = parseReviewActions(markdown);
  if (!actions) return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }} />;
  return (
    <ol className="review-actions">
      {actions.map((item, index) => (
        <li className="review-action" key={index}>
          <span className="review-priority">{item.priority}</span>
          <div>
            <div className="markdown-body report-reading review-action-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.action) }} />
            <div className="review-evidence">
              <span>{t('ai_helper_teaching_summary_evidence_label')}</span>
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.problem) }} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
};

// ─── FindingCard subcomponent ─────────────────────────────────────────────────

interface FindingCardProps {
  finding: TeachingFinding;
  deepDiveText?: string;
  studentNames?: Record<string, string>;
}

const FindingCard: React.FC<FindingCardProps> = ({ finding, deepDiveText, studentNames }) => {
  const [expanded, setExpanded] = useState(false);
  const [showAllNames, setShowAllNames] = useState(false);
  const dimensionLabel = DIMENSION_LABELS[finding.dimension] || finding.dimension;
  const affectedCount = finding.evidence.affectedStudents.length;

  const names = (finding.evidence.affectedStudents || [])
    .map(uid => studentNames?.[String(uid)])
    .filter(Boolean) as string[];

  const extraMetrics = Object.entries(finding.evidence.metrics || {})
    .filter(([key]) => !REDUNDANT_METRICS.has(key));

  const codeSample = (finding.dimension === 'commonError' || finding.dimension === 'errorCluster')
    ? finding.evidence.samples?.code?.[0]
    : undefined;

  // 展开必须有实际内容；否则整行不可点，避免"展开什么也没有"
  const hasDetails = Boolean(
    (finding.supplements && finding.supplements.length > 0)
    || deepDiveText
    || codeSample
    || names.length > 0
    || extraMetrics.length > 0,
  );

  const visibleNames = showAllNames ? names : names.slice(0, MAX_VISIBLE_NAMES);

  const findingSummary = (
    <>
      <span style={{ minWidth: 0 }}>
        <span className="finding-meta">
          <span>{dimensionLabel}</span>
          <span>{t('ai_helper_teaching_summary_affected')} {affectedCount} {t('ai_helper_teaching_summary_students')}</span>
          {finding.severity === 'high' && <span style={{ color: COLORS.warningText }}>{t('ai_helper_teaching_summary_priority_attention')}</span>}
          {finding.confidence && finding.confidence !== 'high' && (
            <span>{finding.confidence === 'low' ? '依据有限' : '数据不足'}</span>
          )}
        </span>
        <span className="finding-title">{finding.title}</span>
      </span>
      {hasDetails && <span className="finding-expand">{t(expanded ? 'ai_helper_teaching_summary_collapse' : 'ai_helper_teaching_summary_view_details')}</span>}
    </>
  );

  return (
    <div className="finding-row">
      {hasDetails ? (
        <button type="button" className="finding-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {findingSummary}
        </button>
      ) : <div className="finding-toggle">{findingSummary}</div>}

      {expanded && hasDetails && (
        <div style={{
          padding: `0 ${SPACING.base} ${SPACING.base}`,
          borderTop: `1px solid ${COLORS.border}`,
          paddingTop: SPACING.md,
        }}>
          {/* 关联洞察（合并进来的交叉关联/错误聚类补充） */}
          {finding.supplements && finding.supplements.length > 0 && (
            <div style={{
              marginBottom: SPACING.md,
              padding: `${SPACING.sm} ${SPACING.md}`,
              backgroundColor: COLORS.bgPage,
              borderLeft: `3px solid ${COLORS.secondary}`,
              borderRadius: RADIUS.sm,
            }}>
              {finding.supplements.map((s, i) => (
                <div key={i} style={{
                  fontSize: '13px', color: COLORS.textSecondary, lineHeight: 1.6,
                }}>
                  ↳ {s}
                </div>
              ))}
            </div>
          )}

          {/* 深度诊断（根因 + 反例 + 课堂提问） */}
          {deepDiveText && (
            <div
              className="markdown-body"
              style={{ marginTop: SPACING.sm }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(deepDiveText) }}
            />
          )}

          {/* 典型错误代码 */}
          {codeSample && (
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
                {codeSample}
              </pre>
            </div>
          )}

          {/* 涉及学生名单 — 教师可据此点名辅导 */}
          {names.length > 0 && (
            <div style={{ marginTop: SPACING.md }}>
              <div style={{
                fontSize: '12px', fontWeight: 600, color: COLORS.textSecondary,
                marginBottom: SPACING.sm, letterSpacing: '0.02em',
              }}>
                {t('ai_helper_teaching_summary_student_list')}（{names.length}）：
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {visibleNames.map((name, i) => (
                  <span key={i} style={{
                    fontSize: '12px', padding: '2px 8px',
                    backgroundColor: COLORS.bgPage,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: RADIUS.full,
                    color: COLORS.textSecondary,
                  }}>
                    {name}
                  </span>
                ))}
                {names.length > MAX_VISIBLE_NAMES && !showAllNames && (
                  <span
                    onClick={() => setShowAllNames(true)}
                    style={{
                      fontSize: '12px', padding: '2px 8px',
                      borderRadius: RADIUS.full,
                      color: COLORS.primary, cursor: 'pointer',
                      border: `1px dashed ${COLORS.primary}`,
                    }}
                  >
                    +{names.length - MAX_VISIBLE_NAMES}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 其余非冗余指标 */}
          {extraMetrics.length > 0 && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: SPACING.sm,
              marginTop: SPACING.md,
            }}>
              {extraMetrics.map(([key, val]) => (
                <span key={key} style={{ fontSize: '12px', color: COLORS.secondary }}>
                  {METRIC_LABELS[key] || key}:{' '}
                  <strong style={{ color: COLORS.textSecondary }}>
                    {typeof val === 'number' ? (val % 1 === 0 ? val : val.toFixed(2)) : val}
                    {typeof val === 'number' && PERCENT_METRIC.test(key) ? '%' : ''}
                  </strong>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Overview bar ─────────────────────────────────────────────────────────────

interface OverviewItem {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
  positive?: boolean;
}

const OverviewBar: React.FC<{ items: OverviewItem[] }> = ({ items }) => (
  <div style={{
    display: 'flex', flexWrap: 'wrap', gap: SPACING.lg,
    marginBottom: SPACING.base,
    padding: `${SPACING.sm} 0`,
  }}>
    {items.map(({ label, value, highlight, positive }) => (
      <span key={label} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '4px' }}>
        <span style={{ fontSize: '13px', color: COLORS.textSecondary }}>{label}</span>
        <span style={{
          fontSize: '18px', fontWeight: 700,
          color: highlight ? COLORS.warningText : positive ? COLORS.successText : COLORS.textPrimary,
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
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [homeworkAudience, setHomeworkAudience] = useState<'student' | 'teacher'>('student');

  useEffect(() => {
    fetchSummary();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Report primary problem count to parent for tab badge
  useEffect(() => {
    if (onStatsUpdate && summary?.findings) {
      const primaryCount = summary.findings.filter(
        f => !f.isSecondary && f.dimension !== 'progress',
      ).length;
      onStatsUpdate(primaryCount);
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
      <div style={{ textAlign: 'center', padding: SPACING.xl, color: COLORS.secondary, fontSize: '14px' }}>
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
          color: COLORS.secondary, fontSize: '13px',
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
        <div style={{ color: COLORS.secondary, fontSize: '14px' }}>
          {t(summary.progressPhase
            ? `ai_helper_teaching_summary_phase_${summary.progressPhase}`
            : 'ai_helper_teaching_summary_generating_notice')}
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
  const progressFinding = findings.find(f => f.dimension === 'progress');
  const problemFindings = findings.filter(f => f.dimension !== 'progress');

  // 后端已按严重度+影响面排序并标记次要发现；对旧文档做同样的客户端兜底限量
  const flaggedPrimary = problemFindings.filter(f => !f.isSecondary);
  const primaryFindings = flaggedPrimary.slice(0, 5);
  const secondaryFindings = [
    ...flaggedPrimary.slice(5),
    ...problemFindings.filter(f => f.isSecondary),
  ];

  const highCount = primaryFindings.filter(f => f.severity === 'high').length;

  const parsed = parseSuggestionSections(summary.overallSuggestion || '');
  const parsedOk = Boolean(parsed.diagnosis || parsed.reviewList);
  const homeworkMd = (summary.homeworkText && summary.homeworkText.trim())
    ? summary.homeworkText
    : parsed.homework;
  const studentHomework = prepareStudentHomework(homeworkMd || '');

  const snapshotDate = summary.dataSnapshotAt
    ? new Date(summary.dataSnapshotAt).toLocaleString('zh-CN', { hour12: false })
    : '';

  const handleCopyHomework = async () => {
    if (!studentHomework.studentMarkdown) return;
    const ok = await copyText(studentHomework.studentMarkdown);
    setCopyState(ok ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 2000);
  };

  const overviewItems: OverviewItem[] = [
    {
      label: t('ai_helper_teaching_summary_participated'),
      value: `${summary.stats.participatedStudents}/${summary.stats.totalStudents}`,
    },
    {
      label: t('ai_helper_teaching_summary_primary_findings'),
      value: primaryFindings.length,
    },
    {
      label: t('ai_helper_teaching_summary_high_priority'),
      value: highCount,
      highlight: highCount > 0,
    },
    ...(progressFinding ? [{
      label: t('ai_helper_teaching_summary_completed_all'),
      value: `${progressFinding.evidence.affectedStudents.length}${
        typeof progressFinding.evidence.metrics?.percentage === 'number'
          ? ` (${progressFinding.evidence.metrics.percentage}%)` : ''
      }`,
      positive: true,
    }] : []),
    {
      label: t('ai_helper_teaching_summary_ai_users'),
      value: summary.stats.aiUserCount,
    },
  ];

  const feedbackRow = (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      gap: SPACING.sm, padding: `${SPACING.sm} 0`,
    }}>
      {feedbackSubmitted ? (
        <span style={{ fontSize: '12px', color: COLORS.successText }}>
          {t('ai_helper_teaching_summary_feedback_thanks')}
        </span>
      ) : (
        <>
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
                  : COLORS.secondary,
                cursor: 'pointer',
              }}
            >
              {rating === 'up' ? t('ai_helper_teaching_summary_feedback_helpful') : t('ai_helper_teaching_summary_feedback_not_helpful')}
            </button>
          ))}
        </>
      )}
    </div>
  );

  return (
    <div className="ai-teaching-summary ai-report-content" style={{ fontFamily: 'inherit', color: COLORS.textPrimary, maxWidth: LAYOUT.contentMaxWidth, margin: '0 auto', width: '100%' }}>
      <style>{markdownTheme}</style>
      <style>{teachingSummaryStyles + reportMarkdownStyles}</style>

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
            <div style={{ fontSize: '12px', color: COLORS.secondary, marginTop: '4px' }}>
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
      <OverviewBar items={overviewItems} />

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

      {/* ① 一句话诊断 — 30 秒抓住重点 */}
      {parsed.diagnosis && (
        <div style={{
          padding: SPACING.lg,
          backgroundColor: COLORS.bgPage,
          borderRadius: RADIUS.md,
        }}>
          <div style={{
            fontSize: '13px', fontWeight: 600, color: COLORS.textSecondary,
            marginBottom: SPACING.sm,
          }}>
            {t('ai_helper_teaching_summary_focus_title')}
          </div>
          <div
            className="markdown-body report-reading"
            style={{ fontSize: '15px', lineHeight: 1.7 }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.diagnosis) }}
          />
          <p className="report-note" style={{ marginBottom: 0 }}>{t('ai_helper_teaching_summary_focus_hint')}</p>
        </div>
      )}

      {/* ② 下节课回顾清单 — 拿着就能上课，常驻展示 */}
      {parsed.reviewList && (
        <SectionCard
          title={t('ai_helper_teaching_summary_section_review')}
        >
          <ReviewActions markdown={parsed.reviewList} />
          {parsed.p1 && (
            <details className="report-disclosure" style={{ marginTop: SPACING.base, paddingTop: SPACING.base, borderTop: `1px solid ${COLORS.border}` }}>
              <summary>{t('ai_helper_teaching_summary_individual_support')}</summary>
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.p1) }}
              />
            </details>
          )}
        </SectionCard>
      )}

      {/* ③ 学生问题 — 去重后的重点卡片 + 其他观察一行带过 */}
      <details className="report-section report-disclosure" open={!parsed.reviewList}>
        <summary>{t('ai_helper_teaching_summary_evidence_title')}（{primaryFindings.length}）</summary>
        {primaryFindings.length === 0 ? (
          <div style={{ color: COLORS.secondary, fontSize: '13px', fontStyle: 'italic' }}>
            {t('ai_helper_teaching_summary_no_findings')}
          </div>
        ) : (
          primaryFindings.map(f => (
            <FindingCard
              key={f.id}
              finding={f}
              deepDiveText={summary.deepDiveResults?.[f.id]}
              studentNames={summary.studentNames}
            />
          ))
        )}

        {secondaryFindings.length > 0 && (
          <div style={{
            marginTop: SPACING.sm,
            padding: `${SPACING.sm} ${SPACING.md}`,
            backgroundColor: COLORS.bgPage,
            borderRadius: RADIUS.sm,
            fontSize: '12px', color: COLORS.secondary, lineHeight: 1.8,
          }}>
            <strong>{t('ai_helper_teaching_summary_other_observations')}：</strong>
            {secondaryFindings.map(f => f.title).join(' · ')}
          </div>
        )}
      </details>

      {/* ④ 课后强化训练 — 一键复制下发 */}
      {homeworkMd && (
        <SectionCard
          title={t('ai_helper_teaching_summary_section_homework')}
          headerRight={(
            <span className="homework-toolbar">
              {copyState !== 'idle' && (
                <span style={{
                  fontSize: '12px',
                  color: copyState === 'copied' ? COLORS.successText : COLORS.errorText,
                }} role="status">
                  {copyState === 'copied'
                    ? t('ai_helper_teaching_summary_copied')
                    : t('ai_helper_teaching_summary_copy_failed')}
                </span>
              )}
              <button
                type="button"
                onClick={handleCopyHomework}
                disabled={!studentHomework.studentMarkdown}
                style={{
                  ...getButtonStyle('primary'), fontSize: '13px',
                  opacity: studentHomework.studentMarkdown ? 1 : 0.5,
                  cursor: studentHomework.studentMarkdown ? 'pointer' : 'not-allowed',
                }}
              >
                {t('ai_helper_teaching_summary_copy_student')}
              </button>
            </span>
          )}
        >
          <div className="homework-tabs" role="group" aria-label={t('ai_helper_teaching_summary_homework_audience')}>
            {(['student', 'teacher'] as const).map(audience => (
              <button type="button" key={audience} aria-pressed={homeworkAudience === audience}
                onClick={() => setHomeworkAudience(audience)}>
                {t(`ai_helper_teaching_summary_homework_${audience}`)}
              </button>
            ))}
          </div>
          <p className="report-note">{t(!studentHomework.studentMarkdown
            ? 'ai_helper_teaching_summary_homework_unrecognized'
            : homeworkAudience === 'student' ? 'ai_helper_teaching_summary_student_hint' : 'ai_helper_teaching_summary_teacher_hint')}</p>
          {homeworkAudience === 'student' && !studentHomework.studentMarkdown ? (
            <button type="button" style={getButtonStyle('secondary')} onClick={() => setHomeworkAudience('teacher')}>
              {t('ai_helper_teaching_summary_view_teacher')}
            </button>
          ) : <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(homeworkAudience === 'student' ? studentHomework.studentMarkdown! : homeworkMd) }}
          />}
        </SectionCard>
      )}

      {/* 兜底：解析失败（或旧版文档）时完整展示 AI 报告 */}
      {!parsedOk && summary.overallSuggestion && (
        <SectionCard
          title={t('ai_helper_teaching_summary_overall_suggestion')}
        >
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.overallSuggestion) }}
          />
        </SectionCard>
      )}

      {/* 已解析主要板块后剩余的未识别章节（如旧版 P0 长报告），默认折叠 */}
      {parsedOk && parsed.rest.length > 0 && (
        <details className="report-section report-disclosure">
          <summary>{t('ai_helper_teaching_summary_section_full_report')}</summary>
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.rest.join('\n\n')) }} />
        </details>
      )}

      {/* 生成中兜底：completed 但建议为空 */}
      {!summary.overallSuggestion && !homeworkMd && (
        <SkeletonBlock lines={6} />
      )}

      {/* Feedback */}
      {feedbackRow}
    </div>
  );
};

export default TeachingSummaryPanel;
