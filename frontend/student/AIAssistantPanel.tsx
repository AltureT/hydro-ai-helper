import React, { useEffect, useCallback } from 'react';
import 'highlight.js/styles/github.css';
import { useChatSession } from './hooks/useChatSession';
import { useFloatingPanel } from './hooks/useFloatingPanel';
import { useTextSelection } from './hooks/useTextSelection';
import { ChatMessageList } from './ChatMessageList';
import { ChatInput } from './ChatInput';

interface AIAssistantPanelProps {
  problemId: string;
  defaultExpanded?: boolean;
  onCollapse?: () => void;
  embedded?: boolean;
}

const markdownStyles = `
  .markdown-body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3,
  .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-weight: bold; margin-top: 16px; margin-bottom: 8px; }
  .markdown-body h1 { font-size: 18px; }
  .markdown-body h2 { font-size: 16px; }
  .markdown-body h3 { font-size: 15px; }
  .markdown-body ul, .markdown-body ol { padding-left: 20px; margin: 8px 0; }
  .markdown-body li { margin: 4px 0; }
  .markdown-body blockquote { padding: 0 1em; color: #6a737d; border-left: 4px solid #dfe2e5; margin: 8px 0; }
  .markdown-body a { color: #6366f1; text-decoration: underline; }
  .markdown-body pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; overflow-x: auto; margin: 8px 0; }
  .markdown-body pre code { font-family: 'Consolas', 'Monaco', 'Courier New', monospace; font-size: 13px; line-height: 1.6; background: transparent; border: none; padding: 0; }
  .markdown-body code { background: #f0f0f0; border: 1px solid #e0e0e0; border-radius: 3px; padding: 2px 6px; font-family: 'Consolas', 'Monaco', 'Courier New', monospace; font-size: 13px; }
  .markdown-body p { margin: 8px 0; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
`;

const ERROR_STYLE_MAP: Record<string, { bg: string; border: string; color: string; icon: string }> = {
  rate_limit: { bg: '#fffbeb', border: '#fde68a', color: '#92400e', icon: '⏳' },
  timeout:    { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', icon: '⏱️' },
  network:    { bg: '#f0fdf4', border: '#bbf7d0', color: '#166534', icon: '🔌' },
  auth:       { bg: '#fdf4ff', border: '#e9d5ff', color: '#6b21a8', icon: '🔑' },
};
const DEFAULT_ERROR_STYLE = { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', icon: '⚠️' };

export const AIAssistantPanel: React.FC<AIAssistantPanelProps> = ({
  problemId, defaultExpanded, onCollapse, embedded = false,
}) => {
  const floating = useFloatingPanel({ defaultExpanded, onCollapse });
  const chat = useChatSession({ problemId, isCollapsed: floating.isCollapsed });
  const { state, dispatch } = chat;

  const textSelection = useTextSelection({
    onClarify: useCallback((text: string, _sourceId: string) => {
      dispatch({ type: 'SET_QUESTION_TYPE', payload: 'clarify' });
      dispatch({ type: 'SET_USER_THINKING', payload: `我不太理解这部分："${text}"，能再解释一下吗？` });
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
    const s = ERROR_STYLE_MAP[state.errorCategory] || DEFAULT_ERROR_STYLE;
    return (
      <div style={{
        background: s.bg, border: `1px solid ${s.border}`,
        padding: compact ? '8px 12px' : '12px', borderRadius: compact ? '6px' : '8px',
        color: s.color, fontSize: compact ? '12px' : '13px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: compact ? '6px' : '8px',
        ...(compact ? { marginBottom: '10px' } : {}),
      }}>
        <span>{s.icon}{' '}{state.error}</span>
        {state.errorRetryable && (
          <button
            onClick={() => chat.handleSubmit()}
            style={{
              padding: compact ? '3px 10px' : '4px 12px',
              fontSize: compact ? '11px' : '12px', fontWeight: '500',
              background: 'white', border: '1px solid #d1d5db',
              borderRadius: compact ? '4px' : '6px',
              cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            重试
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
        backgroundColor: 'rgba(0, 0, 0, 0.5)', display: 'flex',
        justifyContent: 'center', alignItems: 'center', zIndex: 10001
      }}>
        <div style={{
          background: 'white', borderRadius: '12px', padding: '24px',
          maxWidth: '420px', width: '90%', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)'
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: '600', color: '#374151' }}>加载AC代码</h3>
          <p style={{ margin: '0 0 20px 0', fontSize: '14px', color: '#6b7280', lineHeight: '1.5' }}>
            是否将最近一次AC的代码加载到当前编辑器？
            <br /><span style={{ color: '#dc2626', fontSize: '13px' }}>注意：这将覆盖编辑器中的当前代码</span>
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => {
                dispatch({ type: 'SET_SHOW_LOAD_CODE_CONFIRM', payload: false });
                const scratchpadCode = chat.readFromScratchpad();
                if (scratchpadCode) dispatch({ type: 'SET_CODE', payload: scratchpadCode });
                dispatch({ type: 'SET_INCLUDE_CODE', payload: true });
              }}
              style={{
                padding: '10px 20px', border: '1px solid #d1d5db', borderRadius: '6px',
                background: 'white', color: '#374151', cursor: 'pointer', fontSize: '14px'
              }}
            >
              使用当前代码
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
                padding: '10px 20px', border: 'none', borderRadius: '6px',
                background: '#6366f1', color: 'white', cursor: 'pointer',
                fontSize: '14px', fontWeight: '500'
              }}
            >
              加载AC代码
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
    const restrictedContent = (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100%', padding: '32px',
        textAlign: 'center', background: '#ffffff'
      }}>
        <div style={{ fontSize: '40px', marginBottom: '16px' }}>🔒</div>
        <div style={{ fontSize: '16px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>AI 助手功能受限</div>
        <div style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.6' }}>
          比赛期间 AI 助手不可用，请独立完成作答。<br />比赛结束后可正常使用。
        </div>
      </div>
    );

    if (embedded) return restrictedContent;

    return (
      <div ref={floating.panelRef} style={floating.panelStyle} onClick={floating.isCollapsed && !floating.isMobile ? floating.toggleCollapse : undefined}>
        {floating.isMobile || !floating.isCollapsed ? (
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #e5e7eb', background: '#6b7280', color: 'white',
            borderRadius: floating.isMobile ? '0' : '12px 12px 0 0', fontWeight: '600', fontSize: '15px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none',
            height: floating.isMobile ? '56px' : '48px', boxSizing: 'border-box'
          }}>
            <span>🔒 AI 学习助手</span>
            <button onClick={floating.toggleCollapse} style={{
              background: 'transparent', border: 'none', color: 'white',
              fontSize: '18px', cursor: 'pointer', padding: '4px 8px', lineHeight: '1'
            }}>
              {floating.isCollapsed ? '▲' : '▼'}
            </button>
          </div>
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '28px', userSelect: 'none'
          }}>🔒</div>
        )}
        {!floating.isCollapsed && restrictedContent}
      </div>
    );
  }

  // Embedded mode
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#ffffff' }}>
        <style>{markdownStyles}</style>
        <ChatMessageList {...messageListProps} variant="embedded">
          {renderErrorBanner(false)}
          {state.conversationHistory.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '4px' }}>选择问题类型：</div>
              {chat.QUESTION_TYPES.map((type) => (
                <label
                  key={type.value}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                    background: state.questionType === type.value ? '#eef2ff' : '#f9fafb',
                    border: state.questionType === type.value ? '2px solid #6366f1' : '1px solid #e5e7eb',
                    borderRadius: '8px', cursor: 'pointer', fontSize: '13px', transition: 'all 0.2s'
                  }}
                >
                  <input
                    type="radio" name="questionType" value={type.value}
                    checked={state.questionType === type.value}
                    onChange={(e) => chat.handleQuestionTypeChange(e.target.value)}
                    style={{ accentColor: '#6366f1' }}
                  />
                  {type.label}
                </label>
              ))}
              {state.questionType === 'debug' && (
                <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>将自动附带最近一次评测结果</div>
              )}
            </div>
          )}
        </ChatMessageList>
        <ChatInput {...inputProps} variant="embedded" />
        {renderLoadCodeConfirmModal()}
      </div>
    );
  }

  // Floating mode
  return (
    <>
      <style>{markdownStyles}</style>
      <div
        ref={floating.panelRef}
        style={floating.panelStyle}
        onClick={floating.isCollapsed && !floating.isMobile ? floating.toggleCollapse : undefined}
      >
        {/* Title bar */}
        {floating.isMobile || !floating.isCollapsed ? (
          <div
            onMouseDown={floating.handleDragStart}
            style={{
              padding: '12px 16px', borderBottom: floating.isCollapsed ? 'none' : '1px solid #e5e7eb',
              background: '#6366f1', color: 'white',
              borderRadius: floating.isMobile ? '0' : '12px 12px 0 0',
              fontWeight: '600', fontSize: '15px',
              cursor: floating.isMobile ? 'default' : (floating.isDragging ? 'grabbing' : 'grab'),
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              userSelect: 'none', height: floating.isMobile ? '56px' : '48px', boxSizing: 'border-box'
            }}
          >
            <span>✨ AI 学习助手</span>
            <button
              onClick={floating.toggleCollapse}
              style={{
                background: 'transparent', border: 'none', color: 'white',
                fontSize: '18px', cursor: 'pointer', padding: '4px 8px', lineHeight: '1'
              }}
              title={floating.isCollapsed ? '展开面板' : '折叠面板'}
            >
              {floating.isCollapsed ? '▲' : '▼'}
            </button>
          </div>
        ) : (
          <div
            style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: '28px', userSelect: 'none', transition: 'transform 0.2s ease'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
            title="展开 AI 学习助手"
          >
            ✨
          </div>
        )}

        {/* Content area */}
        {!floating.isCollapsed && (
          <div style={{
            display: 'flex', flexDirection: 'column', flex: 1,
            background: '#ffffff', borderRadius: floating.isMobile ? '0' : '0 0 12px 12px', overflow: 'hidden'
          }}>
            <ChatMessageList {...messageListProps} variant="floating" />
            <ChatInput {...inputProps} variant="floating" errorBanner={renderErrorBanner(true)} />
          </div>
        )}

        {/* Resize handles */}
        {!floating.isMobile && !floating.isCollapsed && (
          <>
            <div
              onMouseDown={(e) => floating.handleResizeStart(e, 'width')}
              style={{
                position: 'absolute', top: '48px', left: '0', bottom: '32px',
                width: '8px', cursor: 'ew-resize', background: 'transparent',
                transition: 'background 0.2s ease', borderRadius: '12px 0 0 0'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.1)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title="拖拽调整面板宽度"
            >
              <div style={{
                position: 'absolute', top: '50%', left: '2px', transform: 'translateY(-50%)',
                width: '3px', height: '40px', borderRadius: '2px', background: '#d1d5db', pointerEvents: 'none'
              }} />
            </div>
            <div
              onMouseDown={(e) => floating.handleResizeStart(e, 'height')}
              style={{
                position: 'absolute', bottom: '0', left: '0', right: '0', height: '32px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'ns-resize', background: 'transparent',
                transition: 'background 0.2s ease', borderRadius: '0 0 12px 12px'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.05)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title="拖拽调整面板高度"
            >
              <div style={{
                width: '40px', height: '4px', borderRadius: '2px', background: '#d1d5db',
                position: 'relative', pointerEvents: 'none'
              }}>
                <div style={{ position: 'absolute', top: '-6px', left: '0', right: '0', height: '3px', borderRadius: '2px', background: '#d1d5db' }} />
                <div style={{ position: 'absolute', top: '6px', left: '0', right: '0', height: '3px', borderRadius: '2px', background: '#d1d5db' }} />
              </div>
            </div>
          </>
        )}

        {renderLoadCodeConfirmModal()}
      </div>
    </>
  );
};
