/**
 * StudentSummaryView — read-only view of a student's published AI learning summary.
 * Fetches the current user's published summary for a given contest and renders markdown.
 * Polls every 30s until a published summary is found, then stops.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, markdownTheme } from '../utils/styles';
import { renderMarkdown } from '../utils/markdown';

function t(key: string): string {
  const val = i18n(key);
  if (val === key && key === 'ai_helper_batch_summary_my_title') return 'AI 学习总结';
  return val;
}

interface StudentSummaryViewProps {
  domainId: string;
  contestId: string;
}

function renderSummaryHtml(summary: string, domainId: string): string {
  let html = renderMarkdown(summary);
  html = html.replace(
    /\[提交 #(r[a-f0-9]+)\]/g,
    (_match, recordId) =>
      `<a href="/d/${domainId}/record/${recordId}" target="_blank" rel="noopener noreferrer" `
      + `style="color:${COLORS.primary};background:#eff6ff;border-radius:4px;padding:1px 4px;text-decoration:none">`
      + `[提交 #${recordId}]</a>`,
  );
  return html;
}

function buildUrl(domainId: string, path: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/batch-summaries${path}`
    : `/ai-helper/batch-summaries${path}`;
}

const POLL_INTERVAL = 30000; // 30 seconds

export const StudentSummaryView: React.FC<StudentSummaryViewProps> = ({ domainId, contestId }) => {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch(buildUrl(domainId, `/my-summary?contestId=${contestId}`), {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.summary?.summary || null;
    } catch {
      return null;
    }
  }, [domainId, contestId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const result = await fetchSummary();
      if (cancelled) return;
      setLoading(false);
      if (result) {
        setSummary(result);
        return; // Already have summary, no need to poll
      }

      // No published summary yet — start polling until one appears
      timerRef.current = setInterval(async () => {
        const polled = await fetchSummary();
        if (cancelled) return;
        if (polled) {
          setSummary(polled);
          // Stop polling once we have the summary
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
        }
      }, POLL_INTERVAL);
    })();

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fetchSummary]);

  if (loading || !summary) return null;

  return (
    <div style={{
      backgroundColor: COLORS.bgCard,
      borderRadius: RADIUS.md,
      boxShadow: SHADOWS.sm,
      borderLeft: `3px solid ${COLORS.primary}`,
      overflow: 'hidden',
      marginBottom: SPACING.base,
    }}>
      <style>{markdownTheme}</style>

      {/* Header */}
      <div style={{
        padding: `${SPACING.sm} ${SPACING.base}`,
        borderBottom: `1px solid ${COLORS.border}`,
        fontWeight: 600,
        fontSize: '14px',
        color: COLORS.primary,
      }}>
        {t('ai_helper_batch_summary_my_title')}
      </div>

      {/* Body */}
      <div style={{ padding: SPACING.base }}>
        <div
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: renderSummaryHtml(summary, domainId) }}
          style={{
            fontSize: '14px',
            color: COLORS.textPrimary,
            lineHeight: 1.6,
            wordBreak: 'break-word',
          }}
        />
      </div>
    </div>
  );
};

export default StudentSummaryView;
