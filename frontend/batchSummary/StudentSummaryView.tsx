/**
 * StudentSummaryView — read-only view of a student's published AI learning summary.
 * Fetches the current user's published summary for a given contest and renders markdown.
 * Polls every 30s until a published summary is found, then stops.
 * While nothing is published (or the request fails) it renders an explanatory
 * placeholder instead of nothing — a blank tab is indistinguishable from a bug
 * for students, which is exactly how the "无法看到 AI 学习总结" report read.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, LAYOUT, markdownTheme, emptyStateStyle } from '../utils/styles';
import { renderMarkdown } from '../utils/markdown';

/** i18n with hardcoded Chinese fallback for keys that may not yet be in lang-*.js */
const I18N_FALLBACK: Record<string, string> = {
  ai_helper_batch_summary_my_title: 'AI 学习总结',
  ai_helper_batch_summary_my_empty: '你的学习总结尚未发布。老师发布后会自动显示在这里。',
  ai_helper_batch_summary_my_load_failed: '学习总结加载失败，正在自动重试…',
};

function t(key: string): string {
  const val = i18n(key);
  return val === key ? (I18N_FALLBACK[key] || val) : val;
}

interface StudentSummaryViewProps {
  domainId: string;
  contestId: string;
}

function renderSummaryHtml(summary: string, domainId: string): string {
  let html = renderMarkdown(summary);
  html = html.replace(
    /\[提交 #(r([a-f0-9]+))\]/g,
    (_match, display, objectId) =>
      `<a href="/d/${domainId}/record/${objectId}" target="_blank" rel="noopener noreferrer" `
      + `style="color:${COLORS.primary};background:#eff6ff;border-radius:4px;padding:1px 4px;text-decoration:none">`
      + `[提交 #${display}]</a>`,
  );
  return html;
}

function buildUrl(domainId: string, path: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/batch-summaries${path}`
    : `/ai-helper/batch-summaries${path}`;
}

const POLL_INTERVAL = 30000; // 30 seconds

/** Fetch outcome: `failed` distinguishes request errors from "not published yet" */
interface FetchResult {
  failed: boolean;
  summary: string | null;
}

export const StudentSummaryView: React.FC<StudentSummaryViewProps> = ({ domainId, contestId }) => {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSummary = useCallback(async (): Promise<FetchResult> => {
    try {
      const res = await fetch(buildUrl(domainId, `/my-summary?contestId=${contestId}`), {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) return { failed: true, summary: null };
      const data = await res.json();
      return { failed: false, summary: data.summary?.summary || null };
    } catch {
      return { failed: true, summary: null };
    }
  }, [domainId, contestId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const result = await fetchSummary();
      if (cancelled) return;
      setLoading(false);
      setLoadFailed(result.failed);
      if (result.summary) {
        setSummary(result.summary);
        return; // Already have summary, no need to poll
      }

      // No published summary yet (or the request failed) — poll until one appears
      timerRef.current = setInterval(async () => {
        const polled = await fetchSummary();
        if (cancelled) return;
        setLoadFailed(polled.failed);
        if (polled.summary) {
          setSummary(polled.summary);
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

  if (loading) return null;

  if (!summary) {
    return (
      <div style={{
        maxWidth: LAYOUT.contentMaxWidth,
        margin: '0 auto',
        width: '100%',
        marginBottom: SPACING.base,
      }}>
        <div style={emptyStateStyle}>
          {t(loadFailed ? 'ai_helper_batch_summary_my_load_failed' : 'ai_helper_batch_summary_my_empty')}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      maxWidth: LAYOUT.contentMaxWidth,
      margin: '0 auto',
      width: '100%',
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
