/**
 * 题目详情页面集成
 * 在题目详情页挂载 AI 助手面板
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import { AIAssistantPanel } from './student/AIAssistantPanel';

// 支持的题目详情页 URL 模式
const PROBLEM_DETAIL_PATTERNS: RegExp[] = [
  /^\/p\/([^/]+)/, // 根域题目：/p/D3102
  /^\/d\/[^/]+\/p\/([^/]+)/, // 域下题目：/d/:domain/p/:pid
];

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
 * 初始化 AI 助手面板
 */
const initAIAssistantPanel = () => {
  if (!isProblemDetailPage()) {
    console.log('[AI Helper] Not a problem detail page, skipping initialization');
    return;
  }

  const problemId = extractProblemId();
  if (!problemId) {
    console.error('[AI Helper] Failed to extract problem ID from URL');
    return;
  }

  console.log('[AI Helper] Initializing AI Assistant Panel for problem:', problemId);

  // 创建容器元素
  const container = document.createElement('div');
  container.id = 'ai-assistant-panel-container';
  document.body.appendChild(container);

  // 渲染 React 组件（兼容 React 17/18）
  const reactDom = ReactDOM as unknown as {
    createRoot?: (el: Element | DocumentFragment) => { render: (node: React.ReactNode) => void };
    render?: (node: React.ReactNode, el: Element | DocumentFragment | null) => void;
  };

  if (typeof reactDom.createRoot === 'function') {
    const root = reactDom.createRoot(container);
    root.render(<AIAssistantPanel problemId={problemId} />);
  } else if (typeof reactDom.render === 'function') {
    reactDom.render(<AIAssistantPanel problemId={problemId} />, container);
  } else {
    console.error('[AI Helper] ReactDOM is missing render/createRoot');
  }

  console.log('[AI Helper] AI Assistant Panel mounted successfully');
};

// 等待 DOM 加载完成
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAIAssistantPanel, { once: true });
} else {
  initAIAssistantPanel();
}
