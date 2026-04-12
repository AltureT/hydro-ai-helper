/**
 * BatchSummaryPanel — teacher-facing UI for AI batch learning summary generation.
 * Injects into homework/contest scoreboard pages automatically.
 * Supports SSE progress streaming, expand/collapse, publish, export, stop/continue, and edit flows.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, getButtonStyle, getAlertStyle, markdownTheme } from '../utils/styles';

/** i18n with hardcoded Chinese fallback for keys that may not yet be in lang-*.js */
const I18N_FALLBACK: Record<string, string> = {
  ai_helper_batch_summary_stop: '停止',
  ai_helper_batch_summary_continue: '继续生成',
  ai_helper_batch_summary_regenerate: '重新生成',
  ai_helper_batch_summary_pending: '待处理',
  ai_helper_batch_summary_loading: '加载中...',
  ai_helper_batch_summary_stopped_notice: '生成已停止，部分学生尚未处理。点击「继续生成」恢复。',
  ai_helper_batch_summary_my_title: 'AI 学习总结',
  ai_helper_batch_summary_retry_failed: '重试失败',
  ai_helper_batch_summary_generate_new: '为 {0} 名新学生生成总结',
  ai_helper_batch_summary_retry_n_failed: '重试 {0} 个失败项',
  ai_helper_batch_summary_publish_n_drafts: '发布 {0} 份草稿',
  ai_helper_batch_summary_regenerate_all: '全部重新生成',
  ai_helper_batch_summary_regenerate_all_confirm: '将为所有学生重新生成总结，已编辑的内容将被覆盖。确认继续？',
  ai_helper_batch_summary_stats_completed: '已完成',
  ai_helper_batch_summary_stats_draft: '草稿',
  ai_helper_batch_summary_stats_published: '已发布',
  ai_helper_batch_summary_stats_failed: '失败',
  ai_helper_batch_summary_stats_not_generated: '未生成',
  ai_helper_batch_summary_no_new_students: '所有学生已生成总结，无需补充',
};
function t(key: string): string {
  const val = i18n(key);
  return val === key ? (I18N_FALLBACK[key] || val) : val;
}
import { useBatchSummary, buildUrl } from './useBatchSummary';
import { SummaryCard } from './SummaryCard';
import { StudentSummaryView } from './StudentSummaryView';
import { renderComponent } from '../utils/renderHelper';
import { ErrorBoundary } from '../components/ErrorBoundary';

// ─── Props ─────────────────────────────────────────────────────────────────────

interface BatchSummaryPanelProps {
  domainId: string;
  contestId: string;
  isTeacher: boolean;
  existingJobId?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export const BatchSummaryPanel: React.FC<BatchSummaryPanelProps> = ({
  domainId,
  contestId,
  isTeacher,
}) => {
  const {
    state, startGeneration, stopGeneration, continueGeneration,
    retryFailed, loadLatest, publishAll, retryStudent, cleanup,
  } = useBatchSummary(domainId);

  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);

  // ── Mount: auto-load existing results ──────────────────────────────────────

  useEffect(() => {
    loadLatest(contestId);
    return () => {
      cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Expand/collapse helpers ─────────────────────────────────────────────────

  const toggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpandedUsers(new Set());
      setAllExpanded(false);
    } else {
      const all = new Set<number>(state.summaries.keys());
      setExpandedUsers(all);
      setAllExpanded(true);
    }
  }, [allExpanded, state.summaries]);

  const toggleUser = useCallback((userId: number) => {
    setExpandedUsers(prev => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  // ── Generate handler ────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async (mode?: 'new_only' | 'regenerate') => {
    if (mode === 'regenerate') {
      const confirmed = window.confirm(t('ai_helper_batch_summary_regenerate_all_confirm'));
      if (!confirmed) return;
    }
    const result = await startGeneration({
      contestId,
      mode,
      confirmRegenerate: mode === 'regenerate' ? true : undefined,
    });
    if (result.needConfirm) {
      const confirmed = window.confirm(
        result.message || i18n('ai_helper_batch_summary_confirm_regenerate'),
      );
      if (confirmed) {
        await startGeneration({ contestId, mode: 'regenerate', confirmRegenerate: true });
      }
    }
  }, [contestId, startGeneration]);

  // ── Derived values (needed by smart button) ────────────────────────────────

  const hasPending = Array.from(state.summaries.values()).some(s => s.status === 'pending');
  const progressPct = state.total > 0 ? Math.round(((state.completed + state.failed) / state.total) * 100) : 0;

  // ── Smart button config ────────────────────────────────────────────────────

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

  const draftCount = Array.from(state.summaries.values()).filter(
    s => s.status === 'completed' && s.publishStatus === 'draft',
  ).length;
  const publishedCount = Array.from(state.summaries.values()).filter(
    s => s.status === 'completed' && s.publishStatus === 'published',
  ).length;
  const completedCount = Array.from(state.summaries.values()).filter(
    s => s.status === 'completed',
  ).length;
  const failedCount = Array.from(state.summaries.values()).filter(
    s => s.status === 'failed',
  ).length;

  type SmartButtonConfig = { label: string; action: () => void; variant: 'primary' | 'secondary' | 'danger' };

  const getSmartButton = (): SmartButtonConfig | null => {
    if (state.isGenerating) return null;

    if (state.newStudentCount > 0) {
      return {
        label: t('ai_helper_batch_summary_generate_new').replace('{0}', String(state.newStudentCount)),
        action: () => handleGenerate('new_only'),
        variant: 'primary',
      };
    }

    if (failedCount > 0 && state.jobStatus !== 'stopped') {
      return {
        label: t('ai_helper_batch_summary_retry_n_failed').replace('{0}', String(failedCount)),
        action: retryFailed,
        variant: 'danger',
      };
    }

    if (state.jobStatus === 'stopped' && hasPending) {
      return {
        label: t('ai_helper_batch_summary_continue'),
        action: continueGeneration,
        variant: 'primary',
      };
    }

    if (state.summaries.size === 0) {
      return {
        label: i18n('ai_helper_batch_summary_generate'),
        action: () => handleGenerate(),
        variant: 'primary',
      };
    }

    return null;
  };

  const smartButton = getSmartButton();
  const showDropdown = state.summaries.size > 0 && !state.isGenerating;

  // ── Export ──────────────────────────────────────────────────────────────────

  const handleExportCsv = useCallback(() => {
    if (!state.jobId) return;
    window.open(buildUrl(domainId, `/${state.jobId}/export`), '_blank', 'noopener,noreferrer');
  }, [domainId, state.jobId]);

  // ── Publish all ─────────────────────────────────────────────────────────────

  const handlePublishAll = useCallback(() => {
    publishAll();
  }, [publishAll]);

  // ── Publish single ──────────────────────────────────────────────────────────

  const handlePublishOne = useCallback(async (userId: number) => {
    if (!state.jobId) return;
    try {
      const res = await fetch(buildUrl(domainId, `/${state.jobId}/publish`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        // Update local state
        const prev = state.summaries.get(userId);
        if (prev) {
          state.summaries.set(userId, { ...prev, publishStatus: 'published' });
        }
      }
    } catch (err) {
      console.error('[BatchSummaryPanel] publish error:', err);
    }
  }, [domainId, state.jobId, state.summaries]);

  // ── Edit ────────────────────────────────────────────────────────────────────

  const handleEdit = useCallback(async (userId: number, newSummary: string) => {
    if (!state.jobId) return;
    try {
      const res = await fetch(buildUrl(domainId, `/${state.jobId}/edit/${userId}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ summary: newSummary }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.error('[BatchSummaryPanel] edit failed:', errData.error);
      }
    } catch (err) {
      console.error('[BatchSummaryPanel] edit error:', err);
    }
  }, [domainId, state.jobId]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (state.loading) {
    return (
      <div style={{ textAlign: 'center', padding: SPACING.xl, color: COLORS.textMuted, fontSize: '14px' }}>
        {t('ai_helper_batch_summary_loading')}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'inherit', color: COLORS.textPrimary }}>
      <style>{markdownTheme}</style>

      {isTeacher && (
        <>
          {/* Status bar */}
          {state.jobId && !state.isGenerating && (
            <div style={{
              display: 'flex', alignItems: 'center', flexWrap: 'wrap',
              gap: SPACING.base, marginBottom: SPACING.sm,
              fontSize: '13px', color: COLORS.textMuted,
            }}>
              {completedCount > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: COLORS.primary, display: 'inline-block' }} />
                  {t('ai_helper_batch_summary_stats_completed')} {completedCount}
                </span>
              )}
              {draftCount > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: COLORS.warningText, display: 'inline-block' }} />
                  {t('ai_helper_batch_summary_stats_draft')} {draftCount}
                </span>
              )}
              {publishedCount > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: COLORS.successText, display: 'inline-block' }} />
                  {t('ai_helper_batch_summary_stats_published')} {publishedCount}
                </span>
              )}
              {failedCount > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: COLORS.errorText, display: 'inline-block' }} />
                  {t('ai_helper_batch_summary_stats_failed')} {failedCount}
                </span>
              )}
              {state.newStudentCount > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: COLORS.textMuted, display: 'inline-block' }} />
                  {t('ai_helper_batch_summary_stats_not_generated')} {state.newStudentCount}
                </span>
              )}
            </div>
          )}

          {/* Action bar */}
          <div style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap',
            gap: SPACING.sm, marginBottom: SPACING.base,
          }}>
            {state.summaries.size > 0 && (
              <button onClick={toggleExpandAll} style={getButtonStyle('secondary')}>
                {allExpanded ? i18n('ai_helper_batch_summary_collapse_all') : i18n('ai_helper_batch_summary_expand_all')}
              </button>
            )}
            {state.jobId && (
              <button onClick={handleExportCsv} style={getButtonStyle('secondary')}>
                {i18n('ai_helper_batch_summary_export_csv')}
              </button>
            )}
            {draftCount > 0 && !state.isGenerating && (
              <button onClick={handlePublishAll} style={getButtonStyle('secondary')}>
                {t('ai_helper_batch_summary_publish_n_drafts').replace('{0}', String(draftCount))}
              </button>
            )}

            <div style={{ flex: 1 }} />

            {state.isGenerating && (
              <button onClick={stopGeneration} style={{ ...getButtonStyle('danger'), display: 'flex', alignItems: 'center', gap: '4px' }}>
                {t('ai_helper_batch_summary_stop')}
              </button>
            )}

            {!state.isGenerating && (
              <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-flex' }}>
                {smartButton && (
                  <button
                    onClick={smartButton.action}
                    style={{
                      ...getButtonStyle(smartButton.variant),
                      borderTopRightRadius: showDropdown ? 0 : undefined,
                      borderBottomRightRadius: showDropdown ? 0 : undefined,
                    }}
                  >
                    {smartButton.label}
                  </button>
                )}
                {showDropdown && (
                  <button
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                    style={{
                      ...getButtonStyle(smartButton ? smartButton.variant : 'secondary'),
                      borderTopLeftRadius: smartButton ? 0 : undefined,
                      borderBottomLeftRadius: smartButton ? 0 : undefined,
                      borderLeft: smartButton ? '1px solid rgba(255,255,255,0.3)' : undefined,
                      padding: `${SPACING.sm} 8px`,
                      minWidth: 'auto',
                    }}
                  >
                    ▾
                  </button>
                )}
                {!smartButton && !showDropdown && state.summaries.size === 0 && (
                  <button onClick={() => handleGenerate()} style={getButtonStyle('primary')}>
                    {i18n('ai_helper_batch_summary_generate')}
                  </button>
                )}
                {dropdownOpen && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: '4px',
                    backgroundColor: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
                    borderRadius: RADIUS.md, boxShadow: SHADOWS.md, zIndex: 100,
                    minWidth: '160px', overflow: 'hidden',
                  }}>
                    <button
                      onClick={() => { setDropdownOpen(false); handleGenerate('regenerate'); }}
                      style={{
                        display: 'block', width: '100%', padding: `${SPACING.sm} ${SPACING.base}`,
                        background: 'none', border: 'none', textAlign: 'left',
                        cursor: 'pointer', fontSize: '13px', color: COLORS.errorText,
                      }}
                    >
                      {t('ai_helper_batch_summary_regenerate_all')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Progress bar */}
      {state.isGenerating && state.total > 0 && (
        <div style={{
          backgroundColor: '#eff6ff', border: '1px solid #bfdbfe',
          borderRadius: RADIUS.md, padding: SPACING.base, marginBottom: SPACING.base,
        }}>
          <div style={{
            width: '100%', height: '6px', backgroundColor: '#dbeafe',
            borderRadius: RADIUS.full, overflow: 'hidden', marginBottom: SPACING.sm,
          }}>
            <div style={{
              width: `${progressPct}%`, height: '100%', backgroundColor: COLORS.primary,
              borderRadius: RADIUS.full, transition: 'width 300ms ease',
            }} />
          </div>
          <div style={{ fontSize: '13px', color: COLORS.infoText }}>
            {i18n('ai_helper_batch_summary_generating')}{' '}
            {state.completed + state.failed} / {state.total}
            {state.failed > 0 && (
              <span style={{ marginLeft: SPACING.sm, color: COLORS.errorText }}>
                · {state.failed} {i18n('ai_helper_batch_summary_failed')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Stopped notice */}
      {!state.isGenerating && state.jobStatus === 'stopped' && hasPending && (
        <div style={{
          backgroundColor: COLORS.warningBg, border: `1px solid ${COLORS.warningBorder}`,
          borderRadius: RADIUS.md, padding: SPACING.base, marginBottom: SPACING.base,
          fontSize: '13px', color: COLORS.warningText,
        }}>
          {t('ai_helper_batch_summary_stopped_notice')}
        </div>
      )}

      {/* Error */}
      {state.error && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.base }}>
          {state.error}
        </div>
      )}

      {/* Summary cards */}
      {state.summaries.size > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
          {Array.from(state.summaries.entries()).map(([userId, data]) => {
            const isExpanded = expandedUsers.has(userId);
            return (
              <div key={userId} style={{
                border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
                boxShadow: SHADOWS.sm, overflow: 'hidden', backgroundColor: COLORS.bgCard,
              }}>
                <div
                  onClick={() => toggleUser(userId)}
                  style={{
                    display: 'flex', alignItems: 'center',
                    padding: `${SPACING.sm} ${SPACING.base}`, cursor: 'pointer',
                    borderBottom: isExpanded ? `1px solid ${COLORS.border}` : 'none',
                    userSelect: 'none', gap: SPACING.sm,
                    backgroundColor: isExpanded ? COLORS.bgPage : COLORS.bgCard,
                  }}
                >
                  <span style={{
                    fontSize: '12px', color: COLORS.textMuted,
                    transition: 'transform 150ms',
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    display: 'inline-block', width: '14px', flexShrink: 0,
                  }}>▶</span>
                  <span style={{
                    fontWeight: 600, fontSize: '14px', color: COLORS.textPrimary,
                    flex: 1, minWidth: 0, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {data.userName || `User #${userId}`}
                  </span>
                  <span style={{
                    fontSize: '12px', fontWeight: 500, padding: `2px ${SPACING.sm}`,
                    borderRadius: RADIUS.full, flexShrink: 0,
                    color: data.status === 'failed' ? COLORS.errorText
                      : data.status === 'pending' ? COLORS.textMuted
                        : data.publishStatus === 'published' ? COLORS.successText : COLORS.warningText,
                    backgroundColor: data.status === 'failed' ? COLORS.errorBg
                      : data.status === 'pending' ? COLORS.bgPage
                        : data.publishStatus === 'published' ? COLORS.successBg : COLORS.warningBg,
                    border: `1px solid ${
                      data.status === 'failed' ? COLORS.errorBorder
                        : data.status === 'pending' ? COLORS.border
                          : data.publishStatus === 'published' ? COLORS.successBorder : COLORS.warningBorder
                    }`,
                  }}>
                    {data.status === 'failed' ? i18n('ai_helper_batch_summary_failed')
                      : data.status === 'pending' ? t('ai_helper_batch_summary_pending')
                        : data.publishStatus === 'published' ? i18n('ai_helper_batch_summary_published')
                          : i18n('ai_helper_batch_summary_draft')}
                  </span>
                </div>
                {isExpanded && (
                  <div style={{ padding: SPACING.base }}>
                    <SummaryCard
                      userId={userId}
                      userName={data.userName || `User #${userId}`}
                      status={data.status}
                      publishStatus={data.publishStatus}
                      summary={data.summary}
                      error={data.error}
                      domainId={domainId}
                      isTeacher={isTeacher}
                      onRetry={() => retryStudent(userId)}
                      onPublish={() => handlePublishOne(userId)}
                      onEdit={(newSummary) => handleEdit(userId, newSummary)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {state.summaries.size === 0 && !state.isGenerating && !state.error && !state.loading && (
        <div style={{
          textAlign: 'center', color: COLORS.textMuted, padding: SPACING.xxl,
          fontSize: '14px', border: `2px dashed ${COLORS.border}`, borderRadius: RADIUS.lg,
        }}>
          {i18n('ai_helper_batch_summary_empty')}
        </div>
      )}
    </div>
  );
};

export default BatchSummaryPanel;

// ─── Scoreboard page URL patterns ─────────────────────────────────────────────

// Match contestId (ObjectId hex) from homework/contest scoreboard URLs
const SCOREBOARD_PATTERNS: RegExp[] = [
  /\/homework\/([a-f0-9]{24})\/scoreboard/,
  /\/contest\/([a-f0-9]{24})\/scoreboard/,
];

function parseScoreboardUrl(): { domainId: string; contestId: string } | null {
  const pathname = window.location.pathname;
  for (const pattern of SCOREBOARD_PATTERNS) {
    const match = pathname.match(pattern);
    if (match) {
      // domainId from UiContext (always correct, even without /d/ prefix in URL)
      const domainId = (window as any).UiContext?.domainId || 'system';
      return { domainId, contestId: match[1] };
    }
  }
  return null;
}

// ─── Permission detection ─────────────────────────────────────────────────────

declare global {
  interface Window {
    UserContext?: {
      _id?: number | string;
      priv?: number;
      role?: string;
    };
  }
}

// PRIV_READ_RECORD_CODE = 1 << 7 (128) in HydroOJ (packages/common/permission.ts)
const PRIV_READ_RECORD_CODE = 1 << 7;

function hasTeacherPrivilege(): boolean {
  const ctx = window.UserContext;
  if (!ctx || !ctx._id) return false;

  const priv = ctx.priv;
  if (typeof priv === 'number') {
    // Super admin: priv is -1
    if (priv < 0) return true;
    // Has PRIV_READ_RECORD_CODE bit
    if ((priv & PRIV_READ_RECORD_CODE) !== 0) return true;
  }

  // Domain role fallback (admin/root roles have elevated permissions)
  const role = ctx.role;
  if (typeof role === 'string' && role !== 'default' && role !== 'guest' && role !== '') return true;

  return false;
}

// ─── Self-mounting on scoreboard pages ────────────────────────────────────────

function isLoggedIn(): boolean {
  const ctx = window.UserContext;
  return !!(ctx && ctx._id);
}

function insertContainer(id: string): HTMLDivElement | null {
  // Prevent double-mount
  if (document.getElementById(id)) return null;

  const container = document.createElement('div');
  container.id = id;
  container.style.margin = `${SPACING.base} 0`;
  container.style.padding = `0 ${SPACING.base}`;

  const sectionHeader = document.querySelector('.section__header');
  if (sectionHeader && sectionHeader.parentElement) {
    sectionHeader.parentElement.insertBefore(container, sectionHeader.nextSibling);
  } else {
    const scoreboard = document.querySelector('[data-fragment-id="scoreboard"]');
    if (scoreboard && scoreboard.parentElement) {
      scoreboard.parentElement.insertBefore(container, scoreboard);
    } else {
      const section = document.querySelector('.section.visible') || document.body;
      section.appendChild(container);
    }
  }
  return container;
}

function initBatchSummaryPanel() {
  const parsed = parseScoreboardUrl();
  if (!parsed) return;
  if (!isLoggedIn()) return;

  const isTeacher = hasTeacherPrivilege();

  if (isTeacher) {
    const container = insertContainer('ai-batch-summary-root');
    if (!container) return;
    renderComponent(
      <ErrorBoundary>
        <BatchSummaryPanel
          domainId={parsed.domainId}
          contestId={parsed.contestId}
          isTeacher={true}
        />
      </ErrorBoundary>,
      container,
    );
  } else {
    const container = insertContainer('ai-student-summary-root');
    if (!container) return;
    renderComponent(
      <ErrorBoundary>
        <StudentSummaryView
          domainId={parsed.domainId}
          contestId={parsed.contestId}
        />
      </ErrorBoundary>,
      container,
    );
  }
}

// ─── Initialization: handle both full page load and PJAX navigation ─────────

// 1. Full page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBatchSummaryPanel, { once: true });
} else {
  initBatchSummaryPanel();
}

// 2. PJAX navigation: HydroOJ triggers jQuery 'vjContentNew' on replaced fragments
//    Re-run init when scoreboard content is loaded via PJAX.
if (typeof (window as any).$ === 'function') {
  (window as any).$(document).on('vjContentNew', () => {
    // Small delay to ensure DOM is fully updated after PJAX replacement
    setTimeout(initBatchSummaryPanel, 50);
  });
} else {
  // Fallback: listen for native custom event (some HydroOJ builds dispatch both)
  document.addEventListener('vjContentNew', () => {
    setTimeout(initBatchSummaryPanel, 50);
  });
}
