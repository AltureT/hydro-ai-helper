/** A learning summary with teacher review actions and an optional standalone heading. */
import React, { useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, SPACING, getButtonStyle } from '../utils/styles';
import { renderReportMarkdown, reportMarkdownStyles } from '../utils/reportMarkdown';
import { Icon } from '../components/Icon';

export interface SummaryCardProps {
  userId: number;
  userName: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  publishStatus: 'draft' | 'published';
  summary: string | null;
  error?: string;
  domainId: string;
  isTeacher: boolean;
  embedded?: boolean;
  actionsDisabled?: boolean;
  onRetry?: () => void | Promise<void>;
  onPublish?: () => void | Promise<void>;
  onEdit?: (newSummary: string) => void | Promise<void>;
}

function renderSummaryHtml(summary: string, domainId: string): string {
  return renderReportMarkdown(summary).replace(
    /\[提交 #(r([a-f0-9]+))\]/g,
    (_match, display, objectId) =>
      `<a href="/d/${encodeURIComponent(domainId)}/record/${objectId}" target="_blank" rel="noopener noreferrer">[提交 #${display}]</a>`,
  );
}

export const SummaryCard: React.FC<SummaryCardProps> = ({
  userName, status, publishStatus, summary, error, domainId, isTeacher,
  embedded = false, actionsDisabled = false, onRetry, onPublish, onEdit,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (action: () => void | Promise<void>, closeEditor = false) => {
    if (busy || actionsDisabled) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      if (closeEditor) setIsEditing(false);
    } catch {
      setActionError(i18n('ai_helper_batch_summary_action_failed'));
    } finally {
      setBusy(false);
    }
  };
  const actionStyle = (primary = false) => ({
    ...getButtonStyle(primary ? 'primary' : 'secondary'), gap: '6px',
    padding: '6px 12px', fontSize: '13px', opacity: busy ? 0.55 : 1,
  });

  return (
    <div className="ai-report-content" aria-busy={busy}>
      <style>{reportMarkdownStyles}</style>
      {!embedded && <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>{userName} {i18n('ai_helper_batch_summary')}</h3>}
      {status === 'failed' ? (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px', color: COLORS.errorText }}>
          <Icon name="warning" />
          <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{error || i18n('ai_helper_batch_summary_failed')}</span>
          {isTeacher && onRetry && <button type="button" disabled={busy || actionsDisabled} style={actionStyle()} onClick={() => runAction(onRetry)}><Icon name="refresh" /> {i18n('ai_helper_batch_summary_retry')}</button>}
        </div>
      ) : status === 'completed' && summary !== null ? (
        <>
          {isEditing ? (
            <div>
              <textarea
                aria-label={i18n('ai_helper_batch_summary_edit')} value={editValue}
                onChange={event => setEditValue(event.target.value)} disabled={busy}
                style={{ width: '100%', minHeight: '240px', padding: SPACING.md,
                  font: 'inherit', fontSize: '14px', lineHeight: 1.7, resize: 'vertical',
                  border: `1px solid ${COLORS.borderFocus}`, borderRadius: '6px', boxSizing: 'border-box' }}
              />
              <div className="summary-actions">
                <button type="button" disabled={busy} style={actionStyle()} onClick={() => setIsEditing(false)}>{i18n('ai_helper_batch_summary_cancel')}</button>
                <button type="button" disabled={busy} style={actionStyle(true)} onClick={() => onEdit && runAction(() => onEdit(editValue), true)}><Icon name="check" /> {i18n('Save')}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderSummaryHtml(summary, domainId) }} />
              {isTeacher && (onEdit || (onPublish && publishStatus === 'draft')) && (
                <div className="summary-actions">
                  {onEdit && <button type="button" disabled={busy} style={actionStyle()} onClick={() => { setEditValue(summary); setActionError(null); setIsEditing(true); }}><Icon name="edit" /> {i18n('ai_helper_batch_summary_edit')}</button>}
                  {onPublish && publishStatus === 'draft' && <button type="button" disabled={busy} style={actionStyle(true)} onClick={() => runAction(onPublish)}><Icon name="upload" /> {i18n('ai_helper_batch_summary_publish_one')}</button>}
                </div>
              )}
            </>
          )}
        </>
      ) : <p style={{ color: COLORS.textSecondary }}>{i18n(status === 'generating' ? 'ai_helper_batch_summary_generating' : 'ai_helper_batch_summary_pending')}</p>}
      {actionError && <p role="alert" style={{ color: COLORS.errorText, marginTop: '12px' }}>{actionError}</p>}
    </div>
  );
};

export default SummaryCard;
