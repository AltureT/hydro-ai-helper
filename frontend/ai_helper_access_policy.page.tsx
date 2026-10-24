/**
 * AI 访问策略管理页面挂载入口
 * 路由: /ai-helper/admin/access 和 /d/:domainId/ai-helper/admin/access
 */

import React from 'react';
import { renderComponent } from './utils/renderHelper';
import AccessPolicyPanel from './admin/AccessPolicyPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

const isAccessPolicyPage = () => {
  const pathname = window.location.pathname;
  return pathname === '/ai-helper/admin/access'
    || /^\/d\/[^/]+\/ai-helper\/admin\/access$/.test(pathname);
};

const renderAccessPolicyPage = () => {
  if (!isAccessPolicyPage()) {
    return;
  }

  const container = document.getElementById('ai-helper-access-policy-root');
  if (!container) {
    console.debug('[AI Helper] access policy root not found, skip render');
    return;
  }

  renderComponent(<ErrorBoundary><AccessPolicyPanel /></ErrorBoundary>, container);
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderAccessPolicyPage, { once: true });
} else {
  renderAccessPolicyPage();
}
