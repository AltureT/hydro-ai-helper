/**
 * StudentSummaryView — read-only view of a student's published AI learning summary.
 * Fetches the current user's published summary for a given contest and renders markdown.
 */

import React, { useEffect, useState } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, markdownTheme } from '../utils/styles';
import { renderMarkdown } from '../utils/markdown';

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

export const StudentSummaryView: React.FC<StudentSummaryViewProps> = ({ domainId, contestId }) => {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(buildUrl(domainId, `/my-summary?contestId=${contestId}`), {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data.summary?.summary) {
          setSummary(data.summary.summary);
        }
      } catch {
        // silently ignore — student simply won't see a summary
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [domainId, contestId]);

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
        {i18n('ai_helper_batch_summary_my_title')}
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
