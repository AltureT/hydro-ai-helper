import React, { useMemo } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { renderMarkdown as renderMarkdownSafe, renderStreamingMarkdown } from '../utils/markdown';
import { ZINDEX } from '../utils/styles';
import { ThinkingBlock } from './ThinkingBlock';
import { AIMark } from './icons';
import type { Message, ProblemInfo } from './types';

// ── 方案 A · 克制蓝 调色（局部常量，避免改动共享的 styles.ts）──────────────
const A = {
  border: '#eef1f5',
  problemBg: '#f7f9fc',
  pillBg: '#e7eeff',
  pillText: '#2563eb',
  textPrimary: '#1e2536',
  textSecondary: '#64748b',
  textMuted: '#94a3b8',
  textFaint: '#aab4c2',
  aiBubbleBg: '#f4f8ff',
  aiBubbleBorder: '#e2ecfb',
  userBubbleBg: '#2563eb',
  mono: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace",
};

interface ParsedContent {
  content: string;
  isThinkingStreaming: boolean;
}

function parseMessageContent(text: string): ParsedContent {
  const thinkStart = text.indexOf('<think>');
  if (thinkStart === -1) return { content: text, isThinkingStreaming: false };

  const thinkEnd = text.indexOf('</think>');
  if (thinkEnd === -1) {
    const content = text.substring(0, thinkStart);
    return { content, isThinkingStreaming: true };
  }

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
      style={{ fontSize: '13px', lineHeight: '1.7' }}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 16px', background: A.problemBg, borderBottom: `1px solid ${A.border}` }}>
          <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 7px', background: A.pillBg, color: A.pillText, borderRadius: '5px', fontFamily: A.mono, flexShrink: 0 }}>
            {problemInfo.problemId}
          </span>
          <span style={{ fontSize: '12.5px', color: A.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
            {problemInfo.title}
          </span>
        </div>
      );
    }
    if (problemInfoError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 16px', background: '#fffbeb', borderBottom: '1px solid #fde68a' }}>
          <span style={{ fontSize: '12px', color: '#92400e', whiteSpace: 'nowrap' }}>⚠ {i18n('ai_helper_student_cannot_get_problem')}</span>
          <input
            type="text"
            placeholder={i18n('ai_helper_student_manual_title_placeholder')}
            value={manualTitle}
            onChange={(e) => onManualTitleChange(e.target.value)}
            style={{ flex: 1, padding: '4px 8px', border: '1px solid #fde68a', borderRadius: '6px', fontSize: '12px', boxSizing: 'border-box' }}
          />
        </div>
      );
    }
    return null;
  };

  const renderEmptyState = () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '40px 24px', textAlign: 'center' }}>
      <div style={{
        width: '64px', height: '64px', borderRadius: '18px',
        background: 'linear-gradient(135deg, #2563eb, #5b8def)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: A.mono, fontSize: '24px', fontWeight: 700, color: '#fff',
        letterSpacing: '-1px', marginBottom: '18px',
        boxShadow: '0 8px 20px rgba(37, 99, 235, 0.25)',
      }}>AI</div>
      <div style={{ fontSize: '17px', fontWeight: 700, color: A.textPrimary, marginBottom: '6px' }}>{i18n('ai_helper_student_welcome_title')}</div>
      <div style={{ fontSize: '12.5px', color: A.textMuted, lineHeight: '1.7' }}>
        {i18n('ai_helper_student_welcome_desc_line1')}<br />{i18n('ai_helper_student_welcome_desc_line2')}
      </div>
    </div>
  );

  const renderMessage = (msg: Message, idx: number) => {
    const parsed = msg.role === 'ai' ? parseMessageContent(msg.content) : null;
    const isStudent = msg.role === 'student';
    return (
      <div key={idx} style={{ display: 'flex', flexDirection: isStudent ? 'row-reverse' : 'row', gap: '8px', alignItems: 'flex-start' }}>
        {/* Avatar */}
        {isStudent ? (
          <div style={{ width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600, background: A.userBubbleBg, color: '#fff' }}>
            {i18n('ai_helper_student_me')}
          </div>
        ) : (
          <AIMark size={28} radius={8} fontSize={10} />
        )}
        <div style={{ maxWidth: '82%', display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {/* Speaker label */}
          <div style={{ fontSize: '10.5px', color: A.textFaint, textAlign: isStudent ? 'right' : 'left' }}>
            {isStudent ? i18n('ai_helper_student_me') : i18n('ai_helper_student_ai_assistant')}
          </div>
          {/* Bubble */}
          <div
            data-ai-message={msg.role === 'ai' ? 'true' : undefined}
            data-message-id={msg.role === 'ai' ? msg.id : undefined}
            style={{
              padding: '10px 13px',
              borderRadius: isStudent ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
              background: isStudent ? A.userBubbleBg : A.aiBubbleBg,
              color: isStudent ? '#ffffff' : A.textPrimary,
              fontSize: '13px', lineHeight: '1.7',
              border: isStudent ? 'none' : `1px solid ${A.aiBubbleBorder}`,
            }}
          >
            {msg.role === 'ai' && parsed ? (
              renderMarkdown(parsed.content)
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
            )}
          </div>
          {/* Attached code (student) */}
          {isStudent && msg.code && (
            <div style={{ background: '#f8fafc', border: `1px solid ${A.border}`, borderRadius: '10px', padding: '8px', fontSize: '12px', maxWidth: '100%', overflow: 'hidden' }}>
              <div style={{ fontSize: '11px', color: A.textMuted, marginBottom: '4px' }}>📝 {i18n('ai_helper_student_attached_code')}</div>
              <div className="markdown-body" dangerouslySetInnerHTML={{
                __html: renderMarkdownSafe(`\`\`\`\n${msg.code.length > 500 ? msg.code.substring(0, 500) + `\n// ... ${i18n('ai_helper_student_code_truncated')}` : msg.code}\n\`\`\``),
              }} />
            </div>
          )}
        </div>
      </div>
    );
  };

  // Build the message nodes once per `messages` change. Selecting text only
  // updates popup state (popupPosition); without this memo the whole list
  // re-renders and React rewrites each .markdown-body's innerHTML, which
  // detaches the live selection's text node and collapses the highlight.
  // Stable element references make React bail out of these subtrees.
  const messageNodes = useMemo(
    () => messages.map((msg, idx) => renderMessage(msg, idx)),
    [messages],
  );

  return (
    <div
      ref={chatContainerRef}
      onMouseUp={onTextSelection}
      style={{ flex: 1, overflowY: 'auto', padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      {/* dot-pulse keyframes for streaming/loading */}
      <style>{`@keyframes dotpulse{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}`}</style>

      {/* Problem info breadcrumb (full-bleed: negate the body padding) */}
      <div style={{ margin: '-18px -16px 0' }}>{renderProblemInfoCard()}</div>

      {/* Empty state */}
      {messages.length === 0 && !isStreaming && !isLoading && renderEmptyState()}

      {/* Messages (memoized — see messageNodes above) */}
      {messageNodes}

      {/* Streaming output */}
      {isStreaming && streamingContent && (() => {
        const parsed = parseMessageContent(streamingContent);
        return (
          <div style={{ display: 'flex', flexDirection: 'row', gap: '8px', alignItems: 'flex-start' }}>
            <AIMark size={28} radius={8} fontSize={10} />
            <div style={{
              maxWidth: '82%', padding: '11px 14px', borderRadius: '14px 14px 14px 4px',
              background: A.aiBubbleBg, border: `1px solid ${A.aiBubbleBorder}`,
              color: A.textPrimary, fontSize: '13px', lineHeight: '1.7',
            }}>
              <ThinkingBlock isStreaming={parsed.isThinkingStreaming} />
              {(!parsed.isThinkingStreaming && parsed.content) && renderMarkdown(parsed.content, true)}
              {!parsed.isThinkingStreaming && (
                <span style={{
                  display: 'inline-block', width: '6px', height: '14px', background: A.pillText,
                  marginLeft: '2px', animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom',
                }} />
              )}
            </div>
          </div>
        );
      })()}

      {/* Loading (pre-stream) */}
      {isLoading && !isStreaming && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <AIMark size={28} radius={8} fontSize={10} />
          <div style={{ padding: '12px 14px', borderRadius: '14px 14px 14px 4px', background: A.aiBubbleBg, border: `1px solid ${A.aiBubbleBorder}`, color: A.textSecondary, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>{i18n('ai_helper_student_loading')}</span>
            <span style={{ display: 'inline-flex', gap: '3px' }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: A.pillText, animation: 'dotpulse 1.2s infinite' }} />
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: A.pillText, animation: 'dotpulse 1.2s infinite 0.2s' }} />
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: A.pillText, animation: 'dotpulse 1.2s infinite 0.4s' }} />
            </span>
          </div>
        </div>
      )}

      {/* "I don't understand" popup */}
      {popupPosition && (
        <div
          style={{
            position: 'fixed', left: popupPosition.x, top: popupPosition.y,
            transform: 'translateX(-50%)', zIndex: ZINDEX.dropdown,
            background: A.textPrimary, color: '#ffffff', padding: '6px 12px',
            borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,.18)', whiteSpace: 'nowrap',
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDontUnderstand}
        >
          ❓ {i18n('ai_helper_student_dont_understand')}
        </div>
      )}

      {children}
    </div>
  );
};
