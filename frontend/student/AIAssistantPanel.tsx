/**
 * AI 学习助手面板 - 学生端
 * 在题目详情页显示的对话界面
 * T007A: 可折叠/可拖拽/可调尺寸的浮动卡片
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  // 原有业务状态
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

  // T007A: 浮动面板 UI 状态
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true; // SSR/构建安全
    const saved = window.localStorage.getItem('ai_assistant_collapsed');
    if (saved === 'true') return true;
    if (saved === 'false') return false;
    return true; // 默认折叠
  }); // 折叠状态
  const [position, setPosition] = useState({ bottom: 20, right: 20 }); // 面板位置
  const [size, setSize] = useState({ width: 400, height: 500 }); // 面板尺寸
  const [isDragging, setIsDragging] = useState<boolean>(false); // 拖拽状态
  const [isResizing, setIsResizing] = useState<boolean>(false); // 缩放状态
  const [isMobile, setIsMobile] = useState<boolean>(false); // 移动端检测

  // DOM 引用
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const resizeStartSize = useRef({ width: 0, height: 0 });
  const resizeStartMouse = useRef({ x: 0, y: 0 });

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('ai_assistant_collapsed', next ? 'true' : 'false');
      } catch (e) {
        // 忽略本地存储错误
      }
      return next;
    });
  };

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
   * T007A: 移动端检测
   */
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  /**
   * T007A: 拖拽功能 - 标题栏拖拽
   */
  const handleDragStart = (e: React.MouseEvent) => {
    if (isMobile) return; // 移动端禁用拖拽
    setIsDragging(true);
    dragStartPos.current = {
      x: e.clientX - (window.innerWidth - position.right - size.width),
      y: e.clientY - (window.innerHeight - position.bottom - size.height)
    };
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleDragMove = (e: MouseEvent) => {
      const newX = e.clientX - dragStartPos.current.x;
      const newY = e.clientY - dragStartPos.current.y;

      // 计算 bottom 和 right 位置
      const newBottom = window.innerHeight - newY - size.height;
      const newRight = window.innerWidth - newX - size.width;

      // 边界限制
      const clampedBottom = Math.max(0, Math.min(window.innerHeight - 100, newBottom));
      const clampedRight = Math.max(0, Math.min(window.innerWidth - 100, newRight));

      setPosition({ bottom: clampedBottom, right: clampedRight });
    };

    const handleDragEnd = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);

    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, [isDragging, position, size]);

  /**
   * T007A: 缩放功能 - 右下角手柄
   */
  const handleResizeStart = (e: React.MouseEvent) => {
    if (isMobile) return; // 移动端禁用缩放
    e.stopPropagation();
    setIsResizing(true);
    resizeStartSize.current = { width: size.width, height: size.height };
    resizeStartMouse.current = { x: e.clientX, y: e.clientY };
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleResizeMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartMouse.current.x;
      const deltaY = e.clientY - resizeStartMouse.current.y; // 修复:向下拖动增加高度

      const newWidth = resizeStartSize.current.width + deltaX;
      const newHeight = resizeStartSize.current.height + deltaY; // 修复:正向增加

      // 尺寸限制: 最小 360x400, 最大 600x80vh
      const maxHeight = Math.min(800, window.innerHeight * 0.8);
      const clampedWidth = Math.max(300, Math.min(600, newWidth));
      const clampedHeight = Math.max(360, Math.min(maxHeight, newHeight));

      setSize({ width: clampedWidth, height: clampedHeight });
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
      document.body.style.userSelect = ''; // 恢复文本选择
    };

    // 禁用文本选择
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);

    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

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

  // 计算面板样式(移动端 vs 桌面端)
  const panelStyle: React.CSSProperties = isMobile ? {
    // 移动端:全屏模式
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: isCollapsed ? '56px' : '100vh',
    background: '#f9fafb',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    transition: 'height 0.3s ease'
  } : {
    // 桌面端:浮动卡片
    position: 'fixed',
    bottom: `${position.bottom}px`,
    right: `${position.right}px`,
    width: `${size.width}px`,
    height: isCollapsed ? '48px' : `${size.height}px`,
    background: '#f9fafb',
    borderRadius: '12px',
    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.15), 0 4px 10px rgba(0, 0, 0, 0.1)',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    overflow: 'hidden',
    transition: 'height 0.3s ease'
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

      <div ref={panelRef} style={panelStyle}>
      {/* 标题栏 - 可拖拽 */}
      <div
        onMouseDown={handleDragStart}
        style={{
          padding: '12px 16px',
          borderBottom: isCollapsed ? 'none' : '1px solid #e5e7eb',
          background: '#6366f1',
          color: 'white',
          borderRadius: isMobile ? '0' : '12px 12px 0 0',
          fontWeight: '600',
          fontSize: '15px',
          cursor: isMobile ? 'default' : (isDragging ? 'grabbing' : 'grab'),
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          userSelect: 'none',
          height: isMobile ? '56px' : '48px',
          boxSizing: 'border-box'
        }}
      >
        <span>✨ AI 学习助手</span>
        <button
          onClick={toggleCollapse}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'white',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '4px 8px',
            lineHeight: '1'
          }}
          title={isCollapsed ? '展开面板' : '折叠面板'}
        >
          {isCollapsed ? '▲' : '▼'}
        </button>
      </div>

      {/* 内容区 - 折叠时隐藏 */}
      {!isCollapsed && (
      <div style={{
        padding: '16px',
        overflowY: 'auto',
        flex: 1,
        background: '#ffffff',
        borderRadius: isMobile ? '0' : '0 0 12px 12px'
      }}>
        {/* 如果没有 AI 回复,显示表单 */}
        {!aiResponse ? (
          <div>
            {/* 题目信息卡片或手动输入 */}
            {problemInfo ? (
              <div style={{
                background: '#f5f3ff',
                border: '1px solid #e0ddff',
                padding: '10px 12px',
                borderRadius: '8px',
                marginBottom: '16px'
              }}>
                <div style={{
                  fontSize: '12px',
                  color: '#9333ea',
                  marginBottom: '4px',
                  fontWeight: '500'
                }}>
                  题目 {problemInfo.problemId}
                </div>
                <div style={{
                  fontWeight: '600',
                  fontSize: '14px',
                  color: '#5b21b6',
                  lineHeight: '1.4',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical'
                }}>
                  {problemInfo.title}
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
                    borderRadius: '6px',
                    fontSize: '13px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
            )}

            {/* 问题类型选择 - 胶囊式按钮 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'block',
                marginBottom: '10px',
                fontWeight: '600',
                fontSize: '14px',
                color: '#374151'
              }}>
                问题类型
              </label>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px'
              }}>
                {QUESTION_TYPES.map(type => {
                  const isSelected = questionType === type.value;
                  return (
                    <label
                      key={type.value}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '8px 14px',
                        borderRadius: '999px',
                        border: `1.5px solid ${isSelected ? '#7c3aed' : '#d1d5db'}`,
                        background: isSelected ? '#ede9fe' : '#ffffff',
                        color: isSelected ? '#5b21b6' : '#4b5563',
                        fontSize: '13px',
                        fontWeight: isSelected ? '600' : '500',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        userSelect: 'none'
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.borderColor = '#9ca3af';
                          e.currentTarget.style.background = '#f9fafb';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.borderColor = '#d1d5db';
                          e.currentTarget.style.background = '#ffffff';
                        }
                      }}
                    >
                      <input
                        type="radio"
                        name="questionType"
                        value={type.value}
                        checked={isSelected}
                        onChange={(e) => setQuestionType(e.target.value)}
                        style={{ display: 'none' }}
                      />
                      {type.label}
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 我的理解和尝试 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'block',
                marginBottom: '8px',
                fontWeight: '600',
                fontSize: '14px',
                color: '#374151'
              }}>
                我的理解和尝试 <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <textarea
                value={userThinking}
                onChange={(e) => setUserThinking(e.target.value)}
                placeholder="请描述你对这道题的理解和已经尝试的方法(至少 20 字)..."
                style={{
                  width: '100%',
                  minHeight: '140px',
                  padding: '10px 12px',
                  border: '1px solid #d4d4d8',
                  borderRadius: '8px',
                  fontSize: '13px',
                  lineHeight: '1.6',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  transition: 'all 0.2s ease',
                  outline: 'none',
                  background: '#ffffff'
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#6366f1';
                  e.target.style.boxShadow = '0 0 0 3px rgba(99, 102, 241, 0.1)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = '#d4d4d8';
                  e.target.style.boxShadow = 'none';
                }}
              />
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: '6px'
              }}>
                <div style={{
                  fontSize: '12px',
                  color: '#9ca3af',
                  lineHeight: '1.4'
                }}>
                  💡 越详细的思路描述,AI 越能针对性地帮你诊断
                </div>
                <div style={{
                  fontSize: '12px',
                  color: userThinking.length >= 20 ? '#10b981' : '#9ca3af',
                  fontWeight: '500'
                }}>
                  {userThinking.length} / 2000
                </div>
              </div>
            </div>

            {/* 附带代码显式确认 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'flex',
                alignItems: 'flex-start',
                cursor: 'pointer',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                background: includeCode ? '#faf5ff' : '#ffffff',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                if (!includeCode) {
                  e.currentTarget.style.background = '#f9fafb';
                }
              }}
              onMouseLeave={(e) => {
                if (!includeCode) {
                  e.currentTarget.style.background = '#ffffff';
                }
              }}
              >
                <input
                  type="checkbox"
                  checked={includeCode}
                  onChange={(e) => setIncludeCode(e.target.checked)}
                  style={{
                    marginRight: '10px',
                    marginTop: '2px',
                    width: '18px',
                    height: '18px',
                    cursor: 'pointer',
                    accentColor: '#7c3aed'
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontWeight: '600',
                    fontSize: '14px',
                    color: '#374151',
                    marginBottom: '4px'
                  }}>
                    📎 附带当前代码给 AI 检查
                  </div>
                  <div style={{
                    fontSize: '12px',
                    color: '#6b7280',
                    lineHeight: '1.4'
                  }}>
                    建议在调试错误时勾选,可能略微增加响应时间
                  </div>
                </div>
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
                padding: '12px',
                background: '#fee2e2',
                color: '#dc2626',
                borderRadius: '8px',
                marginBottom: '15px',
                fontSize: '13px',
                border: '1px solid #fecaca'
              }}>
                ⚠️ {error}
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
                padding: '14px',
                background: (
                  isLoading ||
                  !questionType ||
                  userThinking.trim().length < 20 ||
                  (includeCode && !code.trim())
                ) ? '#d1d5db' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '999px',
                fontSize: '15px',
                fontWeight: '600',
                cursor: (
                  isLoading ||
                  !questionType ||
                  userThinking.trim().length < 20 ||
                  (includeCode && !code.trim())
                ) ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s ease',
                boxShadow: (
                  isLoading ||
                  !questionType ||
                  userThinking.trim().length < 20 ||
                  (includeCode && !code.trim())
                ) ? 'none' : '0 4px 12px rgba(99, 102, 241, 0.3)',
                transform: 'translateY(0)'
              }}
              onMouseEnter={(e) => {
                if (!(
                  isLoading ||
                  !questionType ||
                  userThinking.trim().length < 20 ||
                  (includeCode && !code.trim())
                )) {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(99, 102, 241, 0.4)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = (
                  isLoading ||
                  !questionType ||
                  userThinking.trim().length < 20 ||
                  (includeCode && !code.trim())
                ) ? 'none' : '0 4px 12px rgba(99, 102, 241, 0.3)';
              }}
            >
              {isLoading ? '⏳ 正在思考...' : '🚀 提交问题'}
            </button>
          </div>
        ) : (
          // 显示 AI 回复
          <div>
            {/* 学生消息 */}
            <div style={{
              background: '#dbeafe',
              border: '1px solid #93c5fd',
              padding: '14px',
              borderRadius: '10px',
              marginBottom: '16px'
            }}>
              <div style={{ fontWeight: '600', fontSize: '14px', marginBottom: '8px', color: '#1e40af' }}>
                💬 我的问题
              </div>
              <div style={{ fontSize: '13px', whiteSpace: 'pre-wrap', color: '#1e3a8a' }}>
                {userThinking}
              </div>
              {includeCode && code && (
                <pre style={{
                  background: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  padding: '10px',
                  borderRadius: '6px',
                  marginTop: '10px',
                  fontSize: '12px',
                  overflow: 'auto',
                  fontFamily: 'Consolas, Monaco, "Courier New", monospace'
                }}>
                  <code>{code}</code>
                </pre>
              )}
            </div>

            {/* AI 回复 */}
            <div style={{
              background: '#f0fdf4',
              border: '1px solid #86efac',
              padding: '14px',
              borderRadius: '10px',
              marginBottom: '16px'
            }}>
              <div style={{ fontWeight: '600', fontSize: '14px', marginBottom: '8px', color: '#15803d' }}>
                🤖 AI 导师
              </div>
              <div style={{ fontSize: '13px', color: '#166534' }}>
                {renderMarkdown(aiResponse)}
              </div>
            </div>

            {/* 继续提问按钮 */}
            <button
              onClick={handleReset}
              style={{
                width: '100%',
                padding: '12px',
                background: '#8b5cf6',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'background 0.2s'
              }}
            >
              💬 继续提问
            </button>
          </div>
        )}
      </div>
      )}

      {/* 拖拽高度调整把手 - 仅桌面端且未折叠时显示 */}
      {!isMobile && !isCollapsed && (
        <div
          onMouseDown={handleResizeStart}
          style={{
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'ns-resize',
            background: 'transparent',
            transition: 'background 0.2s ease',
            borderRadius: '0 0 12px 12px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(99, 102, 241, 0.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
          title="拖拽调整面板高度"
        >
          {/* 三条横线作为拖拽图标 */}
          <div style={{
            width: '40px',
            height: '4px',
            borderRadius: '2px',
            background: '#d1d5db',
            position: 'relative',
            pointerEvents: 'none'
          }}>
            <div style={{
              position: 'absolute',
              top: '-6px',
              left: '0',
              right: '0',
              height: '3px',
              borderRadius: '2px',
              background: '#d1d5db'
            }} />
            <div style={{
              position: 'absolute',
              top: '6px',
              left: '0',
              right: '0',
              height: '3px',
              borderRadius: '2px',
              background: '#d1d5db'
            }} />
          </div>
        </div>
      )}
    </div>
    </>
  );
};
