/**
 * AI 配置页面挂载入口
 * 路由: /ai-helper/admin/config
 */

import React from 'react';
import { renderComponent } from './utils/renderHelper';
import ConfigPanel from './admin/ConfigPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * 检查是否为 AI 配置页面
 */
const isAdminConfigPage = () => window.location.pathname === '/ai-helper/admin/config';

/**
 * 将配置页面挂载到模板提供的根节点
 */
const renderAdminConfigPage = () => {
  if (!isAdminConfigPage()) {
    return;
  }

  const container = document.getElementById('ai-helper-admin-config-root');
  if (!container) {
    console.debug('[AI Helper] admin config root not found, skip render');
    return;
  }

  renderComponent(<ErrorBoundary><ConfigPanel /></ErrorBoundary>, container);
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderAdminConfigPage, { once: true });
} else {
  renderAdminConfigPage();
}
