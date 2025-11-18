/**
 * AI 配置页面挂载入口
 * 路由: /ai-helper/admin/config
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import ConfigPanel from './admin/ConfigPanel';

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

  console.log('[AI Helper] Mounting ConfigPanel component');

  const reactDom = ReactDOM as unknown as {
    createRoot?: (el: Element | DocumentFragment) => { render: (node: React.ReactNode) => void };
    render?: (node: React.ReactNode, el: Element | DocumentFragment | null) => void;
  };

  if (typeof reactDom.createRoot === 'function') {
    const root = reactDom.createRoot(container);
    root.render(<ConfigPanel />);
  } else if (typeof reactDom.render === 'function') {
    reactDom.render(<ConfigPanel />, container);
  } else {
    console.error('[AI Helper] ReactDOM is missing render/createRoot');
  }

  console.log('[AI Helper] ConfigPanel component mounted successfully');
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderAdminConfigPage, { once: true });
} else {
  renderAdminConfigPage();
}
