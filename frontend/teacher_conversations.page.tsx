/**
 * 教师端对话列表页面
 * 挂载点: 通过 URL 直接访问 (后续可添加到后台导航)
 *
 * 说明:
 * - HydroOJ 默认的 NamedPage 工具位于 ui-default 主题，但在插件前端构建阶段不会自动提供 `vj/misc/Page`
 * - 为避免构建时找不到模块，这里使用 DOMContentLoaded + 路由判断的方式挂载组件
 */

import React from 'react';
import ReactDOM from 'react-dom';
import ConversationList from './teacher/ConversationList';

const isConversationListRoute = () => window.location.pathname === '/ai-helper/conversations';

const renderConversationList = () => {
  const container = document.createElement('div');
  container.id = 'ai-conversation-list-container';
  container.style.padding = '20px';

  const mainContent = document.querySelector('.main') || document.body;
  if (!mainContent) return;

  mainContent.innerHTML = '';
  mainContent.appendChild(container);
  ReactDOM.render(<ConversationList />, container);
};

const init = () => {
  if (!isConversationListRoute()) return;
  renderConversationList();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
