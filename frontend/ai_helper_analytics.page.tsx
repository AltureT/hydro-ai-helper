/**
 * AI 使用统计页面挂载入口
 * 路由: /ai-helper/analytics
 */

import React from 'react';
import { renderComponent } from './utils/renderHelper';
import AnalyticsPage from './teacher/AnalyticsPage';
import { ErrorBoundary } from './components/ErrorBoundary';

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

  renderComponent(<ErrorBoundary><AnalyticsPage /></ErrorBoundary>, container);
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderAnalyticsPage, { once: true });
} else {
  renderAnalyticsPage();
}
