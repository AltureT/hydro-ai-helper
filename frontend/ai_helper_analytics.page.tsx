/**
 * AI 使用统计页面挂载入口
 * 路由: /ai-helper/analytics
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import AnalyticsPage from './teacher/AnalyticsPage';

/**
 * T025: 检查是否为 AI 使用统计页面
 * 支持: /ai-helper/analytics 和 /d/:domainId/ai-helper/analytics
 */
const isAnalyticsPage = () => {
  const pathname = window.location.pathname;
  return pathname === '/ai-helper/analytics' ||
    /^\/d\/[^/]+\/ai-helper\/analytics$/.test(pathname);
};

/**
 * 将统计页面挂载到模板提供的根节点
 */
const renderAnalyticsPage = () => {
  if (!isAnalyticsPage()) {
    return;
  }

  const container = document.getElementById('ai-helper-analytics-root');
  if (!container) {
    console.debug('[AI Helper] analytics root not found, skip render');
    return;
  }

  const reactDom = ReactDOM as unknown as {
    createRoot?: (el: Element | DocumentFragment) => { render: (node: React.ReactNode) => void };
    render?: (node: React.ReactNode, el: Element | DocumentFragment | null) => void;
  };

  if (typeof reactDom.createRoot === 'function') {
    const root = reactDom.createRoot(container);
    root.render(<AnalyticsPage />);
  } else if (typeof reactDom.render === 'function') {
    reactDom.render(<AnalyticsPage />, container);
  }
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderAnalyticsPage, { once: true });
} else {
  renderAnalyticsPage();
}
