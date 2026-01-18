/**
 * AI 聊天面板 - 嵌入式版本
 * 用于三列布局中的 AI 对话区域
 * 现代简约风格设计
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import { buildApiUrl } from '../utils/domainUtils';

/**
 * 问题类型选项
 */
const QUESTION_TYPES = [
  { value: 'understand', label: '理解题意', icon: '📖' },
  { value: 'think', label: '理清思路', icon: '💡' },
  { value: 'debug', label: '分析错误', icon: '🔧' }
];

interface AIChatPanelProps {
  problemId: string;
}

/**
 * 从 Scratchpad 读取代码
 */
const readFromScratchpad = (): string | null => {
  try {
    const monaco = (window as any).monaco;
    if (monaco?.editor?.getModels) {
      const models = monaco.editor.getModels();
      if (models && models.length > 0) {
        return models[0].getValue();
      }
    }
    return null;
  } catch (err) {
    console.error('[AI Helper] Failed to read from Scratchpad:', err);
    return null;
  }
};

export const AIChatPanel: React.FC<AIChatPanelProps> = ({ problemId }) => {
  // 业务状态
  const [questionType, setQuestionType] = useState<string>('');
  const [userThinking, setUserThinking] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [includeCode, setIncludeCode] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // 多轮对话状态
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<Array<{
    role: 'student' | 'ai';
    content: string;
    timestamp: Date;
    code?: string;
  }>>([]);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const aiResponseRef = useRef<HTMLDivElement>(null);

  // 选中答疑状态
  const [selectedText, setSelectedText] = useState<string>('');
  const [popupPosition, setPopupPosition] = useState<{x: number; y: number} | null>(null);
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState<boolean>(false);

  // Markdown 渲染器
  const md = useMemo(() => {
    return new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      highlight: (str, lang) => {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
          } catch (err) {
            console.error('Highlight.js error:', err);
          }
        }
        return '';
      }
    });
  }, []);

  // 从 localStorage 恢复 conversationId
  useEffect(() => {
    if (problemId) {
      try {
        const savedId = window.localStorage.getItem(`ai_conversation_${problemId}`);
        if (savedId) setConversationId(savedId);
      } catch (e) {
        // ignore
      }
    }
  }, [problemId]);

  // 当勾选附带代码时自动读取
  useEffect(() => {
    if (includeCode && !code) {
      const scratchpadCode = readFromScratchpad();
      if (scratchpadCode !== null) {
        setCode(scratchpadCode);
      }
    }
  }, [includeCode, code]);

  // 自动提交监听
  useEffect(() => {
    if (pendingAutoSubmit && questionType && userThinking.trim()) {
      setPendingAutoSubmit(false);
      handleSubmit();
    }
  }, [pendingAutoSubmit, questionType, userThinking]);

  const scrollToBottom = () => {
    setTimeout(() => {
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      }
    }, 100);
  };

  const handleSubmit = async () => {
    const effectiveQuestionType = questionType || (conversationHistory.length > 0 ? 'think' : '');
    if (!effectiveQuestionType) {
      setError('请选择问题类型');
      return;
    }

    if (conversationHistory.length > 0 && !userThinking.trim()) {
      setError('请输入追问内容');
      return;
    }

    if (includeCode && !code.trim()) {
      setError('请粘贴代码或关闭「附带代码」选项');
      return;
    }

    const studentMessage = {
      role: 'student' as const,
      content: userThinking || '（继续追问）',
      timestamp: new Date(),
      code: includeCode ? code : undefined
    };
    setConversationHistory(prev => [...prev, studentMessage]);
    scrollToBottom();

    setError('');
    setIsLoading(true);
    const savedUserThinking = userThinking;
    const savedCode = includeCode ? code : undefined;
    setUserThinking('');

    try {
      // 读取题目信息
      const titleElement = document.querySelector('.section__title');
      const problemTitle = titleElement?.textContent?.trim() || `题目 ${problemId}`;

      const descElement = document.querySelector('.section__body.typo[data-fragment-id="problem-description"]');
      const fullText = descElement?.textContent?.trim() || '';
      const problemContent = fullText.substring(0, 500) + (fullText.length > 500 ? '...' : '');

      const response = await fetch(buildApiUrl('/ai-helper/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problemId,
          problemTitle,
          problemContent,
          questionType: effectiveQuestionType,
          userThinking: savedUserThinking,
          includeCode,
          code: savedCode,
          conversationId
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '请求失败');
      }

      const data = await response.json();

      const aiMessage = {
        role: 'ai' as const,
        content: data.message.content,
        timestamp: new Date()
      };
      setConversationHistory(prev => [...prev, aiMessage]);
      scrollToBottom();

      if (data.conversationId) {
        setConversationId(data.conversationId);
        try {
          window.localStorage.setItem(`ai_conversation_${problemId}`, data.conversationId);
        } catch (e) {
          // ignore
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
      setUserThinking(savedUserThinking);
      setConversationHistory(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  const startNewConversation = () => {
    setQuestionType('');
    setUserThinking('');
    setCode('');
    setIncludeCode(false);
    setError('');
    setConversationId(null);
    setConversationHistory([]);
    try {
      window.localStorage.removeItem(`ai_conversation_${problemId}`);
    } catch (e) {
      // ignore
    }
  };

  const refreshCodeFromScratchpad = () => {
    const scratchpadCode = readFromScratchpad();
    if (scratchpadCode !== null) {
      setCode(scratchpadCode);
      setIncludeCode(true);
    } else {
      setError('无法读取代码');
    }
  };

  const handleTextSelection = () => {
    if (!aiResponseRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setPopupPosition(null);
      return;
    }
    const text = selection.toString().trim();
    if (text && aiResponseRef.current.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setSelectedText(text);
      setPopupPosition({ x: rect.left + rect.width / 2, y: rect.top - 40 });
    } else {
      setPopupPosition(null);
    }
  };

  const handleDontUnderstand = () => {
    const truncated = selectedText.length > 100 ? selectedText.substring(0, 100) + '...' : selectedText;
    setQuestionType('understand');
    setUserThinking(`我不太理解这部分："${truncated}"，能再解释一下吗？`);
    setPopupPosition(null);
    setPendingAutoSubmit(true);
  };

  const renderMarkdown = (text: string) => {
    const html = md.render(text);
    return (
      <div
        className="ai-markdown-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  };

  return (
    <>
      {/* 样式 */}
      <style>{`
        .ai-chat-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .ai-chat-header {
          padding: 12px 16px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          font-weight: 600;
          font-size: 14px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .ai-chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: #fafafa;
        }
        .ai-message {
          padding: 12px 14px;
          border-radius: 12px;
          font-size: 13px;
          line-height: 1.6;
        }
        .ai-message-student {
          background: #e0f2fe;
          border: 1px solid #7dd3fc;
          margin-left: 20px;
        }
        .ai-message-ai {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }
        .ai-message-header {
          font-weight: 600;
          font-size: 12px;
          margin-bottom: 6px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .ai-message-student .ai-message-header { color: #0369a1; }
        .ai-message-ai .ai-message-header { color: #059669; }
        .ai-input-area {
          border-top: 1px solid #e2e8f0;
          padding: 12px 16px;
          background: #ffffff;
        }
        .ai-question-types {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        .ai-question-type {
          padding: 6px 12px;
          border-radius: 20px;
          border: 1.5px solid #e2e8f0;
          background: #ffffff;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .ai-question-type:hover {
          border-color: #818cf8;
          background: #f5f3ff;
        }
        .ai-question-type.selected {
          border-color: #6366f1;
          background: #eef2ff;
          color: #4338ca;
        }
        .ai-input-row {
          display: flex;
          gap: 8px;
          align-items: flex-end;
        }
        .ai-textarea {
          flex: 1;
          min-height: 60px;
          max-height: 120px;
          padding: 10px 12px;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          font-size: 13px;
          line-height: 1.5;
          resize: none;
          outline: none;
          transition: border-color 0.2s;
        }
        .ai-textarea:focus {
          border-color: #6366f1;
        }
        .ai-send-btn {
          padding: 10px 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
        }
        .ai-send-btn:hover:not(:disabled) {
          opacity: 0.9;
        }
        .ai-send-btn:disabled {
          background: #d1d5db;
          cursor: not-allowed;
        }
        .ai-action-btns {
          display: flex;
          gap: 8px;
          margin-bottom: 10px;
        }
        .ai-action-btn {
          padding: 6px 12px;
          background: #f1f5f9;
          color: #475569;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 4px;
          transition: all 0.2s;
        }
        .ai-action-btn:hover {
          background: #e2e8f0;
        }
        .ai-checkbox-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #64748b;
          cursor: pointer;
          margin-top: 10px;
        }
        .ai-checkbox-label input {
          accent-color: #6366f1;
        }
        .ai-error {
          padding: 8px 12px;
          background: #fef2f2;
          color: #dc2626;
          border: 1px solid #fecaca;
          border-radius: 8px;
          font-size: 12px;
          margin-bottom: 10px;
        }
        .ai-loading {
          padding: 12px;
          background: #f0fdf4;
          border: 1px solid #86efac;
          border-radius: 10px;
          color: #15803d;
          font-size: 13px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .ai-loading-dot {
          width: 6px;
          height: 6px;
          background: #22c55e;
          border-radius: 50%;
          animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        .ai-markdown-content {
          font-size: 13px;
          line-height: 1.6;
        }
        .ai-markdown-content h1, .ai-markdown-content h2, .ai-markdown-content h3 {
          font-weight: 600;
          margin: 12px 0 8px;
        }
        .ai-markdown-content h1 { font-size: 16px; }
        .ai-markdown-content h2 { font-size: 15px; }
        .ai-markdown-content h3 { font-size: 14px; }
        .ai-markdown-content ul, .ai-markdown-content ol {
          padding-left: 20px;
          margin: 8px 0;
        }
        .ai-markdown-content pre {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 12px;
          overflow-x: auto;
          margin: 10px 0;
        }
        .ai-markdown-content code {
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 12px;
        }
        .ai-markdown-content pre code {
          background: none;
          padding: 0;
        }
        .ai-markdown-content code:not(pre code) {
          background: #f1f5f9;
          padding: 2px 6px;
          border-radius: 4px;
        }
        .ai-popup-btn {
          background: #ef4444;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 8px 14px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .ai-code-preview {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 8px;
          margin-bottom: 10px;
          font-size: 11px;
        }
      `}</style>

      <div className="ai-chat-panel">
        {/* 标题栏 */}
        <div className="ai-chat-header">
          <span>✨</span>
          AI 学习助手
          {conversationHistory.length > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: '12px', opacity: 0.8 }}>
              {conversationHistory.length} 条消息
            </span>
          )}
        </div>

        {/* 消息区域 */}
        <div className="ai-chat-messages" ref={chatContainerRef}>
          {/* 欢迎消息 */}
          {conversationHistory.length === 0 && (
            <div style={{
              textAlign: 'center',
              padding: '40px 20px',
              color: '#64748b'
            }}>
              <div style={{ fontSize: '40px', marginBottom: '16px' }}>👋</div>
              <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '8px' }}>
                你好！我是 AI 学习助手
              </div>
              <div style={{ fontSize: '13px', color: '#94a3b8' }}>
                选择问题类型，描述你的疑惑，我会帮助你理清思路
              </div>
            </div>
          )}

          {/* 对话历史 */}
          {conversationHistory.map((msg, idx) => (
            <div
              key={idx}
              className={`ai-message ai-message-${msg.role}`}
              ref={msg.role === 'ai' ? aiResponseRef : undefined}
              onMouseUp={msg.role === 'ai' ? handleTextSelection : undefined}
            >
              <div className="ai-message-header">
                {msg.role === 'student' ? '💬 我' : '🤖 AI 导师'}
              </div>
              <div>
                {msg.role === 'ai' ? renderMarkdown(msg.content) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                )}
              </div>
              {msg.code && (
                <pre style={{
                  background: '#f1f5f9',
                  padding: '8px',
                  borderRadius: '6px',
                  marginTop: '8px',
                  fontSize: '11px',
                  overflow: 'auto',
                  maxHeight: '80px'
                }}>
                  <code>{msg.code.length > 200 ? msg.code.substring(0, 200) + '...' : msg.code}</code>
                </pre>
              )}
            </div>
          ))}

          {/* 加载中 */}
          {isLoading && (
            <div className="ai-loading">
              <div className="ai-loading-dot" />
              <div className="ai-loading-dot" style={{ animationDelay: '0.2s' }} />
              <div className="ai-loading-dot" style={{ animationDelay: '0.4s' }} />
              <span>AI 导师正在思考...</span>
            </div>
          )}
        </div>

        {/* 选中文本弹窗 */}
        {popupPosition && (
          <div style={{
            position: 'fixed',
            top: popupPosition.y,
            left: popupPosition.x,
            transform: 'translateX(-50%)',
            zIndex: 2000
          }}>
            <button className="ai-popup-btn" onClick={handleDontUnderstand}>
              ❓ 我不理解
            </button>
          </div>
        )}

        {/* 输入区域 */}
        <div className="ai-input-area">
          {/* 错误提示 */}
          {error && (
            <div className="ai-error">⚠️ {error}</div>
          )}

          {/* 首次提问：问题类型 */}
          {conversationHistory.length === 0 && (
            <div className="ai-question-types">
              {QUESTION_TYPES.map(type => (
                <button
                  key={type.value}
                  className={`ai-question-type ${questionType === type.value ? 'selected' : ''}`}
                  onClick={() => setQuestionType(type.value)}
                >
                  <span>{type.icon}</span>
                  {type.label}
                </button>
              ))}
            </div>
          )}

          {/* 追问时：操作按钮 */}
          {conversationHistory.length > 0 && (
            <div className="ai-action-btns">
              <button className="ai-action-btn" onClick={refreshCodeFromScratchpad}>
                📎 {includeCode ? '已附带代码' : '附带代码'}
              </button>
              <button className="ai-action-btn" onClick={startNewConversation}>
                🔄 新对话
              </button>
            </div>
          )}

          {/* 代码预览 */}
          {conversationHistory.length > 0 && includeCode && code && (
            <div className="ai-code-preview">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ color: '#64748b' }}>📝 已附带代码 ({code.length} 字符)</span>
                <button
                  onClick={() => { setCode(''); setIncludeCode(false); }}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '11px' }}
                >
                  ✕ 移除
                </button>
              </div>
            </div>
          )}

          {/* 输入框 */}
          <div className="ai-input-row">
            <textarea
              className="ai-textarea"
              value={userThinking}
              onChange={(e) => setUserThinking(e.target.value)}
              placeholder={conversationHistory.length === 0 ? "描述你的问题或疑惑..." : "继续追问..."}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            <button
              className="ai-send-btn"
              onClick={handleSubmit}
              disabled={
                isLoading ||
                (conversationHistory.length === 0 && !questionType) ||
                (conversationHistory.length > 0 && !userThinking.trim())
              }
            >
              {isLoading ? '⏳' : '发送'}
            </button>
          </div>

          {/* 首次提问：附带代码选项 */}
          {conversationHistory.length === 0 && (
            <label className="ai-checkbox-label">
              <input
                type="checkbox"
                checked={includeCode}
                onChange={(e) => {
                  setIncludeCode(e.target.checked);
                  if (e.target.checked && !code) {
                    const scratchpadCode = readFromScratchpad();
                    if (scratchpadCode) setCode(scratchpadCode);
                  }
                }}
              />
              📎 附带当前代码
              {includeCode && code && (
                <span style={{ marginLeft: '8px', color: '#10b981' }}>
                  ✓ 已读取 {code.length} 字符
                </span>
              )}
            </label>
          )}
        </div>
      </div>
    </>
  );
};

export default AIChatPanel;
