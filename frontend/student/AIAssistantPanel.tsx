import React, { useEffect, useCallback } from 'react';
import 'highlight.js/styles/github.css';
import { useChatSession } from './hooks/useChatSession';
import { useTextSelection } from './hooks/useTextSelection';
import { ChatMessageList } from './ChatMessageList';
import { ChatInput } from './ChatInput';
import {
  markdownTheme, COLORS, getAlertStyle, getButtonStyle,
  keyframeStyles, FONT_FAMILY, SPACING, RADIUS, TRANSITIONS,
} from '../utils/styles';

interface AIAssistantPanelProps {
  problemId: string;
}

const RETRYABLE_CATEGORIES = new Set(['rate_limit', 'timeout', 'network']);

export const AIAssistantPanel: React.FC<AIAssistantPanelProps> = ({ problemId }) => {
  const chat = useChatSession({ problemId });
  const { state, dispatch } = chat;

  const textSelection = useTextSelection({
    onClarify: useCallback((text: string, _sourceId: string) => {
      dispatch({ type: 'SET_QUESTION_TYPE', payload: 'clarify' });
      dispatch({ type: 'SET_USER_THINKING', payload: `\u6211\u4e0d\u592a\u7406\u89e3\u8fd9\u90e8\u5206\uff1a\u201c${text}\u201d\uff0c\u80fd\u518d\u89e3\u91ca\u4e00\u4e0b\u5417\uff1f` });
    }, [dispatch]),
  });

  // Auto-submit for "I don't understand" feature
  useEffect(() => {
    if (textSelection.pendingAutoSubmit && state.questionType && state.userThinking.trim()) {
      textSelection.setPendingAutoSubmit(false);
      chat.handleSubmitRef.current({
        sourceAiMessageId: textSelection.selectedSourceAiMessageId,
        selectedText: textSelection.selectedText,
      });
    }
  }, [textSelection.pendingAutoSubmit, state.questionType, state.userThinking]);

  const renderErrorBanner = (compact: boolean) => {
    if (!state.error) return null;
    const isRetryable = state.errorRetryable && RETRYABLE_CATEGORIES.has(state.errorCategory || '');
    const alertStyle = isRetryable ? getAlertStyle('warning') : getAlertStyle('error');
    return (
      <div style={{
        ...alertStyle,
        padding: compact ? `${SPACING.sm} ${SPACING.md}` : alertStyle.padding,
        fontSize: compact ? '12px' : '13px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: compact ? '6px' : SPACING.sm,
        ...(compact ? { marginBottom: '10px' } : {}),
      }}>
        <span>{state.error}</span>
        {state.errorRetryable && (
          <button
            onClick={() => chat.handleSubmit()}
            style={{
              ...getButtonStyle('secondary'),
              padding: compact ? '3px 10px' : '4px 12px',
              fontSize: compact ? '11px' : '12px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            \u91cd\u8bd5
          </button>
        )}
      </div>
    );
  };

  const renderLoadCodeConfirmModal = () => {
    if (!state.showLoadCodeConfirm) return null;
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: COLORS.overlay, display: 'flex',
        justifyContent: 'center', alignItems: 'center', zIndex: 10001
      }}>
        <div style={{
          background: COLORS.bgCard, borderRadius: RADIUS.lg, padding: SPACING.lg,
          maxWidth: '420px', width: '90%', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)'
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: '600', color: COLORS.textPrimary }}>\u52a0\u8f7dAC\u4ee3\u7801</h3>
          <p style={{ margin: '0 0 20px 0', fontSize: '14px', color: COLORS.textSecondary, lineHeight: '1.5' }}>
            \u662f\u5426\u5c06\u6700\u8fd1\u4e00\u6b21AC\u7684\u4ee3\u7801\u52a0\u8f7d\u5230\u5f53\u524d\u7f16\u8f91\u5668\uff1f
            <br /><span style={{ color: COLORS.error, fontSize: '13px' }}>\u6ce8\u610f\uff1a\u8fd9\u5c06\u8986\u76d6\u7f16\u8f91\u5668\u4e2d\u7684\u5f53\u524d\u4ee3\u7801</span>
          </p>
          <div style={{ display: 'flex', gap: SPACING.md, justifyContent: 'flex-end' }}>
            <button
              onClick={() => {
                dispatch({ type: 'SET_SHOW_LOAD_CODE_CONFIRM', payload: false });
                const scratchpadCode = chat.readFromScratchpad();
                if (scratchpadCode) dispatch({ type: 'SET_CODE', payload: scratchpadCode });
                dispatch({ type: 'SET_INCLUDE_CODE', payload: true });
              }}
              style={{
                ...getButtonStyle('secondary'),
                padding: '10px 20px', fontSize: '14px',
              }}
            >
              \u4f7f\u7528\u5f53\u524d\u4ee3\u7801
            </button>
            <button
              onClick={() => {
                dispatch({ type: 'SET_SHOW_LOAD_CODE_CONFIRM', payload: false });
                if (state.acCode) {
                  dispatch({ type: 'SET_CODE', payload: state.acCode });
                  dispatch({ type: 'SET_INCLUDE_CODE', payload: true });
                  chat.writeToScratchpad(state.acCode);
                }
              }}
              style={{
                ...getButtonStyle('primary'),
                padding: '10px 20px', fontSize: '14px',
              }}
            >
              \u52a0\u8f7dAC\u4ee3\u7801
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Common props for sub-components
  const messageListProps = {
    messages: state.conversationHistory,
    streamingContent: state.streamingContent,
    isStreaming: state.isStreaming,
    isLoading: state.isLoading,
    chatContainerRef: chat.chatContainerRef,
    onTextSelection: textSelection.handleTextSelection,
    popupPosition: textSelection.popupPosition,
    onDontUnderstand: textSelection.handleDontUnderstand,
    problemInfo: state.problemInfo,
    problemInfoError: state.problemInfoError,
    manualTitle: state.manualTitle,
    onManualTitleChange: (v: string) => dispatch({ type: 'SET_MANUAL_TITLE', payload: v }),
    onNewConversation: chat.startNewConversation,
  };

  const inputProps = {
    userThinking: state.userThinking,
    onUserThinkingChange: (v: string) => dispatch({ type: 'SET_USER_THINKING', payload: v }),
    questionType: state.questionType,
    onQuestionTypeChange: chat.handleQuestionTypeChange,
    questionTypes: chat.QUESTION_TYPES,
    includeCode: state.includeCode,
    onIncludeCodeChange: (checked: boolean) => {
      dispatch({ type: 'SET_INCLUDE_CODE', payload: checked });
      if (checked && !state.code) {
        const scratchpadCode = chat.readFromScratchpad();
        if (scratchpadCode) dispatch({ type: 'SET_CODE', payload: scratchpadCode });
      }
    },
    code: state.code,
    onCodeClear: () => {
      dispatch({ type: 'SET_CODE', payload: '' });
      dispatch({ type: 'SET_INCLUDE_CODE', payload: false });
    },
    isLoading: state.isLoading,
    conversationHistoryLength: state.conversationHistory.length,
    onSubmit: () => chat.handleSubmit(),
    onCancel: chat.cancelRequest,
    onRefreshCode: chat.refreshCodeFromScratchpad,
    onNewConversation: chat.startNewConversation,
  };

  // Contest restricted UI
  if (state.isContestRestricted) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100%', padding: SPACING.xl,
        textAlign: 'center', background: COLORS.bgCard,
      }}>
        <div style={{ fontSize: '40px', marginBottom: SPACING.base }}>🔒</div>
        <div style={{ fontSize: '16px', fontWeight: '600', color: COLORS.textPrimary, marginBottom: SPACING.sm }}>AI \u52a9\u624b\u529f\u80fd\u53d7\u9650</div>
        <div style={{ fontSize: '13px', color: COLORS.textSecondary, lineHeight: '1.6' }}>
          \u6bd4\u8d5b\u671f\u95f4 AI \u52a9\u624b\u4e0d\u53ef\u7528\uff0c\u8bf7\u72ec\u7acb\u5b8c\u6210\u4f5c\u7b54\u3002<br />\u6bd4\u8d5b\u7ed3\u675f\u540e\u53ef\u6b63\u5e38\u4f7f\u7528\u3002
        </div>
      </div>
    );
  }

  // Embedded mode (always)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: COLORS.bgCard }}>
      <style>{markdownTheme}{keyframeStyles}</style>
      <ChatMessageList {...messageListProps}>
        {renderErrorBanner(false)}
        {state.conversationHistory.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
            <div style={{ fontSize: '13px', color: COLORS.textSecondary, marginBottom: SPACING.xs }}>\u9009\u62e9\u95ee\u9898\u7c7b\u578b\uff1a</div>
            {chat.QUESTION_TYPES.map((type) => (
              <label
                key={type.value}
                style={{
                  display: 'flex', alignItems: 'center', gap: SPACING.sm, padding: '10px 12px',
                  background: state.questionType === type.value ? COLORS.primaryLight : COLORS.bgPage,
                  border: state.questionType === type.value ? `2px solid ${COLORS.primary}` : `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.md, cursor: 'pointer', fontSize: '13px',
                  transition: `all ${TRANSITIONS.fast}`,
                }}
              >
                <input
                  type="radio" name="questionType" value={type.value}
                  checked={state.questionType === type.value}
                  onChange={(e) => chat.handleQuestionTypeChange(e.target.value)}
                  style={{ accentColor: COLORS.primary }}
                />
                {type.label}
              </label>
            ))}
            {state.questionType === 'debug' && (
              <div style={{ fontSize: '12px', color: COLORS.textMuted, marginTop: SPACING.xs }}>\u5c06\u81ea\u52a8\u9644\u5e26\u6700\u8fd1\u4e00\u6b21\u8bc4\u6d4b\u7ed3\u679c</div>
            )}
          </div>
        )}
      </ChatMessageList>
      <ChatInput {...inputProps} variant="embedded" />
      {renderLoadCodeConfirmModal()}
    </div>
  );
};
