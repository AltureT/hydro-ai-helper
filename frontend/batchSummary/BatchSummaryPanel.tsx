/**
 * BatchSummaryPanel — teacher-facing UI for AI batch learning summary generation.
 * Injects into homework/contest scoreboard pages automatically.
 * Supports SSE progress streaming, expand/collapse, publish, export, stop/continue, and edit flows.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, getButtonStyle, getAlertStyle, markdownTheme } from '../utils/styles';
import { useBatchSummary, buildUrl } from './useBatchSummary';
import { SummaryCard } from './SummaryCard';
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
    loadLatest, publishAll, retryStudent, cleanup,
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

  const handleGenerate = useCallback(async () => {
    const result = await startGeneration(contestId);
    if (result.needConfirm) {
      const confirmed = window.confirm(
        result.message || i18n('ai_helper_batch_summary_confirm_regenerate'),
      );
      if (confirmed) {
        await startGeneration(contestId, true);
      }
    }
  }, [contestId, startGeneration]);

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

  // ── Derived values ──────────────────────────────────────────────────────────

  const hasDrafts = Array.from(state.summaries.values()).some(
    s => s.status === 'completed' && s.publishStatus === 'draft',
  );
  const hasPending = Array.from(state.summaries.values()).some(
    s => s.status === 'pending',
  );
  const progressPct =
    state.total > 0 ? Math.round(((state.completed + state.failed) / state.total) * 100) : 0;
  const isStopped = state.jobStatus === 'stopped';

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (state.loading) {
    return (
      <div style={{ textAlign: 'center', padding: SPACING.xl, color: COLORS.textMuted, fontSize: '14px' }}>
        {i18n('ai_helper_batch_summary_loading')}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'inherit', color: COLORS.textPrimary }}>
      <style>{markdownTheme}</style>

      {/* Action bar — teacher only */}
      {isTeacher && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: SPACING.sm,
          marginBottom: SPACING.base,
        }}>
          {/* Expand / Collapse */}
          {state.summaries.size > 0 && (
            <button
              onClick={toggleExpandAll}
              style={getButtonStyle('secondary')}
            >
              {allExpanded
                ? i18n('ai_helper_batch_summary_collapse_all')
                : i18n('ai_helper_batch_summary_expand_all')}
            </button>
          )}

          {/* Export CSV */}
          {state.jobId && (
            <button
              onClick={handleExportCsv}
              style={getButtonStyle('secondary')}
            >
              {i18n('ai_helper_batch_summary_export_csv')}
            </button>
          )}

          {/* Publish all */}
          {hasDrafts && !state.isGenerating && (
            <button
              onClick={handlePublishAll}
              style={getButtonStyle('secondary')}
            >
              {i18n('ai_helper_batch_summary_publish_all')}
            </button>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Stop button (during generation) */}
          {state.isGenerating && (
            <button
              onClick={stopGeneration}
              style={{
                ...getButtonStyle('danger'),
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              {i18n('ai_helper_batch_summary_stop')}
            </button>
          )}

          {/* Continue button (after stop, if pending students remain) */}
          {!state.isGenerating && isStopped && hasPending && (
            <button
              onClick={continueGeneration}
              style={getButtonStyle('primary')}
            >
              {i18n('ai_helper_batch_summary_continue')}
            </button>
          )}

          {/* Generate / Regenerate button */}
          {!state.isGenerating && (
            <button
              onClick={handleGenerate}
              style={getButtonStyle('primary')}
            >
              {state.summaries.size > 0
                ? i18n('ai_helper_batch_summary_regenerate')
                : i18n('ai_helper_batch_summary_generate')}
            </button>
          )}
        </div>
      )}

      {/* Progress bar */}
      {state.isGenerating && state.total > 0 && (
        <div style={{
          backgroundColor: '#eff6ff',
          border: `1px solid #bfdbfe`,
          borderRadius: RADIUS.md,
          padding: SPACING.base,
          marginBottom: SPACING.base,
        }}>
          {/* Track */}
          <div style={{
            width: '100%',
            height: '6px',
            backgroundColor: '#dbeafe',
            borderRadius: RADIUS.full,
            overflow: 'hidden',
            marginBottom: SPACING.sm,
          }}>
            <div style={{
              width: `${progressPct}%`,
              height: '100%',
              backgroundColor: COLORS.primary,
              borderRadius: RADIUS.full,
              transition: 'width 300ms ease',
            }} />
          </div>

          {/* Label */}
          <div style={{ fontSize: '13px', color: COLORS.infoText }}>
            {i18n('ai_helper_batch_summary_generating')}
            {' '}
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
      {!state.isGenerating && isStopped && hasPending && (
        <div style={{
          backgroundColor: COLORS.warningBg,
          border: `1px solid ${COLORS.warningBorder}`,
          borderRadius: RADIUS.md,
          padding: SPACING.base,
          marginBottom: SPACING.base,
          fontSize: '13px',
          color: COLORS.warningText,
        }}>
          {i18n('ai_helper_batch_summary_stopped_notice')}
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
              <div
                key={userId}
                style={{
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.md,
                  boxShadow: SHADOWS.sm,
                  overflow: 'hidden',
                  backgroundColor: COLORS.bgCard,
                }}
              >
                {/* Row header (always visible) */}
                <div
                  onClick={() => toggleUser(userId)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: `${SPACING.sm} ${SPACING.base}`,
                    cursor: 'pointer',
                    borderBottom: isExpanded ? `1px solid ${COLORS.border}` : 'none',
                    userSelect: 'none',
                    gap: SPACING.sm,
                    backgroundColor: isExpanded ? COLORS.bgPage : COLORS.bgCard,
                  }}
                >
                  {/* Chevron */}
                  <span style={{
                    fontSize: '12px',
                    color: COLORS.textMuted,
                    transition: 'transform 150ms',
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    display: 'inline-block',
                    width: '14px',
                    flexShrink: 0,
                  }}>
                    ▶
                  </span>

                  {/* Name */}
                  <span style={{
                    fontWeight: 600,
                    fontSize: '14px',
                    color: COLORS.textPrimary,
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {data.userName || `User #${userId}`}
                  </span>

                  {/* Status badge */}
                  <span style={{
                    fontSize: '12px',
                    fontWeight: 500,
                    padding: `2px ${SPACING.sm}`,
                    borderRadius: RADIUS.full,
                    flexShrink: 0,
                    color:
                      data.status === 'failed'
                        ? COLORS.errorText
                        : data.status === 'pending'
                          ? COLORS.textMuted
                          : data.publishStatus === 'published'
                            ? COLORS.successText
                            : COLORS.warningText,
                    backgroundColor:
                      data.status === 'failed'
                        ? COLORS.errorBg
                        : data.status === 'pending'
                          ? COLORS.bgPage
                          : data.publishStatus === 'published'
                            ? COLORS.successBg
                            : COLORS.warningBg,
                    border: `1px solid ${
                      data.status === 'failed'
                        ? COLORS.errorBorder
                        : data.status === 'pending'
                          ? COLORS.border
                          : data.publishStatus === 'published'
                            ? COLORS.successBorder
                            : COLORS.warningBorder
                    }`,
                  }}>
                    {data.status === 'failed'
                      ? i18n('ai_helper_batch_summary_failed')
                      : data.status === 'pending'
                        ? i18n('ai_helper_batch_summary_pending')
                        : data.publishStatus === 'published'
                          ? i18n('ai_helper_batch_summary_published')
                          : i18n('ai_helper_batch_summary_draft')}
                  </span>
                </div>

                {/* Expanded card body */}
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
          textAlign: 'center',
          color: COLORS.textMuted,
          padding: SPACING.xxl,
          fontSize: '14px',
          border: `2px dashed ${COLORS.border}`,
          borderRadius: RADIUS.lg,
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

function initBatchSummaryPanel() {
  const parsed = parseScoreboardUrl();
  if (!parsed) return;

  if (!hasTeacherPrivilege()) return;

  // HydroOJ scoreboard DOM: .section__header contains export <a class="button"> elements
  const sectionHeader = document.querySelector('.section__header');

  // Create container — insert between .section__header and the scoreboard table
  const container = document.createElement('div');
  container.id = 'ai-batch-summary-root';
  container.style.margin = `${SPACING.base} 0`;
  container.style.padding = `0 ${SPACING.base}`;

  if (sectionHeader && sectionHeader.parentElement) {
    // Insert after .section__header (before scoreboard table fragment)
    sectionHeader.parentElement.insertBefore(container, sectionHeader.nextSibling);
  } else {
    // Fallback: insert before [data-fragment-id="scoreboard"] or at section top
    const scoreboard = document.querySelector('[data-fragment-id="scoreboard"]');
    if (scoreboard && scoreboard.parentElement) {
      scoreboard.parentElement.insertBefore(container, scoreboard);
    } else {
      const section = document.querySelector('.section.visible') || document.body;
      section.appendChild(container);
    }
  }

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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBatchSummaryPanel, { once: true });
} else {
  initBatchSummaryPanel();
}
