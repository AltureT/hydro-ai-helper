import React, { useEffect, useCallback } from 'react';
import { i18n } from '@hydrooj/ui-default';
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
      dispatch({ type: 'SET_USER_THINKING', payload: i18n('ai_helper_student_clarify_template').replace('{text}', text) });
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
            {i18n('ai_helper_student_retry')}
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
          <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: '600', color: COLORS.textPrimary }}>{i18n('ai_helper_student_load_ac_code')}</h3>
          <p style={{ margin: '0 0 20px 0', fontSize: '14px', color: COLORS.textSecondary, lineHeight: '1.5' }}>
            {i18n('ai_helper_student_load_ac_confirm')}
            <br /><span style={{ color: COLORS.error, fontSize: '13px' }}>{i18n('ai_helper_student_load_ac_warning')}</span>
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
              {i18n('ai_helper_student_use_current_code')}
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
              {i18n('ai_helper_student_load_ac_code')}
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
        <div style={{ fontSize: '16px', fontWeight: '600', color: COLORS.textPrimary, marginBottom: SPACING.sm }}>{i18n('ai_helper_student_contest_title')}</div>
        <div style={{ fontSize: '13px', color: COLORS.textSecondary, lineHeight: '1.6' }}>
          {i18n('ai_helper_student_contest_desc_line1')}<br />{i18n('ai_helper_student_contest_desc_line2')}
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
      </ChatMessageList>
      <ChatInput {...inputProps} />
      {renderLoadCodeConfirmModal()}
    </div>
  );
};
