/**
 * 教师端对话详情组件
 * 显示单个会话的完整对话内容,支持 Markdown 渲染 (只读)
 * 现代简约风格设计
 */

import React, { useState, useEffect, useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';

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
 * 创建 Markdown 渲染器
 */
function createMarkdownRenderer(): MarkdownIt {
  return new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight: (str, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch (err) {
          console.error('[AI Helper] Highlight.js error:', err);
        }
      }
      return '';
    }
  });
}

/**
 * MarkdownContent 子组件
 */
const MarkdownContent: React.FC<{ content: string; className?: string }> = ({ content, className }) => {
  const md = useMemo(() => createMarkdownRenderer(), []);
  const html = useMemo(() => md.render(content), [md, content]);

  return (
    <div
      className={`markdown-body ${className || ''}`}
      style={{ lineHeight: '1.6', color: '#1f2937' }}
      dangerouslySetInnerHTML={{ __html: html }}
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
      const response = await fetch(`/ai-helper/conversations/${conversationId}`, {
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
          setError('对话不存在');
        } else {
          setError(`加载失败：${response.status}`);
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
      setError('加载失败：网络错误');
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
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const getQuestionTypeLabel = (type?: string): string => {
    const labels: Record<string, string> = {
      understand: '理解题意',
      think: '理清思路',
      debug: '分析错误'
    };
    return type ? labels[type] || type : '';
  };

  return (
    <div style={{
      padding: '32px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: '#f8fafc',
      minHeight: '100vh',
      maxWidth: '1200px',
      margin: '0 auto'
    }}>
      {/* 返回按钮 */}
      <a
        href="/ai-helper/conversations"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          color: '#6366f1',
          textDecoration: 'none',
          marginBottom: '24px',
          fontSize: '14px',
          fontWeight: 500,
          padding: '8px 16px',
          backgroundColor: '#eef2ff',
          borderRadius: '8px',
          transition: 'all 0.2s'
        }}
      >
        ← 返回对话列表
      </a>

      {/* 页面标题 */}
      <div style={{
        marginBottom: '32px',
        padding: '24px 32px',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        borderRadius: '16px',
        color: 'white',
        boxShadow: '0 4px 20px rgba(102, 126, 234, 0.3)'
      }}>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 700 }}>📝 对话详情</h1>
        <p style={{ margin: '8px 0 0', opacity: 0.9, fontSize: '15px' }}>查看完整的学生与 AI 对话内容</p>
      </div>

      {/* 加载状态 */}
      {loading && (
        <div style={{
          padding: '60px 20px',
          textAlign: 'center',
          color: '#6b7280',
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>⏳</div>
          <div style={{ fontSize: '15px' }}>加载中...</div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{
          padding: '16px 20px',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '12px',
          color: '#991b1b',
          marginBottom: '24px'
        }}>
          ⚠️ 错误: {error}
        </div>
      )}

      {/* 对话元信息 */}
      {!loading && !error && conversation && (
        <>
          <div style={{
            marginBottom: '32px',
            padding: '24px',
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            border: '1px solid #e5e7eb'
          }}>
            <h2 style={{ margin: '0 0 20px', fontSize: '18px', fontWeight: 600, color: '#1f2937' }}>会话信息</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
              <div style={{ padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>学生</div>
                <div style={{ fontSize: '15px', fontWeight: 500, color: '#1f2937' }}>
                  {conversation.userName ? `${conversation.userName} (${conversation.userId})` : `#${conversation.userId}`}
                </div>
              </div>
              <div style={{ padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>班级</div>
                <div style={{ fontSize: '15px', fontWeight: 500, color: '#1f2937' }}>{conversation.classId || '-'}</div>
              </div>
              <div style={{ padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>题目</div>
                <div style={{ fontSize: '15px', fontWeight: 500, color: '#1f2937' }}>
                  {conversation.metadata?.problemTitle || conversation.problemId}
                </div>
              </div>
              <div style={{ padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>消息数</div>
                <div style={{ fontSize: '15px', fontWeight: 500, color: '#1f2937' }}>{conversation.messageCount}</div>
              </div>
              <div style={{ padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>开始时间</div>
                <div style={{ fontSize: '14px', color: '#4b5563' }}>{formatDateTime(conversation.startTime)}</div>
              </div>
              <div style={{ padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>结束时间</div>
                <div style={{ fontSize: '14px', color: '#4b5563' }}>{formatDateTime(conversation.endTime)}</div>
              </div>
              <div style={{ padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>有效对话</div>
                <div>
                  <span style={{
                    display: 'inline-block',
                    padding: '4px 12px',
                    borderRadius: '20px',
                    fontSize: '13px',
                    fontWeight: 600,
                    backgroundColor: conversation.isEffective ? '#dcfce7' : '#fee2e2',
                    color: conversation.isEffective ? '#166534' : '#991b1b'
                  }}>
                    {conversation.isEffective ? '是' : '否'}
                  </span>
                </div>
              </div>
              {conversation.tags.length > 0 && (
                <div style={{ gridColumn: '1 / -1', padding: '12px 16px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                  <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>标签</div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {conversation.tags.map((tag, idx) => (
                      <span key={idx} style={{
                        padding: '4px 12px',
                        backgroundColor: '#eef2ff',
                        color: '#4f46e5',
                        borderRadius: '20px',
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
                <div style={{ gridColumn: '1 / -1', padding: '12px 16px', backgroundColor: '#fefce8', borderRadius: '8px', border: '1px solid #fef08a' }}>
                  <div style={{ fontSize: '12px', color: '#854d0e', marginBottom: '4px' }}>教师备注</div>
                  <div style={{ fontSize: '14px', color: '#713f12' }}>{conversation.teacherNote}</div>
                </div>
              )}
            </div>
          </div>

          {/* 对话消息列表 */}
          <div style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            border: '1px solid #e5e7eb',
            padding: '24px'
          }}>
            <h2 style={{ margin: '0 0 24px', fontSize: '18px', fontWeight: 600, color: '#1f2937' }}>对话内容</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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
                      padding: '16px 20px',
                      borderRadius: '16px',
                      backgroundColor: msg.role === 'student' ? '#e0f2fe' : '#f3f4f6',
                      border: msg.role === 'student' ? '1px solid #7dd3fc' : '1px solid #e5e7eb',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                    }}
                  >
                    {/* 消息头部 */}
                    <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{
                        fontWeight: 600,
                        fontSize: '14px',
                        color: msg.role === 'student' ? '#0369a1' : '#374151'
                      }}>
                        {msg.role === 'student' ? '👤 学生' : '🤖 AI 助手'}
                      </span>
                      {msg.questionType && (
                        <span style={{
                          padding: '3px 10px',
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          color: 'white',
                          borderRadius: '20px',
                          fontSize: '12px',
                          fontWeight: 500
                        }}>
                          {getQuestionTypeLabel(msg.questionType)}
                        </span>
                      )}
                      {msg.attachedCode && (
                        <span style={{
                          padding: '3px 10px',
                          backgroundColor: '#f3e8ff',
                          color: '#7c3aed',
                          borderRadius: '20px',
                          fontSize: '12px',
                          fontWeight: 500
                        }}>
                          📎 附带代码
                        </span>
                      )}
                      <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                        {formatDateTime(msg.timestamp)}
                      </span>
                    </div>

                    {/* 消息内容 */}
                    <MarkdownContent content={msg.content} className="markdown-body" />

                    {/* 代码警告 */}
                    {msg.metadata?.codeWarning && (
                      <div style={{
                        marginTop: '12px',
                        padding: '10px 14px',
                        backgroundColor: '#fef3c7',
                        border: '1px solid #fcd34d',
                        borderRadius: '8px',
                        fontSize: '13px',
                        color: '#92400e'
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
          <style>{`
            .markdown-body pre {
              background-color: #f8fafc;
              border: 1px solid #e2e8f0;
              border-radius: 8px;
              padding: 16px;
              overflow-x: auto;
              font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
              font-size: 13px;
              line-height: 1.6;
              margin: 12px 0;
            }

            .markdown-body code {
              background-color: #f1f5f9;
              padding: 2px 6px;
              border-radius: 4px;
              font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
              font-size: 13px;
            }

            .markdown-body pre code {
              background-color: transparent;
              padding: 0;
            }

            .markdown-body h1, .markdown-body h2, .markdown-body h3 {
              font-weight: 600;
              margin-top: 1em;
              margin-bottom: 0.5em;
              color: #1f2937;
            }

            .markdown-body h1 { font-size: 1.5em; }
            .markdown-body h2 { font-size: 1.25em; }
            .markdown-body h3 { font-size: 1.1em; }

            .markdown-body ul, .markdown-body ol {
              padding-left: 20px;
              margin: 8px 0;
            }

            .markdown-body li {
              margin: 4px 0;
            }

            .markdown-body blockquote {
              border-left: 4px solid #6366f1;
              padding-left: 16px;
              color: #6b7280;
              background-color: #f9fafb;
              margin: 12px 0;
              padding: 12px 16px;
              border-radius: 0 8px 8px 0;
            }

            .markdown-body a {
              color: #6366f1;
              text-decoration: none;
            }

            .markdown-body a:hover {
              text-decoration: underline;
            }

            .markdown-body p {
              margin: 8px 0;
            }

            .markdown-body strong {
              font-weight: 600;
              color: #1f2937;
            }
          `}</style>
        </>
      )}
    </div>
  );
};

export default ConversationDetail;
