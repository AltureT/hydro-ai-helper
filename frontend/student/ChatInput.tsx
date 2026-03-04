import React from 'react';

interface QuestionType {
  value: string;
  label: string;
}

interface ChatInputProps {
  variant: 'embedded' | 'floating';
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
  variant, userThinking, onUserThinkingChange,
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
        fontSize: '12px', color: questionType === 'optimize' ? '#9ca3af' : '#6b7280',
        whiteSpace: 'nowrap', alignSelf: 'center'
      }}
      title={questionType === 'optimize' ? '代码优化必须附带代码' : undefined}
    >
      <input
        type="checkbox" checked={includeCode} disabled={questionType === 'optimize'}
        onChange={(e) => onIncludeCodeChange(e.target.checked)}
        style={{ marginRight: '6px', accentColor: '#7c3aed' }}
      />
      {labelText}
      {questionType === 'optimize' && <span style={{ marginLeft: '4px', color: '#f59e0b', fontSize: '11px' }}>(必需)</span>}
      {includeCode && code && questionType !== 'optimize' && <span style={{ marginLeft: '4px', color: '#10b981', fontSize: '11px' }}>✓</span>}
    </label>
  );

  const renderTextarea = (minHeight: string, maxHeight: string) => (
    <textarea
      value={userThinking}
      onChange={(e) => onUserThinkingChange(e.target.value)}
      placeholder={isFirstConversation ? "描述你的问题或疑惑..." : "继续追问..."}
      style={{
        flex: 1, minHeight, maxHeight, padding: '10px 12px',
        border: '1px solid #d4d4d8', borderRadius: '8px', fontSize: '13px',
        lineHeight: '1.5', resize: 'none', boxSizing: 'border-box', outline: 'none',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      }}
      onFocus={(e) => { e.target.style.borderColor = '#6366f1'; }}
      onBlur={(e) => { e.target.style.borderColor = '#d4d4d8'; }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSubmit(); }
      }}
    />
  );

  // Embedded variant: simple layout
  if (variant === 'embedded') {
    return (
      <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 16px', background: '#fafafa', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          {renderTextarea(isFirstConversation ? '60px' : '40px', '100px')}
          {isFirstConversation && renderIncludeCodeCheckbox('📎 附带代码')}
          <button
            onClick={onSubmit}
            disabled={isLoading || !canSubmit}
            style={{
              padding: '10px 16px',
              background: (isLoading || !canSubmit) ? '#d1d5db' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              color: 'white', border: 'none', borderRadius: '8px',
              fontSize: '14px', fontWeight: '600',
              cursor: (isLoading || !canSubmit) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap'
            }}
          >
            {isLoading ? '⏳' : '发送'}
          </button>
        </div>
      </div>
    );
  }

  // Floating variant
  return (
    <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 16px 40px 16px', background: '#fafafa' }}>
      {errorBanner}

      {/* Question type selector - first conversation */}
      {isFirstConversation && (
        <div style={{ marginBottom: '10px' }}>
          <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '6px' }}>选择问题类型：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {questionTypes.map(type => {
              const isSelected = questionType === type.value;
              return (
                <label
                  key={type.value}
                  style={{
                    display: 'inline-flex', alignItems: 'center', padding: '6px 10px',
                    borderRadius: '999px',
                    border: `1.5px solid ${isSelected ? '#7c3aed' : '#d1d5db'}`,
                    background: isSelected ? '#ede9fe' : '#ffffff',
                    color: isSelected ? '#5b21b6' : '#4b5563',
                    fontSize: '12px', fontWeight: isSelected ? '600' : '500',
                    cursor: 'pointer', transition: 'all 0.2s ease', userSelect: 'none'
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
            <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>将自动附带最近一次评测结果</div>
          )}
        </div>
      )}

      {/* Follow-up action buttons */}
      {isFollowUp && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <button
            type="button" onClick={onRefreshCode}
            style={{
              padding: '6px 12px', background: '#f3f4f6', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '12px',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
            }}
          >
            📎 {includeCode ? '已附带代码' : '附带代码'}
          </button>
          <button
            type="button" onClick={onNewConversation}
            style={{
              padding: '6px 12px', background: '#f3f4f6', color: '#6b7280',
              border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '12px', cursor: 'pointer'
            }}
          >
            🔄 新对话
          </button>
        </div>
      )}

      {/* Code preview (follow-up with attached code) */}
      {isFollowUp && includeCode && code && (
        <div style={{
          background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px',
          padding: '8px', marginBottom: '10px', fontSize: '11px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ color: '#6b7280' }}>📝 已附带代码 ({code.length} 字符)</span>
            <button
              type="button" onClick={onCodeClear}
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '11px', padding: '2px 4px' }}
            >
              ✕ 移除
            </button>
          </div>
          <pre style={{
            margin: 0, fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#374151', maxHeight: '60px', overflow: 'auto'
          }}>
            {code.length > 200 ? code.substring(0, 200) + '...' : code}
          </pre>
        </div>
      )}

      {/* Input row */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
        {renderTextarea(isFirstConversation ? '80px' : '40px', '120px')}
        {isFirstConversation && renderIncludeCodeCheckbox('📎 附带当前代码')}
        {isLoading ? (
          <button
            onClick={onCancel}
            style={{
              padding: '10px 16px', background: '#ef4444', color: 'white', border: 'none',
              borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap'
            }}
          >
            取消
          </button>
        ) : (
          <button
            onClick={onSubmit} disabled={!canSubmit}
            style={{
              padding: '10px 16px',
              background: !canSubmit ? '#d1d5db' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              color: 'white', border: 'none', borderRadius: '8px',
              fontSize: '14px', fontWeight: '600',
              cursor: !canSubmit ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap'
            }}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
};
