/**
 * 题目详情页面集成
 * 在 Scratchpad 模式下显示 AI 助手触发图标
 * 展开后形成四列布局：标签栏 | 题目 | 代码 | AI助手
 */

import React, { useState, useEffect, useCallback } from 'react';
import * as ReactDOM from 'react-dom';
import { AIAssistantPanel } from './student/AIAssistantPanel';

// 支持的题目详情页 URL 模式
const PROBLEM_DETAIL_PATTERNS: RegExp[] = [
  /^\/p\/([^/]+)/, // 根域题目：/p/D3102
  /^\/d\/[^/]+\/p\/([^/]+)/, // 域下题目：/d/:domain/p/:pid
];

// AI 面板宽度
const AI_PANEL_WIDTH = 380;

/**
 * 判断是否为题目详情页
 */
const isProblemDetailPage = () => {
  const pathname = window.location.pathname;
  return PROBLEM_DETAIL_PATTERNS.some((pattern) => pattern.test(pathname));
};

/**
 * 从 URL 提取题目 ID
 */
const extractProblemId = (): string => {
  const pathname = window.location.pathname;

  for (const pattern of PROBLEM_DETAIL_PATTERNS) {
    const match = pathname.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return '';
};

/**
 * AI 助手触发器组件
 * 只在 Scratchpad 模式下显示边缘图标
 */
const AIAssistantTrigger: React.FC<{ problemId: string }> = ({ problemId }) => {
  const [isScratchpadActive, setIsScratchpadActive] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  // 调整 Scratchpad 容器宽度
  const adjustScratchpadLayout = useCallback((panelOpen: boolean) => {
    const scratchpadContainer = document.querySelector('.scratchpad-container') as HTMLElement;
    if (!scratchpadContainer) return;

    if (panelOpen) {
      // 面板展开：收缩 Scratchpad 容器，为 AI 面板留出空间
      scratchpadContainer.style.transition = 'width 0.3s ease, right 0.3s ease';
      scratchpadContainer.style.width = `calc(100% - ${AI_PANEL_WIDTH}px)`;
      scratchpadContainer.style.position = 'absolute';
      scratchpadContainer.style.left = '0';
    } else {
      // 面板关闭：恢复 Scratchpad 容器
      scratchpadContainer.style.transition = 'width 0.3s ease';
      scratchpadContainer.style.width = '100%';
    }
  }, []);

  useEffect(() => {
    // 检测 Scratchpad 是否激活
    const checkScratchpad = () => {
      const scratchpad = document.querySelector('.scratchpad-container');
      const isActive = !!scratchpad && scratchpad.querySelector('.monaco-editor') !== null;

      if (isActive !== isScratchpadActive) {
        setIsScratchpadActive(isActive);

        // Scratchpad 关闭时自动关闭面板并恢复布局
        if (!isActive && isPanelOpen) {
          setIsPanelOpen(false);
          adjustScratchpadLayout(false);
        }
      }
    };

    // 初始检查
    checkScratchpad();

    // 使用 MutationObserver 监听 DOM 变化
    const observer = new MutationObserver(() => {
      requestAnimationFrame(checkScratchpad);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [isScratchpadActive, isPanelOpen, adjustScratchpadLayout]);

  // 面板开关变化时调整布局
  useEffect(() => {
    if (isScratchpadActive) {
      adjustScratchpadLayout(isPanelOpen);
    }
  }, [isPanelOpen, isScratchpadActive, adjustScratchpadLayout]);

  // 处理面板展开
  const handleOpenPanel = () => {
    setIsPanelOpen(true);
  };

  // 处理面板折叠
  const handleClosePanel = () => {
    setIsPanelOpen(false);
  };

  // 不在 Scratchpad 模式下，不显示任何内容
  if (!isScratchpadActive) return null;

  return (
    <>
      {/* 右侧边缘抽屉把手图标 */}
      {!isPanelOpen && (
        <div
          onClick={handleOpenPanel}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={{
            position: 'fixed',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            width: isHovered ? '44px' : '32px',
            height: '100px',
            background: isHovered
              ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)'
              : 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
            borderRadius: '10px 0 0 10px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: isHovered
              ? '-4px 0 20px rgba(99, 102, 241, 0.4)'
              : '-2px 0 10px rgba(99, 102, 241, 0.2)',
            transition: 'all 0.3s ease',
            zIndex: 9998,
            gap: '4px'
          }}
          title="打开 AI 学习助手"
        >
          {/* AI 图标 */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            style={{
              transition: 'transform 0.3s ease',
              transform: isHovered ? 'scale(1.1)' : 'scale(1)'
            }}
          >
            <path
              d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
              fill="white"
            />
          </svg>
          {/* 文字标签 */}
          <span
            style={{
              color: 'white',
              fontSize: '10px',
              fontWeight: 600,
              writingMode: 'vertical-rl',
              textOrientation: 'mixed',
              letterSpacing: '1px'
            }}
          >
            AI
          </span>
          {/* 展开箭头 */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            style={{
              transition: 'transform 0.3s ease',
              transform: isHovered ? 'translateX(-2px)' : 'translateX(0)'
            }}
          >
            <path
              d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"
              fill="white"
            />
          </svg>
        </div>
      )}

      {/* AI 对话面板 - 作为右侧第四列 */}
      {isPanelOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            width: `${AI_PANEL_WIDTH}px`,
            height: '100vh',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            background: '#ffffff',
            borderLeft: '1px solid #e5e7eb',
            boxShadow: '-2px 0 10px rgba(0, 0, 0, 0.1)'
          }}
        >
          {/* 面板头部 - 浅色简约风格 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              background: '#f8fafc',
              borderBottom: '1px solid #e5e7eb',
              flexShrink: 0
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
                  fill="#6366f1"
                />
              </svg>
              <span style={{ fontWeight: 600, fontSize: '14px', color: '#1f2937' }}>AI 学习助手</span>
            </div>
            <button
              onClick={handleClosePanel}
              style={{
                background: '#f3f4f6',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                padding: '6px 10px',
                color: '#4b5563',
                cursor: 'pointer',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}
              title="收起面板"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" fill="#4b5563"/>
              </svg>
              收起
            </button>
          </div>

          {/* AI 面板内容 */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <AIAssistantPanel
              problemId={problemId}
              defaultExpanded={true}
              onCollapse={handleClosePanel}
              embedded={true}
            />
          </div>
        </div>
      )}
    </>
  );
};

/**
 * 初始化 AI 助手
 */
const initAIAssistant = () => {
  if (!isProblemDetailPage()) {
    return;
  }

  const problemId = extractProblemId();
  if (!problemId) {
    return;
  }

  // 创建容器元素
  const container = document.createElement('div');
  container.id = 'ai-assistant-trigger-container';
  document.body.appendChild(container);

  // 渲染 React 组件（兼容 React 17/18）
  const reactDom = ReactDOM as unknown as {
    createRoot?: (el: Element | DocumentFragment) => { render: (node: React.ReactNode) => void };
    render?: (node: React.ReactNode, el: Element | DocumentFragment | null) => void;
  };

  if (typeof reactDom.createRoot === 'function') {
    const root = reactDom.createRoot(container);
    root.render(<AIAssistantTrigger problemId={problemId} />);
  } else if (typeof reactDom.render === 'function') {
    reactDom.render(<AIAssistantTrigger problemId={problemId} />, container);
  }
};

// 等待 DOM 加载完成
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAIAssistant, { once: true });
} else {
  initAIAssistant();
}
