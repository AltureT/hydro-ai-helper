/**
 * 对话详情弹窗组件
 * 支持在对话列表页面内快速查看对话详情，支持前后导航和键盘快捷键
 */

import React, { useState, useEffect, useCallback } from 'react';
import 'highlight.js/styles/github.css';
import { renderMarkdown } from '../utils/markdown';
import { buildApiUrl } from '../utils/domainUtils';
import { formatDateTime } from '../utils/formatDate';
import {
  COLORS, FONT_FAMILY, SPACING, RADIUS, SHADOWS,
  modalOverlayStyle, markdownTheme,
} from '../utils/styles';

interface Conversation {
  _id: string;
  userId: number;
  userName?: string;
  classId?: string;
  problemId: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  isEffective: boolean;
  tags: string[];
  teacherNote?: string;
  metadata?: {
    problemTitle?: string;
    problemContent?: string;
  };
}

interface Message {
  _id: string;
  role: 'student' | 'ai';
  content: string;
  timestamp: string;
  questionType?: string;
  attachedCode?: boolean;
  attachedError?: boolean;
  metadata?: {
    codeLength?: number;
    codeWarning?: string;
    codeContent?: string;
  };
}

interface ConversationDetailResponse {
  conversation: Conversation;
  messages: Message[];
}

const questionTypeBadgeMap: Record<string, { bg: string; color: string; label: string }> = {
  understand: { bg: '#dbeafe', color: '#1e40af', label: '理解题意' },
  think: { bg: '#f3e8ff', color: '#6b21a8', label: '理清思路' },
  debug: { bg: '#fee2e2', color: '#991b1b', label: '分析错误' },
};

function QuestionTypeBadge({ type }: { type: string }) {
  const info = questionTypeBadgeMap[type];
  if (!info) return null;
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: 600,
      backgroundColor: info.bg,
      color: info.color,
    }}>
      {info.label}
    </span>
  );
}

const MarkdownContent: React.FC<{ content: string }> = ({ content }) => {
  const safeHtml = renderMarkdown(content);
  return (
    <div
      className="markdown-body"
      style={{ lineHeight: '1.6', color: COLORS.textPrimary }}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
};

export interface ConversationDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string | null;
  conversationIds: string[];
  onNavigate: (id: string) => void;
}

export const ConversationDetailModal: React.FC<ConversationDetailModalProps> = ({
  isOpen,
  onClose,
  conversationId,
  conversationIds,
  onNavigate,
}) => {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentIndex = conversationId ? conversationIds.indexOf(conversationId) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < conversationIds.length - 1;

  const navigatePrev = useCallback(() => {
    if (hasPrev) onNavigate(conversationIds[currentIndex - 1]);
  }, [hasPrev, currentIndex, conversationIds, onNavigate]);

  const navigateNext = useCallback(() => {
    if (hasNext) onNavigate(conversationIds[currentIndex + 1]);
  }, [hasNext, currentIndex, conversationIds, onNavigate]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowLeft') { navigatePrev(); return; }
      if (e.key === 'ArrowRight') { navigateNext(); return; }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, navigatePrev, navigateNext]);

  useEffect(() => {
    if (!isOpen || !conversationId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch(buildApiUrl(`/ai-helper/conversations/${conversationId}`), {
          headers: { Accept: 'application/json' },
        });
        if (cancelled) return;
        if (!resp.ok) {
          setError(resp.status === 404 ? '对话不存在' : `加载失败：${resp.status}`);
          setConversation(null);
          setMessages([]);
          return;
        }
        const data: ConversationDetailResponse = await resp.json();
        if (cancelled) return;
        setConversation(data.conversation);
        setMessages(data.messages);
      } catch {
        if (!cancelled) {
          setError('加载失败：网络错误');
          setConversation(null);
          setMessages([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [isOpen, conversationId]);

  if (!isOpen) return null;

  const navBtnStyle = (disabled: boolean): React.CSSProperties => ({
    padding: '6px 14px',
    borderRadius: RADIUS.md,
    border: `1px solid ${COLORS.border}`,
    backgroundColor: disabled ? COLORS.bgDisabled : COLORS.bgCard,
    color: disabled ? COLORS.textDisabled : COLORS.textSecondary,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    fontFamily: FONT_FAMILY,
  });

  const firstStudentMsg = messages.find(m => m.role === 'student');
  const questionType = firstStudentMsg?.questionType;

  return (
    <div
      style={{ ...modalOverlayStyle, zIndex: 10300 }}
      onClick={onClose}
    >
      <div
        style={{
          width: '900px',
          maxWidth: '95vw',
          height: '85vh',
          backgroundColor: '#fff',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '16px 24px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
            {conversation && (
              <>
                <span style={{ fontWeight: 600, fontSize: '15px', color: COLORS.textPrimary }}>
                  {conversation.userName || `#${conversation.userId}`}
                </span>
                <span style={{ color: COLORS.textMuted, fontSize: '13px' }}>
                  {conversation.metadata?.problemTitle || conversation.problemId}
                </span>
                {questionType && <QuestionTypeBadge type={questionType} />}
                <span style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: conversation.isEffective ? COLORS.success : COLORS.error,
                  flexShrink: 0,
                }} title={conversation.isEffective ? '有效对话' : '无效对话'} />
              </>
            )}
            {!conversation && !loading && <span style={{ color: COLORS.textMuted }}>对话详情</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <button onClick={navigatePrev} disabled={!hasPrev} style={navBtnStyle(!hasPrev)}>
              ← 上一条
            </button>
            <button onClick={navigateNext} disabled={!hasNext} style={navBtnStyle(!hasNext)}>
              下一条 →
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '6px 10px',
                borderRadius: RADIUS.md,
                border: 'none',
                backgroundColor: 'transparent',
                color: COLORS.textMuted,
                cursor: 'pointer',
                fontSize: '18px',
                lineHeight: 1,
                fontFamily: FONT_FAMILY,
              }}
              title="关闭 (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Metadata bar */}
        {conversation && (
          <div style={{
            padding: '12px 24px',
            backgroundColor: '#f8fafc',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '20px',
            fontSize: '13px',
            color: '#64748b',
            borderBottom: '1px solid #e2e8f0',
          }}>
            <div><span style={{ color: COLORS.textMuted }}>班级 </span><span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>{conversation.classId || '-'}</span></div>
            <div><span style={{ color: COLORS.textMuted }}>消息数 </span><span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>{conversation.messageCount}</span></div>
            <div><span style={{ color: COLORS.textMuted }}>开始 </span><span style={{ color: COLORS.textPrimary }}>{formatDateTime(conversation.startTime)}</span></div>
            <div><span style={{ color: COLORS.textMuted }}>结束 </span><span style={{ color: COLORS.textPrimary }}>{formatDateTime(conversation.endTime)}</span></div>
          </div>
        )}

        {/* Message thread */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px', color: COLORS.textMuted }}>加载中...</div>
          )}
          {error && (
            <div style={{
              padding: '16px',
              backgroundColor: COLORS.errorBg,
              border: `1px solid ${COLORS.errorBorder}`,
              borderRadius: RADIUS.md,
              color: COLORS.errorText,
              fontSize: '14px',
            }}>
              {error}
            </div>
          )}
          {!loading && !error && messages.map((msg) => {
            const isStudent = msg.role === 'student';
            const hasCode = isStudent && msg.attachedCode && msg.metadata?.codeContent;
            return (
              <div key={msg._id} style={{ alignSelf: isStudent ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div style={{ marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: COLORS.textMuted, fontWeight: 500 }}>
                    {isStudent ? '学生' : 'AI 助手'}
                  </span>
                  {isStudent && msg.questionType && <QuestionTypeBadge type={msg.questionType} />}
                  {hasCode && (
                    <span style={{
                      padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 600,
                      backgroundColor: '#fef3c7', color: '#92400e',
                    }}>
                      附带代码
                    </span>
                  )}
                  <span style={{ fontSize: '11px', color: COLORS.textMuted }}>{formatDateTime(msg.timestamp)}</span>
                </div>
                <div style={{
                  backgroundColor: isStudent ? '#f1f5f9' : '#eff6ff',
                  border: isStudent ? 'none' : '1px solid #dbeafe',
                  color: '#1e293b',
                  borderRadius: '12px',
                  borderTopLeftRadius: isStudent ? '12px' : '2px',
                  borderTopRightRadius: isStudent ? '2px' : '12px',
                  padding: '12px 16px',
                }}>
                  {isStudent ? (
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: '14px', lineHeight: 1.6 }}>{msg.content}</div>
                  ) : (
                    <MarkdownContent content={msg.content} />
                  )}
                </div>
                {hasCode && (
                  <div style={{ marginTop: '6px' }}>
                    {msg.metadata?.codeWarning && (
                      <div style={{
                        padding: '6px 12px', marginBottom: '4px',
                        fontSize: '12px', color: '#92400e', backgroundColor: '#fffbeb',
                        borderRadius: `${RADIUS.md} ${RADIUS.md} 0 0`,
                        border: '1px solid #fde68a', borderBottom: 'none',
                      }}>
                        {msg.metadata.codeWarning}
                      </div>
                    )}
                    <MarkdownContent content={'```\n' + (msg.metadata?.codeContent || '') + '\n```'} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <style>{markdownTheme}</style>
      </div>
    </div>
  );
};

export default ConversationDetailModal;
