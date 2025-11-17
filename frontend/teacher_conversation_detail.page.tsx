/**
 * 教师端对话详情页面
 * 挂载点: 通过 URL 直接访问 (后续可添加到后台导航)
 *
 * 说明:
 * - HydroOJ 默认的 NamedPage 工具位于 ui-default 主题，但在插件前端构建阶段不会自动提供 `vj/misc/Page`
 * - 为避免构建失败，这里使用 DOMContentLoaded + 路由判断的方式挂载组件
 */

import React from 'react';
import ReactDOM from 'react-dom';
import ConversationDetail from './teacher/ConversationDetail';

/**
 * 从 URL 中提取 conversationId
 */
const getConversationIdFromUrl = (): string | null => {
  const match = window.location.pathname.match(/\/ai-helper\/conversations\/([a-f0-9]{24})/i);
  return match ? match[1] : null;
};

const renderConversationDetail = (conversationId: string) => {
  const container = document.createElement('div');
  container.id = 'ai-conversation-detail-container';
  container.style.padding = '20px';

  const mainContent = document.querySelector('.main') || document.body;
  if (!mainContent) return;

  mainContent.innerHTML = '';
  mainContent.appendChild(container);
  ReactDOM.render(<ConversationDetail conversationId={conversationId} />, container);
};

const init = () => {
  const conversationId = getConversationIdFromUrl();
  if (!conversationId) return;
  renderConversationDetail(conversationId);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
