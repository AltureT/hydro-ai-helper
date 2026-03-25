import React from 'react';
import {
  COLORS, SPACING, RADIUS, TRANSITIONS, FONT_FAMILY,
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
        flex: 1, minHeight, maxHeight,
        resize: 'none' as const, boxSizing: 'border-box' as const,
      }}
      onFocus={(e) => {
        e.target.style.borderColor = COLORS.borderFocus;
        e.target.style.boxShadow = `0 0 0 3px ${COLORS.shadowFocus}`;
      }}
      onBlur={(e) => {
        e.target.style.borderColor = COLORS.border;
        e.target.style.boxShadow = 'none';
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSubmit(); }
      }}
    />
  );

  const disabledSubmit = isLoading || !canSubmit;
  const submitStyle: React.CSSProperties = disabledSubmit
    ? { ...getButtonStyle('secondary'), cursor: 'not-allowed', opacity: 0.6, whiteSpace: 'nowrap' }
    : { ...getButtonStyle('primary'), background: COLORS.gradient, whiteSpace: 'nowrap' };

  return (
    <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: `${SPACING.md} ${SPACING.base}`, background: COLORS.bgPage, flexShrink: 0 }}>
      {errorBanner}

      {isFirstConversation && (
        <div style={{ marginBottom: SPACING.sm }}>
          <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginBottom: SPACING.xs }}>选择问题类型：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.xs }}>
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
          {questionType === 'debug' && (
            <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: SPACING.xs }}>将自动附带最近一次评测结果</div>
          )}
        </div>
      )}

      {isFollowUp && (
        <div style={{ display: 'flex', gap: SPACING.sm, marginBottom: SPACING.sm }}>
          <button
            type="button" onClick={onRefreshCode}
            style={{
              ...getButtonStyle('secondary'),
              fontSize: '12px', padding: `${SPACING.xs} ${SPACING.md}`,
              display: 'flex', alignItems: 'center', gap: SPACING.xs,
            }}
          >
            &#128206; {includeCode ? '已附带代码' : '附带代码'}
          </button>
          <button
            type="button" onClick={onNewConversation}
            style={{
              ...getButtonStyle('ghost'),
              fontSize: '12px', padding: `${SPACING.xs} ${SPACING.md}`,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            &#128260; 新对话
          </button>
        </div>
      )}

      {isFollowUp && includeCode && code && (
        <div style={{
          background: COLORS.bgPage, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
          padding: SPACING.sm, marginBottom: SPACING.sm, fontSize: '11px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.xs }}>
            <span style={{ color: COLORS.textSecondary }}>&#128221; 已附带代码 ({code.length} 字符)</span>
            <button
              type="button" onClick={onCodeClear}
              style={{ background: 'none', border: 'none', color: COLORS.error, cursor: 'pointer', fontSize: '11px', padding: '2px 4px' }}
            >
              &#10005; 移除
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

      <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'flex-end' }}>
        {renderTextarea(isFirstConversation ? '80px' : '40px', '120px')}
        {isFirstConversation && renderIncludeCodeCheckbox('&#128206; 附带当前代码')}
        {isLoading ? (
          <button
            onClick={onCancel}
            style={{ ...getButtonStyle('danger'), whiteSpace: 'nowrap' }}
          >
            取消
          </button>
        ) : (
          <button
            onClick={onSubmit} disabled={disabledSubmit}
            style={submitStyle}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
};
