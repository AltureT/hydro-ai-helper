import React from 'react';
import { i18n } from '../utils/i18n';
import { TypeIcon, SendIcon, AttachIcon, RefreshIcon, RemoveIcon } from './icons';

// ── 方案 A · 克制蓝 调色 ───────────────────────────────────────────────
const A = {
  border: '#eef1f5',
  cardBorder: '#e3e8ef',
  inputBg: '#f8fafc',
  primary: '#2563eb',
  gradient: 'linear-gradient(135deg, #2563eb, #5b8def)',
  textPrimary: '#1e2536',
  textSecondary: '#475569',
  textMuted: '#64748b',
  textFaint: '#94a3b8',
  placeholder: '#aab4c2',
  selBorder: '#2563eb',
  selBg: '#f3f7ff',
  idleBorder: '#eef1f5',
  idleBg: '#fafbfd',
  iconIdleBg: '#eef2f8',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  disabledBg: '#f1f5f9',
  disabledText: '#cbd5e1',
};

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

  // ── 问题类型卡片（2×2 网格，替换原 pill 行）─────────────────────────
  const renderTypeCard = (type: QuestionType) => {
    const isSelected = questionType === type.value;
    return (
      <label
        key={type.value}
        className="ai-type-card"
        style={{
          display: 'block', padding: '11px 12px', borderRadius: '12px', cursor: 'pointer',
          border: `1.5px solid ${isSelected ? A.selBorder : A.idleBorder}`,
          background: isSelected ? A.selBg : A.idleBg,
          transition: 'all 160ms cubic-bezier(.4,0,.2,1)', userSelect: 'none',
        }}
      >
        <input
          type="radio" name="questionType" value={type.value}
          checked={isSelected} onChange={(e) => onQuestionTypeChange(e.target.value)}
          style={{ display: 'none' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
          <div style={{
            width: '24px', height: '24px', borderRadius: '7px',
            background: isSelected ? A.primary : A.iconIdleBg,
            color: isSelected ? '#fff' : A.textMuted,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <TypeIcon type={type.value} size={14} />
          </div>
          <span style={{ fontSize: '13px', fontWeight: 600, color: A.textPrimary }}>{i18n(type.label)}</span>
        </div>
        {type.description && (
          <div style={{ fontSize: '11px', color: A.textMuted, lineHeight: 1.4 }}>{i18n(type.description)}</div>
        )}
      </label>
    );
  };

  const renderIncludeCodeCheckbox = (labelText: string) => (
    <label
      style={{
        display: 'flex', alignItems: 'center',
        cursor: questionType === 'optimize' ? 'not-allowed' : 'pointer',
        fontSize: '11.5px', color: questionType === 'optimize' ? A.disabledText : A.textMuted,
        whiteSpace: 'nowrap', alignSelf: 'center',
      }}
      title={questionType === 'optimize' ? i18n('ai_helper_student_optimize_code_required') : undefined}
    >
      <input
        type="checkbox" checked={includeCode} disabled={questionType === 'optimize'}
        onChange={(e) => onIncludeCodeChange(e.target.checked)}
        style={{ marginRight: '6px', accentColor: A.primary }}
      />
      {labelText}
      {questionType === 'optimize' && <span style={{ marginLeft: '4px', color: A.warning, fontSize: '11px' }}>({i18n('ai_helper_student_required')})</span>}
      {includeCode && code && questionType !== 'optimize' && <span style={{ marginLeft: '4px', color: A.success, fontSize: '11px' }}>&#10003;</span>}
    </label>
  );

  const renderTextarea = (minHeight: string, maxHeight: string) => (
    <textarea
      value={userThinking}
      onChange={(e) => onUserThinkingChange(e.target.value)}
      placeholder={isFirstConversation ? i18n('ai_helper_student_placeholder_first') : i18n('ai_helper_student_placeholder_followup')}
      style={{
        width: '100%', border: 'none', outline: 'none', boxShadow: 'none',
        background: 'transparent', color: A.textPrimary,
        fontSize: '12.5px', lineHeight: 1.6, fontFamily: 'inherit',
        flex: 1, minHeight, maxHeight, resize: 'none', boxSizing: 'border-box', padding: 0,
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSubmit(); }
      }}
    />
  );

  const disabledSubmit = isLoading || !canSubmit;
  const submitStyle: React.CSSProperties = {
    width: '32px', height: '32px', borderRadius: '50%',
    background: disabledSubmit ? A.disabledBg : A.gradient,
    color: disabledSubmit ? A.disabledText : '#ffffff',
    border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: disabledSubmit ? 'not-allowed' : 'pointer', transition: 'all 150ms ease',
    boxShadow: disabledSubmit ? 'none' : '0 2px 6px rgba(37, 99, 235, 0.3)',
    flexShrink: 0, padding: 0,
  };

  const pillButton: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px',
    color: A.textSecondary, padding: '5px 11px', border: `1px solid ${A.cardBorder}`,
    borderRadius: '999px', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
  };

  return (
    <div style={{ background: '#fff', flexShrink: 0 }}>
      <style>{`.ai-type-card:hover{border-color:#c5d4f5 !important}.ai-input-card:focus-within{border-color:#2563eb !important;box-shadow:0 0 0 3px rgba(37,99,235,.18)}`}</style>
      {errorBanner}

      {/* 问题类型卡片 — 首次对话 */}
      {isFirstConversation && (
        <div style={{ padding: '12px 16px 0' }}>
          <div style={{ fontSize: '12px', color: A.textFaint, marginBottom: '8px' }}>{i18n('ai_helper_student_select_type')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            {questionTypes.map(renderTypeCard)}
          </div>
          {questionType === 'debug' && (
            <div style={{ fontSize: '11.5px', color: A.textMuted, marginTop: '8px' }}>
              {i18n('ai_helper_student_debug_auto_attach')}
            </div>
          )}
        </div>
      )}

      {/* 追问操作 — 后续对话 */}
      {isFollowUp && (
        <div style={{ display: 'flex', gap: '8px', padding: '10px 16px 0' }}>
          <button type="button" onClick={onRefreshCode} style={pillButton}>
            <AttachIcon size={12} /> {includeCode ? i18n('ai_helper_student_code_attached') : i18n('ai_helper_student_attach_code')}
          </button>
          <button type="button" onClick={onNewConversation} style={pillButton}>
            <RefreshIcon size={12} /> {i18n('ai_helper_student_new_conversation')}
          </button>
        </div>
      )}

      {/* 已附带代码预览 */}
      {isFollowUp && includeCode && code && (
        <div style={{ background: A.inputBg, border: `1px solid ${A.cardBorder}`, borderRadius: '10px', padding: '8px', margin: '8px 16px 0', fontSize: '11px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ color: A.textMuted }}>📝 {i18n('ai_helper_student_code_attached')} ({code.length} {i18n('ai_helper_student_chars')})</span>
            <button type="button" onClick={onCodeClear} style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'none', border: 'none', color: A.error, cursor: 'pointer', fontSize: '11px', padding: '2px 4px', fontFamily: 'inherit' }}>
              <RemoveIcon size={11} /> {i18n('ai_helper_student_remove')}
            </button>
          </div>
          <pre style={{ margin: 0, fontFamily: 'Consolas, Monaco, "Courier New", monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: A.textPrimary, maxHeight: '60px', overflow: 'auto' }}>
            {code.length > 200 ? code.substring(0, 200) + '...' : code}
          </pre>
        </div>
      )}

      {/* 统一输入卡片 */}
      <div className="ai-input-card" style={{
        margin: '12px 16px', padding: '11px 12px', borderRadius: '16px',
        border: `1px solid ${A.cardBorder}`, background: A.inputBg,
        transition: 'all 200ms ease',
      }}>
        {renderTextarea(isFirstConversation ? '40px' : '24px', '120px')}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
          {isFirstConversation ? renderIncludeCodeCheckbox(i18n('ai_helper_student_attach_current_code')) : <div />}
          {isLoading ? (
            <button onClick={onCancel} style={{ background: A.error, color: '#fff', border: 'none', borderRadius: '999px', padding: '6px 16px', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
              {i18n('ai_helper_student_cancel')}
            </button>
          ) : (
            <button onClick={onSubmit} disabled={disabledSubmit} style={submitStyle} title={i18n('ai_helper_student_send_shortcut')}>
              <SendIcon size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
