/**
 * AI 助手统一入口页面挂载入口
 * 路由: /ai-helper 和 /d/:domainId/ai-helper
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import { AIHelperDashboard } from './components/AIHelperDashboard';

/**
 * 检查是否为 AI 助手统一入口页面
 * 支持: /ai-helper 和 /d/:domainId/ai-helper
 */
const isAIHelperPage = () => {
  const pathname = window.location.pathname;
  return pathname === '/ai-helper' ||
    /^\/d\/[^/]+\/ai-helper$/.test(pathname);
};

/**
 * 将统一入口页面挂载到模板提供的根节点
 */
const renderPage = () => {
  if (!isAIHelperPage()) {
    return;
  }

  const container = document.getElementById('ai-helper-dashboard-root');
  if (!container) {
    console.debug('[AI Helper] dashboard root not found, skip render');
    return;
  }

  const reactDom = ReactDOM as unknown as {
    createRoot?: (el: Element | DocumentFragment) => { render: (node: React.ReactNode) => void };
    render?: (node: React.ReactNode, el: Element | DocumentFragment | null) => void;
  };

  if (typeof reactDom.createRoot === 'function') {
    const root = reactDom.createRoot(container);
    root.render(<AIHelperDashboard />);
  } else if (typeof reactDom.render === 'function') {
    reactDom.render(<AIHelperDashboard />, container);
  }
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderPage, { once: true });
} else {
  renderPage();
}
