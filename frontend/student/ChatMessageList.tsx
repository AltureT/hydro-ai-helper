import React from 'react';
import { renderMarkdown as renderMarkdownSafe, renderStreamingMarkdown } from '../utils/markdown';
import { COLORS, SPACING, RADIUS, SHADOWS, ZINDEX, FONT_FAMILY } from '../utils/styles';
import { ThinkingBlock } from './ThinkingBlock';
import type { Message, ProblemInfo } from './types';

interface ParsedContent {
  content: string;
  isThinkingStreaming: boolean;
}

function parseMessageContent(text: string): ParsedContent {
  const thinkStart = text.indexOf('<think>');
  if (thinkStart === -1) return { content: text, isThinkingStreaming: false };

  const thinkEnd = text.indexOf('</think>');
  if (thinkEnd === -1) {
    // Think tag opened but not closed — still streaming thinking
    const content = text.substring(0, thinkStart);
    return { content, isThinkingStreaming: true };
  }

  // Strip the entire <think>...</think> block (content is just a placeholder)
  const content = text.substring(0, thinkStart) + text.substring(thinkEnd + 8);
  return { content: content.trim(), isThinkingStreaming: false };
}

interface ChatMessageListProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  isLoading: boolean;
  chatContainerRef: React.RefObject<HTMLDivElement>;
  onTextSelection: () => void;
  popupPosition: { x: number; y: number } | null;
  onDontUnderstand: () => void;
  problemInfo: ProblemInfo | null;
  problemInfoError: string;
  manualTitle: string;
  onManualTitleChange: (value: string) => void;
  onNewConversation: () => void;
  children?: React.ReactNode;
}

const renderMarkdown = (text: string, streaming?: boolean) => {
  const html = streaming ? renderStreamingMarkdown(text) : renderMarkdownSafe(text);
  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
      style={{ fontSize: '13px', lineHeight: '1.6' }}
    />
  );
};

export const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages, streamingContent, isStreaming, isLoading,
  chatContainerRef, onTextSelection, popupPosition, onDontUnderstand,
  problemInfo, problemInfoError, manualTitle, onManualTitleChange,
  onNewConversation, children,
}) => {
  const renderProblemInfoCard = () => {
    if (problemInfo) {
      return (
        <div style={{ flex: 1, background: COLORS.primaryLight, border: `1px solid ${COLORS.border}`, padding: '10px 12px', borderRadius: RADIUS.md }}>
          <div style={{ fontSize: '12px', color: COLORS.primary, marginBottom: SPACING.xs, fontWeight: '500' }}>
            题目 {problemInfo.problemId}
          </div>
          <div style={{
            fontWeight: '600', fontSize: '14px', color: COLORS.textPrimary, lineHeight: '1.4',
            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical'
          }}>
            {problemInfo.title}
          </div>
        </div>
      );
    }
    if (problemInfoError) {
      return (
        <div style={{
          flex: 1, background: COLORS.warningBg, border: `1px solid ${COLORS.warningBorder}`,
          padding: SPACING.md, borderRadius: RADIUS.md
        }}>
          <div style={{ fontSize: '13px', color: COLORS.warningText, marginBottom: SPACING.sm }}>
            ⚠️ 无法自动获取题目信息
          </div>
          <input
            type="text"
            placeholder="请手动输入题目标题"
            value={manualTitle}
            onChange={(e) => onManualTitleChange(e.target.value)}
            style={{
              width: '100%', padding: SPACING.sm, border: `1px solid ${COLORS.warningBorder}`,
              borderRadius: RADIUS.sm, fontSize: '13px', boxSizing: 'border-box'
            }}
          />
        </div>
      );
    }
    return <div style={{ flex: 1 }} />;
  };

  const renderMessage = (msg: Message, idx: number) => {
    const parsed = msg.role === 'ai' ? parseMessageContent(msg.content) : null;
    return (
      <div key={idx} style={{ display: 'flex', flexDirection: msg.role === 'student' ? 'row-reverse' : 'row', gap: SPACING.sm }}>
        <div
          data-ai-message={msg.role === 'ai' ? 'true' : undefined}
          data-message-id={msg.role === 'ai' ? msg.id : undefined}
          style={{
            maxWidth: '85%', padding: '10px 14px',
            borderRadius: msg.role === 'student' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
            background: msg.role === 'student' ? COLORS.primary : COLORS.primaryLight,
            color: msg.role === 'student' ? '#ffffff' : COLORS.textPrimary,
            fontSize: '13px', lineHeight: '1.6'
          }}
        >
          {msg.role === 'ai' && parsed ? (
            renderMarkdown(parsed.content)
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={chatContainerRef}
      onMouseUp={onTextSelection}
      style={{ flex: 1, overflowY: 'auto', padding: SPACING.base, display: 'flex', flexDirection: 'column', gap: SPACING.md }}
    >
      {/* Problem info + new conversation button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACING.sm }}>
        {renderProblemInfoCard()}
        {messages.length > 0 && (
          <button
            onClick={onNewConversation}
            style={{
              padding: `${SPACING.sm} ${SPACING.md}`, background: COLORS.bgHover, border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md, fontSize: '12px', color: COLORS.textSecondary, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: SPACING.xs, whiteSpace: 'nowrap', flexShrink: 0,
            }}
            title="开始新对话"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill={COLORS.textSecondary} />
            </svg>
            新对话
          </button>
        )}
      </div>

      {/* Messages */}
      {messages.map((msg, idx) => renderMessage(msg, idx))}

      {/* Streaming output */}
      {isStreaming && streamingContent && (() => {
        const parsed = parseMessageContent(streamingContent);
        return (
          <div style={{ display: 'flex', flexDirection: 'row', gap: SPACING.sm }}>
            <div style={{
              maxWidth: '85%', padding: '10px 14px', borderRadius: '12px 12px 12px 4px',
              background: COLORS.primaryLight, color: COLORS.textPrimary, fontSize: '13px', lineHeight: '1.6'
            }}>
              <ThinkingBlock isStreaming={parsed.isThinkingStreaming} />
              {(!parsed.isThinkingStreaming && parsed.content) && renderMarkdown(parsed.content, true)}
              {!parsed.isThinkingStreaming && (
                <span style={{
                  display: 'inline-block', width: '6px', height: '14px', background: COLORS.primary,
                  marginLeft: '2px', animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom'
                }} />
              )}
            </div>
          </div>
        );
      })()}

      {/* Loading indicator */}
      {isLoading && !isStreaming && (
        <div style={{ display: 'flex', gap: SPACING.sm }}>
          <div style={{ padding: '10px 14px', borderRadius: '12px 12px 12px 4px', background: COLORS.primaryLight, color: COLORS.textSecondary, fontSize: '13px' }}>
            <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>正在思考中...</span>
            <span style={{ color: COLORS.textMuted, fontSize: '11px', marginLeft: SPACING.sm }}>点击取消按钮可中止</span>
          </div>
        </div>
      )}

      {/* "I don't understand" popup */}
      {popupPosition && (
        <div
          style={{
            position: 'fixed', left: popupPosition.x, top: popupPosition.y,
            transform: 'translateX(-50%)', zIndex: ZINDEX.dropdown,
            background: COLORS.textPrimary, color: '#ffffff', padding: `6px ${SPACING.md}`,
            borderRadius: RADIUS.md, fontSize: '12px', cursor: 'pointer',
            boxShadow: SHADOWS.md, whiteSpace: 'nowrap'
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDontUnderstand}
        >
          ❓ 我不理解
        </div>
      )}

      {children}
    </div>
  );
};
