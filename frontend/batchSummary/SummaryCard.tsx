/**
 * SummaryCard — displays a single student's AI-generated learning summary.
 * Supports failed state (with retry), completed state (with edit/publish),
 * and inline submission link rendering.
 */

import React, { useState } from 'react';
import { i18n } from '@hydrooj/ui-default';
import {
  COLORS, SPACING, RADIUS, SHADOWS, getButtonStyle,
} from '../utils/styles';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SummaryCardProps {
  userId: number;
  userName: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  publishStatus: 'draft' | 'published';
  summary: string | null;
  error?: string;
  domainId: string;
  isTeacher: boolean;
  onRetry?: () => void;
  onPublish?: () => void;
  onEdit?: (newSummary: string) => void;
}

// ─── Submission Link Renderer ─────────────────────────────────────────────────

function renderSummaryWithLinks(summary: string, domainId: string): React.ReactNode[] {
  const parts = summary.split(/(\[提交 #r[a-f0-9]+\])/g);
  return parts.map((part, idx) => {
    const match = part.match(/^\[提交 #(r[a-f0-9]+)\]$/);
    if (match) {
      const recordId = match[1];
      return (
        <a
          key={idx}
          href={`/d/${domainId}/record/${recordId}`}
          style={{
            color: COLORS.primary,
            backgroundColor: '#eff6ff',
            borderRadius: RADIUS.sm,
            padding: '1px 4px',
            textDecoration: 'none',
            fontSize: 'inherit',
          }}
          target="_blank"
          rel="noopener noreferrer"
        >
          {part}
        </a>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export const SummaryCard: React.FC<SummaryCardProps> = ({
  userName,
  status,
  publishStatus,
  summary,
  error,
  domainId,
  isTeacher,
  onRetry,
  onPublish,
  onEdit,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  // ── Failed state ────────────────────────────────────────────────────────────

  if (status === 'failed') {
    return (
      <div style={{
        backgroundColor: COLORS.errorBg,
        border: `1px solid ${COLORS.errorBorder}`,
        borderRadius: RADIUS.md,
        padding: SPACING.base,
        boxShadow: SHADOWS.sm,
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: SPACING.sm,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '14px', color: COLORS.errorText, marginBottom: SPACING.xs }}>
              {userName}
            </div>
            <div style={{ fontSize: '13px', color: COLORS.errorText }}>
              {i18n('ai_helper_batch_summary_failed')}
              {error && <span style={{ marginLeft: SPACING.xs }}>{error}</span>}
            </div>
          </div>
          {isTeacher && onRetry && (
            <button
              onClick={onRetry}
              style={{
                ...getButtonStyle('danger'),
                padding: `4px ${SPACING.sm}`,
                fontSize: '13px',
                flexShrink: 0,
              }}
            >
              {i18n('ai_helper_batch_summary_retry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Completed state ─────────────────────────────────────────────────────────

  if (status === 'completed' && summary !== null) {
    const isDraft = publishStatus === 'draft';

    const handleEditStart = () => {
      setEditValue(summary);
      setIsEditing(true);
    };

    const handleEditSave = () => {
      onEdit?.(editValue);
      setIsEditing(false);
    };

    const handleEditCancel = () => {
      setIsEditing(false);
      setEditValue('');
    };

    return (
      <div style={{
        backgroundColor: COLORS.bgCard,
        borderRadius: RADIUS.md,
        boxShadow: SHADOWS.sm,
        borderLeft: `3px solid ${COLORS.primary}`,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: `${SPACING.sm} ${SPACING.base}`,
          borderBottom: `1px solid ${COLORS.border}`,
          gap: SPACING.sm,
          flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: '14px', color: COLORS.textPrimary, whiteSpace: 'nowrap' }}>
              {userName}
            </span>
            <span style={{ fontSize: '13px', color: COLORS.textSecondary }}>
              {i18n('ai_helper_batch_summary')}
            </span>
            {isTeacher && isDraft && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: `2px ${SPACING.sm}`,
                fontSize: '11px',
                fontWeight: 500,
                color: COLORS.warningText,
                backgroundColor: COLORS.warningBg,
                border: `1px solid ${COLORS.warningBorder}`,
                borderRadius: RADIUS.full,
                flexShrink: 0,
              }}>
                {i18n('ai_helper_batch_summary_draft')}
              </span>
            )}
          </div>

          {/* Teacher actions */}
          {isTeacher && !isEditing && (
            <div style={{ display: 'flex', gap: SPACING.xs, flexShrink: 0 }}>
              {isDraft && onPublish && (
                <button
                  onClick={onPublish}
                  style={{
                    ...getButtonStyle('primary'),
                    padding: `4px ${SPACING.sm}`,
                    fontSize: '13px',
                  }}
                >
                  {i18n('ai_helper_batch_summary_publish_one')}
                </button>
              )}
              {onEdit && (
                <button
                  onClick={handleEditStart}
                  style={{
                    ...getButtonStyle('secondary'),
                    padding: `4px ${SPACING.sm}`,
                    fontSize: '13px',
                  }}
                >
                  {i18n('ai_helper_batch_summary_edit')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: SPACING.base }}>
          {isEditing ? (
            <div>
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{
                  width: '100%',
                  minHeight: '120px',
                  padding: SPACING.sm,
                  fontSize: '14px',
                  color: COLORS.textPrimary,
                  backgroundColor: COLORS.bgCard,
                  border: `1px solid ${COLORS.borderFocus}`,
                  borderRadius: RADIUS.md,
                  resize: 'vertical',
                  outline: 'none',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                  lineHeight: 1.6,
                }}
              />
              <div style={{ display: 'flex', gap: SPACING.sm, marginTop: SPACING.sm }}>
                <button
                  onClick={handleEditSave}
                  style={{
                    ...getButtonStyle('primary'),
                    padding: `4px ${SPACING.sm}`,
                    fontSize: '13px',
                  }}
                >
                  {i18n('Save')}
                </button>
                <button
                  onClick={handleEditCancel}
                  style={{
                    ...getButtonStyle('secondary'),
                    padding: `4px ${SPACING.sm}`,
                    fontSize: '13px',
                  }}
                >
                  {i18n('ai_helper_batch_summary_cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              fontSize: '14px',
              color: COLORS.textPrimary,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {renderSummaryWithLinks(summary, domainId)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Pending / generating (and null summary on completed) ────────────────────
  return null;
};

export default SummaryCard;
