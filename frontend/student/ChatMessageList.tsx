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
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', background: 'rgba(248,250,252,0.8)', borderBottom: `1px solid ${COLORS.border}` }}>
          <span style={{ fontSize: '11px', fontWeight: 'bold', padding: '2px 6px', background: COLORS.primaryLight, color: COLORS.primary, borderRadius: '4px' }}>
            {problemInfo.problemId}
          </span>
          <span style={{ fontSize: '13px', color: COLORS.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
            {problemInfo.title}
          </span>
        </div>
      );
    }
    if (problemInfoError) {
      return (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', background: COLORS.warningBg, borderBottom: `1px solid ${COLORS.warningBorder}`
        }}>
          <span style={{ fontSize: '12px', color: COLORS.warningText, whiteSpace: 'nowrap' }}>⚠️ 无法获取题目</span>
          <input
            type="text"
            placeholder="请手动输入题目标题"
            value={manualTitle}
            onChange={(e) => onManualTitleChange(e.target.value)}
            style={{
              flex: 1, padding: SPACING.xs, border: `1px solid ${COLORS.warningBorder}`,
              borderRadius: RADIUS.sm, fontSize: '12px', boxSizing: 'border-box'
            }}
          />
        </div>
      );
    }
    return null;
  };

  const renderEmptyState = () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '40px 24px', textAlign: 'center' }}>
      <div style={{
        width: '72px', height: '72px', borderRadius: '50%',
        background: 'linear-gradient(135deg, #2563eb, #3b82f6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '36px', marginBottom: '24px',
        boxShadow: '0 8px 24px rgba(37, 99, 235, 0.2)',
        animation: 'float 3s ease-in-out infinite',
      }}>🤖</div>
      <div style={{ fontSize: '18px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '8px' }}>你好！我是 AI 学习助手</div>
      <div style={{ fontSize: '13px', color: COLORS.textSecondary, lineHeight: '1.8' }}>
        选择下方的问题类型，描述你的疑惑<br/>我来帮你理清思路
      </div>
    </div>
  );

  const renderMessage = (msg: Message, idx: number) => {
    const parsed = msg.role === 'ai' ? parseMessageContent(msg.content) : null;
    const isStudent = msg.role === 'student';
    return (
      <div key={idx} style={{ display: 'flex', flexDirection: isStudent ? 'row-reverse' : 'row', gap: SPACING.sm, alignItems: 'flex-start' }}>
        {/* Avatar indicator */}
        <div style={{
          width: '28px', height: '28px', borderRadius: RADIUS.full, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px',
          background: isStudent ? COLORS.primary : COLORS.primaryLight,
          color: isStudent ? '#ffffff' : COLORS.primary,
          border: isStudent ? 'none' : `1px solid ${COLORS.border}`,
        }}>
          {isStudent ? '\u{1F464}' : '\u{1F916}'}
        </div>
        <div style={{ maxWidth: '80%', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {/* Speaker label */}
          <div style={{ fontSize: '11px', color: COLORS.textMuted, textAlign: isStudent ? 'right' : 'left' }}>
            {isStudent ? '我' : 'AI 助手'}
          </div>
          {/* Bubble */}
          <div
            data-ai-message={msg.role === 'ai' ? 'true' : undefined}
            data-message-id={msg.role === 'ai' ? msg.id : undefined}
            style={{
              padding: `${SPACING.sm} ${SPACING.md}`,
              borderRadius: isStudent ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
              background: isStudent ? COLORS.primary : '#f0f7ff',
              color: isStudent ? '#ffffff' : COLORS.textPrimary,
              fontSize: '13px', lineHeight: '1.6',
              border: isStudent ? 'none' : '1px solid #dbeafe',
              boxShadow: SHADOWS.sm,
            }}
          >
            {msg.role === 'ai' && parsed ? (
              renderMarkdown(parsed.content)
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
            )}
          </div>
          {/* Attached code block for student messages */}
          {isStudent && msg.code && (
            <div style={{
              background: COLORS.bgPage, border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md, padding: SPACING.sm, fontSize: '12px',
              maxWidth: '100%', overflow: 'hidden',
            }}>
              <div style={{ fontSize: '11px', color: COLORS.textMuted, marginBottom: SPACING.xs, display: 'flex', alignItems: 'center', gap: SPACING.xs }}>
                📝 附带代码
              </div>
              <div className="markdown-body" dangerouslySetInnerHTML={{
                __html: renderMarkdownSafe(`\`\`\`\n${msg.code.length > 500 ? msg.code.substring(0, 500) + '\n// ... 代码已截断' : msg.code}\n\`\`\``).innerHTML
              }} />
            </div>
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
      {/* Problem info breadcrumb */}
      {renderProblemInfoCard()}

      {/* Empty state */}
      {messages.length === 0 && !isStreaming && !isLoading && renderEmptyState()}

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
