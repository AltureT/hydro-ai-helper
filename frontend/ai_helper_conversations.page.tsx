/**
 * 教师端对话列表页面
 * 挂载点: 通过 URL 直接访问 (后续可添加到后台导航)
 *
 * 说明:
 * - HydroOJ 默认的 NamedPage 工具位于 ui-default 主题，但在插件前端构建阶段不会自动提供 `vj/misc/Page`
 * - 挂载点 ID 需要与模板 templates/ai-helper/teacher_conversations.html 中定义的一致
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import ConversationList from './teacher/ConversationList';

/**
 * T024: 检查是否为对话列表页
 * 支持: /ai-helper/conversations 和 /d/:domainId/ai-helper/conversations
 */
const isConversationsPage = () => {
  const pathname = window.location.pathname;
  return pathname === '/ai-helper/conversations' ||
    /^\/d\/[^/]+\/ai-helper\/conversations$/.test(pathname);
};

/**
 * 将对话列表挂载到模板提供的根节点
 */
const renderTeacherConversationsPage = () => {
  if (!isConversationsPage()) {
    return;
  }

  const container = document.getElementById('ai-helper-conversations-root');
  if (!container) {
    console.debug('[AI Helper] conversations root not found, skip render');
    return;
  }

  console.log('[AI Helper] Mounting ConversationList component');

  const reactDom = ReactDOM as unknown as {
    createRoot?: (el: Element | DocumentFragment) => { render: (node: React.ReactNode) => void };
    render?: (node: React.ReactNode, el: Element | DocumentFragment | null) => void;
  };

  if (typeof reactDom.createRoot === 'function') {
    const root = reactDom.createRoot(container);
    root.render(<ConversationList />);
  } else if (typeof reactDom.render === 'function') {
    reactDom.render(<ConversationList />, container);
  } else {
    console.error('[AI Helper] ReactDOM is missing render/createRoot');
  }

  console.log('[AI Helper] ConversationList component mounted successfully');
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderTeacherConversationsPage, { once: true });
} else {
  renderTeacherConversationsPage();
}
