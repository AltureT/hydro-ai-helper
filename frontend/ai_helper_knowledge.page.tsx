/**
 * 知识库管理页面挂载入口
 * 路由: /ai-helper/admin/knowledge (含 /d/:domainId 前缀形式)
 */

import React from 'react';
import { renderComponent } from './utils/renderHelper';
import KnowledgePanel from './admin/KnowledgePanel';
import { ErrorBoundary } from './components/ErrorBoundary';

const isKnowledgePage = () => /\/ai-helper\/admin\/knowledge\/?$/.test(window.location.pathname);

const renderKnowledgePage = () => {
  if (!isKnowledgePage()) {
    return;
  }

  const container = document.getElementById('ai-helper-knowledge-root');
  if (!container) {
    console.debug('[AI Helper] knowledge root not found, skip render');
    return;
  }

  renderComponent(<ErrorBoundary><KnowledgePanel /></ErrorBoundary>, container);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderKnowledgePage, { once: true });
} else {
  renderKnowledgePage();
}
