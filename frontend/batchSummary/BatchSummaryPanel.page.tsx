/**
 * BatchSummaryPanel — teacher-facing page for AI batch learning summary generation.
 * Supports SSE progress streaming, expand/collapse, publish, export, and edit flows.
 *
 * Route: /ai-helper/batch-summaries (teacher/admin)
 */

import React, { useEffect, useState, useCallback } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, getButtonStyle, getAlertStyle } from '../utils/styles';
import { useBatchSummary } from './useBatchSummary';
import { SummaryCard } from './SummaryCard';

// ─── Props ─────────────────────────────────────────────────────────────────────

interface BatchSummaryPanelProps {
  domainId: string;
  contestId: string;
  isTeacher: boolean;
  existingJobId?: string;
}

// ─── URL helper ────────────────────────────────────────────────────────────────

function buildUrl(domainId: string, path: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/batch-summaries${path}`
    : `/ai-helper/batch-summaries${path}`;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export const BatchSummaryPanel: React.FC<BatchSummaryPanelProps> = ({
  domainId,
  contestId,
  isTeacher,
  existingJobId,
}) => {
  const { state, startGeneration, loadExisting, publishAll, retryStudent, cleanup } =
    useBatchSummary(domainId);

  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);

  // ── Mount / unmount ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (existingJobId) {
      loadExisting(existingJobId);
    }
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
    try {
      const res = await fetch(buildUrl(domainId, `/publish/${userId}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.error('[BatchSummaryPanel] publish failed:', errData.error);
      }
    } catch (err) {
      console.error('[BatchSummaryPanel] publish error:', err);
    }
  }, [domainId]);

  // ── Edit ────────────────────────────────────────────────────────────────────

  const handleEdit = useCallback(async (userId: number, newSummary: string) => {
    try {
      const res = await fetch(buildUrl(domainId, `/edit/${userId}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ userId, summary: newSummary }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.error('[BatchSummaryPanel] edit failed:', errData.error);
      }
    } catch (err) {
      console.error('[BatchSummaryPanel] edit error:', err);
    }
  }, [domainId]);

  // ── Derived values ──────────────────────────────────────────────────────────

  const hasDrafts = Array.from(state.summaries.values()).some(
    s => s.status === 'completed' && s.publishStatus === 'draft',
  );
  const progressPct =
    state.total > 0 ? Math.round(((state.completed + state.failed) / state.total) * 100) : 0;

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: 'inherit', color: COLORS.textPrimary }}>

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

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={state.isGenerating}
            style={{
              ...getButtonStyle('primary'),
              opacity: state.isGenerating ? 0.6 : 1,
              cursor: state.isGenerating ? 'not-allowed' : 'pointer',
            }}
          >
            {state.isGenerating
              ? i18n('ai_helper_batch_summary_generating')
              : i18n('ai_helper_batch_summary_generate')}
          </button>
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
                        : data.publishStatus === 'published'
                          ? COLORS.successText
                          : COLORS.warningText,
                    backgroundColor:
                      data.status === 'failed'
                        ? COLORS.errorBg
                        : data.publishStatus === 'published'
                          ? COLORS.successBg
                          : COLORS.warningBg,
                    border: `1px solid ${
                      data.status === 'failed'
                        ? COLORS.errorBorder
                        : data.publishStatus === 'published'
                          ? COLORS.successBorder
                          : COLORS.warningBorder
                    }`,
                  }}>
                    {data.status === 'failed'
                      ? i18n('ai_helper_batch_summary_failed')
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
      {state.summaries.size === 0 && !state.isGenerating && !state.error && (
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
