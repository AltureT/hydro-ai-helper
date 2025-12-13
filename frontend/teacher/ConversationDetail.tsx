/**
 * 教师端对话详情组件
 * 显示单个会话的完整对话内容,支持 Markdown 渲染 (只读)
 * 使用 HydroOJ 官方方案：POST /markdown + vjContentNew + Prism.js
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

// 声明 HydroOJ 前端全局 API
declare const vjContentNew: (container: HTMLElement) => void;

/**
 * 调用 HydroOJ 后端渲染 Markdown
 * @param markdown Markdown 文本
 * @returns 渲染后的 HTML
 */
async function renderMarkdownViaAPI(markdown: string): Promise<string> {
  try {
    const response = await fetch('/markdown', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: markdown }),
    });

    if (!response.ok) {
      console.error('[AI Helper] Markdown API failed:', response.status);
      // 降级处理：简单转义 HTML
      return escapeHtml(markdown);
    }

    const data = await response.json();
    return data.html || data.text || escapeHtml(markdown);
  } catch (err) {
    console.error('[AI Helper] Markdown render error:', err);
    return escapeHtml(markdown);
  }
}

/**
 * HTML 转义（降级方案）
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

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
 * 使用 HydroOJ 官方 /markdown API + vjContentNew 渲染 Markdown
 */
const MarkdownContent: React.FC<{ content: string; className?: string }> = ({ content, className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string>('');
  const [renderError, setRenderError] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      try {
        const renderedHtml = await renderMarkdownViaAPI(content);
        if (!cancelled) {
          setHtml(renderedHtml);
          setRenderError(false);
        }
      } catch (err) {
        console.error('[AI Helper] Markdown render failed:', err);
        if (!cancelled) {
          setHtml(escapeHtml(content));
          setRenderError(true);
        }
      }
    };

    render();
    return () => { cancelled = true; };
  }, [content]);

  // 当 HTML 更新后，调用 vjContentNew 激活 Prism.js 高亮
  useEffect(() => {
    if (html && containerRef.current) {
      try {
        if (typeof vjContentNew === 'function') {
          vjContentNew(containerRef.current);
        }
      } catch (err) {
        console.warn('[AI Helper] vjContentNew failed:', err);
      }
    }
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={`vjContentNew ${className || ''}`}
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

  /**
   * 加载对话详情
   */
  const loadConversationDetail = async () => {
    setLoading(true);
    setError(null);

    try {
      // 调用 API (显式设置 Accept 头以获取 JSON 数据)
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

  /**
   * 组件加载时获取数据
   */
  useEffect(() => {
    if (conversationId) {
      loadConversationDetail();
    }
  }, [conversationId]);

  /**
   * 格式化日期时间
   */
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

  /**
   * 获取问题类型的中文标签
   */
  const getQuestionTypeLabel = (type?: string): string => {
    const labels: Record<string, string> = {
      understand: '理解题意',
      think: '理清思路',
      debug: '分析错误',
      review: '检查代码'
    };
    return type ? labels[type] || type : '';
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      {/* 返回按钮 */}
      <a href="/ai-helper/conversations" style={{ color: '#6366f1', textDecoration: 'none', marginBottom: '20px', display: 'inline-block' }}>
        ← 返回对话列表
      </a>

      <h1>对话详情</h1>

      {/* 加载状态 */}
      {loading && <p>加载中...</p>}

      {/* 错误提示 */}
      {error && <p style={{ color: 'red' }}>错误: {error}</p>}

      {/* 对话元信息 */}
      {!loading && !error && conversation && (
        <>
          <div style={{ marginBottom: '30px', padding: '20px', backgroundColor: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
            <h2>会话信息</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
              <div>
                <strong>学生:</strong> {conversation.userName ? `${conversation.userName} (${conversation.userId})` : `#${conversation.userId}`}
              </div>
              <div>
                <strong>班级:</strong> {conversation.classId || '-'}
              </div>
              <div>
                <strong>题目:</strong> {conversation.metadata?.problemTitle || conversation.problemId}
              </div>
              <div>
                <strong>开始时间:</strong> {formatDateTime(conversation.startTime)}
              </div>
              <div>
                <strong>结束时间:</strong> {formatDateTime(conversation.endTime)}
              </div>
              <div>
                <strong>消息数:</strong> {conversation.messageCount}
              </div>
              <div>
                <strong>有效对话:</strong> {conversation.isEffective ? '✓ 是' : '✗ 否'}
              </div>
              {conversation.tags.length > 0 && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <strong>标签:</strong> {conversation.tags.join(', ')}
                </div>
              )}
              {conversation.teacherNote && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <strong>教师备注:</strong> {conversation.teacherNote}
                </div>
              )}
            </div>
          </div>

          {/* TODO(Phase4): 添加标签和备注编辑功能 */}

          {/* 对话消息列表 */}
          <h2>对话内容</h2>
          <div style={{ marginBottom: '20px' }}>
            {messages.map((msg, index) => (
              <div
                key={msg._id}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'student' ? 'flex-start' : 'flex-end',
                  marginBottom: '20px'
                }}
              >
                <div
                  style={{
                    maxWidth: '70%',
                    padding: '15px',
                    borderRadius: '12px',
                    backgroundColor: msg.role === 'student' ? '#e0f2fe' : '#f3f4f6',
                    border: msg.role === 'student' ? '1px solid #bae6fd' : '1px solid #e5e7eb'
                  }}
                >
                  {/* 消息头部 */}
                  <div style={{ marginBottom: '10px', fontSize: '14px', color: '#6b7280' }}>
                    <strong>{msg.role === 'student' ? '学生' : 'AI 助手'}</strong>
                    {msg.questionType && (
                      <span style={{ marginLeft: '10px', padding: '2px 8px', backgroundColor: '#6366f1', color: 'white', borderRadius: '4px', fontSize: '12px' }}>
                        {getQuestionTypeLabel(msg.questionType)}
                      </span>
                    )}
                    {msg.attachedCode && (
                      <span style={{ marginLeft: '10px', padding: '2px 8px', backgroundColor: '#8b5cf6', color: 'white', borderRadius: '4px', fontSize: '12px' }}>
                        附带代码
                      </span>
                    )}
                    <div style={{ marginTop: '5px', fontSize: '12px' }}>
                      {formatDateTime(msg.timestamp)}
                    </div>
                  </div>

                  {/* 消息内容 (Markdown 渲染) */}
                  <MarkdownContent content={msg.content} className="markdown-body" />

                  {/* 代码警告 */}
                  {msg.metadata?.codeWarning && (
                    <div style={{ marginTop: '10px', padding: '8px', backgroundColor: '#fef3c7', border: '1px solid #fbbf24', borderRadius: '4px', fontSize: '13px' }}>
                      ⚠️ {msg.metadata.codeWarning}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Markdown 样式补充 */}
          <style>{`
            .markdown-body pre {
              background-color: #f6f8fa;
              border: 1px solid #e1e4e8;
              border-radius: 6px;
              padding: 16px;
              overflow-x: auto;
              font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
              font-size: 13px;
              line-height: 1.6;
            }

            .markdown-body code {
              background-color: #f0f0f0;
              padding: 2px 6px;
              border-radius: 3px;
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
            }

            .markdown-body ul, .markdown-body ol {
              padding-left: 20px;
            }

            .markdown-body blockquote {
              border-left: 4px solid #dfe2e5;
              padding-left: 16px;
              color: #6b7280;
              background-color: #f9fafb;
              margin: 10px 0;
            }

            .markdown-body a {
              color: #6366f1;
              text-decoration: none;
            }

            .markdown-body a:hover {
              text-decoration: underline;
            }
          `}</style>
        </>
      )}
    </div>
  );
};

export default ConversationDetail;
