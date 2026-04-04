import React from 'react';
import { i18n } from 'vj/utils';
import {
  COLORS, SPACING, RADIUS, SHADOWS, TRANSITIONS, FONT_FAMILY,
  getButtonStyle, getPillStyle, getInputStyle,
} from '../utils/styles';

interface QuestionType {
  value: string;
  label: string;
  description?: string;
}

interface ChatInputProps {
  userThinking: string;
  onUserThinkingChange: (value: string) => void;
  questionType: string;
  onQuestionTypeChange: (value: string) => void;
  questionTypes: QuestionType[];
  includeCode: boolean;
  onIncludeCodeChange: (checked: boolean) => void;
  code: string;
  onCodeClear: () => void;
  isLoading: boolean;
  conversationHistoryLength: number;
  onSubmit: () => void;
  onCancel: () => void;
  onRefreshCode: () => void;
  onNewConversation: () => void;
  errorBanner?: React.ReactNode;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  userThinking, onUserThinkingChange,
  questionType, onQuestionTypeChange, questionTypes,
  includeCode, onIncludeCodeChange, code, onCodeClear,
  isLoading, conversationHistoryLength,
  onSubmit, onCancel, onRefreshCode, onNewConversation,
  errorBanner,
}) => {
  const isFirstConversation = conversationHistoryLength === 0;
  const isFollowUp = conversationHistoryLength > 0;
  const canSubmit = isFirstConversation ? !!questionType : !!userThinking.trim();

  const renderIncludeCodeCheckbox = (labelText: string) => (
    <label
      style={{
        display: 'flex', alignItems: 'center',
        cursor: questionType === 'optimize' ? 'not-allowed' : 'pointer',
        fontSize: '12px', color: questionType === 'optimize' ? COLORS.textDisabled : COLORS.textSecondary,
        whiteSpace: 'nowrap', alignSelf: 'center',
      }}
      title={questionType === 'optimize' ? i18n('ai_helper_student_optimize_code_required') : undefined}
    >
      <input
        type="checkbox" checked={includeCode} disabled={questionType === 'optimize'}
        onChange={(e) => onIncludeCodeChange(e.target.checked)}
        style={{ marginRight: '6px', accentColor: COLORS.primary }}
      />
      {labelText}
      {questionType === 'optimize' && <span style={{ marginLeft: '4px', color: COLORS.warning, fontSize: '11px' }}>({i18n('ai_helper_student_required')})</span>}
      {includeCode && code && questionType !== 'optimize' && <span style={{ marginLeft: '4px', color: COLORS.success, fontSize: '11px' }}>&#10003;</span>}
    </label>
  );

  const renderTextarea = (minHeight: string, maxHeight: string) => (
    <textarea
      value={userThinking}
      onChange={(e) => onUserThinkingChange(e.target.value)}
      placeholder={isFirstConversation ? i18n('ai_helper_student_placeholder_first') : i18n('ai_helper_student_placeholder_followup')}
      style={{
        ...getInputStyle(),
        border: 'none', outline: 'none', boxShadow: 'none',
        backgroundColor: 'transparent',
        flex: 1, minHeight, maxHeight,
        resize: 'none' as const, boxSizing: 'border-box' as const,
      }}
      onFocus={() => {}}
      onBlur={() => {}}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSubmit(); }
      }}
    />
  );

  const disabledSubmit = isLoading || !canSubmit;
  const submitStyle: React.CSSProperties = {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    background: disabledSubmit ? COLORS.bgDisabled : COLORS.gradient,
    color: disabledSubmit ? COLORS.textDisabled : '#ffffff',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabledSubmit ? 'not-allowed' : 'pointer',
    transition: 'all 150ms ease',
    boxShadow: disabledSubmit ? 'none' : '0 2px 6px rgba(37, 99, 235, 0.3)',
    flexShrink: 0,
    fontSize: '16px',
    padding: 0,
  };

  return (
    <div style={{ background: COLORS.bgPage, flexShrink: 0 }}>
      {errorBanner}

      {/* Question type pills - above the card */}
      {isFirstConversation && (
        <div style={{ padding: `${SPACING.sm} ${SPACING.base} 0` }}>
          <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginBottom: SPACING.xs }}>{i18n('ai_helper_student_select_type')}：</div>
          <div className="hide-scrollbar" style={{ display: 'flex', overflowX: 'auto', gap: SPACING.sm }}>
            {questionTypes.map(type => {
              const isSelected = questionType === type.value;
              return (
                <label
                  key={type.value}
                  style={{
                    ...getPillStyle(isSelected),
                    userSelect: 'none' as const,
                  }}
                >
                  <input
                    type="radio" name="questionType" value={type.value}
                    checked={isSelected} onChange={(e) => onQuestionTypeChange(e.target.value)}
                    style={{ display: 'none' }}
                  />
                  {i18n(type.label)}
                </label>
              );
            })}
          </div>
          {questionType && (() => {
            const selected = questionTypes.find(t => t.value === questionType);
            const descKey = (selected as any)?.description;
            return descKey ? (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: SPACING.xs }}>
                {i18n(descKey)}
                {questionType === 'debug' && i18n('ai_helper_student_debug_auto_attach')}
              </div>
            ) : null;
          })()}
        </div>
      )}

      {/* Follow-up action buttons - above the card */}
      {isFollowUp && (
        <div style={{ display: 'flex', gap: SPACING.sm, padding: `${SPACING.sm} ${SPACING.base} 0` }}>
          <button
            type="button" onClick={onRefreshCode}
            style={{
              ...getButtonStyle('secondary'),
              fontSize: '12px', padding: `${SPACING.xs} ${SPACING.md}`,
              display: 'flex', alignItems: 'center', gap: SPACING.xs,
            }}
          >
            📎 {includeCode ? i18n('ai_helper_student_code_attached') : i18n('ai_helper_student_attach_code')}
          </button>
          <button
            type="button" onClick={onNewConversation}
            style={{
              ...getButtonStyle('ghost'),
              fontSize: '12px', padding: `${SPACING.xs} ${SPACING.md}`,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            🔄 {i18n('ai_helper_student_new_conversation')}
          </button>
        </div>
      )}

      {isFollowUp && includeCode && code && (
        <div style={{
          background: COLORS.bgPage, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
          padding: SPACING.sm, margin: `${SPACING.sm} ${SPACING.base} 0`, fontSize: '11px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.xs }}>
            <span style={{ color: COLORS.textSecondary }}>📝 {i18n('ai_helper_student_code_attached')} ({code.length} {i18n('ai_helper_student_chars')})</span>
            <button
              type="button" onClick={onCodeClear}
              style={{ background: 'none', border: 'none', color: COLORS.error, cursor: 'pointer', fontSize: '11px', padding: '2px 4px' }}
            >
              ✕ {i18n('ai_helper_student_remove')}
            </button>
          </div>
          <pre style={{
            margin: 0, fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: COLORS.textPrimary, maxHeight: '60px', overflow: 'auto',
          }}>
            {code.length > 200 ? code.substring(0, 200) + '...' : code}
          </pre>
        </div>
      )}

      {/* Unified input card */}
      <div className="chat-input-card" style={{
        margin: '12px', padding: '10px 12px 10px 16px', borderRadius: '24px',
        border: `1px solid ${COLORS.border}`, backgroundColor: '#f8fafc',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.04)', transition: 'all 200ms ease',
      }}>
        {renderTextarea(isFirstConversation ? '48px' : '24px', '120px')}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
          {isFirstConversation ? renderIncludeCodeCheckbox(`📎 ${i18n('ai_helper_student_attach_current_code')}`) : <div />}
          {isLoading ? (
            <button
              onClick={onCancel}
              style={{ ...getButtonStyle('danger'), whiteSpace: 'nowrap', borderRadius: RADIUS.full, padding: '6px 16px', fontSize: '13px' }}
            >
              {i18n('ai_helper_student_cancel')}
            </button>
          ) : (
            <button
              onClick={onSubmit} disabled={disabledSubmit}
              style={submitStyle}
              title={i18n('ai_helper_student_send_shortcut')}
            >
              &#x27A4;
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
