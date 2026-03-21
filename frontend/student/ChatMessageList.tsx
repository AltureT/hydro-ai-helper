import React from 'react';
import { renderMarkdown as renderMarkdownSafe, renderStreamingMarkdown } from '../utils/markdown';
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
  variant: 'embedded' | 'floating';
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
  onNewConversation, variant, children,
}) => {
  const isEmbedded = variant === 'embedded';

  const renderProblemInfoCard = () => {
    if (problemInfo) {
      return (
        <div style={{ flex: 1, background: '#f5f3ff', border: '1px solid #e0ddff', padding: '10px 12px', borderRadius: '8px' }}>
          <div style={{ fontSize: '12px', color: '#9333ea', marginBottom: '4px', fontWeight: '500' }}>
            题目 {problemInfo.problemId}
          </div>
          <div style={{
            fontWeight: '600', fontSize: '14px', color: '#5b21b6', lineHeight: '1.4',
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
          flex: 1, background: '#fef3c7', border: '1px solid #fbbf24',
          padding: '12px', borderRadius: '8px'
        }}>
          <div style={{ fontSize: '13px', color: '#92400e', marginBottom: '8px' }}>
            ⚠️ {isEmbedded ? '无法自动获取题目信息' : problemInfoError}
          </div>
          <input
            type="text"
            placeholder={isEmbedded ? '请手动输入题目标题' : '请输入题目标题(如: A+B Problem)'}
            value={manualTitle}
            onChange={(e) => onManualTitleChange(e.target.value)}
            style={{
              width: '100%', padding: '8px', border: '1px solid #fbbf24',
              borderRadius: isEmbedded ? '4px' : '6px', fontSize: '13px', boxSizing: 'border-box'
            }}
          />
        </div>
      );
    }
    return isEmbedded ? <div style={{ flex: 1 }} /> : null;
  };

  const renderEmbeddedMessage = (msg: Message, idx: number) => {
    const parsed = msg.role === 'ai' ? parseMessageContent(msg.content) : null;
    return (
      <div key={idx} style={{ display: 'flex', flexDirection: msg.role === 'student' ? 'row-reverse' : 'row', gap: '8px' }}>
        <div
          data-ai-message={msg.role === 'ai' ? 'true' : undefined}
          data-message-id={msg.role === 'ai' ? msg.id : undefined}
          style={{
            maxWidth: '85%', padding: '10px 14px',
            borderRadius: msg.role === 'student' ? '12px 12px 0 12px' : '12px 12px 12px 0',
            background: msg.role === 'student' ? '#6366f1' : '#f3f4f6',
            color: msg.role === 'student' ? 'white' : '#1f2937',
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

  const renderFloatingMessage = (msg: Message, idx: number) => {
    const parsed = msg.role === 'ai' ? parseMessageContent(msg.content) : null;
    return (
      <div
        key={idx}
        data-ai-message={msg.role === 'ai' ? 'true' : undefined}
        data-message-id={msg.role === 'ai' ? msg.id : undefined}
        onMouseUp={msg.role === 'ai' ? onTextSelection : undefined}
        style={{
          background: msg.role === 'student' ? '#dbeafe' : '#f0fdf4',
          border: `1px solid ${msg.role === 'student' ? '#93c5fd' : '#86efac'}`,
          padding: '12px', borderRadius: '10px', position: 'relative'
        }}
      >
        <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '6px', color: msg.role === 'student' ? '#1e40af' : '#15803d' }}>
          {msg.role === 'student' ? '💬 我' : '🤖 AI 导师'}
        </div>
        <div style={{ fontSize: '13px', color: msg.role === 'student' ? '#1e3a8a' : '#166534' }}>
          {msg.role === 'ai' && parsed ? (
            renderMarkdown(parsed.content)
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          )}
        </div>
        {msg.code && (
          <pre style={{
            background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px',
            borderRadius: '6px', marginTop: '8px', fontSize: '11px', overflow: 'auto',
            maxHeight: '100px', fontFamily: 'Consolas, Monaco, "Courier New", monospace'
          }}>
            <code>{msg.code.length > 300 ? msg.code.substring(0, 300) + '...' : msg.code}</code>
          </pre>
        )}
      </div>
    );
  };

  return (
    <div
      ref={chatContainerRef}
      onMouseUp={isEmbedded ? onTextSelection : undefined}
      style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
    >
      {/* Problem info + new conversation button */}
      {isEmbedded ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
          {renderProblemInfoCard()}
          {messages.length > 0 && (
            <button
              onClick={onNewConversation}
              style={{
                padding: '8px 12px', background: '#f3f4f6', border: '1px solid #e5e7eb',
                borderRadius: '6px', fontSize: '12px', color: '#4b5563', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', flexShrink: 0,
              }}
              title="开始新对话"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="#4b5563" />
              </svg>
              新对话
            </button>
          )}
        </div>
      ) : renderProblemInfoCard()}

      {/* Messages */}
      {messages.map((msg, idx) => (
        isEmbedded ? renderEmbeddedMessage(msg, idx) : renderFloatingMessage(msg, idx)
      ))}

      {/* Streaming output */}
      {isStreaming && streamingContent && (() => {
        const parsed = parseMessageContent(streamingContent);
        return isEmbedded ? (
          <div style={{ display: 'flex', flexDirection: 'row', gap: '8px' }}>
            <div style={{
              maxWidth: '85%', padding: '10px 14px', borderRadius: '12px 12px 12px 0',
              background: '#f3f4f6', color: '#1f2937', fontSize: '13px', lineHeight: '1.6'
            }}>
              <ThinkingBlock isStreaming={parsed.isThinkingStreaming} variant="embedded" />
              {(!parsed.isThinkingStreaming && parsed.content) && renderMarkdown(parsed.content, true)}
              {!parsed.isThinkingStreaming && (
                <span style={{
                  display: 'inline-block', width: '6px', height: '14px', background: '#6366f1',
                  marginLeft: '2px', animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom'
                }} />
              )}
            </div>
          </div>
        ) : (
          <div style={{
            background: '#f0fdf4', border: '1px solid #86efac', padding: '12px',
            borderRadius: '10px', position: 'relative'
          }}>
            <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '6px', color: '#15803d' }}>
              🤖 AI 导师
            </div>
            <div style={{ fontSize: '13px', color: '#166534' }}>
              <ThinkingBlock isStreaming={parsed.isThinkingStreaming} variant="floating" />
              {(!parsed.isThinkingStreaming && parsed.content) && renderMarkdown(parsed.content, true)}
              {!parsed.isThinkingStreaming && (
                <span style={{
                  display: 'inline-block', width: '6px', height: '14px', background: '#15803d',
                  marginLeft: '2px', animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom'
                }} />
              )}
            </div>
          </div>
        );
      })()}

      {/* Loading indicator */}
      {isLoading && !isStreaming && (
        isEmbedded ? (
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ padding: '10px 14px', borderRadius: '12px 12px 12px 0', background: '#f3f4f6', color: '#6b7280', fontSize: '13px' }}>
              <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>正在思考中...</span>
              <span style={{ color: '#9ca3af', fontSize: '11px', marginLeft: '8px' }}>点击取消按钮可中止</span>
            </div>
          </div>
        ) : (
          <div style={{
            background: '#f0fdf4', border: '1px solid #86efac', padding: '12px',
            borderRadius: '10px', color: '#15803d', fontSize: '13px'
          }}>
            🤖 AI 导师正在思考...
          </div>
        )
      )}

      {/* "I don't understand" popup */}
      {popupPosition && (
        isEmbedded ? (
          <div
            style={{
              position: 'fixed', left: popupPosition.x, top: popupPosition.y,
              transform: 'translateX(-50%)', zIndex: 10000,
              background: '#1f2937', color: 'white', padding: '6px 12px',
              borderRadius: '6px', fontSize: '12px', cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)', whiteSpace: 'nowrap'
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDontUnderstand}
          >
            ❓ 我不理解
          </div>
        ) : (
          <div style={{ position: 'fixed', top: popupPosition.y, left: popupPosition.x, transform: 'translateX(-50%)', zIndex: 2000 }}>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); onDontUnderstand(); }}
              style={{
                background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px',
                padding: '8px 14px', fontSize: '13px', fontWeight: '500', cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(0,0,0,0.25)', whiteSpace: 'nowrap'
              }}
            >
              ❓ 我不理解
            </button>
          </div>
        )
      )}

      {children}
    </div>
  );
};
