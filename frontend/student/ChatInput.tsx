import React from 'react';
import {
  COLORS, SPACING, RADIUS, SHADOWS, TRANSITIONS, FONT_FAMILY,
  getButtonStyle, getPillStyle, getInputStyle,
} from '../utils/styles';

interface QuestionType {
  value: string;
  label: string;
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
      title={questionType === 'optimize' ? '代码优化必须附带代码' : undefined}
    >
      <input
        type="checkbox" checked={includeCode} disabled={questionType === 'optimize'}
        onChange={(e) => onIncludeCodeChange(e.target.checked)}
        style={{ marginRight: '6px', accentColor: COLORS.primary }}
      />
      {labelText}
      {questionType === 'optimize' && <span style={{ marginLeft: '4px', color: COLORS.warning, fontSize: '11px' }}>(必需)</span>}
      {includeCode && code && questionType !== 'optimize' && <span style={{ marginLeft: '4px', color: COLORS.success, fontSize: '11px' }}>&#10003;</span>}
    </label>
  );

  const renderTextarea = (minHeight: string, maxHeight: string) => (
    <textarea
      value={userThinking}
      onChange={(e) => onUserThinkingChange(e.target.value)}
      placeholder={isFirstConversation ? '描述你的问题或疑惑...' : '继续追问...'}
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
          <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginBottom: SPACING.xs }}>选择问题类型：</div>
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
                  {type.label.split(' - ')[0]}
                </label>
              );
            })}
          </div>
          {questionType && (() => {
            const selected = questionTypes.find(t => t.value === questionType);
            const desc = selected?.label.split(' - ')[1];
            return desc ? (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: SPACING.xs }}>
                {desc}
                {questionType === 'debug' && '，将自动附带最近一次评测结果'}
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
            📎 {includeCode ? '已附带代码' : '附带代码'}
          </button>
          <button
            type="button" onClick={onNewConversation}
            style={{
              ...getButtonStyle('ghost'),
              fontSize: '12px', padding: `${SPACING.xs} ${SPACING.md}`,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            🔄 新对话
          </button>
        </div>
      )}

      {isFollowUp && includeCode && code && (
        <div style={{
          background: COLORS.bgPage, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
          padding: SPACING.sm, margin: `${SPACING.sm} ${SPACING.base} 0`, fontSize: '11px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.xs }}>
            <span style={{ color: COLORS.textSecondary }}>📝 已附带代码 ({code.length} 字符)</span>
            <button
              type="button" onClick={onCodeClear}
              style={{ background: 'none', border: 'none', color: COLORS.error, cursor: 'pointer', fontSize: '11px', padding: '2px 4px' }}
            >
              ✕ 移除
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
          {isFirstConversation ? renderIncludeCodeCheckbox('📎 附带当前代码') : <div />}
          {isLoading ? (
            <button
              onClick={onCancel}
              style={{ ...getButtonStyle('danger'), whiteSpace: 'nowrap', borderRadius: RADIUS.full, padding: '6px 16px', fontSize: '13px' }}
            >
              取消
            </button>
          ) : (
            <button
              onClick={onSubmit} disabled={disabledSubmit}
              style={submitStyle}
              title="发送 (Ctrl+Enter)"
            >
              &#x27A4;
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
