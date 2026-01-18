/**
 * 三列布局组件 - LeetCode 风格
 * 左侧：题目描述
 * 中间：代码编辑器（使用 HydroOJ 原有的 Scratchpad）
 * 右侧：AI 学习助手
 */

import React, { useState, useEffect, useRef } from 'react';
import { AIChatPanel } from './AIChatPanel';

interface ThreeColumnLayoutProps {
  problemId: string;
}

/**
 * 三列布局组件
 * 检测屏幕宽度 >= 1200px 时启用三列模式
 */
export const ThreeColumnLayout: React.FC<ThreeColumnLayoutProps> = ({ problemId }) => {
  const [leftWidth, setLeftWidth] = useState(33);
  const [rightWidth, setRightWidth] = useState(34);
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 处理左侧分割线拖拽
  useEffect(() => {
    if (!isDraggingLeft) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newLeftWidth = ((e.clientX - rect.left) / rect.width) * 100;
      // 限制在 20% - 50% 之间
      setLeftWidth(Math.max(20, Math.min(50, newLeftWidth)));
    };

    const handleMouseUp = () => {
      setIsDraggingLeft(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingLeft]);

  // 处理右侧分割线拖拽
  useEffect(() => {
    if (!isDraggingRight) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newRightWidth = ((rect.right - e.clientX) / rect.width) * 100;
      // 限制在 25% - 45% 之间
      setRightWidth(Math.max(25, Math.min(45, newRightWidth)));
    };

    const handleMouseUp = () => {
      setIsDraggingRight(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingRight]);

  const middleWidth = 100 - leftWidth - rightWidth;

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        width: '100%',
        height: 'calc(100vh - 60px)', // 减去顶部导航栏高度
        background: '#f8fafc',
        overflow: 'hidden'
      }}
    >
      {/* 左侧：题目描述 */}
      <div
        style={{
          width: `${leftWidth}%`,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          borderRight: '1px solid #e2e8f0'
        }}
      >
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
          fontWeight: '600',
          fontSize: '14px',
          color: '#1e293b',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{ fontSize: '16px' }}>📄</span>
          题目描述
        </div>
        <div
          id="problem-content-wrapper"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px'
          }}
        >
          {/* 题目内容将通过 DOM 操作移动到这里 */}
        </div>
      </div>

      {/* 左侧分割线 */}
      <div
        onMouseDown={() => setIsDraggingLeft(true)}
        style={{
          width: '6px',
          cursor: 'col-resize',
          background: isDraggingLeft ? '#6366f1' : 'transparent',
          transition: 'background 0.2s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        onMouseEnter={(e) => {
          if (!isDraggingLeft) e.currentTarget.style.background = '#e2e8f0';
        }}
        onMouseLeave={(e) => {
          if (!isDraggingLeft) e.currentTarget.style.background = 'transparent';
        }}
      >
        <div style={{
          width: '2px',
          height: '40px',
          background: '#cbd5e1',
          borderRadius: '1px'
        }} />
      </div>

      {/* 中间：代码编辑器 */}
      <div
        style={{
          width: `${middleWidth}%`,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          borderRight: '1px solid #e2e8f0'
        }}
      >
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
          fontWeight: '600',
          fontSize: '14px',
          color: '#1e293b',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{ fontSize: '16px' }}>💻</span>
          代码编辑器
        </div>
        <div
          id="code-editor-wrapper"
          style={{
            flex: 1,
            overflow: 'hidden'
          }}
        >
          {/* 代码编辑器将通过 DOM 操作移动到这里 */}
        </div>
      </div>

      {/* 右侧分割线 */}
      <div
        onMouseDown={() => setIsDraggingRight(true)}
        style={{
          width: '6px',
          cursor: 'col-resize',
          background: isDraggingRight ? '#6366f1' : 'transparent',
          transition: 'background 0.2s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        onMouseEnter={(e) => {
          if (!isDraggingRight) e.currentTarget.style.background = '#e2e8f0';
        }}
        onMouseLeave={(e) => {
          if (!isDraggingRight) e.currentTarget.style.background = 'transparent';
        }}
      >
        <div style={{
          width: '2px',
          height: '40px',
          background: '#cbd5e1',
          borderRadius: '1px'
        }} />
      </div>

      {/* 右侧：AI 学习助手 */}
      <div
        style={{
          width: `${rightWidth}%`,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff'
        }}
      >
        <AIChatPanel problemId={problemId} />
      </div>
    </div>
  );
};

export default ThreeColumnLayout;
