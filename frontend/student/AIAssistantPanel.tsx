/**
 * AI 学习助手面板 - 学生端
 * 在题目详情页显示的对话界面
 */

import React, { useState, useEffect, useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';

/**
 * 问题类型选项
 */
const QUESTION_TYPES = [
  { value: 'understand', label: '理解题意 - 我对题目要求不太清楚' },
  { value: 'think', label: '理清思路 - 我需要帮助梳理解题思路' },
  { value: 'debug', label: '分析错误 - 我的代码有问题,需要找出原因' },
  { value: 'review', label: '检查代码思路 - 请帮我检查思路是否正确' }
];

/**
 * 题目信息接口
 */
interface ProblemInfo {
  title: string;
  problemId: string;
  content: string;
}

/**
 * AI 助手面板组件
 */
export const AIAssistantPanel: React.FC<{ problemId: string }> = ({ problemId }) => {
  const [questionType, setQuestionType] = useState<string>('');
  const [userThinking, setUserThinking] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [includeCode, setIncludeCode] = useState<boolean>(false);
  const [aiResponse, setAiResponse] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // 题目信息自动读取相关状态
  const [problemInfo, setProblemInfo] = useState<ProblemInfo | null>(null);
  const [problemInfoError, setProblemInfoError] = useState<string>('');
  const [manualTitle, setManualTitle] = useState<string>('');

  /**
   * 初始化 Markdown 渲染器
   */
  const md = useMemo(() => {
    return new MarkdownIt({
      html: false, // 禁用 HTML 标签(安全考虑)
      linkify: true, // 自动将 URL 转为链接
      typographer: true, // 启用排版优化
      highlight: (str, lang) => {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
          } catch (err) {
            console.error('Highlight.js error:', err);
          }
        }
        return ''; // 使用默认转义
      }
    });
  }, []);

  /**
   * 自动读取题目信息
   */
  useEffect(() => {
    try {
      // 读取题目标题
      const titleElement = document.querySelector('.section__title');
      const title = titleElement?.textContent?.trim() || '';

      // 从 URL 提取题目编号
      const match = window.location.pathname.match(/\/p\/([A-Z0-9]+)/i);
      const problemIdFromUrl = match ? match[1] : problemId;

      // 读取题目描述摘要
      const descElement = document.querySelector('.section__body.typo[data-fragment-id="problem-description"]');
      const fullText = descElement?.textContent?.trim() || '';
      const content = fullText.substring(0, 500) + (fullText.length > 500 ? '...' : '');

      // 检查是否成功读取
      if (title && content) {
        setProblemInfo({
          title,
          problemId: problemIdFromUrl,
          content
        });
        setProblemInfoError('');
      } else {
        setProblemInfoError('无法自动读取题目信息,请手动输入题目标题');
      }
    } catch (err) {
      console.error('[AI Helper] 读取题目信息失败:', err);
      setProblemInfoError('读取题目信息失败,请手动输入');
    }
  }, [problemId]);

  /**
   * 提交问题到后端
   */
  const handleSubmit = async () => {
    // 验证输入
    if (!questionType) {
      setError('请选择问题类型');
      return;
    }

    if (!userThinking || userThinking.trim().length < 20) {
      setError('请详细描述你的思路(至少 20 字)');
      return;
    }

    // 验证代码附带逻辑
    if (includeCode && !code.trim()) {
      setError('⚠️ 请粘贴代码或关闭「附带代码」选项');
      return;
    }

    setError('');
    setIsLoading(true);

    try {
      // 准备题目信息
      const finalProblemTitle = problemInfo?.title || manualTitle || undefined;
      const finalProblemContent = problemInfo?.content || undefined;

      // 调用后端 API
      const response = await fetch('/ai-helper/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          problemId,
          problemTitle: finalProblemTitle,
          problemContent: finalProblemContent,
          questionType,
          userThinking,
          includeCode,
          code: includeCode ? code : undefined
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '请求失败');
      }

      const data = await response.json();
      setAiResponse(data.message.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
      console.error('[AI Helper] 提交失败:', err);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 重置表单
   */
  const handleReset = () => {
    setQuestionType('');
    setUserThinking('');
    setCode('');
    setIncludeCode(false);
    setAiResponse('');
    setError('');
  };

  /**
   * 渲染 Markdown 内容
   * 使用 markdown-it + highlight.js
   */
  const renderMarkdown = (text: string) => {
    const html = md.render(text);
    return (
      <div
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
        style={{
          fontSize: '13px',
          lineHeight: '1.6'
        }}
      />
    );
  };

  return (
    <>
      {/* Markdown 样式 */}
      <style>{`
        .markdown-body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .markdown-body h1, .markdown-body h2, .markdown-body h3,
        .markdown-body h4, .markdown-body h5, .markdown-body h6 {
          font-weight: bold;
          margin-top: 16px;
          margin-bottom: 8px;
        }
        .markdown-body h1 { font-size: 18px; }
        .markdown-body h2 { font-size: 16px; }
        .markdown-body h3 { font-size: 15px; }
        .markdown-body ul, .markdown-body ol {
          padding-left: 20px;
          margin: 8px 0;
        }
        .markdown-body li {
          margin: 4px 0;
        }
        .markdown-body blockquote {
          padding: 0 1em;
          color: #6a737d;
          border-left: 4px solid #dfe2e5;
          margin: 8px 0;
        }
        .markdown-body a {
          color: #6366f1;
          text-decoration: underline;
        }
        .markdown-body pre {
          background: #f6f8fa;
          border: 1px solid #e1e4e8;
          border-radius: 6px;
          padding: 16px;
          overflow-x: auto;
          margin: 8px 0;
        }
        .markdown-body pre code {
          font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
          font-size: 13px;
          line-height: 1.6;
          background: transparent;
          border: none;
          padding: 0;
        }
        .markdown-body code {
          background: #f0f0f0;
          border: 1px solid #e0e0e0;
          border-radius: 3px;
          padding: 2px 6px;
          font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
          font-size: 13px;
        }
        .markdown-body p {
          margin: 8px 0;
        }
      `}</style>

      <div style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        width: '400px',
        maxHeight: '600px',
        background: 'white',
        border: '1px solid #ddd',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      }}>
      {/* 标题栏 */}
      <div style={{
        padding: '15px',
        borderBottom: '1px solid #eee',
        background: '#4CAF50',
        color: 'white',
        borderRadius: '8px 8px 0 0',
        fontWeight: 'bold'
      }}>
        AI 学习助手
      </div>

      {/* 内容区 */}
      <div style={{
        padding: '15px',
        overflowY: 'auto',
        flex: 1
      }}>
        {/* 如果没有 AI 回复,显示表单 */}
        {!aiResponse ? (
          <div>
            {/* 题目信息卡片或手动输入 */}
            {problemInfo ? (
              <div style={{
                background: '#f3f4f6',
                padding: '12px',
                borderRadius: '8px',
                marginBottom: '15px',
                fontSize: '14px'
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                  📝 {problemInfo.problemId}: {problemInfo.title}
                </div>
                <div style={{ fontSize: '12px', color: '#6b7280' }}>
                  题目信息已自动读取
                </div>
              </div>
            ) : (
              <div style={{
                background: '#fef3c7',
                border: '1px solid #fbbf24',
                padding: '12px',
                borderRadius: '8px',
                marginBottom: '15px'
              }}>
                <div style={{ fontSize: '13px', color: '#92400e', marginBottom: '8px' }}>
                  ⚠️ {problemInfoError}
                </div>
                <input
                  type="text"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="请输入题目标题(如: A+B Problem)"
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #fbbf24',
                    borderRadius: '4px',
                    fontSize: '13px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
            )}

            {/* 问题类型选择 */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', fontSize: '14px' }}>
                问题类型
              </label>
              {QUESTION_TYPES.map(type => (
                <label key={type.value} style={{ display: 'block', marginBottom: '6px', fontSize: '13px' }}>
                  <input
                    type="radio"
                    name="questionType"
                    value={type.value}
                    checked={questionType === type.value}
                    onChange={(e) => setQuestionType(e.target.value)}
                    style={{ marginRight: '6px' }}
                  />
                  {type.label}
                </label>
              ))}
            </div>

            {/* 我的理解和尝试 */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', fontSize: '14px' }}>
                我的理解和尝试 <span style={{ color: 'red' }}>*</span>
              </label>
              <textarea
                value={userThinking}
                onChange={(e) => setUserThinking(e.target.value)}
                placeholder="请描述你对这道题的理解和已经尝试的方法(至少 20 字)..."
                style={{
                  width: '100%',
                  minHeight: '100px',
                  padding: '8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '13px',
                  resize: 'vertical',
                  boxSizing: 'border-box'
                }}
              />
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                {userThinking.length} / 2000 字
              </div>
            </div>

            {/* 附带代码显式确认 */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                marginBottom: '8px',
                fontSize: '14px',
                cursor: 'pointer'
              }}>
                <input
                  type="checkbox"
                  checked={includeCode}
                  onChange={(e) => setIncludeCode(e.target.checked)}
                  style={{
                    marginRight: '8px',
                    width: '16px',
                    height: '16px',
                    cursor: 'pointer'
                  }}
                />
                <span style={{ fontWeight: 'bold' }}>📎 附带当前代码给 AI 检查</span>
              </label>

              {includeCode && (
                <div>
                  <div style={{
                    fontSize: '13px',
                    color: '#6b7280',
                    marginBottom: '8px'
                  }}>
                    请将您的代码粘贴到下方输入框中
                  </div>
                  <textarea
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="// 在此粘贴您的代码..."
                    style={{
                      width: '100%',
                      minHeight: '150px',
                      padding: '8px',
                      border: `1px solid ${code.length > 5000 ? '#ef4444' : '#6366f1'}`,
                      borderRadius: '4px',
                      fontSize: '14px',
                      fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                      lineHeight: '1.6',
                      background: '#f9fafb',
                      resize: 'vertical',
                      boxSizing: 'border-box'
                    }}
                  />
                  {/* 代码长度提示 */}
                  <div style={{
                    fontSize: '12px',
                    marginTop: '6px',
                    color: code.length > 5000 ? '#ef4444' : '#6b7280',
                    fontWeight: code.length > 5000 ? 'bold' : 'normal'
                  }}>
                    {code.length > 5000 ? (
                      <>⚠️ 代码过长({code.length} 字符),将截断到 5000 字符</>
                    ) : (
                      <>当前代码长度: {code.length} 字符</>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 错误提示 */}
            {error && (
              <div style={{
                padding: '10px',
                background: '#ffebee',
                color: '#c62828',
                borderRadius: '4px',
                marginBottom: '15px',
                fontSize: '13px'
              }}>
                {error}
              </div>
            )}

            {/* 提交按钮 */}
            <button
              onClick={handleSubmit}
              disabled={
                isLoading ||
                !questionType ||
                userThinking.trim().length < 20 ||
                (includeCode && !code.trim())
              }
              style={{
                width: '100%',
                padding: '10px',
                background: (
                  isLoading ||
                  !questionType ||
                  userThinking.trim().length < 20 ||
                  (includeCode && !code.trim())
                ) ? '#ccc' : '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontSize: '14px',
                fontWeight: 'bold',
                cursor: (
                  isLoading ||
                  !questionType ||
                  userThinking.trim().length < 20 ||
                  (includeCode && !code.trim())
                ) ? 'not-allowed' : 'pointer'
              }}
            >
              {isLoading ? '正在思考...' : '提交问题'}
            </button>
          </div>
        ) : (
          // 显示 AI 回复
          <div>
            {/* 学生消息 */}
            <div style={{
              background: '#e3f2fd',
              padding: '12px',
              borderRadius: '8px',
              marginBottom: '15px'
            }}>
              <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '6px', color: '#1976d2' }}>
                我的问题
              </div>
              <div style={{ fontSize: '13px', whiteSpace: 'pre-wrap' }}>
                {userThinking}
              </div>
              {includeCode && code && (
                <pre style={{
                  background: '#f5f5f5',
                  padding: '8px',
                  borderRadius: '4px',
                  marginTop: '8px',
                  fontSize: '12px',
                  overflow: 'auto'
                }}>
                  <code>{code}</code>
                </pre>
              )}
            </div>

            {/* AI 回复 */}
            <div style={{
              background: '#f5f5f5',
              padding: '12px',
              borderRadius: '8px',
              marginBottom: '15px'
            }}>
              <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '6px', color: '#4CAF50' }}>
                AI 导师
              </div>
              <div style={{ fontSize: '13px' }}>
                {renderMarkdown(aiResponse)}
              </div>
            </div>

            {/* 继续提问按钮 */}
            <button
              onClick={handleReset}
              style={{
                width: '100%',
                padding: '10px',
                background: '#2196F3',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontSize: '14px',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              继续提问
            </button>
          </div>
        )}
      </div>
    </div>
    </>
  );
};
