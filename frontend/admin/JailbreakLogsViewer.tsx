import React from 'react';
import { i18n } from '@hydrooj/ui-default';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  cardStyle, getButtonStyle,
} from '../utils/styles';
import type { JailbreakLogPagination } from './configTypes';

interface JailbreakLogsViewerProps {
  logPagination: JailbreakLogPagination;
  loading: boolean;
  onChangePage: (page: number) => void;
  onCopyToClipboard: (text: string) => void;
  onAppendPattern: (pattern: string) => void;
}

export const JailbreakLogsViewer: React.FC<JailbreakLogsViewerProps> = ({
  logPagination, loading, onChangePage, onCopyToClipboard, onAppendPattern,
}) => {
  const [collapsed, setCollapsed] = React.useState(true);

  return (
  <div style={{
    ...cardStyle,
    marginTop: '20px',
  }}>
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
      onClick={() => setCollapsed(!collapsed)}
    >
      <h2 style={{ margin: 0, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
        <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', marginRight: '8px' }}>▼</span>
        {i18n('ai_helper_admin_jailbreak_title')}
      </h2>
      {logPagination.total > 0 && (
        <span style={{ fontSize: '13px', color: COLORS.textMuted }}>
          {i18n('ai_helper_admin_jailbreak_total', logPagination.total)}
        </span>
      )}
    </div>

    {collapsed ? null : logPagination.logs.length === 0 ? (
      <div style={{
        padding: SPACING.base, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md,
        border: `1px dashed ${COLORS.border}`, color: COLORS.textMuted, fontSize: '14px',
      }}>
        {i18n('ai_helper_admin_jailbreak_empty')}
      </div>
    ) : (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.base }}>
          {logPagination.logs.map((log) => {
            const contextPieces: string[] = [];
            if (log.userId !== undefined) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_user_id')}${log.userId}`);
            if (log.problemId) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_problem_id')}${log.problemId}`);
            if (log.conversationId) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_conversation_id')}${log.conversationId}`);
            if (log.questionType) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_question_type')}${log.questionType}`);
            const contextText = contextPieces.join(' \u00b7 ');

            return (
              <div key={log.id} style={{
                ...cardStyle,
              }}>
                <div style={{ fontSize: '14px', color: COLORS.textPrimary, fontWeight: 500 }}>
                  {i18n('ai_helper_admin_jailbreak_time')}{new Date(log.createdAt).toLocaleString()}
                </div>
                <div style={{ marginTop: '6px', fontSize: '13px', color: COLORS.textSecondary }}>
                  {i18n('ai_helper_admin_jailbreak_matched_rule')}<code style={{ fontFamily: 'monospace' }}>{log.matchedPattern}</code>
                </div>
                <pre style={{
                  marginTop: '10px', padding: SPACING.md, backgroundColor: '#1f2937', color: '#f9fafb',
                  borderRadius: RADIUS.md, fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {log.matchedText}
                </pre>
                {contextText && (
                  <div style={{ marginTop: '6px', fontSize: '12px', color: COLORS.textMuted }}>
                    {contextText}
                  </div>
                )}
                <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                  <button type="button" onClick={() => onCopyToClipboard(log.matchedText)} style={getButtonStyle('secondary')}>
                    {i18n('ai_helper_admin_jailbreak_copy_text')}
                  </button>
                  <button type="button" onClick={() => onCopyToClipboard(log.matchedPattern)} style={getButtonStyle('secondary')}>
                    {i18n('ai_helper_admin_jailbreak_copy_regex')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAppendPattern(log.matchedPattern)}
                    style={getButtonStyle('ghost')}
                  >
                    {i18n('ai_helper_admin_jailbreak_append_rule')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {logPagination.totalPages > 1 && (
          <div style={{
            marginTop: '20px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px',
          }}>
            <button
              onClick={() => onChangePage(logPagination.page - 1)}
              disabled={logPagination.page <= 1 || loading}
              style={{
                ...getButtonStyle('secondary'),
                opacity: logPagination.page <= 1 ? 0.5 : 1,
                cursor: logPagination.page <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              {i18n('ai_helper_admin_jailbreak_prev_page')}
            </button>
            <span style={{ fontSize: '14px', color: COLORS.textSecondary }}>
              {i18n('ai_helper_admin_jailbreak_page_info', logPagination.page, logPagination.totalPages)}
            </span>
            <button
              onClick={() => onChangePage(logPagination.page + 1)}
              disabled={logPagination.page >= logPagination.totalPages || loading}
              style={{
                ...getButtonStyle('secondary'),
                opacity: logPagination.page >= logPagination.totalPages ? 0.5 : 1,
                cursor: logPagination.page >= logPagination.totalPages ? 'not-allowed' : 'pointer',
              }}
            >
              {i18n('ai_helper_admin_jailbreak_next_page')}
            </button>
          </div>
        )}
      </>
    )}
  </div>
  );
};
