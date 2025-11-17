/**
 * AI 学习助手面板 - 学生端
 * 在题目详情页显示的对话界面
 */

import React, { useState } from 'react';

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

    setError('');
    setIsLoading(true);

    try {
      // 调用后端 API
      const response = await fetch('/ai-helper/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          problemId,
          questionType,
          userThinking,
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
   * 简单的 Markdown 渲染(仅处理代码块)
   */
  const renderMarkdown = (text: string) => {
    // 简单处理代码块
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
      if (part.startsWith('```')) {
        const codeContent = part.replace(/^```[\w]*\n?/, '').replace(/```$/, '');
        return (
          <pre key={index} style={{
            background: '#f5f5f5',
            padding: '10px',
            borderRadius: '4px',
            overflow: 'auto',
            marginTop: '8px',
            marginBottom: '8px'
          }}>
            <code>{codeContent}</code>
          </pre>
        );
      } else {
        // 处理普通文本中的换行
        return (
          <div key={index} style={{ whiteSpace: 'pre-wrap' }}>
            {part}
          </div>
        );
      }
    });
  };

  return (
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

            {/* 附带代码 */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={includeCode}
                  onChange={(e) => setIncludeCode(e.target.checked)}
                  style={{ marginRight: '6px' }}
                />
                附带代码
              </label>
              {includeCode && (
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="粘贴你的代码..."
                  style={{
                    width: '100%',
                    minHeight: '120px',
                    padding: '8px',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    resize: 'vertical',
                    boxSizing: 'border-box'
                  }}
                />
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
              disabled={isLoading || !questionType || userThinking.trim().length < 20}
              style={{
                width: '100%',
                padding: '10px',
                background: isLoading || !questionType || userThinking.trim().length < 20 ? '#ccc' : '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontSize: '14px',
                fontWeight: 'bold',
                cursor: isLoading || !questionType || userThinking.trim().length < 20 ? 'not-allowed' : 'pointer'
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
  );
};
