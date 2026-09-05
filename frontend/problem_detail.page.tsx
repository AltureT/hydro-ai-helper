import { Icon } from './components/Icon';
/**
 * 题目详情页面集成
 * 在 Scratchpad 模式下显示 AI 助手触发图标
 * 展开后形成四列布局：标签栏 | 题目 | 代码 | AI助手
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { i18n } from './utils/i18n';
import { renderComponent } from './utils/renderHelper';
import { AIAssistantPanel } from './student/AIAssistantPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

// 支持的题目详情页 URL 模式
const PROBLEM_DETAIL_PATTERNS: RegExp[] = [
  /^\/p\/([^/]+)/, // 根域题目：/p/D3102
  /^\/d\/[^/]+\/p\/([^/]+)/, // 域下题目：/d/:domain/p/:pid
];

// AI 面板宽度范围
const AI_PANEL_MIN_WIDTH = 300;
const AI_PANEL_MAX_WIDTH = 900;
const AI_PANEL_DEFAULT_WIDTH = 380;

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
  const [panelWidth, setPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ mouseX: 0, width: 0 });

  // 调整 Scratchpad 容器宽度
  const adjustScratchpadLayout = useCallback((panelOpen: boolean, width?: number) => {
    const scratchpadContainer = document.querySelector('.scratchpad-container') as HTMLElement;
    if (!scratchpadContainer) return;

    const actualWidth = width ?? panelWidth;
    if (panelOpen) {
      // 面板展开：收缩 Scratchpad 容器，为 AI 面板留出空间
      scratchpadContainer.style.transition = width ? 'none' : 'width 0.3s ease, right 0.3s ease';
      scratchpadContainer.style.width = `calc(100% - ${actualWidth}px)`;
      scratchpadContainer.style.position = 'absolute';
      scratchpadContainer.style.left = '0';
    } else {
      // 面板关闭：恢复 Scratchpad 容器
      scratchpadContainer.style.transition = 'width 0.3s ease';
      scratchpadContainer.style.width = '100%';
    }
  }, [panelWidth]);

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

  // 开始拖拽调整宽度
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartRef.current = { mouseX: e.clientX, width: panelWidth };
  };

  // 拖拽调整宽度的 effect
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // 向左拖动 (deltaX 为负) 应增加宽度
      const deltaX = e.clientX - resizeStartRef.current.mouseX;
      const newWidth = resizeStartRef.current.width - deltaX;
      const clampedWidth = Math.max(AI_PANEL_MIN_WIDTH, Math.min(AI_PANEL_MAX_WIDTH, newWidth));
      setPanelWidth(clampedWidth);
      adjustScratchpadLayout(true, clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, adjustScratchpadLayout]);

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
              ? 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)'
              : 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
            borderRadius: '10px 0 0 10px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: isHovered
              ? '-4px 0 20px rgba(37, 99, 235, 0.4)'
              : '-2px 0 10px rgba(37, 99, 235, 0.2)',
            transition: 'all 0.3s ease',
            zIndex: 9998,
            gap: '4px'
          }}
          title={i18n('ai_helper_student_open_panel')}
        >
          {/* AI 图标 */}
          <Icon name="message" size={20} style={{ color: 'white' }} />
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
          <Icon name="chevronLeft" size={14} style={{ color: 'white' }} />
        </div>
      )}

      {/* AI 对话面板 - 作为右侧第四列 */}
      {isPanelOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            width: `${panelWidth}px`,
            height: '100vh',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            background: '#ffffff',
            borderLeft: '1px solid #e5e7eb',
            boxShadow: '-2px 0 10px rgba(0, 0, 0, 0.1)'
          }}
        >
          {/* 左侧拖拽调整宽度把手 */}
          <div
            onMouseDown={handleResizeStart}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: '6px',
              cursor: 'ew-resize',
              background: isResizing ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
              transition: 'background 0.2s ease',
              zIndex: 10
            }}
            onMouseEnter={(e) => {
              if (!isResizing) e.currentTarget.style.background = 'rgba(37, 99, 235, 0.1)';
            }}
            onMouseLeave={(e) => {
              if (!isResizing) e.currentTarget.style.background = 'transparent';
            }}
            title={i18n('ai_helper_student_resize_panel')}
          >
            {/* 竖线拖拽指示器 */}
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '1px',
              transform: 'translateY(-50%)',
              width: '3px',
              height: '40px',
              borderRadius: '2px',
              background: '#d1d5db',
              pointerEvents: 'none'
            }} />
          </div>

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
              <Icon name="message" size={18} style={{ color: '#2563eb' }} />
              <span style={{ fontWeight: 600, fontSize: '14px', color: '#1f2937' }}>{i18n('ai_helper_student_panel_title')}</span>
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
              title={i18n('ai_helper_student_collapse_panel')}
            >
              <Icon name="chevronRight" size={14} />
              {i18n('ai_helper_student_collapse')}
            </button>
          </div>

          {/* AI 面板内容 */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <AIAssistantPanel
              problemId={problemId}
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

  renderComponent(<ErrorBoundary><AIAssistantTrigger problemId={problemId} /></ErrorBoundary>, container);
};

// 等待 DOM 加载完成
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAIAssistant, { once: true });
} else {
  initAIAssistant();
}
