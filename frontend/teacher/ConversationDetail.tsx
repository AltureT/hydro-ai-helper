/**
 * 教师端对话详情组件
 * 显示单个会话的完整对话内容,支持 Markdown 渲染 (只读)
 */

import React, { useState, useEffect } from 'react';
import { i18n } from '@hydrooj/ui-default';
import 'highlight.js/styles/github.css';
import { renderMarkdown } from '../utils/markdown';
import { buildApiUrl, buildPageUrl } from '../utils/domainUtils';
import {
  COLORS, FONT_FAMILY, TYPOGRAPHY, SPACING, RADIUS, SHADOWS,
  cardStyle, getAlertStyle, markdownTheme,
} from '../utils/styles';

/**
 * 对话接口
 */
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

/**
 * 消息接口
 */
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
  };
}

/**
 * 对话详情响应接口
 */
interface ConversationDetailResponse {
  conversation: Conversation;
  messages: Message[];
}

/**
 * ConversationDetail 组件属性
 */
interface ConversationDetailProps {
  conversationId: string;
}

/**
 * MarkdownContent 子组件
 */
const MarkdownContent: React.FC<{ content: string; className?: string }> = ({ content, className }) => {
  const safeHtml = renderMarkdown(content);
  return (
    <div
      className={`markdown-body ${className || ''}`}
      style={{ lineHeight: '1.6', color: COLORS.textPrimary }}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
};

/**
 * ConversationDetail 组件
 */
export const ConversationDetail: React.FC<ConversationDetailProps> = ({ conversationId }) => {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadConversationDetail = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(buildApiUrl(`/ai-helper/conversations/${conversationId}`), {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[AI Helper] failed to load conversation detail', response.status, text);
        setConversation(null);
        setMessages([]);
        if (response.status === 404) {
          setError(i18n('ai_helper_teacher_conv_not_found'));
        } else {
          setError(`${i18n('ai_helper_teacher_load_failed')}${response.status}`);
        }
        return;
      }

      const data: ConversationDetailResponse = await response.json();

      console.debug('[AI Helper] conversation detail loaded', data);
      setConversation(data.conversation);
      setMessages(data.messages);
    } catch (err) {
      console.error('[AI Helper] error while loading conversation detail', err);
      setConversation(null);
      setMessages([]);
      setError(i18n('ai_helper_teacher_load_failed_network'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (conversationId) {
      loadConversationDetail();
    }
  }, [conversationId]);

  const formatDateTime = (isoString: string): string => {
    const date = new Date(isoString);
    const locale = (typeof window !== 'undefined' && (window as any).LOCALES?.__id) || 'zh';
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const getQuestionTypeLabel = (type?: string): string => {
    const labelKeys: Record<string, string> = {
      understand: 'ai_helper_teacher_qtype_understand',
      think: 'ai_helper_teacher_qtype_think',
      debug: 'ai_helper_teacher_qtype_debug'
    };
    return type ? (labelKeys[type] ? i18n(labelKeys[type]) : type) : '';
  };

  return (
    <div style={{
      padding: SPACING.xl,
      fontFamily: FONT_FAMILY,
      backgroundColor: COLORS.bgPage,
      minHeight: '100vh',
      maxWidth: '1200px',
      margin: '0 auto'
    }}>
      {/* 返回按钮 */}
      <a
        href={buildPageUrl('/ai-helper/conversations')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          color: COLORS.primary,
          textDecoration: 'none',
          marginBottom: SPACING.lg,
          fontSize: '14px',
          fontWeight: 500,
          padding: `${SPACING.sm} ${SPACING.base}`,
          backgroundColor: COLORS.primaryLight,
          borderRadius: RADIUS.md,
          transition: 'all 0.2s'
        }}
      >
        ← {i18n('ai_helper_teacher_conv_back_to_list')}
      </a>

      {/* 页面标题 */}
      <div style={{
        marginBottom: SPACING.xl,
        padding: `${SPACING.lg} ${SPACING.xl}`,
        background: COLORS.primaryLight,
        borderRadius: RADIUS.lg,
        borderLeft: `4px solid ${COLORS.primary}`,
      }}>
        <h1 style={{ margin: 0, ...TYPOGRAPHY.xl, color: COLORS.primary }}>{i18n('ai_helper_teacher_conv_detail_title')}</h1>
        <p style={{ margin: '8px 0 0', ...TYPOGRAPHY.sm, color: COLORS.textSecondary }}>{i18n('ai_helper_teacher_conv_detail_subtitle')}</p>
      </div>

      {/* 加载状态 */}
      {loading && (
        <div style={{
          padding: '60px 20px',
          textAlign: 'center',
          color: COLORS.textMuted,
          backgroundColor: COLORS.bgCard,
          borderRadius: RADIUS.lg,
          border: `1px solid ${COLORS.border}`
        }}>
          <div style={{ fontSize: '32px', marginBottom: SPACING.base }}>⏳</div>
          <div style={{ ...TYPOGRAPHY.sm }}>{i18n('ai_helper_teacher_loading')}</div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{
          ...getAlertStyle('error'),
          marginBottom: SPACING.lg,
          borderRadius: RADIUS.lg,
          borderLeft: 'none',
          border: `1px solid ${COLORS.errorBorder}`,
        }}>
          {error}
        </div>
      )}

      {/* 对话元信息 */}
      {!loading && !error && conversation && (
        <>
          <div style={{
            ...cardStyle,
            marginBottom: SPACING.xl,
          }}>
            <h2 style={{ margin: `0 0 ${SPACING.lg}`, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>{i18n('ai_helper_teacher_conv_session_info')}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SPACING.lg }}>
              <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_col_student')}</div>
                <div style={{ ...TYPOGRAPHY.sm, fontWeight: 500, color: COLORS.textPrimary }}>
                  {conversation.userName ? `${conversation.userName} (${conversation.userId})` : `#${conversation.userId}`}
                </div>
              </div>
              <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_col_class')}</div>
                <div style={{ ...TYPOGRAPHY.sm, fontWeight: 500, color: COLORS.textPrimary }}>{conversation.classId || '-'}</div>
              </div>
              <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_col_problem')}</div>
                <div style={{ ...TYPOGRAPHY.sm, fontWeight: 500, color: COLORS.textPrimary }}>
                  {conversation.metadata?.problemTitle || conversation.problemId}
                </div>
              </div>
              <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_col_messages')}</div>
                <div style={{ ...TYPOGRAPHY.sm, fontWeight: 500, color: COLORS.textPrimary }}>{conversation.messageCount}</div>
              </div>
              <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_col_start_time')}</div>
                <div style={{ fontSize: '14px', color: COLORS.textSecondary }}>{formatDateTime(conversation.startTime)}</div>
              </div>
              <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_end_time')}</div>
                <div style={{ fontSize: '14px', color: COLORS.textSecondary }}>{formatDateTime(conversation.endTime)}</div>
              </div>
              <div style={{ padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_effective_conv')}</div>
                <div>
                  <span style={{
                    display: 'inline-block',
                    padding: `${SPACING.xs} ${SPACING.md}`,
                    borderRadius: RADIUS.full,
                    fontSize: '13px',
                    fontWeight: 600,
                    backgroundColor: conversation.isEffective ? COLORS.successBg : COLORS.errorBg,
                    color: conversation.isEffective ? COLORS.successText : COLORS.errorText
                  }}>
                    {conversation.isEffective ? i18n('ai_helper_teacher_yes') : i18n('ai_helper_teacher_no')}
                  </span>
                </div>
              </div>
              {conversation.tags.length > 0 && (
                <div style={{ gridColumn: '1 / -1', padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md }}>
                  <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.sm }}>{i18n('ai_helper_teacher_conv_tags')}</div>
                  <div style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
                    {conversation.tags.map((tag, idx) => (
                      <span key={idx} style={{
                        padding: `${SPACING.xs} ${SPACING.md}`,
                        backgroundColor: COLORS.primaryLight,
                        color: COLORS.primary,
                        borderRadius: RADIUS.full,
                        fontSize: '13px',
                        fontWeight: 500
                      }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {conversation.teacherNote && (
                <div style={{ gridColumn: '1 / -1', padding: `${SPACING.md} ${SPACING.base}`, backgroundColor: COLORS.warningBg, borderRadius: RADIUS.md, border: `1px solid ${COLORS.warningBorder}` }}>
                  <div style={{ ...TYPOGRAPHY.xs, color: COLORS.warningText, marginBottom: SPACING.xs }}>{i18n('ai_helper_teacher_conv_teacher_note')}</div>
                  <div style={{ fontSize: '14px', color: COLORS.warningText }}>{conversation.teacherNote}</div>
                </div>
              )}
            </div>
          </div>

          {/* 对话消息列表 */}
          <div style={{
            ...cardStyle,
          }}>
            <h2 style={{ margin: `0 0 ${SPACING.lg}`, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>{i18n('ai_helper_teacher_conv_content')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.lg }}>
              {messages.map((msg) => (
                <div
                  key={msg._id}
                  style={{
                    display: 'flex',
                    justifyContent: msg.role === 'student' ? 'flex-start' : 'flex-end'
                  }}
                >
                  <div
                    style={{
                      maxWidth: '75%',
                      padding: `${SPACING.base} ${SPACING.lg}`,
                      borderRadius: RADIUS.xl,
                      backgroundColor: msg.role === 'student' ? COLORS.primaryLight : COLORS.bgHover,
                      border: `1px solid ${msg.role === 'student' ? COLORS.infoBorder : COLORS.border}`,
                      boxShadow: SHADOWS.sm
                    }}
                  >
                    {/* 消息头部 */}
                    <div style={{ marginBottom: SPACING.md, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{
                        fontWeight: 600,
                        fontSize: '14px',
                        color: msg.role === 'student' ? COLORS.infoText : COLORS.textSecondary
                      }}>
                        {msg.role === 'student' ? i18n('ai_helper_teacher_role_student') : i18n('ai_helper_teacher_role_ai')}
                      </span>
                      {msg.questionType && (
                        <span style={{
                          padding: `3px 10px`,
                          background: COLORS.gradient,
                          color: 'white',
                          borderRadius: RADIUS.full,
                          fontSize: '12px',
                          fontWeight: 500
                        }}>
                          {getQuestionTypeLabel(msg.questionType)}
                        </span>
                      )}
                      {msg.attachedCode && (
                        <span style={{
                          padding: `3px 10px`,
                          backgroundColor: COLORS.infoBg,
                          color: COLORS.info,
                          borderRadius: RADIUS.full,
                          fontSize: '12px',
                          fontWeight: 500
                        }}>
                          {i18n('ai_helper_teacher_conv_attached_code')}
                        </span>
                      )}
                      <span style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted }}>
                        {formatDateTime(msg.timestamp)}
                      </span>
                    </div>

                    {/* 消息内容 */}
                    <MarkdownContent content={msg.content} className="markdown-body" />

                    {/* 附带代码内容 */}
                    {msg.attachedCode && msg.metadata?.codeContent && (
                      <div style={{
                        marginTop: SPACING.md,
                        background: COLORS.bgPage,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: RADIUS.md,
                        padding: SPACING.md,
                        fontSize: '12px',
                      }}>
                        <div style={{ fontSize: '11px', color: COLORS.textMuted, marginBottom: SPACING.sm }}>&#128221; {i18n('ai_helper_teacher_conv_student_code')}</div>
                        <MarkdownContent content={`\`\`\`\n${msg.metadata.codeContent}\n\`\`\``} className="markdown-body" />
                      </div>
                    )}

                    {/* 代码警告 */}
                    {msg.metadata?.codeWarning && (
                      <div style={{
                        marginTop: SPACING.md,
                        padding: `10px 14px`,
                        backgroundColor: COLORS.warningBg,
                        border: `1px solid ${COLORS.warningBorder}`,
                        borderRadius: RADIUS.md,
                        fontSize: '13px',
                        color: COLORS.warningText
                      }}>
                        ⚠️ {msg.metadata.codeWarning}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Markdown 样式 */}
          <style>{markdownTheme}</style>
        </>
      )}
    </div>
  );
};

export default ConversationDetail;
